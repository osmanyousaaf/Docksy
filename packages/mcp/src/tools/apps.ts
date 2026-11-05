import { z } from 'zod';
import type { App, CreateAppRequest, Deployment, EnvVars, Template, UpdateAppRequest } from '@docksy/shared';
import { seg } from '../api.ts';
import { defineTool, UserFacingError } from '../registry.ts';
import { resolveApp, resolveServer, serverNames } from '../resolve.ts';
import { APP_HEADERS, appRow, renderApp } from '../render.ts';
import { table } from '../format.ts';

/** Mirrors APP_NAME_RE in apps/server/src/core/apps/model.ts. */
const appName = z.string().regex(/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/, 'Name must be 3–40 chars: lowercase letters, digits and dashes, starting with a letter');

export const appRef = z.string().min(1).describe('App id or name (e.g. "web"). Use list_apps if unsure.');

const volume = z.object({
  name: z.string().min(1).describe('Volume name, e.g. "data".'),
  mountPath: z.string().min(1).describe('Absolute path inside the container, e.g. "/var/lib/postgresql/data".'),
});

/** Fields shared by create_app and update_app. */
const appFields = {
  repoUrl: z.string().optional().describe('Git repository URL (https), e.g. "https://github.com/acme/web". Use for building from source.'),
  branch: z.string().optional().describe('Git branch to build and to auto-deploy from (default "main").'),
  gitToken: z.string().optional().describe('Access token for a private repo (stored encrypted, never shown again).'),
  image: z.string().optional().describe('Docker image to run instead of building, e.g. "ghcr.io/acme/api:1.4".'),
  buildType: z
    .enum(['auto', 'dockerfile', 'compose', 'image'])
    .optional()
    .describe('"auto" (default): use the repo Dockerfile, else detect Node/Python/Go/static. "dockerfile", "compose" (docker compose project) or "image".'),
  dockerfilePath: z.string().optional().describe('Path to the Dockerfile inside the repo (default "Dockerfile").'),
  buildContext: z.string().optional().describe('Docker build context directory (default ".").'),
  composePath: z.string().optional().describe('Compose file path for buildType "compose" (default "docker-compose.yml").'),
  port: z.number().int().min(1).max(65535).optional().describe('Port the app listens on inside the container; HTTPS traffic is routed here.'),
  domains: z
    .array(z.string())
    .optional()
    .describe('Domains to serve (first is primary), DNS must point at the server. Leave empty for a free <app>.<ip>.sslip.io domain.'),
  healthcheckPath: z
    .string()
    .nullable()
    .optional()
    .describe('HTTP path that returns 2xx when healthy, e.g. "/health". Used for zero-downtime deploys. null = "container running" is enough.'),
  volumes: z.array(volume).optional().describe('Persistent volumes.'),
  autoDeploy: z.boolean().optional().describe('Redeploy automatically on git push to the branch (default true for git apps).'),
};

export const listApps = defineTool({
  name: 'list_apps',
  title: 'List apps',
  description:
    'List apps, databases and services with their status (running, failed, deploying…), server, source and primary domain. Use it to find an app by name or to see what is deployed where.',
  kind: 'read',
  input: { serverId: z.string().optional().describe('Only apps on this server (id, name or host).') },
  async run({ serverId }, { api }) {
    const server = serverId ? await resolveServer(api, serverId) : null;
    const [{ items }, names] = await Promise.all([
      api.get<{ items: App[] }>('/apps', { serverId: server?.id }),
      serverNames(api),
    ]);
    const text = items.length
      ? `## Apps${server ? ` on ${server.name}` : ''} (${items.length})\n\n${table(APP_HEADERS, items.map((a) => appRow(a, names.get(a.serverId))))}`
      : 'No apps yet. Create one with `create_app` (from a git repo, a Docker image, or a template like postgres; see list_templates).';
    return { text, data: { items } };
  },
});

export const getApp = defineTool({
  name: 'get_app',
  title: 'Get app',
  description:
    'Show one app in full: status, source (repo/image/template), build settings, port, domains, healthcheck, volumes, webhook and recent deployments. Use before changing or debugging an app.',
  kind: 'read',
  input: { appId: appRef },
  async run({ appId }, { api }) {
    const app = await resolveApp(api, appId);
    const [deps, names] = await Promise.all([
      api.get<{ items: Deployment[] }>('/deployments', { appId: app.id, limit: 5 }).catch(() => ({ items: [] as Deployment[] })),
      serverNames(api),
    ]);
    return { text: renderApp(app, deps.items, names.get(app.serverId)), data: { app, recentDeployments: deps.items } };
  },
});

export const listTemplates = defineTool({
  name: 'list_templates',
  title: 'List one-click templates',
  description:
    'List one-click templates (postgres, mysql, redis, mongodb, n8n, uptime-kuma, plausible, umami, minio, ghost, wordpress…). Use the template id with create_app {template} to launch a database or service with sane defaults and generated passwords.',
  kind: 'read',
  input: {},
  async run(_a, { api }) {
    const { items } = await api.get<{ items: Template[] }>('/templates');
    const text = `## Templates (${items.length})\n\n${table(
      ['id', 'name', 'kind', 'image', 'port', 'backups', 'description'],
      items.map((t) => [t.id, t.name, t.kind, t.image, t.port, t.backupSupported ? 'yes' : 'no', t.description]),
    )}`;
    return { text, data: { items } };
  },
});

export const createApp = defineTool({
  name: 'create_app',
  title: 'Create app',
  description:
    'Create an app on a server from (a) a git repo (repoUrl, optional branch/buildType), (b) a Docker image (image), or (c) a one-click template (template, e.g. "postgres"; see list_templates). Does not deploy unless deploy=true; otherwise call deploy_app next. Set env vars here or with set_env_vars.',
  kind: 'write',
  input: {
    name: appName.describe('3–40 chars: lowercase letters, digits and dashes, starting with a letter, e.g. "web" or "orders-db". Used in container names and the default domain.'),
    serverId: z.string().min(1).describe('Target server id, name or host (see list_servers).'),
    template: z.string().optional().describe('One-click template id, e.g. "postgres", "redis", "n8n". Fills image, port, volumes and env.'),
    ...appFields,
    env: z.record(z.string(), z.string()).optional().describe('Environment variables, e.g. {"NODE_ENV":"production"}.'),
    deploy: z.boolean().optional().describe('Start the first deployment right away (default false).'),
  },
  async run({ serverId, deploy, ...rest }, { api }) {
    const server = await resolveServer(api, serverId);
    if (!rest.template && !rest.repoUrl && !rest.image) {
      throw new UserFacingError('create_app needs one of: repoUrl (build from git), image (run a Docker image) or template (see list_templates).');
    }
    const body: CreateAppRequest = { ...rest, serverId: server.id };
    if (!body.sourceType && !body.template) body.sourceType = body.image && !body.repoUrl ? 'image' : 'git';
    if (body.sourceType === 'image' && !body.buildType) body.buildType = 'image';
    const app = await api.post<App>('/apps', body);
    const lines = [`Created **${app.name}** (\`${app.id}\`) on ${server.name}.`];
    let deployment: Deployment | null = null;
    if (deploy) {
      deployment = await api.post<Deployment>(`/apps/${seg(app.id)}/deploy`, { trigger: 'mcp' });
      lines.push(`Deployment \`${deployment.id}\` started (${deployment.status}). Follow with \`list_deployments {"appId":"${app.name}"}\` or \`get_deployment_logs {"deploymentId":"${deployment.id}"}\`.`);
    } else {
      lines.push(`Next: \`deploy_app {"appId":"${app.name}","wait":true}\`.`);
    }
    if (app.domains.length) lines.push(`URL once deployed: https://${app.domains[0]}`);
    if (app.sourceType === 'git' && app.autoDeploy) lines.push(`For deploy-on-push, add a GitHub webhook to ${app.webhookUrl} (secret: see the app's Settings in Docksy).`);
    return { text: lines.join('\n'), data: { app, deployment } };
  },
});

export const updateApp = defineTool({
  name: 'update_app',
  title: 'Update app settings',
  description:
    'Change app settings: source repo/branch/image, build type and paths, port, domains, healthcheck, volumes, auto-deploy, or rename. Only the fields you pass change. Changes take effect on the next deploy_app.',
  kind: 'write',
  idempotent: true,
  input: {
    appId: appRef,
    name: appName.optional().describe('New name (3–40 chars, lowercase letters, digits, dashes).'),
    sourceType: z.enum(['git', 'image']).optional().describe('Switch between building from git and running an image.'),
    ...appFields,
  },
  async run({ appId, ...patch }, { api }) {
    const current = await resolveApp(api, appId);
    if (Object.keys(patch).length === 0) throw new UserFacingError('Nothing to update: pass at least one field to change.');
    const app = await api.patch<App>(`/apps/${seg(current.id)}`, patch as UpdateAppRequest);
    return {
      text: `Updated **${app.name}**: ${Object.keys(patch).join(', ')}. Run \`deploy_app {"appId":"${app.name}"}\` to apply.`,
      data: { app },
    };
  },
});

export const setEnvVars = defineTool({
  name: 'set_env_vars',
  title: 'Set environment variables',
  description:
    "Set and/or remove an app's environment variables (merged with the existing ones; values are stored encrypted). Never echo secret values back to the user. Takes effect on the next deploy; pass redeploy=true to deploy right away.",
  kind: 'write',
  idempotent: true,
  input: {
    appId: appRef,
    set: z.record(z.string(), z.string()).optional().describe('Variables to add or overwrite, e.g. {"DATABASE_URL":"postgres://…"}.'),
    unset: z.array(z.string()).optional().describe('Variable names to remove.'),
    redeploy: z.boolean().optional().describe('Deploy after saving so the new values are live (default false).'),
  },
  async run({ appId, set, unset, redeploy }, { api }) {
    const app = await resolveApp(api, appId);
    const setKeys = Object.keys(set ?? {});
    if (!setKeys.length && !(unset ?? []).length) throw new UserFacingError('Pass `set` and/or `unset`.');
    for (const k of setKeys) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new UserFacingError(`"${k}" is not a valid environment variable name.`);
    }
    // PUT replaces the whole set, so merge with the real (unmasked) current values first.
    const current = await api.get<EnvVars>(`/apps/${seg(app.id)}/env`, { reveal: 1 });
    const vars = { ...(current.vars ?? {}), ...(set ?? {}) };
    const removed: string[] = [];
    for (const k of unset ?? []) {
      if (k in vars) {
        delete vars[k];
        removed.push(k);
      }
    }
    await api.put(`/apps/${seg(app.id)}/env`, { vars });
    const lines = [
      `Saved env for **${app.name}**: ${setKeys.length ? `set ${setKeys.join(', ')}` : ''}${setKeys.length && removed.length ? '; ' : ''}${removed.length ? `removed ${removed.join(', ')}` : ''}. ${Object.keys(vars).length} variables total.`,
    ];
    let deployment: Deployment | null = null;
    if (redeploy) {
      deployment = await api.post<Deployment>(`/apps/${seg(app.id)}/deploy`, { trigger: 'mcp' });
      lines.push(`Redeploying (\`${deployment.id}\`).`);
    } else {
      lines.push(`Applies on the next deploy (\`deploy_app {"appId":"${app.name}"}\`).`);
    }
    return { text: lines.join('\n'), data: { appId: app.id, set: setKeys, removed, keys: Object.keys(vars), deployment } };
  },
});

function lifecycle(name: 'restart_app' | 'stop_app' | 'start_app', verb: string, description: string, idempotent: boolean) {
  const action = name.split('_')[0];
  return defineTool({
    name,
    title: `${verb} app`,
    description,
    kind: 'write',
    idempotent,
    input: { appId: appRef },
    async run({ appId }, { api }) {
      const app = await resolveApp(api, appId);
      const res = await api.post<unknown>(`/apps/${seg(app.id)}/${action}`);
      const updated = res && typeof res === 'object' && 'status' in res && 'name' in res ? (res as App) : null;
      return {
        text: `${verb === 'Stop' ? 'Stopped' : verb === 'Start' ? 'Started' : 'Restarted'} **${app.name}**${updated ? ` (status: ${updated.status})` : ''}.`,
        data: { ok: true, appId: app.id, app: updated },
      };
    },
  });
}

export const restartApp = lifecycle(
  'restart_app',
  'Restart',
  'Restart the running container(s) of an app without rebuilding. The quick fix for a hung process, memory leak or crash loop after config on the server changed. To ship new code or new env vars use deploy_app instead.',
  false,
);
export const stopApp = lifecycle(
  'stop_app',
  'Stop',
  'Stop an app\'s containers (the site goes down until start_app). Data volumes are kept. Confirm with the user first if the app serves traffic.',
  true,
);
export const startApp = lifecycle('start_app', 'Start', 'Start a stopped app\'s existing containers (no rebuild). Use deploy_app if it was never deployed.', true);

export const deleteApp = defineTool({
  name: 'delete_app',
  title: 'Delete app',
  description:
    "Delete an app: removes its containers from the server and its configuration and deployment history from Docksy. Volumes (database data) are kept unless deleteVolumes=true. Suggest a backup first for databases.",
  kind: 'destructive',
  input: {
    appId: appRef,
    deleteVolumes: z.boolean().optional().describe('Also delete persistent volumes, i.e. all data (default false).'),
  },
  async run({ appId, deleteVolumes }, { api }) {
    const app = await resolveApp(api, appId);
    await api.delete(`/apps/${seg(app.id)}`, deleteVolumes ? { volumes: 1 } : undefined);
    return {
      text: `Deleted **${app.name}** (\`${app.id}\`). Volumes ${deleteVolumes ? 'deleted too' : 'kept on the server'}.`,
      data: { ok: true, appId: app.id, volumesDeleted: !!deleteVolumes },
    };
  },
});

export const appTools = [listApps, getApp, listTemplates, createApp, updateApp, setEnvVars, restartApp, stopApp, startApp, deleteApp];
