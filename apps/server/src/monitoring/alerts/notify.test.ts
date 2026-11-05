import './test-env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Alert } from '@docksy/shared';
import {
  buildDiscord, buildEmail, buildRequest, buildSlack, buildTelegram, buildWebhook, hintLine, plainText,
  sendNotice, setNotifyTransport, signBody, summaryLine, type AlertNotice, type MailMessage,
} from './notify.ts';
import { maskConfig, maskUrl, mergeConfig, CHANNEL_CONFIG } from './model.ts';

const alert: Alert = {
  id: 'a1', ruleId: 'r1', serverId: 's1', appId: null, state: 'firing', severity: 'critical',
  title: 'CPU on prod-1 is 97%', message: 'CPU on prod-1 is 97% (over 90% for 5m)', value: 97,
  startedAt: '2026-11-01T10:00:00.000Z', resolvedAt: null, ackedAt: null,
};
const fired: AlertNotice = { kind: 'fired', alert, serverName: 'prod-1', appName: null, link: 'https://dx.example.com/alerts', instance: 'Docksy' };
const resolved: AlertNotice = {
  ...fired, kind: 'resolved', note: 'CPU on prod-1 is back to 42%.',
  alert: { ...alert, state: 'resolved', resolvedAt: '2026-11-01T10:12:00.000Z' },
};

test('summary + hint copy is human', () => {
  assert.equal(summaryLine(fired), '🔴 CPU on prod-1 is 97% (over 90% for 5m)');
  assert.equal(hintLine(fired), 'Ask Claude: /docksy:diagnose prod-1');
  assert.equal(summaryLine(resolved), '✅ CPU on prod-1 is back to 42% (after 12m)');
  assert.equal(hintLine(resolved), null);
  assert.equal(summaryLine({ ...fired, alert: { ...alert, severity: 'warning' } }).startsWith('🟠'), true);
  assert.match(plainText(fired), /Ask Claude: \/docksy:diagnose prod-1\nhttps:\/\/dx\.example\.com\/alerts$/);
  // app alerts point diagnose at the app
  assert.equal(hintLine({ ...fired, appName: 'api' }), 'Ask Claude: /docksy:diagnose api');
});

test('discord embed', () => {
  const p = buildDiscord(fired) as any;
  const e = p.embeds[0];
  assert.equal(e.title, '🔴 CPU on prod-1 is 97% (over 90% for 5m)');
  assert.equal(e.color, 0xef4444);
  assert.match(e.description, /Ask Claude: `\/docksy:diagnose prod-1`/);
  assert.deepEqual(e.fields.map((f: any) => f.name), ['Severity', 'Server']);
  assert.equal(e.url, fired.link);
  const r = buildDiscord(resolved) as any;
  assert.equal(r.embeds[0].color, 0x22c55e);
  assert.match(r.embeds[0].description, /Was: CPU on prod-1 is 97%/);
});

test('slack blocks escape and include the hint', () => {
  const p = buildSlack({ ...fired, serverName: 'a<b>&c' }) as any;
  assert.equal(p.text, summaryLine(fired));
  assert.equal(p.blocks[0].type, 'section');
  assert.match(p.blocks[1].elements[0].text, /a&lt;b&gt;&amp;c/);
  assert.ok(p.blocks.some((b: any) => b.text?.text?.includes('`/docksy:diagnose a&lt;b&gt;&amp;c`')));
  assert.match(p.blocks.at(-1).elements[0].text, /<https:\/\/dx\.example\.com\/alerts\|Open in Docksy>/);
});

test('telegram sendMessage', () => {
  const p = buildTelegram(fired, '-100123') as any;
  assert.equal(p.chat_id, '-100123');
  assert.equal(p.parse_mode, 'HTML');
  assert.match(p.text, /^<b>🔴 CPU on prod-1 is 97% \(over 90% for 5m\)<\/b>/);
  assert.match(p.text, /<code>\/docksy:diagnose prod-1<\/code>/);
  const req = buildRequest({ type: 'telegram', config: { botToken: '123:abc', chatId: '-100123' } }, fired);
  assert.equal(req.url, 'https://api.telegram.org/bot123:abc/sendMessage');
});

test('generic webhook is JSON with an HMAC signature', () => {
  const req = buildWebhook(fired, { url: 'https://hooks.example.com/x', secret: 's3cret' });
  const body = JSON.parse(req.body);
  assert.equal(body.event, 'alert.fired');
  assert.equal(body.alert.id, 'a1');
  assert.deepEqual(body.server, { id: 's1', name: 'prod-1' });
  assert.equal(body.hint, 'Ask Claude: /docksy:diagnose prod-1');
  const expected = `sha256=${createHmac('sha256', 's3cret').update(req.body).digest('hex')}`;
  assert.equal(req.headers['x-docksy-signature'], expected);
  assert.equal(signBody(req.body, 's3cret'), expected);
  assert.equal(req.headers['x-docksy-event'], 'alert.fired');
  // no secret → no signature header
  assert.equal(buildWebhook(fired, { url: 'https://x.example' }).headers['x-docksy-signature'], undefined);
  assert.equal(JSON.parse(buildWebhook(resolved, { url: 'https://x.example' }).body).event, 'alert.resolved');
});

test('email subject, text and html', () => {
  const m = buildEmail(fired, { from: 'docksy@x.io', to: 'me@x.io' });
  assert.equal(m.subject, '[Docksy] 🔴 CPU on prod-1 is 97% (over 90% for 5m)');
  assert.match(m.text, /Ask Claude: \/docksy:diagnose prod-1/);
  assert.match(m.html, /<code[^>]*>\/docksy:diagnose prod-1<\/code>/);
  assert.match(buildEmail({ ...fired, serverName: '<x>' }, { from: 'a', to: 'b' }).html, /&lt;x&gt;/);
});

test('sendNotice uses the transport and reports failures', async () => {
  const calls: { url: string; body: string }[] = [];
  const mails: MailMessage[] = [];
  setNotifyTransport({
    fetch: async (url, init) => {
      calls.push({ url, body: init.body });
      if (url.includes('fail')) return { ok: false, status: 404, text: async () => 'Unknown Webhook' };
      if (url.includes('telegram')) return { ok: true, status: 200, text: async () => '{"ok":true}' };
      return { ok: true, status: 204, text: async () => '' };
    },
    sendMail: async (_smtp, msg) => { mails.push(msg); },
  });
  try {
    await sendNotice({ type: 'discord', config: { url: 'https://discord.com/api/webhooks/1/abc' } }, fired);
    await sendNotice({ type: 'telegram', config: { botToken: 't', chatId: '1' } }, fired);
    await sendNotice({ type: 'email', config: { host: 'smtp.x', port: 587, secure: false, from: 'a@x', to: 'b@x' } }, fired);
    assert.equal(calls.length, 2);
    assert.equal(mails.length, 1);
    await assert.rejects(sendNotice({ type: 'slack', config: { url: 'https://fail.example' } }, fired), /slack answered HTTP 404: Unknown Webhook/);
  } finally {
    setNotifyTransport();
  }
});

test('channel config masking and merging', () => {
  const discord = { url: 'https://discord.com/api/webhooks/123/supersecrettoken' };
  const masked = maskConfig('discord', discord);
  assert.equal(masked.url, 'https://discord.com/••••oken');
  assert.equal(maskUrl('not a url at all'), 'not••••all');
  const tg = maskConfig('telegram', { botToken: '123456:ABCDEFGHIJ', chatId: '42' });
  assert.equal(tg.chatId, '42');
  assert.notEqual(tg.botToken, '123456:ABCDEFGHIJ');
  const mail = maskConfig('email', { host: 'smtp.x', pass: 'hunter2', user: 'u' });
  assert.equal(mail.pass, '••••••');
  assert.equal(mail.host, 'smtp.x');
  // sending a masked value back keeps the stored secret; a new value replaces it
  assert.deepEqual(mergeConfig('discord', discord, masked), discord);
  assert.deepEqual(mergeConfig('webhook', { url: 'https://a.example', secret: 'old' }, { secret: 'new' }), { url: 'https://a.example', secret: 'new' });
  // validation
  assert.equal(CHANNEL_CONFIG.discord.safeParse({ url: 'ftp://x' }).success, false);
  assert.equal(CHANNEL_CONFIG.telegram.safeParse({ botToken: 'x', chatId: 42 }).success, true);
  const email = CHANNEL_CONFIG.email.parse({ host: 'smtp.x', from: 'a@x', to: 'b@x' });
  assert.equal(email.port, 587);
});
