/** status, metrics, diagnose, alerts */
import pc from 'picocolors';
import type { Alert, DiagnoseReport, MetricsRange, Server } from '@crovenai/docksy-client';
import type { Ctx } from '../context.ts';
import { CliError } from '../context.ts';
import { brand, severityBadge, statusColor, sym, table, timeAgo, type Column } from '../format.ts';
import { resolveServer, resolveTarget } from '../resolve.ts';
import { pause, runLive } from '../tui.ts';
import { pushPoint, renderFleet, renderMetrics, type MetricsState } from '../views.ts';

export const RANGES: MetricsRange[] = ['15m', '1h', '6h', '24h', '7d', '30d'];

export function parseRange(v: string): MetricsRange {
  if ((RANGES as string[]).includes(v)) return v as MetricsRange;
  throw new CliError(`Unknown range "${v}".`, { hint: `Use one of: ${RANGES.join(', ')}` });
}

const json = (ctx: Ctx, data: unknown) => ctx.print(JSON.stringify(data, null, 2));

// ───────────────────────────── status ─────────────────────────────

export async function statusCmd(ctx: Ctx, o: { json?: boolean; watch?: boolean }): Promise<void> {
  const client = ctx.client();
  if (o.json) return json(ctx, await client.getFleetOverview());
  if (!o.watch || !ctx.stdout.isTTY) {
    const ov = await client.getFleetOverview();
    for (const l of renderFleet(ov, { width: ctx.width(), url: client.baseUrl })) ctx.print(l);
    return;
  }
  let ov = await client.getFleetOverview();
  let error: string | null = null;
  await runLive(ctx, {
    render: ({ cols }) => {
      const lines = renderFleet(ov, { width: cols, url: client.baseUrl, watching: true });
      if (error) lines.push(pc.yellow(` ● ${error}`));
      return lines;
    },
    async run(redraw, signal) {
      while (!signal.aborted) {
        await pause(5000, signal);
        if (signal.aborted) break;
        try { ov = await client.getFleetOverview({ signal }); error = null; } catch (e) { if (!signal.aborted) error = `refresh failed: ${(e as Error).message}`; }
        redraw();
      }
    },
  });
}

// ───────────────────────────── metrics ─────────────────────────────

export async function metricsCmd(ctx: Ctx, ref: string, o: { json?: boolean; watch?: boolean; range?: string }): Promise<void> {
  const client = ctx.client();
  const range = parseRange(o.range ?? (o.watch ? '15m' : '1h'));
  const server = await resolveServer(client, ref);
  const [metrics, containers] = await Promise.all([client.getServerMetrics(server.id, { range }), client.listContainers(server.id)]);
  if (o.json) return json(ctx, { server, metrics, containers });

  const state: MetricsState = { server, points: metrics.points, perCore: [], containers, rangeLabel: `last ${range}`, updatedAt: Date.now() };
  if (!o.watch || !ctx.stdout.isTTY) {
    for (const l of renderMetrics(state, { cols: ctx.width() })) ctx.print(l);
    return;
  }
  state.rangeLabel = undefined;
  await runLive(ctx, {
    render: ({ cols, rows }) => renderMetrics(state, { cols, rows, watching: true }),
    run: (redraw, signal) => followLiveMetrics(ctx, server, state, redraw, signal),
  });
}

async function followLiveMetrics(ctx: Ctx, server: Server, state: MetricsState, redraw: () => void, signal: AbortSignal): Promise<void> {
  const client = ctx.client();
  let backoff = 1000;
  while (!signal.aborted) {
    try {
      for await (const ev of client.streamServerMetrics(server.id, { signal })) {
        if (ev.event !== 'metrics') continue;
        const d = ev.data;
        state.points = pushPoint(state.points, d.point);
        state.perCore = d.perCore ?? [];
        state.containers = d.containers ?? state.containers;
        state.live = true;
        state.error = null;
        state.updatedAt = Date.now();
        backoff = 1000;
        redraw();
      }
      if (signal.aborted) return;
      state.live = false;
      state.error = 'stream ended, reconnecting…';
    } catch (e) {
      if (signal.aborted) return;
      state.live = false;
      state.error = `${(e as Error).message}, retrying in ${Math.round(backoff / 1000)}s`;
    }
    redraw();
    await pause(backoff, signal);
    backoff = Math.min(backoff * 2, 15_000);
    // Refresh server facts (liveness) between reconnects.
    try { state.server = await client.getServer(server.id, { signal }); } catch { /* keep the old one */ }
  }
}

// ───────────────────────────── diagnose ─────────────────────────────

export async function diagnoseCmd(ctx: Ctx, ref: string | undefined, o: { json?: boolean }): Promise<void> {
  const client = ctx.client();
  let q: { serverId?: string; appId?: string } = {};
  let label = 'whole fleet';
  if (ref) {
    const t = await resolveTarget(client, ref);
    if (t.kind === 'server') { q = { serverId: t.server.id }; label = `server ${t.server.name}`; }
    else { q = { appId: t.app.id }; label = `app ${t.app.name}`; }
  }
  const report = await client.diagnose(q);
  if (o.json) return json(ctx, report);
  for (const l of renderDiagnose(report, label, ref)) ctx.print(l);
}

export function renderDiagnose(r: DiagnoseReport, label: string, ref?: string): string[] {
  const lines: string[] = [];
  const n = r.findings.length;
  const verdict = r.healthy ? pc.green('✔ healthy') : pc.red(`✖ ${n} issue${n === 1 ? '' : 's'} found`);
  lines.push(` ${brand('docksy diagnose')}  ${pc.dim(label)}  ${verdict}`);
  if (r.summary) lines.push(`  ${r.summary}`);
  const order = { critical: 0, warning: 1, info: 2 } as const;
  const findings = [...r.findings].sort((a, b) => order[a.severity] - order[b.severity]);
  for (const f of findings) {
    lines.push('');
    lines.push(`  ${severityBadge(f.severity)}  ${pc.bold(f.title)}`);
    if (f.detail) lines.push(`     ${f.detail}`);
    for (const ev of f.evidence.slice(0, 8)) lines.push(`     ${pc.dim('│')} ${pc.dim(ev)}`);
    if (f.evidence.length > 8) lines.push(`     ${pc.dim(`│ … ${f.evidence.length - 8} more`)}`);
    if (f.suggestion) lines.push(`     ${pc.cyan('→')} ${f.suggestion}`);
    if (f.action) lines.push(`     ${pc.magenta('⚙')} ${pc.dim('Claude can run:')} ${pc.magenta(f.action.tool)} ${pc.dim(JSON.stringify(f.action.args))}`);
  }
  const fa = r.context?.firingAlerts ?? [];
  if (fa.length) {
    lines.push('');
    lines.push(`  ${pc.bold('Firing alerts')}`);
    for (const a of fa) lines.push(`   ${severityBadge(a.severity)}  ${a.title} ${pc.dim(`· since ${timeAgo(a.startedAt)}`)}`);
  }
  lines.push('');
  lines.push(pc.dim(`  Let Claude dig in: /docksy:diagnose${ref ? ` ${ref}` : ''}  ·  generated ${timeAgo(r.generatedAt)}`));
  return lines;
}

// ───────────────────────────── alerts ─────────────────────────────

export async function alertsCmd(ctx: Ctx, o: { json?: boolean; all?: boolean; limit?: string }): Promise<void> {
  const client = ctx.client();
  const limit = o.limit ? Number(o.limit) : 50;
  if (!Number.isInteger(limit) || limit <= 0) throw new CliError('--limit must be a positive number.');
  const [alerts, servers] = await Promise.all([
    client.listAlerts({ state: o.all ? undefined : 'firing', limit }),
    client.listServers().catch(() => [] as Server[]),
  ]);
  if (o.json) return json(ctx, alerts);
  if (alerts.length === 0) {
    ctx.print(o.all ? ' No alerts yet.' : ` ${sym.ok} No firing alerts. All quiet.`);
    if (!o.all) ctx.print(pc.dim('   History: docksy alerts --all'));
    return;
  }
  ctx.print(renderAlerts(alerts, servers, ctx.width()));
  if (!o.all) ctx.print(pc.dim(`\n Acknowledge: docksy alerts ack <id> · History: docksy alerts --all`));
}

export function renderAlerts(alerts: Alert[], servers: Server[], width: number): string {
  const name = new Map(servers.map((s) => [s.id, s.name]));
  const cols: Column[] = [
    { header: 'Id' }, { header: 'Severity' }, { header: 'State' }, { header: 'Alert', flex: true },
    { header: 'Server' }, { header: 'Value', align: 'right' }, { header: 'Since' },
  ];
  const rows = alerts.map((a) => [
    pc.dim(a.id),
    statusColor(a.severity),
    statusColor(a.state) + (a.ackedAt ? pc.dim(' (acked)') : ''),
    a.title,
    a.serverId ? (name.get(a.serverId) ?? a.serverId) : pc.dim('–'),
    a.value == null ? pc.dim('–') : Number.isInteger(a.value) ? String(a.value) : a.value.toFixed(1),
    a.state === 'resolved' && a.resolvedAt ? pc.dim(`resolved ${timeAgo(a.resolvedAt)}`) : timeAgo(a.startedAt),
  ]);
  return table(cols, rows, { width, indent: 1 });
}

export async function ackCmd(ctx: Ctx, id: string): Promise<void> {
  const a = await ctx.client().ackAlert(id);
  ctx.print(` ${sym.ok} Acknowledged ${pc.bold(a?.title ?? id)}.`);
}
