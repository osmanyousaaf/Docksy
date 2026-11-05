import { z } from 'zod';
import type { Alert, AlertRule, CreateAlertRuleRequest, DiagnoseReport, FleetOverview, ServerMetrics, UptimeCheck } from '@docksy/shared';
import { seg } from '../api.ts';
import { defineTool, UserFacingError } from '../registry.ts';
import { resolveApp, resolveServer, serverNames } from '../resolve.ts';
import { renderDiagnose, renderMetrics, renderOverview, sortFindings } from '../render.ts';
import { ago, downsample, pct, table } from '../format.ts';

const RANGES = ['15m', '1h', '6h', '24h', '7d', '30d'] as const;
const METRICS = ['cpu', 'mem', 'disk', 'load', 'swap', 'server_offline', 'container_down', 'container_restarts', 'deploy_failed', 'uptime_down', 'backup_failed'] as const;

export const getServerMetrics = defineTool({
  name: 'get_server_metrics',
  title: 'Get server metrics',
  description:
    'CPU, memory, disk, swap, load and network for a server over a time range, as sparklines with current/avg/max. Use it to answer "is the server OK?", spot spikes or leaks (steadily rising memory), and check disk headroom. For per-container usage use list_containers.',
  kind: 'read',
  input: {
    serverId: z.string().min(1).describe('Server id, name or host.'),
    range: z.enum(RANGES).optional().describe('Time window (default "1h"). Use 24h/7d for trends and leaks.'),
  },
  async run({ serverId, range }, { api }) {
    const server = await resolveServer(api, serverId);
    const m = await api.get<ServerMetrics>(`/servers/${seg(server.id)}/metrics`, { range: range ?? '1h' });
    const { text, series } = renderMetrics(m, server.name);
    const step = Math.max(1, Math.ceil(m.points.length / 60));
    return {
      text,
      data: {
        serverId: server.id,
        range: m.range,
        stepSec: m.stepSec,
        pointCount: m.points.length,
        summary: Object.fromEntries(series.map((s) => [s.key, s.stats])),
        latest: m.points[m.points.length - 1] ?? null,
        // Downsampled (≤60) for compactness; the full series is available over the HTTP API.
        points: m.points.filter((_, i) => i % step === 0),
        cpuSeries: downsample(m.points.map((p) => p.cpu), 60),
      },
    };
  },
});

export const getFleetOverview = defineTool({
  name: 'get_fleet_overview',
  title: 'Fleet overview',
  description:
    'One-shot health summary of everything: each server with live CPU/memory/disk bars, a CPU trend sparkline, app count and firing alerts, plus totals. The best first call for "how are my servers?" or "is anything wrong?".',
  kind: 'read',
  input: {},
  async run(_a, { api }) {
    const o = await api.get<FleetOverview>('/overview');
    let text = renderOverview(o);
    if (o.totals.firingAlerts > 0) text += '\n\nThere are firing alerts: `list_alerts {"state":"firing"}`, then `diagnose` the affected server.';
    return { text, data: o };
  },
});

export const diagnose = defineTool({
  name: 'diagnose',
  title: 'Diagnose server or app',
  description:
    "Run Docksy's deterministic health check on a server and/or app. It checks CPU/memory pressure and top containers, disk space, swap thrashing, offline agent, restart loops and OOM-kills, failed deploys (with build log tail), recent app log errors, TLS, and failing uptime checks. Returns findings by severity with concrete evidence and suggested fix tool calls. Use it first whenever something is slow, down, or alerting.",
  kind: 'read',
  input: {
    serverId: z.string().optional().describe('Server id, name or host to diagnose.'),
    appId: z.string().optional().describe('App id or name to diagnose (its server is checked too).'),
  },
  async run({ serverId, appId }, { api }) {
    if (!serverId && !appId) throw new UserFacingError('Pass serverId and/or appId. Use get_fleet_overview to see which server needs attention.');
    const [server, app] = await Promise.all([
      serverId ? resolveServer(api, serverId) : Promise.resolve(null),
      appId ? resolveApp(api, appId) : Promise.resolve(null),
    ]);
    const report = await api.get<DiagnoseReport>('/diagnose', { serverId: server?.id, appId: app?.id });
    const sorted = { ...report, findings: sortFindings(report.findings) };
    const nextActions = sorted.findings.filter((f) => f.action).map((f) => ({ ...f.action!, severity: f.severity, reason: f.title }));
    return { text: renderDiagnose(sorted), data: { ...sorted, nextActions } };
  },
});

export const listAlerts = defineTool({
  name: 'list_alerts',
  title: 'List alerts',
  description:
    'List alerts (firing first) with severity, title, value, when they started/resolved and whether acknowledged. Use it to see what is wrong right now (state "firing") or what happened recently.',
  kind: 'read',
  input: {
    state: z.enum(['firing', 'resolved']).optional().describe('Filter by state. Omit for both.'),
    limit: z.number().int().min(1).max(200).optional().describe('Max alerts (default 50).'),
  },
  async run({ state, limit }, { api }) {
    const [{ items }, names] = await Promise.all([api.get<{ items: Alert[] }>('/alerts', { state, limit: limit ?? 50 }), serverNames(api)]);
    const sorted = [...items].sort((a, b) => (a.state === b.state ? 0 : a.state === 'firing' ? -1 : 1));
    const firing = items.filter((a) => a.state === 'firing').length;
    const text = items.length
      ? `## Alerts: ${firing} firing, ${items.length - firing} resolved\n\n${table(
          ['id', 'state', 'severity', 'title', 'server', 'value', 'started', 'resolved', 'acked'],
          sorted.map((a) => [a.id, a.state, a.severity, a.title, a.serverId ? (names.get(a.serverId) ?? a.serverId) : null, a.value, ago(a.startedAt), a.resolvedAt ? ago(a.resolvedAt) : null, a.ackedAt ? 'yes' : null]),
        )}`
      : `No ${state ? `${state} ` : ''}alerts. All quiet.`;
    return { text, data: { items: sorted } };
  },
});

export const listAlertRules = defineTool({
  name: 'list_alert_rules',
  title: 'List alert rules',
  description:
    'List alert rules (defaults like CPU > 90% for 5m, disk > 85%, server offline, deploy failed, plus custom rules) with thresholds, scope and channels. Use before creating a rule to avoid duplicates.',
  kind: 'read',
  input: {},
  async run(_a, { api }) {
    const { items } = await api.get<{ items: AlertRule[] }>('/alert-rules');
    const text = `## Alert rules (${items.length})\n\n${table(
      ['id', 'name', 'condition', 'for', 'severity', 'scope', 'enabled', 'default'],
      items.map((r) => [
        r.id,
        r.name,
        ['cpu', 'mem', 'disk', 'swap'].includes(r.metric) ? `${r.metric} ${r.op} ${r.threshold}%` : ['load', 'container_restarts'].includes(r.metric) ? `${r.metric} ${r.op} ${r.threshold}` : r.metric,
        r.durationSec ? `${r.durationSec}s` : null,
        r.severity,
        r.appId ? `app ${r.appId}` : r.serverId ? `server ${r.serverId}` : 'all',
        r.enabled ? 'yes' : 'no',
        r.isDefault ? 'yes' : null,
      ]),
    )}`;
    return { text, data: { items } };
  },
});

export const createAlertRule = defineTool({
  name: 'create_alert_rule',
  title: 'Create alert rule',
  description:
    'Create an alert rule. Metric rules (cpu, mem, disk, swap: percent; load: absolute; container_restarts: count) fire when the condition holds for durationSec. Event rules (server_offline, container_down, deploy_failed, uptime_down, backup_failed) fire on the event. Notifications go to the given channels (or all enabled channels).',
  kind: 'write',
  input: {
    name: z.string().min(1).describe('Human name, e.g. "API memory high".'),
    metric: z.enum(METRICS).describe('What to watch.'),
    op: z.enum(['>', '<']).optional().describe('Comparison (default ">").'),
    threshold: z.number().optional().describe('Threshold: percent for cpu/mem/disk/swap, absolute for load, count for container_restarts. Ignored for event metrics.'),
    durationSec: z.number().int().min(0).optional().describe('Condition must hold this long before firing (default 300 for cpu/mem/load, else 0).'),
    severity: z.enum(['info', 'warning', 'critical']).optional().describe('Default "warning".'),
    serverId: z.string().optional().describe('Limit to one server (id, name or host). Omit for all servers.'),
    appId: z.string().optional().describe('Limit to one app (id or name).'),
    channelIds: z.array(z.string()).optional().describe('Notification channel ids; empty = all enabled channels.'),
    enabled: z.boolean().optional().describe('Default true.'),
  },
  async run(a, { api }) {
    const [server, app] = await Promise.all([a.serverId ? resolveServer(api, a.serverId) : null, a.appId ? resolveApp(api, a.appId) : null]);
    const body: CreateAlertRuleRequest = {
      name: a.name,
      metric: a.metric,
      op: a.op ?? '>',
      threshold: a.threshold ?? 0,
      durationSec: a.durationSec ?? (['cpu', 'mem', 'load'].includes(a.metric) ? 300 : 0),
      severity: a.severity ?? 'warning',
      serverId: server?.id ?? null,
      appId: app?.id ?? null,
      channelIds: a.channelIds ?? [],
      enabled: a.enabled ?? true,
    };
    const rule = await api.post<AlertRule>('/alert-rules', body);
    return { text: `Created alert rule **${rule.name}** (\`${rule.id}\`): ${rule.metric} ${rule.op} ${rule.threshold}${rule.durationSec ? ` for ${rule.durationSec}s` : ''}, ${rule.severity}.`, data: { rule } };
  },
});

export const ackAlert = defineTool({
  name: 'ack_alert',
  title: 'Acknowledge alert',
  description:
    'Acknowledge a firing alert so the team knows someone is on it (it still resolves automatically when the condition clears). Use after you or the user started fixing the issue.',
  kind: 'write',
  idempotent: true,
  input: { alertId: z.string().min(1).describe('Alert id (from list_alerts).') },
  async run({ alertId }, { api }) {
    const res = await api.post<Alert | { ok: true }>(`/alerts/${seg(alertId)}/ack`);
    return { text: `Acknowledged alert \`${alertId}\`.`, data: { ok: true, alertId, alert: 'id' in res ? res : null } };
  },
});

export const listUptimeChecks = defineTool({
  name: 'list_uptime_checks',
  title: 'List uptime checks',
  description:
    'List HTTP uptime checks with current status (up/down), 24h uptime % and average latency. Use it to see whether sites respond from the outside, and which are on the public status page.',
  kind: 'read',
  input: {},
  async run(_a, { api }) {
    const { items } = await api.get<{ items: UptimeCheck[] }>('/uptime-checks');
    const down = items.filter((c) => c.lastStatus === 'down').length;
    const text = items.length
      ? `## Uptime checks: ${items.length - down} up, ${down} down\n\n${table(
          ['id', 'name', 'url', 'status', 'uptime 24h', 'avg latency', 'every', 'public'],
          items.map((c) => [c.id, c.name, c.url, c.enabled ? c.lastStatus : 'paused', pct(c.uptime24h, 2), c.avgLatencyMs24h === null ? null : `${Math.round(c.avgLatencyMs24h)}ms`, `${c.intervalSec}s`, c.public ? 'yes' : null]),
        )}`
      : 'No uptime checks yet. Apps with a domain get one automatically after a successful deploy; add others with `create_uptime_check`.';
    return { text, data: { items } };
  },
});

export const createUptimeCheck = defineTool({
  name: 'create_uptime_check',
  title: 'Create uptime check',
  description:
    'Monitor a URL from Docksy every intervalSec; if it stops responding (or returns an unexpected status) an "uptime down" alert fires. Optionally show it on the public status page.',
  kind: 'write',
  input: {
    name: z.string().min(1).describe('Display name, e.g. "Website".'),
    url: z.string().url().describe('Full URL to request, e.g. "https://example.com/health".'),
    appId: z.string().optional().describe('Link the check to an app (id or name).'),
    intervalSec: z.number().int().min(30).max(86400).optional().describe('How often to check (default 60, min 30).'),
    timeoutMs: z.number().int().min(500).max(60000).optional().describe('Request timeout (default 10000).'),
    expectedStatus: z.number().int().min(0).max(599).optional().describe('Expected HTTP status; 0 (default) accepts any 2xx/3xx.'),
    public: z.boolean().optional().describe('Show on the public status page (default false).'),
  },
  async run(a, { api }) {
    const app = a.appId ? await resolveApp(api, a.appId) : null;
    const check = await api.post<UptimeCheck>('/uptime-checks', {
      name: a.name,
      url: a.url,
      appId: app?.id ?? null,
      intervalSec: a.intervalSec ?? 60,
      timeoutMs: a.timeoutMs ?? 10_000,
      expectedStatus: a.expectedStatus ?? 0,
      public: a.public ?? false,
      enabled: true,
    });
    return { text: `Created uptime check **${check.name}** (\`${check.id}\`) for ${check.url}, every ${check.intervalSec}s.`, data: { check } };
  },
});

export const monitoringTools = [
  getServerMetrics,
  getFleetOverview,
  diagnose,
  listAlerts,
  listAlertRules,
  createAlertRule,
  ackAlert,
  listUptimeChecks,
  createUptimeCheck,
];
