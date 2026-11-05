import type { App, LogLine } from '@docksy/shared';
import { db, now, type Row } from '../../db/index.ts';
import { q, type ExecResult } from '../../lib/ssh.ts';
import { containerName, defaultDomain, getAppEnv, getGitToken, toApp } from '../apps/model.ts';
import { getServerRow } from '../servers/model.ts';
import { templateCommand } from '../apps/templates.ts';
import * as cmd from './commands.ts';
import { DEFAULT_DOCKERIGNORE, GENERATED_DOCKERFILE, planAutoBuild } from './dockerfiles.ts';
import {
  appendLog, deploymentRefs, findDeploymentRow, finishDeployment, setCurrentDeployment, setDeploymentStatus, updateAppStatus,
} from './model.ts';
import { remote, timing } from './remote.ts';

/**
 * One deployment, end to end (CONTRACT.md §4.1):
 * clone → build (auto/dockerfile/compose/image, or reuse an image for rollback) → tag →
 * run new container → wait healthy → remove old containers → finish → prune.
 * The old container keeps serving until the new one is healthy; on any failure the new
 * container is removed and the old one is left alone.
 */

/** A failure with a message meant for humans (shown as the deployment error). */
export class DeployError extends Error {}
class Cancelled extends Error {}

const BUILD_TIMEOUT_MS = 30 * 60_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;
const SHORT_TIMEOUT_MS = 60_000;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/** Splits streamed chunks into lines, strips ANSI, redacts secrets, writes to the deployment log. */
export class DeployLogger {
  private bufs: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  readonly deploymentId: string;
  readonly secrets: string[];
  constructor(deploymentId: string, secrets: string[]) {
    this.deploymentId = deploymentId;
    this.secrets = secrets;
  }
  write(stream: LogLine['stream'], text: string): void {
    appendLog(this.deploymentId, stream, cmd.redact(text.replace(ANSI_RE, ''), this.secrets));
  }
  system(text: string): void {
    for (const l of text.split('\n')) this.write('system', l);
  }
  chunk = (data: string, stream: 'stdout' | 'stderr'): void => {
    const parts = (this.bufs[stream] + data).split(/\r\n|\n|\r/);
    this.bufs[stream] = parts.pop() ?? '';
    for (const p of parts) if (p.trim() !== '') this.write(stream, p);
    if (this.bufs[stream].length > 16_384) { this.write(stream, this.bufs[stream]); this.bufs[stream] = ''; }
  };
  flush(): void {
    for (const s of ['stdout', 'stderr'] as const) {
      if (this.bufs[s].trim() !== '') this.write(s, this.bufs[s]);
      this.bufs[s] = '';
    }
  }
}

interface Ctx {
  deploymentId: string;
  serverId: string;
  signal: AbortSignal;
  log: DeployLogger;
}

interface StepOpts {
  /** Shown in the log instead of the command (still redacted). */
  display?: string;
  /** Don't echo the command or stream its output. */
  quiet?: boolean;
  allowFail?: boolean;
  timeoutMs?: number;
  /** Error message when the command exits non-zero. */
  fail?: string;
  /** Run even after cancel (cleanup). */
  noSignal?: boolean;
}

function checkAbort(ctx: Ctx): void {
  if (ctx.signal.aborted) throw new Cancelled('Deployment cancelled');
}

async function step(ctx: Ctx, command: string, o: StepOpts = {}): Promise<ExecResult> {
  if (!o.noSignal) checkAbort(ctx);
  if (!o.quiet) ctx.log.system(`$ ${o.display ?? command}`);
  let streamed = false;
  const res = await remote.exec(ctx.serverId, command, {
    timeoutMs: o.timeoutMs ?? SHORT_TIMEOUT_MS,
    signal: o.noSignal ? undefined : ctx.signal,
    onData: o.quiet ? undefined : (d, s) => { streamed = true; ctx.log.chunk(d, s); },
  });
  if (!o.quiet) {
    ctx.log.flush();
    if (!streamed) {
      // The SSH layer may not stream; fall back to the buffered output.
      ctx.log.chunk(res.stdout, 'stdout');
      ctx.log.chunk(res.stderr, 'stderr');
      ctx.log.flush();
    }
  }
  if (!o.noSignal) checkAbort(ctx);
  if (res.code !== 0 && !o.allowFail) throw new DeployError(o.fail ? `${o.fail} (exit code ${res.code})` : `Command failed with exit code ${res.code}`);
  return res;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Domains the container is routed on: configured ones, else the sslip.io default. Databases are not routed by default. */
export function routedDomains(app: App, serverHost: string): string[] {
  if (!app.port) return [];
  if (app.domains.length) return app.domains;
  if (app.kind === 'database') return [];
  const d = defaultDomain(app.name, serverHost);
  return d ? [d] : [];
}

async function dumpContainerLogs(ctx: Ctx, name: string): Promise<void> {
  try {
    const res = await remote.exec(ctx.serverId, cmd.containerLogsTailCommand(name, 50), { timeoutMs: 15_000 });
    const lines = res.stdout.split('\n').filter((l) => l.trim());
    if (!lines.length) return;
    ctx.log.system('Last container output:');
    for (const l of lines) ctx.log.write('stderr', l);
  } catch { /* best effort */ }
}

/** Wait until the new container is healthy. Throws DeployError (after dumping its logs) when it isn't. */
async function waitHealthy(ctx: Ctx, name: string, port: number | null, path: string | null): Promise<void> {
  let mode: 'http' | 'running' = port && path ? 'http' : 'running';
  ctx.log.system(mode === 'http'
    ? `Waiting for http://127.0.0.1:${port}${path!.startsWith('/') ? path : `/${path}`} to answer (up to ${Math.round(timing.healthTimeoutMs / 1000)}s)…`
    : `Waiting for the container to stay up for ${Math.round(timing.stableMs / 1000)}s…`);
  const deadline = Date.now() + timing.healthTimeoutMs;
  let runningSince: number | null = null;
  let lastProbe = '';
  for (;;) {
    checkAbort(ctx);
    const st = await step(ctx, cmd.inspectStateCommand(name), { quiet: true, allowFail: true, timeoutMs: 20_000 });
    const state = st.code === 0 ? cmd.parseState(st.stdout) : null;
    if (!state) { await dumpContainerLogs(ctx, name); throw new DeployError('The new container disappeared before it became healthy'); }
    if (state.status === 'exited' || state.status === 'dead') {
      await dumpContainerLogs(ctx, name);
      throw new DeployError(state.oomKilled
        ? 'The new container ran out of memory and was killed'
        : `The new container exited with code ${state.exitCode} before it became healthy`);
    }
    if (state.restarts > 0 || state.status === 'restarting') {
      await dumpContainerLogs(ctx, name);
      throw new DeployError(`The new container is crash-looping (restarted ${state.restarts} time${state.restarts === 1 ? '' : 's'})`);
    }
    if (state.status === 'running') runningSince ??= Date.now();
    else runningSince = null;

    if (runningSince !== null && mode === 'http') {
      const pr = await step(ctx, cmd.healthProbeCommand(name, port!, path!), { quiet: true, allowFail: true, timeoutMs: 15_000 });
      if (pr.code === 0) { ctx.log.system('Health check passed.'); return; }
      if (pr.code === cmd.PROBE_UNAVAILABLE || pr.code === 126) {
        ctx.log.system('The image has no wget or curl, so the HTTP health check is skipped; waiting for the container to stay up instead.');
        mode = 'running';
      } else {
        lastProbe = (pr.stderr || pr.stdout).trim().split('\n').pop() ?? '';
      }
    }
    if (runningSince !== null && mode === 'running' && Date.now() - runningSince >= timing.stableMs) {
      ctx.log.system('Container is up.');
      return;
    }
    if (Date.now() >= deadline) {
      await dumpContainerLogs(ctx, name);
      throw new DeployError(`Health check timed out after ${Math.round(timing.healthTimeoutMs / 1000)}s${lastProbe ? `: ${lastProbe}` : ''}`);
    }
    await sleep(timing.pollMs, ctx.signal);
  }
}

async function waitComposeHealthy(ctx: Ctx, appName: string): Promise<void> {
  ctx.log.system('Waiting for compose services to come up…');
  const deadline = Date.now() + timing.healthTimeoutMs;
  let runningSince: number | null = null;
  for (;;) {
    checkAbort(ctx);
    const res = await step(ctx, cmd.composePsCommand(appName), { quiet: true, allowFail: true, timeoutMs: 20_000 });
    const svcs = cmd.parseComposePs(res.stdout);
    const restarting = svcs.filter((s) => s.state === 'restarting');
    if (restarting.length) throw new DeployError(`Compose service${restarting.length > 1 ? 's' : ''} crash-looping: ${restarting.map((s) => s.service).join(', ')}`);
    const up = svcs.some((s) => s.state === 'running');
    runningSince = up ? runningSince ?? Date.now() : null;
    if (runningSince !== null && Date.now() - runningSince >= timing.stableMs) {
      ctx.log.system(`Services: ${svcs.map((s) => `${s.service} (${s.state})`).join(', ')}`);
      return;
    }
    if (Date.now() >= deadline) throw new DeployError(`No compose service was running after ${Math.round(timing.healthTimeoutMs / 1000)}s`);
    await sleep(timing.pollMs, ctx.signal);
  }
}

/** Build from a git repo. Returns the image tag, or null for compose (compose runs the app itself). */
async function buildFromGit(ctx: Ctx, app: App, appRow: Row, tag: string, envFile: () => Promise<string | null>): Promise<{ image: string | null; port: number | null }> {
  const dir = cmd.buildDir(app.name, ctx.deploymentId);
  const token = getGitToken(appRow);
  const branch = deploymentRefs.get(ctx.deploymentId) ?? app.branch;
  ctx.log.system(`Cloning ${cmd.cleanRepoUrl(app.repoUrl!)}${branch ? ` (${branch})` : ''}…`);
  await step(ctx, cmd.cloneCommand({ repoUrl: app.repoUrl!, branch, dir, token }), {
    display: cmd.cloneCommand({ repoUrl: app.repoUrl!, branch, dir, token: token ? '***' : null }),
    timeoutMs: CLONE_TIMEOUT_MS,
    fail: 'Could not clone the repository. Check the URL, branch and access token',
  });
  const info = cmd.parseCommitInfo((await step(ctx, cmd.commitInfoCommand(dir), { quiet: true, allowFail: true })).stdout);
  if (info.sha) {
    db.prepare('UPDATE deployments SET commit_sha = ?, commit_message = ? WHERE id = ?').run(info.sha, info.message, ctx.deploymentId);
    ctx.log.system(`Commit ${info.sha.slice(0, 7)}${info.message ? `: ${info.message}` : ''}`);
  }

  if (app.buildType === 'compose') {
    const env = await envFile();
    ctx.log.system('Starting with docker compose (env vars are available for ${VAR} interpolation in your compose file).');
    await step(ctx, cmd.composeUpCommand({ dir, appName: app.name, composePath: app.composePath, envFile: env }), {
      timeoutMs: BUILD_TIMEOUT_MS, fail: 'docker compose up failed',
    });
    return { image: null, port: app.port };
  }

  const labels = { 'docksy.app': app.id, 'docksy.deployment': ctx.deploymentId };
  const contextDir = cmd.joinPath(dir, app.buildContext);
  let dockerfile = app.dockerfilePath;
  let port = app.port;

  if (app.buildType === 'auto') {
    const probe = cmd.parseProbe((await step(ctx, cmd.probeCommand(dir, contextDir, app.dockerfilePath), {
      quiet: true, allowFail: true, timeoutMs: 30_000,
    })).stdout);
    if (!probe.files.length && !probe.hasDockerfile) throw new DeployError(`Build context "${app.buildContext}" was not found in the repository`);
    const plan = planAutoBuild(probe, app.port);
    if (!plan) {
      throw new DeployError("Couldn't work out how to build this repo (no Dockerfile, package.json, requirements.txt, pyproject.toml, go.mod or index.html). Add a Dockerfile (Claude can write one with /docksy:dockerize) or deploy an image.");
    }
    if (plan.kind === 'dockerfile') {
      ctx.log.system(`Using ${app.dockerfilePath} from the repository.`);
    } else {
      ctx.log.system(`No Dockerfile found. Detected: ${plan.summary}`);
      ctx.log.system('Generated Dockerfile:');
      for (const l of plan.dockerfile.trimEnd().split('\n')) ctx.log.write('system', `  ${l}`);
      checkAbort(ctx);
      await remote.putFile(ctx.serverId, cmd.joinPath(contextDir, GENERATED_DOCKERFILE), plan.dockerfile, 0o644);
      if (!probe.files.includes('.dockerignore')) await remote.putFile(ctx.serverId, cmd.joinPath(contextDir, '.dockerignore'), DEFAULT_DOCKERIGNORE, 0o644);
      dockerfile = cmd.joinPath(app.buildContext, GENERATED_DOCKERFILE).replace(/^\.\//, '');
      if (!app.port) {
        port = plan.port;
        db.prepare('UPDATE apps SET port = ?, updated_at = ? WHERE id = ? AND port IS NULL').run(port, now(), app.id);
        ctx.log.system(`No port was set; using ${port}. You can change it in the app settings.`);
      }
    }
  }

  ctx.log.system('Building image…');
  await step(ctx, cmd.dockerBuildCommand({ dir, dockerfile, context: app.buildContext, tag, labels }), {
    timeoutMs: BUILD_TIMEOUT_MS, fail: 'Image build failed',
  });
  return { image: tag, port };
}

/**
 * Run one queued deployment. Never throws: every outcome ends in finishDeployment().
 * `signal` aborts it (cancel); cleanup still runs.
 */
export async function runDeployment(deploymentId: string, signal: AbortSignal): Promise<void> {
  const d = findDeploymentRow(deploymentId);
  if (!d || d.status !== 'queued') return;
  const appRow = db.prepare('SELECT * FROM apps WHERE id = ?').get(d.app_id) as Row | undefined;
  if (!appRow) { finishDeployment(deploymentId, 'failed', 'The app no longer exists'); return; }
  const app = toApp(appRow);

  let token: string | null = null;
  try { token = getGitToken(appRow); } catch { /* undecryptable token: clone will fail with a clear error */ }
  const log = new DeployLogger(deploymentId, token ? [token] : []);
  const ctx: Ctx = { deploymentId, serverId: app.serverId, signal, log };
  const newName = containerName(app.name, deploymentId);
  const tag = cmd.imageTag(app.name, deploymentId);
  const envPath = cmd.envFilePath(app.name, deploymentId);
  let envUploaded = false;
  let containerCreated = false;
  let liveTag: string | null = null;

  const uploadEnv = async (port: number | null): Promise<string | null> => {
    const env = getAppEnv(app.id);
    if (port && !('PORT' in env)) env.PORT = String(port);
    const { content, skipped } = cmd.renderEnvFile(env);
    if (skipped.length) log.system(`Skipped env vars that can't be passed to Docker (multi-line value or invalid name): ${skipped.join(', ')}`);
    checkAbort(ctx);
    await remote.putFile(app.serverId, envPath, content, 0o600);
    envUploaded = true;
    return envPath;
  };
  const removeEnv = async () => {
    if (!envUploaded) return;
    envUploaded = false;
    await step(ctx, `rm -f ${q(envPath)}`, { quiet: true, allowFail: true, noSignal: true }).catch(() => {});
  };

  try {
    const server = getServerRow(app.serverId);
    setDeploymentStatus(deploymentId, app.id, 'building', { startedAt: now() });
    updateAppStatus(app.id, 'deploying');
    log.system(`Deploying ${app.name} to ${server.name} (${server.host}) · deployment ${deploymentId.slice(0, 8)} · trigger: ${d.trigger}`);
    await step(ctx, `mkdir -p ${q(cmd.buildDir(app.name, deploymentId))}`, { quiet: true, fail: 'Could not create the build directory' });

    let image: string | null;
    let port = app.port;
    if (d.trigger === 'rollback' && d.image_tag) {
      image = d.image_tag as string;
      log.system(`Rolling back to image ${image}.`);
      await step(ctx, cmd.imageExistsCommand(image), {
        quiet: true,
        fail: `Image ${image} is no longer on the server (Docksy keeps the last ${cmd.KEEP_IMAGES} images per app). Deploy again instead`,
      });
    } else if (app.sourceType === 'image' || app.buildType === 'image') {
      if (!app.image) throw new DeployError('This app has no image set');
      await step(ctx, cmd.pullCommand(app.image), { timeoutMs: BUILD_TIMEOUT_MS, fail: `Could not pull ${app.image}` });
      await step(ctx, cmd.tagCommand(app.image, tag), { quiet: true, fail: 'Could not tag the image' });
      image = tag;
    } else {
      if (!app.repoUrl) throw new DeployError('This app has no repository URL set');
      const built = await buildFromGit(ctx, app, appRow, tag, () => uploadEnv(app.port));
      image = built.image;
      port = built.port;
    }

    checkAbort(ctx);
    setDeploymentStatus(deploymentId, app.id, 'deploying', { imageTag: image });

    if (image === null) {
      // compose: already started by `docker compose up`
      await removeEnv();
      await waitComposeHealthy(ctx, app.name);
    } else {
      liveTag = image;
      const domains = routedDomains({ ...app, port }, server.host);
      if (domains.length) log.system(`Routing ${domains.map((x) => `https://${x}`).join(', ')} → port ${port}`);
      else if (!port && app.kind !== 'database') log.system('No port is set, so the app is not exposed through the proxy.');
      const env = await uploadEnv(port);
      await step(ctx, cmd.removeContainerCommand(newName), { quiet: true, allowFail: true });
      log.system('Starting new container…');
      containerCreated = true;
      try {
        await step(ctx, cmd.runCommand({
          name: newName, image, appId: app.id, appName: app.name, deploymentId, envFile: env, volumes: app.volumes, domains, port,
          command: templateCommand(app.template),
          startCommand: app.startCommand, cpuLimit: app.cpuLimit, memLimitMb: app.memLimitMb,
        }), { fail: 'Could not start the container' });
      } finally {
        await removeEnv();
      }
      await waitHealthy(ctx, newName, port, app.healthcheckPath);
    }

    // Zero-downtime swap: the new container is healthy, now retire the old ones.
    const others = (await step(ctx, cmd.listAppContainersCommand(app.id), { quiet: true, allowFail: true })).stdout
      .split('\n').map((s) => s.trim()).filter((s) => s && s !== newName);
    if (others.length) {
      log.system(`Removing previous container${others.length > 1 ? 's' : ''}: ${others.join(', ')}`);
      await step(ctx, cmd.removeContainersCommand(others), { quiet: true, allowFail: true, noSignal: true, timeoutMs: 90_000 });
    }

    setCurrentDeployment(app.id, deploymentId);
    updateAppStatus(app.id, 'running');
    log.system('✓ Deployment succeeded.');
    finishDeployment(deploymentId, 'succeeded', null);

    // Housekeeping never fails a deployment.
    await step(ctx, cmd.pruneBuildDirsCommand(app.name), { quiet: true, allowFail: true, noSignal: true }).catch(() => {});
    await step(ctx, cmd.pruneImagesCommand(app.name, liveTag), { quiet: true, allowFail: true, noSignal: true, timeoutMs: 120_000 }).catch(() => {});
  } catch (e) {
    const cancelled = signal.aborted || e instanceof Cancelled;
    const message = cancelled ? 'Deployment cancelled' : e instanceof DeployError ? e.message : `Unexpected error: ${(e as Error)?.message ?? String(e)}`;
    log.flush();
    log.system(cancelled ? 'Deployment cancelled.' : `✗ ${message}`);
    await removeEnv();
    if (containerCreated) {
      log.system('Removing the new container; the previous version keeps running.');
      await step(ctx, cmd.removeContainerCommand(newName), { quiet: true, allowFail: true, noSignal: true }).catch(() => {});
    }
    let stillRunning = false;
    try {
      const r = await remote.exec(app.serverId, cmd.runningAppContainersCommand(app.id, app.name), { timeoutMs: 20_000 });
      stillRunning = r.code === 0 && r.stdout.trim() !== '';
    } catch { /* server unreachable */ }
    // The previous version (if any) is still serving: the app stays "running".
    updateAppStatus(app.id, stillRunning ? 'running' : cancelled && !appRow.current_deployment_id ? 'idle' : 'failed');
    finishDeployment(deploymentId, cancelled ? 'cancelled' : 'failed', message);
  } finally {
    await removeEnv();
  }
}
