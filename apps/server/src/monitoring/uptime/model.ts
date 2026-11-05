import type { UptimeCheck, UptimeResult, PublicStatus } from '@docksy/shared';
import { db, bool, isoReq, getSettings, type Row } from '../../db/index.ts';
import { notFound } from '../../lib/http.ts';
import { DAY_MS, buildDailyBuckets, overallStatus, uptimePercent, stateFromRecent, type CheckState, type DayRow } from './stats.ts';

/** DB access + mappers for uptime checks and results. */

export function lastResultRow(checkId: string): Row | undefined {
  return db.prepare('SELECT * FROM uptime_results WHERE check_id = ? ORDER BY ts DESC LIMIT 1').get(checkId) as Row | undefined;
}

export function statsSince(checkId: string, sinceMs: number): { n: number; ok: number; avgLatency: number | null } {
  const r = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(ok), 0) AS okn, AVG(CASE WHEN ok = 1 THEN latency_ms END) AS lat
       FROM uptime_results WHERE check_id = ? AND ts >= ?`,
  ).get(checkId, sinceMs) as Row;
  return { n: Number(r.n), ok: Number(r.okn), avgLatency: r.lat == null ? null : Math.round(Number(r.lat)) };
}

export function toUptimeCheck(r: Row, nowMs = Date.now()): UptimeCheck {
  const enabled = bool(r.enabled);
  const last = lastResultRow(r.id);
  const s = statsSince(r.id, nowMs - DAY_MS);
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    appId: r.app_id ?? null,
    intervalSec: Number(r.interval_sec),
    timeoutMs: Number(r.timeout_ms),
    expectedStatus: Number(r.expected_status),
    public: bool(r.public),
    enabled,
    lastStatus: !enabled || !last ? 'unknown' : bool(last.ok) ? 'up' : 'down',
    uptime24h: uptimePercent(s.ok, s.n),
    avgLatencyMs24h: s.avgLatency,
    createdAt: isoReq(r.created_at),
  };
}

export const toUptimeResult = (r: Row): UptimeResult => ({
  ts: isoReq(r.ts),
  ok: bool(r.ok),
  statusCode: r.status_code ?? null,
  latencyMs: r.latency_ms ?? null,
  error: r.error ?? null,
});

export function getCheckRow(id: string): Row {
  const r = db.prepare('SELECT * FROM uptime_checks WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw notFound('Uptime check');
  return r;
}

export function findCheckRow(id: string): Row | undefined {
  return db.prepare('SELECT * FROM uptime_checks WHERE id = ?').get(id) as Row | undefined;
}

export function listCheckRows(filter: { appId?: string | null } = {}): Row[] {
  if (filter.appId) return db.prepare('SELECT * FROM uptime_checks WHERE app_id = ? ORDER BY created_at').all(filter.appId) as Row[];
  return db.prepare('SELECT * FROM uptime_checks ORDER BY created_at').all() as Row[];
}

export function listChecks(filter: { appId?: string | null } = {}): UptimeCheck[] {
  const t = Date.now();
  return listCheckRows(filter).map((r) => toUptimeCheck(r, t));
}

export function insertResult(checkId: string, ts: number, r: { ok: boolean; statusCode: number | null; latencyMs: number | null; error: string | null }): void {
  db.prepare('INSERT OR REPLACE INTO uptime_results (check_id, ts, ok, status_code, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?)')
    .run(checkId, ts, r.ok ? 1 : 0, r.statusCode, r.latencyMs, r.error);
}

export function listResults(checkId: string, sinceMs: number): UptimeResult[] {
  return (db.prepare('SELECT * FROM uptime_results WHERE check_id = ? AND ts >= ? ORDER BY ts').all(checkId, sinceMs) as Row[]).map(toUptimeResult);
}

/** Consecutive-failure state for a check, rebuilt from its last results. */
export function loadCheckState(checkId: string): CheckState {
  const rows = db.prepare('SELECT ok FROM uptime_results WHERE check_id = ? ORDER BY ts DESC LIMIT 20').all(checkId) as Row[];
  return stateFromRecent(rows.map((r) => bool(r.ok)));
}

export function pruneResults(beforeMs: number): number {
  const r = db.prepare('DELETE FROM uptime_results WHERE ts < ?').run(beforeMs);
  return Number(r.changes);
}

/** Public status page payload. Only enabled + public checks; never exposes URLs. */
export function buildPublicStatus(nowMs = Date.now()): PublicStatus {
  const settings = getSettings();
  const rows = db.prepare('SELECT * FROM uptime_checks WHERE public = 1 AND enabled = 1 ORDER BY created_at').all() as Row[];
  const since = (Math.floor(nowMs / DAY_MS) - 89) * DAY_MS;
  const dayStmt = db.prepare(
    `SELECT CAST(ts / ${DAY_MS} AS INTEGER) AS day, COUNT(*) AS n, COALESCE(SUM(ok), 0) AS ok
       FROM uptime_results WHERE check_id = ? AND ts >= ? GROUP BY day`,
  );
  const checks = rows.map((r) => {
    const c = toUptimeCheck(r, nowMs);
    const dayRows = dayStmt.all(r.id, since) as Row[] as unknown as DayRow[];
    const total = dayRows.reduce((a, d) => a + Number(d.n), 0);
    const ok = dayRows.reduce((a, d) => a + Number(d.ok), 0);
    return { name: c.name, status: c.lastStatus, uptime90d: uptimePercent(ok, total), days: buildDailyBuckets(dayRows, nowMs, 90) };
  });
  return {
    title: settings.statusPageTitle || settings.instanceName,
    overall: overallStatus(checks.map((c) => c.status)),
    checks,
    updatedAt: new Date(nowMs).toISOString(),
  };
}
