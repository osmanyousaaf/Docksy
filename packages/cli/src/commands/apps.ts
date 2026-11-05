/** apps ls | create | rm, deploy, logs, rollback, env */
import pc from 'picocolors';
import type { App, BuildType, CreateAppRequest, Deployment, DocksyClient, LogLine, Server } from '@crovenai/docksy-client';
import type { Ctx } from '../context.ts';
import { CliError, ExitCode } from '../context.ts';
import { formatDuration, shortId, statusColor, sym, table, timeAgo, type Column } from '../format.ts';
import { confirm } from '../prompt.ts';
import { resolveApp, resolveServer } from '../resolve.ts';
import { parsePort } from './servers.ts';

const json = (ctx: Ctx, data: unknown) => ctx.print(JSON.stringify(data, null, 2));

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** ["A=1", "B=x=y"] → {A: "1", B: "x=y"}. Rejects malformed pairs and invalid keys. */
export function parseKeyValues(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i <= 0) throw new CliError(`"${p}" should look like KEY=value.`);
    const k = p.slice(0, i).trim();
    if (!ENV_KEY_RE.test(k)) throw new CliError(`"${k}" is not a valid variable name.`, { hint: 'Use letters, digits and underscores, not starting with a digit.' });
    let v = p.slice(i + 1);
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

// ───────────────────────────── apps ─────────────────────────────

export async function appsLs(ctx: Ctx, o: { json?: boolean; server?: string }): Promise<void> {
  const client = ctx.client();
  const servers = await client.listServers();
  let serverId: string | undefined;
  if (o.server) serverId = (await resolveServer(client, o.server)).id;
  const apps = await client.listApps({ serverId });
  if (o.json) return json(ctx, apps);
  if (apps.length === 0) {
    ctx.print(` No apps yet. Create one: ${pc.cyan('docksy apps create <name> --image nginx')}  ${pc.dim('or --repo https://github.com/you/app')}`);
    return;
  }
  ctx.print(renderApps(apps, servers, ctx.width()));
}

function source(a: App): string {
  if (a.template) return `${pc.magenta('◆')} ${a.template}`;
  if (a.sourceType === 'image') return a.image ?? '–';
  const repo = (a.repoUrl ?? '').replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '');
  return `${repo || '–'}${a.branch ? pc.dim(`#${a.branch}`) : ''}`;
}

export function renderApps(apps: App[], servers: Server[], width: number, now = Date.now()): string {
  const names = new Map(servers.map((s) => [s.id, s.name]));
  const cols: Column[] = [
    { header: 'Name' }, { header: 'Status' }, { header: 'Server' }, { header: 'Source', flex: true },
    { header: 'Domain', flex: true }, { header: 'Updated' },
  ];
  const rows = apps.map((a) => [
    pc.bold(a.name),
    statusColor(a.status),
    names.get(a.serverId) ?? shortId(a.serverId),
    source(a),
    a.domains[0] ? pc.cyan(a.domains[0]) + (a.domains.length > 1 ? pc.dim(` +${a.domains.length - 1}`) : '') : pc.dim('–'),
    pc.dim(timeAgo(a.updatedAt, now)),
  ]);
  return table(cols, rows, { width, indent: 1 });
}

export interface CreateOpts {
  server?: string; repo?: string; branch?: string; image?: string; template?: string; port?: string;
  domain?: string[]; build?: string; dockerfile?: string; healthcheck?: string; env?: string[]; gitToken?: string;
  autoDeploy?: boolean; deploy?: boolean; json?: boolean;
}

const BUILD_TYPES: BuildType[] = ['auto', 'dockerfile', 'compose', 'image'];

export function buildCreateRequest(name: string, serverId: string, o: CreateOpts): CreateAppRequest {
  const given = [o.repo, o.image, o.template].filter(Boolean).length;
  if (given === 0) throw new CliError('Tell Docksy what to run.', { hint: 'Pass one of --repo <git url>, --image <image> or --template <id> (see `docksy apps templates`).' });
  if (given > 1) throw new CliError('Use only one of --repo, --image or --template.');
  if (o.build && !(BUILD_TYPES as string[]).includes(o.build)) throw new CliError(`Unknown build type "${o.build}".`, { hint: `Use one of: ${BUILD_TYPES.join(', ')}` });
  const req: CreateAppRequest = { name, serverId };
  if (o.template) req.template = o.template;
  if (o.image) { req.sourceType = 'image'; req.image = o.image; req.buildType = 'image'; }
  if (o.repo) { req.sourceType = 'git'; req.repoUrl = o.repo; req.branch = o.branch ?? 'main'; req.buildType = (o.build as BuildType) ?? 'auto'; }
  if (o.gitToken) req.gitToken = o.gitToken;
  if (o.dockerfile) { req.dockerfilePath = o.dockerfile; if (!o.build && o.repo) req.buildType = 'dockerfile'; }
  if (o.port) req.port = parsePort(o.port);
  if (o.domain?.length) req.domains = o.domain.flatMap((d) => d.split(',')).map((d) => d.trim()).filter(Boolean);
  if (o.healthcheck) req.healthcheckPath = o.healthcheck;
  if (o.env?.length) req.env = parseKeyValues(o.env);
  if (o.autoDeploy === false) req.autoDeploy = false;
  return req;
}

export async function appsCreate(ctx: Ctx, name: string, o: CreateOpts): Promise<void> {
  const client = ctx.client();
  let server: Server;
  if (o.server) server = await resolveServer(client, o.server);
  else {
    const all = await client.listServers();
    if (all.length !== 1) {
      throw new CliError(all.length ? 'Which server? Pass --server <name>.' : 'Add a server first.', { hint: all.length ? `Servers: ${all.map((s) => s.name).join(', ')}` : 'docksy servers add <name> <host>' });
    }
    server = all[0];
  }
  const app = await client.createApp(buildCreateRequest(name, server.id, o));
  if (o.json && !o.deploy) return json(ctx, app);
  if (!o.json) {
    ctx.print(` ${sym.ok} Created ${pc.bold(app.name)} on ${pc.bold(server.name)}${app.domains[0] ? ` → ${pc.cyan(`https://${app.domains[0]}`)}` : ''}`);
    if (app.sourceType === 'git' && app.autoDeploy) {
      ctx.print(pc.dim(`   Auto-deploy on push: add this GitHub webhook → ${app.webhookUrl}  (secret: docksy apps webhook ${app.name})`));
    }
  }
  if (o.deploy) return deployCmd(ctx, app.name, { follow: !o.json, json: o.json });
  ctx.print(` Next: ${pc.cyan(`docksy deploy ${app.name} --follow`)}`);
}

export async function appsRm(ctx: Ctx, ref: string, o: { yes?: boolean; volumes?: boolean }): Promise<void> {
  const client = ctx.client();
  const app = await resolveApp(client, ref);
  const what = o.volumes ? 'its containers AND its data volumes (this cannot be undone)' : 'its containers (volumes are kept)';
  await confirm(ctx, `Delete app ${pc.bold(app.name)} and ${what}?`, o);
  await client.deleteApp(app.id, { volumes: o.volumes });
  ctx.print(` ${sym.ok} Deleted ${pc.bold(app.name)}.${o.volumes ? '' : pc.dim(' Volumes were kept.')}`);
}

export async function appsTemplates(ctx: Ctx, o: { json?: boolean }): Promise<void> {
  const t = await ctx.client().listTemplates();
  if (o.json) return json(ctx, t);
  const cols: Column[] = [{ header: 'Id' }, { header: 'Name' }, { header: 'Kind' }, { header: 'Image' }, { header: 'Description', flex: true }];
  ctx.print(table(cols, t.map((x) => [pc.bold(x.id), x.name, pc.dim(x.kind), pc.dim(x.image), x.description]), { width: ctx.width(), indent: 1 }));
  ctx.print(pc.dim(`\n Create one: docksy apps create my-db --template postgres`));
}

export async function appsWebhook(ctx: Ctx, ref: string, o: { json?: boolean }): Promise<void> {
  const w = await ctx.client().getWebhook(ref);
  if (o.json) return json(ctx, w);
  ctx.print(` ${pc.bold('Payload URL')}  ${pc.cyan(w.url)}`);
  ctx.print(` ${pc.bold('Secret')}       ${w.secret}`);
  ctx.print(pc.dim(' GitHub → Settings → Webhooks → Add webhook · content type application/json · just the push event'));
}

// ───────────────────────────── deploy ─────────────────────────────

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '        ' : d.toLocaleTimeString([], { hour12: false });
}

export function formatLogLine(l: LogLine): string {
  const ts = pc.dim(clockTime(l.ts));
  if (l.stream === 'system') {
    const step = /^::step::\s*(.*)$/.exec(l.line);
    return `${ts} ${pc.cyan('▸')} ${pc.bold(step ? step[1] : l.line)}`;
  }
  if (l.stream === 'stderr') return `${ts} ${pc.yellow('│')} ${l.line}`;
  return `${ts} ${pc.dim('│')} ${l.line}`;
}

export async function deployCmd(ctx: Ctx, ref: string, o: { follow?: boolean; ref?: string; json?: boolean }): Promise<void> {
  const client = ctx.client();
  const app = await resolveApp(client, ref);
  const d = await client.deployApp(app.id, { ref: o.ref, trigger: 'manual' });
  if (o.json && !o.follow) return json(ctx, d);
  // With --json, stdout carries only the final JSON; progress goes to stderr.
  const say = o.json ? ctx.warn : ctx.print;
  say(` ${pc.cyan('▲')} Deploying ${pc.bold(app.name)} ${pc.dim(`· deployment ${d.id}`)}`);
  if (!o.follow) {
    say(pc.dim(`   Watch the build: docksy deploy ${app.name} --follow  ·  or docksy logs ${app.name} -f once it's up`));
    return;
  }
  const final = await followDeployment(client, d, say);
  if (o.json) json(ctx, final);
  finishDeploy(ctx, app, final, say);
}

async function followDeployment(client: DocksyClient, d: Deployment, say: (s: string) => void): Promise<Deployment> {
  let last = d.status as string;
  const it = client.followDeployment(d.id);
  for (;;) {
    const r = await it.next();
    if (r.done) return r.value;
    const ev = r.value;
    if (ev.event === 'log') say(formatLogLine(ev.data));
    else if (ev.event === 'status' && ev.data.status !== last) {
      last = ev.data.status;
      if (!TERMINAL.has(last)) say(` ${pc.cyan('●')} ${statusColor(last)}`);
    }
  }
}

function finishDeploy(ctx: Ctx, app: App, d: Deployment, say: (s: string) => void): void {
  const took = d.startedAt && d.finishedAt ? ` in ${formatDuration((Date.parse(d.finishedAt) - Date.parse(d.startedAt)) / 1000)}` : '';
  if (d.status === 'succeeded') {
    const url = app.domains[0] ? ` → ${pc.cyan(`https://${app.domains[0]}`)}` : '';
    say(` ${sym.ok} ${pc.bold(app.name)} deployed${took}${url}`);
    return;
  }
  if (d.status === 'cancelled') {
    ctx.warn(` ${sym.warn} Deployment cancelled.`);
    throw new ExitCode(1);
  }
  ctx.warn(` ${sym.fail} Deployment failed${took}${d.error ? `: ${d.error}` : ''}`);
  ctx.warn(pc.dim(`   Ask Claude: /docksy:diagnose ${app.name}  ·  or: docksy diagnose ${app.name}`));
  throw new ExitCode(1);
}

// ───────────────────────────── rollback ─────────────────────────────

/** Most recent succeeded deployment with an image that is not the current one. */
export function pickRollbackTarget(deployments: Deployment[], currentId: string | null): Deployment | undefined {
  return [...deployments]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .find((d) => d.status === 'succeeded' && d.imageTag && d.id !== currentId);
}

export async function rollbackCmd(ctx: Ctx, ref: string, deploymentId: string | undefined, o: { follow?: boolean; json?: boolean }): Promise<void> {
  const client = ctx.client();
  const app = await resolveApp(client, ref);
  let target: Deployment | undefined;
  if (deploymentId) target = await client.getDeployment(deploymentId);
  else {
    target = pickRollbackTarget(await client.listDeployments({ appId: app.id, limit: 50 }), app.currentDeploymentId);
    if (!target) throw new CliError(`No earlier successful deployment of ${app.name} to roll back to.`);
  }
  const d = await client.rollbackApp(app.id, { deploymentId: target.id });
  if (o.json && !o.follow) return json(ctx, d);
  const what = target.commitSha ? `${target.commitSha.slice(0, 7)}${target.commitMessage ? ` "${target.commitMessage.split('\n')[0]}"` : ''}` : (target.imageTag ?? target.id);
  const say = o.json ? ctx.warn : ctx.print;
  say(` ${pc.cyan('↺')} Rolling back ${pc.bold(app.name)} to ${pc.bold(what)} ${pc.dim(`(deployed ${timeAgo(target.createdAt)})`)}`);
  if (!o.follow) {
    say(pc.dim(`   Deployment ${d.id} queued. Follow: docksy rollback ${app.name} ${target.id} --follow`));
    return;
  }
  const final = await followDeployment(client, d, say);
  if (o.json) json(ctx, final);
  finishDeploy(ctx, app, final, say);
}

// ───────────────────────────── logs ─────────────────────────────

export async function logsCmd(ctx: Ctx, ref: string, o: { follow?: boolean; tail?: string; json?: boolean }): Promise<void> {
  const client = ctx.client();
  const tail = o.tail ? Number(o.tail) : 200;
  if (!Number.isInteger(tail) || tail < 0) throw new CliError('--tail must be a number.');
  if (!o.follow) {
    const lines = await client.getAppLogs(ref, { tail });
    if (o.json) return json(ctx, { lines });
    for (const l of lines) ctx.print(l);
    if (lines.length === 0) ctx.warn(pc.dim(' (no log output yet)'));
    return;
  }
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once('SIGINT', stop);
  try {
    for await (const ev of client.streamAppLogs(ref, { signal: ac.signal })) {
      if (ev.event !== 'log') continue;
      const line = typeof ev.data === 'string' ? ev.data : ev.data.line;
      ctx.print(o.json ? JSON.stringify({ line }) : line);
    }
  } catch (e) {
    if (!ac.signal.aborted) throw e;
  } finally {
    process.off('SIGINT', stop);
  }
}

// ───────────────────────────── env ─────────────────────────────

export async function envCmd(ctx: Ctx, ref: string, action: string | undefined, args: string[], o: { json?: boolean; reveal?: boolean }): Promise<void> {
  const client = ctx.client();
  const act = action ?? 'ls';
  if (act === 'ls' || act === 'list') {
    if (args.length) throw new CliError(`Unexpected arguments: ${args.join(' ')}`);
    const { vars } = await client.getEnv(ref, { reveal: o.reveal });
    if (o.json) return json(ctx, vars);
    const keys = Object.keys(vars).sort();
    if (keys.length === 0) { ctx.print(` No environment variables. Add some: ${pc.cyan(`docksy env ${ref} set KEY=value`)}`); return; }
    const w = Math.max(...keys.map((k) => k.length));
    for (const k of keys) ctx.print(` ${pc.bold(k.padEnd(w))}  ${o.reveal ? vars[k] : pc.dim(vars[k])}`);
    if (!o.reveal) ctx.print(pc.dim(`\n Values are masked. Show them: docksy env ${ref} ls --reveal`));
    return;
  }
  if (act === 'set') {
    if (args.length === 0) throw new CliError('Nothing to set.', { hint: `docksy env ${ref} set KEY=value [KEY2=value2 …]` });
    const set = parseKeyValues(args);
    await client.patchEnv(ref, { set });
    const n = Object.keys(set).length;
    ctx.print(` ${sym.ok} Set ${n} variable${n === 1 ? '' : 's'} on ${pc.bold(ref)}: ${Object.keys(set).join(', ')}`);
    ctx.print(pc.dim(`   Apply with a redeploy: docksy deploy ${ref}`));
    return;
  }
  if (act === 'unset' || act === 'rm') {
    if (args.length === 0) throw new CliError('Nothing to unset.', { hint: `docksy env ${ref} unset KEY [KEY2 …]` });
    for (const k of args) if (!ENV_KEY_RE.test(k)) throw new CliError(`"${k}" is not a valid variable name.`);
    const cur = (await client.getEnv(ref)).vars;
    const missing = args.filter((k) => !(k in cur));
    await client.patchEnv(ref, { unset: args });
    const removed = args.filter((k) => k in cur);
    ctx.print(` ${sym.ok} Removed ${removed.length ? removed.join(', ') : 'nothing'} from ${pc.bold(ref)}.${missing.length ? pc.dim(` (not set: ${missing.join(', ')})`) : ''}`);
    if (removed.length) ctx.print(pc.dim(`   Apply with a redeploy: docksy deploy ${ref}`));
    return;
  }
  throw new CliError(`Unknown env action "${act}".`, { hint: 'Use ls, set KEY=value… or unset KEY…' });
}
