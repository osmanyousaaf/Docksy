/**
 * .env helpers for the web UI (pure, no React). Used by the env editor and the new-app flow.
 */

export interface EnvRow { key: string; value: string }

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** True when `k` is a usable environment variable name. */
export const isValidEnvKey = (k: string) => KEY_RE.test(k);

/**
 * Parse dotenv text. Supports `export K=V`, `#` comments, blank lines,
 * single/double quotes (double quotes expand \n, \t, \", \\), inline ` # comments` on unquoted values,
 * and multi-line double/single-quoted values. Later keys win.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const src = text.replace(/\r\n?/g, '\n');
  let i = 0;
  while (i < src.length) {
    // read one logical line start
    let end = src.indexOf('\n', i);
    if (end === -1) end = src.length;
    let line = src.slice(i, end);
    i = end + 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    line = trimmed.replace(/^export\s+/, '');
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!isValidEnvKey(key)) continue;
    let rest = line.slice(eq + 1).replace(/^\s+/, '');
    const q = rest[0];
    if (q === '"' || q === "'" || q === '`') {
      // find closing quote, possibly across lines
      let body = rest.slice(1);
      let close = findClose(body, q);
      while (close === -1 && i < src.length) {
        let nEnd = src.indexOf('\n', i);
        if (nEnd === -1) nEnd = src.length;
        body += '\n' + src.slice(i, nEnd);
        i = nEnd + 1;
        close = findClose(body, q);
      }
      let value = close === -1 ? body : body.slice(0, close);
      if (q === '"') value = value.replace(/\\(n|t|r|"|\\)/g, (_, c) => ({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }[c as string] as string));
      out[key] = value;
    } else {
      const hash = rest.search(/\s#/);
      if (hash !== -1) rest = rest.slice(0, hash);
      out[key] = rest.trim();
    }
  }
  return out;
}

function findClose(s: string, q: string): number {
  for (let j = 0; j < s.length; j++) {
    if (s[j] === '\\' && q === '"') { j++; continue; }
    if (s[j] === q) return j;
  }
  return -1;
}

/** Serialize vars to dotenv text; quotes values that need it. */
export function toDotenv(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([k, v]) => `${k}=${/^[A-Za-z0-9_./:@%+,-]*$/.test(v) ? v : `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`}`)
    .join('\n');
}

export const rowsToVars = (rows: EnvRow[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (k) out[k] = r.value;
  }
  return out;
};

export const varsToRows = (vars: Record<string, string>): EnvRow[] => Object.entries(vars).map(([key, value]) => ({ key, value }));

/** Merge parsed vars into rows: existing keys are updated in place, new keys appended. */
export function mergeRows(rows: EnvRow[], vars: Record<string, string>): EnvRow[] {
  const next = rows.filter((r) => r.key.trim() || r.value);
  const idx = new Map(next.map((r, i) => [r.key.trim(), i]));
  for (const [k, v] of Object.entries(vars)) {
    const at = idx.get(k);
    if (at !== undefined) next[at] = { key: k, value: v };
    else { idx.set(k, next.length); next.push({ key: k, value: v }); }
  }
  return next;
}

/** Problems in rows: invalid or duplicate keys. Returns a message per row index. */
export function validateRows(rows: EnvRow[]): Record<number, string> {
  const errs: Record<number, string> = {};
  const seen = new Map<string, number>();
  rows.forEach((r, i) => {
    const k = r.key.trim();
    if (!k) { if (r.value) errs[i] = 'Name is required'; return; }
    if (!isValidEnvKey(k)) errs[i] = 'Use letters, digits and _ (not starting with a digit)';
    else if (seen.has(k)) errs[i] = 'Duplicate name';
    seen.set(k, i);
  });
  return errs;
}
