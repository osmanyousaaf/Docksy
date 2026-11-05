import type { PublicStatus, UptimeResult } from '@docksy/shared';

/**
 * Pure uptime math (no DB, no network) so it is easy to test.
 */

export const DAY_MS = 86_400_000;
export const RETENTION_DAYS = 90;
export const RETENTION_MS = RETENTION_DAYS * DAY_MS;
/** A check must fail this many times in a row before we fire an alert (filters one-off blips). */
export const DOWN_AFTER_FAILS = 2;

/**
 * Percent of ok results, 2 decimals. Never rounds a failure up to 100:
 * 9999/10000 → 99.99, 99999/100000 → 99.99 (floored), all ok → 100. No data → null.
 */
export function uptimePercent(okCount: number, total: number): number | null {
  if (!total || total <= 0) return null;
  if (okCount >= total) return 100;
  return Math.floor((Math.max(0, okCount) / total) * 10_000) / 100;
}

/** expected = 0 means "any 2xx or 3xx". */
export function isExpectedStatus(code: number, expected: number): boolean {
  return expected === 0 ? code >= 200 && code < 400 : code === expected;
}

export interface CheckState {
  /** consecutive failed results */
  fails: number;
  /** an uptime_down alert is currently firing for this check */
  alerting: boolean;
}

export type CheckEvent = 'down' | 'up' | null;

/**
 * State machine for one check. Fires 'down' once when `downAfter` consecutive failures are reached,
 * and 'up' on the first success after that. A single failure followed by success emits nothing.
 */
export function nextCheckState(prev: CheckState, ok: boolean, downAfter = DOWN_AFTER_FAILS): { state: CheckState; event: CheckEvent } {
  if (ok) return { state: { fails: 0, alerting: false }, event: prev.alerting ? 'up' : null };
  const fails = prev.fails + 1;
  if (!prev.alerting && fails >= downAfter) return { state: { fails, alerting: true }, event: 'down' };
  return { state: { fails, alerting: prev.alerting }, event: null };
}

/** Rebuild state after a restart from recent results (newest first). */
export function stateFromRecent(oksNewestFirst: boolean[], downAfter = DOWN_AFTER_FAILS): CheckState {
  let fails = 0;
  for (const ok of oksNewestFirst) {
    if (ok) break;
    fails++;
  }
  return { fails, alerting: fails >= downAfter };
}

export const dayIndex = (ms: number): number => Math.floor(ms / DAY_MS);
export const dayKey = (index: number): string => new Date(index * DAY_MS).toISOString().slice(0, 10);

export interface DayRow { day: number; n: number; ok: number }

/** `days` UTC daily buckets ending today (oldest first). Days without results have uptime null. */
export function buildDailyBuckets(rows: DayRow[], nowMs: number, days = RETENTION_DAYS): { date: string; uptime: number | null }[] {
  const today = dayIndex(nowMs);
  const byDay = new Map<number, DayRow>();
  for (const r of rows) byDay.set(Number(r.day), r);
  const out: { date: string; uptime: number | null }[] = [];
  for (let d = today - days + 1; d <= today; d++) {
    const r = byDay.get(d);
    out.push({ date: dayKey(d), uptime: r ? uptimePercent(Number(r.ok), Number(r.n)) : null });
  }
  return out;
}

/** Overall banner for the status page. */
export function overallStatus(statuses: ('up' | 'down' | 'unknown')[]): PublicStatus['overall'] {
  const down = statuses.filter((s) => s === 'down').length;
  const up = statuses.filter((s) => s === 'up').length;
  if (down === 0) return 'operational';
  return up === 0 ? 'down' : 'degraded';
}

/**
 * Shrink a long, ascending result series to at most `max` points for charts.
 * A bucket is ok only if every result in it was ok, so short outages stay visible.
 */
export function downsampleResults(items: UptimeResult[], max: number): UptimeResult[] {
  if (items.length <= max || max <= 0) return items;
  const size = Math.ceil(items.length / max);
  const out: UptimeResult[] = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    const failed = chunk.find((r) => !r.ok);
    const lat = chunk.filter((r) => r.latencyMs != null).map((r) => r.latencyMs as number);
    const last = chunk[chunk.length - 1]!;
    out.push({
      ts: last.ts,
      ok: !failed,
      statusCode: failed ? failed.statusCode : last.statusCode,
      latencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
      error: failed ? failed.error : null,
    });
  }
  return out;
}

/** Spread checks out so they don't all fire on the same tick: ms ± ratio. */
export function jitter(ms: number, ratio = 0.1, rnd: () => number = Math.random): number {
  return Math.max(1000, Math.round(ms * (1 - ratio + 2 * ratio * rnd())));
}
