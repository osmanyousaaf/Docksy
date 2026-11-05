import './testenv.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cmd from './commands.ts';

const APP = '11111111-2222-3333-4444-555555555555';
const DEP = 'abcdef12-0000-0000-0000-000000000000';

test('paths and names', () => {
  assert.equal(cmd.buildDir('web', DEP), `/var/lib/docksy/builds/web/${DEP}`);
  assert.equal(cmd.envFilePath('web', DEP), `/var/lib/docksy/builds/web/.env.${DEP}`);
  assert.equal(cmd.imageTag('web', DEP), 'docksy/web:abcdef12');
  assert.equal(cmd.joinPath('/b/x', '.'), '/b/x');
  assert.equal(cmd.joinPath('/b/x', './apps/api/'), '/b/x/apps/api');
});

test('docker run: exact command with labels, network, env file, volumes and caddy', () => {
  const c = cmd.runCommand({
    name: 'dx-web-abcdef12', image: 'docksy/web:abcdef12', appId: APP, appName: 'web', deploymentId: DEP,
    envFile: `/var/lib/docksy/builds/web/.env.${DEP}`, volumes: [{ name: 'data', mountPath: '/data' }],
    domains: ['web.example.com', 'www.example.com'], port: 3000,
  });
  assert.equal(c, [
    'docker run -d',
    "--name 'dx-web-abcdef12'",
    '--network docksy',
    "--network-alias 'web'",
    '--restart unless-stopped',
    "--label 'docksy.managed=true'",
    `--label 'docksy.app=${APP}'`,
    `--label 'docksy.deployment=${DEP}'`,
    "--label 'caddy=web.example.com, www.example.com'",
    "--label 'caddy.reverse_proxy={{upstreams 3000}}'",
    `--env-file '/var/lib/docksy/builds/web/.env.${DEP}'`,
    "-v 'docksy-web-data:/data'",
    "'docksy/web:abcdef12'",
  ].join(' '));
});

test('docker run: no caddy labels without port or domains; template command appended quoted', () => {
  const base = { name: 'dx-cache-abcdef12', image: 'redis:7', appId: APP, appName: 'cache', deploymentId: DEP, envFile: null, volumes: [] };
  const noPort = cmd.runCommand({ ...base, domains: ['x.example.com'], port: null });
  assert.ok(!noPort.includes('caddy'));
  const noDomain = cmd.runCommand({ ...base, domains: [], port: 6379 });
  assert.ok(!noDomain.includes('caddy'));
  assert.ok(!noDomain.includes('--env-file'));
  const withCmd = cmd.runCommand({ ...base, domains: [], port: null, command: ['sh', '-c', 'exec redis-server --requirepass "$REDIS_PASSWORD"'] });
  assert.ok(withCmd.endsWith(`'redis:7' 'sh' '-c' 'exec redis-server --requirepass "$REDIS_PASSWORD"'`));
});

test('env values never appear on the command line; env file is rendered literally', () => {
  const env = { SECRET: "p@ss w'rd $HOME", A: '1', 'bad key': 'x', MULTI: 'a\nb', URL: 'postgres://u:p@h/db?x=1' };
  const { content, skipped } = cmd.renderEnvFile(env);
  assert.equal(content, "A=1\nSECRET=p@ss w'rd $HOME\nURL=postgres://u:p@h/db?x=1\n");
  assert.deepEqual(skipped.sort(), ['MULTI', 'bad key']);
  assert.deepEqual(cmd.renderEnvFile({}), { content: '', skipped: [] });
  const run = cmd.runCommand({ name: 'n', image: 'i', appId: APP, appName: 'web', deploymentId: DEP, envFile: '/f', volumes: [], domains: [], port: null });
  assert.ok(!run.includes('SECRET') && !run.includes(' -e '));
});

test('shell quoting with q() neutralises injection', () => {
  const evil = "x'; rm -rf / #";
  const c = cmd.runCommand({ name: 'n', image: evil, appId: APP, appName: 'web', deploymentId: DEP, envFile: null, volumes: [], domains: [], port: null });
  assert.ok(c.endsWith(`'x'\\''; rm -rf / #'`));
  assert.equal(cmd.pullCommand('nginx:1.27'), "docker pull 'nginx:1.27'");
  assert.equal(cmd.tagCommand('nginx:1.27', 'docksy/web:abcdef12'), "docker tag 'nginx:1.27' 'docksy/web:abcdef12'");
});

test('git clone: token injected for https, scrubbed from .git/config, redactable', () => {
  const c = cmd.cloneCommand({ repoUrl: 'https://github.com/acme/web.git', branch: 'main', dir: '/b/d', token: 'ghp_SECRET123' });
  assert.equal(c, [
    "rm -rf '/b/d'",
    "mkdir -p '/b/d'",
    "GIT_TERMINAL_PROMPT=0 git clone --depth 1 --single-branch -b 'main' -- 'https://x-access-token:ghp_SECRET123@github.com/acme/web.git' '/b/d'",
    "git -C '/b/d' remote set-url origin 'https://github.com/acme/web.git'",
  ].join(' && '));
  assert.ok(!cmd.redact(c, ['ghp_SECRET123']).includes('ghp_SECRET123'));
  const noTok = cmd.cloneCommand({ repoUrl: 'https://github.com/acme/web.git', branch: null, dir: '/b/d', token: null });
  assert.ok(!noTok.includes('remote set-url') && !noTok.includes(' -b '));
  assert.equal(cmd.authedRepoUrl('git@github.com:acme/web.git', 'tok'), 'git@github.com:acme/web.git');
  assert.equal(cmd.cleanRepoUrl('https://old:creds@github.com/a/b'), 'https://github.com/a/b');
  assert.equal(cmd.redact('see https://x-access-token:a%2Fb%3D@h', ['a/b=']), 'see https://x-access-token:***@h');
});

test('commit info parsing', () => {
  assert.deepEqual(cmd.parseCommitInfo('0123456789abcdef0123456789abcdef01234567\nFix: the thing\n'), {
    sha: '0123456789abcdef0123456789abcdef01234567', message: 'Fix: the thing',
  });
  assert.deepEqual(cmd.parseCommitInfo('fatal: not a git repository'), { sha: null, message: null });
});

test('docker build and compose commands', () => {
  assert.equal(
    cmd.dockerBuildCommand({ dir: '/b/d', dockerfile: 'Dockerfile', context: '.', tag: 'docksy/web:abcdef12', labels: { 'docksy.app': APP } }),
    `cd '/b/d' && docker build -t 'docksy/web:abcdef12' -f 'Dockerfile' --label 'docksy.app=${APP}' '.'`,
  );
  assert.equal(
    cmd.composeUpCommand({ dir: '/b/d', appName: 'web', composePath: 'docker-compose.yml', envFile: '/e' }),
    "cd '/b/d' && docker compose -p 'docksy-web' -f 'docker-compose.yml' --env-file '/e' up -d --build --remove-orphans",
  );
  assert.deepEqual(cmd.parseComposePs('web running\nworker exited\n'), [{ service: 'web', state: 'running' }, { service: 'worker', state: 'exited' }]);
});

test('probe output parsing', () => {
  const out = ['::docksy-ls::', 'package.json', 'src/', 'pnpm-lock.yaml', 'cmd/api/', '::docksy-file:: package.json', '{"scripts":{"start":"node x"}}', '', '::docksy-dockerfile::', '::docksy-end::'].join('\n');
  const p = cmd.parseProbe(out);
  assert.deepEqual(p.files, ['package.json', 'src/', 'pnpm-lock.yaml', 'cmd/api/']);
  assert.equal(p.contents['package.json'], '{"scripts":{"start":"node x"}}');
  assert.equal(p.hasDockerfile, true);
  assert.equal(cmd.parseProbe('::docksy-ls::\n::docksy-end::').hasDockerfile, false);
});

test('health: inspect + probe commands and state parsing', () => {
  assert.equal(cmd.inspectStateCommand('dx-web-abcdef12'), "docker inspect -f '{{.State.Status}}|{{.RestartCount}}|{{.State.ExitCode}}|{{.State.OOMKilled}}' 'dx-web-abcdef12'");
  assert.deepEqual(cmd.parseState('running|0|0|false\n'), { status: 'running', restarts: 0, exitCode: 0, oomKilled: false });
  assert.deepEqual(cmd.parseState('exited|2|137|true'), { status: 'exited', restarts: 2, exitCode: 137, oomKilled: true });
  assert.equal(cmd.parseState(''), null);
  const p = cmd.healthProbeCommand('dx-web-abcdef12', 3000, 'health');
  assert.ok(p.startsWith("docker exec 'dx-web-abcdef12' sh -c "));
  assert.ok(p.includes('http://127.0.0.1:3000/health'));
  assert.ok(p.includes(`exit ${cmd.PROBE_UNAVAILABLE}`));
});

test('swap, lifecycle, logs and prune commands', () => {
  assert.equal(cmd.listAppContainersCommand(APP), `docker ps -a --filter 'label=docksy.app=${APP}' --format '{{.Names}}'`);
  assert.equal(cmd.removeContainersCommand(['a', 'b']), "docker stop -t 10 'a' 'b' >/dev/null 2>&1; docker rm -f 'a' 'b'");
  assert.equal(cmd.removeContainerCommand('dx-web-1'), "docker rm -f 'dx-web-1' >/dev/null 2>&1 || true");
  const lc = cmd.lifecycleCommand('restart', APP, 'web');
  assert.ok(lc.includes(`label=docksy.app=${APP}`) && lc.includes('label=com.docker.compose.project=docksy-web') && lc.endsWith('docker restart $ids'));
  assert.ok(cmd.appLogsCommand(APP, 'web', 99999, true).includes('docker logs -f --tail 5000 "$c"'));
  assert.ok(cmd.appLogsCommand(APP, 'web', 50, false).includes('docker logs --tail 50 "$c"'));
  assert.equal(cmd.pruneBuildDirsCommand('web'), "cd '/var/lib/docksy/builds/web' 2>/dev/null && ls -1t | tail -n +6 | xargs -r rm -rf -- ; true");
  assert.equal(
    cmd.pruneImagesCommand('web', 'docksy/web:abcdef12'),
    "docker image ls 'docksy/web' --format '{{.Repository}}:{{.Tag}}' | tail -n +6 | grep -vxF 'docksy/web:abcdef12' | xargs -r docker rmi >/dev/null 2>&1; true",
  );
});
