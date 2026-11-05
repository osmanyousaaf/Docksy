import { connect } from 'node:tls';
import type { Alert, App, ContainerInfo, Deployment, DeploymentStatus, DeploymentTrigger, DiagnoseReport, MetricPoint, Server, Severity } from '@docksy/shared';
import { db, iso, isoReq, json, type Row } from '../../db/index.ts';
import { exec as sshExec, q, type ExecOptions, type ExecResult } from '../../lib/ssh.ts';
import { toServer, getServerRow, listServers } from '../../core/servers/model.ts';
import { toApp, getAppRow, defaultDomain } from '../../core/apps/model.ts';
import { toUptimeCheck, lastResultRow, loadCheckState } from '../uptime/model.ts';
import { computeTrend, runRules, isHealthy, summarize } from './rules.ts';
import type { AppBrief, DiagnoseContext, DockerDfRow, InspectInfo, TlsInfo, UptimeBrief } from './types.ts';

/**
 * Context gathering for diagnose: DB snapshot + (optionally) one SSH round-trip for
 * `docker inspect`, `docker system df` and `docker logs --tail 100`, plus a TLS probe for the app's domain.
 * SSH and TLS failures degrade gracefully: the report is still produced from DB data.
 */

export interface DiagnoseDeps {
  exec: (serverId: string, command: string, opts?: ExecOptions) => Promise<ExecResult>;
  tlsProbe: (host: string) => Promise<TlsInfo>;
  now: () => number;
  /** SSH budget (spec: 10s) */
  sshTimeoutMs: number;
}

const SSH_TIMEOUT_MS = 10_000;
const DAY_MS = 86_400_000;

const defaultDeps: DiagnoseDeps = { exec: sshExec, tlsProbe: probeTls, now: () => Date.now(), sshTimeoutMs: SSH_TIMEOUT_MS };
let deps: DiagnoseDeps = { ...defaultDeps };

/** Test hook: override SSH/TLS/clock. Returns a function restoring the defaults. */
export function setDiagnoseDeps(p: Partial<DiagnoseDeps>): () => void {
  deps = { ...deps, ...p };
  return () => { deps = { ...defaultDeps }; };
}

// ───────────────────────────── mappers (local, read-only) ─────────────────────────────

export const toMetricPoint = (r: Row): MetricPoint => ({
  ts: isoReq(r.ts), cpu: Number(r.cpu), load1: Number(r.load1), load5: Number(r.load5 ?? 0), load15: Number(r.load15 ?? 0), memUsed: Number(r.mem_used), memTotal: Number(r.mem_total),
  swapUsed: Number(r.swap_used), diskUsed: Number(r.disk_used), diskTotal: Number(r.disk_total), netRx: Number(r.net_rx), netTx: Number(r.net_tx),
});

export const toContainerInfo = (r: Row): ContainerInfo => {
  const labels = json<Record<string, string>>(r.labels, {});
  return {
    id: r.container_id, name: r.name, image: r.image, state: r.state, status: r.status, restartCount: Number(r.restart_count),
    startedAt: r.started_at ?? null, cpuPercent: Number(r.cpu), memUsed: Number(r.mem_used), memLimit: Number(r.mem_limit),
    netRx: Number(r.net_rx), netTx: Number(r.net_tx), labels, serverId: r.server_id, appId: r.app_id ?? labels['docksy.app'] ?? null,
    updatedAt: isoReq(r.updated_at),
  };
};

export const toDeployment = (r: Row): Deployment => ({
  id: r.id, appId: r.app_id, status: r.status as DeploymentStatus, trigger: r.trigger as DeploymentTrigger,
  commitSha: r.commit_sha ?? null, commitMessage: r.commit_message ?? null, imageTag: r.image_tag ?? null, error: r.error ?? null,
  startedAt: iso(r.started_at), finishedAt: iso(r.finished_at), createdAt: isoReq(r.created_at),
});

export const toAlert = (r: Row): Alert => ({
  id: r.id, ruleId: r.rule_id ?? null, serverId: r.server_id ?? null, appId: r.app_id ?? null, state: r.state, severity: r.severity as Severity,
  title: r.title, message: r.message, value: r.value ?? null, startedAt: isoReq(r.started_at), resolvedAt: iso(r.resolved_at), ackedAt: iso(r.acked_at),
});

// ───────────────────────────── SSH: one command, parsed into sections ─────────────────────────────

const INSPECT_TPL = '{"id":{{json .Id}},"name":{{json .Name}},"status":{{json .State.Status}},"oom":{{.State.OOMKilled}},'
  + '"exitCode":{{.State.ExitCode}},"restartCount":{{.RestartCount}},"startedAt":{{json .State.StartedAt}},'
  + '"finishedAt":{{json .State.FinishedAt}},"error":{{json .State.Error}},"health":{{json .State.Health}},'
  + '"memLimit":{{.HostConfig.Memory}},"labels":{{json .Config.Labels}}}';

/** Build the shell command run over SSH. `appId` adds the app's container logs. */
export function buildSshCommand(appId: string | null): string {
  const parts = [
    `echo '@@inspect'`,
    `ids=$(docker ps -aq 2>/dev/null | head -n 50); if [ -n "$ids" ]; then docker inspect --format ${q(INSPECT_TPL)} $ids 2>/dev/null; fi`,
    `echo '@@df'`,
    `docker system df --format ${q('{{json .}}')} 2>/dev/null`,
  ];
  if (appId) {
    const f = q(`label=docksy.app=${appId}`);
    parts.push(
      `echo '@@logs'`,
      `c=$(docker ps -q --filter ${f} | head -n1); [ -z "$c" ] && c=$(docker ps -aq --filter ${f} | head -n1); `
        + `if [ -n "$c" ]; then echo "@@container $(docker inspect --format '{{.Name}}' "$c" 2>/dev/null)"; docker logs --tail 100 --timestamps "$c" 2>&1; fi`,
    );
  }
  parts.push(`echo '@@end'`);
  return parts.join('\n');
}

const parseDate = (s: unknown): string | null => {
  if (typeof s !== 'string' || !s || s.startsWith('0001-01-01')) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

export function parseInspectLine(line: string): InspectInfo | null {
  let o: any;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o.id !== 'string') return null;
  const health = o.health && typeof o.health === 'object' ? o.health : null;
  const log: any[] = Array.isArray(health?.Log) ? health.Log : [];
  const lastOut = log.length ? String(log[log.length - 1]?.Output ?? '').trim().slice(0, 300) : '';
  return {
    id: o.id.slice(0, 12),
    name: String(o.name ?? '').replace(/^\//, ''),
    status: String(o.status ?? 'unknown'),
    oomKilled: o.oom === true,
    exitCode: Number(o.exitCode) || 0,
    restartCount: Number(o.restartCount) || 0,
    startedAt: parseDate(o.startedAt),
    finishedAt: parseDate(o.finishedAt),
    error: o.error ? String(o.error).slice(0, 300) : null,
    health: health?.Status ? String(health.Status) : null,
    healthFailingStreak: Number(health?.FailingStreak) || 0,
    healthLastOutput: lastOut || null,
    memLimit: Number(o.memLimit) || 0,
    labels: o.labels && typeof o.labels === 'object' ? o.labels : {},
  };
}

export interface SshSections { inspect: InspectInfo[]; dockerDf: DockerDfRow[]; logs: string[]; logsContainer: string | null; complete: boolean }

/** Parse the marker-delimited output of buildSshCommand. Pure. */
export function parseSshOutput(stdout: string): SshSections {
  const lines = stdout.split(/\r?\n/);
  const out: SshSections = { inspect: [], dockerDf: [], logs: [], logsContainer: null, complete: false };
  let section: 'none' | 'inspect' | 'df' | 'logs' = 'none';
  let endIdx = -1;
  for (let k = lines.length - 1; k >= 0; k--) if (lines[k]!.trim() === '@@end') { endIdx = k; break; }
  out.complete = endIdx >= 0;
  const stop = endIdx >= 0 ? endIdx : lines.length;
  for (let k = 0; k < stop; k++) {
    const line = lines[k]!;
    if (section !== 'logs') {
      const t = line.trim();
      if (t === '@@inspect') { section = 'inspect'; continue; }
      if (t === '@@df') { section = 'df'; continue; }
      if (t === '@@logs') { section = 'logs'; continue; }
    } else if (out.logsContainer == null && out.logs.length === 0 && line.startsWith('@@container ')) {
      out.logsContainer = line.slice(12).trim().replace(/^\//, '') || null;
      continue;
    }
    if (section === 'inspect') {
      const i = parseInspectLine(line.trim());
      if (i) out.inspect.push(i);
    } else if (section === 'df') {
      try {
        const o = JSON.parse(line.trim());
        if (o && o.Type) out.dockerDf.push({ type: String(o.Type), totalCount: String(o.TotalCount ?? ''), size: String(o.Size ?? ''), reclaimable: String(o.Reclaimable ?? '') });
      } catch { /* skip non-JSON */ }
    } else if (section === 'logs') {
      if (line.length) out.logs.push(line.slice(0, 500));
    }
  }
  out.logs = out.logs.slice(-100);
  return out;
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms); })]);
  } finally {
    if (t) clearTimeout(t);
  }
}

async function collectSsh(serverId: string, appId: string | null): Promise<{ sections: SshSections | null; error: string | null }> {
  try {
    const r = await withTimeout(deps.exec(serverId, buildSshCommand(appId), { timeoutMs: deps.sshTimeoutMs }), deps.sshTimeoutMs + 1000, 'SSH');
    const sections = parseSshOutput(r.stdout ?? '');
    if (!r.stdout?.includes('@@inspect')) return { sections: null, error: (r.stderr || `exit code ${r.code}`).trim().slice(0, 300) };
    return { sections, error: sections.complete ? null : 'SSH output was cut off (timeout?)' };
  } catch (e) {
    return { sections: null, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}

// ───────────────────────────── TLS probe ─────────────────────────────

/** Connect to host:443 and read the certificate. Never throws. */
export function probeTls(host: string, port = 443, timeoutMs = 5000): Promise<TlsInfo> {
  return new Promise((resolve) => {
    const base: TlsInfo = { host, reachable: false, ok: false, validTo: null, daysLeft: null, issuer: null, error: null, errorCode: null };
    let done = false;
    let sock: ReturnType<typeof connect> | null = null;
    const finish = (info: TlsInfo) => {
      if (done) return;
      done = true;
      try { sock?.destroy(); } catch { /* ignore */ }
      resolve(info);
    };
    try {
      sock = connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
        const cert = sock!.getPeerCertificate();
        const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
        const validMs = validTo && Number.isFinite(validTo.getTime()) ? validTo.getTime() : null;
        const authErr = sock!.authorizationError ? String(sock!.authorizationError) : null;
        const issuer = cert?.issuer ? String((cert.issuer as any).O ?? (cert.issuer as any).CN ?? '') || null : null;
        finish({
          ...base, reachable: true, ok: sock!.authorized, issuer,
          validTo: validMs ? new Date(validMs).toISOString() : null,
          daysLeft: validMs ? Math.floor((validMs - Date.now()) / DAY_MS) : null,
          error: authErr, errorCode: authErr,
        });
      });
      sock.on('timeout', () => finish({ ...base, error: `Timed out after ${timeoutMs}ms`, errorCode: 'ETIMEDOUT' }));
      sock.on('error', (e: NodeJS.ErrnoException) => finish({ ...base, error: e.message, errorCode: e.code ?? null }));
    } catch (e) {
      finish({ ...base, error: String((e as Error)?.message ?? e), errorCode: null });
    }
  });
}

// ───────────────────────────── DB context ─────────────────────────────

function latestPoint(serverId: string): MetricPoint | null {
  const r = (db.prepare('SELECT * FROM metrics WHERE server_id = ? AND res = 0 ORDER BY ts DESC LIMIT 1').get(serverId)
    ?? db.prepare('SELECT * FROM metrics WHERE server_id = ? ORDER BY ts DESC LIMIT 1').get(serverId)) as Row | undefined;
  return r ? toMetricPoint(r) : null;
}

function points1h(serverId: string, nowMs: number): MetricPoint[] {
  const since = nowMs - 3_600_000;
  let rows = db.prepare('SELECT * FROM metrics WHERE server_id = ? AND res = 0 AND ts >= ? ORDER BY ts').all(serverId, since) as Row[];
  if (!rows.length) rows = db.prepare('SELECT * FROM metrics WHERE server_id = ? AND res = 60 AND ts >= ? ORDER BY ts').all(serverId, since) as Row[];
  return rows.map(toMetricPoint);
}

function appBrief(r: Row): AppBrief {
  const last = db.prepare(`SELECT * FROM deployments WHERE app_id = ? AND status IN ('succeeded','failed','cancelled') ORDER BY created_at DESC LIMIT 1`).get(r.id) as Row | undefined;
  const lastDeploy = last ? toDeployment(last) : null;
  let tail: string[] = [];
  if (lastDeploy?.status === 'failed') {
    tail = (db.prepare('SELECT line FROM deployment_logs WHERE deployment_id = ? ORDER BY id DESC LIMIT 15').all(lastDeploy.id) as Row[])
      .map((x) => String(x.line).slice(0, 300)).reverse();
  }
  const rb = db.prepare(
    `SELECT * FROM deployments WHERE app_id = ? AND status = 'succeeded' AND image_tag IS NOT NULL AND id != ? ORDER BY created_at DESC LIMIT 1`,
  ).get(r.id, r.current_deployment_id ?? '') as Row | undefined;
  return {
    id: r.id, name: r.name, status: r.status, kind: r.kind, currentDeploymentId: r.current_deployment_id ?? null,
    lastDeploy, lastDeployLogTail: tail, rollbackTarget: rb ? toDeployment(rb) : null,
  };
}

function uptimeBriefs(rows: Row[], nowMs: number): UptimeBrief[] {
  return rows.map((r) => {
    const last = lastResultRow(r.id);
    return {
      check: toUptimeCheck(r, nowMs),
      lastError: last?.error ?? null,
      lastStatusCode: last?.status_code ?? null,
      consecutiveFails: loadCheckState(r.id).fails,
    };
  });
}

function emptyContext(nowMs: number, label: string): DiagnoseContext {
  return {
    now: nowMs, label, server: null, app: null, apps: [], latest: null, points1h: [], trend1h: null, containers: [],
    inspect: null, dockerDf: null, sshAttempted: false, sshError: null, firingAlerts: [], recentDeployments: [],
    recentLogs: [], logsContainer: null, uptime: [], tls: null,
  };
}

/** Build the context for one server (and optionally one app on it). */
export async function gatherContext(serverId: string, opts: { app?: App | null; ssh?: boolean } = {}): Promise<DiagnoseContext> {
  const nowMs = deps.now();
  const server: Server = toServer(getServerRow(serverId));
  const app = opts.app ?? null;
  const ctx = emptyContext(nowMs, app ? `App ${app.name} on ${server.name}` : server.name);
  ctx.server = server;
  ctx.app = app;

  const appRows = db.prepare('SELECT * FROM apps WHERE server_id = ? ORDER BY name').all(serverId) as Row[];
  ctx.apps = appRows.map(appBrief);
  ctx.latest = latestPoint(serverId);
  ctx.points1h = points1h(serverId, nowMs);
  ctx.trend1h = computeTrend(ctx.points1h);
  ctx.containers = (db.prepare('SELECT * FROM container_state WHERE server_id = ? ORDER BY name').all(serverId) as Row[]).map(toContainerInfo);

  if (app) {
    ctx.firingAlerts = (db.prepare(
      `SELECT * FROM alerts WHERE state = 'firing' AND (app_id = ? OR (server_id = ? AND app_id IS NULL)) ORDER BY started_at DESC`,
    ).all(app.id, serverId) as Row[]).map(toAlert);
    ctx.recentDeployments = (db.prepare('SELECT * FROM deployments WHERE app_id = ? ORDER BY created_at DESC LIMIT 10').all(app.id) as Row[]).map(toDeployment);
    ctx.uptime = uptimeBriefs(db.prepare('SELECT * FROM uptime_checks WHERE app_id = ? ORDER BY created_at').all(app.id) as Row[], nowMs);
  } else {
    ctx.firingAlerts = (db.prepare(
      `SELECT * FROM alerts WHERE state = 'firing' AND (server_id = ? OR app_id IN (SELECT id FROM apps WHERE server_id = ?)) ORDER BY started_at DESC`,
    ).all(serverId, serverId) as Row[]).map(toAlert);
    ctx.recentDeployments = (db.prepare(
      `SELECT d.* FROM deployments d JOIN apps a ON a.id = d.app_id WHERE a.server_id = ? ORDER BY d.created_at DESC LIMIT 10`,
    ).all(serverId) as Row[]).map(toDeployment);
    ctx.uptime = uptimeBriefs(db.prepare(
      `SELECT * FROM uptime_checks WHERE app_id IN (SELECT id FROM apps WHERE server_id = ?) ORDER BY created_at`,
    ).all(serverId) as Row[], nowMs);
  }

  const tasks: Promise<void>[] = [];
  if (opts.ssh !== false) {
    ctx.sshAttempted = true;
    tasks.push(collectSsh(serverId, app?.id ?? null).then(({ sections, error }) => {
      ctx.sshError = error;
      if (sections) {
        ctx.inspect = sections.inspect;
        ctx.dockerDf = sections.dockerDf.length ? sections.dockerDf : null;
        ctx.recentLogs = sections.logs;
        ctx.logsContainer = sections.logsContainer;
      }
    }));
  }
  if (app && app.port != null && app.kind !== 'database') {
    const domain = app.domains[0] ?? defaultDomain(app.name, server.host);
    if (domain) {
      const host = domain.replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
      tasks.push(withTimeout(deps.tlsProbe(host), 7000, 'TLS probe')
        .then((t) => { ctx.tls = t; })
        .catch(() => { ctx.tls = null; }));
    }
  }
  await Promise.all(tasks);
  return ctx;
}

function reportFrom(ctx: DiagnoseContext, scope: { serverId: string | null; appId: string | null }): DiagnoseReport {
  const findings = runRules(ctx);
  const containers = ctx.app ? ctx.containers.filter((c) => c.appId === ctx.app!.id) : ctx.containers;
  return {
    generatedAt: new Date(ctx.now).toISOString(),
    scope,
    healthy: isHealthy(findings),
    summary: summarize(ctx.label, findings, ctx),
    findings,
    context: {
      server: ctx.server, latest: ctx.latest, trend1h: ctx.trend1h, firingAlerts: ctx.firingAlerts,
      recentDeployments: ctx.recentDeployments, containers, recentLogs: ctx.recentLogs,
    },
  };
}

/**
 * Diagnose a scope. appId (id or name) implies its server. With neither, a single-server
 * install diagnoses that server; a fleet gets DB-only checks for every server.
 */
export async function diagnose(scope: { serverId?: string | null; appId?: string | null } = {}): Promise<DiagnoseReport> {
  if (scope.appId) {
    const app = toApp(getAppRow(scope.appId));
    return reportFrom(await gatherContext(app.serverId, { app }), { serverId: app.serverId, appId: app.id });
  }
  if (scope.serverId) {
    const id = getServerRow(scope.serverId).id;
    return reportFrom(await gatherContext(id), { serverId: id, appId: null });
  }
  const servers = listServers();
  if (servers.length === 1) return reportFrom(await gatherContext(servers[0]!.id), { serverId: servers[0]!.id, appId: null });
  return diagnoseFleet(servers);
}

async function diagnoseFleet(servers: Server[]): Promise<DiagnoseReport> {
  const nowMs = deps.now();
  const label = servers.length ? `Your fleet (${servers.length} servers)` : 'Docksy';
  const ctxs = await Promise.all(servers.map((s) => gatherContext(s.id, { ssh: false })));
  const findings = ctxs.flatMap((c) => runRules(c).map((f) => ({ ...f, title: `${c.server!.name}: ${f.title}` })));

  // checks and alerts not tied to any server
  const global = emptyContext(nowMs, label);
  global.uptime = uptimeBriefs(db.prepare('SELECT * FROM uptime_checks WHERE app_id IS NULL ORDER BY created_at').all() as Row[], nowMs);
  global.firingAlerts = (db.prepare(`SELECT * FROM alerts WHERE state = 'firing' AND server_id IS NULL AND app_id IS NULL ORDER BY started_at DESC`).all() as Row[]).map(toAlert);
  findings.push(...runRules(global));
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);

  if (!servers.length) {
    findings.push({ severity: 'info', title: 'No servers yet', detail: 'Docksy has nothing to monitor.', evidence: ['0 servers registered'],
      suggestion: 'Add a VPS with create_server, then provision it.', action: { tool: 'create_server', args: {} } });
  }
  const summary = servers.length ? summarize(label, findings) : 'No servers yet: add a VPS with create_server, then provision it.';
  return {
    generatedAt: new Date(nowMs).toISOString(),
    scope: { serverId: null, appId: null },
    healthy: isHealthy(findings),
    summary,
    findings,
    context: {
      server: null, latest: null, trend1h: null,
      firingAlerts: (db.prepare(`SELECT * FROM alerts WHERE state = 'firing' ORDER BY started_at DESC`).all() as Row[]).map(toAlert),
      recentDeployments: (db.prepare('SELECT * FROM deployments ORDER BY created_at DESC LIMIT 10').all() as Row[]).map(toDeployment),
      containers: ctxs.flatMap((c) => c.containers),
      recentLogs: [],
    },
  };
}
