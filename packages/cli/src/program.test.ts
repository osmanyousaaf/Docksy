import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App, Deployment, FleetOverview, MetricPoint, Server } from '@crovenai/docksy-client';
import { createContext } from './context.ts';
import { run } from './program.ts';
import { stripAnsi } from './format.ts';
import { buildCreateRequest, parseKeyValues, pickRollbackTarget } from './commands/apps.ts';
import { CliError } from './context.ts';
import { CLI_VERSION } from './version.ts';

// ───────────────────────────── fixtures ─────────────────────────────

const now = new Date().toISOString();
const server: Server = {
  id: 'srv_1', name: 'web-1', host: '203.0.113.10', port: 22, sshUser: 'root', status: 'ready', liveness: 'online',
  lastSeenAt: now, agentVersion: '0.1.0', os: 'ubuntu 24.04', arch: 'amd64', cpuCores: 4, memTotal: 8 * 1024 ** 3,
  diskTotal: 160 * 1024 ** 3, createdAt: now, updatedAt: now,
};
const point = (cpu: number): MetricPoint => ({
  ts: now, cpu, load1: 0.5, memUsed: 6 * 1024 ** 3, memTotal: 8 * 1024 ** 3, swapUsed: 0,
  diskUsed: 40 * 1024 ** 3, diskTotal: 160 * 1024 ** 3, netRx: 1200, netTx: 300,
});
const app: App = {
  id: 'app_1', name: 'blog', serverId: 'srv_1', kind: 'app', template: null, sourceType: 'git', repoUrl: 'https://github.com/me/blog',
  branch: 'main', hasGitToken: false, image: null, buildType: 'auto', dockerfilePath: 'Dockerfile', buildContext: '.',
  composePath: 'docker-compose.yml', port: 3000, domains: ['blog.example.com'], healthcheckPath: null, volumes: [],
  status: 'running', autoDeploy: true, webhookUrl: 'https://d/api/v1/webhooks/github/app_1', currentDeploymentId: 'dep_3',
  createdAt: now, updatedAt: now,
};
const dep = (id: string, status: Deployment['status'], createdAt: string, imageTag: string | null = 'docksy/blog:x'): Deployment => ({
  id, appId: 'app_1', status, trigger: 'manual', commitSha: 'abcdef1234', commitMessage: 'fix', imageTag, error: status === 'failed' ? 'build failed' : null,
  startedAt: createdAt, finishedAt: createdAt, createdAt,
});
const overview: FleetOverview = {
  servers: [{ server, latest: point(42), spark: [10, 20, 30, 42], appsCount: 1, firingAlerts: 0 }],
  totals: { servers: 1, online: 1, apps: 1, runningContainers: 3, firingAlerts: 0 },
};

// ───────────────────────────── mock API ─────────────────────────────

type Req = { method: string; url: string; headers: IncomingMessage['headers']; body: string };
const reqs: Req[] = [];
let env: Record<string, string> = {};
let deployOutcome: 'succeeded' | 'failed' = 'succeeded';
let http: HttpServer;
let base = '';

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function handle(req: IncomingMessage, res: ServerResponse, body: string) {
  const u = new URL(req.url!, 'http://x');
  const route = `${req.method} ${u.pathname.replace('/api/v1', '')}`;
  if (req.headers.authorization !== 'Bearer dsk_good' && route !== 'GET /auth/state') {
    return send(res, 401, { error: { code: 'unauthorized', message: 'Login or API token required' } });
  }
  switch (route) {
    case 'GET /auth/state': return send(res, 200, { setupRequired: false, user: null });
    case 'GET /auth/me': return send(res, 200, { id: 'u1', email: 'me@example.com', name: 'Me', role: 'owner', createdAt: now });
    case 'GET /servers': return send(res, 200, { items: [server] });
    case 'GET /servers/srv_1': return send(res, 200, server);
    case 'DELETE /servers/srv_1': return send(res, 200, { ok: true });
    case 'GET /servers/srv_1/metrics': return send(res, 200, { serverId: 'srv_1', range: u.searchParams.get('range'), stepSec: 10, points: [point(10), point(50), point(42)] });
    case 'GET /servers/srv_1/containers': return send(res, 200, { items: [{ id: 'c1', name: 'dx-blog-1234', image: 'docksy/blog:x', state: 'running', status: 'Up 2 hours', restartCount: 0, startedAt: now, cpuPercent: 12.5, memUsed: 200 * 1024 ** 2, memLimit: 1024 ** 3, netRx: 10, netTx: 5, labels: {}, serverId: 'srv_1', appId: 'app_1', updatedAt: now }] });
    case 'GET /overview': return send(res, 200, overview);
    case 'GET /apps': return send(res, 200, { items: [app] });
    case 'POST /apps': return send(res, 201, { ...app, ...JSON.parse(body), id: 'app_2' });
    case 'GET /apps/blog': case 'GET /apps/app_1': return send(res, 200, app);
    case 'GET /apps/blog/env': return send(res, 200, { vars: u.searchParams.get('reveal') ? env : Object.fromEntries(Object.keys(env).map((k) => [k, '••••'])) });
    case 'PUT /apps/blog/env': env = JSON.parse(body).vars; return send(res, 200, { vars: env });
    case 'POST /apps/app_1/deploy': case 'POST /apps/app_1/rollback': return send(res, 202, dep('dep_9', 'queued', now));
    case 'GET /deployments': return send(res, 200, { items: [dep('dep_3', 'succeeded', '2026-01-03T00:00:00Z'), dep('dep_2', 'failed', '2026-01-02T00:00:00Z'), dep('dep_1', 'succeeded', '2026-01-01T00:00:00Z')] });
    case 'GET /deployments/dep_9': return send(res, 200, dep('dep_9', deployOutcome, now));
    case 'GET /deployments/dep_9/logs/stream': {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: status\ndata: ${JSON.stringify({ status: 'building', error: null })}\n\n`);
      res.write(`event: log\ndata: ${JSON.stringify({ ts: now, stream: 'system', line: '::step:: Building image' })}\n\n`);
      res.write(`event: log\ndata: ${JSON.stringify({ ts: now, stream: 'stdout', line: 'npm ci' })}\n\n`);
      res.write(`event: status\ndata: ${JSON.stringify({ status: deployOutcome, error: deployOutcome === 'failed' ? 'build failed' : null })}\n\n`);
      return res.end();
    }
    case 'GET /diagnose': return send(res, 200, {
      generatedAt: now, scope: { serverId: u.searchParams.get('serverId'), appId: u.searchParams.get('appId') }, healthy: false,
      summary: 'Memory is high.', findings: [{ severity: 'critical', title: 'Memory is 96% used', detail: 'd', evidence: ['mem 7.7 GB / 8 GB'], suggestion: 'Restart blog', action: { tool: 'restart_app', args: { id: 'blog' } } }],
      context: { server: null, latest: null, trend1h: null, firingAlerts: [], recentDeployments: [], containers: [], recentLogs: [] },
    });
    case 'GET /alerts': return send(res, 200, { items: [] });
    default: return send(res, 404, { error: { code: 'not_found', message: `No route ${route}` } });
  }
}

let cfgDir = '';
before(async () => {
  http = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { reqs.push({ method: req.method!, url: req.url!, headers: req.headers, body }); handle(req, res, body); });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  cfgDir = mkdtempSync(join(tmpdir(), 'docksy-cli-test-'));
});
after(() => new Promise<void>((r) => { http.close(() => r()); http.closeAllConnections(); rmSync(cfgDir, { recursive: true, force: true }); }));
beforeEach(() => { reqs.length = 0; env = { A: '1', C: '3' }; deployOutcome = 'succeeded'; });

async function cli(args: string[], o: { env?: Record<string, string | undefined>; config?: string } = {}) {
  let out = '';
  let err = '';
  const ctx = createContext({
    env: { DOCKSY_URL: base, DOCKSY_TOKEN: 'dsk_good', DOCKSY_CONFIG: o.config ?? join(cfgDir, 'none.json'), ...o.env } as NodeJS.ProcessEnv,
    stdout: { write: (s: string) => (out += s), isTTY: false, columns: 120 },
    stderr: { write: (s: string) => (err += s), isTTY: false, columns: 120 },
    stdin: Readable.from([]) as unknown as NodeJS.ReadStream,
    openUrl: () => {},
  });
  const code = await run(args, ctx);
  return { code, out: stripAnsi(out), err: stripAnsi(err) };
}

const calls = (method: string) => reqs.filter((r) => r.method === method).map((r) => r.url);

// ───────────────────────────── tests ─────────────────────────────

describe('argument parsing', () => {
  test('--help shows grouped commands and exits 0', async () => {
    const r = await cli(['--help']);
    assert.equal(r.code, 0);
    for (const s of ['Get started:', 'Apps & deploys:', 'Servers & monitoring:', 'Claude:', 'metrics', 'Examples:']) assert.ok(r.out.includes(s), s);
    assert.ok(!r.out.includes('help [command]'));
  });
  test('--version', async () => {
    const r = await cli(['--version']);
    assert.equal(r.code, 0);
    assert.equal(r.out.trim(), CLI_VERSION);
  });
  test('unknown command suggests the closest one', async () => {
    const r = await cli(['statsu']);
    assert.equal(r.code, 1);
    assert.match(r.err, /Did you mean status\?/);
  });
  test('missing required argument', async () => {
    const r = await cli(['deploy']);
    assert.equal(r.code, 1);
    assert.match(r.err, /missing required argument 'app'/);
  });
  test('invalid --range choice is rejected before any request', async () => {
    const r = await cli(['metrics', 'web-1', '--range', '2y']);
    assert.equal(r.code, 1);
    assert.match(r.err, /Allowed choices are 15m, 1h, 6h, 24h, 7d, 30d/);
    assert.equal(reqs.length, 0);
  });
  test('`servers --json` dispatches to the default ls subcommand', async () => {
    const r = await cli(['servers', '--json']);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out).map((s: Server) => s.name), ['web-1']);
  });
  test('parseKeyValues', () => {
    assert.deepEqual(parseKeyValues(['A=1', 'B=x=y', 'C=', 'D="quoted value"']), { A: '1', B: 'x=y', C: '', D: 'quoted value' });
    assert.throws(() => parseKeyValues(['nope']), CliError);
    assert.throws(() => parseKeyValues(['1BAD=x']), /not a valid variable name/);
  });
  test('buildCreateRequest', () => {
    assert.deepEqual(buildCreateRequest('x', 's', { image: 'nginx', port: '80', env: ['A=1'], domain: ['a.io,b.io'] }), {
      name: 'x', serverId: 's', sourceType: 'image', image: 'nginx', buildType: 'image', port: 80, env: { A: '1' }, domains: ['a.io', 'b.io'],
    });
    assert.deepEqual(buildCreateRequest('x', 's', { repo: 'https://g/r', dockerfile: 'docker/Dockerfile', autoDeploy: false }), {
      name: 'x', serverId: 's', sourceType: 'git', repoUrl: 'https://g/r', branch: 'main', buildType: 'dockerfile', dockerfilePath: 'docker/Dockerfile', autoDeploy: false,
    });
    assert.deepEqual(buildCreateRequest('db', 's', { template: 'postgres' }), { name: 'db', serverId: 's', template: 'postgres' });
    assert.throws(() => buildCreateRequest('x', 's', {}), /what to run/);
    assert.throws(() => buildCreateRequest('x', 's', { image: 'a', repo: 'b' }), /only one/);
    assert.throws(() => buildCreateRequest('x', 's', { image: 'a', port: '99999' }), /valid port/);
  });
  test('pickRollbackTarget skips the current and failed deployments', () => {
    const ds = [dep('d1', 'succeeded', '2026-01-01T00:00:00Z'), dep('d3', 'succeeded', '2026-01-03T00:00:00Z'), dep('d2', 'failed', '2026-01-02T00:00:00Z'), dep('d0', 'succeeded', '2026-01-04T00:00:00Z', null)];
    assert.equal(pickRollbackTarget(ds, 'd3')?.id, 'd1');
    assert.equal(pickRollbackTarget(ds, null)?.id, 'd3');
    assert.equal(pickRollbackTarget([], null), undefined);
  });
});

describe('commands against a mock API', () => {
  test('not logged in gives a friendly hint', async () => {
    const r = await cli(['status'], { env: { DOCKSY_URL: undefined, DOCKSY_TOKEN: undefined } });
    assert.equal(r.code, 1);
    assert.match(r.err, /Not connected/);
    assert.match(r.err, /docksy login/);
  });
  test('401 suggests logging in again', async () => {
    const r = await cli(['apps'], { env: { DOCKSY_TOKEN: 'dsk_bad' } });
    assert.equal(r.code, 1);
    assert.match(r.err, /Login or API token required/);
    assert.match(r.err, /docksy login/);
  });
  test('status renders bars and sparklines; --json is raw', async () => {
    const r = await cli(['status']);
    assert.equal(r.code, 0);
    assert.match(r.out, /web-1/);
    assert.match(r.out, /█/);
    assert.match(r.out, /42%/);
    assert.match(r.out, /[▁▂▃▄▅▆▇█]{4}/);
    const j = await cli(['status', '--json']);
    assert.deepEqual(JSON.parse(j.out), overview);
  });
  test('metrics resolves the server by name and passes the range', async () => {
    const r = await cli(['metrics', 'web-1', '-r', '24h']);
    assert.equal(r.code, 0, r.err);
    assert.ok(calls('GET').includes('/api/v1/servers/srv_1/metrics?range=24h'));
    assert.match(r.out, /CPU/);
    assert.match(r.out, /dx-blog-1234/);
    assert.match(r.out, /6\.0 GB \/ 8\.0 GB/);
    const bad = await cli(['metrics', 'nope']);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /No server called "nope"/);
  });
  test('env set merges with existing vars', async () => {
    const r = await cli(['env', 'blog', 'set', 'B=2', 'C=three']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(env, { A: '1', C: 'three', B: '2' });
    const u = await cli(['env', 'blog', 'unset', 'A', 'ZZZ']);
    assert.equal(u.code, 0, u.err);
    assert.deepEqual(env, { C: 'three', B: '2' });
    assert.match(u.out, /not set: ZZZ/);
    const ls = await cli(['env', 'blog', '--json']);
    assert.deepEqual(JSON.parse(ls.out), { C: '••••', B: '••••' });
    const bad = await cli(['env', 'blog', 'set', 'oops']);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /KEY=value/);
  });
  test('apps create picks the only server and posts the request', async () => {
    const r = await cli(['apps', 'create', 'api', '--image', 'nginx:alpine', '--port', '80', '-e', 'X=1']);
    assert.equal(r.code, 0, r.err);
    const post = reqs.find((q) => q.method === 'POST' && q.url === '/api/v1/apps')!;
    assert.deepEqual(JSON.parse(post.body), { name: 'api', serverId: 'srv_1', sourceType: 'image', image: 'nginx:alpine', buildType: 'image', port: 80, env: { X: '1' } });
    assert.match(r.out, /docksy deploy api/);
  });
  test('deploy --follow streams the log and exits 0 on success, 1 on failure', async () => {
    const ok = await cli(['deploy', 'blog', '--follow']);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /▸ Building image/);
    assert.match(ok.out, /npm ci/);
    assert.match(ok.out, /blog deployed/);
    deployOutcome = 'failed';
    const bad = await cli(['deploy', 'blog', '-f']);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /Deployment failed.*build failed/);
  });
  test('deploy --follow --json keeps stdout pure JSON (progress on stderr)', async () => {
    const r = await cli(['deploy', 'blog', '--follow', '--json', '--no-color']);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).status, 'succeeded');
    assert.match(r.err, /npm ci/);
  });
  test('rollback without an id picks the previous good deployment', async () => {
    const r = await cli(['rollback', 'blog']);
    assert.equal(r.code, 0, r.err);
    const post = reqs.find((q) => q.url === '/api/v1/apps/app_1/rollback')!;
    assert.deepEqual(JSON.parse(post.body), { deploymentId: 'dep_1' });
  });
  test('diagnose routes server vs app targets', async () => {
    const s = await cli(['diagnose', 'web-1']);
    assert.equal(s.code, 0, s.err);
    assert.ok(calls('GET').includes('/api/v1/diagnose?serverId=srv_1'));
    assert.match(s.out, /CRITICAL\s+Memory is 96% used/);
    assert.match(s.out, /restart_app/);
    const a = await cli(['diagnose', 'blog', '--json']);
    assert.equal(JSON.parse(a.out).scope.appId, 'app_1');
  });
  test('destructive commands refuse without a TTY unless --yes', async () => {
    const r = await cli(['servers', 'rm', 'web-1']);
    assert.equal(r.code, 1);
    assert.match(r.err, /--yes/);
    assert.equal(calls('DELETE').length, 0);
    const y = await cli(['servers', 'rm', 'web-1', '--yes']);
    assert.equal(y.code, 0, y.err);
    assert.deepEqual(calls('DELETE'), ['/api/v1/servers/srv_1']);
  });
  test('alerts with nothing firing', async () => {
    const r = await cli(['alerts']);
    assert.equal(r.code, 0);
    assert.match(r.out, /No firing alerts/);
    assert.ok(calls('GET').includes('/api/v1/alerts?state=firing&limit=50'));
  });
  test('login --token verifies and saves the config with 0600', async () => {
    const path = join(cfgDir, 'login', 'config.json');
    const r = await cli(['login', base, '--token', 'dsk_good'], { config: path, env: { DOCKSY_URL: undefined, DOCKSY_TOKEN: undefined } });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { url: base, token: 'dsk_good', user: 'me@example.com' });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const who = await cli(['whoami'], { config: path, env: { DOCKSY_URL: undefined, DOCKSY_TOKEN: undefined } });
    assert.match(who.out, /me@example.com/);
    const bad = await cli(['login', base, '--token', 'dsk_bad'], { config: path, env: { DOCKSY_TOKEN: undefined } });
    assert.equal(bad.code, 1);
    assert.match(bad.err, /rejected/);
  });
  test('open prints the app URL', async () => {
    const r = await cli(['open', 'blog']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`${base}/apps/app_1`));
  });
});

test('CLI_VERSION matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(CLI_VERSION, pkg.version);
});
