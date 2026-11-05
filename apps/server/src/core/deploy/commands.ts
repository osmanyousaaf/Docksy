import type { Volume } from '@docksy/shared';
import { q } from '../../lib/ssh.ts';
import { composeProject, imageRepo, volumeName } from '../apps/model.ts';

/**
 * Pure shell-command builders for the deploy engine. Every user-controlled value goes
 * through q(). Nothing here touches the network or the database, so it is unit-tested
 * by exact string comparison.
 */

export const BUILD_ROOT = '/var/lib/docksy/builds';
export const NETWORK = 'docksy';
export const KEEP_BUILDS = 5;
export const KEEP_IMAGES = 5;

export const appBuildRoot = (appName: string) => `${BUILD_ROOT}/${appName}`;
export const buildDir = (appName: string, deploymentId: string) => `${BUILD_ROOT}/${appName}/${deploymentId}`;
/**
 * The env file lives next to (not inside) the build dir so it can never end up in a
 * docker build context, and it is a dotfile so build-dir pruning ignores it.
 */
export const envFilePath = (appName: string, deploymentId: string) => `${BUILD_ROOT}/${appName}/.env.${deploymentId}`;
export const imageTag = (appName: string, deploymentId: string) => `${imageRepo(appName)}:${deploymentId.slice(0, 8)}`;

/** Join path segments relative to a base without producing "./" noise. */
export function joinPath(base: string, rel: string): string {
  const r = rel.replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (r === '' || r === '.') return base;
  return `${base.replace(/\/+$/, '')}/${r}`;
}

// ───────────────────────────── secrets ─────────────────────────────

/** Replace every occurrence of each secret (and its URL-encoded form) with ***. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    for (const v of new Set([s, encodeURIComponent(s)])) out = out.split(v).join('***');
  }
  return out;
}

// ───────────────────────────── git ─────────────────────────────

/** Strip any credentials from an https URL. Non-URL inputs (git@host:repo) are returned unchanged. */
export function cleanRepoUrl(repoUrl: string): string {
  try {
    const u = new URL(repoUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return repoUrl;
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return repoUrl;
  }
}

/** https://x-access-token:<token>@host/... (only for http(s) URLs). */
export function authedRepoUrl(repoUrl: string, token: string | null): string {
  if (!token) return repoUrl;
  try {
    const u = new URL(cleanRepoUrl(repoUrl));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return repoUrl;
    u.username = 'x-access-token';
    u.password = token;
    return u.toString();
  } catch {
    return repoUrl;
  }
}

export interface CloneSpec { repoUrl: string; branch: string | null; dir: string; token: string | null }

/** Fresh shallow clone; the token is removed from .git/config right after. */
export function cloneCommand(s: CloneSpec): string {
  const branch = s.branch ? ` -b ${q(s.branch)}` : '';
  const parts = [
    `rm -rf ${q(s.dir)}`,
    `mkdir -p ${q(s.dir)}`,
    `GIT_TERMINAL_PROMPT=0 git clone --depth 1 --single-branch${branch} -- ${q(authedRepoUrl(s.repoUrl, s.token))} ${q(s.dir)}`,
  ];
  if (s.token) parts.push(`git -C ${q(s.dir)} remote set-url origin ${q(cleanRepoUrl(s.repoUrl))}`);
  return parts.join(' && ');
}

export const commitInfoCommand = (dir: string) => `git -C ${q(dir)} log -1 --format='%H%n%s'`;

export function parseCommitInfo(stdout: string): { sha: string | null; message: string | null } {
  const [sha, ...rest] = stdout.trim().split('\n');
  const okSha = sha && /^[0-9a-f]{7,64}$/i.test(sha.trim()) ? sha.trim() : null;
  const message = rest.join('\n').trim() || null;
  return { sha: okSha, message: message ? message.slice(0, 500) : null };
}

// ───────────────────────────── repo probe (auto build) ─────────────────────────────

/** Files whose contents feed Dockerfile autodetection. */
export const PROBE_FILES = ['package.json', 'requirements.txt', 'pyproject.toml', 'Procfile', 'go.mod'] as const;

/**
 * Print a listing of the build context plus the contents of the files autodetection
 * needs, separated by marker lines. `dockerfileRel` is checked relative to `repoDir`.
 */
export function probeCommand(repoDir: string, contextDir: string, dockerfileRel: string): string {
  const files = PROBE_FILES.join(' ');
  return [
    `cd ${q(contextDir)}`,
    `echo '::docksy-ls::'`,
    `ls -1Ap`,
    `ls -1d */wsgi.py */asgi.py cmd/*/ 2>/dev/null || true`,
    `for f in ${files}; do if [ -f "$f" ]; then echo "::docksy-file:: $f"; head -c 65536 "$f"; echo; fi; done`,
    `if [ -f ${q(joinPath(repoDir, dockerfileRel))} ]; then echo '::docksy-dockerfile::'; fi`,
    `echo '::docksy-end::'`,
  ].join(' && ');
}

export interface Probe { files: string[]; contents: Record<string, string>; hasDockerfile: boolean }

export function parseProbe(stdout: string): Probe {
  const files: string[] = [];
  const contents: Record<string, string> = {};
  let hasDockerfile = false;
  let mode: 'none' | 'ls' | 'file' = 'none';
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current) contents[current] = buf.join('\n').replace(/\n$/, '');
    current = null;
    buf = [];
  };
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '::docksy-ls::') { flush(); mode = 'ls'; continue; }
    if (line.startsWith('::docksy-file:: ')) { flush(); mode = 'file'; current = line.slice(16).trim(); continue; }
    if (line === '::docksy-dockerfile::') { flush(); mode = 'none'; hasDockerfile = true; continue; }
    if (line === '::docksy-end::') { flush(); mode = 'none'; continue; }
    if (mode === 'ls') { if (line.trim()) files.push(line.trim()); }
    else if (mode === 'file') buf.push(line);
  }
  flush();
  return { files, contents, hasDockerfile };
}

// ───────────────────────────── build ─────────────────────────────

export interface BuildSpec { dir: string; dockerfile: string; context: string; tag: string; labels: Record<string, string> }

/** docker build run from the repo dir; dockerfile and context are relative to it. */
export function dockerBuildCommand(s: BuildSpec): string {
  const labels = Object.entries(s.labels).map(([k, v]) => ` --label ${q(`${k}=${v}`)}`).join('');
  return `cd ${q(s.dir)} && docker build -t ${q(s.tag)} -f ${q(s.dockerfile)}${labels} ${q(s.context || '.')}`;
}

export const pullCommand = (image: string) => `docker pull ${q(image)}`;
export const tagCommand = (src: string, dst: string) => `docker tag ${q(src)} ${q(dst)}`;
export const imageExistsCommand = (tag: string) => `docker image inspect ${q(tag)} >/dev/null 2>&1`;

export interface ComposeSpec { dir: string; appName: string; composePath: string; envFile: string | null }

export function composeUpCommand(s: ComposeSpec): string {
  const env = s.envFile ? ` --env-file ${q(s.envFile)}` : '';
  return `cd ${q(s.dir)} && docker compose -p ${q(composeProject(s.appName))} -f ${q(s.composePath)}${env} up -d --build --remove-orphans`;
}

export const composePsCommand = (appName: string) => `docker compose -p ${q(composeProject(appName))} ps -a --format '{{.Service}} {{.State}}'`;

/** Parse `docker compose ps --format '{{.Service}} {{.State}}'` output. */
export function parseComposePs(stdout: string): { service: string; state: string }[] {
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.lastIndexOf(' ');
    return i < 0 ? { service: l, state: 'unknown' } : { service: l.slice(0, i), state: l.slice(i + 1).toLowerCase() };
  });
}

// ───────────────────────────── env file ─────────────────────────────

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * Render a docker --env-file. Docker reads values literally (no quotes, no escapes),
 * so values with newlines and invalid keys cannot be represented and are skipped.
 */
export function renderEnvFile(env: Record<string, string>): { content: string; skipped: string[] } {
  const lines: string[] = [];
  const skipped: string[] = [];
  for (const [k, v] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
    const val = String(v);
    if (!ENV_KEY_RE.test(k) || /[\r\n\0]/.test(val)) { skipped.push(k); continue; }
    lines.push(`${k}=${val}`);
  }
  return { content: lines.length ? `${lines.join('\n')}\n` : '', skipped };
}

// ───────────────────────────── run ─────────────────────────────

export function appLabels(appId: string, deploymentId: string): Record<string, string> {
  return { 'docksy.managed': 'true', 'docksy.app': appId, 'docksy.deployment': deploymentId };
}

export function caddyLabels(domains: readonly string[], port: number): Record<string, string> {
  return { caddy: domains.join(', '), 'caddy.reverse_proxy': `{{upstreams ${port}}}` };
}

export interface RunSpec {
  name: string;
  image: string;
  appId: string;
  appName: string;
  deploymentId: string;
  envFile: string | null;
  volumes: readonly Volume[];
  /** Routed through Caddy only when non-empty and port is set. */
  domains: readonly string[];
  port: number | null;
  /** Command/args appended after the image (template apps, e.g. redis --requirepass). */
  command?: readonly string[] | null;
  /** User start command (overrides CMD; run via sh -c). Ignored when `command` is set. */
  startCommand?: string | null;
  cpuLimit?: number | null;
  memLimitMb?: number | null;
}

export function runCommand(s: RunSpec): string {
  const labels: Record<string, string> = { ...appLabels(s.appId, s.deploymentId) };
  if (s.domains.length && s.port) Object.assign(labels, caddyLabels(s.domains, s.port));
  const args = [
    'docker run -d',
    `--name ${q(s.name)}`,
    `--network ${NETWORK}`,
    `--network-alias ${q(s.appName)}`,
    '--restart unless-stopped',
    ...Object.entries(labels).map(([k, v]) => `--label ${q(`${k}=${v}`)}`),
  ];
  if (s.cpuLimit) args.push(`--cpus ${q(String(s.cpuLimit))}`);
  if (s.memLimitMb) args.push(`--memory ${q(`${Math.round(s.memLimitMb)}m`)}`);
  if (s.envFile) args.push(`--env-file ${q(s.envFile)}`);
  for (const v of s.volumes) args.push(`-v ${q(`${volumeName(s.appName, v.name)}:${v.mountPath}`)}`);
  args.push(q(s.image));
  if (s.command?.length) args.push(...s.command.map(q));
  else if (s.startCommand?.trim()) args.push('sh -c', q(s.startCommand.trim()));
  return args.join(' ');
}

/** Remove a container if it exists (never fails). */
export const removeContainerCommand = (name: string) => `docker rm -f ${q(name)} >/dev/null 2>&1 || true`;

/** Names of every container (any state) belonging to an app. */
export const listAppContainersCommand = (appId: string) => `docker ps -a --filter ${q(`label=docksy.app=${appId}`)} --format '{{.Names}}'`;

/** Running containers of an app, including compose ones. Prints ids. */
export const runningAppContainersCommand = (appId: string, appName: string) =>
  `{ docker ps -q --filter ${q(`label=docksy.app=${appId}`)}; docker ps -q --filter ${q(`label=com.docker.compose.project=${composeProject(appName)}`)}; } | sort -u`;

/** Gracefully stop then remove the given containers. */
export function removeContainersCommand(names: readonly string[], graceSec = 10): string {
  const list = names.map(q).join(' ');
  return `docker stop -t ${graceSec} ${list} >/dev/null 2>&1; docker rm -f ${list}`;
}

// ───────────────────────────── health ─────────────────────────────

export const inspectStateCommand = (name: string) =>
  `docker inspect -f '{{.State.Status}}|{{.RestartCount}}|{{.State.ExitCode}}|{{.State.OOMKilled}}' ${q(name)}`;

export interface ContainerState { status: string; restarts: number; exitCode: number; oomKilled: boolean }

export function parseState(stdout: string): ContainerState | null {
  const line = stdout.trim().split('\n').pop() ?? '';
  const [status, restarts, exitCode, oom] = line.split('|');
  if (!status || restarts === undefined) return null;
  return { status: status.trim(), restarts: Number(restarts) || 0, exitCode: Number(exitCode) || 0, oomKilled: oom?.trim() === 'true' };
}

/** Exit code the probe uses when the image has neither wget nor curl (or no shell). */
export const PROBE_UNAVAILABLE = 127;

export function healthProbeCommand(name: string, port: number, path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  const url = `http://127.0.0.1:${port}${p}`;
  const script =
    `if command -v wget >/dev/null 2>&1; then wget -q -T 5 -O /dev/null ${q(url)}; ` +
    `elif command -v curl >/dev/null 2>&1; then curl -fsS -m 5 -o /dev/null ${q(url)}; ` +
    `else exit ${PROBE_UNAVAILABLE}; fi`;
  return `docker exec ${q(name)} sh -c ${q(script)}`;
}

export const containerLogsTailCommand = (name: string, tail: number) => `docker logs --tail ${Math.max(1, Math.floor(tail))} ${q(name)} 2>&1`;

// ───────────────────────────── runtime logs / lifecycle ─────────────────────────────

/** Newest container of the app (managed label first, then compose project). Prints a container id. */
export const appContainerSelector = (appId: string, appName: string) =>
  `$( { docker ps -q --filter ${q(`label=docksy.app=${appId}`)}; docker ps -q --filter ${q(`label=com.docker.compose.project=${composeProject(appName)}`)}; } | head -n1)`;

export function appLogsCommand(appId: string, appName: string, tail: number, follow: boolean): string {
  const n = Math.min(Math.max(1, Math.floor(tail) || 200), 5000);
  return `c=${appContainerSelector(appId, appName)}; if [ -z "$c" ]; then exit 3; fi; docker logs ${follow ? '-f ' : ''}--tail ${n} "$c" 2>&1`;
}

export type LifecycleAction = 'restart' | 'stop' | 'start';

/** Exit 3 when the app has no containers. */
export function lifecycleCommand(action: LifecycleAction, appId: string, appName: string): string {
  const ids = `{ docker ps -aq --filter ${q(`label=docksy.app=${appId}`)}; docker ps -aq --filter ${q(`label=com.docker.compose.project=${composeProject(appName)}`)}; } | sort -u`;
  return `ids=$(${ids}); if [ -z "$ids" ]; then exit 3; fi; docker ${action} $ids`;
}

// ───────────────────────────── prune ─────────────────────────────

export function pruneBuildDirsCommand(appName: string, keep = KEEP_BUILDS): string {
  return `cd ${q(appBuildRoot(appName))} 2>/dev/null && ls -1t | tail -n +${keep + 1} | xargs -r rm -rf -- ; true`;
}

/** Keep the newest `keep` images of the app's repo, never removing `protect` (the live tag). */
export function pruneImagesCommand(appName: string, protect: string | null, keep = KEEP_IMAGES): string {
  const filter = protect ? ` | grep -vxF ${q(protect)}` : '';
  return `docker image ls ${q(imageRepo(appName))} --format '{{.Repository}}:{{.Tag}}' | tail -n +${keep + 1}${filter} | xargs -r docker rmi >/dev/null 2>&1; true`;
}
