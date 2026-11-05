import { db, makeServer, report, container } from './test-helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestReport } from './store.ts';
import { runRollups, applyRetention } from './rollup.ts';

const T0 = 1_800_000_000_000 - (1_800_000_000_000 % 3_600_000); // hour-aligned

function r(cpu: number, memUsed: number, diskUsed: number, rx: number) {
  return report({
    cpu: { percent: cpu, cores: 2, perCore: [], load1: cpu / 10, load5: 0, load15: 0 },
    mem: { total: 1000, used: memUsed, available: 1000 - memUsed, swapTotal: 0, swapUsed: 0 },
    disks: [{ mount: '/', fs: 'ext4', total: 5000, used: diskUsed }],
    net: { rxBytesPerSec: rx, txBytesPerSec: rx * 2 },
    containers: [container({ id: 'c', name: 'app', cpuPercent: cpu, memUsed })],
  });
}

test('raw → 60s rollup: avg cpu/load/net, max mem/disk, idempotent', () => {
  const s = makeServer('r60');
  ingestReport(s.id, r(10, 100, 1000, 10), T0);
  ingestReport(s.id, r(20, 300, 1200, 20), T0 + 20_000);
  ingestReport(s.id, r(30, 200, 1100, 30), T0 + 40_000);
  ingestReport(s.id, r(90, 900, 4000, 90), T0 + 60_000); // next minute, incomplete

  runRollups(T0 + 61_000);
  runRollups(T0 + 61_000); // second run must not duplicate or change
  const rows = db.prepare('SELECT * FROM metrics WHERE server_id = ? AND res = 60').all(s.id) as any[];
  assert.equal(rows.length, 1);
  const m = rows[0];
  assert.equal(m.ts, T0);
  assert.equal(m.cpu, 20);
  assert.ok(Math.abs(m.load1 - 2) < 1e-9);
  assert.equal(m.mem_used, 300);
  assert.equal(m.disk_used, 1200);
  assert.equal(m.net_rx, 20);
  assert.equal(m.net_tx, 40);

  const c = db.prepare('SELECT * FROM container_metrics WHERE server_id = ? AND res = 60').all(s.id) as any[];
  assert.equal(c.length, 1);
  assert.equal(c[0].cpu, 20);
  assert.equal(c[0].mem_used, 300);

  // A late report inside the lookback window is absorbed on the next run.
  ingestReport(s.id, r(60, 100, 1000, 10), T0 + 50_000);
  runRollups(T0 + 62_000);
  const again = db.prepare('SELECT cpu FROM metrics WHERE server_id = ? AND res = 60 AND ts = ?').get(s.id, T0) as any;
  assert.equal(again.cpu, 30); // (10+20+30+60)/4
});

test('60s → 3600s rollup covers complete hours only', () => {
  const s = makeServer('r3600');
  for (let i = 0; i < 60; i++) ingestReport(s.id, r(i % 2 ? 40 : 20, 100 + i, 1000, 0), T0 + i * 60_000);
  ingestReport(s.id, r(99, 999, 1000, 0), T0 + 3_600_000); // first minute of the next hour
  runRollups(T0 + 3_600_000 + 61_000);
  const hours = db.prepare('SELECT * FROM metrics WHERE server_id = ? AND res = 3600').all(s.id) as any[];
  assert.equal(hours.length, 1);
  assert.equal(hours[0].ts, T0);
  assert.equal(hours[0].cpu, 30);
  assert.equal(hours[0].mem_used, 159);
  const minutes = db.prepare('SELECT COUNT(*) AS n FROM metrics WHERE server_id = ? AND res = 60').get(s.id) as any;
  assert.equal(minutes.n, 61);
});

test('retention: raw 48h, minutes 14d, hours per settings', () => {
  const s = makeServer('ret');
  const nowT = T0 + 100 * 24 * 3_600_000;
  const day = 24 * 3_600_000;
  const ins = db.prepare(`INSERT INTO metrics (server_id, res, ts, cpu, load1, mem_used, mem_total, swap_used, disk_used, disk_total, net_rx, net_tx)
    VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0)`);
  ins.run(s.id, 0, nowT - 49 * 3_600_000); // drop
  ins.run(s.id, 0, nowT - 47 * 3_600_000); // keep
  ins.run(s.id, 60, nowT - 15 * day); // drop
  ins.run(s.id, 60, nowT - 13 * day); // keep
  ins.run(s.id, 3600, nowT - 31 * day); // drop (default 30 days)
  ins.run(s.id, 3600, nowT - 29 * day); // keep
  db.prepare(`INSERT INTO container_metrics (server_id, container_name, res, ts, cpu, mem_used, net_rx, net_tx) VALUES (?, 'c', 0, ?, 0, 0, 0, 0)`)
    .run(s.id, nowT - 49 * 3_600_000);
  applyRetention(nowT);
  const left = (db.prepare('SELECT res FROM metrics WHERE server_id = ? ORDER BY res').all(s.id) as any[]).map((x) => x.res);
  assert.deepEqual(left, [0, 60, 3600]);
  const cm = db.prepare('SELECT COUNT(*) AS n FROM container_metrics WHERE server_id = ?').get(s.id) as any;
  assert.equal(cm.n, 0);
});
