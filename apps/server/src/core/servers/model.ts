import type { Server, Liveness, ServerStatus } from '@docksy/shared';
import { db, iso, type Row } from '../../db/index.ts';
import { notFound } from '../../lib/http.ts';

/** FROZEN shared helper (integrator-owned). Server is "online" if the agent reported within this window. */
export const ONLINE_WINDOW_MS = 60_000;

export function liveness(lastSeenAt: number | null | undefined): Liveness {
  if (!lastSeenAt) return 'unknown';
  return Date.now() - Number(lastSeenAt) <= ONLINE_WINDOW_MS ? 'online' : 'offline';
}

export const toServer = (r: Row): Server => ({
  id: r.id,
  name: r.name,
  host: r.host,
  port: Number(r.port),
  sshUser: r.ssh_user,
  status: r.status as ServerStatus,
  liveness: liveness(r.last_seen_at),
  lastSeenAt: iso(r.last_seen_at),
  agentVersion: r.agent_version ?? null,
  os: r.os ?? null,
  arch: r.arch ?? null,
  cpuCores: r.cpu_cores ?? null,
  memTotal: r.mem_total ?? null,
  diskTotal: r.disk_total ?? null,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

export function getServerRow(id: string): Row {
  const r = db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw notFound('Server');
  return r;
}

export const getServer = (id: string): Server => toServer(getServerRow(id));

export const listServers = (): Server[] =>
  (db.prepare('SELECT * FROM servers ORDER BY created_at').all() as Row[]).map(toServer);
