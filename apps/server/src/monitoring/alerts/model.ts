import type { Alert, AlertMetric, AlertRule, ChannelType, NotificationChannel, Severity } from '@docksy/shared';
import { z } from 'zod';
import { db, iso, json, bool, type Row } from '../../db/index.ts';
import { encrypt, decrypt, mask } from '../../lib/crypto.ts';

/** Row mappers, rule lookups and channel-config helpers for the alerts module. */

export const ALERT_METRICS = [
  'cpu', 'mem', 'disk', 'load', 'swap',
  'server_offline', 'container_down', 'container_restarts',
  'deploy_failed', 'uptime_down', 'backup_failed',
] as const satisfies readonly AlertMetric[];

/** Metrics evaluated from each agent report's host numbers. */
export const HOST_METRICS: readonly AlertMetric[] = ['cpu', 'mem', 'disk', 'load', 'swap'];

export const SEVERITIES = ['info', 'warning', 'critical'] as const satisfies readonly Severity[];
export const CHANNEL_TYPES = ['discord', 'slack', 'telegram', 'webhook', 'email'] as const satisfies readonly ChannelType[];

// ───────────────────────────── rules ─────────────────────────────

export const toRule = (r: Row): AlertRule => ({
  id: r.id,
  name: r.name,
  metric: r.metric as AlertMetric,
  op: r.op === '<' ? '<' : '>',
  threshold: Number(r.threshold),
  durationSec: Number(r.duration_sec),
  severity: r.severity as Severity,
  serverId: r.server_id ?? null,
  appId: r.app_id ?? null,
  channelIds: json<string[]>(r.channel_ids, []),
  enabled: bool(r.enabled),
  isDefault: bool(r.is_default),
  createdAt: iso(r.created_at)!,
});

export function getRule(id: string): AlertRule | null {
  const r = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id) as Row | undefined;
  return r ? toRule(r) : null;
}

export const listRules = (): AlertRule[] =>
  (db.prepare('SELECT * FROM alert_rules ORDER BY is_default DESC, created_at, name').all() as Row[]).map(toRule);

/** Enabled rules for these metrics that apply to the target (null scope on a rule = all). */
export function rulesFor(metrics: readonly AlertMetric[], target: { serverId?: string | null; appId?: string | null }): AlertRule[] {
  if (metrics.length === 0) return [];
  const marks = metrics.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM alert_rules WHERE enabled = 1 AND metric IN (${marks}) ORDER BY created_at`).all(...metrics) as Row[];
  return rows.map(toRule).filter((r) => ruleMatches(r, target));
}

export function ruleMatches(rule: AlertRule, target: { serverId?: string | null; appId?: string | null }): boolean {
  if (rule.serverId && rule.serverId !== (target.serverId ?? null)) return false;
  if (rule.appId && rule.appId !== (target.appId ?? null)) return false;
  return true;
}

/** Most specific rule wins: app-scoped, then server-scoped, then global. */
export function pickRule(rules: AlertRule[]): AlertRule | null {
  const score = (r: AlertRule) => (r.appId ? 2 : 0) + (r.serverId ? 1 : 0);
  return [...rules].sort((a, b) => score(b) - score(a))[0] ?? null;
}

// ───────────────────────────── alerts ─────────────────────────────

export const toAlert = (r: Row): Alert => ({
  id: r.id,
  ruleId: r.rule_id ?? null,
  serverId: r.server_id ?? null,
  appId: r.app_id ?? null,
  state: r.state === 'resolved' ? 'resolved' : 'firing',
  severity: r.severity as Severity,
  title: r.title,
  message: r.message,
  value: r.value == null ? null : Number(r.value),
  startedAt: iso(r.started_at)!,
  resolvedAt: iso(r.resolved_at),
  ackedAt: iso(r.acked_at),
});

export function getAlertRow(id: string): Row | null {
  return (db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as Row | undefined) ?? null;
}

export function firingRow(dedupeKey: string): Row | null {
  return (db.prepare("SELECT * FROM alerts WHERE dedupe_key = ? AND state = 'firing' ORDER BY started_at DESC LIMIT 1").get(dedupeKey) as Row | undefined) ?? null;
}

// ───────────────────────────── channels ─────────────────────────────

const str = z.string().trim().min(1);
const url = z.string().trim().pipe(z.url({ protocol: /^https?$/ }));

/** Per-type config validation. Stored encrypted as JSON in notification_channels.config_enc. */
export const CHANNEL_CONFIG: Record<ChannelType, z.ZodType<Record<string, unknown>>> = {
  discord: z.object({ url }),
  slack: z.object({ url }),
  telegram: z.object({ botToken: str, chatId: z.union([str, z.number().int()]).transform(String) }),
  webhook: z.object({ url, secret: z.string().optional() }),
  email: z.object({
    host: str,
    port: z.coerce.number().int().min(1).max(65535).default(587),
    secure: z.boolean().default(false),
    user: z.string().optional(),
    pass: z.string().optional(),
    from: str,
    to: str, // comma-separated list
  }),
};

/** Which config keys are secret per type (masked on GET, kept when a masked value is sent back). */
export const SECRET_FIELDS: Record<ChannelType, string[]> = {
  discord: ['url'],
  slack: ['url'],
  telegram: ['botToken'],
  webhook: ['secret'],
  email: ['pass'],
};

const MASK_MARK = '••';

/** Hide the token part of a webhook URL but keep the host so people recognise it. */
export function maskUrl(u: string): string {
  try {
    const p = new URL(u);
    return `${p.origin}/••••${u.slice(-4)}`;
  } catch {
    return mask(u);
  }
}

export function maskConfig(type: ChannelType, cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cfg };
  for (const k of SECRET_FIELDS[type] ?? []) {
    const v = out[k];
    if (typeof v === 'string' && v.length > 0) out[k] = k === 'url' ? maskUrl(v) : mask(v);
  }
  return out;
}

export const isMasked = (v: unknown): boolean => typeof v === 'string' && v.includes(MASK_MARK);

/**
 * Merge an update into an existing config. Secret fields that come back still masked
 * (the UI round-trips what GET returned) keep their stored value.
 */
export function mergeConfig(type: ChannelType, prev: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...prev, ...next };
  for (const k of SECRET_FIELDS[type] ?? []) {
    if (isMasked(next[k])) out[k] = prev[k];
  }
  return out;
}

export function readConfig(r: Row): Record<string, unknown> {
  try { return JSON.parse(decrypt(r.config_enc)) as Record<string, unknown>; } catch { return {}; }
}

export const writeConfig = (cfg: Record<string, unknown>): string => encrypt(JSON.stringify(cfg));

export const toChannel = (r: Row, reveal = false): NotificationChannel => {
  const type = r.type as ChannelType;
  const cfg = readConfig(r);
  return {
    id: r.id,
    name: r.name,
    type,
    config: reveal ? cfg : maskConfig(type, cfg),
    enabled: bool(r.enabled),
    createdAt: iso(r.created_at)!,
  };
};

export function getChannelRow(id: string): Row | null {
  return (db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(id) as Row | undefined) ?? null;
}

/** Channels a rule notifies: its channelIds, or every enabled channel when the list is empty. */
export function channelsForRule(rule: AlertRule | null): Row[] {
  const rows = db.prepare('SELECT * FROM notification_channels WHERE enabled = 1 ORDER BY created_at').all() as Row[];
  const ids = rule?.channelIds ?? [];
  return ids.length === 0 ? rows : rows.filter((r) => ids.includes(r.id));
}
