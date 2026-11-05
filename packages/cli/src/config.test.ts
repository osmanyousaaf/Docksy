import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, configPath, loadConfig, resolveConnection, saveConfig } from './config.ts';

const dir = mkdtempSync(join(tmpdir(), 'docksy-cli-config-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('default path is ~/.config/docksy/config.json; DOCKSY_CONFIG overrides', () => {
  assert.equal(configPath({}), join(homedir(), '.config', 'docksy', 'config.json'));
  assert.equal(configPath({ DOCKSY_CONFIG: '/x/y.json' }), '/x/y.json');
});

test('missing or empty file loads as empty config', () => {
  assert.deepEqual(loadConfig(join(dir, 'nope.json')), {});
  const p = join(dir, 'empty.json');
  writeFileSync(p, '  ');
  assert.deepEqual(loadConfig(p), {});
});

test('save creates dirs, writes 0600 and round-trips', () => {
  const p = join(dir, 'nested', 'docksy', 'config.json');
  saveConfig(p, { url: 'https://d.io', token: 'dsk_abc', user: 'me@x.io' });
  assert.deepEqual(loadConfig(p), { url: 'https://d.io', token: 'dsk_abc', user: 'me@x.io' });
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'nested', 'docksy')).mode & 0o777, 0o700);
  // Overwrite keeps 0600 and drops empty fields.
  saveConfig(p, { url: 'https://d.io' });
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { url: 'https://d.io' });
  assert.equal(statSync(p).mode & 0o777, 0o600);
});

test('invalid JSON or wrong shape gives a friendly ConfigError; unknown fields are ignored', () => {
  const p = join(dir, 'bad.json');
  writeFileSync(p, '{nope');
  assert.throws(() => loadConfig(p), ConfigError);
  writeFileSync(p, '[1,2]');
  assert.throws(() => loadConfig(p), /JSON object/);
  writeFileSync(p, JSON.stringify({ url: 'u', token: 5, extra: true }));
  assert.deepEqual(loadConfig(p), { url: 'u' });
});

test('env vars override the config file', () => {
  const cfg = { url: 'https://cfg', token: 'dsk_cfg' };
  assert.deepEqual(resolveConnection(cfg, {}), { url: 'https://cfg', token: 'dsk_cfg', urlSource: 'config', tokenSource: 'config' });
  assert.deepEqual(resolveConnection(cfg, { DOCKSY_URL: 'https://env', DOCKSY_TOKEN: ' dsk_env ' }), { url: 'https://env', token: 'dsk_env', urlSource: 'env', tokenSource: 'env' });
  assert.deepEqual(resolveConnection({}, { DOCKSY_URL: '' }), { url: undefined, token: undefined, urlSource: 'none', tokenSource: 'none' });
});

test('saveConfig into an existing dir leaves its mode alone', () => {
  const d = join(dir, 'existing');
  mkdirSync(d, { mode: 0o755 });
  saveConfig(join(d, 'c.json'), { url: 'x' });
  assert.equal(statSync(join(d, 'c.json')).mode & 0o777, 0o600);
});
