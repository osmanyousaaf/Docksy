// @ts-nocheck — run with `node --test apps/web/src/features/apps/*.test.ts` (not part of the web tsconfig types)
import test from 'node:test';
import assert from 'node:assert/strict';
import { lineLevel, parseAnsi, stripAnsi } from './ansi.ts';

const E = '\x1b';

test('parseAnsi maps SGR colours and resets', () => {
  assert.deepEqual(parseAnsi(`${E}[31merror${E}[0m: boom`), [{ text: 'error', fg: 1 }, { text: ': boom' }]);
  assert.deepEqual(parseAnsi(`${E}[1;92mok${E}[22m!`), [{ text: 'ok', fg: 10, bold: true }, { text: '!', fg: 10 }]);
  assert.deepEqual(parseAnsi(`${E}[38;5;4mblue${E}[39m`), [{ text: 'blue', fg: 4 }]);
});

test('parseAnsi drops non-SGR escapes and control chars, keeps HTML as text', () => {
  assert.deepEqual(parseAnsi(`${E}[2K${E}[1Aprogress\x07 <b>x</b>`), [{ text: 'progress <b>x</b>' }]);
  assert.deepEqual(parseAnsi(`${E}]0;title\x07hi`), [{ text: 'hi' }]);
  assert.deepEqual(parseAnsi(''), []);
});

test('stripAnsi and lineLevel', () => {
  assert.equal(stripAnsi(`${E}[33mwarn${E}[0m slow`), 'warn slow');
  assert.equal(lineLevel('npm ERR! fatal: thing'), 'error');
  assert.equal(lineLevel('Warning: deprecated'), 'warn');
  assert.equal(lineLevel('::step:: Building'), 'step');
  assert.equal(lineLevel('GET / 200'), null);
});
