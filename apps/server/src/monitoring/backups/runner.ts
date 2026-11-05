/**
 * Backup runner: dump → gzip on the server, upload, prune, verify by restoring into a throwaway
 * container, and alert on failure. Also manual verify and live restore of an existing run.
 *
 * Everything runs on the app's server through `deps.exec` (ssh.exec in production, a fake in tests).
 */
import type { BackupRun } from '@docksy/shared';
import { db, bool, newId, type Row } from '../../db/index.ts';
import { exec as sshExec, q, type ExecOptions, type ExecResult } from '../../lib/ssh.ts';
import { conflict, HttpError } from '../../lib/http.ts';
import { randomToken } from '../../lib/crypto.ts';
import { containerSelector, getAppEnv } from '../../core/apps/model.ts';
import { fireEventAlert, resolveEventAlert } from '../alerts/engine.ts';
import * as E from './engines.ts';
import { backupKey, deleteObject, listObjects, normPrefix, presignObject, type S3Config } from './s3.ts';
import { selectPrune, selectS3Prune } from './policy.ts';
import { getBackupRow, getRun, getRunRow, readS3 } from './store.ts';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Injectable dependencies (tests swap these out). */
export const deps = {
  exec: sshExec as (serverId: string, command: string, opts?: ExecOptions) => Promise<ExecResult>,
  fetch: ((url, init) => fetch(url, init)) as FetchLike,
  fireEventAlert: fireEventAlert as typeof fireEventAlert,
  resolveEventAlert: resolveEventAlert as typeof resolveEventAlert,
  now: (): number => Date.now(),
};

const DUMP_TIMEOUT_MS = 3 * 3600_000;
const UPLOAD_TIMEOUT_MS = 6 * 3600_000;
const RESTORE_TIMEOUT_MS = 3 * 3600_000;
const STEP_TIMEOUT_MS = 5 * 60_000;

export const alertKey = (backupId: string): string => `backup:${backupId}`;

// ───────────────────────────── helpers ─────────────────────────────

/** Backups with a run, verify or restore in progress (one operation per backup at a time). */
const busy = new Set<string>();
export const isBusy = (backupId: string): boolean => busy.has(backupId);

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Last few meaningful lines of a command's stderr. */
export function tail(text: string, lines = 12): string {
  return text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-lines).join('\n').slice(-2000);
}

export function redact(text: string, secrets: string[]): string {
  let out = text.replace(/X-Amz-Signature=[0-9a-f]+/gi, 'X-Amz-Signature=…');
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('••••');
  return out;
}

export const fmtBytes = (n: number): string => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
};

/** Run a bash script on a server with pipefail on. */
function sh(serverId: string, script: string, timeoutMs = STEP_TIMEOUT_MS): Promise<ExecResult> {
  return deps.exec(serverId, `bash -c ${q(`set -o pipefail\n${script}`)}`, { timeoutMs });
}

/** Append-only run log, persisted on every line so the UI can follow along. */
class RunLog {
  runId: string;
  secrets: string[];
  text: string;
  mine: string[] = [];
  constructor(runId: string, secrets: string[] = []) {
    this.runId = runId;
    this.secrets = secrets;
    this.text = (db.prepare('SELECT log FROM backup_runs WHERE id = ?').get(runId) as Row | undefined)?.log ?? '';
  }
  add(msg: string): void {
    const line = `[${new Date(deps.now()).toISOString().slice(11, 19)}] ${redact(msg, this.secrets)}`;
    this.mine.push(line);
    this.text = this.text ? `${this.text}\n${line}` : line;
    db.prepare('UPDATE backup_runs SET log = ? WHERE id = ?').run(this.text, this.runId);
  }
}

interface Ctx { backup: Row; app: Row; engine: E.Engine; conn: E.Conn; s3: S3Config | null; secrets: string[] }

function loadCtx(backup: Row): Ctx {
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(backup.app_id) as Row | undefined;
  if (!app) throw new Error('The app for this backup no longer exists.');
  const engine = E.detectEngine(app.template, app.image);
  if (!engine) throw new Error(`Backups aren't supported for ${app.name}: it isn't a postgres, mysql, mariadb, mongodb or redis app.`);
  const env = getAppEnv(app.id);
  const s3 = backup.destination === 's3' ? readS3(backup) : null;
  if (backup.destination === 's3' && !s3) throw new Error('The S3 settings for this backup are missing or unreadable. Re-enter them (including the secret key).');
  const conn = E.sourceConn(engine, env);
  const secretEnv = Object.entries(env).filter(([k]) => /PASS|SECRET|TOKEN|KEY|AUTH|PWD/i.test(k)).map(([, v]) => v);
  const secrets = [...secretEnv, conn.password, s3?.secretKey ?? ''].filter((s) => s.length >= 4);
  return { backup, app, engine, conn, s3, secrets };
}

function alertFailure(backup: Row, app: Row | undefined, title: string, message: string): void {
  try {
    deps.fireEventAlert('backup_failed', {
      key: alertKey(backup.id),
      title,
      message,
      severity: 'critical',
      serverId: app?.server_id ?? null,
      appId: backup.app_id,
    });
  } catch (e) {
    console.error('[docksy] backups: could not fire alert', e);
  }
}

const appRowOf = (backup: Row): Row | undefined => db.prepare('SELECT * FROM apps WHERE id = ?').get(backup.app_id) as Row | undefined;

async function resolveImage(ctx: Ctx): Promise<string> {
  const r = await sh(ctx.app.server_id, E.imageOfCommand(containerSelector(ctx.app.id)));
  const img = r.code === 0 ? r.stdout.trim().split('\n').pop()?.trim() : '';
  if (img) return img;
  if (ctx.app.image) return ctx.app.image;
  throw new Error('Could not tell which image the database runs (no running container and no image on the app).');
}

/** Make sure the run's file is on the server, fetching it back from S3 when it's only there. */
async function ensureFile(ctx: Ctx, file: string, log: RunLog): Promise<void> {
  const dir = file.slice(0, file.lastIndexOf('/'));
  const parts = [`if [ -s ${q(file)} ]; then echo present; exit 0; fi`];
  if (ctx.s3) {
    const url = presignObject(ctx.s3, 'GET', backupKey(ctx.s3, ctx.app.name, file.slice(file.lastIndexOf('/') + 1)), 3600);
    parts.push(
      `command -v curl >/dev/null 2>&1 || { echo "the backup file is not on the server and curl is not installed to fetch it from S3" >&2; exit 1; }`,
      `mkdir -p ${q(dir)}`,
      `curl -fsS --retry 3 -o ${q(`${file}.part`)} ${q(url)} && mv -f ${q(`${file}.part`)} ${q(file)} && echo downloaded`,
    );
  } else {
    parts.push(`echo "the backup file ${file} is no longer on the server" >&2; exit 1`);
  }
  const r = await sh(ctx.app.server_id, parts.join('\n'), UPLOAD_TIMEOUT_MS);
  if (r.code !== 0) throw new Error(tail(r.stderr) || 'The backup file is missing.');
  if (r.stdout.includes('downloaded')) log.add('Fetched the backup file back from S3');
}

// ───────────────────────────── steps ─────────────────────────────

async function upload(ctx: Ctx, file: string, log: RunLog): Promise<void> {
  const s3 = ctx.s3!;
  const key = backupKey(s3, ctx.app.name, file.slice(file.lastIndexOf('/') + 1));
  const url = presignObject(s3, 'PUT', key, 6 * 3600);
  const script = [
    'if ! command -v curl >/dev/null 2>&1; then echo NO_CURL; exit 0; fi',
    `curl -fsS --retry 3 --retry-delay 2 -T ${q(file)} ${q(url)} -o /dev/null`,
  ].join('\n');
  const r = await sh(ctx.app.server_id, script, UPLOAD_TIMEOUT_MS);
  if (r.code !== 0) throw new Error(`Upload to S3 failed: ${tail(r.stderr) || `curl exit code ${r.code}`}. The backup is still on the server.`);
  if (r.stdout.includes('NO_CURL')) log.add('Warning: curl is not installed on the server, so this backup was kept on the server only.');
  else log.add(`Uploaded to s3://${s3.bucket}/${key}`);
}

async function prune(ctx: Ctx, log: RunLog): Promise<void> {
  const retention = Number(ctx.backup.retention) || 7;
  const rows = db.prepare('SELECT id, path, started_at FROM backup_runs WHERE backup_id = ? AND path IS NOT NULL').all(ctx.backup.id) as Row[];
  const victims = selectPrune(rows.map((r) => ({ id: r.id as string, path: r.path as string, startedAt: Number(r.started_at) })), retention)
    .filter((v) => v.path.startsWith(`${E.BACKUP_ROOT}/`) && !v.path.includes('..'));
  if (victims.length) {
    const r = await sh(ctx.app.server_id, `rm -f -- ${victims.map((v) => q(v.path)).join(' ')}`);
    if (r.code === 0) {
      const upd = db.prepare('UPDATE backup_runs SET path = NULL WHERE id = ?');
      for (const v of victims) upd.run(v.id);
      log.add(`Removed ${victims.length} older backup file(s) from the server (keeping the last ${retention})`);
    } else {
      log.add(`Warning: could not remove old backup files: ${tail(r.stderr)}`);
    }
  }
  if (ctx.s3) {
    try {
      const prefix = `${normPrefix(ctx.s3.prefix)}${ctx.app.name}/`;
      const keys = await listObjects(ctx.s3, prefix, deps.fetch);
      const del = selectS3Prune(keys.map((k) => k.key), retention);
      for (const k of del) await deleteObject(ctx.s3, k, deps.fetch);
      if (del.length) log.add(`Removed ${del.length} older backup(s) from S3 (keeping the last ${retention})`);
    } catch (e) {
      log.add(`Warning: S3 retention cleanup failed: ${errMsg(e)}`);
    }
  }
}

/** Restore the dump into a throwaway container and sanity-check it. Never throws; always cleans up. */
async function verifyFile(ctx: Ctx, runId: string, file: string, log: RunLog, o: { compare: boolean }): Promise<{ ok: boolean; detail: string }> {
  const { app, engine, conn } = ctx;
  const sid = app.server_id;
  const name = E.verifyName(runId);
  let started = false;
  const step = async (script: string, what: string, timeoutMs = STEP_TIMEOUT_MS) => {
    const r = await sh(sid, script, timeoutMs);
    if (r.code !== 0) throw new Error(`${what}: ${tail(r.stderr) || `exit code ${r.code}`}`);
    return r;
  };
  try {
    const image = await resolveImage(ctx);
    const vconn = E.verifyConn(engine, conn, randomToken('dv', 18));
    log.add(`Verifying: restoring into a throwaway ${image} container (${name})`);
    started = true;
    await step(E.startThrowawayCommand(engine, { name, image, conn: vconn, file }), 'Could not start the verify container');
    await step(E.waitReadyCommand(engine, name, vconn), 'The verify database did not start');
    if (engine !== 'redis') {
      const r = await step(`gunzip -c ${q(file)} | ${E.restoreCommand(engine, q(name), vconn, { drop: false })}`, 'Restoring the dump failed', RESTORE_TIMEOUT_MS);
      const errs = E.restoreErrors(engine, r.stderr);
      if (errs.length) throw new Error(`Restoring the dump reported errors:\n${errs.slice(0, 5).join('\n')}`);
    }
    const sr = await step(E.sanityCommand(engine, q(name), vconn), 'The sanity query failed');
    const s = E.parseSanity(engine, sr.stdout);
    if (!s.ok) throw new Error(`Sanity check failed: ${s.detail}`);
    if (o.compare && engine !== 'redis') {
      const src = await sh(sid, `C=${containerSelector(app.id)}\n[ -n "$C" ] || exit 3\n${E.sanityCommand(engine, '"$C"', conn)}`);
      const ps = src.code === 0 ? E.parseSanity(engine, src.stdout) : null;
      if (ps?.value != null && s.value != null && s.value < ps.value) {
        throw new Error(`The restored copy has ${s.value} ${E.sanityLabel(engine)} but the live database has ${ps.value}`);
      }
    }
    log.add(`Verify passed: restored copy has ${s.detail}`);
    return { ok: true, detail: s.detail };
  } catch (e) {
    log.add(`Verify failed: ${errMsg(e)}`);
    return { ok: false, detail: errMsg(e) };
  } finally {
    if (started) {
      await sh(sid, E.cleanupCommand(name)).then(
        () => log.add(`Removed the verify container ${name}`),
        (e) => log.add(`Warning: could not remove ${name}: ${errMsg(e)}`),
      );
    }
  }
}

// ───────────────────────────── run ─────────────────────────────

async function executeRun(backup: Row, runId: string, startedAt: number): Promise<BackupRun> {
  const log = new RunLog(runId);
  let ctx: Ctx | undefined;
  try {
    ctx = loadCtx(backup);
    log.secrets = ctx.secrets;
    const { app, engine, conn } = ctx;
    const file = E.backupFile(app.name, startedAt);

    // 1. dump → gzip
    log.add(`Backing up ${app.name} (${engine})`);
    const r = await sh(app.server_id, E.dumpScript(engine, containerSelector(app.id), conn, file), DUMP_TIMEOUT_MS);
    if (r.code !== 0) throw new Error(`Dump failed: ${tail(r.stderr) || `exit code ${r.code}`}`);

    // 2. size
    const size = Number.parseInt(r.stdout.trim().split('\n').pop() ?? '', 10);
    db.prepare('UPDATE backup_runs SET path = ?, size_bytes = ? WHERE id = ?').run(file, Number.isFinite(size) ? size : null, runId);
    log.add(`Saved ${file}${Number.isFinite(size) ? ` (${fmtBytes(size)})` : ''}`);

    // 3. upload
    if (ctx.s3) await upload(ctx, file, log);

    // 4. retention
    await prune(ctx, log);

    // 5. verify
    let verified: BackupRun['verified'] = 'skipped';
    let verifyDetail = '';
    if (bool(backup.verify)) {
      db.prepare("UPDATE backup_runs SET verified = 'pending' WHERE id = ?").run(runId);
      const v = await verifyFile(ctx, runId, file, log, { compare: true });
      verified = v.ok ? 'passed' : 'failed';
      verifyDetail = v.detail;
    }

    db.prepare("UPDATE backup_runs SET status = 'succeeded', verified = ?, finished_at = ? WHERE id = ?").run(verified, deps.now(), runId);
    if (verified === 'failed') {
      alertFailure(backup, app, `Backup of ${app.name} could not be restored`,
        `The backup was taken, but restoring it into a test container failed: ${redact(verifyDetail, ctx.secrets).slice(0, 500)}`);
      log.add('Backup finished, but verification failed');
    } else {
      try { deps.resolveEventAlert(alertKey(backup.id)); } catch { /* alert engine unavailable */ }
      log.add(verified === 'passed' ? 'Backup finished and verified' : 'Backup finished');
    }
  } catch (e) {
    const msg = redact(errMsg(e), ctx?.secrets ?? []);
    log.add(msg);
    db.prepare("UPDATE backup_runs SET status = 'failed', verified = 'skipped', finished_at = ? WHERE id = ?").run(deps.now(), runId);
    const app = ctx?.app ?? appRowOf(backup);
    alertFailure(backup, app, `Backup of ${app?.name ?? 'an app'} failed`, msg.slice(0, 500));
  }
  return getRun(runId);
}

/** Start a backup run. Returns the new run right away; `done` settles when it finishes (never rejects). */
export function startBackupRun(backupId: string): { run: BackupRun; done: Promise<BackupRun> } {
  const backup = getBackupRow(backupId);
  if (busy.has(backup.id)) throw conflict('This backup is already running. Wait for it to finish, then try again.');
  busy.add(backup.id);
  try {
    const runId = newId();
    const t = deps.now();
    db.prepare("INSERT INTO backup_runs (id, backup_id, status, verified, log, started_at) VALUES (?, ?, 'running', 'pending', '', ?)").run(runId, backup.id, t);
    db.prepare('UPDATE backups SET last_run_at = ? WHERE id = ?').run(t, backup.id);
    const done = executeRun(backup, runId, t).finally(() => busy.delete(backup.id));
    return { run: getRun(runId), done };
  } catch (e) {
    busy.delete(backup.id);
    throw e;
  }
}

function checkRunUsable(run: Row): void {
  if (run.status === 'running') throw conflict('This backup is still running.');
  if (!run.path) throw conflict('This backup has no file any more (it failed or was removed by retention).');
}

/** Re-verify an existing run. Returns the run (verified=pending) right away. */
export function startVerify(runId: string): { run: BackupRun; done: Promise<BackupRun> } {
  const run = getRunRow(runId);
  checkRunUsable(run);
  const backup = getBackupRow(run.backup_id);
  if (busy.has(backup.id)) throw conflict('Another backup operation is running for this database. Try again in a moment.');
  busy.add(backup.id);
  db.prepare("UPDATE backup_runs SET verified = 'pending' WHERE id = ?").run(runId);
  const done = (async () => {
    const log = new RunLog(runId);
    try {
      const ctx = loadCtx(backup);
      log.secrets = ctx.secrets;
      await ensureFile(ctx, run.path, log);
      const v = await verifyFile(ctx, runId, run.path, log, { compare: false });
      db.prepare('UPDATE backup_runs SET verified = ? WHERE id = ?').run(v.ok ? 'passed' : 'failed', runId);
      if (!v.ok) alertFailure(backup, ctx.app, `Backup of ${ctx.app.name} could not be restored`, `Re-verifying a backup failed: ${redact(v.detail, ctx.secrets).slice(0, 500)}`);
    } catch (e) {
      log.add(`Verify failed: ${errMsg(e)}`);
      db.prepare("UPDATE backup_runs SET verified = 'failed' WHERE id = ?").run(runId);
    }
    return getRun(runId);
  })().finally(() => busy.delete(backup.id));
  return { run: getRun(runId), done };
}

/**
 * Restore a run into the app's live database. Destructive: callers must have confirmed.
 * Throws HttpError(502) with the reason when the restore fails.
 */
export async function restoreRun(runId: string): Promise<{ ok: true; log: string }> {
  const run = getRunRow(runId);
  checkRunUsable(run);
  const backup = getBackupRow(run.backup_id);
  if (busy.has(backup.id)) throw conflict('Another backup operation is running for this database. Try again in a moment.');
  busy.add(backup.id);
  const log = new RunLog(runId);
  try {
    const ctx = loadCtx(backup);
    log.secrets = ctx.secrets;
    const { app, engine, conn } = ctx;
    const sid = app.server_id;
    const sel = containerSelector(app.id);
    log.add(`Restoring this backup into ${app.name}`);
    await ensureFile(ctx, run.path, log);
    const noCtr = 'if [ -z "$C" ]; then echo "No running container found for this app. Start it, then try again." >&2; exit 3; fi';

    if (engine === 'redis') {
      // Load the dump into a throwaway redis on the docksy network, then replicate it into the app.
      const name = E.restoreName(runId);
      const vconn = E.verifyConn(engine, conn, '');
      try {
        const image = await resolveImage(ctx);
        let r = await sh(sid, E.startThrowawayCommand(engine, { name, image, conn: vconn, file: run.path, network: 'docksy' }));
        if (r.code !== 0) throw new Error(`Could not start a helper container: ${tail(r.stderr)}`);
        r = await sh(sid, E.waitReadyCommand(engine, name, vconn));
        if (r.code !== 0) throw new Error(`The helper redis did not start: ${tail(r.stderr)}`);
        r = await sh(sid, `C=${sel}\n${noCtr}\n${E.redisReplicateCommand('"$C"', conn, name)}`, RESTORE_TIMEOUT_MS);
        if (r.code !== 0) throw new Error(`Syncing the data into ${app.name} failed: ${tail(r.stderr)}`);
        log.add(`Redis now has ${r.stdout.trim().split('\n').pop()} keys`);
      } finally {
        await sh(sid, E.cleanupCommand(name)).catch(() => undefined);
      }
    } else {
      const script = [
        `C=${sel}`,
        noCtr,
        engine === 'postgres' ? `${E.pgTerminateCommand('"$C"', conn)} || true` : '',
        `gunzip -c ${q(run.path)} | ${E.restoreCommand(engine, '"$C"', conn, { drop: true })}`,
      ].filter(Boolean).join('\n');
      const r = await sh(sid, script, RESTORE_TIMEOUT_MS);
      if (r.code !== 0) throw new Error(`Restore failed: ${tail(r.stderr) || `exit code ${r.code}`}`);
      const errs = E.restoreErrors(engine, r.stderr);
      if (errs.length) throw new Error(`Restore finished with errors:\n${errs.slice(0, 5).join('\n')}`);
    }
    log.add('Restore finished');
    return { ok: true, log: log.mine.join('\n') };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const msg = redact(errMsg(e), log.secrets);
    log.add(msg);
    throw new HttpError(502, 'restore_failed', msg, { log: log.mine.join('\n') });
  } finally {
    busy.delete(backup.id);
  }
}

/** On startup: runs left "running" by a crash or restart are marked failed. */
export function markInterruptedRuns(): void {
  const note = `\n[${new Date().toISOString().slice(11, 19)}] Docksy restarted while this was running.`;
  db.prepare("UPDATE backup_runs SET status = 'failed', verified = 'skipped', finished_at = ?, log = log || ? WHERE status = 'running'").run(Date.now(), note);
  db.prepare("UPDATE backup_runs SET verified = 'failed', log = log || ? WHERE verified = 'pending'").run(note);
}
