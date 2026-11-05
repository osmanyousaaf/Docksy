/**
 * SSH executor (owned by core-platform). Signatures of exec/execTarget/putFile/q are FROZEN.
 *
 * - Uses the instance keypair in data/keys/id_ed25519 (generated on first use).
 * - Keeps a small connection pool per target, closed after 60s idle.
 * - exec never throws on a non-zero exit; it throws only when it can't connect / open a channel.
 *   A timeout resolves with code 124, an abort with code 130 (like `timeout(1)` and Ctrl-C).
 * - Tests can swap the transport with setSshImpl(fake) — no sockets needed.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ssh2 from 'ssh2';
import type { Client as SshClient, ClientChannel } from 'ssh2';
import { config } from '../config.ts';
import { db, type Row } from '../db/index.ts';

const { Client, utils } = ssh2;

/** Thrown when Docksy cannot reach or log in to a server. errorHandler maps it to 502 `server_unreachable`. */
export class SshConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SshConnectError';
  }
}

export interface ExecOptions {
  timeoutMs?: number; // default 120_000; 0 = none
  stdin?: string | Buffer;
  /** Called with each output chunk as it arrives (for streaming logs). */
  onData?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** Abort a long-running command. */
  signal?: AbortSignal;
}

export interface ExecResult { code: number; stdout: string; stderr: string }

export interface SshTarget { host: string; port: number; sshUser: string }

/** Target handed to an SshImpl: serverId is set when the call came through exec(serverId)/putFile(serverId). */
export type ResolvedTarget = SshTarget & { serverId: string | null };

/** Pluggable transport. The default uses ssh2; tests install a fake with setSshImpl(). */
export interface SshImpl {
  exec(target: ResolvedTarget, command: string, opts: ExecOptions): Promise<ExecResult>;
  /** Optional: when missing, putFile is implemented on top of exec (cat > file). */
  putFile?(target: ResolvedTarget, remotePath: string, content: Buffer, mode: number): Promise<void>;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
export const IDLE_CLOSE_MS = 60_000;
const CONNECT_TIMEOUT_MS = 20_000;
/** OpenSSH MaxSessions defaults to 10; stay under it and open another connection when busy. */
const MAX_CHANNELS_PER_CONN = 8;
const MAX_CONNS_PER_TARGET = 4;

// ───────────────────────────── keypair ─────────────────────────────

export interface KeyPair { privateKey: string; publicKey: string; fingerprint: string }

let cachedKeys: KeyPair | null = null;

/** SHA256 fingerprint of an OpenSSH public key line, like `ssh-keygen -lf` ("SHA256:…"). */
export function fingerprintOf(publicKeyLine: string): string {
  const blob = Buffer.from(publicKeyLine.trim().split(/\s+/)[1] ?? '', 'base64');
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** Load the instance keypair, generating data/keys/id_ed25519 (+ .pub) on first use. */
export function getKeyPair(): KeyPair {
  if (cachedKeys) return cachedKeys;
  const privPath = join(config.keysDir, 'id_ed25519');
  const pubPath = `${privPath}.pub`;
  let privateKey: string;
  let publicKey: string;
  if (existsSync(privPath)) {
    privateKey = readFileSync(privPath, 'utf8');
    if (existsSync(pubPath)) {
      publicKey = readFileSync(pubPath, 'utf8').trim();
    } else {
      const parsed = utils.parseKey(privateKey);
      if (parsed instanceof Error) throw new Error(`Cannot read SSH key ${privPath}: ${parsed.message}`);
      const k = Array.isArray(parsed) ? parsed[0] : parsed;
      publicKey = `${k.type} ${k.getPublicSSH().toString('base64')} docksy`;
      writeFileSync(pubPath, `${publicKey}\n`, { mode: 0o644 });
    }
  } else {
    mkdirSync(config.keysDir, { recursive: true, mode: 0o700 });
    const kp = utils.generateKeyPairSync('ed25519', { comment: 'docksy' });
    privateKey = kp.private;
    publicKey = kp.public.trim();
    writeFileSync(privPath, privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`, { mode: 0o600 });
    writeFileSync(pubPath, `${publicKey}\n`, { mode: 0o644 });
    try { chmodSync(privPath, 0o600); } catch { /* best effort */ }
  }
  cachedKeys = { privateKey, publicKey, fingerprint: fingerprintOf(publicKey) };
  return cachedKeys;
}

// ───────────────────────────── connection pool ─────────────────────────────

interface PooledConn {
  client: SshClient;
  ready: Promise<SshClient>;
  active: number;
  dead: boolean;
  idleTimer: NodeJS.Timeout | null;
}

const pool = new Map<string, PooledConn[]>();
const keyOf = (t: SshTarget) => `${t.sshUser}@${t.host}:${t.port}`;

function dropConn(key: string, conn: PooledConn): void {
  conn.dead = true;
  if (conn.idleTimer) clearTimeout(conn.idleTimer);
  conn.idleTimer = null;
  const list = pool.get(key);
  if (list) {
    const i = list.indexOf(conn);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) pool.delete(key);
  }
  try { conn.client.end(); } catch { /* already closed */ }
}

function openConn(key: string, target: SshTarget): PooledConn {
  const client = new Client();
  const conn: PooledConn = { client, ready: null as unknown as Promise<SshClient>, active: 0, dead: false, idleTimer: null };
  conn.ready = new Promise<SshClient>((resolve, reject) => {
    let settled = false;
    client.once('ready', () => { settled = true; resolve(client); });
    client.on('error', (err) => {
      if (!settled) { settled = true; reject(friendlyConnectError(err, target)); }
      dropConn(key, conn);
    });
    client.on('close', () => {
      if (!settled) { settled = true; reject(new SshConnectError(`SSH connection to ${key} closed before it was ready`)); }
      dropConn(key, conn);
    });
    try {
      client.connect({
        host: target.host,
        port: target.port,
        username: target.sshUser,
        privateKey: getKeyPair().privateKey,
        readyTimeout: CONNECT_TIMEOUT_MS,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
      });
    } catch (e) {
      settled = true;
      reject(e instanceof Error ? e : new Error(String(e)));
      dropConn(key, conn);
    }
  });
  conn.ready.catch(() => { /* handled by the caller awaiting it */ });
  const list = pool.get(key) ?? [];
  list.push(conn);
  pool.set(key, list);
  return conn;
}

function friendlyConnectError(err: Error & { level?: string; code?: string }, t: SshTarget): SshConnectError {
  const where = `${t.sshUser}@${t.host}:${t.port}`;
  if (err.level === 'client-authentication') {
    return new SshConnectError(`SSH login to ${where} was rejected. Add Docksy's public key to ~/.ssh/authorized_keys for ${t.sshUser} on that server.`);
  }
  if (err.code === 'ECONNREFUSED') return new SshConnectError(`Connection refused by ${t.host}:${t.port}. Is sshd running and the port open?`);
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return new SshConnectError(`Cannot resolve host "${t.host}".`);
  if (err.code === 'ETIMEDOUT' || /timed out/i.test(err.message)) return new SshConnectError(`Timed out connecting to ${where}. Check the IP, port and firewall.`);
  return new SshConnectError(`SSH connection to ${where} failed: ${err.message}`);
}

function acquire(target: SshTarget): { conn: PooledConn; fresh: boolean } {
  const key = keyOf(target);
  const list = (pool.get(key) ?? []).filter((c) => !c.dead).sort((a, b) => a.active - b.active);
  let conn = list.find((c) => c.active < MAX_CHANNELS_PER_CONN) ?? (list.length >= MAX_CONNS_PER_TARGET ? list[0] : undefined);
  const fresh = !conn;
  if (!conn) conn = openConn(key, target);
  conn.active++;
  if (conn.idleTimer) { clearTimeout(conn.idleTimer); conn.idleTimer = null; }
  return { conn, fresh };
}

function release(target: SshTarget, conn: PooledConn): void {
  conn.active = Math.max(0, conn.active - 1);
  if (conn.active === 0 && !conn.dead) {
    conn.idleTimer = setTimeout(() => dropConn(keyOf(target), conn), IDLE_CLOSE_MS);
    conn.idleTimer.unref();
  }
}

/** Close pooled connections (all, or those for one server/target). */
export function closeConnections(target?: SshTarget): void {
  for (const [key, list] of [...pool.entries()]) {
    if (target && key !== keyOf(target)) continue;
    for (const c of [...list]) dropConn(key, c);
  }
}

/** Number of open pooled connections (for tests/diagnostics). */
export function poolSize(): number {
  let n = 0;
  for (const list of pool.values()) n += list.length;
  return n;
}

function openChannel(client: SshClient, command: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    try {
      client.exec(command, (err, stream) => (err ? reject(err) : resolve(stream)));
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

function runOnChannel(stream: ClientChannel, opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let done = false;
    let forced: { code: number; msg: string } | null = null;
    let timer: NodeJS.Timeout | null = null;

    const finish = (code: number) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      let stderr = Buffer.concat(err).toString('utf8');
      if (forced) stderr += `${stderr && !stderr.endsWith('\n') ? '\n' : ''}${forced.msg}\n`;
      resolve({ code: forced ? forced.code : code, stdout: Buffer.concat(out).toString('utf8'), stderr });
    };
    const kill = (code: number, msg: string) => {
      if (done || forced) return;
      forced = { code, msg };
      try { stream.signal('KILL'); } catch { /* not supported by every sshd */ }
      try { stream.close(); } catch { /* ignore */ }
      // If the channel never reports close, resolve anyway.
      setTimeout(() => finish(code), 2000).unref();
    };
    const onAbort = () => kill(130, 'Command aborted');

    stream.on('data', (d: Buffer) => { out.push(d); opts.onData?.(d.toString('utf8'), 'stdout'); });
    stream.stderr.on('data', (d: Buffer) => { err.push(d); opts.onData?.(d.toString('utf8'), 'stderr'); });
    stream.on('close', (code: number | null, signal?: string) => finish(code ?? (signal ? 255 : 0)));
    stream.on('error', () => finish(255));

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (timeoutMs > 0) timer = setTimeout(() => kill(124, `Command timed out after ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    if (opts.stdin !== undefined) stream.end(opts.stdin);
    else stream.end();
  });
}

const ssh2Impl: SshImpl = {
  async exec(target, command, opts) {
    if (opts.signal?.aborted) return { code: 130, stdout: '', stderr: 'Command aborted\n' };
    // One retry: a pooled connection may have silently died since its last use.
    for (let attempt = 0; ; attempt++) {
      const { conn, fresh } = acquire(target);
      let stream: ClientChannel;
      try {
        const client = await conn.ready;
        stream = await openChannel(client, command);
      } catch (e) {
        release(target, conn);
        if (!fresh && attempt === 0) {
          dropConn(keyOf(target), conn);
          continue;
        }
        throw e;
      }
      try {
        return await runOnChannel(stream, opts);
      } finally {
        release(target, conn);
      }
    }
  },
};

let impl: SshImpl = ssh2Impl;

/** Test seam: replace the SSH transport (pass null to restore the real one). */
export function setSshImpl(fake: SshImpl | null): void {
  impl = fake ?? ssh2Impl;
}

// ───────────────────────────── frozen API ─────────────────────────────

function resolveServer(serverId: string): ResolvedTarget {
  const r = db.prepare('SELECT id, host, port, ssh_user FROM servers WHERE id = ?').get(serverId) as Row | undefined;
  if (!r) throw new Error(`Server ${serverId} not found`);
  return { serverId: r.id, host: r.host, port: Number(r.port), sshUser: r.ssh_user };
}

/** Run a shell command on a server by id. Never throws on non-zero exit; throws on connection failure. */
export async function exec(serverId: string, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
  return impl.exec(resolveServer(serverId), command, opts);
}

/** Same as exec but against an explicit target (used before a server row is validated). */
export async function execTarget(target: SshTarget, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
  return impl.exec({ serverId: null, host: target.host, port: target.port, sshUser: target.sshUser }, command, opts);
}

/** Upload a file's contents to a path on the server (mode e.g. 0o755). Throws if the write fails. */
export async function putFile(serverId: string, remotePath: string, content: string | Buffer, mode = 0o644): Promise<void> {
  const target = resolveServer(serverId);
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  if (impl.putFile) return impl.putFile(target, remotePath, buf, mode);
  const dir = dirname(remotePath);
  const tmp = `${remotePath}.docksy-tmp-${process.pid}-${Date.now()}`;
  const cmd = `mkdir -p ${q(dir)} && cat > ${q(tmp)} && chmod ${mode.toString(8)} ${q(tmp)} && mv -f ${q(tmp)} ${q(remotePath)}`;
  const r = await impl.exec(target, cmd, { stdin: buf, timeoutMs: 300_000 });
  if (r.code !== 0) {
    await impl.exec(target, `rm -f ${q(tmp)}`, { timeoutMs: 15_000 }).catch(() => undefined);
    throw new Error(`Upload to ${remotePath} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
}

/** Shell-quote a single argument for POSIX sh. */
export function q(arg: string): string {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}
