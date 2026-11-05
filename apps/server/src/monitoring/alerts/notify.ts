import { createHmac } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { Alert, ChannelType, Severity } from '@docksy/shared';

/**
 * Notification payload builders (pure) + senders (fetch / nodemailer).
 * Builders take an AlertNotice and return exactly what goes on the wire, so they are unit-tested
 * without any network. Senders go through `transport`, which tests replace via setNotifyTransport().
 */

export interface AlertNotice {
  kind: 'fired' | 'resolved' | 'test';
  alert: Alert;
  serverName: string | null;
  appName: string | null;
  /** Extra line for resolve messages, e.g. "CPU on prod-1 is back to 42%." */
  note?: string | null;
  /** Deep link into the UI, e.g. https://docksy.example.com/alerts */
  link: string;
  /** Instance name from settings (shown as the sender). */
  instance: string;
}

export interface ChannelTarget { type: ChannelType; config: Record<string, unknown> }

export interface WireRequest { url: string; headers: Record<string, string>; body: string }
export interface MailMessage { from: string; to: string; subject: string; text: string; html: string }

const EMOJI: Record<Severity, string> = { critical: '🔴', warning: '🟠', info: '🔵' };
const COLOR: Record<Severity | 'resolved', number> = { critical: 0xef4444, warning: 0xf59e0b, info: 0x3b82f6, resolved: 0x22c55e };

const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function secondsBetween(a: string, b: string | null): number {
  return Math.max(0, Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000));
}

function fmtSpan(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** The one-line, human summary used everywhere (chat title, email subject, webhook "text"). */
export function summaryLine(n: AlertNotice): string {
  const a = n.alert;
  if (n.kind === 'test') return '👋 Test notification from Docksy';
  if (n.kind === 'resolved') {
    const after = ` (after ${fmtSpan(secondsBetween(a.startedAt, a.resolvedAt))})`;
    return n.note ? `✅ ${n.note.replace(/\.$/, '')}${after}` : `✅ Resolved: ${a.title}${after}`;
  }
  return `${EMOJI[a.severity] ?? '🔴'} ${a.message}`;
}

/** "Ask Claude: /docksy:diagnose prod-1" (only on fired + test messages). */
export function hintLine(n: AlertNotice): string | null {
  if (n.kind === 'resolved') return null;
  const target = n.appName ?? n.serverName;
  return target ? `Ask Claude: /docksy:diagnose ${target}` : 'Ask Claude: /docksy:diagnose';
}

/** Plain text body (Telegram fallback, email text, webhook "text"). */
export function plainText(n: AlertNotice): string {
  const lines = [summaryLine(n)];
  if (n.kind === 'test') lines.push('If you can read this, Docksy alerts will reach you here.');
  if (n.kind === 'resolved' && n.note) lines.push(`Was: ${n.alert.title}`);
  const hint = hintLine(n);
  if (hint) lines.push(hint);
  lines.push(n.link);
  return lines.join('\n');
}

const sevLabel = (n: AlertNotice): string => (n.kind === 'resolved' ? 'resolved' : n.alert.severity);
const colorOf = (n: AlertNotice): number => (n.kind === 'resolved' ? COLOR.resolved : COLOR[n.alert.severity] ?? COLOR.critical);
const hintCode = (hint: string): string => hint.replace(/(\/docksy:diagnose.*)$/, '`$1`');

// ───────────────────────────── builders ─────────────────────────────

export function buildDiscord(n: AlertNotice): Record<string, unknown> {
  const hint = hintLine(n);
  const desc: string[] = [];
  if (n.kind === 'test') desc.push('If you can read this, Docksy alerts will reach you here.');
  if (n.kind === 'resolved' && n.note) desc.push(`Was: ${n.alert.title}`);
  if (hint) desc.push(hintCode(hint));
  const fields = [{ name: 'Severity', value: sevLabel(n), inline: true }];
  if (n.serverName) fields.push({ name: 'Server', value: n.serverName, inline: true });
  if (n.appName) fields.push({ name: 'App', value: n.appName, inline: true });
  return {
    username: n.instance || 'Docksy',
    embeds: [{
      title: truncate(summaryLine(n), 256),
      description: truncate(desc.join('\n\n'), 4000) || undefined,
      url: n.link,
      color: colorOf(n),
      fields,
      timestamp: (n.kind === 'resolved' ? n.alert.resolvedAt : n.alert.startedAt) ?? new Date().toISOString(),
      footer: { text: n.instance || 'Docksy' },
    }],
  };
}

const slackEsc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildSlack(n: AlertNotice): Record<string, unknown> {
  const summary = summaryLine(n);
  const hint = hintLine(n);
  const meta = [`Severity: *${sevLabel(n)}*`];
  if (n.serverName) meta.push(`Server: *${slackEsc(n.serverName)}*`);
  if (n.appName) meta.push(`App: *${slackEsc(n.appName)}*`);
  const blocks: Record<string, unknown>[] = [
    { type: 'section', text: { type: 'mrkdwn', text: truncate(`*${slackEsc(summary)}*`, 3000) } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: meta.join('  ·  ') }] },
  ];
  if (n.kind === 'test') blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'If you can read this, Docksy alerts will reach you here.' } });
  if (hint) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: slackEsc(hintCode(hint)) } });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `<${n.link}|Open in ${slackEsc(n.instance || 'Docksy')}>` }] });
  return { text: summary, blocks };
}

const htmlEsc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildTelegram(n: AlertNotice, chatId: string): Record<string, unknown> {
  const lines = [`<b>${htmlEsc(summaryLine(n))}</b>`];
  if (n.kind === 'test') lines.push('If you can read this, Docksy alerts will reach you here.');
  if (n.kind === 'resolved' && n.note) lines.push(`Was: ${htmlEsc(n.alert.title)}`);
  const hint = hintLine(n);
  if (hint) lines.push(htmlEsc(hint).replace(/(\/docksy:diagnose.*)$/, '<code>$1</code>'));
  lines.push(`<a href="${htmlEsc(n.link)}">Open in ${htmlEsc(n.instance || 'Docksy')}</a>`);
  return { chat_id: chatId, text: truncate(lines.join('\n'), 4096), parse_mode: 'HTML', disable_web_page_preview: true };
}

export function buildWebhookBody(n: AlertNotice): Record<string, unknown> {
  return {
    event: n.kind === 'test' ? 'test' : n.kind === 'resolved' ? 'alert.resolved' : 'alert.fired',
    text: summaryLine(n),
    hint: hintLine(n),
    note: n.note ?? null,
    alert: n.alert,
    server: n.alert.serverId ? { id: n.alert.serverId, name: n.serverName } : null,
    app: n.alert.appId ? { id: n.alert.appId, name: n.appName } : null,
    url: n.link,
    instance: n.instance,
    sentAt: new Date().toISOString(),
  };
}

/** "sha256=<hex HMAC of the raw body>" — verify with the channel secret. */
export const signBody = (body: string, secret: string): string => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

export function buildWebhook(n: AlertNotice, cfg: { url: string; secret?: string }): WireRequest {
  const body = JSON.stringify(buildWebhookBody(n));
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'Docksy-Alerts',
    'x-docksy-event': String(buildWebhookBody(n).event),
  };
  if (cfg.secret) headers['x-docksy-signature'] = signBody(body, cfg.secret);
  return { url: cfg.url, headers, body };
}

export function buildEmail(n: AlertNotice, cfg: { from: string; to: string }): MailMessage {
  const summary = summaryLine(n);
  const hint = hintLine(n);
  const color = `#${colorOf(n).toString(16).padStart(6, '0')}`;
  const meta = [`Severity: ${sevLabel(n)}`, n.serverName ? `Server: ${n.serverName}` : '', n.appName ? `App: ${n.appName}` : ''].filter(Boolean).join(' · ');
  const html = [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:16px">',
    `<div style="border-left:4px solid ${color};padding:8px 14px;background:#f8fafc;border-radius:6px">`,
    `<p style="margin:0 0 6px;font-size:16px;font-weight:600;color:#0f172a">${htmlEsc(summary)}</p>`,
    `<p style="margin:0;font-size:13px;color:#475569">${htmlEsc(meta)}</p>`,
    '</div>',
    n.kind === 'test' ? '<p style="font-size:14px;color:#334155">If you can read this, Docksy alerts will reach you here.</p>' : '',
    n.kind === 'resolved' && n.note ? `<p style="font-size:14px;color:#334155">Was: ${htmlEsc(n.alert.title)}</p>` : '',
    hint ? `<p style="font-size:14px;color:#334155">Ask Claude: <code style="background:#eef2ff;padding:2px 6px;border-radius:4px">${htmlEsc(hint.replace(/^Ask Claude: /, ''))}</code></p>` : '',
    `<p style="font-size:13px"><a href="${htmlEsc(n.link)}" style="color:#6366f1">Open in ${htmlEsc(n.instance || 'Docksy')}</a></p>`,
    '</div>',
  ].join('');
  return { from: cfg.from, to: cfg.to, subject: truncate(`[${n.instance || 'Docksy'}] ${summary}`, 200), text: plainText(n), html };
}

/** The HTTP request a channel would send (all types except email). Exported for tests. */
export function buildRequest(target: ChannelTarget, n: AlertNotice): WireRequest {
  const c = target.config as Record<string, any>;
  const jsonReq = (url: string, payload: unknown): WireRequest => ({
    url, headers: { 'content-type': 'application/json', 'user-agent': 'Docksy-Alerts' }, body: JSON.stringify(payload),
  });
  switch (target.type) {
    case 'discord': return jsonReq(String(c.url), buildDiscord(n));
    case 'slack': return jsonReq(String(c.url), buildSlack(n));
    case 'telegram': return jsonReq(`https://api.telegram.org/bot${c.botToken}/sendMessage`, buildTelegram(n, String(c.chatId)));
    case 'webhook': return buildWebhook(n, { url: String(c.url), secret: c.secret ? String(c.secret) : undefined });
    default: throw new Error(`No HTTP request for channel type ${target.type}`);
  }
}

// ───────────────────────────── transport ─────────────────────────────

export interface SmtpConfig { host: string; port: number; secure: boolean; user?: string; pass?: string }

export interface NotifyTransport {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  sendMail: (smtp: SmtpConfig, msg: MailMessage) => Promise<void>;
}

const defaultTransport: NotifyTransport = {
  fetch: (url, init) => fetch(url, init),
  sendMail: async (smtp, msg) => {
    const t = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass ?? '' } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    try { await t.sendMail(msg); } finally { t.close(); }
  },
};

let transport: NotifyTransport = defaultTransport;

/** Tests: replace fetch/sendMail. Call with no argument to restore the real transport. */
export function setNotifyTransport(t?: Partial<NotifyTransport>): void {
  transport = t ? { ...defaultTransport, ...t } : defaultTransport;
}

/** Send one notice to one channel. Throws a readable Error on failure. */
export async function sendNotice(target: ChannelTarget, n: AlertNotice): Promise<void> {
  if (target.type === 'email') {
    const c = target.config as Record<string, any>;
    const msg = buildEmail(n, { from: String(c.from), to: String(c.to) });
    await transport.sendMail({ host: String(c.host), port: Number(c.port ?? 587), secure: !!c.secure, user: c.user || undefined, pass: c.pass || undefined }, msg);
    return;
  }
  const req = buildRequest(target, n);
  const res = await transport.fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(10_000) });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${target.type} answered HTTP ${res.status}${text ? `: ${truncate(text, 200)}` : ''}`);
  if (target.type === 'telegram') {
    try {
      const j = JSON.parse(text) as { ok?: boolean; description?: string };
      if (j.ok === false) throw new Error(`telegram: ${j.description ?? 'request failed'}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('telegram:')) throw e;
    }
  }
}
