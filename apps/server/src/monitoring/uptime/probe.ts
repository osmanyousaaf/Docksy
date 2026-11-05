import { config } from '../../config.ts';
import { isExpectedStatus } from './stats.ts';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ProbeTarget { url: string; timeoutMs: number; expectedStatus: number }
export interface ProbeResult { ok: boolean; statusCode: number | null; latencyMs: number | null; error: string | null }

const USER_AGENT = `Docksy-Uptime/${config.version} (+https://github.com/osmanyousaaf/docksy)`;

/** One HTTP check: GET, follows redirects, latency = time to response headers. Never throws. */
export async function probe(t: ProbeTarget, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<ProbeResult> {
  const started = performance.now();
  try {
    const res = await fetchImpl(t.url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(t.timeoutMs),
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
    });
    const latencyMs = Math.round(performance.now() - started);
    try { await res.body?.cancel(); } catch { /* body already consumed or closed */ }
    const ok = isExpectedStatus(res.status, t.expectedStatus);
    const error = ok ? null : t.expectedStatus ? `Expected HTTP ${t.expectedStatus}, got ${res.status}` : `HTTP ${res.status}`;
    return { ok, statusCode: res.status, latencyMs, error };
  } catch (e) {
    return { ok: false, statusCode: null, latencyMs: null, error: describeFetchError(e, t.timeoutMs) };
  }
}

/** Turn undici's "fetch failed" into something useful, e.g. "ENOTFOUND: getaddrinfo ENOTFOUND example.com". */
export function describeFetchError(e: unknown, timeoutMs: number): string {
  const err = e as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string } } | null;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `Timed out after ${timeoutMs}ms`;
  const code = err?.cause?.code ?? err?.code;
  const msg = err?.cause?.message ?? err?.message ?? String(e);
  const text = code && !msg.includes(code) ? `${code}: ${msg}` : msg;
  return text.slice(0, 300);
}
