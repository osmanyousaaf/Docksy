import type { AgentReport, AlertMetric, AlertRule } from '@docksy/shared';
import type { Row } from '../../db/index.ts';

/** Pure alert logic (no DB, no network) so it is easy to test. */

export interface Sample { ts: number; value: number }

export const breaches = (value: number, op: '>' | '<', threshold: number): boolean =>
  op === '<' ? value < threshold : value > threshold;

const pct = (used: number, total: number): number | null => (total > 0 ? (used / total) * 100 : null);

/** The disk the dashboard shows: mount "/" or the largest one. */
export function primaryDisk(disks: AgentReport['disks']): { used: number; total: number } | null {
  if (!disks?.length) return null;
  return disks.find((d) => d.mount === '/') ?? [...disks].sort((a, b) => b.total - a.total)[0]!;
}

/** Current value of a host metric from an agent report (percent, or load1 for "load"). */
export function reportValue(metric: AlertMetric, r: AgentReport): number | null {
  switch (metric) {
    case 'cpu': return Number.isFinite(r.cpu?.percent) ? r.cpu.percent : null;
    case 'load': return Number.isFinite(r.cpu?.load1) ? r.cpu.load1 : null;
    case 'mem': return pct(r.mem?.used ?? 0, r.mem?.total ?? 0);
    case 'swap': return pct(r.mem?.swapUsed ?? 0, r.mem?.swapTotal ?? 0);
    case 'disk': {
      const d = primaryDisk(r.disks);
      return d ? pct(d.used, d.total) : null;
    }
    default: return null;
  }
}

/** Value of a host metric from a raw `metrics` row. Swap needs the total from the live report. */
export function rowValue(metric: AlertMetric, row: Row, swapTotal = 0): number | null {
  switch (metric) {
    case 'cpu': return Number(row.cpu);
    case 'load': return Number(row.load1);
    case 'mem': return pct(Number(row.mem_used), Number(row.mem_total));
    case 'disk': return pct(Number(row.disk_used), Number(row.disk_total));
    case 'swap': return pct(Number(row.swap_used), swapTotal);
    default: return null;
  }
}

/**
 * Has the condition held for `durationMs`? `samples` are newest first.
 * We walk back while samples breach and stay contiguous (no gap > maxGapMs), and
 * fire once the breaching run spans the duration, minus one interval of tolerance
 * (the newest report may not be stored yet when we evaluate).
 */
export function heldFor(
  samples: Sample[],
  pred: (v: number) => boolean,
  durationMs: number,
  opts: { toleranceMs: number; maxGapMs: number },
): boolean {
  if (durationMs <= 0) return samples.length > 0 && pred(samples[0]!.value);
  const sorted = [...samples].sort((a, b) => b.ts - a.ts);
  const need = Math.max(0, durationMs - opts.toleranceMs);
  const newest = sorted[0];
  if (!newest || !pred(newest.value)) return false;
  let prevTs = newest.ts;
  for (const s of sorted) {
    if (prevTs - s.ts > opts.maxGapMs) return false;
    if (!pred(s.value)) return false;
    if (newest.ts - s.ts >= need) return true;
    prevTs = s.ts;
  }
  return false;
}

/** Restart count increase within the window. History is (ts, restartCount) for one container. */
export function restartsInWindow(history: { ts: number; count: number }[], nowMs: number, windowMs: number): number {
  const inWin = history.filter((h) => h.ts >= nowMs - windowMs);
  if (inWin.length === 0) return 0;
  const latest = inWin.reduce((a, b) => (b.ts >= a.ts ? b : a));
  const min = Math.min(...inWin.map((h) => h.count));
  return Math.max(0, latest.count - min);
}

// ───────────────────────────── human copy ─────────────────────────────

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60), r = s % 60;
    return r && m < 10 ? `${m}m ${r}s` : `${Math.round(s / 60)}m`;
  }
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

const LABEL: Partial<Record<AlertMetric, string>> = { cpu: 'CPU', mem: 'Memory', disk: 'Disk', swap: 'Swap', load: 'Load' };

export const fmtValue = (metric: AlertMetric, v: number): string =>
  metric === 'load' ? (Math.round(v * 10) / 10).toString() : `${Math.round(v)}%`;

/** "CPU on prod-1 is 97%" + "CPU on prod-1 is 97% (over 90% for 5m)" */
export function hostCopy(rule: AlertRule, serverName: string, value: number): { title: string; message: string } {
  const label = LABEL[rule.metric] ?? rule.metric;
  const v = fmtValue(rule.metric, value);
  const t = fmtValue(rule.metric, rule.threshold);
  const full = rule.metric === 'disk' ? ' full' : '';
  const dir = rule.op === '<' ? 'under' : 'over';
  const dur = rule.durationSec > 0 ? ` for ${fmtDuration(rule.durationSec)}` : '';
  const title = `${label} on ${serverName} is ${v}${full}`;
  return { title, message: `${title} (${dir} ${t}${dur})` };
}

export function hostResolvedNote(metric: AlertMetric, serverName: string, value: number): string {
  return `${LABEL[metric] ?? metric} on ${serverName} is back to ${fmtValue(metric, value)}.`;
}
