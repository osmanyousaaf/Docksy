import type { Deployment, DeploymentStatus, DeploymentTrigger, LogLine } from '@docksy/shared';
import { db, iso, isoReq, now, type Row } from '../../db/index.ts';
import { bus } from '../../lib/events.ts';
import { notFound } from '../../lib/http.ts';
import { setAppStatus } from '../apps/model.ts';

/** Deployment rows, log lines and status transitions shared by the queue, pipeline and routes. */

export const TERMINAL: ReadonlySet<DeploymentStatus> = new Set(['succeeded', 'failed', 'cancelled']);
export const ACTIVE: ReadonlySet<DeploymentStatus> = new Set(['building', 'deploying']);

/** Max log lines stored per deployment; later lines are dropped (with one notice). */
export const MAX_LOG_LINES = 20_000;
const MAX_LINE_LEN = 4_000;

export const toDeployment = (r: Row): Deployment => ({
  id: r.id,
  appId: r.app_id,
  status: r.status as DeploymentStatus,
  trigger: r.trigger as DeploymentTrigger,
  commitSha: r.commit_sha ?? null,
  commitMessage: r.commit_message ?? null,
  imageTag: r.image_tag ?? null,
  error: r.error ?? null,
  startedAt: iso(r.started_at),
  finishedAt: iso(r.finished_at),
  createdAt: isoReq(r.created_at),
});

export function findDeploymentRow(id: string): Row | undefined {
  return db.prepare('SELECT * FROM deployments WHERE id = ?').get(id) as Row | undefined;
}

export function getDeploymentRow(id: string): Row {
  const r = findDeploymentRow(id);
  if (!r) throw notFound('Deployment');
  return r;
}

export const getDeployment = (id: string): Deployment => toDeployment(getDeploymentRow(id));

/** `ref` passed to enqueueDeployment (branch/tag override). In-memory only: there is no column for it. */
export const deploymentRefs = new Map<string, string>();

const lineCounts = new Map<string, number>();

function countLines(deploymentId: string): number {
  let n = lineCounts.get(deploymentId);
  if (n === undefined) {
    n = Number((db.prepare('SELECT COUNT(*) AS n FROM deployment_logs WHERE deployment_id = ?').get(deploymentId) as Row).n);
    lineCounts.set(deploymentId, n);
  }
  return n;
}

/** Store one log line and emit `deployment.log`. Never throws (the deployment may have been deleted). */
export function appendLog(deploymentId: string, stream: LogLine['stream'], text: string): void {
  try {
    const n = countLines(deploymentId);
    if (n > MAX_LOG_LINES) return;
    let line = text.length > MAX_LINE_LEN ? `${text.slice(0, MAX_LINE_LEN)}…` : text;
    if (n === MAX_LOG_LINES) { stream = 'system'; line = `Log limit of ${MAX_LOG_LINES} lines reached; further output is not stored.`; }
    const ts = now();
    db.prepare('INSERT INTO deployment_logs (deployment_id, ts, stream, line) VALUES (?, ?, ?, ?)').run(deploymentId, ts, stream, line);
    lineCounts.set(deploymentId, n + 1);
    bus.emit('deployment.log', { deploymentId, line: { ts: isoReq(ts), stream, line } });
  } catch {
    /* deployment deleted mid-run */
  }
}

export function listLogLines(deploymentId: string, afterId = 0, limit = MAX_LOG_LINES + 1): (LogLine & { id: number })[] {
  const rows = db.prepare('SELECT id, ts, stream, line FROM deployment_logs WHERE deployment_id = ? AND id > ? ORDER BY id LIMIT ?')
    .all(deploymentId, afterId, limit) as Row[];
  return rows.map((r) => ({ id: Number(r.id), ts: isoReq(r.ts), stream: r.stream as LogLine['stream'], line: r.line }));
}

/** Move a deployment to a non-terminal status and emit `deployment.status`. */
export function setDeploymentStatus(id: string, appId: string, status: 'building' | 'deploying', patch: { startedAt?: number; imageTag?: string | null } = {}): void {
  if (patch.startedAt !== undefined) db.prepare('UPDATE deployments SET started_at = ? WHERE id = ?').run(patch.startedAt, id);
  if (patch.imageTag !== undefined) db.prepare('UPDATE deployments SET image_tag = ? WHERE id = ?').run(patch.imageTag, id);
  db.prepare('UPDATE deployments SET status = ? WHERE id = ?').run(status, id);
  bus.emit('deployment.status', { deploymentId: id, appId, status, error: null });
}

/**
 * Finish a deployment (succeeded/failed/cancelled): sets finished_at/error, emits
 * `deployment.status` + `deployment.finished`. Idempotent: no-op if already terminal.
 */
export function finishDeployment(id: string, status: 'succeeded' | 'failed' | 'cancelled', error: string | null): boolean {
  const r = findDeploymentRow(id);
  if (!r || TERMINAL.has(r.status as DeploymentStatus)) return false;
  db.prepare('UPDATE deployments SET status = ?, error = ?, finished_at = ? WHERE id = ?').run(status, error, now(), id);
  lineCounts.delete(id);
  deploymentRefs.delete(id);
  bus.emit('deployment.status', { deploymentId: id, appId: r.app_id, status, error });
  bus.emit('deployment.finished', { deploymentId: id, appId: r.app_id, status, error });
  return true;
}

/** Set app status and emit `app.status`. */
export function updateAppStatus(appId: string, status: Parameters<typeof setAppStatus>[1]): void {
  try {
    setAppStatus(appId, status);
    bus.emit('app.status', { appId, status });
  } catch {
    /* app deleted */
  }
}

export function setCurrentDeployment(appId: string, deploymentId: string): void {
  db.prepare('UPDATE apps SET current_deployment_id = ?, updated_at = ? WHERE id = ?').run(deploymentId, now(), appId);
}

export function activeDeploymentFor(appId: string): Row | undefined {
  return db.prepare("SELECT * FROM deployments WHERE app_id = ? AND status IN ('building','deploying') ORDER BY created_at DESC LIMIT 1").get(appId) as Row | undefined;
}
