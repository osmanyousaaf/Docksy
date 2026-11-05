import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOCKSY_DB_PATH = ':memory:';
process.env.DOCKSY_DISABLE_JOBS = '1';
process.env.DOCKSY_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'docksy-uptime-'));

const { db, migrate, setSettings } = await import('../../db/index.ts');
const { sha256 } = await import('../../lib/crypto.ts');
const { errorHandler } = await import('../../lib/http.ts');
const { Hono } = await import('hono');
const stats = await import('./stats.ts');
const { probe, describeFetchError } = await import('./probe.ts');
const sched = await import('./scheduler.ts');
const uptime = await import('./index.ts');

migrate();

const TOKEN = 'dsk_uptime_test_token';
const DAY = 86_400_000;

function makeApp() {
  const app = new Hono<any>();
  app.onError(errorHandler);
  uptime.registerUptime(app);
  return app;
}

const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

before(() => {
  const t = Date.now();
  db.prepare(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'a@b.c', 'A', 'x', 'owner', ?)`).run(t);
  db.prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, created_at) VALUES ('t1', 'u1', 'test', ?, 'dsk_uptime', 'full', ?)`).run(sha256(TOKEN), t);
  db.prepare(`INSERT INTO servers (id, name, host, created_at, updated_at) VALUES ('s1', 'prod-1', '203.0.113.7', ?, ?)`).run(t, t);
  db.prepare(`INSERT INTO apps (id, name, server_id, port, domains, webhook_secret, created_at, updated_at) VALUES ('a1', 'api', 's1', 3000, '["api.example.com"]', 'whs', ?, ?)`).run(t, t);
  db.prepare(`INSERT INTO apps (id, name, server_id, port, domains, webhook_secret, created_at, updated_at) VALUES ('a2', 'web', 's1', 8080, '[]', 'whs', ?, ?)`).run(t, t);
  db.prepare(`INSERT INTO apps (id, name, server_id, kind, port, domains, webhook_secret, created_at, updated_at) VALUES ('a3', 'pg', 's1', 'database', 5432, '[]', 'whs', ?, ?)`).run(t, t);
});

describe('uptime math', () => {
  test('uptimePercent', () => {
    assert.equal(stats.uptimePercent(0, 0), null);
    assert.equal(stats.uptimePercent(10, 10), 100);
    assert.equal(stats.uptimePercent(0, 10), 0);
    assert.equal(stats.uptimePercent(1439, 1440), 99.93);
    assert.equal(stats.uptimePercent(99_999, 100_000), 99.99, 'a failure never rounds up to 100');
    assert.equal(stats.uptimePercent(1, 3), 33.33);
  });

  test('isExpectedStatus', () => {
    assert.ok(stats.isExpectedStatus(200, 0));
    assert.ok(stats.isExpectedStatus(301, 0));
    assert.ok(!stats.isExpectedStatus(404, 0));
    assert.ok(!stats.isExpectedStatus(500, 0));
    assert.ok(stats.isExpectedStatus(204, 204));
    assert.ok(!stats.isExpectedStatus(200, 204));
  });

  test('state transitions: down after 2 failures, once; up on recovery', () => {
    let s = { fails: 0, alerting: false };
    let r = stats.nextCheckState(s, false); assert.equal(r.event, null); s = r.state;
    assert.deepEqual(s, { fails: 1, alerting: false });
    r = stats.nextCheckState(s, false); assert.equal(r.event, 'down'); s = r.state;
    r = stats.nextCheckState(s, false); assert.equal(r.event, null, 'no duplicate down'); s = r.state;
    assert.deepEqual(s, { fails: 3, alerting: true });
    r = stats.nextCheckState(s, true); assert.equal(r.event, 'up'); s = r.state;
    r = stats.nextCheckState(s, true); assert.equal(r.event, null);
    // a blip: fail then ok emits nothing
    r = stats.nextCheckState({ fails: 0, alerting: false }, false);
    assert.equal(stats.nextCheckState(r.state, true).event, null);
  });

  test('stateFromRecent', () => {
    assert.deepEqual(stats.stateFromRecent([]), { fails: 0, alerting: false });
    assert.deepEqual(stats.stateFromRecent([false, true, false]), { fails: 1, alerting: false });
    assert.deepEqual(stats.stateFromRecent([false, false, false, true]), { fails: 3, alerting: true });
  });

  test('daily buckets: 90 days, oldest first, null for no data', () => {
    const nowMs = Date.UTC(2026, 10, 1, 12);
    const today = Math.floor(nowMs / DAY);
    const days = stats.buildDailyBuckets([{ day: today, n: 4, ok: 3 }, { day: today - 89, n: 10, ok: 10 }, { day: today - 200, n: 1, ok: 0 }], nowMs);
    assert.equal(days.length, 90);
    assert.equal(days[89]!.date, '2026-11-01');
    assert.equal(days[89]!.uptime, 75);
    assert.equal(days[0]!.uptime, 100);
    assert.equal(days[1]!.uptime, null);
    assert.equal(days[0]!.date, '2026-08-04');
  });

  test('overallStatus', () => {
    assert.equal(stats.overallStatus([]), 'operational');
    assert.equal(stats.overallStatus(['up', 'unknown']), 'operational');
    assert.equal(stats.overallStatus(['up', 'down']), 'degraded');
    assert.equal(stats.overallStatus(['down', 'down', 'unknown']), 'down');
  });

  test('downsampleResults keeps outages visible', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ ts: new Date(i * 1000).toISOString(), ok: i !== 42, statusCode: i === 42 ? 503 : 200, latencyMs: 100, error: i === 42 ? 'HTTP 503' : null }));
    const d = stats.downsampleResults(items, 10);
    assert.equal(d.length, 10);
    assert.equal(d.filter((x) => !x.ok).length, 1);
    assert.equal(d.find((x) => !x.ok)!.statusCode, 503);
  });

  test('jitter stays within ±10%', () => {
    assert.equal(stats.jitter(60_000, 0.1, () => 0), 54_000);
    assert.equal(stats.jitter(60_000, 0.1, () => 1), 66_000);
  });
});

describe('probe', () => {
  const resp = (status: number) => async () => new Response('x', { status });
  test('ok / bad status / expected status', async () => {
    assert.equal((await probe({ url: 'http://x', timeoutMs: 1000, expectedStatus: 0 }, resp(200))).ok, true);
    const bad = await probe({ url: 'http://x', timeoutMs: 1000, expectedStatus: 0 }, resp(502));
    assert.deepEqual([bad.ok, bad.statusCode, bad.error], [false, 502, 'HTTP 502']);
    const exp = await probe({ url: 'http://x', timeoutMs: 1000, expectedStatus: 204 }, resp(200));
    assert.equal(exp.error, 'Expected HTTP 204, got 200');
  });
  test('network errors are described', async () => {
    const r = await probe({ url: 'http://x', timeoutMs: 1000, expectedStatus: 0 }, async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 1.2.3.4:443' } });
    });
    assert.equal(r.ok, false);
    assert.match(r.error!, /ECONNREFUSED/);
    assert.equal(describeFetchError(Object.assign(new Error('x'), { name: 'TimeoutError' }), 5000), 'Timed out after 5000ms');
  });
});

describe('API + scheduler', () => {
  test('CRUD, validation, results and computed stats; alerts fire and resolve', async () => {
    const app = makeApp();
    const fired: any[] = [];
    const resolved: string[] = [];
    sched.setUptimeAlertHooks({ fire: (m, o) => fired.push({ m, ...o }), resolve: (k) => resolved.push(k) });

    let res = await app.request('/api/v1/uptime-checks', { method: 'POST', headers: auth, body: JSON.stringify({ url: 'ftp://nope' }) });
    assert.equal(res.status, 400);
    res = await app.request('/api/v1/uptime-checks', { method: 'POST', headers: auth, body: JSON.stringify({ url: 'https://x.test', intervalSec: 10 }) });
    assert.equal(res.status, 400, 'min interval 30');
    res = await app.request('/api/v1/uptime-checks', { method: 'POST', body: JSON.stringify({ url: 'https://x.test' }) });
    assert.equal(res.status, 401);

    res = await app.request('/api/v1/uptime-checks', { method: 'POST', headers: auth, body: JSON.stringify({ url: 'https://api.example.com/health', appId: 'api' }) });
    assert.equal(res.status, 201);
    const check = await res.json() as any;
    assert.equal(check.name, 'api.example.com');
    assert.equal(check.appId, 'a1');
    assert.equal(check.lastStatus, 'unknown');
    assert.equal(check.uptime24h, null);
    assert.equal(check.intervalSec, 60);

    const codes = [200, 500, 503, 503, 200];
    let n = 0;
    sched.setUptimeFetch(async () => new Response('', { status: codes[n++]! }));
    for (let i = 0; i < codes.length; i++) {
      await sched.runCheckNow(check.id);
      await new Promise((r) => setTimeout(r, 2)); // distinct ms timestamps
    }
    assert.equal(fired.length, 1);
    assert.equal(fired[0].m, 'uptime_down');
    assert.equal(fired[0].key, `uptime:${check.id}`);
    assert.equal(fired[0].appId, 'a1');
    assert.equal(fired[0].serverId, 's1');
    assert.equal(fired[0].severity, 'critical');
    assert.match(fired[0].message, /docksy:diagnose api/);
    assert.deepEqual(resolved, [`uptime:${check.id}`]);

    res = await app.request('/api/v1/uptime-checks', { headers: auth });
    const list = (await res.json() as any).items;
    const got = list.find((c: any) => c.id === check.id);
    assert.equal(got.lastStatus, 'up');
    assert.equal(got.uptime24h, 40);
    assert.equal(typeof got.avgLatencyMs24h, 'number');

    res = await app.request(`/api/v1/uptime-checks/${check.id}/results?range=24h`, { headers: auth });
    const results = (await res.json() as any).items;
    assert.equal(results.length, 5);
    assert.deepEqual(results.map((r: any) => r.statusCode), codes);
    assert.equal((await app.request(`/api/v1/uptime-checks/${check.id}/results?range=2y`, { headers: auth })).status, 400);

    res = await app.request(`/api/v1/uptime-checks/${check.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ name: 'API', intervalSec: 120, timeoutMs: 5000, public: false }) });
    const upd = await res.json() as any;
    assert.deepEqual([upd.name, upd.intervalSec, upd.timeoutMs, upd.public], ['API', 120, 5000, false]);
    res = await app.request(`/api/v1/uptime-checks/${check.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ timeoutMs: 60_000, intervalSec: 30 }) });
    assert.equal(res.status, 400, 'timeout must be shorter than interval');

    res = await app.request(`/api/v1/uptime-checks/${check.id}`, { method: 'DELETE', headers: auth });
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal((await app.request(`/api/v1/uptime-checks/${check.id}`, { method: 'PATCH', headers: auth, body: '{}' })).status, 404);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM uptime_results WHERE check_id = ?').get(check.id) as any).n, 0);
    const acts = db.prepare(`SELECT action FROM activity WHERE target_id = ? ORDER BY id`).all(check.id).map((r: any) => r.action);
    assert.deepEqual(acts, ['uptime.create', 'uptime.update', 'uptime.delete']);
  });

  test('retention deletes results older than 90 days', () => {
    const t = Date.now();
    db.prepare(`INSERT INTO uptime_checks (id, name, url, created_at) VALUES ('ret', 'r', 'https://r.test', ?)`).run(t);
    db.prepare('INSERT INTO uptime_results (check_id, ts, ok) VALUES (?, ?, 1)').run('ret', t - 91 * DAY);
    db.prepare('INSERT INTO uptime_results (check_id, ts, ok) VALUES (?, ?, 1)').run('ret', t - 89 * DAY);
    assert.equal(sched.runRetention(t), 1);
    db.prepare(`DELETE FROM uptime_checks WHERE id = 'ret'`).run();
  });
});

describe('public status page', () => {
  test('404 when disabled; 90 daily buckets; private checks hidden', async () => {
    const app = makeApp();
    setSettings({ statusPageEnabled: false });
    assert.equal((await app.request('/api/v1/public/status')).status, 404);

    setSettings({ statusPageEnabled: true, statusPageTitle: 'Acme status' });
    const t = Date.now();
    const today = Math.floor(t / DAY) * DAY;
    db.prepare(`INSERT INTO uptime_checks (id, name, url, public, created_at) VALUES ('pub', 'Website', 'https://acme.test', 1, ?)`).run(t);
    db.prepare(`INSERT INTO uptime_checks (id, name, url, public, created_at) VALUES ('priv', 'Secret', 'https://secret.test', 0, ?)`).run(t);
    const ins = db.prepare('INSERT INTO uptime_results (check_id, ts, ok, latency_ms) VALUES (?, ?, ?, 50)');
    // yesterday: 3 ok + 1 fail; 10 days ago: 2 ok; today: 1 ok (latest → up)
    ins.run('pub', today - DAY + 1000, 1); ins.run('pub', today - DAY + 2000, 1); ins.run('pub', today - DAY + 3000, 1); ins.run('pub', today - DAY + 4000, 0);
    ins.run('pub', today - 10 * DAY + 1000, 1); ins.run('pub', today - 10 * DAY + 2000, 1);
    ins.run('pub', Math.min(t - 1, today + 1000), 1);

    const res = await app.request('/api/v1/public/status');
    assert.equal(res.status, 200);
    const s = await res.json() as any;
    assert.equal(s.title, 'Acme status');
    assert.equal(s.overall, 'operational');
    assert.equal(s.checks.length, 1, 'private check hidden');
    const c = s.checks[0];
    assert.equal(c.name, 'Website');
    assert.equal(c.url, undefined, 'URLs are never exposed');
    assert.equal(c.status, 'up');
    assert.equal(c.days.length, 90);
    assert.equal(c.days[89].uptime, 100);
    assert.equal(c.days[88].uptime, 75);
    assert.equal(c.days[79].uptime, 100);
    assert.equal(c.days[50].uptime, null);
    assert.equal(c.uptime90d, 85.71); // 6 of 7

    ins.run('pub', t + 5, 0);
    const s2 = await (await app.request('/api/v1/public/status')).json() as any;
    assert.equal(s2.overall, 'down');
    db.prepare(`DELETE FROM uptime_checks WHERE id IN ('pub', 'priv')`).run();
  });
});

describe('auto-check on first successful deploy', () => {
  const deploy = (id: string, appId: string, status: string) =>
    db.prepare('INSERT INTO deployments (id, app_id, status, created_at) VALUES (?, ?, ?, ?)').run(id, appId, status, Date.now());

  test('creates https://<primary domain> once', () => {
    deploy('d1', 'a1', 'succeeded');
    const row = uptime.handleDeploymentFinished({ appId: 'a1', status: 'succeeded' });
    assert.ok(row);
    assert.equal(row!.url, 'https://api.example.com');
    assert.equal(row!.app_id, 'a1');
    assert.equal(uptime.handleDeploymentFinished({ appId: 'a1', status: 'succeeded' }), null, 'no duplicate');
    deploy('d2', 'a1', 'succeeded');
    db.prepare(`DELETE FROM uptime_checks WHERE app_id = 'a1'`).run();
    assert.equal(uptime.handleDeploymentFinished({ appId: 'a1', status: 'succeeded' }), null, 'only on the first success');
  });

  test('falls back to the sslip.io default domain; skips databases and failures', () => {
    deploy('d3', 'a2', 'succeeded');
    assert.equal(uptime.handleDeploymentFinished({ appId: 'a2', status: 'failed' }), null);
    const row = uptime.handleDeploymentFinished({ appId: 'a2', status: 'succeeded' });
    assert.equal(row!.url, 'https://web.203.0.113.7.sslip.io');
    deploy('d4', 'a3', 'succeeded');
    assert.equal(uptime.handleDeploymentFinished({ appId: 'a3', status: 'succeeded' }), null);
  });

  test('skips hosts that are not reachable from the internet', () => {
    for (const h of ['e2e-sample.localhost', 'localhost', '10.0.0.5','192.168.1.9', '172.20.0.3', 'box.local', 'http://127.0.0.1:3000'])
      assert.equal(uptime.isPublicHost(h), false, h);
    for (const h of ['api.example.com', 'web.203.0.113.7.sslip.io', '8.8.8.8', 'https://x.io/path'])
      assert.equal(uptime.isPublicHost(h), true, h);
  });
});
