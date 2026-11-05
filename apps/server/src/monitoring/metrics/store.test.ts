import { db, makeServer, makeApp, report, container } from './test-helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestReport, listContainers, queryServerMetrics, queryAppMetrics, fleetOverview, latestLive, pickDisk, forgetServer } from './store.ts';
import { runRollups } from './rollup.ts';

test('ingest maps report fields into metrics row and server identity', () => {
  const s = makeServer('map');
  const t = 1_800_000_000_000;
  ingestReport(s.id, report({
    disks: [
      { mount: '/data', fs: 'ext4', total: 900_000, used: 1 },
      { mount: '/', fs: 'ext4', total: 100_000, used: 40_000 },
    ],
  }), t);
  const m = db.prepare('SELECT * FROM metrics WHERE server_id = ?').get(s.id) as any;
  assert.equal(m.res, 0);
  assert.equal(m.ts, t);
  assert.equal(m.cpu, 25);
  assert.equal(m.load1, 0.5);
  assert.equal(m.mem_used, 2000);
  assert.equal(m.mem_total, 8000);
  assert.equal(m.swap_used, 100);
  assert.equal(m.disk_used, 40_000); // "/" wins over the larger /data
  assert.equal(m.disk_total, 100_000);
  assert.equal(m.net_rx, 500);
  assert.equal(m.net_tx, 250);
  const srv = db.prepare('SELECT * FROM servers WHERE id = ?').get(s.id) as any;
  assert.equal(srv.last_seen_at, t);
  assert.equal(srv.agent_version, '0.1.0');
  assert.equal(srv.os, 'ubuntu 24.04');
  assert.equal(srv.arch, 'amd64');
  assert.equal(srv.cpu_cores, 4);
  assert.equal(srv.mem_total, 8000);
  assert.equal(srv.disk_total, 100_000);
});

test('pickDisk falls back to the largest filesystem', () => {
  assert.deepEqual(pickDisk([]), { total: 0, used: 0 });
  assert.equal(pickDisk([{ mount: '/a', fs: 'xfs', total: 5, used: 1 }, { mount: '/b', fs: 'xfs', total: 9, used: 2 }]).used, 2);
});

test('container_state is replaced on every report; app_id comes from the docksy.app label', () => {
  const s = makeServer('cs');
  const appId = makeApp(s.id, 'web-cs');
  ingestReport(s.id, report({
    containers: [
      container({ id: 'aaa', name: 'dx-web-cs-1', labels: { 'docksy.app': appId, 'docksy.managed': 'true' } }),
      container({ id: 'bbb', name: 'other', state: 'exited', cpuPercent: 0 }),
    ],
  }), 1_800_000_010_000);
  let items = listContainers(s.id);
  assert.deepEqual(items.map((c) => c.id), ['aaa', 'bbb']);
  assert.equal(items[0]!.appId, appId);
  assert.equal(items[0]!.labels['docksy.managed'], 'true');
  assert.equal(items[1]!.appId, null);
  // Only running containers get a time-series row.
  const cm = db.prepare('SELECT container_name, app_id FROM container_metrics WHERE server_id = ?').all(s.id) as any[];
  assert.deepEqual(cm.map((r) => [r.container_name, r.app_id]), [['dx-web-cs-1', appId]]);

  ingestReport(s.id, report({ containers: [container({ id: 'ccc', name: 'new-one', cpuPercent: 7, restartCount: 2 })] }), 1_800_000_020_000);
  items = listContainers(s.id);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.id, 'ccc');
  assert.equal(items[0]!.cpuPercent, 7);
  assert.equal(items[0]!.restartCount, 2);
  assert.equal(items[0]!.serverId, s.id);
});

test('server metrics: raw ranges read res 0 and stay within the window', () => {
  const s = makeServer('raw');
  const t0 = 1_800_000_000_000;
  for (let i = 0; i < 120; i++) ingestReport(s.id, report({ cpu: { percent: i, cores: 4, perCore: [], load1: 1, load5: 1, load15: 1 } }), t0 + i * 10_000);
  const nowT = t0 + 119 * 10_000;
  const m = queryServerMetrics(s.id, '15m', nowT);
  assert.equal(m.stepSec, 10);
  assert.equal(m.points.length, 91); // 15 minutes of 10s points, window start inclusive
  assert.equal(m.points.at(-1)!.cpu, 119);
  assert.equal(m.points[0]!.ts, new Date(nowT - 90 * 10_000).toISOString());
});

test('server metrics: 24h uses 1-minute rollups plus the raw tail', () => {
  const s = makeServer('roll');
  const t0 = 1_800_000_000_000; // minute-aligned
  for (let i = 0; i < 18; i++) ingestReport(s.id, report(), t0 + i * 10_000); // 3 minutes
  runRollups(t0 + 2 * 60_000 + 5_000); // rolls minutes 0 and 1 only (minute 2 incomplete)
  const rolled = db.prepare('SELECT COUNT(*) AS n FROM metrics WHERE server_id = ? AND res = 60').get(s.id) as any;
  assert.equal(rolled.n, 2);
  const m = queryServerMetrics(s.id, '24h', t0 + 3 * 60_000);
  assert.equal(m.stepSec, 240);
  assert.equal(m.points.length, 1); // all inside one 4-minute bucket
  assert.equal(m.points[0]!.cpu, 25);
});

test('app metrics sum all of an app containers per timestamp', () => {
  const s = makeServer('appm');
  const appId = makeApp(s.id, 'web-appm');
  const t = 1_800_000_000_000;
  ingestReport(s.id, report({
    containers: [
      container({ id: 'o', name: 'dx-web-appm-old', cpuPercent: 10, memUsed: 100, labels: { 'docksy.app': appId } }),
      container({ id: 'n', name: 'dx-web-appm-new', cpuPercent: 5, memUsed: 50, labels: { 'docksy.app': appId } }),
      container({ id: 'x', name: 'unrelated', cpuPercent: 99, memUsed: 999 }),
    ],
  }), t);
  const { points } = queryAppMetrics(appId, '1h', t + 1000);
  assert.equal(points.length, 1);
  assert.equal(points[0]!.cpu, 15);
  assert.equal(points[0]!.memUsed, 150);
});

test('overview totals and sparkline', () => {
  db.exec('DELETE FROM apps; DELETE FROM servers');
  const a = makeServer('a');
  const b = makeServer('b');
  makeApp(a.id, 'ov-one');
  makeApp(a.id, 'ov-two');
  makeApp(b.id, 'ov-three');
  const base = Date.now() - 40 * 1000;
  for (let i = 0; i < 35; i++) ingestReport(a.id, report({ cpu: { percent: i, cores: 2, perCore: [], load1: 0, load5: 0, load15: 0 } }), base - (34 - i) * 10_000 + 30_000);
  ingestReport(a.id, report({ containers: [container({ id: '1', name: 'c1' }), container({ id: '2', name: 'c2', state: 'exited' })] }), Date.now());
  db.prepare(`INSERT INTO alerts (id, server_id, dedupe_key, state, severity, title, message, started_at) VALUES ('al1', ?, 'k1', 'firing', 'warning', 't', 'm', 1)`).run(a.id);
  db.prepare(`INSERT INTO alerts (id, server_id, dedupe_key, state, severity, title, message, started_at) VALUES ('al2', NULL, 'k2', 'firing', 'critical', 't', 'm', 1)`).run();
  db.prepare(`INSERT INTO alerts (id, server_id, dedupe_key, state, severity, title, message, started_at) VALUES ('al3', ?, 'k3', 'resolved', 'warning', 't', 'm', 1)`).run(b.id);

  const ov = fleetOverview();
  assert.deepEqual(ov.totals, { servers: 2, online: 1, apps: 3, runningContainers: 1, firingAlerts: 2 });
  const sa = ov.servers.find((x) => x.server.id === a.id)!;
  const sb = ov.servers.find((x) => x.server.id === b.id)!;
  assert.equal(sa.appsCount, 2);
  assert.equal(sa.firingAlerts, 1);
  assert.equal(sa.spark.length, 30);
  assert.equal(sa.spark.at(-1), 25); // latest report (default cpu 25) is last
  assert.equal(sa.spark[0], 6); // oldest of the last 30, chronological order
  assert.equal(sa.latest!.cpu, 25);
  assert.equal(sb.latest, null);
  assert.deepEqual(sb.spark, []);
  assert.equal(sb.appsCount, 1);
  assert.equal(sb.firingAlerts, 0);
});

test('latestLive keeps perCore from memory and rebuilds from the DB otherwise', () => {
  const s = makeServer('live');
  ingestReport(s.id, report({ containers: [container({ id: 'z', name: 'z' })] }), 1_800_000_000_000);
  assert.deepEqual(latestLive(s.id)!.perCore, [10, 20, 30, 40]);
  forgetServer(s.id);
  const ev = latestLive(s.id)!;
  assert.deepEqual(ev.perCore, []);
  assert.equal(ev.point.cpu, 25);
  assert.equal(ev.containers[0]!.name, 'z');
  assert.equal(latestLive('nope'), null);
});
