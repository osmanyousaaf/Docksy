import type { Deployment, DeploymentStatus, DeploymentTrigger } from '@docksy/shared';
import { db, newId, now, type Row } from '../../db/index.ts';
import { bus } from '../../lib/events.ts';
import { conflict } from '../../lib/http.ts';
import { getAppRow } from '../apps/model.ts';
import {
  ACTIVE, TERMINAL, appendLog, deploymentRefs, findDeploymentRow, finishDeployment, getDeploymentRow, toDeployment, updateAppStatus,
} from './model.ts';
import { runDeployment } from './pipeline.ts';

/**
 * Deployment queue. Rows with status 'queued' in the deployments table ARE the queue,
 * so it survives restarts. The worker runs one deployment per app at a time and at most
 * MAX_CONCURRENT overall, oldest first.
 */

export const MAX_CONCURRENT = 3;

export type Runner = (deploymentId: string, signal: AbortSignal) => Promise<void>;

let runner: Runner = runDeployment;
let enabled = false;
let timer: NodeJS.Timeout | null = null;
const running = new Map<string, { appId: string; controller: AbortController }>();

/** Test hook: replace the pipeline (pass null to restore). */
export function setRunner(r: Runner | null): void {
  runner = r ?? runDeployment;
}

/** Ids of deployments the worker is executing right now. */
export const runningDeploymentIds = (): string[] => [...running.keys()];

export type EnqueueMeta = { commitSha?: string; commitMessage?: string; ref?: string };

/** FROZEN (CONTRACT.md §7). Insert a 'queued' deployment for an app (id or name) and return it. */
export function enqueueDeployment(appId: string, trigger: DeploymentTrigger, meta: EnqueueMeta = {}): Deployment {
  return enqueue(appId, trigger, meta);
}

/** enqueueDeployment plus internals: `imageTag` pre-set makes a rollback reuse that image. */
export function enqueue(appIdOrName: string, trigger: DeploymentTrigger, meta: EnqueueMeta = {}, extra: { imageTag?: string; note?: string } = {}): Deployment {
  const app = getAppRow(appIdOrName);
  const id = newId();
  db.prepare(`INSERT INTO deployments (id, app_id, status, trigger, commit_sha, commit_message, image_tag, created_at)
    VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)`)
    .run(id, app.id, trigger, meta.commitSha ?? null, meta.commitMessage ? meta.commitMessage.slice(0, 500) : null, extra.imageTag ?? null, now());
  if (meta.ref) deploymentRefs.set(id, meta.ref);
  appendLog(id, 'system', extra.note ?? `Queued (${trigger}).`);
  bus.emit('deployment.status', { deploymentId: id, appId: app.id, status: 'queued', error: null });
  kick();
  return toDeployment(getDeploymentRow(id));
}

/** Start as many queued deployments as the limits allow. Safe to call any time. */
export function kick(): void {
  if (!enabled || running.size >= MAX_CONCURRENT) return;
  const busy = new Set([...running.values()].map((r) => r.appId));
  const rows = db.prepare("SELECT id, app_id FROM deployments WHERE status = 'queued' ORDER BY created_at, rowid").all() as Row[];
  for (const r of rows) {
    if (running.size >= MAX_CONCURRENT) break;
    if (busy.has(r.app_id) || running.has(r.id)) continue;
    busy.add(r.app_id);
    launch(r.id, r.app_id);
  }
}

function launch(id: string, appId: string): void {
  const controller = new AbortController();
  running.set(id, { appId, controller });
  Promise.resolve()
    .then(() => runner(id, controller.signal))
    .catch((e) => { console.error('[docksy] deployment crashed', id, e); })
    .finally(() => {
      running.delete(id);
      // Safety net: a deployment must never be left non-terminal by the worker.
      const row = findDeploymentRow(id);
      if (row && !TERMINAL.has(row.status as DeploymentStatus)) {
        const cancelled = controller.signal.aborted;
        finishDeployment(id, cancelled ? 'cancelled' : 'failed', cancelled ? 'Deployment cancelled' : 'Deployment ended unexpectedly');
      }
      kick();
    });
}

/** Cancel a queued or running deployment. Returns the deployment as it is now. */
export function cancelDeployment(id: string): Deployment {
  const row = getDeploymentRow(id);
  const status = row.status as DeploymentStatus;
  if (TERMINAL.has(status)) throw conflict(`Deployment already ${status}`);
  const live = running.get(id);
  if (live) {
    appendLog(id, 'system', 'Cancelling…');
    live.controller.abort();
  } else {
    appendLog(id, 'system', status === 'queued' ? 'Cancelled before it started.' : 'Cancelled.');
    finishDeployment(id, 'cancelled', status === 'queued' ? 'Cancelled before it started' : 'Deployment cancelled');
  }
  return toDeployment(getDeploymentRow(id));
}

/** Mark deployments left building/deploying by a previous process as failed. */
export function recoverStale(): number {
  const rows = db.prepare("SELECT d.id, d.app_id, a.status AS app_status, a.current_deployment_id FROM deployments d LEFT JOIN apps a ON a.id = d.app_id WHERE d.status IN ('building','deploying')").all() as Row[];
  let n = 0;
  for (const r of rows) {
    if (running.has(r.id)) continue;
    appendLog(r.id, 'system', 'Docksy restarted while this deployment was running. Deploy again to retry.');
    if (finishDeployment(r.id, 'failed', 'Docksy restarted while this deployment was running')) n++;
    if (r.app_status === 'deploying') updateAppStatus(r.app_id, r.current_deployment_id ? 'running' : 'failed');
  }
  return n;
}

export function startWorker(): void {
  if (enabled) return;
  enabled = true;
  kick();
  timer = setInterval(kick, 5_000);
  timer.unref();
}

/** Stop picking up new work (running deployments continue). */
export function stopWorker(): void {
  enabled = false;
  if (timer) clearInterval(timer);
  timer = null;
}

let unsubscribe: (() => void) | null = null;

/** When an app is deleted, abort its running deployment. */
export function watchAppDeletes(): void {
  if (unsubscribe) return;
  unsubscribe = bus.on('app.deleted', ({ appId }) => {
    for (const r of running.values()) if (r.appId === appId) r.controller.abort();
  });
}

export const isActive = (status: DeploymentStatus) => ACTIVE.has(status);
