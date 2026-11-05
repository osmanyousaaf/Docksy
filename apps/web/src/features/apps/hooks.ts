/** Data hooks + small pure helpers for the apps/deploy pages. */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { App, Deployment, DeploymentStatus, ExecResponse, Server, Template, UpdateAppRequest } from '@docksy/shared';
import { api, useApi, type ApiError } from '../../lib/api.ts';

/** Mirrors the server's APP_NAME_RE (core/apps/model.ts). */
export const APP_NAME_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

/** Turn arbitrary text (e.g. a repo name) into a valid app name candidate. */
export function slugify(s: string): string {
  let out = s.toLowerCase().replace(/\.git$/, '').replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '');
  out = out.slice(0, 40).replace(/-+$/, '');
  return out;
}

export function appNameError(name: string): string | null {
  if (!name) return 'Pick a name';
  if (!APP_NAME_RE.test(name)) return '3–40 chars: lowercase letters, digits and dashes; start with a letter';
  return null;
}

/** Repo name from a GitHub-ish URL ("https://github.com/acme/web.git" → "web"). */
export function repoName(url: string): string {
  const m = url.trim().replace(/\/+$/, '').match(/([^/:]+?)(?:\.git)?$/);
  return m ? m[1] : '';
}

/** Split a free-form domain list (comma, space or newline separated). */
export function parseDomains(s: string): string[] {
  return [...new Set(s.split(/[\s,]+/).map((d) => d.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()).filter(Boolean))];
}

export const TERMINAL: DeploymentStatus[] = ['succeeded', 'failed', 'cancelled'];
export const isActive = (s: DeploymentStatus | undefined) => !!s && !TERMINAL.includes(s);
export const shortId = (id: string) => id.slice(0, 8);
export const shortSha = (sha: string | null) => (sha ? sha.slice(0, 7) : null);
export const domainUrl = (d: string) => (/^https?:\/\//.test(d) ? d : `https://${d}`);

/** Rollback targets: previous succeeded deployments that still have an image. */
export const rollbackTargets = (deps: Deployment[], currentId: string | null) =>
  deps.filter((d) => d.status === 'succeeded' && d.imageTag && d.id !== currentId);

/* ───────────────────────── queries ───────────────────────── */

export const useApps = (refetchMs?: number | false) =>
  useApi<{ items: App[] }>('/apps', { refetchInterval: refetchMs ?? false });
export const useServers = () => useApi<{ items: Server[] }>('/servers');
export const useTemplates = () => useApi<{ items: Template[] }>('/templates', { staleTime: 5 * 60_000 });

export function useApp(id: string | undefined) {
  return useApi<App>(id ? `/apps/${encodeURIComponent(id)}` : null, {
    refetchInterval: (q) => (q.state.data?.status === 'deploying' ? 3000 : 15000),
  });
}

export function useDeployments(appId: string | undefined, limit = 50) {
  return useApi<{ items: Deployment[] }>(appId ? `/deployments?appId=${encodeURIComponent(appId)}&limit=${limit}` : null, {
    refetchInterval: (q) => (q.state.data?.items.some((d) => isActive(d.status)) ? 3000 : 20000),
  });
}

/* ───────────────────────── actions ───────────────────────── */

/** Generic action mutation; invalidates queries whose first key starts with any of the prefixes. */
export function useAction<TVars = void, TRes = unknown>(fn: (v: TVars) => Promise<TRes>, invalidate: string[] = ['/apps', '/deployments']) {
  const qc = useQueryClient();
  return useMutation<TRes, ApiError, TVars>({
    mutationFn: fn,
    onSuccess: () => {
      for (const p of invalidate) qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith(p) });
    },
  });
}

const enc = encodeURIComponent;
export const appActions = {
  deploy: (id: string) => api<Deployment>(`/apps/${enc(id)}/deploy`, { method: 'POST', body: { trigger: 'manual' } }),
  rollback: (id: string, deploymentId: string) => api<Deployment>(`/apps/${enc(id)}/rollback`, { method: 'POST', body: { deploymentId } }),
  restart: (id: string) => api(`/apps/${enc(id)}/restart`, { method: 'POST', body: {} }),
  stop: (id: string) => api(`/apps/${enc(id)}/stop`, { method: 'POST', body: {} }),
  start: (id: string) => api(`/apps/${enc(id)}/start`, { method: 'POST', body: {} }),
  cancel: (deploymentId: string) => api(`/deployments/${enc(deploymentId)}/cancel`, { method: 'POST', body: {} }),
};

/** PATCH /apps/:id; refreshes every /apps query on success. */
export function useAppPatch(appId: string) {
  return useAction((body: Omit<UpdateAppRequest, 'port' | 'gitToken'> & { port?: number | null; gitToken?: string | null }) => api<App>(`/apps/${enc(appId)}`, { method: 'PATCH', body }), ['/apps']);
}

/** POST /apps/:id/exec: one command inside the running container (30s limit). */
export const execInApp = (appId: string, command: string) =>
  api<ExecResponse>(`/apps/${enc(appId)}/exec`, { method: 'POST', body: { command } });
