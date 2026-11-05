import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

process.env.DOCKSY_DATA_DIR = mkdtempSync(join(tmpdir(), 'docksy-ssh-'));
process.env.DOCKSY_DB_PATH = ':memory:';
process.env.DOCKSY_DISABLE_JOBS = '1';

const { default: ssh2 } = await import('ssh2');
const { db, migrate } = await import('../db/index.ts');
const ssh = await import('./ssh.ts');
migrate();

test('q quotes for POSIX sh', () => {
  assert.equal(ssh.q('abc'), `'abc'`);
  assert.equal(ssh.q(`it's`), `'it'\\''s'`);
  assert.equal(ssh.q('$(rm -rf /)'), `'$(rm -rf /)'`);
});

test('keypair is generated once into data/keys with safe permissions', () => {
  const k = ssh.getKeyPair();
  const priv = join(process.env.DOCKSY_DATA_DIR!, 'keys', 'id_ed25519');
  assert.match(readFileSync(priv, 'utf8'), /BEGIN OPENSSH PRIVATE KEY/);
  assert.equal(statSync(priv).mode & 0o777, 0o600);
  assert.equal(readFileSync(`${priv}.pub`, 'utf8').trim(), k.publicKey);
  assert.match(k.publicKey, /^ssh-ed25519 \S+ docksy$/);
  assert.equal(ssh.getKeyPair(), k);
  assert.equal(k.fingerprint, ssh.fingerprintOf(k.publicKey));
});

// ── a real in-process SSH server on loopback, to exercise the ssh2 transport ──
const hostKey = ssh2.utils.generateKeyPairSync('ed25519').private;
const allowed = ssh2.utils.parseKey(ssh.getKeyPair().publicKey);
if (allowed instanceof Error) throw allowed;
const allowedKey = Array.isArray(allowed) ? allowed[0] : allowed;
let connections = 0;
const sockets = new Set<import('ssh2').Connection>();

const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
  connections++;
  sockets.add(client);
  client.on('error', () => {});
  client.on('close', () => sockets.delete(client));
  client.on('authentication', (ctx) => {
    if (ctx.method !== 'publickey' || ctx.username !== 'root' || !ctx.key.data.equals(allowedKey.getPublicSSH())) return ctx.reject(['publickey']);
    if (!ctx.signature) return ctx.accept();
    if (ctx.blob && allowedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) return ctx.accept();
    return ctx.reject(['publickey']);
  });
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec();
        const [cmd, arg] = info.command.split(' ');
        if (cmd === 'echo') { stream.write(`${arg}\n`); stream.exit(0); stream.end(); }
        else if (cmd === 'fail') { stream.stderr.write('bad thing\n'); stream.exit(Number(arg)); stream.end(); }
        else if (cmd === 'cat') {
          const chunks: Buffer[] = [];
          stream.on('data', (d: Buffer) => chunks.push(d));
          stream.on('end', () => { stream.write(Buffer.concat(chunks)); stream.exit(0); stream.end(); });
        } else if (cmd === 'stream') {
          stream.write('one\n');
          setTimeout(() => { stream.stderr.write('two\n'); stream.exit(0); stream.end(); }, 20);
        } else if (cmd === 'sleep') { /* never finishes on its own */ }
        else { stream.stderr.write('unknown\n'); stream.exit(127); stream.end(); }
      });
    });
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as AddressInfo).port;
db.prepare("INSERT INTO servers (id, name, host, port, ssh_user, created_at, updated_at) VALUES ('s1', 'local', '127.0.0.1', ?, 'root', 0, 0)").run(port);

after(() => {
  ssh.closeConnections();
  for (const s of sockets) s.end();
  server.close();
});

test('exec runs commands and reuses one pooled connection', async () => {
  const before = connections;
  const a = await ssh.exec('s1', 'echo hello');
  assert.deepEqual(a, { code: 0, stdout: 'hello\n', stderr: '' });
  const [b, c] = await Promise.all([ssh.exec('s1', 'echo b'), ssh.exec('s1', 'echo c')]);
  assert.equal(b.stdout, 'b\n');
  assert.equal(c.stdout, 'c\n');
  assert.equal(connections - before, 1);
  assert.equal(ssh.poolSize(), 1);
});

test('non-zero exit resolves (never throws)', async () => {
  const r = await ssh.exec('s1', 'fail 3');
  assert.equal(r.code, 3);
  assert.equal(r.stderr, 'bad thing\n');
});

test('stdin is piped and onData streams chunks', async () => {
  const r = await ssh.exec('s1', 'cat', { stdin: 'some input' });
  assert.equal(r.stdout, 'some input');
  const seen: string[] = [];
  const s = await ssh.exec('s1', 'stream', { onData: (chunk, which) => seen.push(`${which}:${chunk}`) });
  assert.equal(s.code, 0);
  assert.deepEqual(seen, ['stdout:one\n', 'stderr:two\n']);
});

test('timeout resolves with 124, abort with 130', async () => {
  const t = await ssh.exec('s1', 'sleep', { timeoutMs: 100 });
  assert.equal(t.code, 124);
  assert.match(t.stderr, /timed out/);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const a = await ssh.exec('s1', 'sleep', { signal: ac.signal, timeoutMs: 0 });
  assert.equal(a.code, 130);
  assert.match(a.stderr, /aborted/);
});

test('execTarget works against an explicit target', async () => {
  const r = await ssh.execTarget({ host: '127.0.0.1', port, sshUser: 'root' }, 'echo direct');
  assert.equal(r.stdout, 'direct\n');
});

test('a dead pooled connection is replaced transparently', async () => {
  for (const s of sockets) s.end();
  await new Promise((r) => setTimeout(r, 50));
  const r = await ssh.exec('s1', 'echo again');
  assert.equal(r.stdout, 'again\n');
});

test('connection failures throw with a helpful message', async () => {
  await assert.rejects(ssh.execTarget({ host: '127.0.0.1', port, sshUser: 'nobody' }, 'echo x'), /rejected.*authorized_keys/);
  await assert.rejects(ssh.exec('missing', 'echo x'), /not found/);
});

test('setSshImpl swaps the transport', async () => {
  ssh.setSshImpl({ exec: async (t, cmd) => ({ code: 0, stdout: `${t.serverId}:${cmd}`, stderr: '' }) });
  try {
    assert.equal((await ssh.exec('s1', 'whoami')).stdout, 's1:whoami');
  } finally {
    ssh.setSshImpl(null);
  }
  assert.equal((await ssh.exec('s1', 'echo real')).stdout, 'real\n');
});
