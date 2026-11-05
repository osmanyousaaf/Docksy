import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Server } from '@docksy/shared';
import { DocksyApi } from './api.ts';
import { createDocksyMcpServer } from './server.ts';
import { runHttp } from './http.ts';

const SERVERS: Server[] = [
  {
    id: 'srv_1', name: 'prod-1', host: '203.0.113.7', port: 22, sshUser: 'root', status: 'ready', liveness: 'online',
    lastSeenAt: new Date().toISOString(), agentVersion: '0.1.0', os: 'ubuntu 24.04', arch: 'amd64', cpuCores: 4,
    memTotal: 8 * 1024 ** 3, diskTotal: 80 * 1024 ** 3, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  },
];

interface Seen { method: string; url: string; auth: string | undefined; body: string }
const seen: Seen[] = [];
let env: Record<string, string> = { A: '1', SECRET: 's3cret' };
let mock: HttpServer;
let base = '';

before(async () => {
  mock = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.headers.authorization !== 'Bearer dsk_test') return send(401, { error: { code: 'unauthorized', message: 'Bad token' } });
      const url = new URL(req.url!, 'http://x');
      const p = url.pathname;
      if (p === '/api/v1/servers' && req.method === 'GET') return send(200, { items: SERVERS });
      if (p === '/api/v1/servers/srv_1') return send(200, SERVERS[0]);
      if (p.startsWith('/api/v1/servers/')) return send(404, { error: { code: 'not_found', message: 'Server not found' } });
      if (p === '/api/v1/overview')
        return send(200, { servers: [{ server: SERVERS[0], latest: null, spark: [1, 2, 3], appsCount: 0, firingAlerts: 0 }], totals: { servers: 1, online: 1, apps: 0, runningContainers: 0, firingAlerts: 0 } });
      if (p === '/api/v1/apps/web')
        return send(200, { id: 'app_1', name: 'web', serverId: 'srv_1', domains: [], status: 'running' });
      if (p === '/api/v1/apps/app_1/env' && req.method === 'GET') {
        return send(200, { vars: url.searchParams.get('reveal') === '1' ? env : Object.fromEntries(Object.keys(env).map((k) => [k, '••••'])) });
      }
      if (p === '/api/v1/apps/app_1/env' && req.method === 'PUT') {
        env = JSON.parse(body).vars;
        return send(200, { ok: true });
      }
      send(404, { error: { code: 'not_found', message: `no route ${p}` } });
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((r) => mock.close(() => r())));

async function connect(opts: { token?: string; readonly?: boolean } = {}): Promise<Client> {
  const api = new DocksyApi({ url: base, token: opts.token ?? 'dsk_test' });
  const { server } = createDocksyMcpServer({ api, readonly: opts.readonly });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientT);
  return client;
}

const text = (r: unknown): string => ((r as { content: { text: string }[] }).content[0]).text;

test('round trip: list_servers against a mocked Docksy API', async () => {
  const client = await connect();
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 34);
  const r = await client.callTool({ name: 'list_servers', arguments: {} });
  assert.equal(r.isError, undefined);
  assert.match(text(r), /## Servers \(1\)/);
  assert.match(text(r), /\| prod-1 \| srv_1 \| 203\.0\.113\.7 \| ready \| online \|/);
  assert.equal((r.structuredContent as { items: Server[] }).items[0].id, 'srv_1');
  const call = seen.find((s) => s.url === '/api/v1/servers');
  assert.equal(call?.auth, 'Bearer dsk_test');
  await client.close();
});

test('server names resolve to ids', async () => {
  const client = await connect();
  const r = await client.callTool({ name: 'get_server', arguments: { serverId: 'PROD-1' } });
  assert.match(text(r), /## Server prod-1/);
  const miss = await client.callTool({ name: 'get_server', arguments: { serverId: 'nope' } });
  assert.equal(miss.isError, true);
  assert.match(text(miss), /Known servers: prod-1/);
  await client.close();
});

test('API errors surface as isError with a hint', async () => {
  const client = await connect({ token: 'dsk_wrong' });
  const r = await client.callTool({ name: 'list_servers', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(text(r), /HTTP 401, unauthorized\): Bad token/);
  assert.match(text(r), /DOCKSY_TOKEN/);
  await client.close();
});

test('destructive tool without confirm is refused end to end', async () => {
  const client = await connect();
  const before = seen.length;
  const r = await client.callTool({ name: 'delete_server', arguments: { serverId: 'srv_1' } });
  assert.equal(r.isError, true);
  assert.equal(seen.length, before, 'no API call made');
  await client.close();
});

test('readonly mode only lists read tools', async () => {
  const client = await connect({ readonly: true });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 16);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
  await client.close();
});

test('set_env_vars merges with existing values and never echoes them', async () => {
  const client = await connect();
  const r = await client.callTool({ name: 'set_env_vars', arguments: { appId: 'web', set: { B: '2' }, unset: ['A'] } });
  assert.equal(r.isError, undefined, text(r));
  assert.deepEqual(env, { SECRET: 's3cret', B: '2' });
  assert.doesNotMatch(text(r), /s3cret/);
  assert.doesNotMatch(JSON.stringify(r.structuredContent), /s3cret/);
  await client.close();
});

test('resources and prompts', async () => {
  const client = await connect();
  const res = await client.readResource({ uri: 'docksy://overview' });
  assert.match((res.contents[0] as { text: string }).text, /Fleet: 1 server/);
  const list = await client.listResources();
  assert.ok(list.resources.some((r) => r.uri === 'docksy://servers/srv_1/metrics'));
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(), ['deploy_new_app', 'diagnose_server', 'incident_response']);
  const p = await client.getPrompt({ name: 'diagnose_server', arguments: { server: 'prod-1' } });
  assert.match((p.messages[0].content as { text: string }).text, /diagnose` with serverId "prod-1"/);
  await client.close();
});

test('streamable HTTP transport on 127.0.0.1', async () => {
  const h = await runHttp({ url: base, token: 'dsk_test', readonly: false }, 0);
  try {
    assert.match(h.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const client = new Client({ name: 'http-test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(h.url)));
    const r = await client.callTool({ name: 'list_servers', arguments: {} });
    assert.match(text(r), /prod-1/);
    await client.close();
    // fetch() can't override Host, so use node:http for the DNS-rebinding check.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(h.url, { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(status, 403);
  } finally {
    await h.close();
  }
});
