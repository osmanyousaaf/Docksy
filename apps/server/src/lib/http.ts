import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodType } from 'zod';
import type { User, TokenScope } from '@docksy/shared';
import { db } from '../db/index.ts';

/** Hono env used by every router: new Hono<AppEnv>() */
export type AppEnv = {
  Variables: {
    user: User;
    /** 'session' for browser cookie, otherwise the API token's scope */
    authKind: 'session' | TokenScope;
    /** "user:<email>" or "token:<name>" — use for activity log */
    actor: string;
  };
};

export class HttpError extends Error {
  status: ContentfulStatusCode;
  code: string;
  details?: unknown;
  constructor(status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);

/** Parse + validate JSON body with zod; throws 400 with zod issues. */
export async function body<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw badRequest('Body must be JSON'); }
  const r = schema.safeParse(raw);
  if (!r.success) throw badRequest('Validation failed', r.error.issues);
  return r.data;
}

/** Register as app.onError(errorHandler). Emits ApiError JSON. */
export function errorHandler(err: Error, c: Context) {
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  }
  if (err.name === 'SshConnectError') {
    return c.json({ error: { code: 'server_unreachable', message: err.message } }, 502);
  }
  console.error('[docksy] unhandled error', err);
  return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
}

/** Write an activity log entry. */
export function logActivity(actor: string, action: string, targetType?: string | null, targetId?: string | null, detail?: string | null): void {
  db.prepare('INSERT INTO activity (ts, actor, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Date.now(), actor, action, targetType ?? null, targetId ?? null, detail ?? null);
}

export type { MiddlewareHandler };
