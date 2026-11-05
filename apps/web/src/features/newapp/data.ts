/**
 * Data hooks + pure helpers for the Apps list, New resource flow and Deployment detail pages.
 * Self-contained on purpose (features/apps is owned elsewhere).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { App, BuildType, Deployment, DeploymentStatus, Server, Template } from '@docksy/shared';
import { api, useApi, type ApiError } from '../../lib/api.ts';

/* ───────────────────────── helpers ───────────────────────── */

/** Mirrors the server's APP_NAME_RE. */
export const APP_NAME_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

export function slugify(s: string): string {
  return s.toLowerCase().replace(/\.git$/, '').replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-')
    .replace(/^[^a-z]+/, '').slice(0, 40).replace(/-+$/, '');
}

export function appNameError(name: string): string | null {
  if (!name) return 'Name is required.';
  if (!APP_NAME_RE.test(name)) return '3–40 characters: lowercase letters, digits and dashes, starting with a letter.';
  return null;
}

/** "https://github.com/acme/web.git" → "web" */
export function repoName(url: string): string {
  const m = url.trim().replace(/\/+$/, '').match(/([^/:]+?)(?:\.git)?$/);
  return m ? m[1] : '';
}

/** Split a free-form domain list (comma, space or newline separated). */
export function parseDomains(s: string): string[] {
  return [...new Set(s.split(/[\s,]+/).map((d) => d.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()).filter(Boolean))];
}

export const isIPv4 = (h: string) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(h.trim());

/** Default domain Docksy assigns: <name>.<server-ip>.sslip.io (only computable for IPv4 hosts). */
export function sslipDomain(name: string, host: string | undefined): string | null {
  if (!host || !isIPv4(host)) return null;
  return `${name || 'app'}.${host.trim()}.sslip.io`;
}

export const TERMINAL: DeploymentStatus[] = ['succeeded', 'failed', 'cancelled'];
export const isActive = (s: DeploymentStatus | undefined | null) => !!s && !TERMINAL.includes(s);
export const shortId = (id: string) => id.slice(0, 8);
export const shortSha = (sha: string | null) => (sha ? sha.slice(0, 7) : null);
export const domainUrl = (d: string) => (/^https?:\/\//.test(d) ? d : `https://${d}`);
export const prettyRepo = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\.git$/, '');

export const BUILD_PACKS: { id: Exclude<BuildType, 'image'>; label: string; help: string }[] = [
  { id: 'auto', label: 'Auto-detect', help: 'Uses the Dockerfile if present, otherwise detects Node.js, Python, Go or a static site.' },
  { id: 'dockerfile', label: 'Dockerfile', help: 'Builds the image from the Dockerfile at the given location.' },
  { id: 'compose', label: 'Docker Compose', help: 'Runs docker compose up -d --build with the given compose file.' },
];

export function buildPackLabel(b: BuildType): string {
  return b === 'image' ? 'Docker Image' : BUILD_PACKS.find((x) => x.id === b)?.label ?? b;
}

/** "Git · Dockerfile", "Image", "Template · PostgreSQL" */
export function typeLabel(a: App, templates?: Template[]): { kind: string; detail: string | null } {
  if (a.template) return { kind: a.kind === 'database' ? 'Database' : 'Service', detail: templates?.find((t) => t.id === a.template)?.name ?? a.template };
  if (a.sourceType === 'git') return { kind: 'Git', detail: buildPackLabel(a.buildType) };
  return { kind: 'Image', detail: null };
}

/** One muted line describing an app: its description, else its source. */
export function sourceLine(a: App): string {
  if (a.description) return a.description;
  if (a.repoUrl) return `${prettyRepo(a.repoUrl)}${a.branch ? ` · ${a.branch}` : ''}`;
  return a.image ?? '';
}

/** Remove ANSI escape sequences from a log line. */
// eslint-disable-next-line no-control-regex
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');

/* ───────────────────────── queries ───────────────────────── */

export const useApps = (refetchMs: number | false = false) => useApi<{ items: App[] }>('/apps', { refetchInterval: refetchMs });
export const useServers = () => useApi<{ items: Server[] }>('/servers');
export const useTemplates = () => useApi<{ items: Template[] }>('/templates', { staleTime: 5 * 60_000 });
export const useApp = (id: string | undefined) =>
  useApi<App>(id ? `/apps/${encodeURIComponent(id)}` : null, {
    refetchInterval: (q) => (q.state.data?.status === 'deploying' ? 3000 : 15000),
  });

/* ───────────────────────── actions ───────────────────────── */

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
export const actions = {
  deploy: (appId: string) => api<Deployment>(`/apps/${enc(appId)}/deploy`, { method: 'POST', body: { trigger: 'manual' } }),
  rollback: (appId: string, deploymentId: string) => api<Deployment>(`/apps/${enc(appId)}/rollback`, { method: 'POST', body: { deploymentId } }),
  cancel: (deploymentId: string) => api(`/deployments/${enc(deploymentId)}/cancel`, { method: 'POST', body: {} }),
};
