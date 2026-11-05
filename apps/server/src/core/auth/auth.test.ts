import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOCKSY_DATA_DIR = mkdtempSync(join(tmpdir(), 'docksy-auth-'));
process.env.DOCKSY_DB_PATH = ':memory:';
process.env.DOCKSY_DISABLE_JOBS = '1';
delete process.env.DOCKSY_PUBLIC_URL;

const { Hono } = await import('hono');
const { db, migrate } = await import('../../db/index.ts');
const { errorHandler } = await import('../../lib/http.ts');
const { sha256 } = await import('../../lib/crypto.ts');
const auth = await import('./index.ts');
migrate();

const app = new Hono<import('../../lib/http.ts').AppEnv>();
app.onError(errorHandler);
auth.registerAuth(app);

type Opts = { method?: string; body?: unknown; cookie?: string; token?: string; ip?: string };
async function call(path: string, o: Opts = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': o.ip ?? '203.0.113.9' };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  const res = await app.request(`/api/v1${path}`, { method: o.method ?? 'GET', headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}
const cookieOf = (h: Headers) => (h.get('set-cookie') ?? '').split(';')[0]!;

let cookie = '';

test('auth state requires setup on a fresh instance', async () => {
  const r = await call('/auth/state');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { setupRequired: true, user: null });
});

test('setup creates the owner and a session; second setup is refused', async () => {
  const bad = await call('/auth/setup', { method: 'POST', body: { email: 'nope', name: 'x', password: 'short' } });
  assert.equal(bad.status, 400);

  const r = await call('/auth/setup', { method: 'POST', body: { email: ' Owner@Example.com ', name: 'Owner', password: 'correct horse battery' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.email, 'owner@example.com');
  assert.equal(r.json.role, 'owner');
  assert.equal(r.json.password_hash, undefined);
  cookie = cookieOf(r.headers);
  assert.match(cookie, /^docksy_session=dss_/);

  const again = await call('/auth/setup', { method: 'POST', body: { email: 'b@example.com', name: 'B', password: 'another password' } });
  assert.equal(again.status, 409);

  const state = await call('/auth/state', { cookie });
  assert.equal(state.json.setupRequired, false);
  assert.equal(state.json.user.email, 'owner@example.com');
});

test('login, me and logout', async () => {
  const wrong = await call('/auth/login', { method: 'POST', body: { email: 'owner@example.com', password: 'nope nope' }, ip: '198.51.100.1' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error.code, 'invalid_credentials');
  const unknown = await call('/auth/login', { method: 'POST', body: { email: 'ghost@example.com', password: 'nope nope' }, ip: '198.51.100.1' });
  assert.equal(unknown.status, 401);

  const ok = await call('/auth/login', { method: 'POST', body: { email: 'OWNER@example.com', password: 'correct horse battery' }, ip: '198.51.100.1' });
  assert.equal(ok.status, 200);
  const c2 = cookieOf(ok.headers);
  const me = await call('/auth/me', { cookie: c2 });
  assert.equal(me.status, 200);
  assert.equal(me.json.email, 'owner@example.com');

  assert.equal((await call('/auth/me')).status, 401);

  const out = await call('/auth/logout', { method: 'POST', cookie: c2 });
  assert.deepEqual(out.json, { ok: true });
  assert.equal((await call('/auth/me', { cookie: c2 })).status, 401);
  // logout is idempotent
  assert.equal((await call('/auth/logout', { method: 'POST' })).status, 200);
});

test('login is rate limited to 10 attempts per minute per IP', async () => {
  auth.resetLoginLimits();
  for (let i = 0; i < 10; i++) {
    const r = await call('/auth/login', { method: 'POST', body: { email: 'owner@example.com', password: 'bad password' }, ip: '192.0.2.50' });
    assert.equal(r.status, 401, `attempt ${i + 1}`);
  }
  const blocked = await call('/auth/login', { method: 'POST', body: { email: 'owner@example.com', password: 'correct horse battery' }, ip: '192.0.2.50' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error.code, 'rate_limited');
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  // a different IP is unaffected
  const other = await call('/auth/login', { method: 'POST', body: { email: 'owner@example.com', password: 'correct horse battery' }, ip: '192.0.2.51' });
  assert.equal(other.status, 200);
});

test('hitLoginLimit uses a sliding window', () => {
  auth.resetLoginLimits();
  const t0 = 1_000_000;
  for (let i = 0; i < 10; i++) assert.equal(auth.hitLoginLimit('x', t0 + i), 0);
  assert.ok(auth.hitLoginLimit('x', t0 + 100) > 0);
  assert.equal(auth.hitLoginLimit('x', t0 + 60_001), 0); // first attempt expired
});

test('API tokens: plaintext once, sha256 stored, bearer auth, read scope is read-only', async () => {
  const created = await call('/tokens', { method: 'POST', cookie, body: { name: 'ci' } });
  assert.equal(created.status, 201);
  const { token, plaintext } = created.json;
  assert.match(plaintext, /^dsk_[A-Za-z0-9_-]{40,}$/);
  assert.equal(token.prefix, plaintext.slice(0, 10));
  assert.equal(token.scope, 'full');
  assert.equal(token.plaintext, undefined);

  const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(token.id) as Record<string, string>;
  assert.equal(row.token_hash, sha256(plaintext));
  assert.ok(!JSON.stringify(row).includes(plaintext));

  const list = await call('/tokens', { cookie });
  assert.equal(list.json.items.length, 1);
  assert.equal(list.json.items[0].plaintext, undefined);
  assert.equal(JSON.stringify(list.json).includes(plaintext), false);

  const me = await call('/auth/me', { token: plaintext });
  assert.equal(me.status, 200);
  assert.equal(me.json.email, 'owner@example.com');
  const used = await call('/tokens', { token: plaintext });
  assert.ok(used.json.items[0].lastUsedAt);

  const ro = await call('/tokens', { method: 'POST', token: plaintext, body: { name: 'reader', scope: 'read' } });
  assert.equal(ro.status, 201);
  const readTok = ro.json.plaintext;
  assert.equal((await call('/settings', { token: readTok })).status, 200);
  const denied = await call('/settings', { method: 'PATCH', token: readTok, body: { instanceName: 'Nope' } });
  assert.equal(denied.status, 403);
  assert.equal((await call('/tokens', { method: 'POST', token: readTok, body: { name: 'x' } })).status, 403);

  assert.equal((await call('/auth/me', { token: 'dsk_not-a-real-token' })).status, 401);

  const del = await call(`/tokens/${token.id}`, { method: 'DELETE', cookie });
  assert.deepEqual(del.json, { ok: true });
  assert.equal((await call('/auth/me', { token: plaintext })).status, 401);
  assert.equal((await call(`/tokens/${token.id}`, { method: 'DELETE', cookie })).status, 404);
});

test('settings: GET defaults, PATCH validates publicUrl', async () => {
  const s = await call('/settings', { cookie });
  assert.equal(s.json.instanceName, 'Docksy');

  for (const bad of ['not a url', 'ftp://example.com', 'https://user:pw@example.com', 'https://x.com/?a=1']) {
    const r = await call('/settings', { method: 'PATCH', cookie, body: { publicUrl: bad } });
    assert.equal(r.status, 400, bad);
  }
  assert.equal((await call('/settings', { method: 'PATCH', cookie, body: { metricsRetentionDays: 0 } })).status, 400);

  const ok = await call('/settings', { method: 'PATCH', cookie, body: { publicUrl: 'https://docksy.example.com/', instanceName: 'Prod', statusPageEnabled: true } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.publicUrl, 'https://docksy.example.com');
  assert.equal(ok.json.instanceName, 'Prod');
  assert.equal(ok.json.statusPageEnabled, true);
  assert.equal((await call('/settings', { cookie })).json.publicUrl, 'https://docksy.example.com');
});

test('activity lists writes newest first with a limit', async () => {
  const r = await call('/activity?limit=3', { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.items.length, 3);
  assert.equal(r.json.items[0].action, 'settings.update');
  assert.ok(r.json.items[0].id > r.json.items[1].id);
  const all = await call('/activity', { cookie });
  const actions = all.json.items.map((i: { action: string }) => i.action);
  for (const a of ['auth.setup', 'auth.login', 'auth.logout', 'token.create', 'token.delete', 'settings.update']) assert.ok(actions.includes(a), a);
  assert.equal((await call('/activity')).status, 401);
});

test('viewer role cannot write but can log out', async () => {
  const { hashPassword } = await import('../../lib/crypto.ts');
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('v1', 'viewer@example.com', 'V', ?, 'viewer', ?)").run(hashPassword('viewer password'), Date.now());
  const login = await call('/auth/login', { method: 'POST', body: { email: 'viewer@example.com', password: 'viewer password' }, ip: '192.0.2.77' });
  const vc = cookieOf(login.headers);
  assert.equal((await call('/settings', { cookie: vc })).status, 200);
  assert.equal((await call('/settings', { method: 'PATCH', cookie: vc, body: { instanceName: 'x' } })).status, 403);
  assert.equal((await call('/auth/logout', { method: 'POST', cookie: vc })).status, 200);
  assert.equal((await call('/auth/me', { cookie: vc })).status, 401);
});
