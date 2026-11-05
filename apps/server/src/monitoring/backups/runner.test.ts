import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOCKSY_DB_PATH = ':memory:';
process.env.DOCKSY_DISABLE_JOBS = '1';
process.env.DOCKSY_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'docksy-backups-test-'));
process.env.DOCKSY_SECRET = 'a'.repeat(64);

const { db, migrate } = await import('../../db/index.ts');
const { setAppEnv } = await import('../../core/apps/model.ts');
const { sha256 } = await import('../../lib/crypto.ts');
const { errorHandler } = await import('../../lib/http.ts');
const { Hono } = await import('hono');
const runner = await import('./runner.ts');
const backups = await import('./index.ts');

const PG_PASSWORD = 'pg-super-secret-pw';
const TOKEN = 'dsk_testtoken123';

type Mode = { dump: 'ok' | 'fail'; verifySanity: string };
let mode: Mode = { dump: 'ok', verifySanity: '2' };
let calls: string[] = [];
let alerts: Array<{ metric: string; key: string; title: string }> = [];
let resolved: string[] = [];
let fetches: Array<{ method: string; url: string }> = [];

/** Undo `bash -c '<script>'` quoting so assertions can read the script. */
const unwrap = (cmd: string) => cmd.replace(/^bash -c '/, '').replace(/'$/, '').split(`'\\''`).join(`'`).replace(/^set -o pipefail\n/, '');

async function fakeExec(_serverId: string, command: string) {
  const s = unwrap(command);
  calls.push(s);
  const ok = (stdout = '', stderr = '') => ({ code: 0, stdout, stderr });
  if (s.includes('pg_dumpall') && s.includes('gzip -c >')) {
    return mode.dump === 'ok' ? ok('12345\n') : { code: 1, stdout: '', stderr: 'pg_dumpall: error: connection to server failed\n' };
  }
  if (s.includes('{{.Config.Image}}') && s.includes('docker ps -q')) return ok('postgres:17\n');
  if (s.includes('curl -fsS --retry 3 --retry-delay 2 -T')) return ok();
  if (s.includes('docker run -d')) return ok();
  if (s.startsWith('i=0\nuntil')) return ok();
  if (s.includes('gunzip -c') && s.includes('psql')) return ok('', 'ERROR:  role "postgres" already exists\n');
  if (s.includes('NOT datistemplate')) return s.includes('dx-verify-') ? ok(`${mode.verifySanity}\n`) : ok('2\n');
  if (s.startsWith('docker rm -fv')) return ok();
  if (s.startsWith('rm -f --')) return ok();
  return { code: 99, stdout: '', stderr: `unexpected command in test: ${s.slice(0, 80)}` };
}

const s3List = (keys: string[]) =>
  `<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`).join('')}</ListBucketResult>`;

async function fakeFetch(url: string, init?: RequestInit) {
  const method = init?.method ?? 'GET';
  fetches.push({ method, url });
  if (method === 'GET') {
    return new Response(s3List(['docksy/pg/20200101T000000Z.gz', 'docksy/pg/20200102T000000Z.gz', 'docksy/pg/20200103T000000Z.gz', 'docksy/pg/readme.txt']));
  }
  return new Response(null, { status: 204 });
}

let backupId = '';

before(() => {
  migrate();
  const t = Date.now();
  db.prepare("INSERT INTO servers (id, name, host, created_at, updated_at) VALUES ('srv1', 'vps', '10.0.0.1', ?, ?)").run(t, t);
  db.prepare("INSERT INTO apps (id, name, server_id, kind, template, source_type, image, webhook_secret, created_at, updated_at) VALUES ('app1', 'pg', 'srv1', 'database', 'postgres', 'image', 'postgres:17', 'whs', ?, ?)").run(t, t);
  db.prepare("INSERT INTO apps (id, name, server_id, kind, source_type, image, webhook_secret, created_at, updated_at) VALUES ('app2', 'web', 'srv1', 'app', 'image', 'nginx:1', 'whs2', ?, ?)").run(t, t);
  setAppEnv('app1', { POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: PG_PASSWORD });
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'a@b.c', 'A', 'x', 'owner', ?)").run(t);
  db.prepare("INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, created_at) VALUES ('t1', 'u1', 'test', ?, 'dsk_', 'full', ?)").run(sha256(TOKEN), t);
  runner.deps.exec = fakeExec as typeof runner.deps.exec;
  runner.deps.fetch = fakeFetch;
  runner.deps.fireEventAlert = (metric, o) => { alerts.push({ metric, key: o.key, title: o.title }); };
  runner.deps.resolveEventAlert = (key) => { resolved.push(key); };
});

beforeEach(() => {
  mode = { dump: 'ok', verifySanity: '2' };
  calls = [];
  alerts = [];
  resolved = [];
  fetches = [];
});

function api() {
  const app = new Hono<any>();
  app.onError(errorHandler);
  backups.registerBackups(app);
  type Res = { status: number; json(): Promise<any>; text(): Promise<string> };
  return async (method: string, path: string, body?: unknown): Promise<Res> =>
    await app.request(`/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

test('routes: create with S3 never returns the secret key; validation', async () => {
  const call = api();
  const res = await call('POST', '/backups', {
    appId: 'pg', schedule: 'daily', retention: 2,
    s3: { endpoint: 'https://s3.example.com', bucket: 'bk', region: 'us-east-1', accessKey: 'AKID', secretKey: 'TOPSECRET-S3' },
  });
  assert.equal(res.status, 201);
  const text = await res.text();
  assert.ok(!text.includes('TOPSECRET-S3'), 'secretKey must be write-only');
  const cfg = JSON.parse(text);
  assert.equal(cfg.destination, 's3');
  assert.equal(cfg.appId, 'app1');
  assert.equal(cfg.s3.prefix, 'docksy/');
  assert.equal(cfg.verify, true);
  backupId = cfg.id;

  // patching S3 without a secret keeps the stored one
  const p = await call('PATCH', `/backups/${backupId}`, { s3: { endpoint: 'https://s3.example.com', bucket: 'bk', accessKey: 'AKID2' } });
  assert.equal(p.status, 200);
  assert.equal((await p.json()).s3.accessKey, 'AKID2');
  assert.ok((db.prepare('SELECT s3_config_enc FROM backups WHERE id = ?').get(backupId) as any).s3_config_enc);

  const list = await (await call('GET', '/backups?appId=pg')).json();
  assert.equal(list.items.length, 1);
  assert.ok(!JSON.stringify(list).includes('TOPSECRET-S3'));

  assert.equal((await call('POST', '/backups', { appId: 'web' })).status, 400); // not a database
  assert.equal((await call('POST', '/backups', { appId: 'pg', destination: 's3' })).status, 400); // s3 without settings
  assert.equal((await call('GET', '/backups/nope/runs')).status, 404);
});

test('runner: success uploads, prunes local + S3, verifies and cleans up', async () => {
  // two older runs with files; retention is 2 so the oldest must go
  db.prepare("INSERT INTO backup_runs (id, backup_id, status, verified, path, started_at) VALUES ('old1', ?, 'succeeded', 'passed', '/var/lib/docksy/backups/pg/20200101T000000Z.gz', 1000)").run(backupId);
  db.prepare("INSERT INTO backup_runs (id, backup_id, status, verified, path, started_at) VALUES ('old2', ?, 'succeeded', 'passed', '/var/lib/docksy/backups/pg/20200102T000000Z.gz', 2000)").run(backupId);

  const { run, done } = runner.startBackupRun(backupId);
  assert.equal(run.status, 'running');
  assert.throws(() => runner.startBackupRun(backupId), /already running/);
  const r = await done;

  assert.equal(r.status, 'succeeded', r.log);
  assert.equal(r.verified, 'passed');
  assert.equal(r.sizeBytes, 12345);
  assert.match(r.path ?? '', /^\/var\/lib\/docksy\/backups\/pg\/\d{8}T\d{6}Z\.gz$/);
  assert.ok(!r.log.includes(PG_PASSWORD), 'log must not contain secrets');
  assert.match(r.log, /Uploaded to s3:\/\/bk\/docksy\/pg\//);
  assert.match(r.log, /Verify passed: restored copy has 2 databases/);

  // upload went through a presigned URL + curl on the server
  const up = calls.find((c) => c.includes('curl -fsS --retry 3 --retry-delay 2 -T'))!;
  assert.match(up, /X-Amz-Signature=[0-9a-f]{64}/);
  assert.ok(!up.includes('TOPSECRET-S3'));
  // local prune removed only the oldest file
  const rm = calls.find((c) => c.startsWith('rm -f --'))!;
  assert.ok(rm.includes('20200101T000000Z.gz') && !rm.includes('20200102T000000Z.gz'));
  assert.equal((db.prepare("SELECT path FROM backup_runs WHERE id = 'old1'").get() as any).path, null);
  // S3 prune: LIST, then DELETE all but the newest 2 Docksy files (readme untouched)
  const deletes = fetches.filter((f) => f.method === 'DELETE').map((f) => f.url);
  assert.equal(deletes.length, 1);
  assert.ok(deletes[0].endsWith('/bk/docksy/pg/20200101T000000Z.gz'));
  // the throwaway container was started and always removed
  assert.ok(calls.some((c) => c.includes("docker run -d --name 'dx-verify-")));
  assert.ok(calls.some((c) => c.startsWith("docker rm -fv 'dx-verify-")));
  assert.deepEqual(alerts, []);
  assert.deepEqual(resolved, [`backup:${backupId}`]);
  assert.ok((db.prepare('SELECT last_run_at FROM backups WHERE id = ?').get(backupId) as any).last_run_at);
});

test('runner: dump failure marks the run failed and fires backup_failed', async () => {
  mode.dump = 'fail';
  const r = await runner.startBackupRun(backupId).done;
  assert.equal(r.status, 'failed');
  assert.equal(r.verified, 'skipped');
  assert.equal(r.path, null);
  assert.match(r.log, /Dump failed: pg_dumpall: error: connection to server failed/);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].metric, 'backup_failed');
  assert.equal(alerts[0].key, `backup:${backupId}`);
  assert.ok(!calls.some((c) => c.includes('docker run -d')), 'no verify after a failed dump');
  assert.ok(!calls.some((c) => c.includes('curl')), 'no upload after a failed dump');
});

test('runner: verify failure keeps the backup, marks verified=failed, alerts and cleans up', async () => {
  mode.verifySanity = '0';
  const r = await runner.startBackupRun(backupId).done;
  assert.equal(r.status, 'succeeded');
  assert.equal(r.verified, 'failed');
  assert.match(r.log, /Verify failed: Sanity check failed/);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /could not be restored/);
  assert.ok(calls.some((c) => c.startsWith("docker rm -fv 'dx-verify-")), 'verify container is always removed');
  assert.deepEqual(resolved, []);
});

test('routes: restore requires confirm; run returns 202', async () => {
  const call = api();
  const runs = await (await call('GET', `/backups/${backupId}/runs`)).json();
  const withFile = runs.items.find((r: any) => r.path);
  assert.ok(withFile);
  const no = await call('POST', `/backup-runs/${withFile.id}/restore`, {});
  assert.equal(no.status, 400);
  assert.match((await no.json()).error.message, /confirm/);
  assert.ok(!calls.some((c) => c.includes('pg_terminate_backend')), 'nothing ran without confirm');

  const res = await call('POST', `/backups/${backupId}/run`);
  assert.equal(res.status, 202);
  const run = await res.json();
  assert.equal(run.status, 'running');
  // wait for the background run to finish before the process exits
  for (let i = 0; i < 100 && runner.isBusy(backupId); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(runner.isBusy(backupId), false);
});

test('scheduler: due backups start once per tick', async () => {
  db.prepare('UPDATE backups SET last_run_at = NULL WHERE id = ?').run(backupId);
  assert.deepEqual(backups.schedulerTick(), [backupId]);
  assert.deepEqual(backups.schedulerTick(), [], 'busy/last_run_at prevents a second start');
  for (let i = 0; i < 100 && runner.isBusy(backupId); i++) await new Promise((r) => setTimeout(r, 10));
  db.prepare('UPDATE backups SET enabled = 0 WHERE id = ?').run(backupId);
  db.prepare('UPDATE backups SET last_run_at = NULL WHERE id = ?').run(backupId);
  assert.deepEqual(backups.schedulerTick(), [], 'disabled backups never run');
});
