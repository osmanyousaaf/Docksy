import { z } from 'zod';
import type { App, ContainerInfo, ProvisionJob, Server, SshKeyInfo } from '@docksy/shared';
import { seg } from '../api.ts';
import { defineTool } from '../registry.ts';
import { resolveServer } from '../resolve.ts';
import { containersTable, renderServer, SERVER_HEADERS, serverRow } from '../render.ts';
import { fence, table, tail } from '../format.ts';

const serverRef = z.string().min(1).describe('Server id, name (e.g. "prod-1") or host/IP. Use list_servers if unsure.');

export const listServers = defineTool({
  name: 'list_servers',
  title: 'List servers',
  description:
    'List every server (VPS) Docksy manages with its provisioning status, agent liveness (online/offline), OS, cores and memory. Start here when the user mentions a server by name or you need a serverId for another tool.',
  kind: 'read',
  input: {},
  async run(_a, { api }) {
    const { items } = await api.get<{ items: Server[] }>('/servers');
    const text = items.length
      ? `## Servers (${items.length})\n\n${table(SERVER_HEADERS, items.map(serverRow))}`
      : 'No servers yet. Add one with `create_server` (the user needs a VPS with SSH access), then `provision_server`.';
    return { text, data: { items } };
  },
});

export const getServer = defineTool({
  name: 'get_server',
  title: 'Get server',
  description:
    'Show one server in detail: connection, provisioning status, agent liveness, hardware, and the apps deployed on it. For live usage use get_server_metrics; for what is running use list_containers.',
  kind: 'read',
  input: { serverId: serverRef },
  async run({ serverId }, { api }) {
    const server = await resolveServer(api, serverId);
    const { items: apps } = await api.get<{ items: App[] }>('/apps', { serverId: server.id }).catch(() => ({ items: [] as App[] }));
    return { text: renderServer(server, apps), data: { server, apps } };
  },
});

export const listContainers = defineTool({
  name: 'list_containers',
  title: 'List containers',
  description:
    'List the Docker containers on a server as last reported by the agent (every ~10s): state, CPU %, memory, restart count and owning app. Use it to find what is eating CPU/memory, crash-looping (high restarts) or stopped.',
  kind: 'read',
  input: {
    serverId: serverRef,
    onlyProblems: z.boolean().optional().describe('Only containers that are not running or have restarted at least once.'),
  },
  async run({ serverId, onlyProblems }, { api }) {
    const server = await resolveServer(api, serverId);
    const [{ items }, apps] = await Promise.all([
      api.get<{ items: ContainerInfo[] }>(`/servers/${seg(server.id)}/containers`),
      api.get<{ items: App[] }>('/apps', { serverId: server.id }).catch(() => ({ items: [] as App[] })),
    ]);
    const names = new Map(apps.items.map((a) => [a.id, a.name]));
    const sorted = [...items].sort((a, b) => b.cpuPercent - a.cpuPercent);
    const shown = onlyProblems ? sorted.filter((c) => c.state !== 'running' || c.restartCount > 0) : sorted;
    const running = items.filter((c) => c.state === 'running').length;
    const text = [
      `## Containers on ${server.name}: ${running} running of ${items.length}`,
      '',
      shown.length ? containersTable(shown, names) : onlyProblems ? 'No problem containers.' : 'No containers reported (is the agent online? try get_server).',
    ].join('\n');
    return { text, data: { serverId: server.id, items: shown } };
  },
});

export const createServer = defineTool({
  name: 'create_server',
  title: 'Add server',
  description:
    "Register a VPS with Docksy over SSH. Before calling, the user must add Docksy's public SSH key to the server's authorized_keys (this tool returns the key and a one-line command). Afterwards run provision_server to install Docker, the Caddy proxy and the metrics agent.",
  kind: 'write',
  input: {
    name: z.string().min(1).max(63).describe('Short friendly name, e.g. "prod-1".'),
    host: z.string().min(1).describe('Public IP or hostname of the VPS.'),
    port: z.number().int().min(1).max(65535).optional().describe('SSH port (default 22).'),
    sshUser: z.string().optional().describe('SSH user (default "root"; a sudo-capable user also works).'),
  },
  async run(args, { api }) {
    const server = await api.post<Server>('/servers', args);
    const key = await api.get<SshKeyInfo>('/ssh-key').catch(() => null);
    const lines = [`Added server **${server.name}** (\`${server.id}\`) at ${server.host}.`];
    if (key) {
      lines.push('', "If you haven't yet, the user must run this on the VPS so Docksy can SSH in:", fence(key.instructions, 'bash'));
    }
    lines.push('', `Next: \`provision_server {"serverId":"${server.id}","wait":true}\`.`);
    return { text: lines.join('\n'), data: { server, sshKey: key } };
  },
});

const TERMINAL = new Set(['succeeded', 'failed']);

export const provisionServer = defineTool({
  name: 'provision_server',
  title: 'Provision server',
  description:
    'Install or update everything Docksy needs on a server: Docker, the docksy network, the Caddy reverse proxy (automatic HTTPS) and the metrics agent. Idempotent and safe to re-run; also the fix for a server whose agent is missing or outdated. Takes 1–5 minutes on a fresh VPS.',
  kind: 'write',
  idempotent: true,
  input: {
    serverId: serverRef,
    wait: z.boolean().optional().describe('Wait for provisioning to finish (up to timeoutSec) and return the log tail. Default false.'),
    timeoutSec: z.number().int().min(10).max(900).optional().describe('Max seconds to wait when wait=true (default 240).'),
  },
  async run({ serverId, wait, timeoutSec }, { api, progress }) {
    const server = await resolveServer(api, serverId);
    let job = await api.post<ProvisionJob>(`/servers/${seg(server.id)}/provision`);
    if (wait) {
      const deadline = Date.now() + (timeoutSec ?? 240) * 1000;
      while (!TERMINAL.has(job.status) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        job = await api.get<ProvisionJob>(`/servers/${seg(server.id)}/provision`);
        const step = job.log.split('\n').filter((l) => l.startsWith('::step::')).pop();
        await progress?.(step ? step.slice(8).trim() : `provisioning ${job.status}`);
      }
    }
    const steps = job.log
      .split('\n')
      .filter((l) => l.startsWith('::step::'))
      .map((l) => `- ${l.slice(8).trim()}`);
    const lines = [`Provisioning **${server.name}**: ${job.status}${job.status === 'running' && wait ? ' (still running; check again later with get_server)' : ''}.`];
    if (steps.length) lines.push('', 'Steps:', ...steps.slice(-15));
    if (job.status === 'failed' || (wait && job.log)) lines.push('', 'Log tail:', fence(tail(job.log, 3000)));
    if (job.status === 'succeeded') lines.push('', 'The agent will start reporting within ~30s. Deploy something with `create_app`.');
    if (job.status === 'running' && !wait) lines.push('', 'Call again with wait: true, or check get_server in a minute.');
    return { text: lines.join('\n'), data: { serverId: server.id, status: job.status, log: tail(job.log, 8000) } };
  },
});

export const deleteServer = defineTool({
  name: 'delete_server',
  title: 'Remove server',
  description:
    "Remove a server from Docksy (stops monitoring it; nothing on the VPS is wiped). Docksy refuses while apps still exist on it; delete or move those first. Use only when the user explicitly wants the server gone.",
  kind: 'destructive',
  input: { serverId: serverRef },
  async run({ serverId }, { api }) {
    const server = await resolveServer(api, serverId);
    await api.delete(`/servers/${seg(server.id)}`);
    return { text: `Removed server **${server.name}** (\`${server.id}\`) from Docksy.`, data: { ok: true, serverId: server.id } };
  },
});

export const serverTools = [listServers, getServer, listContainers, createServer, provisionServer, deleteServer];
