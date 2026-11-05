import { test, describe, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOCKSY_DB_PATH = ':memory:';
process.env.DOCKSY_DISABLE_JOBS = '1';
process.env.DOCKSY_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'docksy-diagnose-'));

const { db, migrate } = await import('../../db/index.ts');
const { sha256 } = await import('../../lib/crypto.ts');
const { errorHandler } = await import('../../lib/http.ts');
const { Hono } = await import('hono');
const G = await import('./gather.ts');
const { registerDiagnose } = await import('./index.ts');

migrate();

const TOKEN = 'dsk_diagnose_test_token';
const GiB = 1024 ** 3;
const auth = { authorization: `Bearer ${TOKEN}` };
const app = new Hono<any>();
app.onError(errorHandler);
registerDiagnose(app);

let restore = () => {};
afterEach(() => restore());

const inspectLine = (o: Record<string, unknown>) => JSON.stringify({
  id: 'c0ffee000001aaaabbbbcccc', name: '/dx-api-aaaaaaaa', status: 'running', oom: false, exitCode: 0, restartCount: 0,
  startedAt: '2026-11-01T09:00:00.123456789Z', finishedAt: '0001-01-01T00:00:00Z', error: '', health: null,
  memLimit: 0, labels: { 'docksy.app': 'a1', 'docksy.managed': 'true' }, ...o,
});

function sshOut(opts: { inspect?: string[]; logs?: string[] } = {}) {
  return [
    '@@inspect',
    ...(opts.inspect ?? [inspectLine({})]),
    '@@df',
    '{"Active":"3","Reclaimable":"1.2GB (40%)","Size":"3GB","TotalCount":"5","Type":"Images"}',
    '{"Active":"0","Reclaimable":"800MB","Size":"800MB","TotalCount":"20","Type":"Build Cache"}',
    ...(opts.logs ? ['@@logs', '@@container /dx-api-aaaaaaaa', ...opts.logs] : []),
    '@@end',
    '',
  ].join('\n');
}

before(() => {
  const t = Date.now();
  db.prepare(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'a@b.c', 'A', 'x', 'owner', ?)`).run(t);
  db.prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, created_at) VALUES ('t1', 'u1', 'test', ?, 'dsk_diagno', 'read', ?)`).run(sha256(TOKEN), t);
  db.prepare(`INSERT INTO servers (id, name, host, status, last_seen_at, cpu_cores, mem_total, disk_total, created_at, updated_at)
              VALUES ('s1', 'prod-1', '203.0.113.7', 'ready', ?, 4, ?, ?, ?, ?)`).run(t - 3000, 8 * GiB, 100 * GiB, t - 1e9, t);
  db.prepare(`INSERT INTO apps (id, name, server_id, port, domains, status, current_deployment_id, webhook_secret, created_at, updated_at)
              VALUES ('a1', 'api', 's1', 3000, '["api.example.com"]', 'running', 'd2', 'whs', ?, ?)`).run(t - 1e9, t);
  db.prepare(`INSERT INTO deployments (id, app_id, status, trigger, image_tag, started_at, finished_at, created_at) VALUES ('d1', 'a1', 'succeeded', 'manual', 'docksy/api:d1', ?, ?, ?)`).run(t - 2e8, t - 2e8, t - 2e8);
  db.prepare(`INSERT INTO deployments (id, app_id, status, trigger, image_tag, started_at, finished_at, created_at) VALUES ('d2', 'a1', 'succeeded', 'webhook', 'docksy/api:d2', ?, ?, ?)`).run(t - 1e8, t - 1e8, t - 1e8);
  const m = db.prepare(`INSERT INTO metrics (server_id, res, ts, cpu, load1, mem_used, mem_total, swap_used, disk_used, disk_total, net_rx, net_tx) VALUES ('s1', 0, ?, ?, 0.5, ?, ?, 0, ?, ?, 100, 100)`);
  for (let k = 6; k >= 0; k--) m.run(t - k * 10_000, 10 + k, 3 * GiB, 8 * GiB, 40 * GiB, 100 * GiB);
  db.prepare(`INSERT INTO container_state (server_id, container_id, name, image, state, status, restart_count, started_at, cpu, mem_used, mem_limit, labels, app_id, updated_at)
              VALUES ('s1', 'c0ffee000001', 'dx-api-aaaaaaaa', 'docksy/api:d2', 'running', 'Up 3 hours', 0, '2026-11-01T09:00:00Z', 4.2, ?, 0, '{"docksy.app":"a1"}', 'a1', ?)`).run(300 * 1024 ** 2, t);
});

describe('ssh output parsing', () => {
  test('parses inspect, df and logs sections', () => {
    const p = G.parseSshOutput(sshOut({
      inspect: [inspectLine({}), inspectLine({ id: 'beef00000002ffff', name: '/worker', status: 'exited', oom: true, exitCode: 137, restartCount: 4,
        finishedAt: '2026-11-01T11:58:00Z', health: { Status: 'unhealthy', FailingStreak: 3, Log: [{ Output: 'old' }, { Output: 'curl failed\n' }] }, memLimit: 536870912 })],
      logs: ['2026-11-01T11:59:00Z hello', '@@inspect looks like a marker but is a log line'],
    }));
    assert.equal(p.complete, true);
    assert.equal(p.inspect.length, 2);
    assert.deepEqual(
      [p.inspect[0]!.id, p.inspect[0]!.name, p.inspect[0]!.finishedAt, p.inspect[0]!.startedAt],
      ['c0ffee000001', 'dx-api-aaaaaaaa', null, '2026-11-01T09:00:00.123Z'],
    );
    const w = p.inspect[1]!;
    assert.deepEqual([w.oomKilled, w.exitCode, w.restartCount, w.health, w.healthFailingStreak, w.healthLastOutput, w.memLimit],
      [true, 137, 4, 'unhealthy', 3, 'curl failed', 536870912]);
    assert.deepEqual(p.dockerDf.map((d) => [d.type, d.reclaimable]), [['Images', '1.2GB (40%)'], ['Build Cache', '800MB']]);
    assert.equal(p.logsContainer, 'dx-api-aaaaaaaa');
    assert.deepEqual(p.logs, ['2026-11-01T11:59:00Z hello', '@@inspect looks like a marker but is a log line']);
  });

  test('truncated output is flagged incomplete; garbage lines are skipped', () => {
    const p = G.parseSshOutput('@@inspect\nnot json\n' + inspectLine({}));
    assert.equal(p.complete, false);
    assert.equal(p.inspect.length, 1);
  });

  test('command includes logs only for app scope and quotes the filter', () => {
    assert.ok(!G.buildSshCommand(null).includes('docker logs'));
    const cmd = G.buildSshCommand('a1');
    assert.match(cmd, /docker logs --tail 100 --timestamps/);
    assert.match(cmd, /--filter 'label=docksy.app=a1'/);
    assert.match(cmd, /State\.OOMKilled/);
  });
});

describe('GET /diagnose', () => {
  test('healthy server report with ssh context', async () => {
    const calls: { serverId: string; opts: any }[] = [];
    restore = G.setDiagnoseDeps({ exec: async (serverId, _cmd, opts) => { calls.push({ serverId, opts }); return { code: 0, stdout: sshOut(), stderr: '' }; } });
    const res = await app.request('/api/v1/diagnose?serverId=s1', { headers: auth });
    assert.equal(res.status, 200);
    const r = await res.json() as any;
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.opts.timeoutMs, 10_000);
    assert.deepEqual(r.scope, { serverId: 's1', appId: null });
    assert.equal(r.healthy, true, JSON.stringify(r.findings));
    assert.deepEqual(r.findings, []);
    assert.equal(r.summary, 'prod-1 looks healthy: CPU 10.0%, memory 37.5%, disk 40.0%, 1/1 containers running.');
    assert.equal(r.context.server.id, 's1');
    assert.equal(r.context.trend1h.cpuMax, 16);
    assert.equal(r.context.recentDeployments.length, 2);
    assert.equal(r.context.containers.length, 1);
  });

  test('app scope implies its server, gathers logs + TLS, finds problems', async () => {
    let cmdSeen = '';
    restore = G.setDiagnoseDeps({
      exec: async (_s, cmd) => {
        cmdSeen = cmd;
        return { code: 0, stderr: '', stdout: sshOut({
          inspect: [inspectLine({ status: 'restarting', oom: true, exitCode: 137, restartCount: 6, memLimit: 512 * 1024 ** 2 })],
          logs: ['2026-11-01T11:59:00Z panic: runtime error: invalid memory address', '2026-11-01T11:59:01Z GET / 200'],
        }) };
      },
      tlsProbe: async (host) => ({ host, reachable: true, ok: true, validTo: new Date(Date.now() + 3 * 86_400_000).toISOString(), daysLeft: 3, issuer: "Let's Encrypt", error: null, errorCode: null }),
    });
    const r = await (await app.request('/api/v1/diagnose?appId=api&serverId=wrong', { headers: auth })).json() as any;
    assert.deepEqual(r.scope, { serverId: 's1', appId: 'a1' });
    assert.match(cmdSeen, /docksy\.app=a1/);
    assert.equal(r.healthy, false);
    const titles = r.findings.map((f: any) => f.title);
    assert.equal(titles[0], 'App api was killed for running out of memory');
    assert.ok(titles.includes('TLS certificate for api.example.com expires in 3 days'));
    assert.ok(titles.includes('1 error line in the last 2 log lines of api'));
    assert.equal(r.context.recentLogs.length, 2);
    assert.match(r.summary, /^App api on prod-1 has 1 critical and 2 warnings; most urgent: App api was killed for running out of memory\. Suggested first step: restart_app\.$/);
    for (const f of r.findings) {
      assert.ok(f.evidence.length > 0, `evidence for ${f.title}`);
      assert.ok(f.suggestion.length > 10, `suggestion for ${f.title}`);
    }
  });

  test('ssh failure degrades gracefully', async () => {
    restore = G.setDiagnoseDeps({ exec: async () => { throw new Error('connect ECONNREFUSED 203.0.113.7:22'); } });
    const r = await (await app.request('/api/v1/diagnose?serverId=s1', { headers: auth })).json() as any;
    assert.equal(r.healthy, true);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].severity, 'info');
    assert.ok(r.findings[0].evidence[0].includes('ECONNREFUSED'));
  });

  test('ssh that hangs is cut off', async () => {
    restore = G.setDiagnoseDeps({ exec: () => new Promise(() => {}), sshTimeoutMs: 200 });
    const t0 = Date.now();
    const r = await G.diagnose({ serverId: 's1' });
    assert.ok(Date.now() - t0 < 2_000);
    assert.match(r.findings[0]!.evidence[0]!, /timed out/);
  });

  test('a single server is the default scope; unknown ids 404; auth required', async () => {
    restore = G.setDiagnoseDeps({ exec: async () => ({ code: 0, stdout: sshOut(), stderr: '' }) });
    const r = await (await app.request('/api/v1/diagnose', { headers: auth })).json() as any;
    assert.equal(r.scope.serverId, 's1');
    assert.equal((await app.request('/api/v1/diagnose?serverId=nope', { headers: auth })).status, 404);
    assert.equal((await app.request('/api/v1/diagnose?appId=nope', { headers: auth })).status, 404);
    assert.equal((await app.request('/api/v1/diagnose')).status, 401);
  });

  test('fleet mode with several servers is DB-only and prefixes titles', async () => {
    const t = Date.now();
    db.prepare(`INSERT INTO servers (id, name, host, status, last_seen_at, created_at, updated_at) VALUES ('s2', 'edge-2', '198.51.100.2', 'ready', ?, ?, ?)`).run(t - 30 * 60_000, t - 1e9, t);
    let sshCalls = 0;
    restore = G.setDiagnoseDeps({ exec: async () => { sshCalls++; return { code: 0, stdout: sshOut(), stderr: '' }; } });
    const r = await G.diagnose({});
    assert.equal(sshCalls, 0);
    assert.deepEqual(r.scope, { serverId: null, appId: null });
    assert.equal(r.findings[0]!.title, 'edge-2: edge-2 is offline');
    assert.match(r.summary, /^Your fleet \(2 servers\) has 1 critical/);
    db.prepare(`DELETE FROM servers WHERE id = 's2'`).run();
  });
});
