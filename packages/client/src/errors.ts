/**
 * Every failure from DocksyClient is a DocksyApiError.
 * - HTTP errors carry the server's ApiError `code`/`message`/`details` and the HTTP `status`.
 * - Transport failures use status 0 with code `network_error` or `timeout`; `aborted` when the caller's signal fired.
 */
export class DocksyApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly method: string;
  readonly path: string;

  constructor(o: { status: number; code: string; message: string; details?: unknown; method: string; path: string; cause?: unknown }) {
    super(o.message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = 'DocksyApiError';
    this.status = o.status;
    this.code = o.code;
    this.details = o.details;
    this.method = o.method;
    this.path = o.path;
  }

  get isNotFound(): boolean { return this.status === 404; }
  get isUnauthorized(): boolean { return this.status === 401; }
  get isForbidden(): boolean { return this.status === 403; }
  get isNetworkError(): boolean { return this.status === 0; }
}

export function isDocksyApiError(e: unknown): e is DocksyApiError {
  return e instanceof DocksyApiError;
}
