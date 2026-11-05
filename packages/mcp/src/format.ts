/** Pure text formatters for MCP tool output (markdown tables, sparklines, units). */

const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** Downsamples by averaging buckets so the result has at most `width` values. */
export function downsample(values: number[], width: number): number[] {
  const v = values.filter((x) => Number.isFinite(x));
  if (width <= 0) return [];
  if (v.length <= width) return v;
  const out: number[] = [];
  const size = v.length / width;
  for (let i = 0; i < width; i++) {
    const from = Math.floor(i * size);
    const to = Math.max(from + 1, Math.floor((i + 1) * size));
    let sum = 0;
    for (let j = from; j < to; j++) sum += v[j];
    out.push(sum / (to - from));
  }
  return out;
}

/**
 * Renders a sparkline. With `max` set (e.g. 100 for percentages) bars are absolute,
 * otherwise scaled between the series' own min and max.
 */
export function sparkline(values: number[], opts: { width?: number; min?: number; max?: number } = {}): string {
  const v = downsample(values, opts.width ?? 40);
  if (v.length === 0) return '';
  const lo = opts.min ?? (opts.max !== undefined ? 0 : Math.min(...v));
  const hi = opts.max ?? Math.max(...v);
  const span = hi - lo;
  return v
    .map((x) => {
      // Flat series: show a mid bar for non-zero values so it doesn't read as "idle".
      if (!(span > 0)) return x > 0 ? BARS[3] : BARS[0];
      const t = Math.min(1, Math.max(0, (x - lo) / span));
      return BARS[Math.min(BARS.length - 1, Math.round(t * (BARS.length - 1)))];
    })
    .join('');
}

export interface Stats { current: number | null; avg: number | null; max: number | null; min: number | null }

export function stats(values: number[]): Stats {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length === 0) return { current: null, avg: null, max: null, min: null };
  let sum = 0;
  let max = -Infinity;
  let min = Infinity;
  for (const x of v) {
    sum += x;
    if (x > max) max = x;
    if (x < min) min = x;
  }
  return { current: v[v.length - 1], avg: sum / v.length, max, min };
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let x = Math.abs(n);
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  const s = i === 0 ? String(Math.round(x)) : x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
  return `${n < 0 ? '-' : ''}${s} ${units[i]}`;
}

export const rate = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : `${bytes(n)}/s`);

export function pct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

/** used/total as a 0–100 percentage, or null when total is unknown. */
export function ratio(used: number | null | undefined, total: number | null | undefined): number | null {
  if (!used && used !== 0) return null;
  if (!total) return null;
  return (used / total) * 100;
}

export function num(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}

/** "3m ago", "2h ago", "in 5s". */
export function ago(isoTs: string | null | undefined, now = Date.now()): string {
  if (!isoTs) return 'never';
  const t = Date.parse(isoTs);
  if (!Number.isFinite(t)) return isoTs;
  const d = Math.round((now - t) / 1000);
  const abs = Math.abs(d);
  const s =
    abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.floor(abs / 60)}m` : abs < 86400 ? `${Math.floor(abs / 3600)}h` : `${Math.floor(abs / 86400)}d`;
  return d >= 0 ? `${s} ago` : `in ${s}`;
}

export function duration(fromIso: string | null | undefined, toIso: string | null | undefined): string {
  if (!fromIso) return '—';
  const a = Date.parse(fromIso);
  const b = toIso ? Date.parse(toIso) : Date.now();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '—';
  const s = Math.max(0, Math.round((b - a) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** Escapes a value for a markdown table cell. */
export function cell(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function table(headers: string[], rows: unknown[][]): string {
  if (rows.length === 0) return '_none_';
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${headers.map((_, i) => cell(r[i])).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

/** A 10-char usage bar, e.g. "██████░░░░". */
export function bar(percent: number | null | undefined, width = 10): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return '░'.repeat(width);
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… (truncated ${s.length - max} chars)`;
}

/** Keeps the last `max` chars of a log, cutting at a line boundary. */
export function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(s.length - max);
  const nl = cut.indexOf('\n');
  return `… (${s.length - max} earlier chars omitted)\n${nl >= 0 ? cut.slice(nl + 1) : cut}`;
}

export function fence(s: string, lang = ''): string {
  const body = s.replace(/```/g, '`​``');
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

/** Compact JSON for inline args like `restart_app {"appId":"web"}`. */
export const inlineJson = (v: unknown): string => JSON.stringify(v ?? {});
