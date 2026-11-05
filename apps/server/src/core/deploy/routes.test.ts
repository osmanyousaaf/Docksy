import './testenv.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { db, newId, now, type Row } from '../../db/index.ts';
import { sha256 } from '../../lib/crypto.ts';
import { errorHandler, type AppEnv } from '../../lib/http.ts';
import { FakeRemote, insertApp, insertServer, setupDb } from './fixtures.ts';
import { appendLog, finishDeployment } from './model.ts';
import { registerDeploy } from './index.ts';
import { enqueue } from './queue.ts';
import { setRemote } from './remote.ts';

const TOKEN = 'dsk_routes_test_token';
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
let http: Hono<AppEnv>;
let serverId = '';
let fake: FakeRemote;

before(() => {
  setupDb();
  const uid = newId();
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, 'o@x.io', 'Owner', 'x', 'owner', ?)").run(uid, now());
  db.prepare("INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, created_at) VALUES (?, ?, 'cli', ?, 'dsk_routes', 'full', ?)")
    .run(newId(), uid, sha256(TOKEN), now());
  serverId = insertServer();
  http = new Hono<AppEnv>();
  http.onError(errorHandler);
  registerDeploy(http);
  fake = new FakeRemote();
  setRemote(fake);
});
after(() => setRemote(null));

const req = (method: string, path: string, body?: unknown) =>
  http.request(`/api/v1${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });

test('auth is required', async () => {
  const res = await http.request('/api/v1/deployments');
  assert.equal(res.status, 401);
});

test('deploy → 202 queued deployment (app by name), trigger api for tokens, activity logged', async () => {
  const app = insertApp({ name: 'r-deploy', serverId, repoUrl: 'https://github.com/a/b' });
  const res = await req('POST', '/apps/r-deploy/deploy');
  assert.equal(res.status, 202);
  const d = await res.json() as any;
  assert.equal(d.status, 'queued');
  assert.equal(d.appId, app);
  assert.equal(d.trigger, 'api');
  const act = db.prepare("SELECT * FROM activity WHERE action = 'app.deploy' AND target_id = ?").get(app) as Row;
  assert.equal(act.actor, 'token:cli');

  const list = await (await req('GET', `/deployments?appId=r-deploy&limit=5`)).json() as any;
  assert.equal(list.items.length, 1);
  assert.equal((await req('GET', `/deployments/${d.id}`)).status, 200);

  const cancel = await req('POST', `/deployments/${d.id}/cancel`);
  assert.equal(((await cancel.json()) as any).status, 'cancelled');
  assert.equal((await req('POST', `/deployments/${d.id}/cancel`)).status, 409);
  assert.equal((await req('POST', '/apps/r-deploy/deploy', { bogus: 1 })).status, 400);
});

test('deploy without a repo or image is rejected', async () => {
  insertApp({ name: 'r-empty', serverId, repoUrl: null });
  assert.equal((await req('POST', '/apps/r-empty/deploy')).status, 400);
  assert.equal((await req('POST', '/apps/nope-nope/deploy')).status, 404);
});

test('rollback picks the previous succeeded deployment with an image', async () => {
  const app = insertApp({ name: 'r-rollback', serverId, repoUrl: 'https://github.com/a/b' });
  assert.equal((await req('POST', '/apps/r-rollback/rollback', {})).status, 400);
  const oldD = enqueue(app, 'manual', {}, { imageTag: 'docksy/r-rollback:aaaaaaaa' });
  finishDeployment(oldD.id, 'succeeded', null);
  const cur = enqueue(app, 'manual', {}, { imageTag: 'docksy/r-rollback:bbbbbbbb' });
  finishDeployment(cur.id, 'succeeded', null);
  db.prepare('UPDATE apps SET current_deployment_id = ? WHERE id = ?').run(cur.id, app);

  const res = await req('POST', '/apps/r-rollback/rollback');
  assert.equal(res.status, 202);
  const d = await res.json() as any;
  assert.equal(d.trigger, 'rollback');
  assert.equal(d.imageTag, 'docksy/r-rollback:aaaaaaaa');
  const explicit = await (await req('POST', '/apps/r-rollback/rollback', { deploymentId: cur.id })).json() as any;
  assert.equal(explicit.imageTag, 'docksy/r-rollback:bbbbbbbb');
});

test('deployment logs + SSE stream replays lines then status and closes when finished', async () => {
  const app = insertApp({ name: 'r-logs', serverId, repoUrl: 'https://github.com/a/b' });
  const d = enqueue(app, 'manual');
  appendLog(d.id, 'stdout', 'step 1');
  appendLog(d.id, 'stderr', 'warn: x');
  finishDeployment(d.id, 'failed', 'Image build failed');
  const logs = await (await req('GET', `/deployments/${d.id}/logs`)).json() as any;
  assert.deepEqual(logs.items.map((l: any) => l.line), ['Queued (manual).', 'step 1', 'warn: x']);
  assert.equal(logs.items[2].stream, 'stderr');

  const res = await req('GET', `/deployments/${d.id}/logs/stream`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const text = await res.text(); // ends because the deployment is terminal
  const events = [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map((m) => [m[1], JSON.parse(m[2]!)]);
  assert.deepEqual(events.map((e) => e[0]), ['log', 'log', 'log', 'status']);
  assert.deepEqual(events[3]![1], { status: 'failed', error: 'Image build failed' });
});

test('SSE stream follows a live deployment until it finishes', async () => {
  const app = insertApp({ name: 'r-live', serverId, repoUrl: 'https://github.com/a/b' });
  const d = enqueue(app, 'manual');
  const res = await req('GET', `/deployments/${d.id}/logs/stream`);
  const textP = res.text();
  await new Promise((r) => setTimeout(r, 10));
  appendLog(d.id, 'stdout', 'live line');
  await new Promise((r) => setTimeout(r, 10));
  finishDeployment(d.id, 'succeeded', null);
  const text = await textP;
  assert.match(text, /live line/);
  assert.match(text, /"status":"queued"/);
  assert.match(text, /"status":"succeeded"/);
});

test('lifecycle + runtime logs go over ssh', async () => {
  const app = insertApp({ name: 'r-life', serverId, sourceType: 'image', image: 'nginx', buildType: 'image' });
  fake.on('docker logs --tail 20', { stdout: 'a\nb\n' });
  fake.on('docker stop $ids', { code: 0 });
  fake.on('docker start $ids', { code: 3 });
  const stop = await req('POST', '/apps/r-life/stop');
  assert.equal(stop.status, 200);
  assert.equal((db.prepare('SELECT status FROM apps WHERE id = ?').get(app) as Row).status, 'stopped');
  assert.equal((await req('POST', '/apps/r-life/start')).status, 409);
  const logs = await (await req('GET', '/apps/r-life/logs?tail=20')).json() as any;
  assert.deepEqual(logs.lines, ['a', 'b']);
});
