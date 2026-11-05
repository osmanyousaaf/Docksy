import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentReport, AlertRule } from '@docksy/shared';
import { breaches, fmtDuration, heldFor, hostCopy, primaryDisk, reportValue, restartsInWindow, rowValue } from './evaluate.ts';

const opts = { toleranceMs: 10_000, maxGapMs: 90_000 };
const series = (values: number[], stepMs = 10_000, end = 1_000_000) =>
  values.map((value, i) => ({ ts: end - (values.length - 1 - i) * stepMs, value })).reverse(); // newest first

test('breaches respects op', () => {
  assert.equal(breaches(91, '>', 90), true);
  assert.equal(breaches(90, '>', 90), false);
  assert.equal(breaches(3, '<', 5), true);
});

test('heldFor: fires only after the breach spans the duration', () => {
  const over = (v: number) => v > 90;
  // 31 samples, 10s apart = 300s of breach
  assert.equal(heldFor(series(Array(31).fill(95)), over, 300_000, opts), true);
  // only 2 minutes of breach
  assert.equal(heldFor(series(Array(13).fill(95)), over, 300_000, opts), false);
  // tolerance: 290s span is accepted for a 300s rule (newest report may not be stored yet)
  assert.equal(heldFor(series(Array(30).fill(95)), over, 300_000, opts), true);
});

test('heldFor: a dip inside the window resets the run', () => {
  const over = (v: number) => v > 90;
  const vals = Array(31).fill(95);
  vals[10] = 50; // one calm sample 200s ago
  assert.equal(heldFor(series(vals), over, 300_000, opts), false);
  // newest sample calm → never fires
  const calmNow = Array(31).fill(95);
  calmNow[30] = 10;
  assert.equal(heldFor(series(calmNow), over, 300_000, opts), false);
});

test('heldFor: gaps in data stop the run', () => {
  const over = (v: number) => v > 90;
  const s = [{ ts: 1_000_000, value: 95 }, { ts: 990_000, value: 95 }, { ts: 600_000, value: 95 }];
  assert.equal(heldFor(s, over, 300_000, opts), false);
});

test('heldFor: zero duration uses the newest sample', () => {
  assert.equal(heldFor([{ ts: 1, value: 99 }], (v) => v > 90, 0, opts), true);
  assert.equal(heldFor([], (v) => v > 90, 0, opts), false);
});

test('restartsInWindow counts increases inside the window', () => {
  const h = [
    { ts: 0, count: 1 }, // outside the window
    { ts: 100_000, count: 2 },
    { ts: 300_000, count: 4 },
    { ts: 600_000, count: 6 },
  ];
  assert.equal(restartsInWindow(h, 600_000, 550_000), 4);
  assert.equal(restartsInWindow(h, 600_000, 700_000), 5);
  assert.equal(restartsInWindow([], 1, 1), 0);
});

const report = (over: Partial<AgentReport> = {}): AgentReport => ({
  agentVersion: '0.1.0', hostname: 'h', os: 'ubuntu', arch: 'amd64', uptimeSec: 1, ts: 0,
  cpu: { percent: 97.4, cores: 2, perCore: [97, 98], load1: 3.21, load5: 1, load15: 1 },
  mem: { total: 1000, used: 930, available: 70, swapTotal: 0, swapUsed: 0 },
  disks: [{ mount: '/data', fs: 'ext4', total: 1000, used: 990 }, { mount: '/', fs: 'ext4', total: 100, used: 88 }],
  net: { rxBytesPerSec: 0, txBytesPerSec: 0 },
  containers: [],
  ...over,
});

test('reportValue picks the right numbers', () => {
  const r = report();
  assert.equal(reportValue('cpu', r), 97.4);
  assert.equal(reportValue('mem', r), 93);
  assert.equal(reportValue('disk', r), 88); // mount "/" wins over the larger disk
  assert.equal(reportValue('swap', r), null); // no swap configured
  assert.equal(reportValue('load', r), 3.21);
  assert.equal(primaryDisk([{ mount: '/a', fs: 'x', total: 5, used: 1 }, { mount: '/b', fs: 'x', total: 9, used: 1 }])?.total, 9);
});

test('rowValue reads raw metrics rows', () => {
  const row = { cpu: 50, load1: 1, mem_used: 50, mem_total: 200, swap_used: 10, disk_used: 30, disk_total: 60 };
  assert.equal(rowValue('mem', row), 25);
  assert.equal(rowValue('disk', row), 50);
  assert.equal(rowValue('swap', row, 100), 10);
  assert.equal(rowValue('swap', row, 0), null);
});

test('human copy', () => {
  const rule = { metric: 'cpu', op: '>', threshold: 90, durationSec: 300 } as AlertRule;
  assert.deepEqual(hostCopy(rule, 'prod-1', 97.4), { title: 'CPU on prod-1 is 97%', message: 'CPU on prod-1 is 97% (over 90% for 5m)' });
  const disk = { metric: 'disk', op: '>', threshold: 85, durationSec: 0 } as AlertRule;
  assert.equal(hostCopy(disk, 'db', 88.2).message, 'Disk on db is 88% full (over 85%)');
  assert.equal(fmtDuration(45), '45s');
  assert.equal(fmtDuration(90), '1m 30s');
  assert.equal(fmtDuration(600), '10m');
  assert.equal(fmtDuration(5400), '1h 30m');
});
