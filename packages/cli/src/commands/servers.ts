/** servers ls | add | rm | provision */
import pc from 'picocolors';
import { DocksyApiError, type DocksyClient, type Server } from '@crovenai/docksy-client';
import type { Ctx } from '../context.ts';
import { CliError, ExitCode } from '../context.ts';
import { formatBytes, livenessDot, statusColor, sym, table, timeAgo, type Column } from '../format.ts';
import { confirm } from '../prompt.ts';
import { resolveServer } from '../resolve.ts';

const json = (ctx: Ctx, data: unknown) => ctx.print(JSON.stringify(data, null, 2));

export function parsePort(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new CliError(`"${v}" is not a valid port.`);
  return n;
}

export async function serversLs(ctx: Ctx, o: { json?: boolean }): Promise<void> {
  const servers = await ctx.client().listServers();
  if (o.json) return json(ctx, servers);
  if (servers.length === 0) {
    ctx.print(` No servers yet. Add one: ${pc.cyan('docksy servers add <name> <host>')}`);
    return;
  }
  ctx.print(renderServers(servers, ctx.width()));
}

export function renderServers(servers: Server[], width: number, now = Date.now()): string {
  const cols: Column[] = [
    { header: 'Name' }, { header: 'Host', flex: true }, { header: 'Status' }, { header: 'Agent' },
    { header: 'OS', flex: true }, { header: 'CPU', align: 'right' }, { header: 'Mem', align: 'right' }, { header: 'Disk', align: 'right' },
  ];
  const rows = servers.map((s) => [
    `${livenessDot(s.liveness)} ${pc.bold(s.name)}`,
    `${s.sshUser}@${s.host}${s.port === 22 ? '' : `:${s.port}`}`,
    statusColor(s.status),
    s.liveness === 'online' ? pc.green('online') : s.lastSeenAt ? pc.red(`seen ${timeAgo(s.lastSeenAt, now)}`) : pc.dim('not installed'),
    [s.os, s.arch].filter(Boolean).join(' ') || pc.dim('–'),
    s.cpuCores ? `${s.cpuCores}c` : pc.dim('–'),
    s.memTotal ? formatBytes(s.memTotal) : pc.dim('–'),
    s.diskTotal ? formatBytes(s.diskTotal) : pc.dim('–'),
  ]);
  return table(cols, rows, { width, indent: 1 });
}

export async function serversAdd(ctx: Ctx, name: string, host: string, o: { port?: string; user?: string; validate?: boolean; provision?: boolean; json?: boolean }): Promise<void> {
  const client = ctx.client();
  const key = await client.getSshKey().catch(() => null);
  const server = await client.createServer({ name, host, port: o.port ? parsePort(o.port) : undefined, sshUser: o.user });
  if (o.json && o.validate === false) return json(ctx, server);
  if (!o.json) {
    ctx.print(` ${sym.ok} Added server ${pc.bold(server.name)} ${pc.dim(`(${server.sshUser}@${server.host}:${server.port}, id ${server.id})`)}`);
    if (key) {
      ctx.print('');
      ctx.print(` ${pc.bold('Give Docksy SSH access')} ${pc.dim('— run this on the server once:')}`);
      ctx.print(`   ${pc.cyan(key.instructions)}`);
      ctx.print(pc.dim(`   key fingerprint ${key.fingerprint}`));
    }
  }
  if (o.validate === false) {
    ctx.print('');
    ctx.print(` Next: ${pc.cyan(`docksy servers provision ${server.name}`)}`);
    return;
  }
  if (!o.json) { ctx.print(''); ctx.print(` ${pc.dim('Checking the server…')}`); }
  const v = await client.validateServer(server.id);
  if (o.json) return json(ctx, { server, validation: v });
  for (const c of v.checks) ctx.print(`   ${c.ok ? sym.ok : sym.fail} ${padName(c.name)} ${pc.dim(c.detail)}`);
  ctx.print('');
  if (!v.ok) {
    ctx.print(` ${sym.warn} Some checks failed. Fix them (usually: add the SSH key above), then run ${pc.cyan(`docksy servers provision ${server.name}`)}.`);
    return;
  }
  if (o.provision) return serversProvision(ctx, server.id, { follow: true });
  ctx.print(` ${sym.ok} Looks good. Next: ${pc.cyan(`docksy servers provision ${server.name}`)} ${pc.dim('(installs Docker, the proxy and the metrics agent)')}`);
}

const padName = (s: string) => s.padEnd(8);

export async function serversRm(ctx: Ctx, ref: string, o: { yes?: boolean }): Promise<void> {
  const client = ctx.client();
  const server = await resolveServer(client, ref);
  await confirm(ctx, `Remove server ${pc.bold(server.name)} (${server.host}) from Docksy? Its containers keep running.`, o);
  try {
    await client.deleteServer(server.id);
  } catch (e) {
    if (e instanceof DocksyApiError && e.status === 409) {
      throw new CliError(e.message, { hint: `Remove its apps first: docksy apps ls --server ${server.name}` });
    }
    throw e;
  }
  ctx.print(` ${sym.ok} Removed server ${pc.bold(server.name)}.`);
}

export async function serversProvision(ctx: Ctx, ref: string, o: { follow?: boolean }): Promise<void> {
  const client = ctx.client();
  const server = await resolveServer(client, ref);
  const job = await client.provisionServer(server.id);
  ctx.print(` ${pc.cyan('▸')} Provisioning ${pc.bold(server.name)} ${pc.dim(`(${server.host})`)}…`);
  if (o.follow === false) {
    ctx.print(pc.dim(`   Follow along: docksy servers provision ${server.name}  ·  or watch it in the web UI`));
    return;
  }
  const status = await followProvision(ctx, client, server.id, job.status);
  if (status === 'succeeded') {
    ctx.print(` ${sym.ok} ${pc.bold(server.name)} is ready. Deploy something: ${pc.cyan(`docksy apps create <name> --server ${server.name} --image nginx`)}`);
    return;
  }
  ctx.warn(` ${sym.fail} Provisioning failed. Ask Claude: ${pc.cyan(`/docksy:diagnose ${server.name}`)}`);
  throw new ExitCode(1);
}

export function formatProvisionLine(line: string): string {
  const step = /^::step::\s*(.*)$/.exec(line);
  if (step) return ` ${pc.cyan('▸')} ${pc.bold(step[1])}`;
  if (/\b(error|failed|fatal)\b/i.test(line)) return `   ${pc.red(line)}`;
  return `   ${pc.dim(line)}`;
}

async function followProvision(ctx: Ctx, client: DocksyClient, id: string, initial: string): Promise<string> {
  let status = initial;
  try {
    for await (const ev of client.streamProvision(id)) {
      if (ev.event === 'log') for (const l of String(ev.data.line ?? '').split('\n')) ctx.print(formatProvisionLine(l));
      else if (ev.event === 'status') {
        status = ev.data.status;
        if (status !== 'running') return status;
      }
    }
  } catch (e) {
    if (!(e instanceof DocksyApiError) || e.status !== 0) throw e;
  }
  // Stream ended without a final status: poll.
  for (let i = 0; i < 600 && status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    status = (await client.getProvisionJob(id)).status;
  }
  return status;
}
