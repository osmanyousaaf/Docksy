import type {
  AgentContainer, AgentReport, ContainerInfo, ContainerMetricPoint, FleetOverview, LiveMetricsEvent,
  MetricPoint, MetricsRange, ServerMetrics,
} from '@docksy/shared';
import { db, now, isoReq, json, tx, type Row } from '../../db/index.ts';
import { config } from '../../config.ts';
import { listServers } from '../../core/servers/model.ts';
import { bucketize, pickStep, RANGE_SEC, resolutionFor, type Agg } from './downsample.ts';

/** Container label linking a container to its Docksy app (CONTRACT.md §6). */
export const APP_LABEL = 'docksy.app';

// ───────────── prepared statements (lazy: tables exist only after migrate()) ─────────────

function prepare() {
  // Extra indexes for app-level queries and per-server retention/rollups on container_metrics.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_container_metrics_app ON container_metrics(app_id, res, ts);
    CREATE INDEX IF NOT EXISTS idx_container_metrics_srv ON container_metrics(server_id, res, ts);
  `);
  return {
    insMetric: db.prepare(`INSERT OR REPLACE INTO metrics
      (server_id, res, ts, cpu, load1, load5, load15, mem_used, mem_total, swap_used, disk_used, disk_total, net_rx, net_tx)
      VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    delStates: db.prepare('DELETE FROM container_state WHERE server_id = ?'),
    insState: db.prepare(`INSERT OR REPLACE INTO container_state
      (server_id, container_id, name, image, state, status, restart_count, started_at, cpu, mem_used, mem_limit, net_rx, net_tx, labels, app_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insContainerMetric: db.prepare(`INSERT OR REPLACE INTO container_metrics
      (server_id, container_name, res, ts, app_id, cpu, mem_used, net_rx, net_tx)
      VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)`),
    updServer: db.prepare(`UPDATE servers SET last_seen_at = ?, agent_version = ?, os = ?, arch = ?,
      cpu_cores = ?, mem_total = ?, disk_total = ? WHERE id = ?`),
    latestRaw: db.prepare('SELECT * FROM metrics WHERE server_id = ? AND res = 0 ORDER BY ts DESC LIMIT ?'),
    serverRange: db.prepare('SELECT * FROM metrics WHERE server_id = ? AND res = ? AND ts >= ? AND ts <= ? ORDER BY ts'),
    states: db.prepare('SELECT * FROM container_state WHERE server_id = ? ORDER BY name'),
    appRange: db.prepare(`SELECT ts, SUM(cpu) AS cpu, SUM(mem_used) AS mem_used, SUM(net_rx) AS net_rx, SUM(net_tx) AS net_tx
      FROM container_metrics WHERE app_id = ? AND res = ? AND ts >= ? AND ts <= ? GROUP BY ts ORDER BY ts`),
    appsPerServer: db.prepare('SELECT server_id, COUNT(*) AS n FROM apps GROUP BY server_id'),
    firingPerServer: db.prepare(`SELECT server_id, COUNT(*) AS n FROM alerts WHERE state = 'firing' GROUP BY server_id`),
    runningContainers: db.prepare(`SELECT COUNT(*) AS n FROM container_state WHERE state = 'running'`),
  };
}

let S: ReturnType<typeof prepare> | null = null;
export const stmts = () => (S ??= prepare());

// ───────────── mappers ─────────────

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const int = (v: unknown): number => Math.max(0, Math.round(num(v)));

export function toPoint(r: Row): MetricPoint {
  return {
    ts: isoReq(r.ts),
    cpu: num(r.cpu),
    load1: num(r.load1),
    load5: num(r.load5),
    load15: num(r.load15),
    memUsed: Math.round(num(r.mem_used)),
    memTotal: Math.round(num(r.mem_total)),
    swapUsed: Math.round(num(r.swap_used)),
    diskUsed: Math.round(num(r.disk_used)),
    diskTotal: Math.round(num(r.disk_total)),
    netRx: num(r.net_rx),
    netTx: num(r.net_tx),
  };
}

export function toContainerInfo(r: Row): ContainerInfo {
  return {
    id: r.container_id,
    name: r.name,
    image: r.image,
    state: r.state,
    status: r.status,
    restartCount: Number(r.restart_count) || 0,
    startedAt: r.started_at ?? null,
    cpuPercent: num(r.cpu),
    memUsed: num(r.mem_used),
    memLimit: num(r.mem_limit),
    netRx: num(r.net_rx),
    netTx: num(r.net_tx),
    labels: json<Record<string, string>>(r.labels, {}),
    serverId: r.server_id,
    appId: r.app_id ?? null,
    updatedAt: isoReq(r.updated_at),
  };
}

/** Root filesystem if reported, otherwise the largest one. */
export function pickDisk(disks: AgentReport['disks']): { total: number; used: number } {
  if (!disks.length) return { total: 0, used: 0 };
  const root = disks.find((d) => d.mount === '/');
  if (root) return root;
  return disks.reduce((a, b) => (b.total > a.total ? b : a));
}

const appIdOf = (c: AgentContainer): string | null => c.labels?.[APP_LABEL] || null;

// ───────────── live cache (latest event per server; perCore is not persisted) ─────────────

const live = new Map<string, LiveMetricsEvent>();

export function forgetServer(serverId: string): void {
  live.delete(serverId);
}

/** Latest live event: from memory if we have it, otherwise rebuilt from the DB (perCore empty). */
export function latestLive(serverId: string): LiveMetricsEvent | null {
  const cached = live.get(serverId);
  if (cached) return cached;
  const r = stmts().latestRaw.get(serverId, 1) as Row | undefined;
  if (!r) return null;
  return { serverId, point: toPoint(r), perCore: [], containers: listContainers(serverId) };
}

// ───────────── ingest ─────────────

/**
 * Store one agent report: raw metrics row, container snapshot (replacing the previous one),
 * raw container metrics, and the server's identity fields. One transaction per report.
 * Uses the control plane's clock for `ts` so skewed agent clocks can't scramble the series.
 */
export function ingestReport(serverId: string, report: AgentReport, t: number = now()): LiveMetricsEvent {
  const s = stmts();
  const disk = pickDisk(report.disks);
  const point = {
    ts: t,
    cpu: num(report.cpu.percent),
    load1: num(report.cpu.load1),
    load5: num(report.cpu.load5),
    load15: num(report.cpu.load15),
    mem_used: int(report.mem.used),
    mem_total: int(report.mem.total),
    swap_used: int(report.mem.swapUsed),
    disk_used: int(disk.used),
    disk_total: int(disk.total),
    net_rx: num(report.net.rxBytesPerSec),
    net_tx: num(report.net.txBytesPerSec),
  };
  const updatedAt = isoReq(t);
  const containers: ContainerInfo[] = [];

  tx(() => {
    s.insMetric.run(serverId, t, point.cpu, point.load1, point.load5, point.load15, point.mem_used, point.mem_total, point.swap_used,
      point.disk_used, point.disk_total, point.net_rx, point.net_tx);

    s.delStates.run(serverId);
    for (const c of report.containers) {
      const appId = appIdOf(c);
      const info: ContainerInfo = {
        id: c.id,
        name: c.name,
        image: c.image,
        state: c.state,
        status: c.status,
        startedAt: c.startedAt ?? null,
        cpuPercent: num(c.cpuPercent),
        memUsed: int(c.memUsed),
        memLimit: int(c.memLimit),
        netRx: num(c.netRx),
        netTx: num(c.netTx),
        restartCount: int(c.restartCount),
        labels: c.labels ?? {},
        serverId,
        appId,
        updatedAt,
      };
      containers.push(info);
      s.insState.run(serverId, c.id, c.name, c.image, c.state, c.status, info.restartCount, info.startedAt,
        info.cpuPercent, info.memUsed, info.memLimit, info.netRx, info.netTx, JSON.stringify(info.labels), appId, t);
      if (c.state === 'running') {
        s.insContainerMetric.run(serverId, c.name, t, appId, info.cpuPercent, info.memUsed, info.netRx, info.netTx);
      }
    }

    s.updServer.run(t, report.agentVersion || null, report.os || null, report.arch || null,
      int(report.cpu.cores) || null, point.mem_total || null, point.disk_total || null, serverId);
  });

  containers.sort((a, b) => a.name.localeCompare(b.name));
  const ev: LiveMetricsEvent = { serverId, point: toPoint(point), perCore: report.cpu.perCore.map(num), containers };
  live.set(serverId, ev);
  return ev;
}

// ───────────── queries ─────────────

const SERVER_AGG = {
  cpu: 'avg', load1: 'avg', load5: 'avg', load15: 'avg', mem_used: 'max', mem_total: 'max', swap_used: 'max',
  disk_used: 'max', disk_total: 'max', net_rx: 'avg', net_tx: 'avg',
} satisfies Record<string, Agg>;

const APP_AGG = { cpu: 'avg', mem_used: 'max', net_rx: 'avg', net_tx: 'avg' } satisfies Record<string, Agg>;

/**
 * Read `res` rows from `from`, then fill the not-yet-rolled-up tail from finer resolutions,
 * so 24h/7d/30d charts reach "now" (and work before the first rollup ran).
 */
function readChain(res: number, from: number, to: number, q: (res: number, from: number, to: number) => Row[]): Row[] {
  const chain = [3600, 60, 0].filter((r) => r <= res);
  const out: Row[] = [];
  let cursor = from;
  for (const r of chain) {
    const rows = q(r, cursor, to);
    if (rows.length) {
      for (const row of rows) out.push(row);
      cursor = Number(rows[rows.length - 1]!.ts) + r * 1000;
    }
  }
  return out;
}

function rangeWindow(range: MetricsRange, t: number) {
  const res = resolutionFor(range);
  const rangeSec = RANGE_SEC[range];
  const stepSec = pickStep(rangeSec, res || config.agentIntervalSec);
  return { res, from: t - rangeSec * 1000, stepSec };
}

export function queryServerMetrics(serverId: string, range: MetricsRange, t: number = now()): ServerMetrics {
  const { res, from, stepSec } = rangeWindow(range, t);
  const rows = readChain(res, from, t, (r, a, b) => stmts().serverRange.all(serverId, r, a, b) as Row[]);
  const points = bucketize(rows as any[], stepSec * 1000, SERVER_AGG).map(toPoint);
  return { serverId, range, stepSec, points };
}

/** Summed across all of the app's containers (old + new during a deploy), then bucketed. */
export function queryAppMetrics(appId: string, range: MetricsRange, t: number = now()): { points: ContainerMetricPoint[]; stepSec: number } {
  const { res, from, stepSec } = rangeWindow(range, t);
  const rows = readChain(res, from, t, (r, a, b) => stmts().appRange.all(appId, r, a, b) as Row[]);
  const points = bucketize(rows as any[], stepSec * 1000, APP_AGG).map((r) => ({
    ts: isoReq(r.ts), cpu: num(r.cpu), memUsed: Math.round(num(r.mem_used)), netRx: num(r.net_rx), netTx: num(r.net_tx),
  }));
  return { points, stepSec };
}

export const listContainers = (serverId: string): ContainerInfo[] =>
  (stmts().states.all(serverId) as Row[]).map(toContainerInfo);

/** Newest-first raw rows. */
export const recentRaw = (serverId: string, n: number): Row[] => stmts().latestRaw.all(serverId, n) as Row[];

export function fleetOverview(): FleetOverview {
  const s = stmts();
  const apps = new Map((s.appsPerServer.all() as Row[]).map((r) => [r.server_id as string, Number(r.n)]));
  const firing = new Map((s.firingPerServer.all() as Row[]).map((r) => [r.server_id as string | null, Number(r.n)]));
  const servers = listServers().map((server) => {
    const rows = recentRaw(server.id, 30);
    return {
      server,
      latest: rows[0] ? toPoint(rows[0]) : null,
      spark: rows.map((r) => num(r.cpu)).reverse(),
      appsCount: apps.get(server.id) ?? 0,
      firingAlerts: firing.get(server.id) ?? 0,
    };
  });
  let appsTotal = 0;
  for (const n of apps.values()) appsTotal += n;
  let firingTotal = 0;
  for (const n of firing.values()) firingTotal += n;
  return {
    servers,
    totals: {
      servers: servers.length,
      online: servers.filter((x) => x.server.liveness === 'online').length,
      apps: appsTotal,
      runningContainers: Number((s.runningContainers.get() as Row).n) || 0,
      firingAlerts: firingTotal,
    },
  };
}
