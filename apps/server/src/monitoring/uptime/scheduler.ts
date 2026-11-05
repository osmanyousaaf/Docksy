import type { UptimeResult } from '@docksy/shared';
import { db, now, bool, isoReq, type Row } from '../../db/index.ts';
import { fireEventAlert, resolveEventAlert } from '../alerts/engine.ts';
import { probe, type FetchLike } from './probe.ts';
import { findCheckRow, insertResult, loadCheckState, pruneResults } from './model.ts';
import { RETENTION_MS, jitter, nextCheckState, type CheckState } from './stats.ts';

/**
 * Uptime scheduler: one timer per enabled check, jittered, never overlapping.
 * After a single failure the next attempt comes sooner (RETRY_MS) to confirm the outage quickly.
 */

const RETRY_MS = 15_000;
const FIRST_RUN_SPREAD_MS = 30_000;
const RETENTION_EVERY_MS = 3_600_000;

let fetchImpl: FetchLike = (u, i) => fetch(u, i);
let alertHooks = { fire: fireEventAlert, resolve: resolveEventAlert };

/** Test hook: replace fetch. */
export function setUptimeFetch(f: FetchLike): void { fetchImpl = f; }
/** Test hook: observe alert fire/resolve calls. */
export function setUptimeAlertHooks(h: Partial<typeof alertHooks>): void { alertHooks = { ...alertHooks, ...h }; }

const states = new Map<string, CheckState>();
const timers = new Map<string, NodeJS.Timeout>();
const running = new Set<string>();
let started = false;
let retentionTimer: NodeJS.Timeout | null = null;

export const alertKey = (checkId: string): string => `uptime:${checkId}`;

function getState(checkId: string): CheckState {
  let s = states.get(checkId);
  if (!s) { s = loadCheckState(checkId); states.set(checkId, s); }
  return s;
}

function serverIdForApp(appId: string | null): string | null {
  if (!appId) return null;
  const r = db.prepare('SELECT server_id FROM apps WHERE id = ?').get(appId) as Row | undefined;
  return r?.server_id ?? null;
}

function appName(appId: string | null): string | null {
  if (!appId) return null;
  const r = db.prepare('SELECT name FROM apps WHERE id = ?').get(appId) as Row | undefined;
  return r?.name ?? null;
}

function safely(fn: () => void): void {
  try { fn(); } catch (e) { console.error('[docksy] uptime alert hook failed', e); }
}

/** Run one check right now, store the result and fire/resolve alerts. Returns null if missing or already running. */
export async function runCheckNow(checkId: string): Promise<UptimeResult | null> {
  const row = findCheckRow(checkId);
  if (!row || running.has(checkId)) return null;
  running.add(checkId);
  try {
    const r = await probe({ url: row.url, timeoutMs: Number(row.timeout_ms), expectedStatus: Number(row.expected_status) }, fetchImpl);
    const ts = now();
    if (!findCheckRow(checkId)) return null; // deleted while probing
    insertResult(checkId, ts, r);
    const prev = getState(checkId);
    const { state, event } = nextCheckState(prev, r.ok);
    states.set(checkId, state);
    if (event === 'down') {
      const app = appName(row.app_id ?? null);
      safely(() => alertHooks.fire('uptime_down', {
        key: alertKey(checkId),
        title: `${row.name} is down`,
        message: `${row.url} failed ${state.fails} checks in a row (${r.error ?? 'no response'}). Ask Claude: /docksy:diagnose${app ? ` ${app}` : ''}`,
        severity: 'critical',
        appId: row.app_id ?? null,
        serverId: serverIdForApp(row.app_id ?? null),
        value: r.statusCode,
      }));
    } else if (event === 'up') {
      safely(() => alertHooks.resolve(alertKey(checkId)));
    }
    return { ts: isoReq(ts), ...r };
  } finally {
    running.delete(checkId);
  }
}

function setTimer(checkId: string, delayMs: number): void {
  const old = timers.get(checkId);
  if (old) clearTimeout(old);
  const t = setTimeout(() => { void tick(checkId); }, delayMs);
  t.unref?.();
  timers.set(checkId, t);
}

async function tick(checkId: string): Promise<void> {
  timers.delete(checkId);
  const row = findCheckRow(checkId);
  if (!row || !bool(row.enabled)) return;
  try {
    await runCheckNow(checkId);
  } catch (e) {
    console.error('[docksy] uptime check failed to run', checkId, e);
  }
  if (!started) return;
  const fresh = findCheckRow(checkId);
  if (!fresh || !bool(fresh.enabled) || timers.has(checkId)) return; // removed, disabled, or rescheduled meanwhile
  const base = Number(fresh.interval_sec) * 1000;
  const st = states.get(checkId);
  const delay = st && st.fails > 0 && !st.alerting ? Math.min(base, RETRY_MS) : jitter(base);
  setTimer(checkId, delay);
}

/** (Re)schedule a check after create/update. No-op when the scheduler isn't running (tests, DOCKSY_DISABLE_JOBS). */
export function scheduleCheck(checkId: string): void {
  if (!started) return;
  const row = findCheckRow(checkId);
  if (!row || !bool(row.enabled)) { unscheduleCheck(checkId); return; }
  setTimer(checkId, 1000 + Math.round(Math.random() * 2000));
}

export function unscheduleCheck(checkId: string): void {
  const t = timers.get(checkId);
  if (t) clearTimeout(t);
  timers.delete(checkId);
  states.delete(checkId);
}

/** Resolve a firing alert for a check that was deleted or disabled. */
export function clearCheckAlert(checkId: string): void {
  const s = states.get(checkId) ?? loadCheckState(checkId);
  if (s.alerting || s.fails > 0) safely(() => alertHooks.resolve(alertKey(checkId)));
  states.delete(checkId);
}

export function runRetention(nowMs = now()): number {
  try {
    return pruneResults(nowMs - RETENTION_MS);
  } catch (e) {
    console.error('[docksy] uptime retention failed', e);
    return 0;
  }
}

export function startScheduler(): void {
  if (started) return;
  started = true;
  const rows = db.prepare('SELECT id, interval_sec FROM uptime_checks WHERE enabled = 1').all() as Row[];
  for (const r of rows) {
    const spread = Math.min(Number(r.interval_sec) * 1000, FIRST_RUN_SPREAD_MS);
    setTimer(r.id, 500 + Math.round(Math.random() * spread));
  }
  runRetention();
  retentionTimer = setInterval(() => runRetention(), RETENTION_EVERY_MS);
  retentionTimer.unref?.();
}

export function stopScheduler(): void {
  started = false;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  states.clear();
  if (retentionTimer) clearInterval(retentionTimer);
  retentionTimer = null;
}
