import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  bar, formatBytes, formatDuration, formatPercent, padEnd, padStart, pct, resample, sparkline, stripAnsi, table, timeAgo,
  truncate, usageBar, visibleWidth,
} from './format.ts';

const RED = '\x1b[31m';
const RESET = '\x1b[39m';

describe('ANSI-aware text', () => {
  test('stripAnsi and visibleWidth ignore color codes', () => {
    assert.equal(stripAnsi(`${RED}hi${RESET}`), 'hi');
    assert.equal(visibleWidth(`${RED}hello${RESET}`), 5);
    assert.equal(visibleWidth('█▌░'), 3);
    assert.equal(visibleWidth('日本'), 4);
  });
  test('pad respects visible width', () => {
    assert.equal(stripAnsi(padEnd(`${RED}ab${RESET}`, 4)), 'ab  ');
    assert.equal(padStart('7', 3), '  7');
    assert.equal(padEnd('toolong', 3), 'toolong');
  });
  test('truncate adds an ellipsis and keeps color codes balanced', () => {
    assert.equal(truncate('abcdefgh', 5), 'abcd…');
    assert.equal(truncate('abc', 5), 'abc');
    const t = truncate(`${RED}abcdefgh${RESET}`, 4);
    assert.equal(stripAnsi(t), 'abc…');
    assert.ok(t.endsWith('\x1b[0m'));
    assert.equal(truncate('abc', 0), '');
  });
});

describe('numbers', () => {
  test('formatBytes', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(10 * 1024 * 1024), '10 MB');
    assert.equal(formatBytes(8 * 1024 ** 3 - 1), '8.0 GB');
    assert.equal(formatBytes(3.5 * 1024 ** 4), '3.5 TB');
    assert.equal(formatBytes(2048, { perSec: true }), '2.0 KB/s');
    assert.equal(formatBytes(null), '–');
    assert.equal(formatBytes(-2048), '-2.0 KB');
  });
  test('formatPercent', () => {
    assert.equal(formatPercent(42.37), '42%');
    assert.equal(formatPercent(4.21), '4.2%');
    assert.equal(formatPercent(0), '0%');
    assert.equal(formatPercent(100), '100%');
    assert.equal(formatPercent(undefined), '–');
  });
  test('pct clamps and handles unknown totals', () => {
    assert.equal(pct(50, 200), 25);
    assert.equal(pct(300, 200), 100);
    assert.equal(pct(5, 0), null);
    assert.equal(pct(null, 10), null);
  });
  test('formatDuration and timeAgo', () => {
    assert.equal(formatDuration(7), '7s');
    assert.equal(formatDuration(125), '2m 5s');
    assert.equal(formatDuration(3600), '1h');
    assert.equal(formatDuration(93784), '1d 2h');
    assert.equal(formatDuration(-1), '–');
    const now = Date.parse('2026-01-01T12:00:00Z');
    assert.equal(timeAgo('2026-01-01T11:55:00Z', now), '5m ago');
    assert.equal(timeAgo('2026-01-01T11:59:58Z', now), 'just now');
    assert.equal(timeAgo('2025-12-30T12:00:00Z', now), '2d ago');
    assert.equal(timeAgo('2026-01-01T14:00:00Z', now), 'in 2h');
    assert.equal(timeAgo(null, now), 'never');
  });
});

describe('bars', () => {
  test('full, empty and partial cells', () => {
    assert.equal(bar(0, 4), '░░░░');
    assert.equal(bar(100, 4), '████');
    assert.equal(bar(50, 4), '██░░');
    assert.equal(bar(56.25, 4), '██▎░'); // 2.25 cells
    assert.equal(bar(150, 3), '███');
    assert.equal(bar(null, 3), '░░░');
    assert.equal(bar(50, 0), '');
  });
  test('every width is exact', () => {
    for (let p = 0; p <= 100; p += 3.7) for (const w of [1, 5, 10, 23]) assert.equal(bar(p, w).length, w, `p=${p} w=${w}`);
  });
  test('usageBar adds a percent label', () => {
    const s = stripAnsi(usageBar(45, 10));
    assert.equal(s, '████▌░░░░░  45%');
    assert.equal(stripAnsi(usageBar(45, 10, { label: false })), '████▌░░░░░');
  });
});

describe('sparklines', () => {
  test('auto-scaled ramp uses the full range', () => {
    assert.equal(sparkline([0, 1, 2, 3, 4, 5, 6, 7]), '▁▂▃▄▅▆▇█');
  });
  test('fixed scale for percents', () => {
    assert.equal(sparkline([0, 50, 100], { min: 0, max: 100 }), '▁▅█');
    assert.equal(sparkline([200, -5], { min: 0, max: 100 }), '█▁');
  });
  test('missing values are blanks, flat series are low', () => {
    assert.equal(sparkline([1, null, 3]), '▁ █');
    assert.equal(sparkline([5, 5, 5]), '▁▁▁');
    assert.equal(sparkline([]), '');
    assert.equal(sparkline([null, null]), '  ');
  });
  test('width downsamples by averaging', () => {
    const s = sparkline(Array.from({ length: 100 }, (_, i) => i), { width: 10 });
    assert.equal(s.length, 10);
    assert.equal(s[0], '▁');
    assert.equal(s[9], '█');
    assert.deepEqual(resample([1, 3, 5, 7], 2), [2, 6]);
    assert.deepEqual(resample([null, null, 4, 6], 2), [null, 5]);
  });
});

describe('table', () => {
  test('aligns columns, right-aligns numbers, uppercases headers', () => {
    const out = stripAnsi(table(
      [{ header: 'Name' }, { header: 'Count', align: 'right' }, { header: 'Note' }],
      [['web', '3', 'ok'], ['database', '12', '']],
    ));
    assert.deepEqual(out.split('\n'), [
      'NAME      COUNT  NOTE',
      'web           3  ok',
      'database     12',
    ]);
  });
  test('aligns colored cells by visible width', () => {
    const out = table([{ header: 'A' }, { header: 'B' }], [[`${RED}x${RESET}`, 'y'], ['long', 'z']]);
    const lines = stripAnsi(out).split('\n');
    assert.equal(lines[1].indexOf('y'), lines[2].indexOf('z'));
  });
  test('shrinks flex columns to fit the width', () => {
    const out = stripAnsi(table(
      [{ header: 'Id' }, { header: 'Description', flex: true }],
      [['1', 'a very long description that does not fit']],
      { width: 30 },
    ));
    for (const l of out.split('\n')) assert.ok(visibleWidth(l) <= 30, l);
    assert.ok(out.includes('…'));
  });
  test('indent and no header', () => {
    assert.equal(stripAnsi(table([{ header: 'x' }], [['a']], { indent: 2, header: false })), '  a');
  });
});
