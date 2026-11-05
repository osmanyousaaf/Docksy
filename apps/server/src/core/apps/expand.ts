import { randomInt, createHmac } from 'node:crypto';
import { safeEqual } from '../../lib/crypto.ts';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** N cryptographically random alphanumerics (uniform; randomInt avoids modulo bias). */
export function randomAlnum(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += ALNUM[randomInt(ALNUM.length)];
  return out;
}

const RANDOM_RE = /\{\{\s*random:(\d{1,3})\s*\}\}/g;
const DOMAIN_RE = /\{\{\s*domain\s*\}\}/g;

/** Resolve `{{random:N}}` (1–256, fresh per occurrence) and `{{domain}}` in a single value. */
export function expandValue(value: string, ctx: { domain: string | null }): string {
  return value
    .replace(RANDOM_RE, (_m, n: string) => randomAlnum(Math.min(Math.max(Number(n), 1), 256)))
    .replace(DOMAIN_RE, ctx.domain ?? 'localhost');
}

export function expandEnv(env: Record<string, string>, ctx: { domain: string | null }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) out[k] = expandValue(String(v), ctx);
  return out;
}

/** Verify a GitHub `X-Hub-Signature-256: sha256=<hex>` header against the raw request body. */
export function verifyGithubSignature(secret: string, rawBody: string, header: string | null | undefined): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return safeEqual(expected, header.trim().toLowerCase());
}

/** Turn `owner/repo` shorthand into a GitHub https URL; leave full URLs alone. */
export function normalizeRepoUrl(input: string): string {
  const s = input.trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) return `https://github.com/${s.replace(/\.git$/, '')}.git`;
  return s;
}
