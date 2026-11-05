/**
 * core-platform: auth (setup/login/logout/me), API tokens, settings, activity.
 * Routes are mounted per-route with requireUser so other modules' public routes stay public.
 */
import type { Context, Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { z } from 'zod';
import type { ActivityEntry, ApiToken, AuthState, CreateTokenResponse, TokenScope } from '@docksy/shared';
import { db, getSettings, iso, isoReq, newId, now, setSettings, tx, type Row } from '../../db/index.ts';
import { hashPassword, randomToken, sha256, verifyPassword } from '../../lib/crypto.ts';
import { HttpError, body, conflict, logActivity, notFound, type AppEnv } from '../../lib/http.ts';
import { createSession, destroySession, requireUser, resolveCaller, toUser } from '../../lib/auth.ts';

// ───────────────────────────── login rate limit ─────────────────────────────

export const LOGIN_LIMIT = 10;
export const LOGIN_WINDOW_MS = 60_000;
const attempts = new Map<string, number[]>();

/** Record a login attempt for `ip`. Returns seconds to wait if over the limit, else 0. */
export function hitLoginLimit(ip: string, t = Date.now()): number {
  const recent = (attempts.get(ip) ?? []).filter((x) => t - x < LOGIN_WINDOW_MS);
  if (recent.length >= LOGIN_LIMIT) {
    attempts.set(ip, recent);
    return Math.max(1, Math.ceil((recent[0]! + LOGIN_WINDOW_MS - t) / 1000));
  }
  recent.push(t);
  attempts.set(ip, recent);
  // Keep the map from growing without bound.
  if (attempts.size > 10_000) {
    for (const [k, v] of attempts) if (!v.some((x) => t - x < LOGIN_WINDOW_MS)) attempts.delete(k);
  }
  return 0;
}

/** Test helper. */
export function resetLoginLimits(): void {
  attempts.clear();
}

const isPrivateIp = (ip: string) =>
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|::ffff:(127|10|192\.168)\.)/i.test(ip);

/**
 * Client IP. Uses the socket address; X-Forwarded-For is only honoured when the socket peer is a
 * loopback/private address (i.e. a reverse proxy in front of Docksy), so it can't be spoofed from outside.
 */
export function clientIp(c: Context): string {
  let socketIp: string | undefined;
  try { socketIp = getConnInfo(c).remote.address; } catch { socketIp = undefined; }
  const xff = c.req.header('x-forwarded-for')?.split(',').map((s) => s.trim()).filter(Boolean);
  if ((!socketIp || isPrivateIp(socketIp)) && xff?.length) return xff[xff.length - 1]!;
  return socketIp ?? c.req.header('x-real-ip') ?? 'unknown';
}

// ───────────────────────────── schemas + mappers ─────────────────────────────

const email = z.string().trim().toLowerCase().pipe(z.email({ message: 'Enter a valid email address' }));
const SetupSchema = z.object({
  email,
  name: z.string().trim().min(1, 'Name is required').max(80),
  password: z.string().min(8, 'Use at least 8 characters').max(256),
});
const LoginSchema = z.object({ email, password: z.string().min(1).max(256) });
const TokenSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(64),
  scope: z.enum(['full', 'read']).optional(),
});

const publicUrl = z
  .string()
  .trim()
  .pipe(z.url({ protocol: /^https?$/, message: 'Must be an http(s) URL, e.g. https://docksy.example.com' }))
  .refine((u) => {
    try { const p = new URL(u); return !p.search && !p.hash && !p.username && !p.password; } catch { return false; }
  }, 'URL must not contain credentials, a query or a fragment')
  .transform((u) => u.replace(/\/+$/, ''));

export const SettingsPatchSchema = z.object({
  instanceName: z.string().trim().min(1).max(80).optional(),
  publicUrl: publicUrl.optional(),
  statusPageEnabled: z.boolean().optional(),
  statusPageTitle: z.string().trim().min(1).max(120).optional(),
  metricsRetentionDays: z.number().int().min(1).max(3650).optional(),
});

const toToken = (r: Row): ApiToken => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scope: r.scope as TokenScope,
  lastUsedAt: iso(r.last_used_at),
  createdAt: isoReq(r.created_at),
});

const toActivity = (r: Row): ActivityEntry => ({
  id: Number(r.id),
  ts: isoReq(r.ts),
  actor: r.actor,
  action: r.action,
  targetType: r.target_type ?? null,
  targetId: r.target_id ?? null,
  detail: r.detail ?? null,
});

const userCount = (): number => Number((db.prepare('SELECT COUNT(*) AS n FROM users').get() as Row).n);

/** Used to keep login timing similar whether or not the email exists. */
let dummyHash: string | null = null;

// ───────────────────────────── routes ─────────────────────────────

export function registerAuth(app: Hono<AppEnv>): void {
  // ── public ──
  app.get('/api/v1/auth/state', (c) => {
    const who = resolveCaller(c);
    const state: AuthState = { setupRequired: userCount() === 0, user: who?.user ?? null };
    return c.json(state);
  });

  app.post('/api/v1/auth/setup', async (c) => {
    const input = await body(c, SetupSchema);
    const id = newId();
    tx(() => {
      if (userCount() > 0) throw conflict('Setup is already complete. Log in instead.');
      db.prepare('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, input.email, input.name, hashPassword(input.password), 'owner', now());
    });
    createSession(c, id);
    logActivity(`user:${input.email}`, 'auth.setup', 'user', id);
    return c.json(toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row), 201);
  });

  app.post('/api/v1/auth/login', async (c) => {
    const wait = hitLoginLimit(clientIp(c));
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      throw new HttpError(429, 'rate_limited', `Too many login attempts. Try again in ${wait}s.`);
    }
    const input = await body(c, LoginSchema);
    const r = db.prepare('SELECT * FROM users WHERE email = ?').get(input.email) as Row | undefined;
    if (!r) {
      verifyPassword(input.password, (dummyHash ??= hashPassword('docksy-dummy-password')));
      throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');
    }
    if (!verifyPassword(input.password, r.password_hash)) {
      throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');
    }
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
    createSession(c, r.id);
    logActivity(`user:${r.email}`, 'auth.login', 'user', r.id);
    return c.json(toUser(r));
  });

  // Logout works for anyone (incl. viewers, whom requireUser blocks from POSTs) and is idempotent.
  app.post('/api/v1/auth/logout', (c) => {
    const who = resolveCaller(c);
    destroySession(c);
    if (who) logActivity(who.actor, 'auth.logout', 'user', who.user.id);
    return c.json({ ok: true });
  });

  // ── authenticated ──
  app.get('/api/v1/auth/me', requireUser, (c) => c.json(c.get('user')));

  app.get('/api/v1/tokens', requireUser, (c) => {
    const rows = db.prepare('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC').all(c.get('user').id) as Row[];
    return c.json({ items: rows.map(toToken) });
  });

  app.post('/api/v1/tokens', requireUser, async (c) => {
    const input = await body(c, TokenSchema);
    const plaintext = randomToken('dsk_', 32);
    const id = newId();
    db.prepare('INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, c.get('user').id, input.name, sha256(plaintext), plaintext.slice(0, 10), input.scope ?? 'full', now());
    logActivity(c.get('actor'), 'token.create', 'token', id, `${input.name} (${input.scope ?? 'full'})`);
    const res: CreateTokenResponse = { token: toToken(db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id) as Row), plaintext };
    return c.json(res, 201);
  });

  app.delete('/api/v1/tokens/:id', requireUser, (c) => {
    const id = c.req.param('id');
    const r = db.prepare('SELECT * FROM api_tokens WHERE id = ? AND user_id = ?').get(id, c.get('user').id) as Row | undefined;
    if (!r) throw notFound('Token');
    db.prepare('DELETE FROM api_tokens WHERE id = ?').run(id);
    logActivity(c.get('actor'), 'token.delete', 'token', id, r.name);
    return c.json({ ok: true });
  });

  app.get('/api/v1/settings', requireUser, (c) => c.json(getSettings()));

  app.patch('/api/v1/settings', requireUser, async (c) => {
    const patch = await body(c, SettingsPatchSchema);
    const updated = setSettings(patch);
    const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
    logActivity(c.get('actor'), 'settings.update', 'settings', null, keys.join(', ') || null);
    return c.json(updated);
  });

  app.get('/api/v1/activity', requireUser, (c) => {
    const limit = Math.min(500, Math.max(1, Number.parseInt(c.req.query('limit') ?? '50', 10) || 50));
    const where: string[] = [];
    const args: (string | number)[] = [];
    const before = Number.parseInt(c.req.query('before') ?? '', 10);
    if (Number.isFinite(before)) { where.push('id < ?'); args.push(before); }
    const targetType = c.req.query('targetType');
    if (targetType) { where.push('target_type = ?'); args.push(targetType); }
    const targetId = c.req.query('targetId');
    if (targetId) { where.push('target_id = ?'); args.push(targetId); }
    const sql = `SELECT * FROM activity ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...args, limit) as Row[];
    return c.json({ items: rows.map(toActivity) });
  });
}
