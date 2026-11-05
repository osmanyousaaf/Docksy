import { Hono } from 'hono';
import { z } from 'zod';
import type { AlertRule, ChannelType } from '@docksy/shared';
import { db, now, newId, type Row } from '../../db/index.ts';
import { requireUser } from '../../lib/auth.ts';
import { HttpError, badRequest, body, logActivity, notFound, type AppEnv } from '../../lib/http.ts';
import {
  ALERT_METRICS, CHANNEL_CONFIG, CHANNEL_TYPES, SEVERITIES,
  getAlertRow, getChannelRow, getRule, listRules, mergeConfig, readConfig, toAlert, toChannel, writeConfig,
} from './model.ts';
import { noticeFor, resolveRuleAlerts, startEngine } from './engine.ts';
import { sendNotice } from './notify.ts';
import { seedDefaultRules } from './defaults.ts';

// ───────────────────────────── schemas ─────────────────────────────

// No .default() here: zod 4 applies defaults inside .partial(), which would break PATCH.
const ruleFields = z.object({
  name: z.string().trim().min(1).max(120),
  metric: z.enum(ALERT_METRICS),
  op: z.enum(['>', '<']),
  threshold: z.number().finite(),
  durationSec: z.number().int().min(0).max(7 * 86400),
  severity: z.enum(SEVERITIES),
  serverId: z.string().min(1).nullable(),
  appId: z.string().min(1).nullable(),
  channelIds: z.array(z.string().min(1)).max(50),
  enabled: z.boolean(),
});
const createRuleSchema = ruleFields.partial().required({ name: true, metric: true });
const patchRuleSchema = ruleFields.partial();

const createChannelSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(CHANNEL_TYPES),
  config: z.record(z.string(), z.unknown()),
  enabled: z.boolean().optional(),
});
const patchChannelSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

// ───────────────────────────── helpers ─────────────────────────────

function resolveServerId(id: string | null | undefined): string | null {
  if (!id) return null;
  const r = db.prepare('SELECT id FROM servers WHERE id = ? OR name = ?').get(id, id) as Row | undefined;
  if (!r) throw badRequest(`Server "${id}" not found`);
  return r.id;
}

function resolveAppId(id: string | null | undefined): string | null {
  if (!id) return null;
  const r = db.prepare('SELECT id FROM apps WHERE id = ? OR name = ?').get(id, id) as Row | undefined;
  if (!r) throw badRequest(`App "${id}" not found`);
  return r.id;
}

function checkChannelIds(ids: string[]): string[] {
  const unique = [...new Set(ids)];
  for (const id of unique) if (!getChannelRow(id)) throw badRequest(`Notification channel "${id}" not found`);
  return unique;
}

function validateConfig(type: ChannelType, cfg: Record<string, unknown>): Record<string, unknown> {
  const r = CHANNEL_CONFIG[type].safeParse(cfg);
  if (!r.success) throw badRequest(`That ${type} config doesn't look right`, r.error.issues);
  return r.data;
}

const mustRule = (id: string): AlertRule => {
  const r = getRule(id);
  if (!r) throw notFound('Alert rule');
  return r;
};

const mustChannel = (id: string): Row => {
  const r = getChannelRow(id);
  if (!r) throw notFound('Notification channel');
  return r;
};

// ───────────────────────────── routes ─────────────────────────────

/** Mount /api/v1/alert-rules, /alerts, /notification-channels. */
export function registerAlerts(app: Hono<AppEnv>): void {
  const r = new Hono<AppEnv>();
  // requireUser goes on each route: a router-wide r.use() would also block other modules' public routes.

  // ── rules ──
  r.get('/alert-rules', requireUser, (c) => c.json({ items: listRules() }));

  r.post('/alert-rules', requireUser, async (c) => {
    const b = await body(c, createRuleSchema);
    const id = newId();
    db.prepare(`INSERT INTO alert_rules (id, name, metric, op, threshold, duration_sec, severity, server_id, app_id, channel_ids, enabled, is_default, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
      .run(
        id, b.name, b.metric, b.op ?? '>', b.threshold ?? 0, b.durationSec ?? 0, b.severity ?? 'warning',
        resolveServerId(b.serverId), resolveAppId(b.appId), JSON.stringify(checkChannelIds(b.channelIds ?? [])),
        b.enabled === false ? 0 : 1, now(),
      );
    logActivity(c.get('actor'), 'alert_rule.create', 'alert_rule', id, b.name);
    return c.json(mustRule(id), 201);
  });

  r.patch('/alert-rules/:id', requireUser, async (c) => {
    const prev = mustRule(c.req.param('id'));
    const b = await body(c, patchRuleSchema);
    const next = {
      name: b.name ?? prev.name,
      metric: b.metric ?? prev.metric,
      op: b.op ?? prev.op,
      threshold: b.threshold ?? prev.threshold,
      durationSec: b.durationSec ?? prev.durationSec,
      severity: b.severity ?? prev.severity,
      serverId: b.serverId === undefined ? prev.serverId : resolveServerId(b.serverId),
      appId: b.appId === undefined ? prev.appId : resolveAppId(b.appId),
      channelIds: b.channelIds === undefined ? prev.channelIds : checkChannelIds(b.channelIds),
      enabled: b.enabled ?? prev.enabled,
    };
    db.prepare(`UPDATE alert_rules SET name = ?, metric = ?, op = ?, threshold = ?, duration_sec = ?, severity = ?, server_id = ?, app_id = ?, channel_ids = ?, enabled = ? WHERE id = ?`)
      .run(next.name, next.metric, next.op, next.threshold, next.durationSec, next.severity, next.serverId, next.appId, JSON.stringify(next.channelIds), next.enabled ? 1 : 0, prev.id);
    // What the rule watches changed (or it was switched off): clear its alerts; live ones re-fire on the next evaluation.
    const watchChanged = next.metric !== prev.metric || next.serverId !== prev.serverId || next.appId !== prev.appId;
    if (!next.enabled || watchChanged) resolveRuleAlerts(prev.id);
    logActivity(c.get('actor'), 'alert_rule.update', 'alert_rule', prev.id, next.name);
    return c.json(mustRule(prev.id));
  });

  r.delete('/alert-rules/:id', requireUser, (c) => {
    const rule = mustRule(c.req.param('id'));
    resolveRuleAlerts(rule.id);
    db.prepare('DELETE FROM alert_rules WHERE id = ?').run(rule.id);
    logActivity(c.get('actor'), 'alert_rule.delete', 'alert_rule', rule.id, rule.name);
    return c.json({ ok: true });
  });

  // ── alerts ──
  r.get('/alerts', requireUser, (c) => {
    const state = c.req.query('state');
    if (state && state !== 'firing' && state !== 'resolved') throw badRequest('state must be "firing" or "resolved"');
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit')) || 100));
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (state) { where.push('state = ?'); args.push(state); }
    const serverId = c.req.query('serverId');
    if (serverId) { where.push('server_id = ?'); args.push(serverId); }
    const appId = c.req.query('appId');
    if (appId) { where.push('app_id = ?'); args.push(resolveAppId(appId)!); }
    const sql = `SELECT * FROM alerts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY (state = 'firing') DESC, started_at DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...args, limit) as Row[];
    return c.json({ items: rows.map(toAlert) });
  });

  r.post('/alerts/:id/ack', requireUser, (c) => {
    const row = getAlertRow(c.req.param('id'));
    if (!row) throw notFound('Alert');
    if (row.acked_at == null) db.prepare('UPDATE alerts SET acked_at = ? WHERE id = ?').run(now(), row.id);
    logActivity(c.get('actor'), 'alert.ack', 'alert', row.id, row.title);
    return c.json(toAlert(getAlertRow(row.id)!));
  });

  // ── notification channels ──
  r.get('/notification-channels', requireUser, (c) => {
    const rows = db.prepare('SELECT * FROM notification_channels ORDER BY created_at').all() as Row[];
    return c.json({ items: rows.map((x) => toChannel(x)) });
  });

  r.post('/notification-channels', requireUser, async (c) => {
    const b = await body(c, createChannelSchema);
    const cfg = validateConfig(b.type, b.config);
    const id = newId();
    db.prepare('INSERT INTO notification_channels (id, name, type, config_enc, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, b.name, b.type, writeConfig(cfg), b.enabled === false ? 0 : 1, now());
    logActivity(c.get('actor'), 'notification_channel.create', 'notification_channel', id, `${b.type}: ${b.name}`);
    return c.json(toChannel(mustChannel(id)), 201);
  });

  r.patch('/notification-channels/:id', requireUser, async (c) => {
    const row = mustChannel(c.req.param('id'));
    const b = await body(c, patchChannelSchema);
    const type = row.type as ChannelType;
    const cfg = b.config ? validateConfig(type, mergeConfig(type, readConfig(row), b.config)) : null;
    db.prepare('UPDATE notification_channels SET name = ?, config_enc = ?, enabled = ? WHERE id = ?')
      .run(b.name ?? row.name, cfg ? writeConfig(cfg) : row.config_enc, b.enabled === undefined ? row.enabled : b.enabled ? 1 : 0, row.id);
    logActivity(c.get('actor'), 'notification_channel.update', 'notification_channel', row.id, b.name ?? row.name);
    return c.json(toChannel(mustChannel(row.id)));
  });

  r.delete('/notification-channels/:id', requireUser, (c) => {
    const row = mustChannel(c.req.param('id'));
    // Drop the channel from rules that pointed at it.
    for (const rule of listRules()) {
      if (rule.channelIds.includes(row.id)) {
        db.prepare('UPDATE alert_rules SET channel_ids = ? WHERE id = ?').run(JSON.stringify(rule.channelIds.filter((x) => x !== row.id)), rule.id);
      }
    }
    db.prepare('DELETE FROM notification_channels WHERE id = ?').run(row.id);
    logActivity(c.get('actor'), 'notification_channel.delete', 'notification_channel', row.id, row.name);
    return c.json({ ok: true });
  });

  r.post('/notification-channels/:id/test', requireUser, async (c) => {
    const row = mustChannel(c.req.param('id'));
    const t = new Date().toISOString();
    const notice = noticeFor('test', {
      id: 'test', ruleId: null, serverId: null, appId: null, state: 'firing', severity: 'info',
      title: 'Test notification from Docksy', message: 'If you can read this, Docksy alerts will reach you here.',
      value: null, startedAt: t, resolvedAt: null, ackedAt: null,
    });
    try {
      await sendNotice({ type: row.type as ChannelType, config: readConfig(row) }, notice);
    } catch (e) {
      throw new HttpError(502, 'notify_failed', `Couldn't reach ${row.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    logActivity(c.get('actor'), 'notification_channel.test', 'notification_channel', row.id, row.name);
    return c.json({ ok: true });
  });

  app.route('/api/v1', r);
}

/** Seed default rules (first run) and start evaluation: bus listeners + the 30s offline loop. */
export function startAlerts(): void {
  try {
    const n = seedDefaultRules();
    if (n) console.log(`[docksy] alerts: added ${n} default alert rules`);
  } catch (e) {
    console.warn('[docksy] alerts: could not seed default rules', e);
  }
  startEngine();
}
