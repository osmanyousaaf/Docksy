import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DiagnoseReport, FleetOverview, MetricPoint, Server } from '@docksy/shared';
import { ago, bar, bytes, downsample, duration, pct, sparkline, stats, table, tail } from './format.ts';
import { renderDiagnose, renderMetrics, renderOverview, sortFindings } from './render.ts';
import { apiBase, buildPath } from './api.ts';

test('sparkline scales to min..max and respects width', () => {
  assert.equal(sparkline([0, 1, 2, 3, 4, 5, 6, 7]), '▁▂▃▄▅▆▇█');
  assert.equal(sparkline([]), '');
  assert.equal(sparkline([5, 5, 5]), '▄▄▄');
  assert.equal(sparkline([0, 0]), '▁▁');
  assert.equal(sparkline(Array.from({ length: 500 }, (_, i) => i), { width: 20 }).length, 20);
});

test('sparkline with absolute max (percentages)', () => {
  assert.equal(sparkline([0, 50, 100], { max: 100 }), '▁▅█');
  assert.equal(sparkline([10, 10], { max: 100 }), '▂▂');
});

test('downsample averages buckets', () => {
  assert.deepEqual(downsample([1, 3, 5, 7], 2), [2, 6]);
  assert.deepEqual(downsample([1, 2], 10), [1, 2]);
  assert.deepEqual(downsample([1, NaN, 3], 10), [1, 3]);
});

test('stats current/avg/max/min', () => {
  assert.deepEqual(stats([1, 5, 3]), { current: 3, avg: 3, max: 5, min: 1 });
  assert.deepEqual(stats([]), { current: null, avg: null, max: null, min: null });
});

test('units', () => {
  assert.equal(bytes(0), '0 B');
  assert.equal(bytes(1536), '1.50 KB');
  assert.equal(bytes(8 * 1024 ** 3), '8.00 GB');
  assert.equal(bytes(null), '—');
  assert.equal(pct(12.345), '12.3%');
  assert.equal(bar(50, 10), '█████░░░░░');
  assert.equal(bar(null, 4), '░░░░');
});

test('time formatting', () => {
  const now = Date.parse('2026-01-01T00:10:00Z');
  assert.equal(ago('2026-01-01T00:09:30Z', now), '30s ago');
  assert.equal(ago('2026-01-01T00:00:00Z', now), '10m ago');
  assert.equal(ago(null, now), 'never');
  assert.equal(duration('2026-01-01T00:00:00Z', '2026-01-01T00:01:05Z'), '1m05s');
});

test('table escapes pipes and newlines, shows dashes for empty', () => {
  const t = table(['a', 'b'], [['x|y', null], ['line\nbreak', 0]]);
  assert.equal(t, '| a | b |\n| --- | --- |\n| x\\|y | — |\n| line break | 0 |');
  assert.equal(table(['a'], []), '_none_');
});

test('tail keeps the end at a line boundary', () => {
  const s = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const t = tail(s, 30);
  assert.match(t, /line 99$/);
  assert.match(t, /^… \(/);
});

test('api base + query building', () => {
  assert.equal(apiBase('https://d.example.com/'), 'https://d.example.com/api/v1');
  assert.equal(apiBase('https://d.example.com/api/v1'), 'https://d.example.com/api/v1');
  assert.equal(buildPath('/apps', { serverId: 'a b', x: undefined, y: '' }), '/apps?serverId=a+b');
});

const pt = (cpu: number, mem: number): MetricPoint => ({
  ts: new Date().toISOString(), cpu, load1: 0.5, load5: 0.5, load15: 0.5, memUsed: mem, memTotal: 100, swapUsed: 0, diskUsed: 40, diskTotal: 100, netRx: 1024, netTx: 2048,
});

test('renderMetrics: sparklines and current/avg/max', () => {
  const { text, series } = renderMetrics({ serverId: 's1', range: '1h', stepSec: 10, points: [pt(10, 50), pt(30, 60), pt(20, 70)] }, 'prod');
  assert.match(text, /Metrics: prod \(last 1h, 3 points/);
  assert.match(text, /CPU\s+\S+\s+now\s+20\.0%\s+avg\s+20\.0%\s+max\s+30\.0%/);
  assert.match(text, /Memory\s+\S+\s+now\s+70\.0%/);
  const cpu = series.find((s) => s.key === 'cpu')!;
  assert.equal(cpu.spark.length, 3);
  assert.equal(cpu.stats.max, 30);
});

test('renderMetrics with no points explains why', () => {
  assert.match(renderMetrics({ serverId: 's1', range: '1h', stepSec: 10, points: [] }, 'prod').text, /No metrics/);
});

const server = { id: 's1', name: 'prod', host: '1.2.3.4', port: 22, sshUser: 'root', status: 'ready', liveness: 'online' } as Server;

test('renderOverview', () => {
  const o: FleetOverview = {
    servers: [{ server, latest: pt(42, 80), spark: [10, 20, 30], appsCount: 3, firingAlerts: 1 }],
    totals: { servers: 1, online: 1, apps: 3, runningContainers: 5, firingAlerts: 1 },
  };
  const t = renderOverview(o);
  assert.match(t, /1 server \(1 online\) · 3 apps · 5 running containers · 1 firing alert/);
  assert.match(t, /\| prod \| ready\/online \|/);
});

test('renderDiagnose groups by severity and lists next tool calls', () => {
  const r: DiagnoseReport = {
    generatedAt: new Date().toISOString(),
    scope: { serverId: 's1', appId: null },
    healthy: false,
    summary: '2 problems',
    findings: [
      { severity: 'warning', title: 'Disk 88% full', detail: 'Root disk is filling', evidence: ['/ 88%'], suggestion: 'Prune images' },
      { severity: 'critical', title: 'web is crash-looping', detail: '', evidence: ['12 restarts'], suggestion: 'Restart it', action: { tool: 'restart_app', args: { appId: 'web' } } },
    ],
    context: { server, latest: null, trend1h: { cpuAvg: 10, cpuMax: 20, memAvgPct: 50, memMaxPct: 60 }, firingAlerts: [], recentDeployments: [], containers: [], recentLogs: [] },
  };
  const sorted = { ...r, findings: sortFindings(r.findings) };
  assert.equal(sorted.findings[0].severity, 'critical');
  const t = renderDiagnose(sorted);
  assert.ok(t.indexOf('## CRITICAL') < t.indexOf('## WARNING'));
  assert.match(t, /1 critical · 1 warning/);
  assert.match(t, /1\. `restart_app \{"appId":"web"\}`/);
  assert.match(t, /Problems found/);
});
