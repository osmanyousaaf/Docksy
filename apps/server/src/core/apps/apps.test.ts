import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

// Env must be set before db/config/crypto load, hence dynamic imports below.
const dataDir = mkdtempSync(join(tmpdir(), 'docksy-apps-test-'));
process.env.DOCKSY_DATA_DIR = dataDir;
process.env.DOCKSY_DB_PATH = ':memory:';
process.env.DOCKSY_DISABLE_JOBS = '1';
process.env.DOCKSY_SECRET = 'a'.repeat(64);
process.env.DOCKSY_PUBLIC_URL = 'https://docksy.example.com';

const { Hono } = await import('hono');
const { db, migrate } = await import('../../db/index.ts');
const { sha256, decrypt } = await import('../../lib/crypto.ts');
const { errorHandler } = await import('../../lib/http.ts');
const { bus } = await import('../../lib/events.ts');
const apps = await import('./index.ts');
const { TEMPLATES, templateCommand } = await import('./templates.ts');
const { expandValue, verifyGithubSignature, normalizeRepoUrl } = await import('./expand.ts');

migrate();

const TOKEN = 'dsk_test_full_token';
const READ_TOKEN = 'dsk_test_read_token';
const t0 = Date.now();
db.prepare('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('u1', 'me@example.com', 'Me', 'x', 'owner', t0);
db.prepare('INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('t1', 'u1', 'test', sha256(TOKEN), TOKEN.slice(0, 10), 'full', t0);
db.prepare('INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('t2', 'u1', 'ro', sha256(READ_TOKEN), READ_TOKEN.slice(0, 10), 'read', t0);
db.prepare('INSERT INTO servers (id, name, host, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('srv1', 'vps', '203.0.113.7', t0, t0);

const server = new Hono<any>();
server.onError(errorHandler);
apps.registerApps(server);

async function call(method: string, path: string, payload?: unknown, token = TOKEN) {
  const res = await server.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const enqueued: { appId: string; trigger: string; meta: any }[] = [];
const execs: { serverId: string; cmd: string }[] = [];
let execResult: { code: number; stdout: string; stderr: string } | Error = { code: 0, stdout: '', stderr: '' };
const restore = apps.setAppsDeps({
  enqueueDeployment: (appId, trigger, meta = {}) => {
    enqueued.push({ appId, trigger, meta });
    return { id: `dep-${enqueued.length}`, appId, status: 'queued', trigger, commitSha: meta.commitSha ?? null, commitMessage: meta.commitMessage ?? null, imageTag: null, error: null, startedAt: null, finishedAt: null, createdAt: new Date().toISOString() };
  },
  exec: async (serverId, cmd) => {
    execs.push({ serverId, cmd });
    if (execResult instanceof Error) throw execResult;
    return execResult;
  },
});

after(() => { restore(); rmSync(dataDir, { recursive: true, force: true }); });

const events: string[] = [];
bus.on('app.created', (p) => events.push(`created:${p.appId}`));
bus.on('app.deleted', (p) => events.push(`deleted:${p.appId}`));

describe('templates', () => {
  test('cover the contract set with pinned images', () => {
    const ids = TEMPLATES.map((t) => t.id);
    for (const id of ['postgres', 'mysql', 'mariadb', 'redis', 'mongodb', 'n8n', 'uptime-kuma', 'umami', 'minio', 'ghost', 'wordpress']) assert.ok(ids.includes(id), id);
    assert.equal(new Set(ids).size, ids.length);
    for (const t of TEMPLATES) {
      assert.match(t.image, /:[^:]+$/, `${t.id} image must be tagged`);
      assert.ok(!t.image.endsWith(':latest'), `${t.id} must not use :latest`);
      assert.equal(t.backupSupported, t.kind === 'database', t.id);
    }
    assert.deepEqual(templateCommand('minio')?.slice(0, 2), ['server', '/data']);
    assert.equal(templateCommand('postgres'), null);
  });

  test('GET /templates', async () => {
    const r = await call('GET', '/api/v1/templates');
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, TEMPLATES.length);
  });
});

describe('placeholders + helpers', () => {
  test('random placeholders resolve to fresh alphanumerics', () => {
    const v = expandValue('a={{random:12}} b={{ random:5 }}', { domain: null });
    const m = v.match(/^a=([A-Za-z0-9]{12}) b=([A-Za-z0-9]{5})$/);
    assert.ok(m, v);
    assert.notEqual(expandValue('{{random:32}}', { domain: null }), expandValue('{{random:32}}', { domain: null }));
    assert.equal(expandValue('https://{{domain}}', { domain: 'x.io' }), 'https://x.io');
  });

  test('repo shorthand', () => {
    assert.equal(normalizeRepoUrl('osmanyousaaf/docksy'), 'https://github.com/osmanyousaaf/docksy.git');
    assert.equal(normalizeRepoUrl('https://gitlab.com/a/b.git'), 'https://gitlab.com/a/b.git');
  });
});

describe('apps CRUD', () => {
  let gitAppId = '';

  test('create from git: defaults, encrypted token, default domain, event + activity', async () => {
    const r = await call('POST', '/api/v1/apps', { name: 'web', serverId: 'srv1', repoUrl: 'acme/web', gitToken: 'ghp_secret123', port: 3000, env: { API_KEY: 'super-secret-value' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const a = r.body;
    gitAppId = a.id;
    assert.equal(a.sourceType, 'git');
    assert.equal(a.repoUrl, 'https://github.com/acme/web.git');
    assert.equal(a.branch, 'main');
    assert.equal(a.buildType, 'auto');
    assert.equal(a.hasGitToken, true);
    assert.equal(a.autoDeploy, true);
    assert.deepEqual(a.domains, ['web.203.0.113.7.sslip.io']);
    assert.equal(a.webhookUrl, `https://docksy.example.com/api/v1/webhooks/github/${a.id}`);
    assert.equal(a.status, 'idle');
    assert.ok(!('gitToken' in a));

    const row = db.prepare('SELECT git_token_enc, webhook_secret FROM apps WHERE id = ?').get(a.id) as any;
    assert.ok(row.git_token_enc.startsWith('v1:'));
    assert.ok(!row.git_token_enc.includes('ghp_secret123'));
    assert.equal(decrypt(row.git_token_enc), 'ghp_secret123');
    assert.match(row.webhook_secret, /^whs_/);

    const env = db.prepare('SELECT value_enc FROM app_env WHERE app_id = ? AND key = ?').get(a.id, 'API_KEY') as any;
    assert.ok(!env.value_enc.includes('super-secret'));
    assert.equal(decrypt(env.value_enc), 'super-secret-value');

    assert.ok(events.includes(`created:${a.id}`));
    const act = db.prepare(`SELECT * FROM activity WHERE action = 'app.create' AND target_id = ?`).get(a.id) as any;
    assert.equal(act.actor, 'token:test');
  });

  test('create from template: image/port/volumes come from template, randoms resolved, env encrypted', async () => {
    const r = await call('POST', '/api/v1/apps', { name: 'db1', serverId: 'srv1', template: 'postgres', env: { POSTGRES_DB: 'shop' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const a = r.body;
    assert.equal(a.kind, 'database');
    assert.equal(a.template, 'postgres');
    assert.equal(a.sourceType, 'image');
    assert.equal(a.buildType, 'image');
    assert.equal(a.image, 'postgres:17');
    assert.equal(a.port, 5432);
    assert.deepEqual(a.volumes, [{ name: 'data', mountPath: '/var/lib/postgresql/data' }]);
    assert.deepEqual(a.domains, [], 'databases are not routed');

    const rows = db.prepare('SELECT key, value_enc FROM app_env WHERE app_id = ?').all(a.id) as any[];
    const env = Object.fromEntries(rows.map((x) => [x.key, decrypt(x.value_enc)]));
    assert.match(env.POSTGRES_PASSWORD, /^[A-Za-z0-9]{32}$/);
    assert.equal(env.POSTGRES_DB, 'shop', 'user env overrides template env');
    for (const x of rows) assert.ok(x.value_enc.startsWith('v1:') && !x.value_enc.includes(env[x.key]));

    const n8n = await call('POST', '/api/v1/apps', { name: 'flows', serverId: 'srv1', template: 'n8n' });
    assert.equal(n8n.status, 201);
    const revealed = await call('GET', `/api/v1/apps/${n8n.body.id}/env?reveal=1`);
    assert.equal(revealed.body.vars.N8N_HOST, 'flows.203.0.113.7.sslip.io');
    assert.equal(revealed.body.vars.WEBHOOK_URL, 'https://flows.203.0.113.7.sslip.io/');
  });

  test('validation: names, server, template, source', async () => {
    for (const name of ['A', 'ab', 'Web', '1app', 'app-', 'my_app', 'a'.repeat(41), 'has space']) {
      const r = await call('POST', '/api/v1/apps', { name, serverId: 'srv1', image: 'nginx:1.27' });
      assert.equal(r.status, 400, name);
    }
    assert.equal((await call('POST', '/api/v1/apps', { name: 'abc', serverId: 'srv1', image: 'nginx:1.27' })).status, 201);
    assert.equal((await call('POST', '/api/v1/apps', { name: 'web', serverId: 'srv1', image: 'nginx:1.27' })).status, 409, 'duplicate name');
    assert.equal((await call('POST', '/api/v1/apps', { name: 'nosrv', serverId: 'nope', image: 'nginx:1.27' })).status, 400);
    assert.equal((await call('POST', '/api/v1/apps', { name: 'notpl', serverId: 'srv1', template: 'oracle' })).status, 400);
    assert.equal((await call('POST', '/api/v1/apps', { name: 'norepo', serverId: 'srv1', sourceType: 'git' })).status, 400);
    assert.equal((await call('POST', '/api/v1/apps', { name: 'badpath', serverId: 'srv1', repoUrl: 'a/b', dockerfilePath: '../etc/passwd' })).status, 400);
    assert.equal((await call('POST', '/api/v1/apps', { name: 'dupdom', serverId: 'srv1', image: 'nginx:1.27', domains: ['web.203.0.113.7.sslip.io'] })).status, 409);
    assert.equal((await call('POST', '/api/v1/apps', { name: 'readonly', serverId: 'srv1', image: 'nginx:1.27' }, READ_TOKEN)).status, 403);
  });

  test('list, get by id or name, patch', async () => {
    const list = await call('GET', '/api/v1/apps?serverId=srv1');
    assert.ok(list.body.items.length >= 3);
    assert.equal((await call('GET', '/api/v1/apps?serverId=other')).body.items.length, 0);
    assert.equal((await call('GET', '/api/v1/apps/web')).body.id, gitAppId);
    assert.equal((await call('GET', '/api/v1/apps/missing')).status, 404);

    const p = await call('PATCH', '/api/v1/apps/web', { branch: 'release', autoDeploy: false, gitToken: null, domains: ['WWW.Example.com'] });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.branch, 'release');
    assert.equal(p.body.autoDeploy, false);
    assert.equal(p.body.hasGitToken, false);
    assert.deepEqual(p.body.domains, ['www.example.com']);
    await call('PATCH', '/api/v1/apps/web', { branch: 'main', autoDeploy: true });

    const ren = await call('PATCH', '/api/v1/apps/abc', { name: 'abc-two' });
    assert.equal(ren.body.name, 'abc-two');
    assert.equal((await call('PATCH', '/api/v1/apps/web', { buildType: 'image' })).status, 400);
  });

  test('env: masked by default, reveal, PUT keeps masked round-trips', async () => {
    const masked = await call('GET', '/api/v1/apps/web/env');
    assert.equal(masked.body.vars.API_KEY, 'sup••••lue');
    const shown = await call('GET', '/api/v1/apps/web/env?reveal=1');
    assert.equal(shown.body.vars.API_KEY, 'super-secret-value');

    const put = await call('PUT', '/api/v1/apps/web/env', { vars: { API_KEY: masked.body.vars.API_KEY, NEW_ONE: 'hello-world-123' } });
    assert.equal(put.status, 200);
    assert.equal(put.body.vars.NEW_ONE, 'hel••••123');
    const after = await call('GET', '/api/v1/apps/web/env?reveal=1');
    assert.deepEqual(after.body.vars, { API_KEY: 'super-secret-value', NEW_ONE: 'hello-world-123' });

    assert.equal((await call('PUT', '/api/v1/apps/web/env', { vars: { 'BAD KEY': 'x' } })).status, 400);
    assert.equal((await call('PUT', '/api/v1/apps/web/env', { API_KEY: 'x' })).status, 400);
  });

  test('webhook info', async () => {
    const r = await call('GET', '/api/v1/apps/web/webhook');
    assert.equal(r.body.url, `https://docksy.example.com/api/v1/webhooks/github/${gitAppId}`);
    assert.match(r.body.secret, /^whs_/);
  });
});

describe('github webhook', () => {
  let id = '';
  let secret = '';
  before(async () => {
    const r = await call('GET', '/api/v1/apps/web/webhook');
    id = r.body.url.split('/').pop();
    secret = r.body.secret;
  });

  const sign = (s: string, raw: string) => 'sha256=' + createHmac('sha256', s).update(raw).digest('hex');
  const push = (branch: string, extra: object = {}) => JSON.stringify({ ref: `refs/heads/${branch}`, after: 'abc1234def', head_commit: { id: 'abc1234def', message: 'Fix bug\n\nlong body' }, ...extra });
  const hook = (raw: string, sig: string | null, event = 'push', appId = id) => server.request(`/api/v1/webhooks/github/${appId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': event, ...(sig ? { 'x-hub-signature-256': sig } : {}) },
    body: raw,
  });

  test('signature helper', () => {
    assert.equal(verifyGithubSignature('s', 'body', sign('s', 'body')), true);
    assert.equal(verifyGithubSignature('s', 'body', sign('t', 'body')), false);
    assert.equal(verifyGithubSignature('s', 'body', null), false);
    assert.equal(verifyGithubSignature('s', 'body', 'sha1=abc'), false);
  });

  test('valid push to the app branch enqueues a webhook deployment (no auth needed)', async () => {
    enqueued.length = 0;
    const raw = push('main');
    const res = await hook(raw, sign(secret, raw));
    assert.equal(res.status, 202);
    const b = await res.json() as any;
    assert.equal(b.deploymentId, 'dep-1');
    assert.deepEqual(enqueued, [{ appId: id, trigger: 'webhook', meta: { commitSha: 'abc1234def', commitMessage: 'Fix bug', ref: 'main' } }]);
  });

  test('invalid or missing signature → 401, nothing enqueued', async () => {
    enqueued.length = 0;
    const raw = push('main');
    assert.equal((await hook(raw, sign('whs_wrong', raw))).status, 401);
    assert.equal((await hook(raw, null)).status, 401);
    assert.equal((await hook(raw + ' ', sign(secret, raw))).status, 401, 'tampered body');
    assert.equal((await hook(raw, sign(secret, raw), 'push', 'no-such-app')).status, 401);
    assert.equal(enqueued.length, 0);
  });

  test('branch mismatch, tags, deleted branches and ping are acknowledged but skipped', async () => {
    enqueued.length = 0;
    for (const raw of [push('feature-x'), JSON.stringify({ ref: 'refs/tags/v1.0.0' }), push('main', { deleted: true })]) {
      const res = await hook(raw, sign(secret, raw));
      assert.equal(res.status, 200);
      assert.ok(((await res.json()) as any).skipped);
    }
    const ping = JSON.stringify({ zen: 'Keep it simple.' });
    const pr = await hook(ping, sign(secret, ping), 'ping');
    assert.equal(pr.status, 200);
    assert.equal(enqueued.length, 0);
  });

  test('autoDeploy off → skipped; form-encoded payloads work', async () => {
    enqueued.length = 0;
    await call('PATCH', '/api/v1/apps/web', { autoDeploy: false });
    const raw = push('main');
    const res = await hook(raw, sign(secret, raw));
    assert.equal(res.status, 200);
    assert.match(((await res.json()) as any).skipped, /Auto-deploy/);
    await call('PATCH', '/api/v1/apps/web', { autoDeploy: true });

    const form = 'payload=' + encodeURIComponent(push('main'));
    const fr = await server.request(`/api/v1/webhooks/github/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-github-event': 'push', 'x-hub-signature-256': sign(secret, form) },
      body: form,
    });
    assert.equal(fr.status, 202);
    assert.equal(enqueued.length, 1);
  });
});

describe('delete', () => {
  test('never-deployed app: no SSH, row removed, event emitted', async () => {
    execs.length = 0;
    const a = (await call('GET', '/api/v1/apps/abc-two')).body;
    const r = await call('DELETE', `/api/v1/apps/${a.id}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(execs.length, 0);
    assert.equal((await call('GET', `/api/v1/apps/${a.id}`)).status, 404);
    assert.ok(events.includes(`deleted:${a.id}`));
  });

  test('deployed app: removes containers by label + compose project; volumes only with ?volumes=1', async () => {
    const a = (await call('GET', '/api/v1/apps/db1')).body;
    db.prepare(`INSERT INTO deployments (id, app_id, status, trigger, created_at) VALUES (?, ?, 'succeeded', 'manual', ?)`).run('d-old', a.id, Date.now());
    db.prepare(`UPDATE apps SET status = 'running' WHERE id = ?`).run(a.id);

    // unreachable server → 502 and row kept
    execs.length = 0;
    execResult = new Error('connect ECONNREFUSED');
    assert.equal((await call('DELETE', `/api/v1/apps/${a.id}`)).status, 502);
    assert.equal((await call('GET', `/api/v1/apps/${a.id}`)).status, 200);

    // reachable, without volumes
    execResult = { code: 0, stdout: '', stderr: '' };
    const script = apps.removalScript(a, false);
    assert.match(script, new RegExp(`label=docksy\\.app=${a.id}`));
    assert.match(script, /docker compose -p 'docksy-db1' down --remove-orphans >/);
    assert.ok(!script.includes('docker volume rm'));
    const withVols = apps.removalScript(a, true);
    assert.match(withVols, /docker volume rm -f 'docksy-db1-data'/);
    assert.match(withVols, /down --remove-orphans -v/);

    execs.length = 0;
    const r = await call('DELETE', `/api/v1/apps/${a.id}?volumes=1`);
    assert.equal(r.status, 200);
    assert.equal(execs.length, 1);
    assert.equal(execs[0].serverId, 'srv1');
    assert.ok(execs[0].cmd.includes("docker volume rm -f 'docksy-db1-data'"));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deployments WHERE app_id = ?').get(a.id)!.n, 0, 'deployments cascade');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM app_env WHERE app_id = ?').get(a.id)!.n, 0, 'env cascades');
  });

  test('running deployment blocks delete unless ?force=1', async () => {
    const a = (await call('GET', '/api/v1/apps/flows')).body;
    db.prepare(`INSERT INTO deployments (id, app_id, status, trigger, created_at) VALUES (?, ?, 'building', 'manual', ?)`).run('d-run', a.id, Date.now());
    assert.equal((await call('DELETE', `/api/v1/apps/${a.id}`)).status, 409);
    execResult = new Error('host down');
    assert.equal((await call('DELETE', `/api/v1/apps/${a.id}?force=1`)).status, 200);
    execResult = { code: 0, stdout: '', stderr: '' };
  });
});
