import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'docksy-servers-'));
const scriptsDir = join(root, 'scripts');
const binDir = join(root, 'bin');
mkdirSync(scriptsDir);
mkdirSync(binDir);
process.env.DOCKSY_DATA_DIR = join(root, 'data');
process.env.DOCKSY_SCRIPTS_DIR = scriptsDir;
process.env.DOCKSY_AGENT_BIN_DIR = binDir;
process.env.DOCKSY_DB_PATH = ':memory:';
process.env.DOCKSY_DISABLE_JOBS = '1';
delete process.env.DOCKSY_PUBLIC_URL;

const { Hono } = await import('hono');
const { db, migrate, setSettings } = await import('../../db/index.ts');
const { errorHandler } = await import('../../lib/http.ts');
const { sha256 } = await import('../../lib/crypto.ts');
const { bus } = await import('../../lib/events.ts');
const ssh = await import('../../lib/ssh.ts');
const auth = await import('../auth/index.ts');
const servers = await import('./index.ts');
migrate();

const app = new Hono<import('../../lib/http.ts').AppEnv>();
app.onError(errorHandler);
auth.registerAuth(app);
servers.registerServers(app);
// A public route registered by a later module must stay reachable (no global requireUser).
app.get('/api/v1/public/probe', (c) => c.text('public ok'));

// ── fake SSH transport ──
type Call = { target: import('../../lib/ssh.ts').ResolvedTarget; command: string; stdin?: string };
const calls: Call[] = [];
let handler: (c: Call, opts: import('../../lib/ssh.ts').ExecOptions) => Promise<import('../../lib/ssh.ts').ExecResult>;
ssh.setSshImpl({
  async exec(target, command, opts) {
    const c: Call = { target, command, stdin: opts.stdin?.toString() };
    calls.push(c);
    return handler(c, opts);
  },
});
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

const PROBE_OK = ['user=root', 'uid=0', 'sudo=root', 'kernel=Linux', 'arch=x86_64', 'os=ubuntu 24.04', 'os_pretty=Ubuntu 24.04 LTS',
  'docker=27.3.1', 'disk=81920000 40960000', 'cores=4', 'mem=8000000'].join('\n');

async function call(path: string, o: { method?: string; body?: unknown; cookie?: string; token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  const res = await app.request(path, { method: o.method ?? 'GET', headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return res;
}
async function json(path: string, o: Parameters<typeof call>[1] = {}) {
  const r = await call(path, o);
  return { status: r.status, json: await r.json() as any };
}

const setup = await call('/api/v1/auth/setup', { method: 'POST', body: { email: 'o@example.com', name: 'O', password: 'password123' } });
const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0]!;

async function waitFor(fn: () => boolean, ms = 3000) {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('ssh-key generates an ed25519 keypair once', async () => {
  const r = await json('/api/v1/ssh-key', { cookie });
  assert.equal(r.status, 200);
  assert.match(r.json.publicKey, /^ssh-ed25519 AAAA\S+ docksy$/);
  assert.match(r.json.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(r.json.instructions, `mkdir -p ~/.ssh && echo '${r.json.publicKey}' >> ~/.ssh/authorized_keys`);
  assert.ok(existsSync(join(root, 'data', 'keys', 'id_ed25519')));
  assert.ok(existsSync(join(root, 'data', 'keys', 'id_ed25519.pub')));
  const again = await json('/api/v1/ssh-key', { cookie });
  assert.equal(again.json.publicKey, r.json.publicKey);
  assert.equal((await call('/api/v1/ssh-key')).status, 401);
});

let serverId = '';

test('servers CRUD', async () => {
  const events: string[] = [];
  bus.on('server.created', (e) => events.push(`created:${e.serverId}`));
  bus.on('server.deleted', (e) => events.push(`deleted:${e.serverId}`));

  assert.equal((await json('/api/v1/servers', { method: 'POST', cookie, body: { name: 'x', host: 'bad host!' } })).status, 400);
  assert.equal((await json('/api/v1/servers', { method: 'POST', cookie, body: { name: 'x', host: '1.2.3.4', port: 70000 } })).status, 400);

  const c = await json('/api/v1/servers', { method: 'POST', cookie, body: { name: 'prod-1', host: '203.0.113.10' } });
  assert.equal(c.status, 201);
  assert.equal(c.json.port, 22);
  assert.equal(c.json.sshUser, 'root');
  assert.equal(c.json.status, 'new');
  assert.equal(c.json.liveness, 'unknown');
  serverId = c.json.id;
  assert.deepEqual(events, [`created:${serverId}`]);

  assert.equal((await json('/api/v1/servers', { method: 'POST', cookie, body: { name: 'prod-1', host: '203.0.113.11' } })).status, 409);

  const list = await json('/api/v1/servers', { cookie });
  assert.equal(list.json.items.length, 1);
  assert.equal((await json(`/api/v1/servers/${serverId}`, { cookie })).json.name, 'prod-1');
  assert.equal((await json('/api/v1/servers/prod-1', { cookie })).json.id, serverId);
  assert.equal((await json('/api/v1/servers/nope', { cookie })).status, 404);

  const p = await json(`/api/v1/servers/${serverId}`, { method: 'PATCH', cookie, body: { port: 2222, sshUser: 'deploy' } });
  assert.equal(p.json.port, 2222);
  assert.equal(p.json.sshUser, 'deploy');
  await json(`/api/v1/servers/${serverId}`, { method: 'PATCH', cookie, body: { port: 22, sshUser: 'root' } });

  // delete: refused while apps exist
  const tmp = await json('/api/v1/servers', { method: 'POST', cookie, body: { name: 'tmp', host: 'tmp.example.com' } });
  db.prepare("INSERT INTO apps (id, name, server_id, webhook_secret, created_at, updated_at) VALUES ('a1', 'web', ?, 'whs_x', 0, 0)").run(tmp.json.id);
  const refused = await json(`/api/v1/servers/${tmp.json.id}`, { method: 'DELETE', cookie });
  assert.equal(refused.status, 409);
  db.prepare("DELETE FROM apps WHERE id = 'a1'").run();
  assert.deepEqual((await json(`/api/v1/servers/${tmp.json.id}`, { method: 'DELETE', cookie })).json, { ok: true });
  assert.ok(events.includes(`deleted:${tmp.json.id}`));
  assert.equal((await json(`/api/v1/servers/${tmp.json.id}`, { cookie })).status, 404);

  const acts = (db.prepare('SELECT action FROM activity').all() as { action: string }[]).map((a) => a.action);
  for (const a of ['server.create', 'server.update', 'server.delete']) assert.ok(acts.includes(a), a);
});

test('validate reports checks from the probe and prefills facts', async () => {
  handler = async () => ok(PROBE_OK);
  const r = await json(`/api/v1/servers/${serverId}/validate`, { method: 'POST', cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.checks.map((c: { name: string }) => c.name), ['ssh', 'root', 'os', 'docker', 'disk']);
  assert.match(r.json.checks[2].detail, /Ubuntu 24\.04 LTS \(amd64\)/);
  assert.match(r.json.checks[3].detail, /Docker 27\.3\.1/);
  const s = (await json(`/api/v1/servers/${serverId}`, { cookie })).json;
  assert.equal(s.arch, 'amd64');
  assert.equal(s.cpuCores, 4);
  assert.equal(s.memTotal, 8000000 * 1024);
  assert.equal(calls.at(-1)!.target.host, '203.0.113.10');

  handler = async () => ok(PROBE_OK.replace('sudo=root', 'sudo=no').replace('docker=27.3.1', 'docker=').replace('disk=81920000 40960000', 'disk=81920000 1000'));
  const bad = await json(`/api/v1/servers/${serverId}/validate`, { method: 'POST', cookie });
  assert.equal(bad.json.ok, false);
  const byName = Object.fromEntries(bad.json.checks.map((c: { name: string; ok: boolean }) => [c.name, c.ok]));
  assert.deepEqual(byName, { ssh: true, root: false, os: true, docker: true, disk: false });

  handler = async () => { throw new Error('SSH login to root@203.0.113.10:22 was rejected.'); };
  const down = await json(`/api/v1/servers/${serverId}/validate`, { method: 'POST', cookie });
  assert.equal(down.status, 200);
  assert.equal(down.json.ok, false);
  assert.equal(down.json.checks[0].name, 'ssh');
  assert.match(down.json.checks[0].detail, /rejected/);
});

test('probe helpers', () => {
  assert.deepEqual(servers.parseProbe('a=1\nb=x=y\njunk\n'), { a: '1', b: 'x=y' });
  assert.equal(servers.parseStep('::step:: Installing Docker'), 'Installing Docker');
  assert.equal(servers.parseStep('plain line'), null);
  assert.equal(servers.scriptCommand('root', { A: "it's" }), `env A='it'\\''s' bash -s`);
  assert.equal(servers.scriptCommand('ubuntu', { A: '1' }), `sudo -n env A='1' bash -s`);
});

test('provision fails gracefully when scripts are missing', async () => {
  handler = async () => ok('docksy-ok');
  const r = await json(`/api/v1/servers/${serverId}/provision`, { method: 'POST', cookie });
  assert.equal(r.status, 202);
  assert.equal(r.json.status, 'running');
  await waitFor(() => (db.prepare('SELECT status FROM servers WHERE id = ?').get(serverId) as { status: string }).status === 'error');
  const job = (await json(`/api/v1/servers/${serverId}/provision`, { cookie })).json;
  assert.equal(job.status, 'failed');
  assert.match(job.log, /provision\.sh not found/);
});

test('provision runs both scripts with env, parses steps, streams SSE and becomes ready', async () => {
  writeFileSync(join(scriptsDir, 'provision.sh'), '#!/bin/bash\necho provision\n');
  writeFileSync(join(scriptsDir, 'install-agent.sh'), '#!/bin/bash\necho install-agent\n');
  setSettings({ publicUrl: 'https://docksy.example.com' });

  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  handler = async (c, opts) => {
    if (c.command.includes('echo docksy-ok')) return ok('docksy-ok\n');
    if (c.stdin?.includes('echo provision')) {
      opts.onData?.('::step:: Installing Docker\nDocker ', 'stdout');
      opts.onData?.('installed\n', 'stdout');
      await gate;
      opts.onData?.('::step:: Starting proxy\n', 'stdout');
      return ok();
    }
    if (c.stdin?.includes('echo install-agent')) {
      opts.onData?.('::step:: Agent running\n', 'stdout');
      return ok();
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };

  const start = await json(`/api/v1/servers/${serverId}/provision`, { method: 'POST', cookie });
  assert.equal(start.status, 202);
  await waitFor(() => calls.some((c) => c.stdin?.includes('echo provision')));
  assert.equal((await json(`/api/v1/servers/${serverId}`, { cookie })).json.status, 'provisioning');
  // second POST while running returns the same job
  const dup = await json(`/api/v1/servers/${serverId}/provision`, { method: 'POST', cookie });
  assert.equal(dup.status, 200);
  assert.equal(dup.json.status, 'running');

  const sse = await call(`/api/v1/servers/${serverId}/provision/stream`, { cookie });
  assert.equal(sse.status, 200);
  const textP = sse.text();
  setTimeout(release, 30);
  const text = await textP;

  assert.match(text, /event: log\ndata: {"line":"::step:: Installing Docker"}/);
  assert.match(text, /event: step\ndata: {"step":"Installing Docker"}/);
  assert.match(text, /data: {"line":"Docker installed"}/);
  assert.match(text, /data: {"line":"::step:: Starting proxy"}/);
  assert.match(text, /event: status\ndata: {"status":"succeeded"}/);

  const prov = calls.find((c) => c.stdin?.includes('echo provision'))!;
  assert.match(prov.command, /^env DOCKSY_URL='https:\/\/docksy\.example\.com' DOCKSY_AGENT_INTERVAL='10' bash -s$/);
  const inst = calls.find((c) => c.stdin?.includes('echo install-agent'))!;
  const tok = /DOCKSY_AGENT_TOKEN='(dsa_[^']+)'/.exec(inst.command)?.[1];
  assert.ok(tok);
  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as Record<string, string>;
  assert.equal(row.agent_token_hash, sha256(tok!));
  assert.equal(row.status, 'ready');
  assert.match(row.provision_log, /::step:: Agent running/);
  assert.match(row.provision_log, /::step:: Server is ready/);

  const job = (await json(`/api/v1/servers/${serverId}/provision`, { cookie })).json;
  assert.equal(job.status, 'succeeded');

  // stream after completion replays and closes
  const after = await (await call(`/api/v1/servers/${serverId}/provision/stream`, { cookie })).text();
  assert.match(after, /"status":"succeeded"/);
});

test('provision marks error when a script exits non-zero', async () => {
  handler = async (c) => (c.command.includes('echo docksy-ok') ? ok('docksy-ok') : { code: 3, stdout: '', stderr: 'boom' });
  await json(`/api/v1/servers/${serverId}/provision`, { method: 'POST', cookie });
  await waitFor(() => (db.prepare('SELECT status FROM servers WHERE id = ?').get(serverId) as { status: string }).status === 'error');
  const job = (await json(`/api/v1/servers/${serverId}/provision`, { cookie })).json;
  assert.equal(job.status, 'failed');
  assert.match(job.log, /provision\.sh exited with code 3/);
});

test('startServers marks servers stuck in provisioning as error', async () => {
  db.prepare("INSERT INTO servers (id, name, host, status, provision_log, created_at, updated_at) VALUES ('stuck', 'stuck', 'h', 'provisioning', 'half done', 0, 0)").run();
  servers.startServers();
  const r = db.prepare("SELECT status, provision_log FROM servers WHERE id = 'stuck'").get() as Record<string, string>;
  assert.equal(r.status, 'error');
  assert.match(r.provision_log, /^half done\n.*interrupted/);
});

test('public agent binary and install.sh', async () => {
  assert.equal((await call('/api/agent/v1/binary/linux-amd64')).status, 404);
  assert.equal((await call('/api/agent/v1/binary/windows-amd64')).status, 404);
  writeFileSync(join(binDir, 'docksy-agent-linux-amd64'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]));
  const bin = await call('/api/agent/v1/binary/linux-amd64');
  assert.equal(bin.status, 200);
  assert.equal(bin.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual([...new Uint8Array(await bin.arrayBuffer())], [0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]);

  const sh = await call('/api/agent/v1/install.sh');
  assert.equal(sh.status, 200);
  assert.match(await sh.text(), /install-agent/);
});

test('putFile falls back to exec with stdin', async () => {
  handler = async () => ok();
  await ssh.putFile(serverId, '/etc/docksy/agent.env', 'A=1\n', 0o600);
  const c = calls.at(-1)!;
  assert.match(c.command, /^mkdir -p '\/etc\/docksy' && cat > '\/etc\/docksy\/agent\.env\.docksy-tmp-[^']+' && chmod 600 /);
  assert.equal(c.stdin, 'A=1\n');
  handler = async () => ({ code: 1, stdout: '', stderr: 'denied' });
  await assert.rejects(ssh.putFile(serverId, '/root/x', 'y'), /denied/);
});

test('auth/servers modules do not block public routes registered after them', async () => {
  const r = await call('/api/v1/public/probe');
  assert.equal(r.status, 200);
  for (const p of ['/api/v1/auth/state', '/api/agent/v1/install.sh']) assert.equal((await call(p)).status, 200, p);
});
