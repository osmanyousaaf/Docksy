import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { DocksyClient, DocksyApiError, normalizeBaseUrl, VERSION } from './index.ts';

type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: string };
type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let server: Server;
let base = '';
const seen: Seen[] = [];
const routes = new Map<string, Handler>();
let streamClosed = false;

function json(res: ServerResponse, status: number, data: unknown, headers: Record<string, string | string[]> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
}

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const path = req.url!.split('?')[0];
      const h = routes.get(`${req.method} ${path}`);
      if (h) return h(req, res, body);
      json(res, 404, { error: { code: 'not_found', message: `No route ${req.method} ${path}` } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  routes.set('GET /api/v1/apps', (_q, res) => json(res, 200, { items: [{ id: 'a1', name: 'web' }] }));
  routes.set('GET /api/v1/apps/my%20app', (_q, res) => json(res, 200, { id: 'a2', name: 'my app' }));
  routes.set('POST /api/v1/apps/web/deploy', (_q, res) => json(res, 202, { id: 'd1', status: 'queued' }));
  routes.set('DELETE /api/v1/apps/web', (_q, res) => json(res, 200, { ok: true }));
  routes.set('GET /api/v1/servers/s1', (_q, res) => json(res, 409, { error: { code: 'conflict', message: 'Server has apps', details: { apps: 2 } } }));
  routes.set('GET /api/v1/overview', (_q, res) => { res.writeHead(502, { 'content-type': 'text/html' }); res.end('<html>Bad gateway</html>'); });
  routes.set('GET /api/v1/health', (_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('not json'); });
  routes.set('GET /api/v1/settings', (_q, res) => { setTimeout(() => json(res, 200, {}), 500); });
  routes.set('POST /api/v1/auth/login', (_q, res) => json(res, 200, { id: 'u1', email: 'a@b.c' }, { 'set-cookie': ['docksy_session=dss_abc; Path=/; HttpOnly; SameSite=Lax'] }));
  routes.set('GET /api/v1/auth/me', (_q, res) => json(res, 200, { id: 'u1' }));
  routes.set('GET /api/v1/apps/web/env', (_q, res) => json(res, 200, { vars: { A: '1', B: '2', C: '3' } }));
  routes.set('PUT /api/v1/apps/web/env', (_q, res, body) => json(res, 200, JSON.parse(body)));
  routes.set('GET /api/v1/deployments/d1/logs/stream', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': hello\n\n');
    res.write('event: log\ndata: {"ts":"t","stream":"stdout","line":"step 1"}\n\n');
    res.write('event: lo');
    setTimeout(() => {
      res.write('g\r\ndata: {"ts":"t","stream":"stderr","line":"step 2"}\r\n\r\n');
      res.write('event: status\ndata: {"status":"succeeded","error":null}\n\n');
    }, 20);
    res.on('close', () => res.end());
  });
  routes.set('GET /api/v1/deployments/d1', (_q, res) => json(res, 200, { id: 'd1', status: 'succeeded' }));
  routes.set('GET /api/v1/apps/web/logs/stream', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let n = 0;
    const t = setInterval(() => res.write(`event: log\ndata: {"line":"line ${n++}"}\n\n`), 5);
    res.on('close', () => { clearInterval(t); streamClosed = true; });
  });
});

after(() => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }));

const last = () => seen[seen.length - 1];

describe('normalizeBaseUrl', () => {
  test('strips trailing slashes and /api/v1', () => {
    assert.equal(normalizeBaseUrl('https://docksy.example.com/'), 'https://docksy.example.com');
    assert.equal(normalizeBaseUrl('https://docksy.example.com/api/v1/'), 'https://docksy.example.com');
    assert.equal(normalizeBaseUrl('https://x.io/sub/path//'), 'https://x.io/sub/path');
  });
  test('adds a scheme (http for localhost, https otherwise)', () => {
    assert.equal(normalizeBaseUrl('localhost:8080'), 'http://localhost:8080');
    assert.equal(normalizeBaseUrl('docksy.example.com'), 'https://docksy.example.com');
  });
  test('rejects garbage', () => {
    assert.throws(() => normalizeBaseUrl('http://'), TypeError);
  });
});

describe('DocksyClient', () => {
  test('builds URLs with an /api/v1 prefix and drops empty query values', () => {
    const c = new DocksyClient({ url: 'https://d.io/' });
    assert.equal(c.url('/apps', { serverId: 's1', x: undefined, y: '' }), 'https://d.io/api/v1/apps?serverId=s1');
    assert.equal(c.url('/api/agent/v1/install.sh'), 'https://d.io/api/agent/v1/install.sh');
    assert.equal(c.agentBinaryUrl('linux-arm64'), 'https://d.io/api/agent/v1/binary/linux-arm64');
  });

  test('sends auth, user-agent and unwraps list responses', async () => {
    const c = new DocksyClient({ url: base, token: 'dsk_test' });
    const apps = await c.listApps({ serverId: 's1' });
    assert.deepEqual(apps, [{ id: 'a1', name: 'web' }]);
    const r = last();
    assert.equal(r.url, '/api/v1/apps?serverId=s1');
    assert.equal(r.headers.authorization, 'Bearer dsk_test');
    assert.equal(r.headers['user-agent'], `docksy-client/${VERSION}`);
    assert.equal(r.headers.accept, 'application/json');
  });

  test('encodes path params and sends JSON bodies', async () => {
    const c = new DocksyClient({ url: base, token: 'dsk_test' });
    assert.equal((await c.getApp('my app')).id, 'a2');
    assert.equal(last().url, '/api/v1/apps/my%20app');
    const d = await c.deployApp('web', { ref: 'main', trigger: 'api' });
    assert.equal(d.id, 'd1');
    assert.equal(last().headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(last().body), { ref: 'main', trigger: 'api' });
    await c.deleteApp('web', { volumes: true });
    assert.equal(last().url, '/api/v1/apps/web?volumes=1');
    await c.deleteApp('web');
    assert.equal(last().url, '/api/v1/apps/web');
  });

  test('maps ApiError JSON to DocksyApiError', async () => {
    const c = new DocksyClient({ url: base });
    await assert.rejects(c.getServer('s1'), (e: unknown) => {
      assert.ok(e instanceof DocksyApiError);
      assert.equal(e.status, 409);
      assert.equal(e.code, 'conflict');
      assert.equal(e.message, 'Server has apps');
      assert.deepEqual(e.details, { apps: 2 });
      assert.equal(e.method, 'GET');
      assert.equal(e.path, '/servers/s1');
      return true;
    });
    await assert.rejects(c.getApp('nope'), (e: DocksyApiError) => e.isNotFound && e.code === 'not_found');
  });

  test('maps non-JSON errors and invalid bodies', async () => {
    const c = new DocksyClient({ url: base });
    await assert.rejects(c.getFleetOverview(), (e: DocksyApiError) => e.status === 502 && e.code === 'http_502' && !e.message.includes('<html>'));
    await assert.rejects(c.health(), (e: DocksyApiError) => e.code === 'invalid_response');
  });

  test('maps timeouts and network errors (status 0)', async () => {
    const c = new DocksyClient({ url: base, timeoutMs: 50 });
    await assert.rejects(c.getSettings(), (e: DocksyApiError) => e.status === 0 && e.code === 'timeout');
    const ac = new AbortController();
    const p = c.getSettings({ signal: ac.signal, timeoutMs: 5000 });
    ac.abort();
    await assert.rejects(p, (e: DocksyApiError) => e.code === 'aborted');
    const dead = new DocksyClient({ url: 'http://127.0.0.1:1' });
    await assert.rejects(dead.listApps(), (e: DocksyApiError) => e.isNetworkError && e.code === 'network_error');
  });

  test('captures the session cookie on login and reuses it', async () => {
    const c = new DocksyClient({ url: base });
    await c.login({ email: 'a@b.c', password: 'pw' });
    assert.equal(c.sessionCookie, 'dss_abc');
    await c.me();
    assert.equal(last().headers.cookie, 'docksy_session=dss_abc');
    assert.equal(last().headers.authorization, undefined);
  });

  test('patchEnv merges set/unset into the revealed env', async () => {
    const c = new DocksyClient({ url: base, token: 'dsk_x' });
    const r = await c.patchEnv('web', { set: { B: 'two', D: '4' }, unset: ['C'] });
    assert.deepEqual(r.vars, { A: '1', B: 'two', D: '4' });
    const get = seen[seen.length - 2];
    assert.equal(get.url, '/api/v1/apps/web/env?reveal=1');
  });

  test('streams SSE events across chunk boundaries', async () => {
    const c = new DocksyClient({ url: base, token: 'dsk_x' });
    const events = [];
    for await (const ev of c.streamDeploymentLogs('d1')) {
      events.push(ev);
      if (ev.event === 'status') break;
    }
    assert.equal(last().headers.accept, 'text/event-stream');
    assert.deepEqual(events.map((e) => e.event), ['log', 'log', 'status']);
    assert.equal((events[1].data as { line: string }).line, 'step 2');
  });

  test('followDeployment returns the final deployment', async () => {
    const c = new DocksyClient({ url: base, token: 'dsk_x' });
    const it = c.followDeployment('d1');
    const lines: string[] = [];
    let r = await it.next();
    while (!r.done) {
      if (r.value.event === 'log') lines.push(r.value.data.line);
      r = await it.next();
    }
    assert.deepEqual(lines, ['step 1', 'step 2']);
    assert.equal(r.value.status, 'succeeded');
  });

  test('breaking out of a stream closes the connection', async () => {
    const c = new DocksyClient({ url: base, token: 'dsk_x' });
    let n = 0;
    for await (const ev of c.streamAppLogs('web')) {
      assert.equal(ev.event, 'log');
      if (++n === 3) break;
    }
    for (let i = 0; i < 50 && !streamClosed; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(streamClosed, true);
  });

  test('the stream reports HTTP errors as DocksyApiError', async () => {
    const c = new DocksyClient({ url: base });
    await assert.rejects(async () => { for await (const _ of c.streamServerMetrics('zzz')) { /* none */ } }, (e: DocksyApiError) => e.status === 404);
  });

  test('VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(VERSION, pkg.version);
  });
});
