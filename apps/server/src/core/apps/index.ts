import type { Hono } from 'hono';
import { z } from 'zod';
import type { App, AppKind, BuildType, EnvVars, Template, Volume } from '@docksy/shared';
import { db, json, newId, now, tx, type Row } from '../../db/index.ts';
import { encrypt, mask, randomToken } from '../../lib/crypto.ts';
import { HttpError, badRequest, conflict, body, logActivity, type AppEnv } from '../../lib/http.ts';
import { requireUser } from '../../lib/auth.ts';
import { bus } from '../../lib/events.ts';
import { exec as sshExec, q } from '../../lib/ssh.ts';
import { enqueueDeployment as realEnqueue } from '../deploy/queue.ts';
import { getServerRow } from '../servers/model.ts';
import {
  APP_NAME_RE, toApp, getAppRow, getAppEnv, setAppEnv, defaultDomain, composeProject, volumeName, imageRepo,
} from './model.ts';
import { TEMPLATES, getTemplate } from './templates.ts';
import { expandEnv, normalizeRepoUrl, verifyGithubSignature } from './expand.ts';

// ───────────────────────── injectable seam (tests swap these) ─────────────────────────

export const deps = {
  enqueueDeployment: realEnqueue,
  exec: sshExec,
};

/** Override side-effecting dependencies (tests). Returns a restore function. */
export function setAppsDeps(patch: Partial<typeof deps>): () => void {
  const prev = { ...deps };
  Object.assign(deps, patch);
  return () => { Object.assign(deps, prev); };
}

// ───────────────────────── validation ─────────────────────────

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._\/:@-]{0,254}$/;
const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]{1,200}$/;

const relPath = z.string().trim().min(1).max(255)
  .regex(/^[A-Za-z0-9._\/-]+$/, 'Only letters, digits and . _ / - are allowed')
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'Must be a relative path inside the repository');

const envSchema = z.record(z.string().regex(ENV_KEY_RE, 'Invalid env var name').max(255), z.string().max(65_536));

const volumeSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/, 'Volume names are lowercase letters, digits, . _ -'),
  mountPath: z.string().regex(/^\/[A-Za-z0-9._\/-]*$/, 'Mount path must be absolute').refine((p) => p !== '/', 'Cannot mount over /'),
});

const domainsSchema = z.array(
  z.string().trim().toLowerCase().regex(HOST_RE, 'Invalid domain'),
).max(20);

const repoUrlSchema = z.string().trim().min(1).max(500).transform(normalizeRepoUrl)
  .refine((u) => /^https?:\/\/[^\s'"`$\\]+$/.test(u), 'Repository must be an https URL or owner/repo');

const appName = z.string().trim().regex(APP_NAME_RE, 'Name must be 3–40 chars: lowercase letters, digits and dashes, starting with a letter');

const buildTypeSchema = z.enum(['auto', 'dockerfile', 'compose', 'image']);

const createSchema = z.object({
  name: appName,
  serverId: z.string().min(1),
  template: z.string().min(1).optional(),
  sourceType: z.enum(['git', 'image']).optional(),
  repoUrl: repoUrlSchema.optional(),
  branch: z.string().trim().regex(BRANCH_RE, 'Invalid branch name').optional(),
  gitToken: z.string().trim().max(1000).optional(),
  image: z.string().trim().regex(IMAGE_RE, 'Invalid image reference').optional(),
  buildType: buildTypeSchema.optional(),
  dockerfilePath: relPath.optional(),
  buildContext: relPath.optional(),
  composePath: relPath.optional(),
  port: z.number().int().min(1).max(65535).optional(),
  domains: domainsSchema.optional(),
  healthcheckPath: z.string().regex(/^\/[^\s'"`$\\]*$/, 'Health check path must start with /').max(500).nullable().optional(),
  volumes: z.array(volumeSchema).max(20).optional(),
  env: envSchema.optional(),
  autoDeploy: z.boolean().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  startCommand: z.string().trim().max(2000).nullable().optional(),
  watchPaths: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  cpuLimit: z.number().min(0.05).max(256).nullable().optional(),
  memLimitMb: z.number().int().min(16).max(1_048_576).nullable().optional(),
});

const updateSchema = createSchema.omit({ serverId: true, template: true }).partial().extend({
  gitToken: z.string().trim().max(1000).nullable().optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  repoUrl: repoUrlSchema.nullable().optional(),
  image: z.string().trim().regex(IMAGE_RE, 'Invalid image reference').nullable().optional(),
});

const envBodySchema = z.object({ vars: envSchema });

// ───────────────────────── helpers ─────────────────────────

const hasDupes = (xs: string[]) => new Set(xs).size !== xs.length;

function assertNameFree(name: string, exceptId?: string): void {
  const r = db.prepare('SELECT id FROM apps WHERE name = ?').get(name) as Row | undefined;
  if (r && r.id !== exceptId) throw conflict(`An app named "${name}" already exists`);
}

function assertDomainsFree(domains: string[], exceptId?: string): void {
  if (!domains.length) return;
  const rows = db.prepare('SELECT id, name, domains FROM apps').all() as Row[];
  for (const r of rows) {
    if (r.id === exceptId) continue;
    const taken = (JSON.parse(r.domains ?? '[]') as string[]).filter((d) => domains.includes(d));
    if (taken.length) throw conflict(`Domain ${taken[0]} is already used by app "${r.name}"`);
  }
}

function checkVolumes(vols: Volume[]): void {
  if (hasDupes(vols.map((v) => v.name))) throw badRequest('Volume names must be unique');
  if (hasDupes(vols.map((v) => v.mountPath))) throw badRequest('Volume mount paths must be unique');
}

function maskVars(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) out[k] = mask(v);
  return out;
}

type CreateInput = z.infer<typeof createSchema>;

/** Build the row for a new app (pure apart from the server lookup). Exported for tests. */
export function planApp(input: CreateInput): { row: Row; env: Record<string, string>; gitToken: string | null } {
  const server = (() => {
    try { return getServerRow(input.serverId); } catch { throw badRequest(`Server ${input.serverId} not found`); }
  })();

  let tpl: Template | undefined;
  if (input.template) {
    tpl = getTemplate(input.template);
    if (!tpl) throw badRequest(`Unknown template "${input.template}". See GET /api/v1/templates`);
  }

  const kind: AppKind = tpl?.kind ?? 'app';
  let sourceType: 'git' | 'image';
  let buildType: BuildType;
  let image: string | null = null;
  let repoUrl: string | null = null;
  let branch: string | null = null;

  if (tpl) {
    if (input.sourceType === 'git' || input.repoUrl) throw badRequest('Template apps run an image; leave out repoUrl/sourceType');
    sourceType = 'image';
    buildType = 'image';
    image = input.image ?? tpl.image;
  } else {
    sourceType = input.sourceType ?? (input.image && !input.repoUrl ? 'image' : 'git');
    if (sourceType === 'git') {
      if (!input.repoUrl) throw badRequest('repoUrl is required for git apps (https URL or owner/repo)');
      repoUrl = input.repoUrl;
      branch = input.branch ?? 'main';
      buildType = input.buildType ?? 'auto';
      if (buildType === 'image') throw badRequest('buildType "image" needs sourceType "image"');
    } else {
      if (!input.image) throw badRequest('image is required for image apps (e.g. nginx:1.27)');
      if (input.repoUrl) throw badRequest('Image apps cannot have a repoUrl');
      if (input.buildType && input.buildType !== 'image') throw badRequest('Image apps use buildType "image"');
      image = input.image;
      buildType = 'image';
    }
  }

  const port = input.port ?? tpl?.port ?? null;
  const volumes = input.volumes ?? tpl?.volumes ?? [];
  checkVolumes(volumes);

  let domains = [...new Set(input.domains ?? [])];
  if (!domains.length && kind !== 'database') {
    const d = defaultDomain(input.name, server.host);
    if (d) domains = [d];
  }

  const ctx = { domain: domains[0] ?? null };
  const env = { ...expandEnv(tpl?.env ?? {}, ctx), ...expandEnv(input.env ?? {}, ctx) };

  const t = now();
  const row: Row = {
    id: newId(),
    name: input.name,
    server_id: server.id,
    kind,
    template: tpl?.id ?? null,
    source_type: sourceType,
    repo_url: repoUrl,
    branch,
    image,
    build_type: buildType,
    dockerfile_path: input.dockerfilePath ?? 'Dockerfile',
    build_context: input.buildContext ?? '.',
    compose_path: input.composePath ?? 'docker-compose.yml',
    port,
    domains: JSON.stringify(domains),
    healthcheck_path: input.healthcheckPath ?? null,
    volumes: JSON.stringify(volumes),
    description: input.description || null,
    start_command: input.startCommand || null,
    watch_paths: JSON.stringify(input.watchPaths ?? []),
    cpu_limit: input.cpuLimit ?? null,
    mem_limit_mb: input.memLimitMb ?? null,
    status: 'idle',
    auto_deploy: (input.autoDeploy ?? true) ? 1 : 0,
    webhook_secret: randomToken('whs_'),
    current_deployment_id: null,
    created_at: t,
    updated_at: t,
  };
  return { row, env, gitToken: sourceType === 'git' && input.gitToken ? input.gitToken : null };
}

function insertApp(row: Row, env: Record<string, string>, gitToken: string | null): void {
  tx(() => {
    db.prepare(`INSERT INTO apps (id, name, server_id, kind, template, source_type, repo_url, branch, git_token_enc, image,
      build_type, dockerfile_path, build_context, compose_path, port, domains, healthcheck_path, volumes, status,
      auto_deploy, webhook_secret, current_deployment_id, created_at, updated_at,
      description, start_command, watch_paths, cpu_limit, mem_limit_mb)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.id, row.name, row.server_id, row.kind, row.template, row.source_type, row.repo_url, row.branch,
      gitToken ? encrypt(gitToken) : null, row.image, row.build_type, row.dockerfile_path, row.build_context,
      row.compose_path, row.port, row.domains, row.healthcheck_path, row.volumes, row.status, row.auto_deploy,
      row.webhook_secret, row.current_deployment_id, row.created_at, row.updated_at,
      row.description ?? null, row.start_command ?? null, row.watch_paths ?? '[]', row.cpu_limit ?? null, row.mem_limit_mb ?? null,
    );
    setAppEnv(row.id, env);
  });
}

/** Shell script that removes everything Docksy put on the server for this app. */
export function removalScript(app: App, withVolumes: boolean): string {
  const proj = composeProject(app.name);
  const lines = [
    'set +e',
    `ids=$(docker ps -aq --filter ${q(`label=docksy.app=${app.id}`)})`,
    'if [ -n "$ids" ]; then docker rm -f $ids >/dev/null; fi',
    `if docker compose version >/dev/null 2>&1; then docker compose -p ${q(proj)} down --remove-orphans${withVolumes ? ' -v' : ''} >/dev/null 2>&1; fi`,
    `pids=$(docker ps -aq --filter ${q(`label=com.docker.compose.project=${proj}`)})`,
    'if [ -n "$pids" ]; then docker rm -f $pids >/dev/null; fi',
    `imgs=$(docker images -q ${q(imageRepo(app.name))} | sort -u)`,
    'if [ -n "$imgs" ]; then docker rmi -f $imgs >/dev/null 2>&1; fi',
    `rm -rf ${q(`/var/lib/docksy/builds/${app.name}`)}`,
  ];
  if (withVolumes) {
    for (const v of app.volumes) lines.push(`docker volume rm -f ${q(volumeName(app.name, v.name))} >/dev/null 2>&1`);
    lines.push(`vols=$(docker volume ls -q --filter ${q(`label=com.docker.compose.project=${proj}`)})`);
    lines.push('if [ -n "$vols" ]; then docker volume rm -f $vols >/dev/null 2>&1; fi');
    lines.push(`rm -rf ${q(`/var/lib/docksy/volumes/${app.name}`)}`);
  }
  lines.push('exit 0');
  return lines.join('\n');
}

const truthy = (v: string | undefined) => v === '1' || v === 'true';

// ───────────────────────── GitHub webhook ─────────────────────────

export type WebhookOutcome =
  | { status: 200; body: { ok: true; event: string; skipped?: string } }
  | { status: 202; body: { ok: true; event: 'push'; deploymentId: string } };

/** Minimal glob: ** matches across "/", * within a segment, ? one char. A trailing "/" means the whole folder. */
export function globMatch(glob: string, path: string): boolean {
  let g = glob.trim().replace(/^\.?\//, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!;
    if (ch === '*' && g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
    else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(path.replace(/^\.?\//, ''));
}

const execSchema = z.object({ command: z.string().trim().min(1).max(2000) });
const EXEC_OUTPUT_CAP = 200_000;

/** Handle a verified-or-not GitHub delivery. Pure apart from DB reads + deps.enqueueDeployment. */
export function handleGithubWebhook(appIdOrName: string, rawBody: string, headers: { signature?: string | null; event?: string | null; contentType?: string | null }): WebhookOutcome {
  const row = db.prepare('SELECT * FROM apps WHERE id = ? OR name = ?').get(appIdOrName, appIdOrName) as Row | undefined;
  // Same answer for unknown app and bad signature, so the endpoint can't be used to probe app ids.
  if (!row || !verifyGithubSignature(row.webhook_secret, rawBody, headers.signature)) {
    throw new HttpError(401, 'invalid_signature', 'Webhook signature did not match. Check the secret in GitHub matches GET /apps/:id/webhook.');
  }
  const event = headers.event ?? 'unknown';
  if (event === 'ping') return { status: 200, body: { ok: true, event } };
  if (event !== 'push') return { status: 200, body: { ok: true, event, skipped: 'Only push events trigger deploys' } };

  let payload: any;
  try {
    let text = rawBody;
    if (headers.contentType?.includes('application/x-www-form-urlencoded')) text = new URLSearchParams(rawBody).get('payload') ?? '';
    payload = JSON.parse(text);
  } catch {
    throw badRequest('Push payload is not valid JSON');
  }

  const ref = typeof payload?.ref === 'string' ? payload.ref : '';
  const pushedBranch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
  const appBranch = row.branch ?? 'main';
  const skip = (why: string): WebhookOutcome => ({ status: 200, body: { ok: true, event, skipped: why } });

  if (row.source_type !== 'git') return skip('App is not deployed from git');
  if (!pushedBranch) return skip(`Ref ${ref || '(none)'} is not a branch`);
  if (pushedBranch !== appBranch) return skip(`Push to ${pushedBranch}; app deploys ${appBranch}`);
  if (payload.deleted) return skip('Branch was deleted');
  if (!row.auto_deploy) return skip('Auto-deploy is off for this app');
  const watch = json<string[]>(row.watch_paths, []);
  if (watch.length && Array.isArray(payload.commits) && payload.commits.length) {
    const changed = payload.commits.flatMap((c: any) => [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]) as string[];
    if (!changed.some((f) => watch.some((g) => globMatch(g, f)))) return skip(`No changed file matches the watch paths (${watch.join(', ')})`);
  }

  const commitSha: string | undefined = payload.head_commit?.id ?? payload.after ?? undefined;
  const commitMessage: string | undefined = typeof payload.head_commit?.message === 'string'
    ? payload.head_commit.message.split('\n')[0].slice(0, 500)
    : undefined;
  const dep = deps.enqueueDeployment(row.id, 'webhook', { commitSha, commitMessage, ref: pushedBranch });
  logActivity('webhook', 'app.deploy', 'app', row.id, `push ${pushedBranch}${commitSha ? ` @ ${commitSha.slice(0, 7)}` : ''}`);
  return { status: 202, body: { ok: true, event: 'push', deploymentId: dep.id } };
}

// ───────────────────────── routes ─────────────────────────

export function registerApps(app: Hono<AppEnv>): void {
  // Public: GitHub push webhook (HMAC verified). Registered without requireUser on purpose.
  app.post('/api/v1/webhooks/github/:appId', async (c) => {
    const raw = await c.req.text();
    const out = handleGithubWebhook(c.req.param('appId'), raw, {
      signature: c.req.header('x-hub-signature-256'),
      event: c.req.header('x-github-event'),
      contentType: c.req.header('content-type'),
    });
    return c.json(out.body, out.status);
  });

  app.get('/api/v1/templates', requireUser, (c) => c.json({ items: TEMPLATES }));

  app.get('/api/v1/apps', requireUser, (c) => {
    const serverId = c.req.query('serverId');
    const rows = (serverId
      ? db.prepare('SELECT * FROM apps WHERE server_id = ? ORDER BY created_at').all(serverId)
      : db.prepare('SELECT * FROM apps ORDER BY created_at').all()) as Row[];
    return c.json({ items: rows.map(toApp) });
  });

  app.post('/api/v1/apps', requireUser, async (c) => {
    const input = await body(c, createSchema);
    assertNameFree(input.name);
    const { row, env, gitToken } = planApp(input);
    assertDomainsFree(JSON.parse(row.domains));
    insertApp(row, env, gitToken);
    logActivity(c.get('actor'), 'app.create', 'app', row.id, row.template ? `${row.name} (template ${row.template})` : row.name);
    bus.emit('app.created', { appId: row.id });
    return c.json(toApp(getAppRow(row.id)), 201);
  });

  app.get('/api/v1/apps/:id', requireUser, (c) => c.json(toApp(getAppRow(c.req.param('id')))));

  app.patch('/api/v1/apps/:id', requireUser, async (c) => {
    const row = getAppRow(c.req.param('id'));
    const input = await body(c, updateSchema);
    const sets: Record<string, unknown> = {};

    if (input.name !== undefined && input.name !== row.name) {
      const deployed = db.prepare('SELECT 1 FROM deployments WHERE app_id = ? LIMIT 1').get(row.id);
      if (deployed) throw conflict('Apps cannot be renamed after their first deploy (containers and volumes are named after the app). Create a new app instead.');
      assertNameFree(input.name, row.id);
      sets.name = input.name;
    }

    const nextSource = input.sourceType ?? row.source_type;
    if (input.sourceType !== undefined && row.template && input.sourceType !== 'image') throw badRequest('Template apps run an image');
    if (input.sourceType !== undefined) sets.source_type = input.sourceType;
    if (input.repoUrl !== undefined) sets.repo_url = input.repoUrl;
    if (input.branch !== undefined) sets.branch = input.branch;
    if (input.image !== undefined) sets.image = input.image;
    if (input.buildType !== undefined) sets.build_type = input.buildType;
    if (input.dockerfilePath !== undefined) sets.dockerfile_path = input.dockerfilePath;
    if (input.buildContext !== undefined) sets.build_context = input.buildContext;
    if (input.composePath !== undefined) sets.compose_path = input.composePath;
    if (input.port !== undefined) sets.port = input.port;
    if (input.healthcheckPath !== undefined) sets.healthcheck_path = input.healthcheckPath;
    if (input.autoDeploy !== undefined) sets.auto_deploy = input.autoDeploy ? 1 : 0;
    if (input.description !== undefined) sets.description = input.description || null;
    if (input.startCommand !== undefined) sets.start_command = input.startCommand || null;
    if (input.watchPaths !== undefined) sets.watch_paths = JSON.stringify(input.watchPaths);
    if (input.cpuLimit !== undefined) sets.cpu_limit = input.cpuLimit;
    if (input.memLimitMb !== undefined) sets.mem_limit_mb = input.memLimitMb;
    if (input.gitToken !== undefined) sets.git_token_enc = input.gitToken ? encrypt(input.gitToken) : null;
    if (input.volumes !== undefined) { checkVolumes(input.volumes); sets.volumes = JSON.stringify(input.volumes); }
    if (input.domains !== undefined) {
      const domains = [...new Set(input.domains)];
      assertDomainsFree(domains, row.id);
      sets.domains = JSON.stringify(domains);
    }

    // Consistency of the resulting source/build combination.
    const repo = 'repo_url' in sets ? sets.repo_url : row.repo_url;
    const img = 'image' in sets ? sets.image : row.image;
    const bt = (sets.build_type ?? row.build_type) as BuildType;
    if (nextSource === 'git') {
      if (!repo) throw badRequest('Git apps need a repoUrl');
      if (bt === 'image') throw badRequest('buildType "image" needs sourceType "image"');
      if (!('branch' in sets) && !row.branch) sets.branch = 'main';
    } else {
      if (!img) throw badRequest('Image apps need an image');
      if (bt !== 'image') sets.build_type = 'image';
    }

    tx(() => {
      const keys = Object.keys(sets);
      if (keys.length) {
        db.prepare(`UPDATE apps SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
          .run(...(keys.map((k) => sets[k]) as any[]), now(), row.id);
      }
      if (input.env) setAppEnv(row.id, { ...getAppEnv(row.id), ...input.env });
    });
    const changed = [...Object.keys(sets), ...(input.env ? ['env'] : [])];
    logActivity(c.get('actor'), 'app.update', 'app', row.id, changed.length ? changed.join(', ') : null);
    return c.json(toApp(getAppRow(row.id)));
  });

  // Terminal: run one command inside the app's running container.
  app.post('/api/v1/apps/:id/exec', requireUser, async (c) => {
    const row = getAppRow(c.req.param('id'));
    const { command } = await body(c, execSchema);
    const script = [
      `C=$(docker ps -q --filter ${q(`label=docksy.app=${row.id}`)} | head -n1)`,
      `[ -n "$C" ] || C=$(docker ps -q --filter ${q(`label=com.docker.compose.project=docksy-${row.name}`)} | head -n1)`,
      `[ -n "$C" ] || { echo "No running container for ${row.name}. Deploy or start it first." >&2; exit 125; }`,
      `echo "::container::$(docker inspect -f '{{.Name}}' "$C" | sed 's#^/##')"`,
      `docker exec "$C" sh -c ${q(command)}`,
    ].join('\n');
    const started = Date.now();
    const r = await deps.exec(row.server_id, script, { timeoutMs: 30_000 });
    let stdout = r.stdout;
    let container: string | null = null;
    const m = /^::container::(.*)\n?/.exec(stdout);
    if (m) { container = m[1]!.trim() || null; stdout = stdout.slice(m[0].length); }
    logActivity(c.get('actor'), 'app.exec', 'app', row.id, command.slice(0, 200));
    return c.json({
      code: r.code,
      stdout: stdout.slice(-EXEC_OUTPUT_CAP),
      stderr: (r.code === 124 ? `${r.stderr}\nTimed out after 30s.` : r.stderr).slice(-EXEC_OUTPUT_CAP),
      container,
      durationMs: Date.now() - started,
    });
  });

  app.delete('/api/v1/apps/:id', requireUser, async (c) => {
    const row = getAppRow(c.req.param('id'));
    const current = toApp(row);
    const withVolumes = truthy(c.req.query('volumes'));
    const force = truthy(c.req.query('force'));

    const active = db.prepare(`SELECT id FROM deployments WHERE app_id = ? AND status IN ('queued','building','deploying') LIMIT 1`).get(row.id) as Row | undefined;
    if (active && !force) throw conflict(`Deployment ${active.id} is still running. Cancel it first, or pass ?force=1.`);

    const everDeployed = !!db.prepare('SELECT 1 FROM deployments WHERE app_id = ? LIMIT 1').get(row.id) || row.status !== 'idle';
    let cleanup = 'skipped (never deployed)';
    if (everDeployed) {
      try {
        const r = await deps.exec(row.server_id, removalScript(current, withVolumes), { timeoutMs: 120_000 });
        if (r.code !== 0 && !force) throw new HttpError(502, 'cleanup_failed', `Removing containers failed: ${(r.stderr || r.stdout).trim().slice(-500)}. Retry, or pass ?force=1 to delete the app anyway.`);
        cleanup = r.code === 0 ? 'ok' : `failed (exit ${r.code}), forced`;
      } catch (e) {
        if (e instanceof HttpError) throw e;
        if (!force) throw new HttpError(502, 'server_unreachable', `Couldn't reach the server to remove containers (${(e as Error).message}). Retry, or pass ?force=1 to delete the app anyway.`);
        cleanup = 'server unreachable, forced';
      }
    }

    db.prepare('DELETE FROM apps WHERE id = ?').run(row.id);
    logActivity(c.get('actor'), 'app.delete', 'app', row.id, `${row.name}; volumes ${withVolumes ? 'removed' : 'kept'}; cleanup ${cleanup}`);
    bus.emit('app.deleted', { appId: row.id });
    return c.json({ ok: true });
  });

  app.get('/api/v1/apps/:id/env', requireUser, (c) => {
    const row = getAppRow(c.req.param('id'));
    const vars = getAppEnv(row.id);
    const reveal = truthy(c.req.query('reveal'));
    if (reveal) logActivity(c.get('actor'), 'app.env.reveal', 'app', row.id, null);
    return c.json({ vars: reveal ? vars : maskVars(vars) } satisfies EnvVars);
  });

  app.put('/api/v1/apps/:id/env', requireUser, async (c) => {
    const row = getAppRow(c.req.param('id'));
    const { vars } = await body(c, envBodySchema);
    const existing = getAppEnv(row.id);
    // A value equal to the masked form of the stored one means "unchanged" (UI round-trips GET → PUT).
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) next[k] = k in existing && v === mask(existing[k]) && v !== existing[k] ? existing[k] : v;
    setAppEnv(row.id, next);
    db.prepare('UPDATE apps SET updated_at = ? WHERE id = ?').run(now(), row.id);
    const added = Object.keys(next).filter((k) => !(k in existing));
    const removed = Object.keys(existing).filter((k) => !(k in next));
    logActivity(c.get('actor'), 'app.env.update', 'app', row.id,
      `${Object.keys(next).length} vars${added.length ? `; added ${added.join(',')}` : ''}${removed.length ? `; removed ${removed.join(',')}` : ''}`);
    return c.json({ vars: maskVars(next) } satisfies EnvVars);
  });

  app.get('/api/v1/apps/:id/webhook', requireUser, (c) => {
    const row = getAppRow(c.req.param('id'));
    return c.json({ url: toApp(row).webhookUrl, secret: row.webhook_secret as string });
  });
}
