import type { ContainerInfo, Deployment, DiagnoseFinding, MetricPoint, Severity } from '@docksy/shared';
import type { AppBrief, DiagnoseContext, InspectInfo, TrendStats } from './types.ts';

/**
 * Deterministic diagnose rules. Each rule is a pure function: (ctx) => DiagnoseFinding[].
 * Findings carry real numbers in `evidence`, a concrete `suggestion`, and when possible an `action`
 * naming the MCP tool (CONTRACT.md §8) that would fix it. Docksy never calls an LLM — Claude reasons on top.
 */

export type Rule = (ctx: DiagnoseContext) => DiagnoseFinding[];

export const T = {
  cpuWarn: 85, cpuCrit: 95,
  memWarn: 90, memCrit: 95,
  diskWarn: 85, diskCrit: 95,
  swapBytes: 512 * 1024 ** 2, swapGrowthBytes: 256 * 1024 ** 2, swapMemPct: 80,
  staleMs: 5 * 60_000,
  crashRestarts: 3, crashWindowMs: 15 * 60_000,
  recentDeployMs: 60 * 60_000,
  tlsWarnDays: 14,
  uptimeWarnPct: 99, slowLatencyMs: 2000,
  logErrorsWarn: 10,
} as const;

export const LOG_ERROR_RE = /error|exception|fatal|panic|killed/i;

// ───────────────────────────── formatting helpers ─────────────────────────────

export function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export const fmtPct = (n: number): string => `${(Math.round(n * 10) / 10).toFixed(1)}%`;

export function ago(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

const ms = (isoStr: string | null | undefined): number | null => {
  if (!isoStr) return null;
  const t = Date.parse(isoStr);
  return Number.isFinite(t) && t > 0 ? t : null;
};

export const memPct = (p: MetricPoint): number => (p.memTotal > 0 ? (p.memUsed / p.memTotal) * 100 : 0);
export const diskPct = (p: MetricPoint): number => (p.diskTotal > 0 ? (p.diskUsed / p.diskTotal) * 100 : 0);

export function computeTrend(points: MetricPoint[]): TrendStats | null {
  if (!points.length) return null;
  const cpus = points.map((p) => p.cpu);
  const mems = points.map(memPct);
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const r = (n: number) => Math.round(n * 10) / 10;
  return { cpuAvg: r(avg(cpus)), cpuMax: r(Math.max(...cpus)), memAvgPct: r(avg(mems)), memMaxPct: r(Math.max(...mems)) };
}

export const containerAppId = (c: ContainerInfo): string | null => c.appId ?? c.labels?.['docksy.app'] ?? null;

function appById(ctx: DiagnoseContext, id: string | null): AppBrief | null {
  return id ? ctx.apps.find((a) => a.id === id) ?? null : null;
}

function containerLabel(ctx: DiagnoseContext, c: { name: string; appId?: string | null; labels?: Record<string, string> }): string {
  const appId = c.appId ?? c.labels?.['docksy.app'] ?? null;
  const app = appById(ctx, appId);
  return app ? `${c.name} (app ${app.name})` : c.name;
}

function inspectFor(ctx: DiagnoseContext, c: ContainerInfo): InspectInfo | null {
  return ctx.inspect?.find((i) => i.id === c.id || c.id.startsWith(i.id) || i.id.startsWith(c.id) || i.name === c.name) ?? null;
}

/** Containers the container-level rules look at: the focused app's, or all of the server's. */
function scopedContainers(ctx: DiagnoseContext): ContainerInfo[] {
  if (!ctx.app) return ctx.containers;
  return ctx.containers.filter((c) => containerAppId(c) === ctx.app!.id);
}

/** Inspect entries without a matching agent snapshot (e.g. a container that died between reports). */
function scopedInspectOnly(ctx: DiagnoseContext): InspectInfo[] {
  if (!ctx.inspect) return [];
  return ctx.inspect.filter((i) => {
    if (ctx.app && i.labels['docksy.app'] !== ctx.app.id) return false;
    return !ctx.containers.some((c) => c.id === i.id || c.id.startsWith(i.id) || i.id.startsWith(c.id) || c.name === i.name);
  });
}

function metricsFresh(ctx: DiagnoseContext): MetricPoint | null {
  const t = ms(ctx.latest?.ts);
  return ctx.latest && t != null && ctx.now - t <= T.staleMs ? ctx.latest : null;
}

function topBy(ctx: DiagnoseContext, key: 'cpuPercent' | 'memUsed', n = 3): ContainerInfo[] {
  return ctx.containers.filter((c) => c.state === 'running').sort((a, b) => b[key] - a[key]).slice(0, n).filter((c) => c[key] > 0);
}

function topManaged(ctx: DiagnoseContext, key: 'cpuPercent' | 'memUsed'): { c: ContainerInfo; app: AppBrief } | null {
  for (const c of topBy(ctx, key, 10)) {
    const app = appById(ctx, containerAppId(c));
    if (app) return { c, app };
  }
  return null;
}

export function exitMeaning(code: number): string {
  switch (code) {
    case 0: return 'exited cleanly';
    case 1: return 'application error';
    case 126: return 'command not executable';
    case 127: return 'command not found';
    case 137: return 'SIGKILL, often out of memory';
    case 139: return 'segmentation fault';
    case 143: return 'SIGTERM, stopped';
    default: return 'non-zero exit';
  }
}

// ───────────────────────────── server rules ─────────────────────────────

export const offlineRule: Rule = (ctx) => {
  const s = ctx.server;
  if (!s || s.liveness === 'online') return [];
  const action = { tool: 'provision_server', args: { serverId: s.id } };
  if (!s.lastSeenAt) {
    return [{
      severity: 'warning',
      title: `The agent on ${s.name} has never reported`,
      detail: 'Docksy has no metrics from this server yet, so CPU, memory, disk and container monitoring are blind.',
      evidence: [`Server status: ${s.status}`, `Added ${ago(ms(s.createdAt) ?? ctx.now, ctx.now)}`,
        ...(ctx.sshAttempted ? [ctx.sshError ? `SSH failed: ${ctx.sshError}` : 'SSH works'] : [])],
      suggestion: s.status === 'ready'
        ? 'Re-run provisioning to reinstall the agent, and make sure the server can reach Docksy\'s public URL (Settings → Public URL).'
        : 'Provision the server: it installs Docker, the proxy and the monitoring agent.',
      action,
    }];
  }
  const last = ms(s.lastSeenAt)!;
  const evidence = [`Last agent report ${ago(last, ctx.now)} (${s.lastSeenAt})`, 'A server counts as online when it reported within 60s'];
  let suggestion: string;
  if (ctx.sshAttempted && !ctx.sshError) {
    evidence.push('SSH still works, so the machine is up');
    suggestion = 'The agent process probably stopped. Run `systemctl restart docksy-agent` on the server (check `journalctl -u docksy-agent`), or re-provision to reinstall it. Also confirm the server can reach Docksy\'s public URL.';
  } else {
    if (ctx.sshAttempted && ctx.sshError) evidence.push(`SSH also failed: ${ctx.sshError}`);
    suggestion = 'The server itself looks unreachable. Check it in your cloud provider\'s console (powered off, out of memory, network or firewall change). Once it is back, the agent reconnects on its own.';
  }
  return [{ severity: 'critical', title: `${s.name} is offline`, detail: 'The monitoring agent stopped reporting, so the server, its network or the agent is down.', evidence, suggestion, action }];
};

export const cpuRule: Rule = (ctx) => {
  const p = metricsFresh(ctx);
  if (!p) return [];
  const avg = ctx.trend1h?.cpuAvg ?? p.cpu;
  if (p.cpu < T.cpuWarn && avg < T.cpuWarn) return [];
  const severity: Severity = p.cpu >= T.cpuCrit && avg >= T.cpuWarn ? 'critical' : 'warning';
  const evidence = [`CPU ${fmtPct(p.cpu)} now${ctx.trend1h ? `; 1h avg ${fmtPct(ctx.trend1h.cpuAvg)}, max ${fmtPct(ctx.trend1h.cpuMax)}` : ''}`];
  const cores = ctx.server?.cpuCores;
  if (cores) evidence.push(`Load average ${p.load1.toFixed(2)} on ${cores} cores`);
  for (const c of topBy(ctx, 'cpuPercent')) evidence.push(`${containerLabel(ctx, c)}: ${fmtPct(c.cpuPercent)} CPU`);
  const top = topManaged(ctx, 'cpuPercent');
  return [{
    severity,
    title: `CPU is ${fmtPct(p.cpu)} busy on ${ctx.server?.name ?? 'the server'}`,
    detail: 'Sustained high CPU makes every app on this server slow to respond.',
    evidence,
    suggestion: top
      ? `Most CPU goes to app ${top.app.name} (${fmtPct(top.c.cpuPercent)}). Check its logs for a runaway loop or a traffic spike; restart it if the load is unexpected, or move it to a bigger server.`
      : 'No Docksy app stands out; check host processes with `top` on the server, or move workloads to a bigger server.',
    ...(top ? { action: { tool: 'get_app_logs', args: { appId: top.app.id, tail: 200 } } } : {}),
  }];
};

export const memoryRule: Rule = (ctx) => {
  const p = metricsFresh(ctx);
  if (!p || p.memTotal <= 0) return [];
  const pct = memPct(p);
  if (pct < T.memWarn) return [];
  const evidence = [`Memory ${fmtBytes(p.memUsed)} of ${fmtBytes(p.memTotal)} used (${fmtPct(pct)})`];
  if (ctx.trend1h) evidence.push(`1h avg ${fmtPct(ctx.trend1h.memAvgPct)}, max ${fmtPct(ctx.trend1h.memMaxPct)}`);
  if (p.swapUsed > 0) evidence.push(`Swap used ${fmtBytes(p.swapUsed)}`);
  for (const c of topBy(ctx, 'memUsed')) {
    evidence.push(`${containerLabel(ctx, c)}: ${fmtBytes(c.memUsed)}${c.memLimit > 0 && c.memLimit < p.memTotal ? ` of ${fmtBytes(c.memLimit)} limit` : ''}`);
  }
  const top = topManaged(ctx, 'memUsed');
  return [{
    severity: pct >= T.memCrit ? 'critical' : 'warning',
    title: `Memory is ${fmtPct(pct)} used on ${ctx.server?.name ?? 'the server'}`,
    detail: 'When memory runs out the kernel starts killing processes (OOM) and the server swaps, slowing everything down.',
    evidence,
    suggestion: top
      ? `App ${top.app.name} uses the most memory (${fmtBytes(top.c.memUsed)}). Restart it to reclaim memory if it is leaking, then watch whether it grows again; otherwise add RAM or move an app to another server.`
      : 'No Docksy app stands out; check host processes with `ps aux --sort=-rss | head` or add RAM.',
    ...(top ? { action: { tool: 'restart_app', args: { appId: top.app.id } } } : {}),
  }];
};

export const diskRule: Rule = (ctx) => {
  const p = metricsFresh(ctx) ?? ctx.latest;
  if (!p || p.diskTotal <= 0) return [];
  const pct = diskPct(p);
  if (pct < T.diskWarn) return [];
  const evidence = [`Disk ${fmtBytes(p.diskUsed)} of ${fmtBytes(p.diskTotal)} used (${fmtPct(pct)}), ${fmtBytes(p.diskTotal - p.diskUsed)} free`];
  const first = ctx.points1h[0];
  if (first && ctx.points1h.length > 1) {
    const spanH = ((ms(p.ts) ?? ctx.now) - (ms(first.ts) ?? ctx.now)) / 3_600_000;
    const growth = p.diskUsed - first.diskUsed;
    if (spanH >= 0.25 && growth > 0) {
      const perH = growth / spanH;
      evidence.push(`Growing about ${fmtBytes(perH)}/h; full in roughly ${Math.max(0, (p.diskTotal - p.diskUsed) / perH).toFixed(1)} h at this rate`);
    }
  }
  for (const d of ctx.dockerDf ?? []) evidence.push(`Docker ${d.type}: ${d.size} (${d.reclaimable} reclaimable)`);
  return [{
    severity: pct >= T.diskCrit ? 'critical' : 'warning',
    title: `Disk is ${fmtPct(pct)} full on ${ctx.server?.name ?? 'the server'}`,
    detail: 'A full disk breaks builds, databases and logging. Docker images and build cache are the usual culprits.',
    evidence,
    suggestion: 'Free space over SSH: `docker builder prune -af` (build cache, safe) and `docker image prune -f` (dangling images, safe). '
      + '`docker image prune -af --filter until=168h` frees more but deletes old images that rollbacks use. '
      + 'Also check old backups in /var/lib/docksy/backups and large logs with `du -sh /var/lib/docker/containers/*`.',
  }];
};

export const swapRule: Rule = (ctx) => {
  const p = metricsFresh(ctx);
  if (!p || p.memTotal <= 0) return [];
  const mp = memPct(p);
  const first = ctx.points1h[0];
  const growth = first ? p.swapUsed - first.swapUsed : 0;
  if (mp < T.swapMemPct) return [];
  if (p.swapUsed < T.swapBytes && growth < T.swapGrowthBytes) return [];
  const top = topManaged(ctx, 'memUsed');
  return [{
    severity: 'warning',
    title: `${ctx.server?.name ?? 'The server'} is swapping heavily`,
    detail: 'The server is short on RAM and paging memory to disk, which makes apps slow and unpredictable.',
    evidence: [
      `Swap used ${fmtBytes(p.swapUsed)}${first ? ` (was ${fmtBytes(first.swapUsed)} an hour ago)` : ''}`,
      `Memory ${fmtPct(mp)} used`,
      ...(top ? [`Biggest app: ${top.app.name} at ${fmtBytes(top.c.memUsed)}`] : []),
    ],
    suggestion: top
      ? `Reduce memory pressure: restart ${top.app.name} if it is leaking, give it a memory limit, or add RAM.`
      : 'Reduce memory pressure: stop unused containers or add RAM.',
    ...(top ? { action: { tool: 'restart_app', args: { appId: top.app.id } } } : {}),
  }];
};

// ───────────────────────────── container rules ─────────────────────────────

function isOom(i: InspectInfo | null): boolean {
  return !!i?.oomKilled;
}

function isCrashLooping(c: { state: string; restartCount: number; startedAt: string | null }, i: InspectInfo | null, nowMs: number): boolean {
  const state = i?.status ?? c.state;
  if (state === 'restarting') return true;
  const restarts = i?.restartCount ?? c.restartCount;
  if (restarts < T.crashRestarts) return false;
  const started = ms(i?.startedAt ?? c.startedAt);
  return state !== 'running' || (started != null && nowMs - started <= T.crashWindowMs);
}

function recentDeployOf(ctx: DiagnoseContext, app: AppBrief | null): Deployment | null {
  const d = app?.lastDeploy;
  const t = ms(d?.finishedAt);
  return d && d.status === 'succeeded' && t != null && ctx.now - t <= T.recentDeployMs ? d : null;
}

export const oomRule: Rule = (ctx) => {
  if (!ctx.inspect) return [];
  const out: DiagnoseFinding[] = [];
  const seen = new Set<string>();
  const items: { name: string; i: InspectInfo; c: ContainerInfo | null }[] = [];
  for (const c of scopedContainers(ctx)) { const i = inspectFor(ctx, c); if (i) items.push({ name: c.name, i, c }); }
  for (const i of scopedInspectOnly(ctx)) items.push({ name: i.name, i, c: null });
  for (const { name, i, c } of items) {
    if (!isOom(i) || seen.has(name)) continue;
    seen.add(name);
    const app = appById(ctx, i.labels['docksy.app'] ?? (c ? containerAppId(c) : null));
    const evidence = [
      `docker inspect: State.OOMKilled=true, ExitCode=${i.exitCode} (${exitMeaning(i.exitCode)})`,
      `Memory limit: ${i.memLimit > 0 ? fmtBytes(i.memLimit) : 'none (bounded by host RAM)'}`,
      `Restarts: ${i.restartCount}, status now: ${i.status}`,
    ];
    if (i.finishedAt && ms(i.finishedAt)) evidence.push(`Killed ${ago(ms(i.finishedAt)!, ctx.now)} (${i.finishedAt})`);
    if (c && c.memUsed > 0) evidence.push(`Using ${fmtBytes(c.memUsed)} at the last agent report`);
    if (ctx.latest && ctx.latest.memTotal > 0) evidence.push(`Server memory ${fmtPct(memPct(ctx.latest))} used`);
    out.push({
      severity: 'critical',
      title: `${app ? `App ${app.name}` : name} was killed for running out of memory`,
      detail: `The kernel OOM-killed container ${name}.${i.memLimit > 0 ? ' It hit its own memory limit.' : ' The whole server ran out of memory.'}`,
      evidence,
      suggestion: app
        ? `Give ${app.name} more memory (a higher limit or a bigger server) or fix the leak, then restart it. If this started after the latest deploy, roll back.`
        : 'Give this container more memory or stop other memory-heavy workloads on the server.',
      ...(app ? { action: { tool: 'restart_app', args: { appId: app.id } } } : {}),
    });
  }
  return out;
};

export const crashLoopRule: Rule = (ctx) => {
  const out: DiagnoseFinding[] = [];
  const items: { name: string; state: string; status: string; restartCount: number; startedAt: string | null; appId: string | null; i: InspectInfo | null }[] = [];
  for (const c of scopedContainers(ctx)) {
    items.push({ name: c.name, state: c.state, status: c.status, restartCount: c.restartCount, startedAt: c.startedAt, appId: containerAppId(c), i: inspectFor(ctx, c) });
  }
  for (const i of scopedInspectOnly(ctx)) {
    items.push({ name: i.name, state: i.status, status: i.status, restartCount: i.restartCount, startedAt: i.startedAt, appId: i.labels['docksy.app'] ?? null, i });
  }
  for (const it of items) {
    if (isOom(it.i) || !isCrashLooping(it, it.i, ctx.now)) continue;
    const restarts = it.i?.restartCount ?? it.restartCount;
    const app = appById(ctx, it.appId);
    const evidence = [`State: ${it.i?.status ?? it.state} (${it.status})`, `RestartCount=${restarts}`];
    if (it.i) evidence.push(`Last exit code ${it.i.exitCode} (${exitMeaning(it.i.exitCode)})${it.i.error ? `: ${it.i.error}` : ''}`);
    const started = ms(it.i?.startedAt ?? it.startedAt);
    if (started) evidence.push(`Last started ${ago(started, ctx.now)}`);
    const recent = recentDeployOf(ctx, app);
    if (recent) evidence.push(`Deployed ${ago(ms(recent.finishedAt)!, ctx.now)} (deployment ${recent.id.slice(0, 8)}${recent.commitSha ? `, commit ${recent.commitSha.slice(0, 7)}` : ''})`);
    const canRollback = !!(recent && app?.rollbackTarget);
    out.push({
      severity: 'critical',
      title: `${app ? `App ${app.name}` : it.name} is crash-looping (${restarts} restarts)`,
      detail: `Container ${it.name} keeps exiting and Docker keeps restarting it.`,
      evidence,
      suggestion: canRollback
        ? `It started after the latest deploy. Roll back to deployment ${app!.rollbackTarget!.id.slice(0, 8)} now, then read the logs to fix the new version.`
        : `Read its logs to see why it exits (missing env var, bad config, failing migration, wrong port).${app ? '' : ' It is not a Docksy-managed app.'}`,
      ...(canRollback
        ? { action: { tool: 'rollback_app', args: { appId: app!.id, deploymentId: app!.rollbackTarget!.id } } }
        : app ? { action: { tool: 'get_app_logs', args: { appId: app.id, tail: 200 } } } : {}),
    });
  }
  return out;
};

export const appDownRule: Rule = (ctx) => {
  if (ctx.server?.liveness !== 'online') return []; // container data is stale when the agent is offline
  const out: DiagnoseFinding[] = [];
  const apps = ctx.app ? ctx.apps.filter((a) => a.id === ctx.app!.id) : ctx.apps;
  for (const app of apps) {
    if (app.status !== 'running') continue;
    const mine = ctx.containers.filter((c) => containerAppId(c) === app.id);
    if (mine.some((c) => c.state === 'running')) continue;
    // crash loops and OOM kills are reported by their own rules
    if (mine.some((c) => { const i = inspectFor(ctx, c); return isOom(i) || isCrashLooping(c, i, ctx.now); })) continue;
    const evidence = mine.length
      ? mine.map((c) => { const i = inspectFor(ctx, c); return `Container ${c.name} is ${c.state} (${c.status})${i ? `, exit code ${i.exitCode} (${exitMeaning(i.exitCode)})` : ''}`; })
      : ['No container with label docksy.app for this app was found on the server'];
    evidence.unshift(`App status in Docksy: ${app.status}`);
    out.push({
      severity: 'critical',
      title: `App ${app.name} is not running`,
      detail: mine.length ? 'Its container stopped and was not restarted.' : 'Docksy thinks the app is running, but its container is gone.',
      evidence,
      suggestion: mine.length
        ? `Start it again, then check the logs if it stops.`
        : `Redeploy ${app.name} to recreate its container.`,
      action: mine.length ? { tool: 'start_app', args: { appId: app.id } } : { tool: 'deploy_app', args: { appId: app.id } },
    });
  }
  return out;
};

export const healthcheckRule: Rule = (ctx) => {
  if (!ctx.inspect) return [];
  const out: DiagnoseFinding[] = [];
  for (const c of scopedContainers(ctx)) {
    const i = inspectFor(ctx, c);
    if (!i || i.health !== 'unhealthy' || i.status !== 'running') continue;
    const app = appById(ctx, containerAppId(c));
    out.push({
      severity: 'warning',
      title: `${app ? `App ${app.name}` : c.name} is failing its Docker healthcheck`,
      detail: `Container ${c.name} is running but reports unhealthy.`,
      evidence: [`Health: unhealthy, FailingStreak=${i.healthFailingStreak}`, ...(i.healthLastOutput ? [`Last healthcheck output: ${i.healthLastOutput}`] : [])],
      suggestion: 'Check the healthcheck command/path and the app logs; restart the app if it is stuck.',
      ...(app ? { action: { tool: 'restart_app', args: { appId: app.id } } } : {}),
    });
  }
  return out;
};

// ───────────────────────────── deploy / logs / tls / uptime ─────────────────────────────

/** Map a build error to a concrete hint. Pure. */
export function deployHint(error: string | null, logTail: string[]): string {
  const text = `${error ?? ''}\n${logTail.join('\n')}`;
  if (/no space left on device/i.test(text)) return 'The server ran out of disk during the build. Free space (docker builder prune -af) and redeploy.';
  if (/authentication failed|could not read username|repository not found|permission denied \(publickey\)/i.test(text)) return 'Git could not clone the repo. For a private repo, add a GitHub token to the app (update_app with gitToken), and check the repo URL and branch.';
  if (/remote branch .* not found|couldn't find remote ref/i.test(text)) return 'The branch does not exist on the remote. Fix the branch in the app settings.';
  if (/failed to read dockerfile|dockerfile.*no such file|cannot locate specified dockerfile/i.test(text)) return 'No Dockerfile at the configured path. Fix dockerfilePath, or switch buildType to auto so Docksy generates one.';
  if (/npm err|err_pnpm|yarn error|error: command failed|exit code: 1\b|returned a non-zero code/i.test(text)) return 'A build step failed inside the Dockerfile. Reproduce it locally with `docker build .`, fix it and push again.';
  if (/health|timed out|timeout/i.test(text)) return 'The new container did not become healthy within 120s. Check that the app listens on the configured port and that healthcheckPath returns 2xx.';
  if (/port is already allocated|address already in use/i.test(text)) return 'A port conflict stopped the container. Don\'t publish host ports; Docksy routes traffic through the proxy.';
  if (/pull access denied|manifest unknown|not found: manifest/i.test(text)) return 'The image could not be pulled. Check the image name and tag, and registry access.';
  return 'Read the full build log, fix the cause and redeploy.';
}

export const failedDeployRule: Rule = (ctx) => {
  const out: DiagnoseFinding[] = [];
  const apps = ctx.app ? ctx.apps.filter((a) => a.id === ctx.app!.id) : ctx.apps;
  for (const app of apps) {
    const d = app.lastDeploy;
    if (!d || d.status !== 'failed') continue;
    const finished = ms(d.finishedAt ?? d.createdAt);
    const evidence = [
      `Deployment ${d.id.slice(0, 8)} (${d.trigger}${d.commitSha ? `, commit ${d.commitSha.slice(0, 7)}` : ''}${d.commitMessage ? ` "${d.commitMessage.split('\n')[0]!.slice(0, 80)}"` : ''}) failed${finished ? ` ${ago(finished, ctx.now)}` : ''}`,
      `Error: ${d.error ?? 'no error message recorded'}`,
      ...app.lastDeployLogTail.map((l) => `log: ${l}`),
    ];
    const serving = app.status !== 'failed' && !!app.currentDeploymentId;
    if (serving) evidence.push('The previous version is still serving traffic');
    const hint = deployHint(d.error, app.lastDeployLogTail);
    const rollback = !serving && app.rollbackTarget;
    out.push({
      severity: serving ? 'warning' : 'critical',
      title: `The last deploy of ${app.name} failed`,
      detail: serving ? 'Zero-downtime deploys kept the old container running, but the new code is not live.' : 'There is no healthy version of this app running.',
      evidence,
      suggestion: rollback ? `${hint} Meanwhile, roll back to deployment ${app.rollbackTarget!.id.slice(0, 8)} to get the app back up.` : hint,
      action: rollback
        ? { tool: 'rollback_app', args: { appId: app.id, deploymentId: app.rollbackTarget!.id } }
        : { tool: 'get_deployment_logs', args: { deploymentId: d.id } },
    });
  }
  return out;
};

const stripTs = (l: string): string => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s+/, '');

export const logErrorsRule: Rule = (ctx) => {
  if (!ctx.app || !ctx.recentLogs.length) return [];
  const hits = ctx.recentLogs.filter((l) => LOG_ERROR_RE.test(l));
  if (!hits.length) return [];
  const severe = hits.some((l) => /fatal|panic/i.test(l));
  const samples: string[] = [];
  const seen = new Set<string>();
  for (let k = hits.length - 1; k >= 0 && samples.length < 5; k--) {
    const key = stripTs(hits[k]!).replace(/\d+/g, '#');
    if (seen.has(key)) continue;
    seen.add(key);
    samples.unshift(hits[k]!.slice(0, 240));
  }
  return [{
    severity: severe || hits.length >= T.logErrorsWarn ? 'warning' : 'info',
    title: `${hits.length} error line${hits.length === 1 ? '' : 's'} in the last ${ctx.recentLogs.length} log lines of ${ctx.app.name}`,
    detail: `Matched /${LOG_ERROR_RE.source}/i in the output of ${ctx.logsContainer ?? 'the app container'}.`,
    evidence: [`${hits.length} of ${ctx.recentLogs.length} lines match${severe ? ', including fatal/panic' : ''}`, ...samples],
    suggestion: 'Read the logs around these lines to find the root cause (a failing dependency, bad env var or unhandled exception).',
    action: { tool: 'get_app_logs', args: { appId: ctx.app.id, tail: 200 } },
  }];
};

export const tlsRule: Rule = (ctx) => {
  const t = ctx.tls;
  if (!t) return [];
  const serverHost = ctx.server?.host ?? 'the server IP';
  if (!t.reachable) {
    if (t.errorCode === 'ENOTFOUND' || t.errorCode === 'EAI_AGAIN') {
      return [{
        severity: 'warning',
        title: `Domain ${t.host} does not resolve`,
        detail: 'DNS has no record for this domain, so nobody can reach the app and no certificate can be issued.',
        evidence: [`DNS lookup failed: ${t.error ?? t.errorCode}`],
        suggestion: `Add an A record for ${t.host} pointing at ${serverHost}. The proxy gets a TLS certificate automatically once DNS resolves.`,
      }];
    }
    return [{
      severity: 'warning',
      title: `HTTPS is not reachable on ${t.host}`,
      detail: 'Docksy could not complete a TLS handshake on port 443.',
      evidence: [`TLS connect failed: ${t.error ?? t.errorCode ?? 'unknown error'}`],
      suggestion: 'Check that the docksy-proxy container is running and that ports 80 and 443 are open in the firewall. Re-provisioning restarts the proxy.',
      ...(ctx.server ? { action: { tool: 'provision_server', args: { serverId: ctx.server.id } } } : {}),
    }];
  }
  const evidence = [
    ...(t.validTo ? [`Certificate valid until ${t.validTo}${t.daysLeft != null ? ` (${t.daysLeft} days)` : ''}`] : []),
    ...(t.issuer ? [`Issuer: ${t.issuer}`] : []),
    ...(t.error ? [`Verification error: ${t.error}`] : []),
  ];
  const fix = `The proxy (Caddy) issues and renews certificates automatically when ${t.host} points at ${serverHost} and port 80 is reachable from the internet. Check the docksy-proxy logs for ACME errors.`;
  if (t.daysLeft != null && t.daysLeft < 0) {
    return [{ severity: 'critical', title: `TLS certificate for ${t.host} has expired`, detail: 'Browsers show a security error to every visitor.', evidence, suggestion: fix }];
  }
  if (!t.ok) {
    return [{ severity: 'critical', title: `TLS certificate for ${t.host} is not trusted`, detail: 'Browsers show a security error to every visitor.', evidence, suggestion: fix }];
  }
  if (t.daysLeft != null && t.daysLeft < T.tlsWarnDays) {
    return [{ severity: 'warning', title: `TLS certificate for ${t.host} expires in ${t.daysLeft} days`, detail: 'Automatic renewal normally happens 30 days before expiry, so renewal seems to be failing.', evidence, suggestion: fix }];
  }
  return [];
};

export const uptimeRule: Rule = (ctx) => {
  const out: DiagnoseFinding[] = [];
  for (const u of ctx.uptime) {
    const c = u.check;
    if (!c.enabled) continue;
    const app = appById(ctx, c.appId);
    const stats = `24h uptime ${c.uptime24h == null ? 'n/a' : `${c.uptime24h}%`}${c.avgLatencyMs24h != null ? `, avg latency ${c.avgLatencyMs24h}ms` : ''}`;
    if (c.lastStatus === 'down') {
      out.push({
        severity: 'critical',
        title: `Uptime check ${c.name} is failing`,
        detail: `${c.url} is not responding as expected${c.expectedStatus ? ` (expects HTTP ${c.expectedStatus})` : ' (expects any 2xx/3xx)'}.`,
        evidence: [`Last result: ${u.lastError ?? (u.lastStatusCode ? `HTTP ${u.lastStatusCode}` : 'failed')}`, `${u.consecutiveFails} failed check${u.consecutiveFails === 1 ? '' : 's'} in a row`, stats],
        suggestion: app ? `Look at ${app.name}'s logs and container state; restart it if it is hung.` : `Check the service behind ${c.url}.`,
        ...(app ? { action: { tool: 'restart_app', args: { appId: app.id } } } : {}),
      });
    } else if (c.uptime24h != null && c.uptime24h < T.uptimeWarnPct) {
      out.push({
        severity: 'warning',
        title: `${c.name} was flaky in the last 24h (${c.uptime24h}% up)`,
        detail: `It is up now, but ${c.url} failed some checks today.`,
        evidence: [stats, ...(u.lastError ? [`Most recent error: ${u.lastError}`] : [])],
        suggestion: app ? `Check ${app.name} for restarts or memory pressure around the failures.` : `Check the service behind ${c.url} for intermittent errors.`,
        ...(app ? { action: { tool: 'get_app_logs', args: { appId: app.id, tail: 200 } } } : {}),
      });
    } else if (c.avgLatencyMs24h != null && c.avgLatencyMs24h > T.slowLatencyMs) {
      out.push({
        severity: 'info',
        title: `${c.name} is slow (${c.avgLatencyMs24h}ms average)`,
        detail: `Responses from ${c.url} took over ${T.slowLatencyMs}ms on average in the last 24h.`,
        evidence: [stats],
        suggestion: 'Check CPU and memory on the server and slow queries in the app.',
      });
    }
  }
  return out;
};

const SEV_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export const alertsRule: Rule = (ctx) => {
  const firing = ctx.firingAlerts.filter((a) => a.state === 'firing');
  if (!firing.length) return [];
  const unacked = firing.filter((a) => !a.ackedAt);
  const worst = [...firing].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])[0]!.severity;
  return [{
    severity: unacked.length ? worst : 'info',
    title: `${firing.length} alert${firing.length === 1 ? ' is' : 's are'} firing`,
    detail: 'Alerts resolve on their own once their condition clears.',
    evidence: firing.slice(0, 10).map((a) => `${a.severity}: ${a.title} (since ${ago(ms(a.startedAt) ?? ctx.now, ctx.now)}${a.ackedAt ? ', acknowledged' : ''})`),
    suggestion: 'Fix the causes listed in this report. Acknowledge an alert to stop repeat notifications while you work on it.',
    ...(unacked.length === 1 ? { action: { tool: 'ack_alert', args: { alertId: unacked[0]!.id } } } : {}),
  }];
};

export const sshRule: Rule = (ctx) => {
  if (!ctx.sshAttempted || !ctx.sshError || ctx.server?.liveness !== 'online') return [];
  return [{
    severity: 'info',
    title: `Could not inspect containers on ${ctx.server.name} over SSH`,
    detail: 'This report is based on agent metrics only: OOM kills, exit codes, healthchecks and app logs are missing.',
    evidence: [`SSH error: ${ctx.sshError}`],
    suggestion: 'Check that Docksy\'s SSH key is still in the server\'s authorized_keys and that the SSH user can run docker.',
  }];
};

export const RULES: Rule[] = [
  offlineRule, oomRule, crashLoopRule, appDownRule, failedDeployRule, uptimeRule, tlsRule,
  memoryRule, cpuRule, diskRule, swapRule, healthcheckRule, logErrorsRule, alertsRule, sshRule,
];

/** Run all rules; a rule that throws is skipped (and noted) rather than breaking the report. Sorted by severity. */
export function runRules(ctx: DiagnoseContext, rules: Rule[] = RULES): DiagnoseFinding[] {
  const out: DiagnoseFinding[] = [];
  for (const rule of rules) {
    try {
      out.push(...rule(ctx));
    } catch (e) {
      out.push({ severity: 'info', title: `A diagnose check failed to run (${rule.name || 'rule'})`, detail: String((e as Error)?.message ?? e), evidence: [], suggestion: 'This is a Docksy bug; please report it on GitHub.' });
    }
  }
  return out.map((f, idx) => ({ f, idx })).sort((a, b) => SEV_RANK[a.f.severity] - SEV_RANK[b.f.severity] || a.idx - b.idx).map((x) => x.f);
}

export const isHealthy = (findings: DiagnoseFinding[]): boolean => !findings.some((f) => f.severity !== 'info');

/** 1–2 sentence plain-English verdict. */
export function summarize(label: string, findings: DiagnoseFinding[], ctx?: Pick<DiagnoseContext, 'latest' | 'containers' | 'now' | 'app'>): string {
  const crit = findings.filter((f) => f.severity === 'critical').length;
  const warn = findings.filter((f) => f.severity === 'warning').length;
  const info = findings.length - crit - warn;
  if (!crit && !warn) {
    const parts: string[] = [];
    const p = ctx?.latest;
    const fresh = p && ctx && ctx.now - (ms(p.ts) ?? 0) <= T.staleMs;
    if (fresh) {
      parts.push(`CPU ${fmtPct(p.cpu)}`);
      if (p.memTotal > 0) parts.push(`memory ${fmtPct(memPct(p))}`);
      if (p.diskTotal > 0) parts.push(`disk ${fmtPct(diskPct(p))}`);
    }
    const cs = ctx ? (ctx.app ? ctx.containers.filter((c) => containerAppId(c) === ctx.app!.id) : ctx.containers) : [];
    if (cs.length) parts.push(`${cs.filter((c) => c.state === 'running').length}/${cs.length} containers running`);
    const first = parts.length ? `${label} looks healthy: ${parts.join(', ')}.` : `${label} looks healthy: no problems found.`;
    return info ? `${first} ${info} minor note${info === 1 ? '' : 's'} below.` : first;
  }
  const counts = [crit ? `${crit} critical` : '', warn ? `${warn} warning${warn === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
  const top = findings[0]!;
  const fix = top.action ? ` Suggested first step: ${top.action.tool}.` : ` ${top.suggestion.split(/(?<=\.)\s/)[0]}`;
  return `${label} has ${counts}; most urgent: ${top.title}.${fix}`.slice(0, 400);
}
