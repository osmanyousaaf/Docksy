import type { App, AppKind, AppStatus, BuildType, Volume } from '@docksy/shared';
import { db, iso, json, bool, getSettings, type Row } from '../../db/index.ts';
import { encrypt, decrypt } from '../../lib/crypto.ts';
import { notFound } from '../../lib/http.ts';

/**
 * FROZEN shared helpers (integrator-owned). Used by core/apps, core/deploy and monitoring/*.
 *
 * Naming conventions on servers (see CONTRACT.md §6):
 *   container  : dx-<appName>-<first 8 chars of deploymentId>
 *   labels     : docksy.managed=true, docksy.app=<appId>, docksy.deployment=<deploymentId>
 *   network    : docksy
 *   volume     : docksy-<appName>-<volume.name>
 *   compose    : project name docksy-<appName>
 *   build dir  : /var/lib/docksy/builds/<appName>/<deploymentId>
 */

export const APP_NAME_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

export const containerName = (appName: string, deploymentId: string) => `dx-${appName}-${deploymentId.slice(0, 8)}`;
export const volumeName = (appName: string, vol: string) => `docksy-${appName}-${vol}`;
export const composeProject = (appName: string) => `docksy-${appName}`;
export const imageRepo = (appName: string) => `docksy/${appName}`;
/** Shell snippet resolving the running container id of an app (first match). */
export const containerSelector = (appId: string) => `$(docker ps -q --filter label=docksy.app=${appId} | head -n1)`;

export const toApp = (r: Row): App => {
  const settings = getSettings();
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    serverId: r.server_id,
    kind: r.kind as AppKind,
    template: r.template ?? null,
    sourceType: r.source_type,
    repoUrl: r.repo_url ?? null,
    branch: r.branch ?? null,
    hasGitToken: !!r.git_token_enc,
    image: r.image ?? null,
    buildType: r.build_type as BuildType,
    dockerfilePath: r.dockerfile_path,
    buildContext: r.build_context,
    composePath: r.compose_path,
    port: r.port ?? null,
    domains: json<string[]>(r.domains, []),
    healthcheckPath: r.healthcheck_path ?? null,
    volumes: json<Volume[]>(r.volumes, []),
    startCommand: r.start_command ?? null,
    watchPaths: json<string[]>(r.watch_paths, []),
    cpuLimit: r.cpu_limit ?? null,
    memLimitMb: r.mem_limit_mb ?? null,
    suggestedDomain: suggestedDomainFor(r),
    status: r.status as AppStatus,
    autoDeploy: bool(r.auto_deploy),
    webhookUrl: `${settings.publicUrl.replace(/\/$/, '')}/api/v1/webhooks/github/${r.id}`,
    currentDeploymentId: r.current_deployment_id ?? null,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
};

function suggestedDomainFor(r: Row): string | null {
  const s = db.prepare('SELECT host FROM servers WHERE id = ?').get(r.server_id) as Row | undefined;
  return s ? defaultDomain(r.name, s.host) : null;
}

export function getAppRow(id: string): Row {
  const r = db.prepare('SELECT * FROM apps WHERE id = ? OR name = ?').get(id, id) as Row | undefined;
  if (!r) throw notFound('App');
  return r;
}

export const getApp = (idOrName: string): App => toApp(getAppRow(idOrName));

export function getGitToken(appRow: Row): string | null {
  return appRow.git_token_enc ? decrypt(appRow.git_token_enc) : null;
}

/** Decrypted env vars for an app. */
export function getAppEnv(appId: string): Record<string, string> {
  const rows = db.prepare('SELECT key, value_enc FROM app_env WHERE app_id = ? ORDER BY key').all(appId) as Row[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = decrypt(r.value_enc);
  return out;
}

/** Replace all env vars for an app. */
export function setAppEnv(appId: string, vars: Record<string, string>): void {
  db.prepare('DELETE FROM app_env WHERE app_id = ?').run(appId);
  const ins = db.prepare('INSERT INTO app_env (app_id, key, value_enc) VALUES (?, ?, ?)');
  for (const [k, v] of Object.entries(vars)) ins.run(appId, k, encrypt(String(v)));
}

export function setAppStatus(appId: string, status: AppStatus): void {
  db.prepare('UPDATE apps SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), appId);
}

/** Default domain when none configured: <name>.<ip>.sslip.io (only if host is an IPv4). */
export function defaultDomain(appName: string, serverHost: string): string | null {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(serverHost) ? `${appName}.${serverHost}.sslip.io` : null;
}
