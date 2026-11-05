import type { Hono } from 'hono';
import { z } from 'zod';
import { db, newId, now, bool, getSettings, type Row } from '../../db/index.ts';
import { body, badRequest, notFound, logActivity, type AppEnv } from '../../lib/http.ts';
import { requireUser } from '../../lib/auth.ts';
import { bus } from '../../lib/events.ts';
import { defaultDomain } from '../../core/apps/model.ts';
import { buildPublicStatus, getCheckRow, listChecks, listResults, toUptimeCheck } from './model.ts';
import { clearCheckAlert, runCheckNow, scheduleCheck, startScheduler, unscheduleCheck } from './scheduler.ts';
import { DAY_MS, downsampleResults } from './stats.ts';

export { runCheckNow } from './scheduler.ts';

/**
 * mon-uptime: uptime checks CRUD + results, public status page, auto-checks for deployed apps.
 * Routes (CONTRACT.md §4.2): /uptime-checks, /uptime-checks/:id, /uptime-checks/:id/results, /public/status
 */

const isHttpUrl = (s: string): boolean => {
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
};

const fields = {
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().max(2000).refine(isHttpUrl, 'Must be a full http:// or https:// URL'),
  appId: z.string().min(1).nullable(),
  intervalSec: z.number().int().min(30, 'Minimum interval is 30 seconds').max(86_400),
  timeoutMs: z.number().int().min(1000).max(60_000),
  expectedStatus: z.number().int().refine((v) => v === 0 || (v >= 100 && v <= 599), 'Use 0 (any 2xx/3xx) or an HTTP status code'),
  public: z.boolean(),
  enabled: z.boolean(),
};

const createSchema = z.object({
  ...fields,
  name: fields.name.optional(),
  appId: fields.appId.optional(),
  intervalSec: fields.intervalSec.optional(),
  timeoutMs: fields.timeoutMs.optional(),
  expectedStatus: fields.expectedStatus.optional(),
  public: fields.public.optional(),
  enabled: fields.enabled.optional(),
});
const updateSchema = z.object(fields).partial();

const RANGES: Record<string, number> = { '1h': 3_600_000, '24h': DAY_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS, '90d': 90 * DAY_MS };
const MAX_RESULT_POINTS = 1500;

/** Accept an app id or name; returns the id. */
function resolveAppId(idOrName: string | null | undefined): string | null {
  if (!idOrName) return null;
  const r = db.prepare('SELECT id FROM apps WHERE id = ? OR name = ?').get(idOrName, idOrName) as Row | undefined;
  if (!r) throw badRequest(`App "${idOrName}" not found`);
  return r.id;
}

function checkTimeout(intervalSec: number, timeoutMs: number): void {
  if (timeoutMs >= intervalSec * 1000) throw badRequest('timeoutMs must be shorter than the interval');
}

export function createCheck(input: {
  name?: string; url: string; appId?: string | null; intervalSec?: number; timeoutMs?: number;
  expectedStatus?: number; public?: boolean; enabled?: boolean;
}): Row {
  const intervalSec = input.intervalSec ?? 60;
  const timeoutMs = input.timeoutMs ?? Math.min(10_000, intervalSec * 1000 - 1000);
  checkTimeout(intervalSec, timeoutMs);
  const id = newId();
  const name = input.name ?? new URL(input.url).hostname;
  db.prepare(
    `INSERT INTO uptime_checks (id, name, url, app_id, interval_sec, timeout_ms, expected_status, public, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, input.url, resolveAppId(input.appId), intervalSec, timeoutMs, input.expectedStatus ?? 0,
    input.public === false ? 0 : 1, input.enabled === false ? 0 : 1, now());
  scheduleCheck(id);
  return getCheckRow(id);
}

/**
 * Auto-create a check on an app's first successful deploy when it is routed to a domain.
 * Returns the new check row, or null when nothing was created.
 */
/** False for hosts the Docksy server cannot reach from the internet: localhost, *.localhost, *.local, private and loopback IPs. */
export function isPublicHost(domain: string): boolean {
  const host = domain.trim().replace(/^https?:\/\//, '').replace(/[/:].*$/, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return !host.includes('host.docker.internal');
  const [a, b] = [Number(m[1]), Number(m[2])];
  return !(a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254));
}

export function handleDeploymentFinished(p: { appId: string; status: string }): Row | null {
  if (p.status !== 'succeeded') return null;
  const app = db.prepare('SELECT a.*, s.host AS server_host FROM apps a JOIN servers s ON s.id = a.server_id WHERE a.id = ?').get(p.appId) as Row | undefined;
  if (!app || app.port == null || app.kind === 'database') return null;
  const succeeded = db.prepare(`SELECT COUNT(*) AS n FROM deployments WHERE app_id = ? AND status = 'succeeded'`).get(p.appId) as Row;
  if (Number(succeeded.n) > 1) return null; // only on the first successful deploy; respect a user who deleted it later
  let domains: string[] = [];
  try { domains = JSON.parse(app.domains ?? '[]'); } catch { domains = []; }
  const domain = domains.find((d) => typeof d === 'string' && d.trim()) ?? defaultDomain(app.name, app.server_host);
  if (!domain || !isPublicHost(domain)) return null; // a check on .localhost or a private IP would only ever fail
  const url = `https://${domain.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  const existing = db.prepare('SELECT id FROM uptime_checks WHERE app_id = ? OR url = ? OR url = ?').get(p.appId, url, `${url}/`) as Row | undefined;
  if (existing) return null;
  const row = createCheck({ name: app.name, url, appId: app.id });
  logActivity('system', 'uptime.create', 'uptime_check', row.id, `auto-created for ${app.name}`);
  return row;
}

let listening = false;

export function registerUptime(app: Hono<AppEnv>): void {
  if (!listening) {
    listening = true;
    bus.on('deployment.finished', (p) => {
      try { handleDeploymentFinished(p); } catch (e) { console.error('[docksy] uptime auto-check failed', e); }
    });
  }

  // ── public status page ──
  app.get('/api/v1/public/status', (c) => {
    if (!getSettings().statusPageEnabled) throw notFound('Status page');
    c.header('cache-control', 'public, max-age=30');
    return c.json(buildPublicStatus());
  });

  // ── checks ──
  app.get('/api/v1/uptime-checks', requireUser, (c) => {
    const appParam = c.req.query('appId');
    const appId = appParam ? resolveAppId(appParam) : null;
    return c.json({ items: listChecks({ appId }) });
  });

  app.post('/api/v1/uptime-checks', requireUser, async (c) => {
    const input = await body(c, createSchema);
    const row = createCheck(input);
    logActivity(c.get('actor'), 'uptime.create', 'uptime_check', row.id, row.url);
    return c.json(toUptimeCheck(row), 201);
  });

  app.get('/api/v1/uptime-checks/:id', requireUser, (c) => c.json(toUptimeCheck(getCheckRow(c.req.param('id')))));

  app.patch('/api/v1/uptime-checks/:id', requireUser, async (c) => {
    const row = getCheckRow(c.req.param('id'));
    const p = await body(c, updateSchema);
    const intervalSec = p.intervalSec ?? Number(row.interval_sec);
    const timeoutMs = p.timeoutMs ?? Number(row.timeout_ms);
    checkTimeout(intervalSec, timeoutMs);
    const appId = p.appId === undefined ? row.app_id : resolveAppId(p.appId);
    const enabled = p.enabled ?? bool(row.enabled);
    db.prepare(
      `UPDATE uptime_checks SET name = ?, url = ?, app_id = ?, interval_sec = ?, timeout_ms = ?, expected_status = ?, public = ?, enabled = ? WHERE id = ?`,
    ).run(p.name ?? row.name, p.url ?? row.url, appId ?? null, intervalSec, timeoutMs, p.expectedStatus ?? Number(row.expected_status),
      (p.public ?? bool(row.public)) ? 1 : 0, enabled ? 1 : 0, row.id);
    if (!enabled && bool(row.enabled)) clearCheckAlert(row.id);
    if (enabled) scheduleCheck(row.id); else unscheduleCheck(row.id);
    logActivity(c.get('actor'), 'uptime.update', 'uptime_check', row.id);
    return c.json(toUptimeCheck(getCheckRow(row.id)));
  });

  app.delete('/api/v1/uptime-checks/:id', requireUser, (c) => {
    const row = getCheckRow(c.req.param('id'));
    clearCheckAlert(row.id);
    unscheduleCheck(row.id);
    db.prepare('DELETE FROM uptime_checks WHERE id = ?').run(row.id);
    logActivity(c.get('actor'), 'uptime.delete', 'uptime_check', row.id, row.url);
    return c.json({ ok: true });
  });

  app.get('/api/v1/uptime-checks/:id/results', requireUser, (c) => {
    const row = getCheckRow(c.req.param('id'));
    const range = c.req.query('range') ?? '24h';
    const span = RANGES[range];
    if (!span) throw badRequest(`range must be one of ${Object.keys(RANGES).join(', ')}`);
    const items = downsampleResults(listResults(row.id, now() - span), MAX_RESULT_POINTS);
    return c.json({ items });
  });

  /** Run a check immediately (handy after fixing something). Not in CONTRACT §4.2; additive. */
  app.post('/api/v1/uptime-checks/:id/run', requireUser, async (c) => {
    const row = getCheckRow(c.req.param('id'));
    const result = await runCheckNow(row.id);
    logActivity(c.get('actor'), 'uptime.run', 'uptime_check', row.id);
    return c.json({ check: toUptimeCheck(getCheckRow(row.id)), result });
  });
}

export function startUptime(): void {
  startScheduler();
}
