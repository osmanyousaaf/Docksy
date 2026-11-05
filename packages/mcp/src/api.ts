/**
 * Minimal internal Docksy HTTP client for the MCP server.
 * Deliberately tiny: the full typed client lives in @crovenai/docksy-client.
 */

export interface ApiOptions {
  /** Docksy base URL, e.g. https://docksy.example.com (with or without /api/v1). */
  url: string;
  /** API token (dsk_…). */
  token: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Per-request timeout. Default 30s. */
  timeoutMs?: number;
  userAgent?: string;
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export class DocksyApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'DocksyApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Normalizes "https://x.com/", "https://x.com/api/v1" → "https://x.com/api/v1". */
export function apiBase(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (!/\/api\/v1$/.test(u)) u += '/api/v1';
  return u;
}

export function buildPath(path: string, query?: Query): string {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}${path.includes('?') ? '&' : '?'}${s}` : path;
}

/** Encodes one path segment (ids, names). */
export const seg = (v: string): string => encodeURIComponent(v);

export class DocksyApi {
  readonly base: string;
  /** Web UI origin, for links in tool output. */
  readonly origin: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(o: ApiOptions) {
    this.base = apiBase(o.url);
    this.origin = this.base.replace(/\/api\/v1$/, '');
    this.token = o.token;
    this.fetchImpl = o.fetch ?? globalThis.fetch;
    this.timeoutMs = o.timeoutMs ?? 30_000;
    this.userAgent = o.userAgent ?? 'docksy-mcp';
  }

  async request<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const url = this.base + buildPath(path, opts.query);
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.userAgent,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      const why = e instanceof Error ? (e.name === 'TimeoutError' ? `timed out after ${this.timeoutMs}ms` : e.message) : String(e);
      throw new DocksyApiError(0, 'network_error', `Couldn't reach Docksy at ${this.origin} (${why}). Is DOCKSY_URL right and is Docksy running?`);
    }
    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const err = (data && typeof data === 'object' && 'error' in data ? (data as { error: unknown }).error : null) as
        | { code?: string; message?: string; details?: unknown }
        | null;
      const code = err?.code ?? httpCode(res.status);
      const message = err?.message ?? (typeof data === 'string' && data ? data.slice(0, 300) : res.statusText || `HTTP ${res.status}`);
      throw new DocksyApiError(res.status, code, message, err?.details);
    }
    return data as T;
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, { query });
  }
  post<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>('POST', path, { body: body ?? {}, query });
  }
  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { body });
  }
  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, { body });
  }
  delete<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('DELETE', path, { query });
  }
}

function httpCode(status: number): string {
  switch (status) {
    case 400: return 'bad_request';
    case 401: return 'unauthorized';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 409: return 'conflict';
    case 429: return 'rate_limited';
    default: return status >= 500 ? 'server_error' : 'http_error';
  }
}

/** Human hint appended to API errors so Claude knows what to do next. */
export function errorHint(e: DocksyApiError): string {
  switch (e.status) {
    case 0: return 'Check that DOCKSY_URL points at a running Docksy instance.';
    case 401: return 'The token was rejected. Create a new one in Docksy → Settings → API tokens and set DOCKSY_TOKEN.';
    case 403: return 'This token is not allowed to do that (read-only tokens cannot make changes).';
    case 404: return 'Nothing matched. List the available items first (list_servers, list_apps, list_deployments…) and use an exact id or name.';
    case 409: return 'Docksy refused because of a conflict with current state; read the message and resolve it first.';
    case 429: return 'Rate limited; wait a moment before retrying.';
    default: return e.status >= 500 ? 'Docksy hit an internal error. Retry once; if it persists, check the Docksy server logs.' : '';
  }
}
