/**
 * ANSI-safe log rendering helpers (pure). We never inject HTML: lines are split into
 * text segments with a small set of style flags, rendered by React as plain text.
 * SGR colour codes are honoured; every other escape/control sequence is dropped.
 */

export interface AnsiSegment {
  text: string;
  fg?: number; // 0-7 normal, 8-15 bright
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

interface State { fg?: number; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean }

// CSI ... final byte, OSC ... BEL/ST, other two-char escapes
// eslint-disable-next-line no-control-regex
const ESC_RE = /\x1b\[([0-9;?]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Remove every escape sequence and control char (keeps \t). */
export function stripAnsi(s: string): string {
  return s.replace(ESC_RE, '').replace(/\r(?!$)/g, '').replace(CTRL_RE, '');
}

function applySgr(st: State, params: string): State {
  const codes = params === '' ? [0] : params.split(';').map((p) => (p === '' ? 0 : Number(p)));
  let s: State = { ...st };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) s = {};
    else if (c === 1) s.bold = true;
    else if (c === 2) s.dim = true;
    else if (c === 3) s.italic = true;
    else if (c === 4) s.underline = true;
    else if (c === 22) { s.bold = false; s.dim = false; }
    else if (c === 23) s.italic = false;
    else if (c === 24) s.underline = false;
    else if (c >= 30 && c <= 37) s.fg = c - 30;
    else if (c >= 90 && c <= 97) s.fg = c - 90 + 8;
    else if (c === 39) s.fg = undefined;
    else if (c === 38 || c === 48) {
      // 256-colour / truecolour: map 256-colour 0-15 directly, skip the rest
      if (codes[i + 1] === 5) {
        const n = codes[i + 2];
        if (c === 38 && n !== undefined && n < 16) s.fg = n;
        i += 2;
      } else if (codes[i + 1] === 2) i += 4;
    }
  }
  return s;
}

/** Split one log line into styled segments. Safe for any input. */
export function parseAnsi(line: string): AnsiSegment[] {
  const out: AnsiSegment[] = [];
  let st: State = {};
  let last = 0;
  const push = (text: string) => {
    const clean = text.replace(/\r(?!$)/g, '').replace(CTRL_RE, '');
    if (!clean) return;
    const prev = out[out.length - 1];
    if (prev && prev.fg === st.fg && !!prev.bold === !!st.bold && !!prev.dim === !!st.dim && !!prev.italic === !!st.italic && !!prev.underline === !!st.underline) {
      prev.text += clean;
      return;
    }
    const seg: AnsiSegment = { text: clean };
    if (st.fg !== undefined) seg.fg = st.fg;
    if (st.bold) seg.bold = true;
    if (st.dim) seg.dim = true;
    if (st.italic) seg.italic = true;
    if (st.underline) seg.underline = true;
    out.push(seg);
  };
  ESC_RE.lastIndex = 0;
  for (let m = ESC_RE.exec(line); m; m = ESC_RE.exec(line)) {
    push(line.slice(last, m.index));
    if (m[2] === 'm') st = applySgr(st, m[1]);
    last = m.index + m[0].length;
  }
  push(line.slice(last));
  return out;
}

/** Tailwind-free colour palette for the 16 ANSI colours (tuned for the dark terminal background). */
export const ANSI_COLORS = [
  '#6b7280', '#f87171', '#34d399', '#fbbf24', '#60a5fa', '#c084fc', '#22d3ee', '#e5e7eb',
  '#9ca3af', '#fca5a5', '#6ee7b7', '#fde68a', '#93c5fd', '#d8b4fe', '#67e8f9', '#ffffff',
];

/** Heuristic level for colouring plain (non-ANSI) lines. */
export function lineLevel(line: string): 'error' | 'warn' | 'step' | null {
  const l = stripAnsi(line);
  if (/^::step::/.test(l) || /^(=+>|-->|#\d+ \[|Step \d+\/\d+)/.test(l)) return 'step';
  if (/\b(error|fatal|panic|exception|failed|killed)\b/i.test(l)) return 'error';
  if (/\b(warn|warning|deprecated)\b/i.test(l)) return 'warn';
  return null;
}
