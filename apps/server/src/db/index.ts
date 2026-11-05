import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';

/**
 * Single shared SQLite connection (node:sqlite, synchronous).
 * Usage: db.prepare('SELECT * FROM apps WHERE id = ?').get(id)
 * Rows come back with snake_case columns; convert to API shapes in your module's mapper.
 */
export const db = new DatabaseSync(process.env.DOCKSY_DB_PATH ?? config.dbPath);

db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

/** Columns added after the first schema. CREATE TABLE IF NOT EXISTS won't add them to old databases. */
const ADDED_COLUMNS: [table: string, column: string, def: string][] = [
  ['servers', 'host_key', 'TEXT'],
  ['deployments', 'ref', 'TEXT'],
  ['metrics', 'load5', 'REAL NOT NULL DEFAULT 0'],
  ['metrics', 'load15', 'REAL NOT NULL DEFAULT 0'],
  ['apps', 'description', 'TEXT'],
  ['apps', 'start_command', 'TEXT'],
  ['apps', 'watch_paths', "TEXT NOT NULL DEFAULT '[]'"],
  ['apps', 'cpu_limit', 'REAL'],
  ['apps', 'mem_limit_mb', 'INTEGER'],
];

export function migrate(): void {
  const sql = readFileSync(join(import.meta.dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
  for (const [table, column, def] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}

export type Row = Record<string, any>;

export const now = (): number => Date.now();
export const newId = (): string => randomUUID();
export const iso = (ms: number | null | undefined): string | null => (ms == null ? null : new Date(Number(ms)).toISOString());
export const isoReq = (ms: number): string => new Date(Number(ms)).toISOString();
export const json = <T>(text: string | null | undefined, fallback: T): T => {
  if (text == null) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
};
export const bool = (v: unknown): boolean => v === 1 || v === true || v === '1';

/** Run fn inside a transaction. */
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ── settings (key/value JSON) ──
import type { Settings } from '@docksy/shared';

const DEFAULT_SETTINGS: Settings = {
  instanceName: 'Docksy',
  publicUrl: `http://localhost:${config.port}`,
  statusPageEnabled: false,
  statusPageTitle: 'Status',
  metricsRetentionDays: 30,
};

export function getSettings(): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Row[];
  const s: any = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = json(r.value, s[r.key]);
  if (config.publicUrl) s.publicUrl = config.publicUrl;
  return s as Settings;
}

export function setSettings(patch: Partial<Settings>): Settings {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) if (v !== undefined && k in DEFAULT_SETTINGS) stmt.run(k, JSON.stringify(v));
  return getSettings();
}
