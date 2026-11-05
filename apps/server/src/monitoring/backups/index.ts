/**
 * mon-backups: scheduled database backups (local + S3) with automatic restore verification.
 * Routes: CONTRACT.md §4.2. `requireUser` is applied per route (never as a global/sub-router middleware).
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { db, newId, now, type Row } from '../../db/index.ts';
import { requireUser } from '../../lib/auth.ts';
import { badRequest, body, conflict, logActivity, type AppEnv } from '../../lib/http.ts';
import { getAppRow } from '../../core/apps/model.ts';
import { detectEngine } from './engines.ts';
import { isDue, type Schedule } from './policy.ts';
import { normPrefix, type S3Config } from './s3.ts';
import { getBackupRow, getRun, getRunRow, readS3, toBackupConfig, toBackupRun, writeS3 } from './store.ts';
import { isBusy, markInterruptedRuns, restoreRun, startBackupRun, startVerify } from './runner.ts';

export { isDue } from './policy.ts';

const schedule = z.enum(['hourly', 'daily', 'weekly']);
const s3Base = {
  endpoint: z.url({ protocol: /^https?$/ }),
  bucket: z.string().trim().min(1).max(255),
  region: z.string().trim().min(1).max(64).optional(),
  accessKey: z.string().trim().min(1).max(512),
  prefix: z.string().trim().max(512).optional(),
};
const s3Create = z.object({ ...s3Base, secretKey: z.string().min(1).max(1024) });
const s3Patch = z.object({ ...s3Base, secretKey: z.string().min(1).max(1024).optional() });

const createSchema = z.object({
  appId: z.string().min(1),
  schedule: schedule.optional(),
  retention: z.number().int().min(1).max(1000).optional(),
  destination: z.enum(['local', 's3']).optional(),
  s3: s3Create.nullable().optional(),
  verify: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const patchSchema = z.object({
  schedule: schedule.optional(),
  retention: z.number().int().min(1).max(1000).optional(),
  destination: z.enum(['local', 's3']).optional(),
  s3: s3Patch.nullable().optional(),
  verify: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const restoreSchema = z.object({ confirm: z.literal(true) });

const toS3 = (s: z.infer<typeof s3Create>): S3Config => ({
  endpoint: s.endpoint.replace(/\/+$/, ''),
  bucket: s.bucket,
  region: s.region || 'us-east-1',
  accessKey: s.accessKey,
  secretKey: s.secretKey,
  prefix: normPrefix(s.prefix ?? 'docksy/'),
});

function assertBackupable(app: Row): void {
  if (!detectEngine(app.template, app.image)) {
    throw badRequest(`Backups work for PostgreSQL, MySQL, MariaDB, MongoDB and Redis apps. ${app.name} isn't one of those.`);
  }
}

export function registerBackups(app: Hono<AppEnv>): void {
  app.get('/api/v1/backups', requireUser, (c) => {
    const appId = c.req.query('appId');
    const rows = appId
      ? (db.prepare('SELECT * FROM backups WHERE app_id = ? ORDER BY created_at').all(getAppRow(appId).id) as Row[])
      : (db.prepare('SELECT * FROM backups ORDER BY created_at').all() as Row[]);
    return c.json({ items: rows.map(toBackupConfig) });
  });

  app.post('/api/v1/backups', requireUser, async (c) => {
    const b = await body(c, createSchema);
    const appRow = getAppRow(b.appId);
    assertBackupable(appRow);
    const destination = b.destination ?? (b.s3 ? 's3' : 'local');
    if (destination === 's3' && !b.s3) throw badRequest('S3 destination needs s3 settings: endpoint, bucket, region, accessKey, secretKey.');
    const id = newId();
    db.prepare('INSERT INTO backups (id, app_id, schedule, retention, destination, s3_config_enc, verify, enabled, last_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)').run(
      id, appRow.id, b.schedule ?? 'daily', b.retention ?? 7, destination, b.s3 ? writeS3(toS3(b.s3)) : null,
      b.verify === false ? 0 : 1, b.enabled === false ? 0 : 1, now(),
    );
    logActivity(c.get('actor'), 'backup.create', 'app', appRow.id, `backup ${id}`);
    return c.json(toBackupConfig(getBackupRow(id)), 201);
  });

  app.patch('/api/v1/backups/:id', requireUser, async (c) => {
    const row = getBackupRow(c.req.param('id'));
    const p = await body(c, patchSchema);
    let s3Enc: string | null = row.s3_config_enc ?? null;
    if (p.s3 === null) s3Enc = null;
    else if (p.s3) {
      const secretKey = p.s3.secretKey ?? readS3(row)?.secretKey;
      if (!secretKey) throw badRequest('Include s3.secretKey: there is no saved secret key to keep.');
      s3Enc = writeS3(toS3({ ...p.s3, secretKey }));
    }
    const destination = p.destination ?? (p.s3 ? 's3' : p.s3 === null ? 'local' : row.destination);
    if (destination === 's3' && !s3Enc) throw badRequest('S3 destination needs s3 settings: endpoint, bucket, region, accessKey, secretKey.');
    db.prepare('UPDATE backups SET schedule = ?, retention = ?, destination = ?, s3_config_enc = ?, verify = ?, enabled = ? WHERE id = ?').run(
      p.schedule ?? row.schedule,
      p.retention ?? row.retention,
      destination,
      s3Enc,
      p.verify === undefined ? row.verify : p.verify ? 1 : 0,
      p.enabled === undefined ? row.enabled : p.enabled ? 1 : 0,
      row.id,
    );
    logActivity(c.get('actor'), 'backup.update', 'app', row.app_id, `backup ${row.id}`);
    return c.json(toBackupConfig(getBackupRow(row.id)));
  });

  app.delete('/api/v1/backups/:id', requireUser, (c) => {
    const row = getBackupRow(c.req.param('id'));
    if (isBusy(row.id)) throw conflict('This backup is running right now. Try again when it finishes.');
    db.prepare('DELETE FROM backups WHERE id = ?').run(row.id); // runs cascade; files on the server/S3 are kept
    logActivity(c.get('actor'), 'backup.delete', 'app', row.app_id, `backup ${row.id}`);
    return c.json({ ok: true });
  });

  app.post('/api/v1/backups/:id/run', requireUser, (c) => {
    const row = getBackupRow(c.req.param('id'));
    const { run } = startBackupRun(row.id);
    logActivity(c.get('actor'), 'backup.run', 'app', row.app_id, `backup ${row.id}`);
    return c.json(run, 202);
  });

  app.get('/api/v1/backups/:id/runs', requireUser, (c) => {
    const row = getBackupRow(c.req.param('id'));
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 500);
    const rows = db.prepare('SELECT * FROM backup_runs WHERE backup_id = ? ORDER BY started_at DESC LIMIT ?').all(row.id, limit) as Row[];
    return c.json({ items: rows.map(toBackupRun) });
  });

  // Not in the contract table, but handy for polling a single run.
  app.get('/api/v1/backup-runs/:id', requireUser, (c) => c.json(getRun(c.req.param('id'))));

  app.post('/api/v1/backup-runs/:id/verify', requireUser, (c) => {
    const run = getRunRow(c.req.param('id'));
    const { run: out } = startVerify(run.id);
    const b = getBackupRow(run.backup_id);
    logActivity(c.get('actor'), 'backup.verify', 'app', b.app_id, `run ${run.id}`);
    return c.json(out, 202);
  });

  app.post('/api/v1/backup-runs/:id/restore', requireUser, async (c) => {
    const run = getRunRow(c.req.param('id'));
    let raw: unknown;
    try { raw = await c.req.json(); } catch { raw = {}; }
    if (!restoreSchema.safeParse(raw).success) {
      throw badRequest('Restoring replaces the data in the live database. Send {"confirm": true} to go ahead.');
    }
    const b = getBackupRow(run.backup_id);
    logActivity(c.get('actor'), 'backup.restore', 'app', b.app_id, `run ${run.id}`);
    return c.json(await restoreRun(run.id));
  });
}

// ───────────────────────────── scheduler ─────────────────────────────

const MAX_SCHEDULED_CONCURRENT = 2;
let running = 0;
let timer: NodeJS.Timeout | null = null;

/** One scheduler tick: start every enabled backup that's due (a couple at a time). Returns ids started. */
export function schedulerTick(nowMs = Date.now()): string[] {
  const started: string[] = [];
  const rows = db.prepare('SELECT id, schedule, last_run_at FROM backups WHERE enabled = 1 ORDER BY COALESCE(last_run_at, 0)').all() as Row[];
  for (const r of rows) {
    if (running >= MAX_SCHEDULED_CONCURRENT) break;
    if (isBusy(r.id) || !isDue(r.schedule as Schedule, r.last_run_at, nowMs)) continue;
    try {
      const { done } = startBackupRun(r.id);
      running++;
      started.push(r.id);
      done.finally(() => { running--; });
    } catch (e) {
      console.error('[docksy] backups: could not start scheduled backup', r.id, e);
    }
  }
  return started;
}

export function startBackups(): void {
  if (timer) return;
  markInterruptedRuns();
  const tick = () => { try { schedulerTick(); } catch (e) { console.error('[docksy] backups: scheduler tick failed', e); } };
  setTimeout(tick, 15_000).unref();
  timer = setInterval(tick, 60_000);
  timer.unref();
}
