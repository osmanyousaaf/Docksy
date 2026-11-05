/**
 * core-platform: SSH key, servers CRUD, validate, provisioning (+ SSE log), public agent downloads.
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { ProvisionJob, Server, SshKeyInfo, ValidateServerResponse } from '@docksy/shared';
import { config } from '../../config.ts';
import { db, getSettings, newId, now, type Row } from '../../db/index.ts';
import { bus } from '../../lib/events.ts';
import { body, conflict, logActivity, notFound, type AppEnv } from '../../lib/http.ts';
import { issueAgentToken, requireUser } from '../../lib/auth.ts';
import { closeConnections, execTarget, exec, getKeyPair, q, type SshTarget } from '../../lib/ssh.ts';
import { toServer } from './model.ts';

// ───────────────────────────── helpers ─────────────────────────────

/** Servers are addressed by id; the name is accepted too for CLI/MCP convenience. */
function findServerRow(idOrName: string): Row {
  const r = (db.prepare('SELECT * FROM servers WHERE id = ?').get(idOrName) ??
    db.prepare('SELECT * FROM servers WHERE name = ?').get(idOrName)) as Row | undefined;
  if (!r) throw notFound('Server');
  return r;
}

const targetOf = (r: Row): SshTarget => ({ host: r.host, port: Number(r.port), sshUser: r.ssh_user });

export function sshKeyInfo(): SshKeyInfo {
  const k = getKeyPair();
  return {
    publicKey: k.publicKey,
    fingerprint: k.fingerprint,
    instructions: `mkdir -p ~/.ssh && echo '${k.publicKey}' >> ~/.ssh/authorized_keys`,
  };
}

const HOST_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$|^\[?[0-9a-fA-F:]+\]?$/;
const host = z.string().trim().min(1).max(253).regex(HOST_RE, 'Enter a hostname or IP address').transform((h) => h.replace(/^\[|\]$/g, ''));
const sshUser = z.string().trim().regex(/^[a-z_][a-z0-9_.-]{0,31}$/i, 'Enter a valid Unix user name');
const name = z.string().trim().min(1, 'Name is required').max(64);
const port = z.number().int().min(1).max(65535);

const CreateSchema = z.object({ name, host, port: port.optional(), sshUser: sshUser.optional() });
const UpdateSchema = z.object({ name: name.optional(), host: host.optional(), port: port.optional(), sshUser: sshUser.optional() });

function assertNameFree(n: string, exceptId?: string): void {
  const r = db.prepare('SELECT id FROM servers WHERE name = ?').get(n) as Row | undefined;
  if (r && r.id !== exceptId) throw conflict(`A server named "${n}" already exists`);
}

// ───────────────────────────── validate ─────────────────────────────

const PROBE = [
  'echo "user=$(id -un)"',
  'echo "uid=$(id -u)"',
  'if [ "$(id -u)" = 0 ]; then echo sudo=root; elif sudo -n true 2>/dev/null; then echo sudo=yes; else echo sudo=no; fi',
  'echo "kernel=$(uname -s)"',
  'echo "arch=$(uname -m)"',
  'if [ -r /etc/os-release ]; then . /etc/os-release; echo "os=${ID:-linux} ${VERSION_ID:-}"; echo "os_pretty=${PRETTY_NAME:-}"; fi',
  'if command -v docker >/dev/null 2>&1; then echo "docker=$(docker version --format \'{{.Server.Version}}\' 2>/dev/null || docker --version 2>/dev/null | head -n1)"; else echo docker=; fi',
  'echo "disk=$(df -Pk / 2>/dev/null | awk \'NR==2{print $2" "$4}\')"',
  'echo "cores=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN)"',
  'echo "mem=$(awk \'/^MemTotal:/{print $2}\' /proc/meminfo 2>/dev/null)"',
].join('; ');

export const MIN_FREE_DISK_BYTES = 2 * 1024 ** 3;

export function parseProbe(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const normArch = (a: string) => (a === 'x86_64' || a === 'amd64' ? 'amd64' : a === 'aarch64' || a === 'arm64' ? 'arm64' : a);
const gib = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GiB`;

/** Turn probe output into the user-facing checklist. */
export function probeChecks(p: Record<string, string>): ValidateServerResponse['checks'] {
  const checks: ValidateServerResponse['checks'] = [{ name: 'ssh', ok: true, detail: `Connected as ${p.user || 'unknown'}` }];

  const sudo = p.sudo ?? 'no';
  checks.push({
    name: 'root',
    ok: sudo === 'root' || sudo === 'yes',
    detail: sudo === 'root' ? 'Running as root' : sudo === 'yes' ? 'Passwordless sudo available' : 'Needs root or passwordless sudo (add "<user> ALL=(ALL) NOPASSWD:ALL" to sudoers)',
  });

  const linux = (p.kernel ?? '').toLowerCase() === 'linux';
  const arch = normArch(p.arch ?? '');
  const archOk = arch === 'amd64' || arch === 'arm64';
  checks.push({
    name: 'os',
    ok: linux && archOk,
    detail: !linux ? `Unsupported OS (${p.kernel || 'unknown'}); Docksy needs Linux`
      : !archOk ? `Unsupported CPU architecture ${p.arch}; Docksy supports amd64 and arm64`
      : `${p.os_pretty || p.os || 'Linux'} (${arch})`,
  });

  checks.push({
    name: 'docker',
    ok: true,
    detail: p.docker ? `Docker ${p.docker}` : 'Not installed yet. Provisioning will install it.',
  });

  const [totalKb, freeKb] = (p.disk ?? '').split(/\s+/).map(Number);
  const free = Number.isFinite(freeKb) ? freeKb! * 1024 : NaN;
  checks.push({
    name: 'disk',
    ok: Number.isFinite(free) && free >= MIN_FREE_DISK_BYTES,
    detail: !Number.isFinite(free) ? 'Could not read free disk space'
      : `${gib(free)} free of ${gib((totalKb ?? 0) * 1024)} on /${free < MIN_FREE_DISK_BYTES ? ' (need at least 2 GiB)' : ''}`,
  });
  return checks;
}

async function validateServer(r: Row): Promise<ValidateServerResponse> {
  let res;
  try {
    res = await execTarget(targetOf(r), PROBE, { timeoutMs: 30_000 });
  } catch (e) {
    return { ok: false, checks: [{ name: 'ssh', ok: false, detail: (e as Error).message }] };
  }
  const p = parseProbe(res.stdout);
  if (res.code !== 0 && !p.user) {
    return { ok: false, checks: [{ name: 'ssh', ok: false, detail: `Probe failed (exit ${res.code}): ${res.stderr.trim().slice(0, 300)}` }] };
  }
  const checks = probeChecks(p);
  // Prefill facts the agent will keep up to date later.
  const [totalKb] = (p.disk ?? '').split(/\s+/).map(Number);
  const cores = Number(p.cores);
  const memKb = Number(p.mem);
  db.prepare(`UPDATE servers SET os = COALESCE(?, os), arch = COALESCE(?, arch), cpu_cores = COALESCE(?, cpu_cores),
      mem_total = COALESCE(?, mem_total), disk_total = COALESCE(?, disk_total), updated_at = ? WHERE id = ?`)
    .run(p.os || null, p.arch ? normArch(p.arch) : null, Number.isFinite(cores) && cores > 0 ? cores : null,
      Number.isFinite(memKb) && memKb > 0 ? memKb * 1024 : null, Number.isFinite(totalKb) && totalKb! > 0 ? totalKb! * 1024 : null, now(), r.id);
  return { ok: checks.every((c) => c.ok), checks };
}

// ───────────────────────────── provisioning ─────────────────────────────

type JobEvent = { type: 'log'; line: string } | { type: 'status'; status: ProvisionJob['status'] };

interface Job {
  serverId: string;
  status: ProvisionJob['status'];
  lines: string[];
  listeners: Set<(e: JobEvent) => void>;
  abort: AbortController;
}

const jobs = new Map<string, Job>();
const STEP_RE = /^::step::\s*(.*)$/;
const MAX_LOG_LINES = 5000;

export const PROVISION_TIMEOUT_MS = 20 * 60_000;
export const INSTALL_AGENT_TIMEOUT_MS = 5 * 60_000;

/** Extract the step text from a `::step:: <text>` line, or null. */
export function parseStep(line: string): string | null {
  const m = STEP_RE.exec(line.trim());
  return m ? m[1]!.trim() : null;
}

const jobView = (j: Job): ProvisionJob => ({ serverId: j.serverId, status: j.status, log: j.lines.join('\n') });

function pushLine(j: Job, line: string): void {
  j.lines.push(line);
  if (j.lines.length > MAX_LOG_LINES) j.lines.splice(0, j.lines.length - MAX_LOG_LINES);
  for (const l of j.listeners) l({ type: 'log', line });
}

/** Splits streamed chunks into lines (handles \r progress output). */
function lineSplitter(onLine: (l: string) => void) {
  let buf = '';
  return {
    push(chunk: string) {
      buf += chunk;
      const parts = buf.split(/\r?\n|\r/);
      buf = parts.pop() ?? '';
      for (const p of parts) if (p.trim()) onLine(p);
    },
    flush() { if (buf.trim()) onLine(buf); buf = ''; },
  };
}

function saveLog(j: Job): void {
  db.prepare('UPDATE servers SET provision_log = ? WHERE id = ?').run(j.lines.join('\n'), j.serverId);
}

function readScript(file: string): string | null {
  const p = join(config.scriptsDir, file);
  try { return existsSync(p) ? readFileSync(p, 'utf8') : null; } catch { return null; }
}

/** Build the remote command: env vars + bash reading the script from stdin; via sudo when not root. */
export function scriptCommand(sshUserName: string, env: Record<string, string>): string {
  const vars = Object.entries(env).map(([k, v]) => `${k}=${q(v)}`).join(' ');
  return `${sshUserName === 'root' ? '' : 'sudo -n '}env ${vars} bash -s`.replace(/\s+/g, ' ').trim();
}

async function runScript(j: Job, r: Row, file: string, env: Record<string, string>, timeoutMs: number): Promise<boolean> {
  const script = readScript(file);
  if (script == null) {
    pushLine(j, `Error: ${file} not found in ${config.scriptsDir}. Is this Docksy install complete?`);
    return false;
  }
  const split = lineSplitter((l) => pushLine(j, l));
  let lastSave = Date.now();
  const res = await exec(r.id, scriptCommand(r.ssh_user, env), {
    stdin: script,
    timeoutMs,
    signal: j.abort.signal,
    onData: (chunk) => {
      split.push(chunk);
      if (Date.now() - lastSave > 2000) { lastSave = Date.now(); saveLog(j); }
    },
  });
  split.flush();
  if (res.code !== 0) {
    const why = res.code === 124 ? 'timed out' : res.code === 130 ? 'was cancelled' : `exited with code ${res.code}`;
    pushLine(j, `Error: ${file} ${why}`);
    return false;
  }
  return true;
}

async function runProvision(j: Job, actor: string): Promise<void> {
  const r = findServerRow(j.serverId);
  let ok = false;
  try {
    const settings = getSettings();
    const url = settings.publicUrl.replace(/\/+$/, '');
    if (/\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(url)) {
      pushLine(j, `Warning: the public URL is ${url}. The agent on ${r.host} may not be able to reach it. Set a reachable URL in Settings.`);
    }
    pushLine(j, `::step:: Connecting to ${r.ssh_user}@${r.host}:${r.port}`);
    const ping = await exec(r.id, 'echo docksy-ok', { timeoutMs: 30_000, signal: j.abort.signal });
    if (!ping.stdout.includes('docksy-ok')) throw new Error(`SSH check failed (exit ${ping.code}): ${ping.stderr.trim()}`);

    const baseEnv = { DOCKSY_URL: url, DOCKSY_AGENT_INTERVAL: String(config.agentIntervalSec) };
    if (await runScript(j, r, 'provision.sh', baseEnv, PROVISION_TIMEOUT_MS)) {
      pushLine(j, '::step:: Installing the Docksy agent');
      const token = issueAgentToken(r.id);
      ok = await runScript(j, r, 'install-agent.sh', { ...baseEnv, DOCKSY_AGENT_TOKEN: token }, INSTALL_AGENT_TIMEOUT_MS);
    }
  } catch (e) {
    pushLine(j, `Error: ${(e as Error).message}`);
    ok = false;
  }
  if (ok) pushLine(j, '::step:: Server is ready');
  j.status = ok ? 'succeeded' : 'failed';
  // The row may have been deleted meanwhile; UPDATE is then a no-op.
  db.prepare('UPDATE servers SET status = ?, provision_log = ?, updated_at = ? WHERE id = ?')
    .run(ok ? 'ready' : 'error', j.lines.join('\n'), now(), j.serverId);
  logActivity(actor, ok ? 'server.provisioned' : 'server.provision_failed', 'server', j.serverId);
  for (const l of j.listeners) l({ type: 'status', status: j.status });
  j.listeners.clear();
}

/** Start provisioning (or return the job already running). */
export function startProvision(serverId: string, actor: string): ProvisionJob {
  const existing = jobs.get(serverId);
  if (existing?.status === 'running') return jobView(existing);
  const j: Job = { serverId, status: 'running', lines: [], listeners: new Set(), abort: new AbortController() };
  jobs.set(serverId, j);
  db.prepare("UPDATE servers SET status = 'provisioning', provision_log = '', updated_at = ? WHERE id = ?").run(now(), serverId);
  void runProvision(j, actor).catch((e) => console.error('[docksy] provisioning crashed', e));
  return jobView(j);
}

/** Current job: from memory, else reconstructed from the server row. */
export function getProvisionJob(r: Row): ProvisionJob | null {
  const j = jobs.get(r.id);
  if (j) return jobView(j);
  if (r.status === 'new' && !r.provision_log) return null;
  const status: ProvisionJob['status'] = r.status === 'ready' ? 'succeeded' : r.status === 'provisioning' ? 'running' : 'failed';
  return { serverId: r.id, status, log: r.provision_log ?? '' };
}

// ───────────────────────────── routes ─────────────────────────────

const AGENT_PLATFORMS = new Set(['linux-amd64', 'linux-arm64']);

export function registerServers(app: Hono<AppEnv>): void {
  // ── public agent downloads (outside /api/v1) ──
  app.get('/api/agent/v1/binary/:platform', (c) => {
    const platform = c.req.param('platform');
    if (!AGENT_PLATFORMS.has(platform)) throw notFound('Agent binary');
    const file = join(config.agentBinDir, `docksy-agent-${platform}`);
    let size: number;
    try { const st = statSync(file); if (!st.isFile()) throw new Error(); size = st.size; } catch { throw notFound('Agent binary'); }
    const stream = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream;
    return c.body(stream, 200, {
      'content-type': 'application/octet-stream',
      'content-length': String(size),
      'content-disposition': `attachment; filename="docksy-agent-${platform}"`,
      'cache-control': 'no-cache',
    });
  });

  app.get('/api/agent/v1/install.sh', (c) => {
    const s = readScript('install-agent.sh');
    if (s == null) throw notFound('install-agent.sh');
    return c.body(s, 200, { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-cache' });
  });

  // ── authenticated ──
  app.get('/api/v1/ssh-key', requireUser, (c) => c.json(sshKeyInfo()));

  app.get('/api/v1/servers', requireUser, (c) => {
    const rows = db.prepare('SELECT * FROM servers ORDER BY created_at').all() as Row[];
    return c.json({ items: rows.map(toServer) });
  });

  app.post('/api/v1/servers', requireUser, async (c) => {
    const input = await body(c, CreateSchema);
    assertNameFree(input.name);
    const id = newId();
    const t = now();
    db.prepare('INSERT INTO servers (id, name, host, port, ssh_user, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.name, input.host, input.port ?? 22, input.sshUser ?? 'root', 'new', t, t);
    logActivity(c.get('actor'), 'server.create', 'server', id, `${input.name} (${input.host})`);
    bus.emit('server.created', { serverId: id });
    const server: Server = toServer(findServerRow(id));
    return c.json(server, 201);
  });

  app.get('/api/v1/servers/:id', requireUser, (c) => c.json(toServer(findServerRow(c.req.param('id')))));

  app.patch('/api/v1/servers/:id', requireUser, async (c) => {
    const r = findServerRow(c.req.param('id'));
    const input = await body(c, UpdateSchema);
    if (input.name !== undefined) assertNameFree(input.name, r.id);
    const connChanged = (input.host !== undefined && input.host !== r.host) || (input.port !== undefined && input.port !== Number(r.port))
      || (input.sshUser !== undefined && input.sshUser !== r.ssh_user);
    if (connChanged) closeConnections(targetOf(r));
    db.prepare('UPDATE servers SET name = ?, host = ?, port = ?, ssh_user = ?, updated_at = ? WHERE id = ?')
      .run(input.name ?? r.name, input.host ?? r.host, input.port ?? r.port, input.sshUser ?? r.ssh_user, now(), r.id);
    logActivity(c.get('actor'), 'server.update', 'server', r.id, Object.keys(input).join(', ') || null);
    return c.json(toServer(findServerRow(r.id)));
  });

  app.delete('/api/v1/servers/:id', requireUser, (c) => {
    const r = findServerRow(c.req.param('id'));
    const apps = Number((db.prepare('SELECT COUNT(*) AS n FROM apps WHERE server_id = ?').get(r.id) as Row).n);
    if (apps > 0) throw conflict(`This server still has ${apps} app${apps === 1 ? '' : 's'}. Delete or move them first.`);
    const job = jobs.get(r.id);
    if (job?.status === 'running') job.abort.abort();
    jobs.delete(r.id);
    closeConnections(targetOf(r));
    db.prepare('DELETE FROM servers WHERE id = ?').run(r.id);
    logActivity(c.get('actor'), 'server.delete', 'server', r.id, r.name);
    bus.emit('server.deleted', { serverId: r.id });
    return c.json({ ok: true });
  });

  app.post('/api/v1/servers/:id/validate', requireUser, async (c) => {
    const r = findServerRow(c.req.param('id'));
    const res = await validateServer(r);
    logActivity(c.get('actor'), 'server.validate', 'server', r.id, res.ok ? 'ok' : 'failed');
    return c.json(res);
  });

  app.post('/api/v1/servers/:id/provision', requireUser, (c) => {
    const r = findServerRow(c.req.param('id'));
    const running = jobs.get(r.id)?.status === 'running';
    const job = startProvision(r.id, c.get('actor'));
    if (!running) logActivity(c.get('actor'), 'server.provision', 'server', r.id);
    return c.json(job, running ? 200 : 202);
  });

  app.get('/api/v1/servers/:id/provision', requireUser, (c) => {
    const job = getProvisionJob(findServerRow(c.req.param('id')));
    if (!job) throw notFound('Provisioning job');
    return c.json(job);
  });

  app.get('/api/v1/servers/:id/provision/stream', requireUser, (c) => {
    const r = findServerRow(c.req.param('id'));
    return streamSSE(c, async (s) => {
      const j = jobs.get(r.id);
      const send = (event: string, data: unknown) => s.writeSSE({ event, data: JSON.stringify(data) });
      // Every line is sent as `log`; `::step::` lines are additionally sent as `step` {step} for progress UIs.
      const sendLine = async (line: string) => {
        await send('log', { line });
        const step = parseStep(line);
        if (step) await send('step', { step });
      };
      if (!j) {
        const view = getProvisionJob(r);
        for (const line of (view?.log ?? '').split('\n')) if (line) await sendLine(line);
        if (view) await send('status', { status: view.status });
        return;
      }
      // Subscribe first so nothing is lost while replaying.
      const queue: JobEvent[] = [];
      let wake: (() => void) | null = null;
      const listener = (e: JobEvent) => { queue.push(e); wake?.(); };
      const replay = [...j.lines];
      const finished = j.status !== 'running';
      if (!finished) j.listeners.add(listener);
      s.onAbort(() => { j.listeners.delete(listener); wake?.(); });
      for (const line of replay) await sendLine(line);
      if (finished) { await send('status', { status: j.status }); return; }
      await send('status', { status: 'running' });
      const heartbeat = setInterval(() => { void s.write(': ping\n\n'); }, 15_000);
      try {
        while (!s.aborted) {
          while (queue.length) {
            const e = queue.shift()!;
            if (e.type === 'log') await sendLine(e.line);
            else { await send('status', { status: e.status }); return; }
          }
          await new Promise<void>((res) => { wake = res; });
          wake = null;
        }
      } finally {
        clearInterval(heartbeat);
        j.listeners.delete(listener);
      }
    });
  });
}

/** On boot: servers left in 'provisioning' by a crash/restart are marked as errored. */
export function startServers(): void {
  const rows = db.prepare("SELECT id, provision_log FROM servers WHERE status = 'provisioning'").all() as Row[];
  for (const r of rows) {
    if (jobs.get(r.id)?.status === 'running') continue;
    const log = `${r.provision_log ? `${r.provision_log}\n` : ''}Error: provisioning was interrupted because Docksy restarted. Run it again.`;
    db.prepare("UPDATE servers SET status = 'error', provision_log = ?, updated_at = ? WHERE id = ?").run(log, now(), r.id);
  }
}
