import type { MetricsRange } from '@docksy/shared';

/** Most points any metrics endpoint returns (keeps charts fast and payloads small). */
export const MAX_POINTS = 400;

export const RANGE_SEC: Record<MetricsRange, number> = {
  '15m': 15 * 60,
  '1h': 3600,
  '6h': 6 * 3600,
  '24h': 24 * 3600,
  '7d': 7 * 24 * 3600,
  '30d': 30 * 24 * 3600,
};

export const RANGES = Object.keys(RANGE_SEC) as MetricsRange[];

export const isRange = (v: unknown): v is MetricsRange => typeof v === 'string' && v in RANGE_SEC;

/** Stored resolution to read for a range: ≤6h raw, 24h–7d 1-minute rollups, 30d 1-hour rollups. */
export function resolutionFor(range: MetricsRange): 0 | 60 | 3600 {
  if (range === '30d') return 3600;
  if (range === '24h' || range === '7d') return 60;
  return 0;
}

/**
 * Bucket width (seconds) so a range yields at most `maxPoints` buckets.
 * Always a whole multiple of the base step (agent interval for raw data, or the rollup resolution).
 */
export function pickStep(rangeSec: number, baseStepSec: number, maxPoints = MAX_POINTS): number {
  const base = Math.max(1, Math.round(baseStepSec));
  const min = Math.ceil(rangeSec / Math.max(1, maxPoints - 1));
  return Math.max(base, Math.ceil(min / base) * base);
}

export type Agg = 'avg' | 'max' | 'sum' | 'last';

type NumRow = { ts: number } & Record<string, number>;

/**
 * Group time-ordered rows into fixed buckets aligned to the epoch (bucket ts = bucket start).
 * Each field is aggregated with its configured mode; fields not listed are dropped.
 */
export function bucketize<T extends NumRow>(rows: readonly T[], bucketMs: number, aggs: Partial<Record<Exclude<keyof T, 'ts'>, Agg>>): T[] {
  if (bucketMs <= 0) return rows.slice();
  const fields = Object.entries(aggs) as [string, Agg][];
  const out: T[] = [];
  let curKey = Number.NaN;
  let acc: Record<string, number> = {};
  let n = 0;
  const flush = () => {
    if (n === 0) return;
    const r: Record<string, number> = { ts: curKey };
    for (const [f, mode] of fields) r[f] = mode === 'avg' ? acc[f]! / n : acc[f]!;
    out.push(r as T);
  };
  for (const row of rows) {
    const key = Math.floor(row.ts / bucketMs) * bucketMs;
    if (key !== curKey) {
      flush();
      curKey = key;
      acc = {};
      n = 0;
    }
    for (const [f, mode] of fields) {
      const v = Number(row[f] ?? 0);
      const prev = acc[f];
      if (prev === undefined) acc[f] = v;
      else if (mode === 'max') acc[f] = Math.max(prev, v);
      else if (mode === 'last') acc[f] = v;
      else acc[f] = prev + v; // avg + sum accumulate
    }
    n++;
  }
  flush();
  return out;
}
