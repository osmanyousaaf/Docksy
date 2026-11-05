import './test-env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentContainer, AgentReport, Alert } from '@docksy/shared';
import { db, migrate, newId, type Row } from '../../db/index.ts';
import { bus } from '../../lib/events.ts';
import {
  checkOffline, evaluateReport, fireEventAlert, flushNotifications, onDeploymentFinished, resolveEventAlert,
  resolveRuleAlerts, startEngine, stopEngine,
} from './engine.ts';
import { seedDefaultRules, DEFAULT_RULES } from './defaults.ts';
import { setNotifyTransport } from './notify.ts';
import { writeConfig } from './model.ts';

const sent: { url: string; body: any }[] = [];

before(() => {
  migrate();
  assert.equal(seedDefaultRules(), DEFAULT_RULES.length);
  assert.equal(seedDefaultRules(), 0, 'seeding is idempotent');
  db.prepare('INSERT INTO notification_channels (id, name, type, config_enc, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)')
    .run('ch1', 'hook', 'webhook', writeConfig({ url: 'https://hooks.example.com/docksy' }), Date.now());
  setNotifyTransport({
    fetch: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, text: async () => '' }; },
  });
});
after(() => { setNotifyTransport(); stopEngine(); });

function server(name: string, lastSeen: number | null = Date.now()): string {
  const id = newId();
  db.prepare('INSERT INTO servers (id, name, host, status, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, '10.0.0.1', 'ready', lastSeen, Date.now(), Date.now());
  return id;
}

function app(serverId: string, name: string, status = 'running'): string {
  const id = newId();
  db.prepare('INSERT INTO apps (id, name, server_id, status, webhook_secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, serverId, status, 'whs_x', Date.now(), Date.now());
  return id;
}

function raw(serverId: string, ts: number, cpu: number, memPct = 10, diskPct = 10): void {
  db.prepare(`INSERT INTO metrics (server_id, res, ts, cpu, load1, mem_used, mem_total, swap_used, disk_used, disk_total, net_rx, net_tx)
              VALUES (?, 0, ?, ?, 0.5, ?, 1000, 0, ?, 1000, 0, 0)`).run(serverId, ts, cpu, memPct * 10, diskPct * 10);
}

const report = (o: { cpu?: number; memPct?: number; diskPct?: number; containers?: AgentContainer[] } = {}): AgentReport => ({
  agentVersion: '0.1.0', hostname: 'h', os: 'ubuntu 24.04', arch: 'amd64', uptimeSec: 100, ts: Date.now(),
  cpu: { percent: o.cpu ?? 5, cores: 2, perCore: [5, 5], load1: 0.5, load5: 0.5, load15: 0.5 },
  mem: { total: 1000, used: (o.memPct ?? 10) * 10, available: 1000 - (o.memPct ?? 10) * 10, swapTotal: 0, swapUsed: 0 },
  disks: [{ mount: '/', fs: 'ext4', total: 1000, used: (o.diskPct ?? 10) * 10 }],
  net: { rxBytesPerSec: 0, txBytesPerSec: 0 },
  containers: o.containers ?? [],
});

const container = (o: Partial<AgentContainer>): AgentContainer => ({
  id: 'c1', name: 'dx-api-12345678', image: 'docksy/api:1', state: 'running', status: 'Up 1 minute', restartCount: 0,
  startedAt: null, cpuPercent: 1, memUsed: 1, memLimit: 0, netRx: 0, netTx: 0, labels: {}, ...o,
});

const alertsFor = (serverId: string, state?: 'firing' | 'resolved'): Row[] =>
  db.prepare(`SELECT * FROM alerts WHERE server_id = ? ${state ? 'AND state = ?' : ''} ORDER BY started_at`).all(...(state ? [serverId, state] : [serverId])) as Row[];

const metricOf = (r: Row): string => (db.prepare('SELECT metric FROM alert_rules WHERE id = ?').get(r.rule_id) as Row).metric;

test('CPU over 90% only fires after 5 minutes of raw samples, then resolves and notifies', async () => {
  const s = server('prod-1');
  const t0 = 10_000_000;
  // 2 minutes of high CPU: not enough
  for (let i = 0; i <= 12; i++) raw(s, t0 + i * 10_000, 97);
  evaluateReport(s, report({ cpu: 97 }));
  assert.equal(alertsFor(s, 'firing').length, 0);
  // extend to 5 minutes
  for (let i = 13; i <= 30; i++) raw(s, t0 + i * 10_000, 97);
  sent.length = 0;
  evaluateReport(s, report({ cpu: 97 }));
  const firing = alertsFor(s, 'firing');
  assert.equal(firing.length, 1);
  assert.equal(firing[0]!.title, 'CPU on prod-1 is 97%');
  assert.equal(firing[0]!.message, 'CPU on prod-1 is 97% (over 90% for 5m)');
  assert.equal(firing[0]!.severity, 'warning');
  // dedupe: still one firing alert
  evaluateReport(s, report({ cpu: 98 }));
  assert.equal(alertsFor(s, 'firing').length, 1);
  assert.equal(Number(alertsFor(s, 'firing')[0]!.value), 98);
  await flushNotifications();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.body.event, 'alert.fired');
  assert.equal(sent[0]!.body.text, '🟠 CPU on prod-1 is 97% (over 90% for 5m)');
  assert.equal(sent[0]!.body.hint, 'Ask Claude: /docksy:diagnose prod-1');
  // condition clears → resolved + resolve notification
  evaluateReport(s, report({ cpu: 30 }));
  assert.equal(alertsFor(s, 'firing').length, 0);
  assert.equal(alertsFor(s, 'resolved').length, 1);
  await flushNotifications();
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.body.event, 'alert.resolved');
  assert.match(sent[1]!.body.text, /^✅ CPU on prod-1 is back to 30%/);
});

test('a calm sample inside the window prevents firing', () => {
  const s = server('calm');
  const t0 = 20_000_000;
  for (let i = 0; i <= 30; i++) raw(s, t0 + i * 10_000, i === 15 ? 40 : 97);
  evaluateReport(s, report({ cpu: 97 }));
  assert.equal(alertsFor(s, 'firing').length, 0);
});

test('memory uses the raw window too (critical)', () => {
  const s = server('mem-box');
  for (let i = 0; i <= 30; i++) raw(s, 30_000_000 + i * 10_000, 5, 95);
  evaluateReport(s, report({ memPct: 95 }));
  const a = alertsFor(s, 'firing');
  assert.equal(a.length, 1);
  assert.equal(a[0]!.severity, 'critical');
  assert.equal(a[0]!.title, 'Memory on mem-box is 95%');
});

test('disk rules fire instantly, one alert per rule, and resolve per rule', () => {
  const s = server('disky');
  evaluateReport(s, report({ diskPct: 96 }));
  const a = alertsFor(s, 'firing');
  assert.equal(a.length, 2, '85% warning and 95% critical');
  assert.deepEqual(a.map((x) => x.severity).sort(), ['critical', 'warning']);
  evaluateReport(s, report({ diskPct: 90 }));
  const still = alertsFor(s, 'firing');
  assert.equal(still.length, 1);
  assert.equal(still[0]!.severity, 'warning');
  assert.equal(still[0]!.message, 'Disk on disky is 90% full (over 85%)');
  evaluateReport(s, report({ diskPct: 50 }));
  assert.equal(alertsFor(s, 'firing').length, 0);
});

test('offline detection: fires after 2m without reports, resolves on the next report', () => {
  const t = Date.now();
  const s = server('quiet', t - 3 * 60_000);
  const fresh = server('fresh', t - 30_000);
  const never = server('never', null);
  checkOffline(t);
  checkOffline(t + 30_000);
  const a = alertsFor(s, 'firing');
  assert.equal(a.length, 1);
  assert.equal(metricOf(a[0]!), 'server_offline');
  assert.equal(a[0]!.title, 'quiet is offline');
  assert.match(a[0]!.message, /hasn't reported for 3m/);
  assert.equal(alertsFor(fresh).length, 0);
  assert.equal(alertsFor(never).length, 0, 'servers that never reported are not offline');
  // agent comes back
  db.prepare('UPDATE servers SET last_seen_at = ? WHERE id = ?').run(t + 31_000, s);
  evaluateReport(s, report());
  assert.equal(alertsFor(s, 'firing').length, 0);
  // the loop also resolves when last_seen is recent
  db.prepare('UPDATE servers SET last_seen_at = ? WHERE id = ?').run(t - 5 * 60_000, fresh);
  checkOffline(t);
  assert.equal(alertsFor(fresh, 'firing').length, 1);
  db.prepare('UPDATE servers SET last_seen_at = ? WHERE id = ?').run(t, fresh);
  checkOffline(t + 1000);
  assert.equal(alertsFor(fresh, 'firing').length, 0);
});

test('event alerts: fireEventAlert dedupes by key, resolveEventAlert resolves', () => {
  const s = server('web-1');
  const a = app(s, 'shop');
  const events: Alert[] = [];
  const off1 = bus.on('alert.fired', (p) => events.push(p.alert));
  const off2 = bus.on('alert.resolved', (p) => events.push(p.alert));
  fireEventAlert('uptime_down', { key: 'uptime:check1', title: 'shop.example.com is down', message: 'shop.example.com is down: HTTP 502', appId: a });
  fireEventAlert('uptime_down', { key: 'uptime:check1', title: 'shop.example.com is down', message: 'still down', appId: a });
  const firing = db.prepare("SELECT * FROM alerts WHERE dedupe_key = 'uptime:check1' AND state = 'firing'").all() as Row[];
  assert.equal(firing.length, 1);
  assert.equal(firing[0]!.server_id, s, 'server is derived from the app');
  assert.equal(firing[0]!.severity, 'critical', 'severity comes from the rule');
  resolveEventAlert('uptime:check1');
  resolveEventAlert('uptime:check1'); // no-op
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE dedupe_key = 'uptime:check1' AND state = 'firing'").get() as Row).n, 0);
  assert.deepEqual(events.map((e) => e.state), ['firing', 'resolved']);
  off1(); off2();
  // a disabled rule means the alert is off
  db.prepare("UPDATE alert_rules SET enabled = 0 WHERE metric = 'backup_failed'").run();
  fireEventAlert('backup_failed', { key: 'backup:b1', title: 'Backup failed', message: 'x', appId: a, severity: 'warning' });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE dedupe_key = 'backup:b1'").get() as Row).n, 0);
  db.prepare("UPDATE alert_rules SET enabled = 1 WHERE metric = 'backup_failed'").run();
  fireEventAlert('backup_failed', { key: 'backup:b1', title: 'Backup failed', message: 'x', appId: a, severity: 'warning' });
  assert.equal((db.prepare("SELECT severity FROM alerts WHERE dedupe_key = 'backup:b1'").get() as Row).severity, 'warning', 'explicit severity wins');
});

test('deploy_failed fires on failure and resolves on the next success', () => {
  const s = server('deploy-box');
  const a = app(s, 'api');
  onDeploymentFinished({ appId: a, status: 'failed', error: 'npm ERR! build failed\n  exit 1' });
  onDeploymentFinished({ appId: a, status: 'failed', error: 'again' });
  let rows = alertsFor(s, 'firing');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.title, 'Deploy of api failed');
  assert.equal(rows[0]!.app_id, a);
  onDeploymentFinished({ appId: a, status: 'cancelled', error: null });
  assert.equal(alertsFor(s, 'firing').length, 1, 'cancel changes nothing');
  onDeploymentFinished({ appId: a, status: 'succeeded', error: null });
  rows = alertsFor(s, 'firing');
  assert.equal(rows.length, 0);
});

test('container_down: managed containers of live apps only', () => {
  const s = server('ctr-box');
  const a = app(s, 'api-2');
  const labels = { 'docksy.managed': 'true', 'docksy.app': a };
  const down = container({ id: 'c1', state: 'exited', status: 'Exited (1) 1 minute ago', labels });
  const unmanaged = container({ id: 'c2', name: 'random', state: 'exited', labels: {} });
  evaluateReport(s, report({ containers: [down, unmanaged] }));
  let firing = alertsFor(s, 'firing').filter((r) => metricOf(r) === 'container_down');
  assert.equal(firing.length, 1);
  assert.equal(firing[0]!.title, 'api-2 is down on ctr-box');
  assert.equal(firing[0]!.app_id, a);
  // running again → resolved
  evaluateReport(s, report({ containers: [{ ...down, state: 'running' }] }));
  assert.equal(alertsFor(s, 'firing').length, 0);
  // stopped on purpose → no alert
  evaluateReport(s, report({ containers: [down] }));
  assert.equal(alertsFor(s, 'firing').length, 1);
  db.prepare("UPDATE apps SET status = 'stopped' WHERE id = ?").run(a);
  evaluateReport(s, report({ containers: [down] }));
  firing = alertsFor(s, 'firing');
  assert.equal(firing.length, 0);
});

test('container_restarts: more than 3 restarts in 10 minutes', () => {
  const s = server('loop-box');
  const t = 50_000_000;
  const c = (n: number) => container({ id: 'cr', name: 'dx-worker-1', restartCount: n, state: 'running' });
  evaluateReport(s, report({ containers: [c(1)] }), t);
  evaluateReport(s, report({ containers: [c(3)] }), t + 60_000);
  assert.equal(alertsFor(s, 'firing').length, 0, '2 restarts is fine');
  evaluateReport(s, report({ containers: [c(6)] }), t + 120_000);
  const firing = alertsFor(s, 'firing');
  assert.equal(firing.length, 1);
  assert.equal(firing[0]!.title, 'dx-worker-1 restarted 5 times in 10m on loop-box');
  // 11 minutes later with no new restarts → window is clean → resolved
  evaluateReport(s, report({ containers: [c(6)] }), t + 120_000 + 11 * 60_000);
  assert.equal(alertsFor(s, 'firing').length, 0);
});

test('rule channelIds limits who is notified; resolveRuleAlerts is quiet', async () => {
  const s = server('scoped');
  db.prepare('INSERT INTO notification_channels (id, name, type, config_enc, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)')
    .run('ch2', 'other', 'webhook', writeConfig({ url: 'https://other.example.com/hook' }), Date.now());
  const ruleId = newId();
  db.prepare(`INSERT INTO alert_rules (id, name, metric, op, threshold, duration_sec, severity, server_id, channel_ids, enabled, is_default, created_at)
              VALUES (?, 'load', 'load', '>', 4, 0, 'info', ?, '["ch2"]', 1, 0, ?)`).run(ruleId, s, Date.now());
  await flushNotifications();
  sent.length = 0;
  const r = report();
  r.cpu.load1 = 7.25;
  evaluateReport(s, r);
  await flushNotifications();
  assert.deepEqual(sent.map((x) => x.url), ['https://other.example.com/hook']);
  assert.equal(sent[0]!.body.text, '🔵 Load on scoped is 7.3 (over 4)');
  assert.equal(resolveRuleAlerts(ruleId), 1);
  await flushNotifications();
  assert.equal(sent.length, 1, 'no resolve notification for rule cleanup');
  db.prepare('DELETE FROM alert_rules WHERE id = ?').run(ruleId);
  db.prepare("DELETE FROM notification_channels WHERE id = 'ch2'").run();
});

test('startEngine listens on the bus', () => {
  const s = server('bus-box');
  const a = app(s, 'bus-app');
  startEngine({ offlineIntervalMs: 60_000 });
  startEngine(); // idempotent
  bus.emit('server.report', { serverId: s, report: report({ diskPct: 99 }) });
  assert.equal(alertsFor(s, 'firing').length, 2);
  bus.emit('deployment.finished', { deploymentId: 'd1', appId: a, status: 'failed', error: 'boom' });
  assert.equal(alertsFor(s, 'firing').length, 3);
  stopEngine();
  bus.emit('server.report', { serverId: s, report: report({ diskPct: 10 }) });
  assert.equal(alertsFor(s, 'firing').length, 3, 'stopped engine ignores reports');
});
