import { z } from 'zod';
import type { App, Deployment, LogLine } from '@docksy/shared';
import { seg, type DocksyApi } from '../api.ts';
import { defineTool, UserFacingError, type ToolContext } from '../registry.ts';
import { resolveApp } from '../resolve.ts';
import { deploymentsTable } from '../render.ts';
import { ago, duration, fence, truncate } from '../format.ts';
import { appRef } from './apps.ts';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const MAX_LOG_CHARS = 30_000;

export function logLines(lines: LogLine[]): string {
  return lines.map((l) => `${l.stream === 'stderr' ? '! ' : l.stream === 'system' ? '» ' : ''}${l.line}`).join('\n');
}

/** Compiles a user filter: tries a case-insensitive regex, falls back to a plain substring. */
export function lineFilter(filter: string | undefined): ((s: string) => boolean) | null {
  if (!filter) return null;
  try {
    const re = new RegExp(filter, 'i');
    return (s) => re.test(s);
  } catch {
    const f = filter.toLowerCase();
    return (s) => s.toLowerCase().includes(f);
  }
}

async function waitForDeployment(ctx: ToolContext, d: Deployment, timeoutSec: number): Promise<Deployment> {
  const deadline = Date.now() + timeoutSec * 1000;
  let cur = d;
  while (!TERMINAL.has(cur.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    cur = await ctx.api.get<Deployment>(`/deployments/${seg(cur.id)}`);
    await ctx.progress?.(`deployment ${cur.status}`);
  }
  return cur;
}

async function deploymentOutcome(api: DocksyApi, app: App, d: Deployment, verb: string): Promise<string> {
  const lines = [`${verb} **${app.name}**: deployment \`${d.id}\` is **${d.status}**${d.startedAt ? ` (${duration(d.startedAt, d.finishedAt)})` : ''}.`];
  if (d.status === 'succeeded') {
    if (app.domains.length) lines.push(`Live at https://${app.domains[0]}`);
  } else if (d.status === 'failed') {
    if (d.error) lines.push(`Error: ${d.error}`);
    const logs = await api.get<{ items: LogLine[] }>(`/deployments/${seg(d.id)}/logs`).catch(() => ({ items: [] as LogLine[] }));
    if (logs.items.length) lines.push('', 'Last build/deploy log lines:', fence(logLines(logs.items.slice(-40))));
    lines.push('', 'The previous version (if any) is still serving traffic. Fix the cause, then deploy again; or `diagnose` this app.');
  } else if (!TERMINAL.has(d.status)) {
    lines.push(`Still ${d.status}. Check progress with \`get_deployment_logs {"deploymentId":"${d.id}"}\`.`);
  }
  return lines.join('\n');
}

export const listDeployments = defineTool({
  name: 'list_deployments',
  title: 'List deployments',
  description:
    'List recent deployments (newest first) with status, trigger (manual/webhook/rollback/mcp), commit, image tag, duration and error. Use it to see what changed recently, find a failed deploy, or pick a deploymentId for rollback_app.',
  kind: 'read',
  input: {
    appId: z.string().optional().describe('Only deployments of this app (id or name). Omit for all apps.'),
    limit: z.number().int().min(1).max(100).optional().describe('How many (default 10).'),
  },
  async run({ appId, limit }, { api }) {
    const app = appId ? await resolveApp(api, appId) : null;
    const { items } = await api.get<{ items: Deployment[] }>('/deployments', { appId: app?.id, limit: limit ?? 10 });
    const text = items.length
      ? `## Deployments${app ? ` of ${app.name}` : ''} (${items.length})\n\n${deploymentsTable(items, app?.currentDeploymentId)}`
      : `No deployments yet${app ? ` for ${app.name}; start one with deploy_app` : ''}.`;
    return { text, data: { items } };
  },
});

export const getDeploymentLogs = defineTool({
  name: 'get_deployment_logs',
  title: 'Get deployment (build) logs',
  description:
    "Read the build and rollout log of a deployment: git clone, docker build output, health checks. Use it when a deploy failed or is stuck. Pass deploymentId, or just appId to get the app's latest deployment. For the app's runtime output use get_app_logs instead.",
  kind: 'read',
  input: {
    deploymentId: z.string().optional().describe('Deployment id (from list_deployments).'),
    appId: z.string().optional().describe('App id or name: uses its most recent deployment when deploymentId is omitted.'),
    tail: z.number().int().min(1).max(5000).optional().describe('Only the last N lines (default 300).'),
    filter: z.string().optional().describe('Only lines matching this regex or text (case-insensitive), e.g. "error|failed".'),
  },
  async run({ deploymentId, appId, tail, filter }, { api }) {
    let dep: Deployment;
    if (deploymentId) {
      dep = await api.get<Deployment>(`/deployments/${seg(deploymentId)}`);
    } else if (appId) {
      const app = await resolveApp(api, appId);
      const { items } = await api.get<{ items: Deployment[] }>('/deployments', { appId: app.id, limit: 1 });
      if (!items.length) throw new UserFacingError(`${app.name} has no deployments yet.`, 'not_found');
      dep = items[0];
    } else {
      throw new UserFacingError('Pass deploymentId or appId.');
    }
    const { items } = await api.get<{ items: LogLine[] }>(`/deployments/${seg(dep.id)}/logs`);
    const match = lineFilter(filter);
    const filtered = match ? items.filter((l) => match(l.line)) : items;
    const shown = filtered.slice(-(tail ?? 300));
    const head = [
      `## Deployment \`${dep.id}\`: ${dep.status}`,
      `trigger ${dep.trigger}, ${dep.commitSha ? `commit ${dep.commitSha.slice(0, 7)} "${(dep.commitMessage ?? '').split('\n')[0]}", ` : ''}started ${ago(dep.startedAt ?? dep.createdAt)}, took ${duration(dep.startedAt, dep.finishedAt)}`,
    ];
    if (dep.error) head.push(`**Error:** ${dep.error}`);
    head.push(`Showing ${shown.length} of ${items.length} lines${match ? ` matching /${filter}/` : ''}. Lines starting "!" are stderr, "»" are Docksy steps.`);
    const body = shown.length ? fence(truncate(logLines(shown), MAX_LOG_CHARS)) : '_no log lines_';
    return { text: `${head.join('\n')}\n\n${body}`, data: { deployment: dep, lines: shown, totalLines: items.length } };
  },
});

export const getAppLogs = defineTool({
  name: 'get_app_logs',
  title: 'Get app runtime logs',
  description:
    "Read an app's runtime container logs (stdout/stderr, like `docker logs --tail`). Use it to debug crashes, 500s, slow requests or startup errors of a running app. Use `filter` to grep, e.g. \"error|exception|fatal\".",
  kind: 'read',
  input: {
    appId: appRef,
    tail: z.number().int().min(1).max(5000).optional().describe('How many recent lines to fetch (default 200).'),
    filter: z.string().optional().describe('Only lines matching this regex or text (case-insensitive).'),
  },
  async run({ appId, tail, filter }, { api }) {
    const app = await resolveApp(api, appId);
    const { lines } = await api.get<{ lines: string[] }>(`/apps/${seg(app.id)}/logs`, { tail: tail ?? 200 });
    const match = lineFilter(filter);
    const shown = match ? lines.filter(match) : lines;
    const head = `## Logs of ${app.name} (${app.status}): ${shown.length}${match ? ` matching /${filter}/ of ${lines.length}` : ''} lines`;
    const body = shown.length ? fence(truncate(shown.join('\n'), MAX_LOG_CHARS)) : match ? '_no matching lines_' : '_no output (is the app running? see get_app)_';
    return { text: `${head}\n\n${body}`, data: { appId: app.id, lines: shown, totalLines: lines.length } };
  },
});

const waitFields = {
  wait: z.boolean().optional().describe('Wait for the deployment to finish (up to timeoutSec) and report the result with log tail on failure. Default false.'),
  timeoutSec: z.number().int().min(10).max(900).optional().describe('Max seconds to wait when wait=true (default 240). If it is still running, check again with list_deployments.'),
};

export const deployApp = defineTool({
  name: 'deploy_app',
  title: 'Deploy app',
  description:
    'Build and deploy an app with zero downtime: pulls the latest commit (or image), builds, starts the new container, waits for the healthcheck, then swaps traffic. If anything fails the old version keeps running. Use after create_app, update_app or set_env_vars, or when the user says "ship it".',
  kind: 'write',
  input: {
    appId: appRef,
    ref: z.string().optional().describe('Git branch, tag or commit to deploy (default: the app\'s branch).'),
    ...waitFields,
  },
  async run({ appId, ref, wait, timeoutSec }, ctx) {
    const { api } = ctx;
    const app = await resolveApp(api, appId);
    let d = await api.post<Deployment>(`/apps/${seg(app.id)}/deploy`, { ref, trigger: 'mcp' });
    if (wait) d = await waitForDeployment(ctx, d, timeoutSec ?? 240);
    const text = wait
      ? await deploymentOutcome(api, app, d, 'Deployed')
      : `Deployment \`${d.id}\` of **${app.name}** queued (${d.status}). Follow with \`get_deployment_logs {"deploymentId":"${d.id}"}\` or call deploy_app with wait: true next time.`;
    return { text, data: { deployment: d } };
  },
});

export const rollbackApp = defineTool({
  name: 'rollback_app',
  title: 'Roll back app',
  description:
    "Roll an app back to a previous successful deployment's image (no rebuild, fast). Use when a fresh deploy broke production. Omit deploymentId to go back to the most recent successful deployment before the current one.",
  kind: 'write',
  input: {
    appId: appRef,
    deploymentId: z.string().optional().describe('A previous succeeded deployment id (see list_deployments). Default: the last good one before the current.'),
    ...waitFields,
  },
  async run({ appId, deploymentId, wait, timeoutSec }, ctx) {
    const { api } = ctx;
    const app = await resolveApp(api, appId);
    let target = deploymentId;
    if (!target) {
      const { items } = await api.get<{ items: Deployment[] }>('/deployments', { appId: app.id, limit: 50 });
      const cur = items.findIndex((d) => d.id === app.currentDeploymentId);
      const candidates = (cur >= 0 ? items.slice(cur + 1) : items).filter((d) => d.status === 'succeeded' && d.imageTag && d.id !== app.currentDeploymentId);
      if (!candidates.length) throw new UserFacingError(`No earlier successful deployment of ${app.name} to roll back to.`, 'not_found');
      target = candidates[0].id;
    }
    let d = await api.post<Deployment>(`/apps/${seg(app.id)}/rollback`, { deploymentId: target });
    if (wait) d = await waitForDeployment(ctx, d, timeoutSec ?? 240);
    const text = wait
      ? await deploymentOutcome(api, app, d, `Rolled back to \`${target}\`:`)
      : `Rolling **${app.name}** back to \`${target}\` (deployment \`${d.id}\`, ${d.status}).`;
    return { text, data: { deployment: d, rolledBackTo: target } };
  },
});

export const deployTools = [listDeployments, getDeploymentLogs, getAppLogs, deployApp, rollbackApp];
