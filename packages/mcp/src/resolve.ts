/** Resolves human references (names, hosts) to Docksy entities so Claude can say "prod" instead of an id. */
import type { App, Server } from '@docksy/shared';
import { DocksyApiError, seg, type DocksyApi } from './api.ts';
import { UserFacingError } from './registry.ts';

/** Server by id, name (case-insensitive) or host. */
export async function resolveServer(api: DocksyApi, ref: string): Promise<Server> {
  const r = ref.trim();
  try {
    return await api.get<Server>(`/servers/${seg(r)}`);
  } catch (e) {
    if (!(e instanceof DocksyApiError) || (e.status !== 404 && e.status !== 400)) throw e;
  }
  const { items } = await api.get<{ items: Server[] }>('/servers');
  const lc = r.toLowerCase();
  const hit =
    items.find((s) => s.name.toLowerCase() === lc) ??
    items.find((s) => s.host.toLowerCase() === lc) ??
    items.find((s) => s.id.startsWith(r));
  if (hit) return hit;
  const known = items.map((s) => s.name).join(', ') || 'none yet (use create_server)';
  throw new UserFacingError(`No server matches "${ref}". Known servers: ${known}.`, 'not_found');
}

/** App by id or name (the API accepts both). */
export async function resolveApp(api: DocksyApi, ref: string): Promise<App> {
  try {
    return await api.get<App>(`/apps/${seg(ref.trim())}`);
  } catch (e) {
    if (!(e instanceof DocksyApiError) || e.status !== 404) throw e;
    const { items } = await api.get<{ items: App[] }>('/apps');
    const lc = ref.trim().toLowerCase();
    const hit = items.find((a) => a.name.toLowerCase() === lc || a.id.startsWith(ref.trim()));
    if (hit) return hit;
    const known = items.map((a) => a.name).join(', ') || 'none yet (use create_app)';
    throw new UserFacingError(`No app matches "${ref}". Known apps: ${known}.`, 'not_found');
  }
}

/** Builds an id → name lookup for servers (used to label tables). */
export async function serverNames(api: DocksyApi): Promise<Map<string, string>> {
  try {
    const { items } = await api.get<{ items: Server[] }>('/servers');
    return new Map(items.map((s) => [s.id, s.name]));
  } catch {
    return new Map();
  }
}
