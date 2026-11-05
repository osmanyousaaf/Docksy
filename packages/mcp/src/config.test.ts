import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from './config.ts';
import { parseArgs } from './index.ts';
import { isAllowedOrigin, isLocalHost } from './http.ts';

test('loadConfig reads env and readonly flag', () => {
  assert.deepEqual(loadConfig({ DOCKSY_URL: 'https://d.example.com', DOCKSY_TOKEN: 'dsk_1' }), { url: 'https://d.example.com', token: 'dsk_1', readonly: false });
  assert.equal(loadConfig({ DOCKSY_URL: 'http://x', DOCKSY_TOKEN: 't', DOCKSY_READONLY: '1' }).readonly, true);
  assert.equal(loadConfig({ DOCKSY_URL: 'http://x', DOCKSY_TOKEN: 't', DOCKSY_READONLY: 'true' }).readonly, false);
  assert.equal(loadConfig({ DOCKSY_URL: 'http://x', DOCKSY_TOKEN: 't', DOCKSY_READONLY: '' }).readonly, false);
  assert.equal(loadConfig({ DOCKSY_URL: 'http://x', DOCKSY_TOKEN: 't', DOCKSY_READONLY: '0' }).readonly, false);
});

test('loadConfig explains missing or bad config', () => {
  assert.throws(() => loadConfig({}), (e: unknown) => e instanceof ConfigError && /DOCKSY_URL is not set/.test(e.message) && /DOCKSY_TOKEN is not set/.test(e.message));
  assert.throws(() => loadConfig({ DOCKSY_URL: 'ftp://x', DOCKSY_TOKEN: 't' }), /not a valid http\(s\) URL/);
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs([]), { http: false, port: 3939, help: false, version: false });
  assert.deepEqual(parseArgs(['--http', '--port', '8112']), { http: true, port: 8112, help: false, version: false });
  assert.equal(parseArgs(['--http', '--port=4000']).port, 4000);
  assert.throws(() => parseArgs(['--port', 'abc']), ConfigError);
  assert.throws(() => parseArgs(['--bogus']), /Unknown option/);
});

test('HTTP host/origin guards', () => {
  assert.ok(isLocalHost('127.0.0.1:3939'));
  assert.ok(isLocalHost('localhost:3939'));
  assert.ok(isLocalHost('[::1]:3939'));
  assert.ok(!isLocalHost('evil.com'));
  assert.ok(!isLocalHost('127.0.0.1.evil.com:80'));
  assert.ok(!isLocalHost(undefined));
  assert.ok(isAllowedOrigin(undefined));
  assert.ok(isAllowedOrigin('http://localhost:5173'));
  assert.ok(!isAllowedOrigin('https://evil.com'));
});
