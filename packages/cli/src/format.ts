/** Terminal formatting helpers: bars, sparklines, bytes, durations, ANSI-aware tables. */
import pc from 'picocolors';

// ───────────────────────────── ANSI-aware text ─────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Visible width in terminal cells (ANSI codes removed, combining marks ignored, wide CJK/emoji count 2). */
export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0)!);
  return w;
}

function charWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

export function padEnd(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

export function padStart(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : ' '.repeat(width - w) + s;
}

/** Truncate to `width` visible cells, appending "…". Keeps ANSI codes and resets styling when cut. */
export function truncate(s: string, width: number): string {
  if (width <= 0) return '';
  if (visibleWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  let cut = false;
  const parts = s.split(/(\x1b\[[0-9;?]*[ -/]*[@-~])/);
  for (const part of parts) {
    if (part.startsWith('\x1b[')) { out += part; continue; }
    for (const ch of part) {
      const cw = charWidth(ch.codePointAt(0)!);
      if (w + cw > width - 1) { cut = true; break; }
      out += ch;
      w += cw;
    }
    if (cut) break;
  }
  return out + '…' + (s.includes('\x1b[') ? '\x1b[0m' : '');
}

// ───────────────────────────── numbers ─────────────────────────────

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** 1536 → "1.5 KB" (base 1024). Values under 10 in a unit get one decimal. */
export function formatBytes(n: number | null | undefined, o: { perSec?: boolean } = {}): string {
  if (n == null || !Number.isFinite(n)) return '–';
  const neg = n < 0;
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) { v /= 1024; i++; }
  const num = i === 0 ? String(Math.round(v)) : v < 10 ? v.toFixed(1) : String(Math.round(v));
  return `${neg ? '-' : ''}${num} ${BYTE_UNITS[i]}${o.perSec ? '/s' : ''}`;
}

/** 42.37 → "42%", 4.21 → "4.2%". */
export function formatPercent(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '–';
  if (n !== 0 && Math.abs(n) < 10) return `${n.toFixed(1)}%`;
  return `${Math.round(n)}%`;
}

/** Percent of used/total, or null when total is unknown. */
export function pct(used: number | null | undefined, total: number | null | undefined): number | null {
  if (used == null || !total) return null;
  return Math.max(0, Math.min(100, (used / total) * 100));
}

/** 93784 → "1d 2h", 125 → "2m 5s", 7 → "7s". */
export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '–';
  const s = Math.floor(sec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return r ? `${m}m ${r}s` : `${m}m`;
  return `${r}s`;
}

/** ISO timestamp → "just now" / "5m ago" / "in 2h". */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '–';
  const diff = Math.round((now - t) / 1000);
  if (Math.abs(diff) < 5) return 'just now';
  const label = formatDuration(Math.abs(diff)).split(' ')[0];
  return diff > 0 ? `${label} ago` : `in ${label}`;
}

export function shortId(id: string | null | undefined, n = 8): string {
  return id ? id.slice(0, n) : '–';
}

// ───────────────────────────── bars + sparklines ─────────────────────────────

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/** Plain usage bar of `width` cells with 1/8-cell precision: bar(50, 4) → "██░░". */
export function bar(percent: number | null | undefined, width: number, empty = '░'): string {
  if (width <= 0) return '';
  const p = percent == null || !Number.isFinite(percent) ? 0 : Math.max(0, Math.min(100, percent));
  const eighths = Math.round((p / 100) * width * 8);
  const full = Math.floor(eighths / 8);
  const rem = eighths % 8;
  const filled = '█'.repeat(full) + EIGHTHS[rem];
  return filled + empty.repeat(width - full - (rem ? 1 : 0));
}

/** Threshold color for a usage percent: green < warn ≤ yellow < crit ≤ red. */
export function levelColor(percent: number | null | undefined, warn = 70, crit = 90): (s: string) => string {
  if (percent == null) return pc.dim;
  if (percent >= crit) return pc.red;
  if (percent >= warn) return pc.yellow;
  return pc.green;
}

/** Colored bar + right-aligned percent label: "████▌░░░░░  45%". */
export function usageBar(percent: number | null | undefined, width: number, o: { warn?: number; crit?: number; label?: boolean } = {}): string {
  const color = levelColor(percent, o.warn, o.crit);
  const plain = bar(percent, width);
  const split = plain.search(/░|$/);
  const s = color(plain.slice(0, split)) + pc.dim(plain.slice(split));
  return o.label === false ? s : `${s} ${color(padStart(formatPercent(percent), 4))}`;
}

const SPARKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * Unicode sparkline. `min`/`max` fix the scale (e.g. 0–100 for percents); otherwise it auto-scales.
 * With `width`, values are bucket-averaged down to that many cells (never stretched). Missing values render as spaces.
 */
export function sparkline(values: readonly (number | null | undefined)[], o: { width?: number; min?: number; max?: number } = {}): string {
  let vals = values.map((v) => (v == null || !Number.isFinite(v) ? null : v));
  if (o.width != null && o.width >= 0 && vals.length > o.width) vals = resample(vals, o.width);
  const nums = vals.filter((v): v is number => v != null);
  if (nums.length === 0) return ' '.repeat(vals.length);
  const lo = o.min ?? Math.min(...nums);
  const hi = o.max ?? Math.max(...nums);
  const span = hi - lo;
  return vals.map((v) => {
    if (v == null) return ' ';
    if (span <= 0) return o.max != null && v >= hi && hi > 0 ? SPARKS[7] : SPARKS[0];
    const i = Math.round(((Math.max(lo, Math.min(hi, v)) - lo) / span) * 7);
    return SPARKS[i];
  }).join('');
}

/** Average `vals` into `n` buckets (nulls ignored; an all-null bucket stays null). */
export function resample(vals: readonly (number | null)[], n: number): (number | null)[] {
  if (n <= 0) return [];
  if (vals.length <= n) return [...vals];
  const out: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * vals.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * vals.length) / n));
    let sum = 0, cnt = 0;
    for (let j = a; j < b; j++) { const v = vals[j]; if (v != null) { sum += v; cnt++; } }
    out.push(cnt ? sum / cnt : null);
  }
  return out;
}

// ───────────────────────────── tables ─────────────────────────────

export interface Column {
  header: string;
  align?: 'left' | 'right';
  /** This column shrinks (truncating with "…") when the table is wider than `width`; right-most flex columns shrink first. */
  flex?: boolean;
  /** Never wider than this. */
  max?: number;
}

/**
 * Aligned table. Cells may contain ANSI colors. Headers are dimmed and uppercased.
 * When `width` is given and the table is too wide, flex columns (or the widest column) are truncated.
 */
export function table(columns: Column[], rows: string[][], o: { width?: number; indent?: number; gap?: number; header?: boolean } = {}): string {
  const gap = o.gap ?? 2;
  const indent = ' '.repeat(o.indent ?? 0);
  const showHeader = o.header !== false;
  const widths = columns.map((c, i) => {
    let w = showHeader ? visibleWidth(c.header) : 0;
    for (const r of rows) w = Math.max(w, visibleWidth(r[i] ?? ''));
    return c.max ? Math.min(w, c.max) : w;
  });
  if (o.width) {
    const total = () => indent.length + widths.reduce((a, b) => a + b, 0) + gap * (columns.length - 1);
    let over = total() - o.width;
    // Shrink the right-most flex column first: the left-most column is usually the name people scan for.
    const flex = columns.map((c, i) => (c.flex ? i : -1)).filter((i) => i >= 0).reverse();
    const order = flex.length ? flex : [widths.indexOf(Math.max(...widths))];
    for (const i of order) {
      if (over <= 0) break;
      const min = Math.max(4, showHeader ? Math.min(visibleWidth(columns[i].header), 8) : 4);
      const cut = Math.min(over, widths[i] - min);
      if (cut > 0) { widths[i] -= cut; over -= cut; }
    }
  }
  const fmt = (cells: string[], style?: (s: string) => string) => {
    const parts = columns.map((c, i) => {
      let cell = cells[i] ?? '';
      if (visibleWidth(cell) > widths[i]) cell = truncate(cell, widths[i]);
      if (style) cell = style(cell);
      const last = i === columns.length - 1;
      if (c.align === 'right') return padStart(cell, widths[i]);
      return last ? cell : padEnd(cell, widths[i]);
    });
    return (indent + parts.join(' '.repeat(gap))).replace(/\s+$/, '');
  };
  const lines: string[] = [];
  if (showHeader) lines.push(fmt(columns.map((c) => c.header.toUpperCase()), (s) => pc.dim(s)));
  for (const r of rows) lines.push(fmt(r));
  return lines.join('\n');
}

// ───────────────────────────── status badges ─────────────────────────────

export function livenessDot(l: string | null | undefined): string {
  if (l === 'online') return pc.green('●');
  if (l === 'offline') return pc.red('●');
  return pc.dim('○');
}

/** Colors app, deployment, server, alert and uptime states consistently. */
export function statusColor(s: string | null | undefined): string {
  const v = s ?? 'unknown';
  switch (v) {
    case 'running': case 'succeeded': case 'ready': case 'online': case 'up': case 'passed': case 'operational': case 'resolved':
      return pc.green(v);
    case 'deploying': case 'building': case 'provisioning': case 'queued': case 'restarting': case 'pending': case 'created':
      return pc.cyan(v);
    case 'failed': case 'error': case 'offline': case 'down': case 'dead': case 'firing': case 'critical':
      return pc.red(v);
    case 'warning': case 'degraded': case 'paused':
      return pc.yellow(v);
    default:
      return pc.dim(v);
  }
}

export function severityBadge(s: string): string {
  if (s === 'critical') return pc.bold(pc.red('✖ CRITICAL'));
  if (s === 'warning') return pc.bold(pc.yellow('▲ WARNING'));
  return pc.bold(pc.cyan('● INFO'));
}

export const sym = {
  ok: pc.green('✔'),
  fail: pc.red('✖'),
  warn: pc.yellow('▲'),
  info: pc.cyan('ℹ'),
  arrow: pc.dim('→'),
  bullet: pc.dim('·'),
};

/** Brand mark used in headers. */
export const brand = (s = 'docksy') => pc.bold(pc.cyan('▲ ')) + pc.bold(s);
