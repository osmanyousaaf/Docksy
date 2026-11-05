import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketize, pickStep, resolutionFor, RANGE_SEC, MAX_POINTS, RANGES, isRange } from './downsample.ts';

test('range → stored resolution', () => {
  assert.equal(resolutionFor('15m'), 0);
  assert.equal(resolutionFor('1h'), 0);
  assert.equal(resolutionFor('6h'), 0);
  assert.equal(resolutionFor('24h'), 60);
  assert.equal(resolutionFor('7d'), 60);
  assert.equal(resolutionFor('30d'), 3600);
  assert.ok(isRange('7d'));
  assert.ok(!isRange('2h'));
});

test('pickStep keeps every range at or under 400 buckets, in whole base steps', () => {
  for (const r of RANGES) {
    const base = resolutionFor(r) || 10;
    const step = pickStep(RANGE_SEC[r], base);
    assert.equal(step % base, 0, `${r} step ${step} not a multiple of ${base}`);
    assert.ok(Math.floor(RANGE_SEC[r] / step) + 1 <= MAX_POINTS, `${r} → too many buckets with step ${step}`);
  }
  assert.equal(pickStep(900, 10), 10); // 15m raw: no downsampling needed
  assert.equal(pickStep(86_400, 60), 240); // 24h of minutes → 4-minute buckets
});

test('bucketize aggregates avg / max / sum / last per bucket', () => {
  const rows = [
    { ts: 0, a: 10, m: 5, s: 1, l: 1 },
    { ts: 500, a: 20, m: 9, s: 2, l: 2 },
    { ts: 999, a: 30, m: 7, s: 3, l: 3 },
    { ts: 1000, a: 1, m: 1, s: 1, l: 4 },
  ];
  const out = bucketize(rows, 1000, { a: 'avg', m: 'max', s: 'sum', l: 'last' });
  assert.deepEqual(out, [
    { ts: 0, a: 20, m: 9, s: 6, l: 3 },
    { ts: 1000, a: 1, m: 1, s: 1, l: 4 },
  ]);
});

test('bucketize caps a dense series at 400 points', () => {
  const rangeSec = RANGE_SEC['6h'];
  const rows = Array.from({ length: rangeSec / 10 }, (_, i) => ({ ts: 1_700_000_000_000 + i * 10_000, cpu: i % 100 }));
  const step = pickStep(rangeSec, 10);
  const out = bucketize(rows, step * 1000, { cpu: 'avg' });
  assert.ok(out.length <= MAX_POINTS, `got ${out.length}`);
  assert.ok(out.length >= MAX_POINTS - 50);
  assert.equal(bucketize([], 1000, { cpu: 'avg' }).length, 0);
});
