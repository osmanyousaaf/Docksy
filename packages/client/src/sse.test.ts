import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SseParser } from './sse.ts';
import { render, SHARED_PATH, TYPES_PATH } from '../scripts/sync-types.mjs';

test('parses events, ignores comments, joins multi-line data', () => {
  const p = new SseParser();
  const evs = p.push(': ping\n\nevent: log\ndata: {"line":"a"}\n\ndata: first\ndata: second\nid: 7\n\n');
  assert.deepEqual(evs, [
    { event: 'log', data: { line: 'a' } },
    { event: 'message', data: 'first\nsecond', id: '7' },
  ]);
});

test('handles CRLF, lone CR and chunks split anywhere', () => {
  const p = new SseParser();
  const input = 'event: status\r\ndata: {"status":"failed"}\r\n\r\nevent: log\rdata: 42\r\r';
  const out = [];
  for (const ch of input) out.push(...p.push(ch));
  out.push(...p.end()); // a trailing lone CR is only resolved once the stream ends
  assert.deepEqual(out, [
    { event: 'status', data: { status: 'failed' } },
    { event: 'log', data: 42 },
  ]);
});

test('field without colon, no space after colon, and event without data', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('event: noop\n\ndata:x\n\ndata\n\n'), [
    { event: 'message', data: 'x' },
    { event: 'message', data: '' },
  ]);
});

test('end() flushes an unterminated event', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('event: log\ndata: {"a":1}'), []);
  assert.deepEqual(p.end(), [{ event: 'log', data: { a: 1 } }]);
});

test('types.ts is an up-to-date copy of @docksy/shared (run scripts/sync-types.mjs)', () => {
  const expected = render(readFileSync(SHARED_PATH, 'utf8'));
  assert.equal(readFileSync(TYPES_PATH, 'utf8'), expected);
});
