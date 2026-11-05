import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DOCKSY_DB_PATH = ':memory:';
process.env.DOCKSY_DISABLE_JOBS = '1';
const { globMatch } = await import('./index.ts');
const { runCommand } = await import('../deploy/commands.ts');

test('globMatch: segments, double-star, folders', () => {
  assert.ok(globMatch('src/**', 'src/a/b.ts'));
  assert.ok(globMatch('services/api/**', 'services/api/index.js'));
  assert.ok(!globMatch('services/api/**', 'services/web/index.js'));
  assert.ok(globMatch('*.md', 'README.md'));
  assert.ok(!globMatch('*.md', 'docs/README.md'));
  assert.ok(globMatch('**/*.md', 'docs/README.md'));
  assert.ok(globMatch('backend/', 'backend/app.py'));
  assert.ok(globMatch('./package.json', 'package.json'));
  assert.ok(globMatch('file?.txt', 'file1.txt'));
});

test('runCommand: limits and start command', () => {
  const base = { name: 'dx-a-12345678', image: 'docksy/a:1', appId: 'id', appName: 'a', deploymentId: '12345678x', envFile: null, volumes: [], domains: [], port: null };
  const cmd = runCommand({ ...base, cpuLimit: 0.5, memLimitMb: 512, startCommand: "node server.js --port 3000" });
  assert.match(cmd, /--cpus '0\.5'/);
  assert.match(cmd, /--memory '512m'/);
  assert.match(cmd, /'docksy\/a:1' sh -c 'node server\.js --port 3000'$/);
  const tpl = runCommand({ ...base, command: ['redis-server'], startCommand: 'ignored' });
  assert.match(tpl, /'redis-server'$/);
  assert.doesNotMatch(runCommand(base), /--cpus|--memory|sh -c/);
});
