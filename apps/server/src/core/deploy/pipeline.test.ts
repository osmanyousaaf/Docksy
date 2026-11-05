import './testenv.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, type Row } from '../../db/index.ts';
import { bus } from '../../lib/events.ts';
import { FakeRemote, insertApp, insertServer, setupDb } from './fixtures.ts';
import { getDeployment, listLogLines } from './model.ts';
import { runDeployment } from './pipeline.ts';
import { enqueue, enqueueDeployment } from './queue.ts';
import { setRemote, timing } from './remote.ts';

const TOKEN = 'ghp_SuperSecretToken42';
const SHA = '0123456789abcdef0123456789abcdef01234567';
let serverId = '';

before(() => {
  setupDb();
  serverId = insertServer('203.0.113.7');
  Object.assign(timing, { healthTimeoutMs: 200, pollMs: 1, stableMs: 0 });
});
after(() => setRemote(null));

const appRow = (id: string) => db.prepare('SELECT * FROM apps WHERE id = ?').get(id) as Row;
const logText = (id: string) => listLogLines(id).map((l) => l.line).join('\n');
const run = async (id: string) => runDeployment(id, new AbortController().signal);

function nodeRepoFake(name: string, opts: { oldContainer?: string } = {}) {
  const old = opts.oldContainer ?? `dx-${name}-0ld00000`;
  return new FakeRemote()
    .on('git clone', { stdout: "Cloning into '/var/lib/docksy/builds'...\n" })
    .on('log -1', { stdout: `${SHA}\nAdd health endpoint\n` })
    .on('::docksy-ls::', {
      stdout: ['::docksy-ls::', 'package.json', 'package-lock.json', 'src/', '::docksy-file:: package.json',
        JSON.stringify({ scripts: { start: 'node src/index.js' } }), '::docksy-end::', ''].join('\n'),
    })
    .on('docker build', { stdout: '#1 [internal] load build definition\n#9 DONE 0.1s\n' })
    .on('docker inspect', { stdout: 'running|0|0|false\n' })
    .on('docker exec', { code: 0 })
    .on('docker ps -a --filter', { stdout: `${old}\n` })
    .on(/docker ps -q/, { stdout: 'abc123\n' });
}

test('success: git + auto (node) builds, runs with env file, waits healthy, swaps, prunes', async () => {
  const app = insertApp({
    name: 'pipe-ok', serverId, repoUrl: 'https://github.com/acme/web.git', gitToken: TOKEN, healthcheckPath: '/health',
    env: { DATABASE_URL: 'postgres://u:hunter2@db/app', API_KEY: 'sk-live-xyz' },
  });
  const fake = nodeRepoFake('pipe-ok');
  // the swap must list the new container too, and keep it
  fake.rules.unshift(['docker ps -a --filter', () => ({ stdout: `dx-pipe-ok-0ld00000\n${newName}\n` })]);
  setRemote(fake);
  const events: string[] = [];
  const offs = [
    bus.on('deployment.status', (p) => events.push(`status:${p.status}`)),
    bus.on('deployment.finished', (p) => events.push(`finished:${p.status}`)),
  ];
  const d = enqueueDeployment(app, 'manual', { ref: 'release' });
  const newName = `dx-pipe-ok-${d.id.slice(0, 8)}`;
  await run(d.id);
  offs.forEach((f) => f());

  const after = getDeployment(d.id);
  assert.equal(after.status, 'succeeded', logText(d.id));
  assert.equal(after.commitSha, SHA);
  assert.equal(after.commitMessage, 'Add health endpoint');
  assert.equal(after.imageTag, `docksy/pipe-ok:${d.id.slice(0, 8)}`);
  assert.ok(after.startedAt && after.finishedAt);
  assert.deepEqual(events, ['status:queued', 'status:building', 'status:deploying', 'status:succeeded', 'finished:succeeded']);

  const a = appRow(app);
  assert.equal(a.status, 'running');
  assert.equal(a.current_deployment_id, d.id);
  assert.equal(a.port, 3000, 'detected port is saved when none was set');

  // clone used the ref override and the token, but the token never reached the log
  assert.equal(fake.ran("-b 'release'").length, 1);
  assert.ok(fake.ran(`x-access-token:${TOKEN}@`).length === 1);
  assert.ok(!logText(d.id).includes(TOKEN));

  // generated Dockerfile + .dockerignore uploaded into the build context
  const df = fake.files.find((f) => f.path.endsWith('/Dockerfile.docksy'))!;
  assert.match(df.content, /CMD \["sh","-c","npm start"\]/);
  assert.ok(fake.files.some((f) => f.path.endsWith('/.dockerignore')));
  assert.equal(fake.ran("-f 'Dockerfile.docksy'").length, 1);

  // env goes through a 0600 env file outside the build dir, never on the command line, and is deleted
  const envFile = fake.files.find((f) => f.path.includes('/.env.'))!;
  assert.equal(envFile.path, `/var/lib/docksy/builds/pipe-ok/.env.${d.id}`);
  assert.equal(envFile.mode, 0o600);
  assert.equal(envFile.content, 'API_KEY=sk-live-xyz\nDATABASE_URL=postgres://u:hunter2@db/app\nPORT=3000\n');
  assert.ok(!fake.commands.some((c) => c.includes('hunter2') || c.includes('sk-live-xyz')));
  const runIdx = fake.commands.findIndex((c) => c.startsWith('docker run -d'));
  const rmEnvIdx = fake.commands.findIndex((c) => c === `rm -f '${envFile.path}'`);
  assert.ok(runIdx > 0 && rmEnvIdx > runIdx, 'env file removed after docker run');

  // docker run carries labels and the sslip.io default domain
  const runCmd = fake.commands[runIdx]!;
  assert.ok(runCmd.includes(`--name '${newName}'`));
  assert.ok(runCmd.includes("--label 'caddy=pipe-ok.203.0.113.7.sslip.io'"));
  assert.ok(runCmd.includes("--label 'caddy.reverse_proxy={{upstreams 3000}}'"));

  // health probe hit the healthcheck path, then only the OLD container was removed
  assert.ok(fake.ran('http://127.0.0.1:3000/health').length >= 1);
  const swap = fake.ran('docker stop -t 10');
  assert.equal(swap.length, 1);
  assert.ok(swap[0]!.includes("'dx-pipe-ok-0ld00000'") && !swap[0]!.includes(newName));
  const healthIdx = fake.commands.findIndex((c) => c.includes('docker exec'));
  assert.ok(fake.commands.indexOf(swap[0]!) > healthIdx, 'old container removed only after the new one is healthy');
  assert.equal(fake.ran('xargs -r docker rmi').length, 1);
  assert.equal(fake.ran('xargs -r rm -rf').length, 1);
});

test('build failure: no container started, old one untouched, deployment failed', async () => {
  const app = insertApp({ name: 'pipe-buildfail', serverId, repoUrl: 'https://github.com/acme/web.git', currentDeploymentId: 'prev' });
  const fake = nodeRepoFake('pipe-buildfail');
  fake.rules.unshift(['docker build', { code: 1, stderr: 'npm ERR! missing script: build\n' }]);
  setRemote(fake);
  const d = enqueueDeployment(app, 'manual');
  await run(d.id);
  const after = getDeployment(d.id);
  assert.equal(after.status, 'failed');
  assert.match(after.error!, /Image build failed \(exit code 1\)/);
  assert.match(logText(d.id), /npm ERR! missing script/);
  assert.equal(fake.ran('docker run -d').length, 0);
  assert.equal(fake.ran('docker stop').length, 0);
  assert.equal(appRow(app).status, 'running', 'previous version still serving');
  assert.equal(appRow(app).current_deployment_id, 'prev');
});

test('health failure: new container removed, old container kept', async () => {
  const app = insertApp({ name: 'pipe-unhealthy', serverId, sourceType: 'image', image: 'nginx:1.27', buildType: 'image', port: 80, currentDeploymentId: 'prev' });
  const fake = new FakeRemote()
    .on('docker inspect', { stdout: 'exited|0|1|false\n' })
    .on('docker logs --tail', { stdout: 'Error: listen EADDRINUSE\n' })
    .on(/docker ps -q/, { stdout: 'oldid\n' })
    .on('docker ps -a --filter', { stdout: 'dx-pipe-unhealthy-0ld00000\n' });
  setRemote(fake);
  const d = enqueueDeployment(app, 'manual');
  const newName = `dx-pipe-unhealthy-${d.id.slice(0, 8)}`;
  await run(d.id);
  const after = getDeployment(d.id);
  assert.equal(after.status, 'failed');
  assert.match(after.error!, /exited with code 1/);
  assert.match(logText(d.id), /EADDRINUSE/);
  assert.equal(fake.ran("docker pull 'nginx:1.27'").length, 1);
  assert.equal(fake.ran(`docker tag 'nginx:1.27' 'docksy/pipe-unhealthy:${d.id.slice(0, 8)}'`).length, 1);
  // the new container is force-removed (once before run as stale cleanup, once after failure)...
  assert.ok(fake.ran(`docker rm -f '${newName}'`).length >= 2);
  // ...and the old one is never stopped
  assert.equal(fake.ran('dx-pipe-unhealthy-0ld00000').length, 0);
  assert.equal(fake.ran('docker stop').length, 0);
  assert.equal(appRow(app).status, 'running');
  assert.ok(fake.ran('rm -f \'/var/lib/docksy/builds/pipe-unhealthy/.env.').length >= 1, 'env file cleaned up on failure');
});

test('health timeout: HTTP probe never answers', async () => {
  const app = insertApp({ name: 'pipe-timeout', serverId, sourceType: 'image', image: 'app:1', buildType: 'image', port: 8080, healthcheckPath: '/ready' });
  const fake = new FakeRemote()
    .on('docker inspect', { stdout: 'running|0|0|false\n' })
    .on('docker exec', { code: 1, stderr: 'wget: server returned error: HTTP/1.1 503\n' });
  setRemote(fake);
  const d = enqueueDeployment(app, 'manual');
  await run(d.id);
  const after = getDeployment(d.id);
  assert.equal(after.status, 'failed');
  assert.match(after.error!, /Health check timed out.*503/);
  assert.equal(appRow(app).status, 'failed', 'no previous version running');
});

test('rollback reuses the previous image tag without cloning or building', async () => {
  const app = insertApp({ name: 'pipe-rollback', serverId, repoUrl: 'https://github.com/acme/web.git', port: 3000, template: 'redis' });
  const fake = new FakeRemote()
    .on('docker inspect', { stdout: 'running|0|0|false\n' })
    .on('docker ps -a --filter', { stdout: 'dx-pipe-rollback-cur00000\n' });
  setRemote(fake);
  const d = enqueue(app, 'rollback', { commitSha: SHA }, { imageTag: 'docksy/pipe-rollback:0ld11111' });
  await run(d.id);
  const after = getDeployment(d.id);
  assert.equal(after.status, 'succeeded', logText(d.id));
  assert.equal(after.imageTag, 'docksy/pipe-rollback:0ld11111');
  assert.equal(fake.ran('git clone').length, 0);
  assert.equal(fake.ran('docker build').length, 0);
  assert.equal(fake.ran("docker image inspect 'docksy/pipe-rollback:0ld11111'").length, 1);
  const runCmd = fake.ran('docker run -d')[0]!;
  assert.ok(runCmd.includes("'docksy/pipe-rollback:0ld11111' 'sh' '-c'"), 'image + template command');
  assert.ok(runCmd.includes("--network-alias 'pipe-rollback'"));
  assert.equal(fake.ran("grep -vxF 'docksy/pipe-rollback:0ld11111'").length, 1, 'prune protects the live tag');
});

test('rollback fails cleanly when the image was pruned', async () => {
  const app = insertApp({ name: 'pipe-rb-gone', serverId, sourceType: 'image', image: 'x:1', buildType: 'image' });
  setRemote(new FakeRemote().on('docker image inspect', { code: 1 }));
  const d = enqueue(app, 'rollback', {}, { imageTag: 'docksy/pipe-rb-gone:deadbeef' });
  await run(d.id);
  const after = getDeployment(d.id);
  assert.equal(after.status, 'failed');
  assert.match(after.error!, /no longer on the server/);
});

test('cancel mid-run ends as cancelled and removes the new container', async () => {
  const app = insertApp({ name: 'pipe-cancel', serverId, sourceType: 'image', image: 'x:1', buildType: 'image' });
  const ac = new AbortController();
  const fake = new FakeRemote().on('docker inspect', () => { ac.abort(); return { stdout: 'created|0|0|false\n' }; });
  setRemote(fake);
  const d = enqueueDeployment(app, 'manual');
  await runDeployment(d.id, ac.signal);
  const after = getDeployment(d.id);
  assert.equal(after.status, 'cancelled');
  assert.ok(fake.ran(`docker rm -f 'dx-pipe-cancel-${d.id.slice(0, 8)}'`).length >= 2);
  assert.equal(appRow(app).status, 'idle');
});

test('auto build with nothing to detect fails with a helpful message', async () => {
  const app = insertApp({ name: 'pipe-unknown', serverId, repoUrl: 'https://github.com/acme/docs.git' });
  setRemote(new FakeRemote().on('::docksy-ls::', { stdout: '::docksy-ls::\nREADME.md\n::docksy-end::\n' }));
  const d = enqueueDeployment(app, 'manual');
  await run(d.id);
  const after = getDeployment(d.id);
  assert.equal(after.status, 'failed');
  assert.match(after.error!, /Couldn't work out how to build this repo/);
});
