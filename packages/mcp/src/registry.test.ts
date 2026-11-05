import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { DocksyApi } from './api.ts';
import { annotations, defineTool, fullDescription, inputShape, invokeTool, toResult, visibleTools, type ToolDef } from './registry.ts';
import { ALL_TOOLS } from './tools/index.ts';

const READ = [
  'list_servers', 'get_server', 'get_server_metrics', 'list_containers', 'get_fleet_overview',
  'list_apps', 'get_app', 'list_deployments', 'get_deployment_logs', 'get_app_logs',
  'diagnose', 'list_alerts', 'list_alert_rules', 'list_uptime_checks', 'list_templates', 'list_backups',
];
const WRITE = [
  'create_app', 'update_app', 'deploy_app', 'rollback_app', 'restart_app', 'stop_app', 'start_app',
  'set_env_vars', 'create_server', 'provision_server', 'create_alert_rule', 'ack_alert',
  'create_uptime_check', 'create_backup', 'run_backup',
];
const DESTRUCTIVE = ['delete_app', 'delete_server', 'restore_backup'];

const api = new DocksyApi({ url: 'http://docksy.test', token: 'dsk_x', fetch: (async () => { throw new Error('no network in tests'); }) as typeof fetch });

test('tool names are unique snake_case', () => {
  const names = ALL_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.match(n, /^[a-z]+(_[a-z]+)*$/);
});

test('exactly the CONTRACT §8 tool set, with matching kinds', () => {
  const byKind = (k: string) => ALL_TOOLS.filter((t) => t.kind === k).map((t) => t.name).sort();
  assert.deepEqual(byKind('read'), [...READ].sort());
  assert.deepEqual(byKind('write'), [...WRITE].sort());
  assert.deepEqual(byKind('destructive'), [...DESTRUCTIVE].sort());
});

test('every tool has a useful description and described inputs', () => {
  for (const t of ALL_TOOLS) {
    assert.ok(t.description.length > 60, `${t.name} description too short`);
    assert.ok(t.title, `${t.name} has no title`);
    for (const [key, schema] of Object.entries(inputShape(t))) {
      assert.ok((schema as z.ZodType).description, `${t.name}.${key} has no .describe()`);
    }
  }
});

test('readonly filtering hides write and destructive tools', () => {
  const ro = visibleTools(ALL_TOOLS, { readonly: true });
  assert.deepEqual(ro.map((t) => t.name).sort(), [...READ].sort());
  assert.equal(visibleTools(ALL_TOOLS, { readonly: false }).length, READ.length + WRITE.length + DESTRUCTIVE.length);
});

test('annotations reflect kind', () => {
  for (const t of ALL_TOOLS) {
    const a = annotations(t);
    assert.equal(a.readOnlyHint, t.kind === 'read', t.name);
    assert.equal(a.destructiveHint, t.kind === 'destructive', t.name);
    if (t.kind === 'read') assert.equal(a.idempotentHint, true);
  }
  const byName = new Map(ALL_TOOLS.map((t) => [t.name, t]));
  assert.equal(annotations(byName.get('deploy_app')!).idempotentHint, false);
  assert.equal(annotations(byName.get('set_env_vars')!).idempotentHint, true);
});

test('destructive tools expose confirm and say so in the description', () => {
  for (const t of ALL_TOOLS.filter((x) => x.kind === 'destructive')) {
    assert.ok('confirm' in inputShape(t), t.name);
    assert.match(fullDescription(t), /confirm: true/);
  }
  for (const t of ALL_TOOLS.filter((x) => x.kind !== 'destructive')) assert.ok(!('confirm' in inputShape(t)), t.name);
});

function fakeDestructive(): { def: ToolDef; calls: unknown[] } {
  const calls: unknown[] = [];
  const def = defineTool({
    name: 'nuke_thing',
    title: 'Nuke',
    description: 'test',
    kind: 'destructive',
    input: { id: z.string().describe('id') },
    async run(args) {
      calls.push(args);
      return { text: 'gone', data: { ok: true } };
    },
  });
  return { def, calls };
}

test('confirm guard blocks destructive calls without confirm: true', async () => {
  const { def, calls } = fakeDestructive();
  for (const args of [{ id: 'a' }, { id: 'a', confirm: false }, { id: 'a', confirm: 'yes' }]) {
    const r = await invokeTool(def, args, { api });
    assert.equal(r.isError, true);
    assert.match((r.content[0] as { text: string }).text, /confirm: true/);
    assert.equal((r.structuredContent as { error: { code: string } }).error.code, 'confirmation_required');
  }
  assert.equal(calls.length, 0);
});

test('confirm guard lets confirmed calls through and strips confirm', async () => {
  const { def, calls } = fakeDestructive();
  const r = await invokeTool(def, { id: 'a', confirm: true }, { api });
  assert.equal(r.isError, undefined);
  assert.deepEqual(calls, [{ id: 'a' }]);
});

test('real destructive tools never touch the API without confirm', async () => {
  for (const name of DESTRUCTIVE) {
    const def = ALL_TOOLS.find((t) => t.name === name)!;
    const r = await invokeTool(def, { appId: 'x', serverId: 'x', runId: 'x' }, { api });
    assert.equal(r.isError, true, name);
    assert.match((r.content[0] as { text: string }).text, /destructive/);
  }
});

test('errors become isError results, not throws', async () => {
  const def = ALL_TOOLS.find((t) => t.name === 'list_servers')!;
  const r = await invokeTool(def, {}, { api });
  assert.equal(r.isError, true);
  assert.match((r.content[0] as { text: string }).text, /Couldn't reach Docksy/);
});

test('toResult wraps arrays and keeps objects as structuredContent', () => {
  assert.deepEqual(toResult({ text: 't', data: [1, 2] }).structuredContent, { items: [1, 2] });
  assert.deepEqual(toResult({ text: 't', data: { a: 1 } }).structuredContent, { a: 1 });
  assert.equal(toResult({ text: 't' }).structuredContent, undefined);
});
