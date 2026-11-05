import { db, getSettings, now, tx, type Row } from '../../db/index.ts';
import { stmts } from './store.ts';

/**
 * Rollups: raw (res 0) → 1-minute (res 60) → 1-hour (res 3600).
 * cpu/load/net are averaged; memory, swap and disk take the bucket maximum.
 * Idempotent: buckets are recomputed with INSERT OR REPLACE, and a lookback window is redone each run
 * so late reports and missed runs are absorbed.
 */

export const RAW_RETENTION_MS = 48 * 3600_000;
export const MINUTE_RETENTION_MS = 14 * 24 * 3600_000;

type Level = { src: 0 | 60; dst: 60 | 3600; lookbackMs: number };
export const LEVELS: Level[] = [
  { src: 0, dst: 60, lookbackMs: 10 * 60_000 },
  { src: 60, dst: 3600, lookbackMs: 3 * 3600_000 },
];

// Bucket sizes are fixed constants, inlined as integer literals so SQLite does integer division on ts.
function levelStmts(l: Level) {
  const b = l.dst * 1000;
  return {
    lastDst: db.prepare(`SELECT MAX(ts) AS ts FROM metrics WHERE server_id = ? AND res = ${l.dst}`),
    firstSrc: db.prepare(`SELECT MIN(ts) AS ts FROM metrics WHERE server_id = ? AND res = ${l.src}`),
    servers: db.prepare(`INSERT OR REPLACE INTO metrics
      (server_id, res, ts, cpu, load1, load5, load15, mem_used, mem_total, swap_used, disk_used, disk_total, net_rx, net_tx)
      SELECT server_id, ${l.dst}, (ts / ${b}) * ${b} AS bucket,
        AVG(cpu), AVG(load1), AVG(load5), AVG(load15), MAX(mem_used), MAX(mem_total), MAX(swap_used), MAX(disk_used), MAX(disk_total), AVG(net_rx), AVG(net_tx)
      FROM metrics WHERE server_id = ? AND res = ${l.src} AND ts >= ? AND ts < ?
      GROUP BY bucket`),
    containers: db.prepare(`INSERT OR REPLACE INTO container_metrics
      (server_id, container_name, res, ts, app_id, cpu, mem_used, net_rx, net_tx)
      SELECT server_id, container_name, ${l.dst}, (ts / ${b}) * ${b} AS bucket,
        MAX(app_id), AVG(cpu), MAX(mem_used), AVG(net_rx), AVG(net_tx)
      FROM container_metrics WHERE server_id = ? AND res = ${l.src} AND ts >= ? AND ts < ?
      GROUP BY container_name, bucket`),
  };
}

function prepare() {
  stmts(); // ensures the extra container_metrics indexes exist
  return {
    levels: LEVELS.map((l) => ({ l, q: levelStmts(l) })),
    serverIds: db.prepare('SELECT id FROM servers'),
    delMetrics: db.prepare('DELETE FROM metrics WHERE server_id = ? AND res = ? AND ts < ?'),
    delContainerMetrics: db.prepare('DELETE FROM container_metrics WHERE server_id = ? AND res = ? AND ts < ?'),
  };
}

let R: ReturnType<typeof prepare> | null = null;
const rstmts = () => (R ??= prepare());

const serverIds = (): string[] => (rstmts().serverIds.all() as Row[]).map((r) => r.id as string);

/** Roll up every complete bucket that is new, or inside the lookback window, for every server and level. */
export function runRollups(t: number = now()): void {
  const { levels } = rstmts();
  for (const id of serverIds()) {
    for (const { l, q } of levels) {
      const bucketMs = l.dst * 1000;
      const end = Math.floor(t / bucketMs) * bucketMs; // exclusive: only complete buckets
      const last = (q.lastDst.get(id) as Row).ts as number | null;
      let start: number | null;
      if (last != null) start = Math.min(Number(last), end - l.lookbackMs);
      else start = (q.firstSrc.get(id) as Row).ts as number | null;
      if (start == null) continue;
      start = Math.floor(Number(start) / bucketMs) * bucketMs;
      if (start >= end) continue;
      tx(() => {
        q.servers.run(id, start, end);
        q.containers.run(id, start, end);
      });
    }
  }
}

/** Drop data past its retention: raw 48h, 1-minute 14d, 1-hour settings.metricsRetentionDays. */
export function applyRetention(t: number = now()): void {
  const { delMetrics, delContainerMetrics } = rstmts();
  const days = Math.max(1, Number(getSettings().metricsRetentionDays) || 30);
  const cutoffs: [number, number][] = [
    [0, t - RAW_RETENTION_MS],
    [60, t - MINUTE_RETENTION_MS],
    [3600, t - days * 24 * 3600_000],
  ];
  for (const id of serverIds()) {
    tx(() => {
      for (const [res, cutoff] of cutoffs) {
        delMetrics.run(id, res, cutoff);
        delContainerMetrics.run(id, res, cutoff);
      }
    });
  }
}

let timer: NodeJS.Timeout | null = null;

export function runMaintenance(t: number = now()): void {
  try {
    runRollups(t);
    applyRetention(t);
  } catch (e) {
    console.error('[docksy] metrics rollup failed', e);
  }
}

/** Every 60s (first run shortly after boot). Safe to call twice. */
export function startRollupJob(intervalMs = 60_000): void {
  if (timer) return;
  setTimeout(() => runMaintenance(), 5_000).unref();
  timer = setInterval(() => runMaintenance(), intervalMs);
  timer.unref();
}

export function stopRollupJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
