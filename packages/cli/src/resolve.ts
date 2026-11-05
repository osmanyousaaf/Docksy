/** Turn what the user typed (id, name, host) into API objects. */
import { DocksyApiError, type App, type DocksyClient, type Server } from '@crovenai/docksy-client';
import { CliError } from './context.ts';

/** Server routes take ids only, so match id, name or host from the list. */
export async function resolveServer(client: DocksyClient, ref: string): Promise<Server> {
  const servers = await client.listServers();
  const found = matchServer(servers, ref);
  if (found) return found;
  const names = servers.map((s) => s.name).join(', ');
  throw new CliError(`No server called "${ref}".`, { hint: names ? `Known servers: ${names}` : 'Add one with `docksy servers add <name> <host>`.' });
}

export function matchServer(servers: Server[], ref: string): Server | undefined {
  const r = ref.trim();
  return servers.find((s) => s.id === r)
    ?? servers.find((s) => s.name === r)
    ?? servers.find((s) => s.name.toLowerCase() === r.toLowerCase())
    ?? servers.find((s) => s.host === r)
    ?? (r.length >= 6 ? onlyOne(servers.filter((s) => s.id.startsWith(r))) : undefined);
}

function onlyOne<T>(xs: T[]): T | undefined {
  return xs.length === 1 ? xs[0] : undefined;
}

/** App routes accept id or name directly; this fetches it with a friendly not-found error. */
export async function resolveApp(client: DocksyClient, ref: string): Promise<App> {
  try {
    return await client.getApp(ref);
  } catch (e) {
    if (e instanceof DocksyApiError && e.status === 404) {
      throw new CliError(`No app called "${ref}".`, { hint: 'List apps with `docksy apps`.' });
    }
    throw e;
  }
}

/** For commands taking "server or app": servers win on an exact match, then apps. */
export async function resolveTarget(client: DocksyClient, ref: string): Promise<{ kind: 'server'; server: Server } | { kind: 'app'; app: App }> {
  const servers = await client.listServers();
  const server = matchServer(servers, ref);
  if (server) return { kind: 'server', server };
  try {
    return { kind: 'app', app: await client.getApp(ref) };
  } catch (e) {
    if (e instanceof DocksyApiError && e.status === 404) {
      throw new CliError(`"${ref}" is not a server or an app.`, { hint: 'Try `docksy servers` or `docksy apps`.' });
    }
    throw e;
  }
}
