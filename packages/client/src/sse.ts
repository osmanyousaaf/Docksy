/** A single Server-Sent Event. `data` is JSON-parsed when it looks like JSON, otherwise the raw string. */
export interface SseEvent<T = unknown> {
  event: string;
  data: T;
  id?: string;
}

/**
 * Incremental SSE parser (WHATWG event-stream format).
 * Feed it decoded text chunks; it returns the events completed by that chunk.
 * Comment lines (": ping") are ignored, multi-line `data:` fields are joined with "\n".
 */
export class SseParser {
  private buf = '';
  private event = '';
  private data: string[] = [];
  private id: string | undefined;
  private lastId: string | undefined;

  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buf);
      if (!m) break;
      // A lone trailing "\r" may be the first half of "\r\n": wait for more input.
      if (m[0] === '\r' && m.index === this.buf.length - 1) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  /** Flush a final event that was not terminated by a blank line (stream ended). */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buf) {
      const ev = this.line(this.buf);
      this.buf = '';
      if (ev) out.push(ev);
    }
    const ev = this.dispatch();
    if (ev) out.push(ev);
    return out;
  }

  private line(line: string): SseEvent | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    let value = i === -1 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id' && !value.includes('\0')) this.id = value;
    return null;
  }

  private dispatch(): SseEvent | null {
    if (this.id !== undefined) this.lastId = this.id;
    this.id = undefined;
    if (this.data.length === 0) {
      this.event = '';
      return null;
    }
    const raw = this.data.join('\n');
    const ev: SseEvent = { event: this.event || 'message', data: parseData(raw) };
    if (this.lastId !== undefined) ev.id = this.lastId;
    this.event = '';
    this.data = [];
    return ev;
  }
}

function parseData(raw: string): unknown {
  if (raw === '') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}
