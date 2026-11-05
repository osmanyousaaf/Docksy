import { db, makeServer, makeUserToken, report, container } from './test-helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { errorHandler, type AppEnv } from '../../lib/http.ts';
import { bus } from '../../lib/events.ts';
import { registerMetrics } from './index.ts';

const app = new Hono<AppEnv>();
app.onError(errorHandler);
registerMetrics(app);

const user = makeUserToken();

const post = (token: string | null, body: unknown) =>
  app.request('/api/agent/v1/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const get = (path: string) => app.request(path, { headers: { authorization: user } });

test('agent report: rejects missing and wrong tokens', async () => {
  makeServer('auth');
  assert.equal((await post(null, report())).status, 401);
  assert.equal((await post('dsa_wrong', report())).status, 401);
  assert.equal((await post('dsk_user_token_not_agent', report())).status, 401);
});

test('agent report: stores, emits server.report and returns intervalSec', async () => {
  const s = makeServer('ok');
  let emitted: string | null = null;
  const off = bus.on('server.report', (p) => { emitted = p.serverId; });
  const res = await post(s.agentToken, { ...report({ containers: [container({ id: 'a', name: '/web' })] }), extraField: 'ignored' });
  off();
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.ok, true);
  assert.equal(typeof body.intervalSec, 'number');
  assert.equal(emitted, s.id);
  const n = db.prepare('SELECT COUNT(*) AS n FROM metrics WHERE server_id = ?').get(s.id) as any;
  assert.equal(n.n, 1);
  const c = await (await get(`/api/v1/servers/${s.id}/containers`)).json() as any;
  assert.equal(c.items[0].name, 'web'); // leading slash stripped
});

test('agent report: accepts Go-style nulls, rejects invalid and oversized bodies', async () => {
  const s = makeServer('loose');
  const goish = { ...report(), disks: null, containers: null, cpu: { percent: 5, cores: 1, perCore: null, load1: 0, load5: 0, load15: 0 } };
  assert.equal((await post(s.agentToken, goish)).status, 200);
  assert.equal((await post(s.agentToken, { cpu: 'high' })).status, 400);
  assert.equal((await post(s.agentToken, '{not json')).status, 400);
  const big = JSON.stringify({ ...report(), pad: 'x'.repeat(1024 * 1024 + 10) });
  assert.equal((await post(s.agentToken, big)).status, 413);
});

test('user routes require auth and validate range', async () => {
  const s = makeServer('reads');
  assert.equal((await app.request('/api/v1/overview')).status, 401);
  assert.equal((await app.request(`/api/v1/servers/${s.id}/metrics`)).status, 401);
  assert.equal((await get(`/api/v1/servers/${s.id}/metrics?range=2h`)).status, 400);
  assert.equal((await get(`/api/v1/servers/missing/metrics`)).status, 404);
  assert.equal((await get(`/api/v1/apps/missing/metrics`)).status, 404);
  await post(s.agentToken, report());
  const m = await (await get(`/api/v1/servers/${s.id}/metrics?range=15m`)).json() as any;
  assert.equal(m.range, '15m');
  assert.equal(m.points.length, 1);
  const ov = await (await get('/api/v1/overview')).json() as any;
  assert.ok(ov.totals.servers >= 1);
});

test('live SSE: sends latest on connect, then every new report', async () => {
  const s = makeServer('sse');
  await post(s.agentToken, report());
  const res = await get(`/api/v1/servers/${s.id}/metrics/live`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const nextEvent = async () => {
    let buf = '';
    while (!buf.includes('\n\n')) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buf += dec.decode(value);
    }
    return buf;
  };
  const first = await nextEvent();
  assert.match(first, /event: metrics/);
  const data = JSON.parse(first.split('\n').find((l) => l.startsWith('data: '))!.slice(6));
  assert.equal(data.serverId, s.id);
  assert.deepEqual(data.perCore, [10, 20, 30, 40]);

  await post(s.agentToken, report({ cpu: { percent: 77, cores: 4, perCore: [77], load1: 1, load5: 1, load15: 1 } }));
  const second = await nextEvent();
  assert.match(second, /"cpu":77/);
  await reader.cancel();
});
