// @ts-nocheck — run with `node --test apps/web/src/features/apps/*.test.ts` (not part of the web tsconfig types)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRows, parseDotenv, toDotenv, validateRows } from './env.ts';

test('parseDotenv handles comments, export, quotes and inline comments', () => {
  const v = parseDotenv([
    '# comment',
    '',
    'export A=1',
    'B = two words # trailing',
    'C="quoted # not a comment"',
    "D='single'",
    'E="line1\\nline2"',
    'F=postgres://u:p@h:5432/db?x=1',
    'G=',
    '1BAD=x',
    'noequals',
    'H="multi',
    'line"',
  ].join('\r\n'));
  assert.deepEqual(v, { A: '1', B: 'two words', C: 'quoted # not a comment', D: 'single', E: 'line1\nline2', F: 'postgres://u:p@h:5432/db?x=1', G: '', H: 'multi\nline' });
});

test('toDotenv round-trips', () => {
  const vars = { A: 'plain', B: 'has space', C: 'quo"te', D: 'multi\nline', E: '' };
  assert.deepEqual(parseDotenv(toDotenv(vars)), vars);
});

test('mergeRows updates in place and appends, dropping empty rows', () => {
  const rows = mergeRows([{ key: 'A', value: '1' }, { key: '', value: '' }, { key: 'B', value: '2' }], { B: 'x', C: '3' });
  assert.deepEqual(rows, [{ key: 'A', value: '1' }, { key: 'B', value: 'x' }, { key: 'C', value: '3' }]);
});

test('validateRows flags invalid and duplicate keys', () => {
  const e = validateRows([{ key: 'A', value: '' }, { key: '9X', value: '' }, { key: 'A', value: '' }, { key: '', value: 'orphan' }, { key: '', value: '' }]);
  assert.deepEqual(Object.keys(e).map(Number), [1, 2, 3]);
});
