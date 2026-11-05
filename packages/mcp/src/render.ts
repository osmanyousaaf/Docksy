/** Markdown renderers for Docksy entities. Pure functions: easy to test, reused by tools and resources. */
import type {
  App,
  ContainerInfo,
  Deployment,
  DiagnoseFinding,
  DiagnoseReport,
  FleetOverview,
  MetricPoint,
  Server,
  ServerMetrics,
  Severity,
} from '@docksy/shared';
import { ago, bar, bytes, duration, inlineJson, num, pct, rate, ratio, sparkline, stats, table, type Stats } from './format.ts';

export function serverRow(s: Server): unknown[] {
  return [
    s.name,
    s.id,
    `${s.host}${s.port && s.port !== 22 ? `:${s.port}` : ''}`,
    s.status,
    s.liveness,
    s.os,
    s.cpuCores,
    bytes(s.memTotal),
    ago(s.lastSeenAt),
  ];
}

export const SERVER_HEADERS = ['name', 'id', 'host', 'status', 'agent', 'os', 'cores', 'memory', 'last report'];

export function renderServer(s: Server, apps: App[] = []): string {
  const lines = [
    `## Server ${s.name}`,
    `- id: \`${s.id}\``,
    `- host: ${s.sshUser}@${s.host}:${s.port}`,
    `- status: **${s.status}**, agent ${s.liveness} (last report ${ago(s.lastSeenAt)})`,
    `- system: ${s.os ?? 'unknown OS'} ${s.arch ?? ''}, ${s.cpuCores ?? '?'} cores, ${bytes(s.memTotal)} RAM, ${bytes(s.diskTotal)} disk`,
    `- agent version: ${s.agentVersion ?? '—'}`,
  ];
  if (s.status === 'new') lines.push('', 'Not provisioned yet: run `provision_server` to install Docker, the proxy and the metrics agent.');
  if (s.status === 'error') lines.push('', 'Provisioning failed last time: check the log with `provision_server` (wait: true) after fixing SSH/sudo access.');
  if (s.liveness === 'offline') lines.push('', 'The metrics agent has stopped reporting. Run `diagnose` for this server.');
  if (apps.length) {
    lines.push('', `### Apps on this server (${apps.length})`, table(['name', 'status', 'kind', 'domain'], apps.map((a) => [a.name, a.status, a.kind, a.domains[0]])));
  }
  return lines.join('\n');
}

export function appRow(a: App, serverName?: string): unknown[] {
  return [a.name, a.id, a.status, a.kind, serverName ?? a.serverId, a.template ?? (a.sourceType === 'image' ? a.image : a.repoUrl), a.domains[0]];
}
export const APP_HEADERS = ['name', 'id', 'status', 'kind', 'server', 'source', 'domain'];

export function renderApp(a: App, deployments: Deployment[] = [], serverName?: string): string {
  const source =
    a.sourceType === 'image'
      ? `image \`${a.image}\``
      : `git ${a.repoUrl ?? '—'} @ ${a.branch ?? 'main'} (build: ${a.buildType}${a.buildType === 'dockerfile' ? `, ${a.dockerfilePath}` : ''}${a.buildType === 'compose' ? `, ${a.composePath}` : ''})`;
  const lines = [
    `## App ${a.name}`,
    `- id: \`${a.id}\``,
    `- status: **${a.status}**`,
    `- kind: ${a.kind}${a.template ? ` (template ${a.template})` : ''}`,
    `- server: ${serverName ? `${serverName} (\`${a.serverId}\`)` : `\`${a.serverId}\``}`,
    `- source: ${source}`,
    `- port: ${a.port ?? '—'}, healthcheck: ${a.healthcheckPath ?? 'container running'}`,
    `- domains: ${a.domains.length ? a.domains.map((d) => `https://${d}`).join(', ') : '—'}`,
    `- auto deploy on push: ${a.autoDeploy ? 'on' : 'off'}${a.sourceType === 'git' ? ` (GitHub webhook: ${a.webhookUrl})` : ''}`,
  ];
  if (a.volumes.length) lines.push(`- volumes: ${a.volumes.map((v) => `${v.name}:${v.mountPath}`).join(', ')}`);
  if (deployments.length) lines.push('', '### Recent deployments', deploymentsTable(deployments, a.currentDeploymentId));
  return lines.join('\n');
}

export function deploymentsTable(ds: Deployment[], currentId?: string | null): string {
  return table(
    ['id', 'status', 'trigger', 'commit', 'image', 'started', 'took', 'error'],
    ds.map((d) => [
      `${d.id}${d.id === currentId ? ' (current)' : ''}`,
      d.status,
      d.trigger,
      d.commitSha ? `${d.commitSha.slice(0, 7)} ${(d.commitMessage ?? '').split('\n')[0].slice(0, 50)}` : null,
      d.imageTag,
      ago(d.startedAt ?? d.createdAt),
      d.startedAt ? duration(d.startedAt, d.finishedAt) : null,
      d.error ? d.error.slice(0, 80) : null,
    ]),
  );
}

export function containersTable(cs: ContainerInfo[], appNames: Map<string, string> = new Map()): string {
  return table(
    ['container', 'app', 'state', 'status', 'cpu', 'memory', 'restarts', 'image'],
    cs.map((c) => [
      c.name,
      c.appId ? (appNames.get(c.appId) ?? c.appId) : null,
      c.state,
      c.status,
      pct(c.cpuPercent),
      `${bytes(c.memUsed)}${c.memLimit ? ` / ${bytes(c.memLimit)}` : ''}`,
      c.restartCount,
      c.image,
    ]),
  );
}

export interface SeriesSummary {
  key: string;
  label: string;
  unit: 'pct' | 'bytes' | 'rate' | 'num';
  stats: Stats;
  spark: string;
}

/** Per-metric current/avg/max plus a sparkline for each series. */
export function summarizeMetrics(points: MetricPoint[], width = 40): SeriesSummary[] {
  const series: { key: string; label: string; unit: SeriesSummary['unit']; values: number[]; absMax?: number }[] = [
    { key: 'cpu', label: 'CPU', unit: 'pct', values: points.map((p) => p.cpu), absMax: 100 },
    { key: 'mem', label: 'Memory', unit: 'pct', values: points.map((p) => ratio(p.memUsed, p.memTotal) ?? NaN), absMax: 100 },
    { key: 'disk', label: 'Disk', unit: 'pct', values: points.map((p) => ratio(p.diskUsed, p.diskTotal) ?? NaN), absMax: 100 },
    { key: 'swap', label: 'Swap used', unit: 'bytes', values: points.map((p) => p.swapUsed) },
    { key: 'load1', label: 'Load (1m)', unit: 'num', values: points.map((p) => p.load1) },
    { key: 'netRx', label: 'Net in', unit: 'rate', values: points.map((p) => p.netRx) },
    { key: 'netTx', label: 'Net out', unit: 'rate', values: points.map((p) => p.netTx) },
  ];
  return series.map((s) => ({
    key: s.key,
    label: s.label,
    unit: s.unit,
    stats: stats(s.values),
    spark: sparkline(s.values, { width, max: s.absMax }),
  }));
}

export function fmtUnit(v: number | null, unit: SeriesSummary['unit']): string {
  if (v === null) return '—';
  switch (unit) {
    case 'pct': return pct(v);
    case 'bytes': return bytes(v);
    case 'rate': return rate(v);
    default: return num(v);
  }
}

export function renderMetrics(m: ServerMetrics, serverName: string, width = 40): { text: string; series: SeriesSummary[] } {
  const series = summarizeMetrics(m.points, width);
  if (m.points.length === 0) {
    return {
      series,
      text: `## Metrics: ${serverName} (${m.range})\n\nNo metrics in this range yet. If the server was just provisioned, wait ~30s for the agent's first reports; if it's old, the agent may be offline (try \`diagnose\`).`,
    };
  }
  const last = m.points[m.points.length - 1];
  const labelW = Math.max(...series.map((s) => s.label.length));
  const lines = series.map((s) => {
    const st = s.stats;
    return `${s.label.padEnd(labelW)}  ${s.spark}  now ${fmtUnit(st.current, s.unit).padStart(9)}  avg ${fmtUnit(st.avg, s.unit).padStart(9)}  max ${fmtUnit(st.max, s.unit).padStart(9)}`;
  });
  const text = [
    `## Metrics: ${serverName} (last ${m.range}, ${m.points.length} points @ ${m.stepSec}s, latest ${ago(last.ts)})`,
    '```',
    ...lines,
    '```',
    `Memory ${bytes(last.memUsed)} / ${bytes(last.memTotal)} · Disk ${bytes(last.diskUsed)} / ${bytes(last.diskTotal)}`,
  ].join('\n');
  return { text, series };
}

export function renderOverview(o: FleetOverview): string {
  const t = o.totals;
  const head = `## Fleet: ${t.servers} server${t.servers === 1 ? '' : 's'} (${t.online} online) · ${t.apps} apps · ${t.runningContainers} running containers · ${t.firingAlerts} firing alert${t.firingAlerts === 1 ? '' : 's'}`;
  if (o.servers.length === 0) return `${head}\n\nNo servers yet. Add one with \`create_server\`, then \`provision_server\`.`;
  const rows = o.servers.map(({ server: s, latest, spark, appsCount, firingAlerts }) => {
    const mem = latest ? ratio(latest.memUsed, latest.memTotal) : null;
    const disk = latest ? ratio(latest.diskUsed, latest.diskTotal) : null;
    return [
      s.name,
      `${s.status}/${s.liveness}`,
      latest ? `${bar(latest.cpu, 6)} ${pct(latest.cpu, 0)}` : null,
      sparkline(spark, { width: 30, max: 100 }) || null,
      mem === null ? null : `${bar(mem, 6)} ${pct(mem, 0)}`,
      disk === null ? null : `${bar(disk, 6)} ${pct(disk, 0)}`,
      appsCount,
      firingAlerts || null,
    ];
  });
  return `${head}\n\n${table(['server', 'status', 'cpu', 'cpu trend', 'mem', 'disk', 'apps', 'alerts'], rows)}`;
}

const SEVERITY_ORDER: Severity[] = ['critical', 'warning', 'info'];

export function sortFindings(fs: DiagnoseFinding[]): DiagnoseFinding[] {
  return [...fs].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

export function renderDiagnose(r: DiagnoseReport): string {
  const counts = SEVERITY_ORDER.map((s) => [s, r.findings.filter((f) => f.severity === s).length] as const).filter(([, n]) => n > 0);
  const scope = [r.context.server ? `server ${r.context.server.name}` : r.scope.serverId, r.scope.appId ? `app ${r.scope.appId}` : null]
    .filter(Boolean)
    .join(', ');
  const out: string[] = [
    `# Diagnosis${scope ? `: ${scope}` : ''}`,
    `**${r.healthy ? 'Healthy' : 'Problems found'}**: ${r.summary}`,
  ];
  if (counts.length) out.push(counts.map(([s, n]) => `${n} ${s}`).join(' · '));

  let n = 0;
  const actions: { tool: string; args: Record<string, unknown>; why: string }[] = [];
  for (const sev of SEVERITY_ORDER) {
    const group = r.findings.filter((f) => f.severity === sev);
    if (!group.length) continue;
    out.push('', `## ${sev.toUpperCase()}`);
    for (const f of group) {
      n++;
      out.push('', `### ${n}. ${f.title}`);
      if (f.detail) out.push(f.detail);
      if (f.evidence?.length) out.push('Evidence:', ...f.evidence.slice(0, 8).map((e) => `- ${e}`));
      if (f.suggestion) out.push(`Suggestion: ${f.suggestion}`);
      if (f.action) {
        out.push(`Fix: \`${f.action.tool} ${inlineJson(f.action.args)}\``);
        actions.push({ ...f.action, why: f.title });
      }
    }
  }

  const c = r.context;
  const ctx: string[] = [];
  if (c.trend1h) ctx.push(`- last hour: CPU avg ${pct(c.trend1h.cpuAvg)} / max ${pct(c.trend1h.cpuMax)}, memory avg ${pct(c.trend1h.memAvgPct)} / max ${pct(c.trend1h.memMaxPct)}`);
  if (c.latest) ctx.push(`- now: CPU ${pct(c.latest.cpu)}, memory ${pct(ratio(c.latest.memUsed, c.latest.memTotal))}, disk ${pct(ratio(c.latest.diskUsed, c.latest.diskTotal))}, load ${num(c.latest.load1)}`);
  if (c.firingAlerts.length) ctx.push(`- firing alerts: ${c.firingAlerts.map((a) => `${a.title} (${a.severity}, since ${ago(a.startedAt)})`).join('; ')}`);
  if (c.recentDeployments.length) {
    const d = c.recentDeployments[0];
    ctx.push(`- last deployment: ${d.status} ${ago(d.finishedAt ?? d.createdAt)}${d.error ? ` (${d.error.slice(0, 120)})` : ''}`);
  }
  const bad = c.containers.filter((x) => x.state !== 'running' || x.restartCount > 0);
  if (bad.length) ctx.push(`- containers needing attention: ${bad.map((x) => `${x.name} ${x.state} (${x.restartCount} restarts)`).join(', ')}`);
  if (ctx.length) out.push('', '## Context', ...ctx);

  out.push('', '## Suggested next steps');
  if (actions.length) {
    actions.forEach((a, i) => out.push(`${i + 1}. \`${a.tool} ${inlineJson(a.args)}\` (for: ${a.why})`));
    out.push('Ask the user before running write actions.');
  } else if (r.healthy) {
    out.push('Nothing to fix. `get_server_metrics` with a longer range shows trends.');
  } else {
    out.push('Dig in with `get_server_metrics`, `list_containers`, `get_app_logs` or `get_deployment_logs`, then propose a fix to the user.');
  }
  return out.join('\n');
}
