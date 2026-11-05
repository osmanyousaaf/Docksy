import './test-env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { db, migrate, newId, type Row } from '../../db/index.ts';
import { sha256 } from '../../lib/crypto.ts';
import { errorHandler, type AppEnv } from '../../lib/http.ts';
import { registerAlerts } from './index.ts';
import { seedDefaultRules } from './defaults.ts';
import { fireEventAlert } from './engine.ts';
import { readConfig } from './model.ts';
import { setNotifyTransport } from './notify.ts';

const TOKEN = 'dsk_test_full_token';
const READ_TOKEN = 'dsk_test_read_token';
const app = new Hono<AppEnv>();
app.onError(errorHandler);
const sent: { url: string; headers: Record<string, string>; body: string }[] = [];

before(() => {
  migrate();
  seedDefaultRules();
  const uid = newId();
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, 'o@x.io', 'Owner', 'x', 'owner', ?)").run(uid, Date.now());
  for (const [tok, scope] of [[TOKEN, 'full'], [READ_TOKEN, 'read']]) {
    db.prepare('INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(newId(), uid, scope, sha256(tok!), 'dsk_', scope, Date.now());
  }
  registerAlerts(app);
  // a public route registered after us must stay public
  app.get('/api/v1/public/status', (c) => c.json({ ok: true }));
  setNotifyTransport({
    fetch: async (url, init) => {
      sent.push({ url, headers: init.headers, body: init.body });
      return url.includes('broken') ? { ok: false, status: 500, text: async () => 'nope' } : { ok: true, status: 200, text: async () => '' };
    },
  });
});
after(() => setNotifyTransport());

async function call(method: string, path: string, body?: unknown, token = TOKEN): Promise<{ status: number; json: any }> {
  const res = await app.request(`/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('auth is required, read tokens cannot write, public routes stay public', async () => {
  assert.equal((await app.request('/api/v1/alert-rules')).status, 401);
  assert.equal((await app.request('/api/v1/public/status')).status, 200);
  assert.equal((await call('GET', '/alert-rules', undefined, READ_TOKEN)).status, 200);
  assert.equal((await call('POST', '/alert-rules', { name: 'x', metric: 'cpu' }, READ_TOKEN)).status, 403);
});

test('alert rules CRUD', async () => {
  const list = await call('GET', '/alert-rules');
  assert.equal(list.status, 200);
  assert.equal(list.json.items.length, 10);
  assert.ok(list.json.items.every((r: any) => r.isDefault));

  const bad = await call('POST', '/alert-rules', { name: 'x', metric: 'nope' });
  assert.equal(bad.status, 400);
  const badCh = await call('POST', '/alert-rules', { name: 'x', metric: 'cpu', channelIds: ['missing'] });
  assert.equal(badCh.status, 400);

  const created = await call('POST', '/alert-rules', { name: 'Load high', metric: 'load', threshold: 8, durationSec: 120 });
  assert.equal(created.status, 201);
  assert.equal(created.json.op, '>');
  assert.equal(created.json.severity, 'warning');
  assert.equal(created.json.enabled, true);
  assert.equal(created.json.isDefault, false);
  assert.deepEqual(created.json.channelIds, []);

  const patched = await call('PATCH', `/alert-rules/${created.json.id}`, { threshold: 10, severity: 'critical' });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.threshold, 10);
  assert.equal(patched.json.severity, 'critical');
  assert.equal(patched.json.durationSec, 120, 'PATCH keeps fields it was not given');
  assert.equal(patched.json.name, 'Load high');

  assert.equal((await call('DELETE', `/alert-rules/${created.json.id}`)).json.ok, true);
  assert.equal((await call('PATCH', `/alert-rules/${created.json.id}`, { threshold: 1 })).status, 404);
});

test('disabling a rule resolves its alerts', async () => {
  const rule = (await call('GET', '/alert-rules')).json.items.find((r: any) => r.metric === 'uptime_down');
  fireEventAlert('uptime_down', { key: 'uptime:x', title: 'x is down', message: 'x is down' });
  assert.equal((await call('GET', '/alerts?state=firing')).json.items.length, 1);
  await call('PATCH', `/alert-rules/${rule.id}`, { enabled: false });
  assert.equal((await call('GET', '/alerts?state=firing')).json.items.length, 0);
  assert.equal((await call('GET', '/alerts?state=resolved')).json.items.length, 1);
  await call('PATCH', `/alert-rules/${rule.id}`, { enabled: true });
});

test('alerts list + ack', async () => {
  fireEventAlert('uptime_down', { key: 'uptime:y', title: 'y is down', message: 'y is down' });
  const firing = await call('GET', '/alerts?state=firing&limit=5');
  assert.equal(firing.json.items.length, 1);
  const a = firing.json.items[0];
  assert.equal(a.ackedAt, null);
  const acked = await call('POST', `/alerts/${a.id}/ack`);
  assert.equal(acked.status, 200);
  assert.ok(acked.json.ackedAt);
  assert.equal((await call('POST', '/alerts/nope/ack')).status, 404);
  assert.equal((await call('GET', '/alerts?state=weird')).status, 400);
  const all = await call('GET', '/alerts');
  assert.equal(all.json.items[0].state, 'firing', 'firing first');
});

test('notification channels: encrypted at rest, masked on GET, masked values round-trip', async () => {
  const bad = await call('POST', '/notification-channels', { name: 'd', type: 'discord', config: { url: 'not-a-url' } });
  assert.equal(bad.status, 400);

  const url = 'https://discord.com/api/webhooks/123/very-secret-token';
  const created = await call('POST', '/notification-channels', { name: 'Team Discord', type: 'discord', config: { url } });
  assert.equal(created.status, 201);
  assert.equal(created.json.config.url, 'https://discord.com/••••oken');
  const row = db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(created.json.id) as Row;
  assert.ok(!row.config_enc.includes('very-secret'), 'stored encrypted');
  assert.equal(readConfig(row).url, url);

  const list = await call('GET', '/notification-channels');
  assert.equal(list.json.items[0].config.url, 'https://discord.com/••••oken');

  // the UI sends back what it got: the secret survives
  const renamed = await call('PATCH', `/notification-channels/${created.json.id}`, { name: 'Ops', config: list.json.items[0].config });
  assert.equal(renamed.json.name, 'Ops');
  assert.equal(readConfig(db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(created.json.id) as Row).url, url);

  const tg = await call('POST', '/notification-channels', { name: 'tg', type: 'telegram', config: { botToken: '123456:SECRETSECRET', chatId: 42 } });
  assert.equal(tg.status, 201);
  assert.equal(tg.json.config.chatId, '42');
  assert.ok(!String(tg.json.config.botToken).includes('SECRETSECRET'));

  // test endpoint
  sent.length = 0;
  const ok = await call('POST', `/notification-channels/${created.json.id}/test`);
  assert.equal(ok.status, 200);
  assert.equal(sent[0]!.url, url);
  assert.match(JSON.parse(sent[0]!.body).embeds[0].title, /Test notification from Docksy/);

  const hook = await call('POST', '/notification-channels', { name: 'hook', type: 'webhook', config: { url: 'https://broken.example.com', secret: 'abc' } });
  assert.equal(hook.json.config.secret, '••••••');
  const fail = await call('POST', `/notification-channels/${hook.json.id}/test`);
  assert.equal(fail.status, 502);
  assert.match(fail.json.error.message, /Couldn't reach hook: webhook answered HTTP 500/);
  assert.match(sent.at(-1)!.headers['x-docksy-signature']!, /^sha256=[0-9a-f]{64}$/);

  // deleting a channel removes it from rules
  const rule = await call('POST', '/alert-rules', { name: 'r', metric: 'cpu', channelIds: [hook.json.id] });
  assert.equal((await call('DELETE', `/notification-channels/${hook.json.id}`)).json.ok, true);
  assert.deepEqual((await call('GET', '/alert-rules')).json.items.find((r: any) => r.id === rule.json.id).channelIds, []);
});
