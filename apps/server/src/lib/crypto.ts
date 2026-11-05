import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';

/** 32-byte master key: DOCKSY_SECRET (64 hex chars) or generated once into data/secret.key. */
function loadKey(): Buffer {
  const env = process.env.DOCKSY_SECRET;
  if (env && /^[0-9a-f]{64}$/i.test(env)) return Buffer.from(env, 'hex');
  const file = join(config.dataDir, 'secret.key');
  if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  const key = randomBytes(32);
  writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  return key;
}
const KEY = loadKey();

/** AES-256-GCM. Output: "v1:<iv b64>:<tag b64>:<ciphertext b64>" */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

export function decrypt(blob: string): string {
  const [v, iv, tag, ct] = blob.split(':');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('bad ciphertext');
  const d = createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Random token with a prefix: dsk_ (API token), dsa_ (agent token), dss_ (session), whs_ (webhook secret). */
export const randomToken = (prefix: string, bytes = 24): string => `${prefix}${randomBytes(bytes).toString('base64url')}`;

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(pw, Buffer.from(salt, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(expected, actual);
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Mask a secret for display: "sk-abc…xyz" */
export const mask = (s: string): string => (s.length <= 8 ? '••••••' : `${s.slice(0, 3)}••••${s.slice(-3)}`);
