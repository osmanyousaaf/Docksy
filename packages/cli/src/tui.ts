/** Tiny full-screen renderer: alternate screen, flicker-free redraws, clean exit on q / Ctrl-C. */
import type { Ctx, Out } from './context.ts';
import { truncate } from './format.ts';

const ESC = '\x1b[';
export const ansi = {
  altOn: `${ESC}?1049h`,
  altOff: `${ESC}?1049l`,
  hideCursor: `${ESC}?25l`,
  showCursor: `${ESC}?25h`,
  home: `${ESC}H`,
  clearLine: `${ESC}K`,
  clearDown: `${ESC}J`,
};

/** Build the escape sequence that paints `lines` over the previous frame without clearing (no flicker). */
export function frame(lines: string[], cols: number, rows: number): string {
  const visible = lines.slice(0, Math.max(1, rows));
  return ansi.home + visible.map((l) => truncate(l, cols) + ansi.clearLine).join('\n') + ansi.clearDown;
}

export interface LiveView {
  /** Render the current state into lines. Called on every redraw and on terminal resize. */
  render(size: { cols: number; rows: number }): string[];
  /** Start producing data; call `redraw()` when something changed. Stop when `signal` aborts. */
  run(redraw: () => void, signal: AbortSignal): Promise<void> | void;
}

/**
 * Run a live view until the user presses q / Esc / Ctrl-C (or SIGTERM).
 * Always restores the terminal, even when the view throws.
 */
export async function runLive(ctx: Ctx, view: LiveView): Promise<void> {
  const out = ctx.stdout as Out & NodeJS.WriteStream;
  const ac = new AbortController();
  const size = () => ({ cols: out.columns || 100, rows: out.rows || 40 });
  let restored = false;
  let pending = false;
  const draw = () => {
    if (restored) return;
    const { cols, rows } = size();
    out.write(frame(view.render({ cols, rows }), cols, rows));
  };
  // Coalesce bursts of updates into one paint per tick.
  const redraw = () => {
    if (pending || restored) return;
    pending = true;
    setImmediate(() => { pending = false; draw(); });
  };
  const stdin = ctx.stdin;
  const onKey = (buf: Buffer) => {
    const k = buf.toString();
    if (k === 'q' || k === 'Q' || k === '\x03' || k === '\x1b') ac.abort();
  };
  const restore = () => {
    if (restored) return;
    restored = true;
    out.write(ansi.showCursor + ansi.altOff);
    if (stdin.isTTY && stdin.setRawMode) {
      stdin.setRawMode(false);
      stdin.removeListener('data', onKey);
      stdin.pause();
    }
  };
  const onSignal = () => ac.abort();
  const onResize = () => draw();

  out.write(ansi.altOn + ansi.hideCursor);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('exit', restore);
  out.on?.('resize', onResize);
  if (stdin.isTTY && stdin.setRawMode) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onKey);
  }
  const done = new Promise<void>((r) => ac.signal.addEventListener('abort', () => r(), { once: true }));
  try {
    draw();
    await Promise.race([Promise.resolve(view.run(redraw, ac.signal)), done]);
  } finally {
    ac.abort();
    restore();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('exit', restore);
    out.off?.('resize', onResize);
  }
}

/** Abortable sleep that resolves (never rejects) when aborted. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}
