import type { AgentReport, Alert, AlertMetric, AlertRule, Severity } from '@docksy/shared';
import { db, now, newId, getSettings, type Row } from '../../db/index.ts';
import { bus } from '../../lib/events.ts';
import { config } from '../../config.ts';
import { HOST_METRICS, channelsForRule, firingRow, getRule, pickRule, readConfig, ruleMatches, rulesFor, toAlert, toRule } from './model.ts';
import { breaches, fmtDuration, heldFor, hostCopy, hostResolvedNote, reportValue, restartsInWindow, rowValue, type Sample } from './evaluate.ts';
import { sendNotice, type AlertNotice } from './notify.ts';

/**
 * Alert engine.
 *  - host metric rules (cpu/mem/disk/load/swap): evaluated on every 'server.report', durations use the raw metrics window
 *  - server_offline: a loop every 30s
 *  - container_down / container_restarts: from the containers in each report
 *  - deploy_failed: from 'deployment.finished'
 *  - uptime_down / backup_failed (and anything else): other modules call fireEventAlert / resolveEventAlert
 * One firing alert per dedupe_key. Fired and resolved alerts notify the rule's channels and emit alert.fired / alert.resolved.
 */

const DEFAULT_OFFLINE_SEC = 120;
const DEFAULT_RESTART_WINDOW_SEC = 600;
const DOWN_STATES = new Set(['exited', 'dead']);
/** Apps in these states are expected to have stopped/replaced containers. */
const QUIET_APP_STATES = new Set(['stopped', 'deploying']);

interface OpenSpec {
  rule: AlertRule | null;
  key: string;
  title: string;
  message: string;
  severity: Severity;
  serverId: string | null;
  appId: string | null;
  value: number | null;
}

// ───────────────────────────── notifications ─────────────────────────────

const pending = new Set<Promise<void>>();

/** Await every in-flight notification (tests, graceful shutdown). */
export async function flushNotifications(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

function namesFor(serverId: string | null, appId: string | null): { serverName: string | null; appName: string | null } {
  const s = serverId ? (db.prepare('SELECT name FROM servers WHERE id = ?').get(serverId) as Row | undefined) : undefined;
  const a = appId ? (db.prepare('SELECT name FROM apps WHERE id = ?').get(appId) as Row | undefined) : undefined;
  return { serverName: s?.name ?? null, appName: a?.name ?? null };
}

export function noticeFor(kind: AlertNotice['kind'], alert: Alert, note?: string | null): AlertNotice {
  const settings = getSettings();
  return {
    kind,
    alert,
    ...namesFor(alert.serverId, alert.appId),
    note: note ?? null,
    link: `${settings.publicUrl.replace(/\/+$/, '')}/alerts`,
    instance: settings.instanceName || 'Docksy',
  };
}

function dispatch(kind: 'fired' | 'resolved', alert: Alert, rule: AlertRule | null, note?: string | null): void {
  const channels = channelsForRule(rule);
  if (channels.length === 0) return;
  const n = noticeFor(kind, alert, note);
  for (const ch of channels) {
    const p: Promise<void> = sendNotice({ type: ch.type, config: readConfig(ch) }, n)
      .catch((e: unknown) => console.warn(`[docksy] alert notification to "${ch.name}" failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => { pending.delete(p); });
    pending.add(p);
  }
}

// ───────────────────────────── lifecycle ─────────────────────────────

/** Fire (or refresh) the alert for spec.key. Returns the new alert, or null when one was already firing. */
function openAlert(spec: OpenSpec): Alert | null {
  const existing = firingRow(spec.key);
  if (existing) {
    db.prepare('UPDATE alerts SET title = ?, message = ?, value = ? WHERE id = ?').run(spec.title, spec.message, spec.value, existing.id);
    return null;
  }
  const id = newId();
  db.prepare(`INSERT INTO alerts (id, rule_id, server_id, app_id, dedupe_key, state, severity, title, message, value, started_at)
              VALUES (?, ?, ?, ?, ?, 'firing', ?, ?, ?, ?, ?)`)
    .run(id, spec.rule?.id ?? null, spec.serverId, spec.appId, spec.key, spec.severity, spec.title, spec.message, spec.value, now());
  const alert = toAlert(db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as Row);
  bus.emit('alert.fired', { alert });
  dispatch('fired', alert, spec.rule);
  return alert;
}

/** Resolve the firing alert for this key (if any). */
function closeAlert(key: string, note?: string | null, opts: { notify?: boolean } = {}): Alert | null {
  const row = firingRow(key);
  if (!row) return null;
  return closeRow(row, note, opts);
}

function closeRow(row: Row, note?: string | null, opts: { notify?: boolean } = {}): Alert {
  db.prepare("UPDATE alerts SET state = 'resolved', resolved_at = ? WHERE id = ?").run(now(), row.id);
  const alert = toAlert(db.prepare('SELECT * FROM alerts WHERE id = ?').get(row.id) as Row);
  bus.emit('alert.resolved', { alert });
  if (opts.notify !== false) dispatch('resolved', alert, row.rule_id ? getRule(row.rule_id) : null, note);
  return alert;
}

/** Make the firing set under `prefix` equal `desired`: open what's missing, resolve what's gone. */
function reconcile(prefix: string, desired: Map<string, OpenSpec>): void {
  for (const spec of desired.values()) openAlert(spec);
  const rows = db.prepare("SELECT * FROM alerts WHERE state = 'firing' AND substr(dedupe_key, 1, ?) = ?").all(prefix.length, prefix) as Row[];
  for (const r of rows) if (!desired.has(r.dedupe_key)) closeRow(r);
}

/** Quietly resolve everything a rule has firing (rule deleted, disabled or changed). */
export function resolveRuleAlerts(ruleId: string): number {
  const rows = db.prepare("SELECT * FROM alerts WHERE state = 'firing' AND rule_id = ?").all(ruleId) as Row[];
  for (const r of rows) closeRow(r, null, { notify: false });
  return rows.length;
}

// ───────────────────────────── frozen cross-module API ─────────────────────────────

/**
 * Fire an event alert (uptime_down, backup_failed, ...). `key` is the dedupe key; call resolveEventAlert(key)
 * when the condition clears. Uses the most specific enabled rule for the metric; no enabled rule = alerts off.
 * Never throws.
 */
export function fireEventAlert(metric: AlertMetric, o: { key: string; title: string; message: string; severity?: Severity; serverId?: string | null; appId?: string | null; value?: number | null }): void {
  try {
    const appId = o.appId ?? null;
    let serverId = o.serverId ?? null;
    if (!serverId && appId) serverId = ((db.prepare('SELECT server_id FROM apps WHERE id = ?').get(appId) as Row | undefined)?.server_id as string | undefined) ?? null;
    const rule = pickRule(rulesFor([metric], { serverId, appId }));
    if (!rule) return;
    openAlert({ rule, key: o.key, title: o.title, message: o.message, severity: o.severity ?? rule.severity, serverId, appId, value: o.value ?? null });
  } catch (e) {
    console.warn('[docksy] fireEventAlert failed', e);
  }
}

/** Resolve the firing alert with this dedupe key, if any. Never throws. */
export function resolveEventAlert(key: string): void {
  try { closeAlert(key); } catch (e) { console.warn('[docksy] resolveEventAlert failed', e); }
}

// ───────────────────────────── host metrics ─────────────────────────────

const intervalMs = (): number => Math.max(1, config.agentIntervalSec) * 1000;
const maxGapMs = (): number => Math.max(3 * intervalMs(), 90_000);

/** Raw metrics rows for a server, newest first, covering `windowMs` back from the newest row. */
function rawWindow(serverId: string, windowMs: number): Row[] {
  const max = (db.prepare('SELECT MAX(ts) AS t FROM metrics WHERE server_id = ? AND res = 0').get(serverId) as Row | undefined)?.t;
  if (max == null) return [];
  return db.prepare('SELECT * FROM metrics WHERE server_id = ? AND res = 0 AND ts >= ? ORDER BY ts DESC LIMIT 20000')
    .all(serverId, Number(max) - windowMs) as Row[];
}

function evaluateHost(server: Row, report: AgentReport): void {
  const rules = rulesFor(HOST_METRICS, { serverId: server.id }).filter((r) => !r.appId);
  if (rules.length === 0) return;
  const longest = Math.max(0, ...rules.map((r) => r.durationSec)) * 1000;
  let rows: Row[] | null = null;
  for (const rule of rules) {
    const key = `${rule.id}:${server.id}`;
    const value = reportValue(rule.metric, report);
    if (value == null) continue;
    const pred = (v: number) => breaches(v, rule.op, rule.threshold);
    if (!pred(value)) {
      closeAlert(key, hostResolvedNote(rule.metric, server.name, value));
      continue;
    }
    const copy = hostCopy(rule, server.name, value);
    const spec: OpenSpec = { rule, key, ...copy, severity: rule.severity, serverId: server.id, appId: null, value };
    if (rule.durationSec <= 0 || firingRow(key)) {
      openAlert(spec);
      continue;
    }
    rows ??= rawWindow(server.id, longest + maxGapMs());
    const swapTotal = report.mem?.swapTotal ?? 0;
    const samples: Sample[] = [];
    for (const r of rows) {
      const v = rowValue(rule.metric, r, swapTotal);
      if (v != null && Number.isFinite(v)) samples.push({ ts: Number(r.ts), value: v });
    }
    if (heldFor(samples, pred, rule.durationSec * 1000, { toleranceMs: intervalMs(), maxGapMs: maxGapMs() })) openAlert(spec);
  }
}

// ───────────────────────────── containers ─────────────────────────────

/** First time we saw a container down, per `${serverId}:${containerId}`. */
const downSince = new Map<string, number>();
/** (ts, restartCount) samples per `${serverId}:${containerId}`. */
const restartHistory = new Map<string, { ts: number; count: number }[]>();

function evaluateContainers(server: Row, report: AgentReport, t: number): void {
  const containers = report.containers ?? [];
  const apps = new Map<string, Row>();
  for (const a of db.prepare('SELECT id, name, status FROM apps WHERE server_id = ?').all(server.id) as Row[]) apps.set(a.id, a);

  // bookkeeping (independent of rules so durations/windows work as soon as a rule is added)
  const present = new Set<string>();
  const restartRules = rulesFor(['container_restarts'], { serverId: server.id });
  const keepMs = Math.max(3600, ...restartRules.map((r) => r.durationSec || DEFAULT_RESTART_WINDOW_SEC)) * 1000;
  for (const c of containers) {
    const k = `${server.id}:${c.id}`;
    present.add(k);
    if (DOWN_STATES.has(c.state)) { if (!downSince.has(k)) downSince.set(k, t); } else downSince.delete(k);
    const h = (restartHistory.get(k) ?? []).filter((s) => s.ts >= t - keepMs);
    h.push({ ts: t, count: Number(c.restartCount) || 0 });
    restartHistory.set(k, h);
  }
  for (const m of [downSince, restartHistory]) {
    for (const k of m.keys()) if (k.startsWith(`${server.id}:`) && !present.has(k)) m.delete(k);
  }

  // container_down: managed containers of a live app that are exited/dead
  for (const rule of rulesFor(['container_down'], { serverId: server.id })) {
    const desired = new Map<string, OpenSpec>();
    for (const c of containers) {
      const appId = c.labels?.['docksy.app'];
      if (c.labels?.['docksy.managed'] !== 'true' || !appId) continue;
      const app = apps.get(appId);
      if (!app || QUIET_APP_STATES.has(app.status)) continue;
      if (!ruleMatches(rule, { serverId: server.id, appId })) continue;
      if (!DOWN_STATES.has(c.state)) continue;
      const since = downSince.get(`${server.id}:${c.id}`) ?? t;
      if (rule.durationSec > 0 && t - since < rule.durationSec * 1000) continue;
      const key = `${rule.id}:${server.id}:${c.name}`;
      const title = `${app.name} is down on ${server.name}`;
      const message = `${app.name} on ${server.name} is ${c.state}${c.status ? ` (${c.status})` : ''}. Container ${c.name}.`;
      desired.set(key, { rule, key, title, message, severity: rule.severity, serverId: server.id, appId, value: null });
    }
    reconcile(`${rule.id}:${server.id}:`, desired);
  }

  // container_restarts: restart count grew by more than threshold within the window
  for (const rule of restartRules) {
    const windowSec = rule.durationSec || DEFAULT_RESTART_WINDOW_SEC;
    const desired = new Map<string, OpenSpec>();
    for (const c of containers) {
      const appId = c.labels?.['docksy.app'] ?? null;
      if (!ruleMatches(rule, { serverId: server.id, appId })) continue;
      const n = restartsInWindow(restartHistory.get(`${server.id}:${c.id}`) ?? [], t, windowSec * 1000);
      if (!breaches(n, rule.op, rule.threshold)) continue;
      const display = (appId && apps.get(appId)?.name) || c.name;
      const key = `${rule.id}:${server.id}:${c.name}`;
      const title = `${display} restarted ${n} times in ${fmtDuration(windowSec)} on ${server.name}`;
      const message = `${title}. It may be crash-looping.`;
      desired.set(key, { rule, key, title, message, severity: rule.severity, serverId: server.id, appId, value: n });
    }
    reconcile(`${rule.id}:${server.id}:`, desired);
  }
}

/** Evaluate every report-driven rule for one agent report. Exported for tests. */
export function evaluateReport(serverId: string, report: AgentReport, t: number = now()): void {
  const server = db.prepare('SELECT id, name FROM servers WHERE id = ?').get(serverId) as Row | undefined;
  if (!server) return;
  for (const rule of rulesFor(['server_offline'], { serverId })) closeAlert(`${rule.id}:${serverId}`, `${server.name} is back online.`);
  evaluateHost(server, report);
  evaluateContainers(server, report, t);
}

// ───────────────────────────── offline ─────────────────────────────

let startedAt = 0;

/** Fire server_offline for servers whose agent stopped reporting. Exported for tests. */
export function checkOffline(t: number = now()): void {
  const rules = (db.prepare("SELECT * FROM alert_rules WHERE enabled = 1 AND metric = 'server_offline' AND app_id IS NULL").all() as Row[]).map(toRule);
  if (rules.length === 0) return;
  const servers = db.prepare('SELECT id, name, last_seen_at FROM servers WHERE last_seen_at IS NOT NULL').all() as Row[];
  for (const s of servers) {
    const age = t - Number(s.last_seen_at);
    // Docksy itself being down is not the agent's fault: only open new alerts once a full limit has passed since our start.
    const graceAge = t - Math.max(Number(s.last_seen_at), startedAt);
    for (const rule of rules) {
      if (!ruleMatches(rule, { serverId: s.id })) continue;
      const limitSec = rule.durationSec > 0 ? rule.durationSec : DEFAULT_OFFLINE_SEC;
      const key = `${rule.id}:${s.id}`;
      if (age <= limitSec * 1000) {
        closeAlert(key, `${s.name} is back online.`);
      } else if (graceAge > limitSec * 1000) {
        const ageSec = Math.round(age / 1000);
        openAlert({
          rule, key, severity: rule.severity, serverId: s.id, appId: null, value: ageSec,
          title: `${s.name} is offline`,
          message: `${s.name} hasn't reported for ${fmtDuration(ageSec)} (limit ${fmtDuration(limitSec)}). The agent or the server may be down.`,
        });
      }
    }
  }
}

// ───────────────────────────── deployments ─────────────────────────────

/** deploy_failed fires on a failed deployment and resolves on the next successful one. Exported for tests. */
export function onDeploymentFinished(p: { appId: string; status: 'succeeded' | 'failed' | 'cancelled'; error: string | null }): void {
  if (p.status === 'cancelled') return;
  const app = db.prepare('SELECT id, name, server_id FROM apps WHERE id = ?').get(p.appId) as Row | undefined;
  if (!app) return;
  for (const rule of rulesFor(['deploy_failed'], { serverId: app.server_id, appId: app.id })) {
    const key = `${rule.id}:${app.id}`;
    if (p.status === 'succeeded') {
      closeAlert(key, `${app.name} deployed successfully.`);
      continue;
    }
    const err = (p.error ?? '').trim().replace(/\s+/g, ' ');
    openAlert({
      rule, key, severity: rule.severity, serverId: app.server_id, appId: app.id, value: null,
      title: `Deploy of ${app.name} failed`,
      message: `Deploy of ${app.name} failed${err ? `: ${err.length > 300 ? `${err.slice(0, 299)}…` : err}` : '.'} The previous version is still running.`,
    });
  }
}

// ───────────────────────────── start / stop ─────────────────────────────

let stops: (() => void)[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

const safe = (what: string, fn: () => void) => {
  try { fn(); } catch (e) { console.warn(`[docksy] alerts: ${what} failed`, e); }
};

/** Subscribe to the bus and start the 30s offline loop. Idempotent. */
export function startEngine(opts: { offlineIntervalMs?: number } = {}): void {
  if (timer) return;
  startedAt = now();
  stops = [
    bus.on('server.report', ({ serverId, report }) => safe('report evaluation', () => evaluateReport(serverId, report))),
    bus.on('deployment.finished', (p) => safe('deploy alert', () => onDeploymentFinished(p))),
    bus.on('server.deleted', ({ serverId }) => {
      for (const m of [downSince, restartHistory]) for (const k of m.keys()) if (k.startsWith(`${serverId}:`)) m.delete(k);
    }),
  ];
  timer = setInterval(() => safe('offline check', () => checkOffline()), opts.offlineIntervalMs ?? 30_000);
  timer.unref?.();
}

export function stopEngine(): void {
  for (const s of stops) s();
  stops = [];
  if (timer) clearInterval(timer);
  timer = null;
  startedAt = 0;
}

/** Tests: forget in-memory container history. */
export function resetEngineState(): void {
  downSince.clear();
  restartHistory.clear();
}
