import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { User, Role } from '@docksy/shared';
import { db, iso, now, type Row } from '../db/index.ts';
import { randomToken, sha256 } from './crypto.ts';
import { HttpError, type AppEnv } from './http.ts';
import { config } from '../config.ts';

export const SESSION_COOKIE = 'docksy_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export const toUser = (r: Row): User => ({
  id: r.id, email: r.email, name: r.name, role: r.role as Role, createdAt: iso(r.created_at)!,
});

export function createSession(c: Context, userId: string): void {
  const token = randomToken('dss_', 32);
  const t = now();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, t + SESSION_TTL_MS, t);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'Lax', path: '/', maxAge: SESSION_TTL_MS / 1000,
    secure: !config.dev && c.req.url.startsWith('https://'),
  });
}

export function destroySession(c: Context): void {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token));
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

type Resolved = { user: User; authKind: 'session' | 'full' | 'read'; actor: string };

/** Resolve the caller from session cookie or "Authorization: Bearer dsk_..." API token. */
export function resolveCaller(c: Context): Resolved | null {
  const auth = c.req.header('authorization');
  if (auth?.startsWith('Bearer dsk_')) {
    const tok = auth.slice(7).trim();
    const r = db.prepare(`SELECT t.id AS tid, t.name AS tname, t.scope, u.* FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`).get(sha256(tok)) as Row | undefined;
    if (!r) return null;
    db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now(), r.tid);
    return { user: toUser(r), authKind: r.scope === 'read' ? 'read' : 'full', actor: `token:${r.tname}` };
  }
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie) {
    const r = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`).get(sha256(cookie), now()) as Row | undefined;
    if (r) return { user: toUser(r), authKind: 'session', actor: `user:${r.email}` };
  }
  return null;
}

/** Require a logged-in user or API token. Read-scope tokens (and viewers) may only use GET/HEAD. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const who = resolveCaller(c);
  if (!who) throw new HttpError(401, 'unauthorized', 'Login or API token required');
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
  if (write && (who.authKind === 'read' || who.user.role === 'viewer')) {
    throw new HttpError(403, 'forbidden', 'This token or user is read-only');
  }
  c.set('user', who.user);
  c.set('authKind', who.authKind);
  c.set('actor', who.actor);
  await next();
};

/** Resolve the server for "Authorization: Bearer dsa_..." agent tokens. */
export function resolveAgent(c: Context): Row | null {
  const auth = c.req.header('authorization');
  if (!auth?.startsWith('Bearer dsa_')) return null;
  return (db.prepare('SELECT * FROM servers WHERE agent_token_hash = ?').get(sha256(auth.slice(7).trim())) as Row | undefined) ?? null;
}

/** Issue a fresh agent token for a server (stores hash). Returns plaintext. */
export function issueAgentToken(serverId: string): string {
  const tok = randomToken('dsa_', 32);
  db.prepare('UPDATE servers SET agent_token_hash = ?, updated_at = ? WHERE id = ?').run(sha256(tok), now(), serverId);
  return tok;
}
