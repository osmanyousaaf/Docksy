/** Pure renderers for the fleet overview and the per-server metrics screen (used by both static and --watch modes). */
import pc from 'picocolors';
import type { ContainerInfo, FleetOverview, MetricPoint, Server } from '@crovenai/docksy-client';
import {
  brand, formatBytes, formatPercent, livenessDot, padEnd, padStart, pct, sparkline, statusColor, table, timeAgo,
  truncate, usageBar, visibleWidth, type Column,
} from './format.ts';

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function clock(now: number): string {
  return new Date(now).toLocaleTimeString([], { hour12: false });
}

/** Left and right aligned on one line. */
function spread(left: string, right: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return gap >= 1 ? left + ' '.repeat(gap) + right : left;
}

function net(rx: number | null | undefined, tx: number | null | undefined): string {
  return `${pc.blue('↓')} ${padStart(formatBytes(rx, { perSec: true }), 8)}  ${pc.magenta('↑')} ${padStart(formatBytes(tx, { perSec: true }), 8)}`;
}

// ───────────────────────────── fleet (docksy status) ─────────────────────────────

export function renderFleet(ov: FleetOverview, o: { width: number; now?: number; url?: string; watching?: boolean }): string[] {
  const now = o.now ?? Date.now();
  const width = o.width;
  const t = ov.totals;
  const lines: string[] = [];
  lines.push(spread(` ${brand()}  ${pc.dim(o.url ?? '')}`, pc.dim(clock(now)) + ' ', width));
  lines.push('');
  const alerts = t.firingAlerts > 0 ? pc.red(`● ${t.firingAlerts} firing alert${t.firingAlerts === 1 ? '' : 's'}`) : pc.green('● no firing alerts');
  const online = t.online === t.servers ? pc.green(`${t.online} online`) : pc.yellow(`${t.online} online`);
  lines.push(` ${pc.bold(String(t.servers))} server${t.servers === 1 ? '' : 's'} ${pc.dim('·')} ${online}   ${pc.bold(String(t.apps))} apps   ${pc.bold(String(t.runningContainers))} containers running   ${alerts}`);
  lines.push('');
  if (ov.servers.length === 0) {
    lines.push(`  No servers yet. Add your first one:  ${pc.cyan('docksy servers add <name> <host>')}`);
    return lines;
  }
  const bw = width >= 150 ? 12 : width >= 125 ? 10 : width >= 105 ? 8 : 6;
  const sw = width >= 140 ? 20 : width >= 115 ? 14 : 10;
  const cols: Column[] = [
    { header: 'Server', max: 24 },
    { header: 'CPU' }, { header: 'Mem' }, { header: 'Disk' },
    { header: 'Net ↓ / ↑' },
    { header: 'CPU trend' },
    { header: 'Apps', align: 'right' },
    { header: 'Alerts', align: 'right' },
  ];
  const rows = ov.servers.map(({ server, latest, spark, appsCount, firingAlerts }) => {
    const p = server.liveness === 'online' ? latest : null;
    const name = `${livenessDot(server.liveness)} ${pc.bold(server.name)}`;
    const away = server.liveness === 'offline'
      ? `${pc.red('offline')}${server.lastSeenAt ? pc.dim(` · seen ${timeAgo(server.lastSeenAt, now)}`) : ''}`
      : pc.dim(server.status === 'ready' ? 'waiting for agent' : server.status);
    return [
      name,
      usageBar(p?.cpu, bw),
      usageBar(pct(p?.memUsed, p?.memTotal), bw),
      usageBar(pct(p?.diskUsed, p?.diskTotal), bw, { warn: 80, crit: 90 }),
      p ? net(p.netRx, p.netTx) : away,
      pc.cyan(sparkline(spark, { width: sw, min: 0, max: 100 })),
      String(appsCount),
      firingAlerts ? pc.red(String(firingAlerts)) : pc.dim('0'),
    ];
  });
  lines.push(...table(cols, rows, { width, indent: 1 }).split('\n'));
  lines.push('');
  if (o.watching) lines.push(pc.dim(` q quit · refreshes every 5s`));
  else lines.push(pc.dim(` Details: docksy metrics <server> --watch · Problems? docksy diagnose <server>`));
  return lines;
}

// ───────────────────────────── server metrics (docksy metrics) ─────────────────────────────

export interface MetricsState {
  server: Server;
  points: MetricPoint[];
  perCore: number[];
  containers: ContainerInfo[];
  /** Live stream connected (watch mode). */
  live?: boolean;
  /** Last error shown in the footer (watch mode). */
  error?: string | null;
  updatedAt?: number;
  rangeLabel?: string;
}

export function renderMetrics(s: MetricsState, o: { cols: number; rows?: number; now?: number; watching?: boolean }): string[] {
  const now = o.now ?? Date.now();
  const cols = o.cols;
  const maxRows = o.rows ?? Infinity;
  const srv = s.server;
  const p = s.points[s.points.length - 1] ?? null;
  const lines: string[] = [];

  const facts = [srv.os, srv.arch, srv.cpuCores ? `${srv.cpuCores} cores` : null, srv.agentVersion ? `agent ${srv.agentVersion}` : null].filter(Boolean).join(' · ');
  lines.push(spread(` ${brand('docksy metrics')}  ${pc.bold(srv.name)} ${pc.dim(srv.host)}  ${livenessDot(srv.liveness)} ${statusColor(srv.liveness)}  ${pc.dim(facts)}`, pc.dim(clock(now)) + ' ', cols));
  lines.push('');

  if (!p) {
    lines.push(srv.liveness === 'online' ? pc.dim('  Waiting for the first report from the agent…') : `  ${pc.yellow('No metrics yet.')} The agent hasn't reported${srv.lastSeenAt ? ` since ${timeAgo(srv.lastSeenAt, now)}` : ''}.`);
    if (srv.status !== 'ready') lines.push(`  Provision the server first: ${pc.cyan(`docksy servers provision ${srv.name}`)}`);
  } else {
    const label = 6;
    const bw = clamp(Math.floor(cols / 5), 10, 30);
    const tail = 28;
    const sw = clamp(cols - label - bw - 6 - tail - 4, 8, 80);
    const series = (f: (m: MetricPoint) => number | null) => s.points.map(f);
    const memPct = (m: MetricPoint) => pct(m.memUsed, m.memTotal);
    const diskPct = (m: MetricPoint) => pct(m.diskUsed, m.diskTotal);
    const row = (name: string, value: number | null, spark: string, extra: string, warn?: number, crit?: number) =>
      ` ${pc.bold(padEnd(name, label - 1))}${usageBar(value, bw, { warn, crit })}  ${spark}  ${extra}`;
    lines.push(row('CPU', p.cpu, pc.cyan(sparkline(series((m) => m.cpu), { width: sw, min: 0, max: 100 })), pc.dim(`load ${p.load1.toFixed(2)}`)));
    lines.push(row('MEM', memPct(p), pc.green(sparkline(series(memPct), { width: sw, min: 0, max: 100 })),
      `${formatBytes(p.memUsed)} ${pc.dim('/')} ${formatBytes(p.memTotal)}${p.swapUsed ? pc.yellow(` · swap ${formatBytes(p.swapUsed)}`) : ''}`));
    lines.push(row('DISK', diskPct(p), pc.yellow(sparkline(series(diskPct), { width: sw, min: 0, max: 100 })),
      `${formatBytes(p.diskUsed)} ${pc.dim('/')} ${formatBytes(p.diskTotal)}`, 80, 90));
    const nsw = clamp(Math.floor((cols - 40) / 2), 6, 40);
    lines.push(` ${pc.bold(padEnd('NET', label - 1))}${pc.blue('↓')} ${padStart(formatBytes(p.netRx, { perSec: true }), 10)} ${pc.blue(sparkline(series((m) => m.netRx), { width: nsw, min: 0 }))}   ${pc.magenta('↑')} ${padStart(formatBytes(p.netTx, { perSec: true }), 10)} ${pc.magenta(sparkline(series((m) => m.netTx), { width: nsw, min: 0 }))}`);
    if (s.rangeLabel) lines.push(pc.dim(`       ${s.rangeLabel}`));

    if (s.perCore.length) {
      lines.push('');
      lines.push(` ${pc.bold('CORES')}`);
      const cell = 18; // "  12 ██████ 100%"
      const maxPerLine = Math.max(1, Math.floor((cols - 2) / cell));
      const perLine = Math.ceil(s.perCore.length / Math.ceil(s.perCore.length / maxPerLine)); // balanced rows
      const cw = String(s.perCore.length - 1).length;
      for (let i = 0; i < s.perCore.length; i += perLine) {
        const chunk = s.perCore.slice(i, i + perLine).map((v, j) => `${pc.dim(padStart(String(i + j), cw))} ${usageBar(v, 8)}`);
        lines.push(' ' + chunk.map((c) => padEnd(c, cell)).join(''));
      }
    }
  }

  // Containers
  const cs = [...s.containers].sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || b.cpuPercent - a.cpuPercent || a.name.localeCompare(b.name));
  const running = cs.filter((c) => c.state === 'running').length;
  lines.push('');
  lines.push(` ${pc.bold('CONTAINERS')}  ${pc.dim(`${running} running${cs.length - running ? ` · ${cs.length - running} stopped` : ''}`)}`);
  if (cs.length === 0) {
    lines.push(pc.dim('  No containers reported yet.'));
  } else {
    const footer = o.watching ? 2 : 0;
    const room = Number.isFinite(maxRows) ? Math.max(1, maxRows - lines.length - 1 - footer) : cs.length;
    const shown = cs.slice(0, room);
    const withNet = cols >= 120;
    const ccols: Column[] = [
      { header: 'Name', flex: true, max: 40 }, { header: 'State' }, { header: 'CPU' }, { header: 'Mem' },
      ...(withNet ? [{ header: 'Net ↓ / ↑' }] : []), { header: 'Restarts', align: 'right' }, { header: 'Status', flex: true },
    ];
    const rows = shown.map((c) => [
      c.appId ? pc.bold(c.name) : c.name,
      statusColor(c.state),
      `${usageBar(c.cpuPercent, 6, { label: false })} ${padStart(formatPercent(c.cpuPercent), 5)}`,
      `${usageBar(pct(c.memUsed, c.memLimit), 6, { label: false })} ${padStart(formatBytes(c.memUsed), 7)}`,
      ...(withNet ? [c.state === 'running' ? net(c.netRx, c.netTx) : pc.dim('–')] : []),
      c.restartCount > 0 ? pc.yellow(String(c.restartCount)) : pc.dim('0'),
      pc.dim(c.status),
    ]);
    lines.push(...table(ccols, rows, { width: cols, indent: 1 }).split('\n'));
    if (shown.length < cs.length) lines.push(pc.dim(`  … ${cs.length - shown.length} more (enlarge the window)`));
  }

  if (o.watching) {
    lines.push('');
    const state = s.error ? pc.yellow(`● ${truncate(s.error, Math.max(10, cols - 50))}`) : s.live ? pc.green('● live') : pc.dim('○ connecting…');
    const upd = s.updatedAt ? `updated ${timeAgo(new Date(s.updatedAt).toISOString(), now)}` : '';
    lines.push(` ${pc.dim('q quit')}  ${state}  ${pc.dim(upd)}`);
  }
  return lines;
}

/** Append a live point, dedupe by timestamp and keep at most `max` points. */
export function pushPoint(points: MetricPoint[], p: MetricPoint, max = 180): MetricPoint[] {
  const next = points.length && points[points.length - 1].ts === p.ts ? [...points.slice(0, -1), p] : [...points, p];
  return next.length > max ? next.slice(next.length - max) : next;
}
