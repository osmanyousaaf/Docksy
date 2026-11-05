import type { Context, Hono } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { z } from 'zod';
import type { DeploymentStatus, DeploymentTrigger } from '@docksy/shared';
import { db, type Row } from '../../db/index.ts';
import { bus } from '../../lib/events.ts';
import { badRequest, conflict, HttpError, logActivity, notFound, type AppEnv } from '../../lib/http.ts';
import { requireUser } from '../../lib/auth.ts';
import { getAppRow } from '../apps/model.ts';
import { appLogsCommand, lifecycleCommand, type LifecycleAction } from './commands.ts';
import { activeDeploymentFor, findDeploymentRow, getDeploymentRow, listLogLines, TERMINAL, toDeployment, updateAppStatus } from './model.ts';
import { cancelDeployment, enqueue, recoverStale, startWorker, watchAppDeletes } from './queue.ts';
import { remote } from './remote.ts';

const API = '/api/v1';
const HEARTBEAT_MS = 15_000;

const DeployBody = z.object({
  ref: z.string().min(1).max(255).optional(),
  trigger: z.enum(['manual', 'webhook', 'api', 'mcp']).optional(),
}).strict();

const RollbackBody = z.object({ deploymentId: z.string().min(1).optional() }).strict();

/** Optional JSON body: empty body → {}. */
async function optionalBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const text = await c.req.text();
  let raw: unknown = {};
  if (text.trim()) {
    try { raw = JSON.parse(text); } catch { throw badRequest('Body must be JSON'); }
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw badRequest('Validation failed', r.error.issues);
  return r.data;
}

function defaultTrigger(c: Context<AppEnv>): DeploymentTrigger {
  return c.get('authKind') === 'session' ? 'manual' : 'api';
}

function assertDeployable(app: Row): void {
  const isImage = app.source_type === 'image' || app.build_type === 'image';
  if (isImage && !app.image) throw badRequest('This app has no image set. Set one, then deploy.');
  if (!isImage && !app.repo_url) throw badRequest('This app has no repository URL. Set one, then deploy.');
}

/** Pipe a remote command's output to an SSE stream as `log` {line} events until the client leaves. */
async function sseRemoteLines(stream: SSEStreamingApi, serverId: string, command: string): Promise<void> {
  const ac = new AbortController();
  stream.onAbort(() => ac.abort());
  let chain: Promise<void> = Promise.resolve();
  const send = (event: string, data: unknown) => {
    chain = chain.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => {});
  };
  let buf = '';
  const hb = setInterval(() => { chain = chain.then(() => stream.write(': ping\n\n')).then(() => {}).catch(() => {}); }, HEARTBEAT_MS);
  try {
    const res = await remote.exec(serverId, command, {
      timeoutMs: 0,
      signal: ac.signal,
      onData: (d) => {
        const parts = (buf + d).split(/\r?\n/);
        buf = parts.pop() ?? '';
        for (const line of parts) send('log', { line });
      },
    });
    if (buf) send('log', { line: buf });
    if (res.code === 3) send('log', { line: 'No container is running for this app yet.' });
  } catch (e) {
    if (!ac.signal.aborted) send('log', { line: `Log stream ended: ${(e as Error).message}` });
  } finally {
    clearInterval(hb);
    await chain;
  }
}

export function registerDeploy(app: Hono<AppEnv>): void {
  // ── deploy / rollback ──
  app.post(`${API}/apps/:id/deploy`, requireUser, async (c) => {
    const a = getAppRow(c.req.param('id'));
    const b = await optionalBody(c, DeployBody);
    assertDeployable(a);
    const d = enqueue(a.id, b.trigger ?? defaultTrigger(c), { ref: b.ref });
    logActivity(c.get('actor'), 'app.deploy', 'app', a.id, b.ref ? `ref ${b.ref}` : null);
    return c.json(d, 202);
  });

  app.post(`${API}/apps/:id/rollback`, requireUser, async (c) => {
    const a = getAppRow(c.req.param('id'));
    const b = await optionalBody(c, RollbackBody);
    let target: Row | undefined;
    if (b.deploymentId) {
      target = db.prepare('SELECT * FROM deployments WHERE id = ? AND app_id = ?').get(b.deploymentId, a.id) as Row | undefined;
      if (!target) throw notFound('Deployment');
      if (target.status !== 'succeeded' || !target.image_tag) throw badRequest('You can only roll back to a succeeded deployment that produced an image.');
    } else {
      target = db.prepare("SELECT * FROM deployments WHERE app_id = ? AND status = 'succeeded' AND image_tag IS NOT NULL AND id IS NOT ? ORDER BY created_at DESC LIMIT 1")
        .get(a.id, a.current_deployment_id ?? null) as Row | undefined;
      if (!target) throw badRequest('There is no earlier successful deployment to roll back to.');
    }
    const d = enqueue(a.id, 'rollback', { commitSha: target.commit_sha ?? undefined, commitMessage: target.commit_message ?? undefined }, {
      imageTag: target.image_tag,
      note: `Queued rollback to deployment ${String(target.id).slice(0, 8)} (${target.image_tag}).`,
    });
    logActivity(c.get('actor'), 'app.rollback', 'app', a.id, `to ${target.id}`);
    return c.json(d, 202);
  });

  // ── lifecycle ──
  const lifecycle = (action: LifecycleAction) => async (c: Context<AppEnv>) => {
    const a = getAppRow(c.req.param('id')!);
    if (activeDeploymentFor(a.id)) throw conflict('A deployment is in progress. Wait for it to finish or cancel it first.');
    const res = await remote.exec(a.server_id, lifecycleCommand(action, a.id, a.name), { timeoutMs: 120_000 });
    if (res.code === 3) throw conflict('This app has no containers yet. Deploy it first.');
    if (res.code !== 0) throw new HttpError(502, 'remote_failed', `docker ${action} failed: ${(res.stderr || res.stdout).trim().slice(0, 500)}`);
    updateAppStatus(a.id, action === 'stop' ? 'stopped' : 'running');
    logActivity(c.get('actor'), `app.${action}`, 'app', a.id);
    return c.json({ ok: true });
  };
  app.post(`${API}/apps/:id/restart`, requireUser, lifecycle('restart'));
  app.post(`${API}/apps/:id/stop`, requireUser, lifecycle('stop'));
  app.post(`${API}/apps/:id/start`, requireUser, lifecycle('start'));

  // ── runtime logs ──
  app.get(`${API}/apps/:id/logs`, requireUser, async (c) => {
    const a = getAppRow(c.req.param('id'));
    const tail = Number(c.req.query('tail') ?? 200);
    const res = await remote.exec(a.server_id, appLogsCommand(a.id, a.name, Number.isFinite(tail) ? tail : 200, false), { timeoutMs: 30_000 });
    if (res.code === 3) return c.json({ lines: [] as string[] });
    const lines = res.stdout.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return c.json({ lines });
  });

  app.get(`${API}/apps/:id/logs/stream`, requireUser, (c) => {
    const a = getAppRow(c.req.param('id'));
    const tail = Number(c.req.query('tail') ?? 100);
    return streamSSE(c, (stream) => sseRemoteLines(stream, a.server_id, appLogsCommand(a.id, a.name, Number.isFinite(tail) ? tail : 100, true)));
  });

  // ── deployments ──
  app.get(`${API}/deployments`, requireUser, (c) => {
    const appParam = c.req.query('appId');
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 500);
    const rows = appParam
      ? db.prepare('SELECT * FROM deployments WHERE app_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(getAppRow(appParam).id, limit)
      : db.prepare('SELECT * FROM deployments ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit);
    return c.json({ items: (rows as Row[]).map(toDeployment) });
  });

  app.get(`${API}/deployments/:id`, requireUser, (c) => c.json(toDeployment(getDeploymentRow(c.req.param('id')))));

  app.get(`${API}/deployments/:id/logs`, requireUser, (c) => {
    const d = getDeploymentRow(c.req.param('id'));
    return c.json({ items: listLogLines(d.id).map(({ id: _id, ...l }) => l) });
  });

  app.get(`${API}/deployments/:id/logs/stream`, requireUser, (c) => {
    const d = getDeploymentRow(c.req.param('id'));
    return streamSSE(c, async (stream) => {
      let lastId = 0;
      let lastStatus: string | null = null;
      let done = false;
      let pumping: Promise<void> | null = null;
      let again = false;
      let finish!: () => void;
      const finished = new Promise<void>((r) => { finish = r; });

      const pumpOnce = async () => {
        for (;;) {
          const lines = listLogLines(d.id, lastId, 500);
          for (const { id, ...l } of lines) {
            await stream.writeSSE({ event: 'log', data: JSON.stringify(l) });
            lastId = id;
          }
          if (lines.length < 500) break;
        }
        const row = findDeploymentRow(d.id);
        const status = (row?.status ?? 'failed') as DeploymentStatus;
        if (status !== lastStatus) {
          lastStatus = status;
          await stream.writeSSE({ event: 'status', data: JSON.stringify({ status, error: row?.error ?? (row ? null : 'Deployment deleted') }) });
        }
        if (!row || TERMINAL.has(status)) { done = true; finish(); }
      };
      // Coalesce bursts of events into one DB read; never run two pumps at once.
      const pump = () => {
        if (done) return;
        if (pumping) { again = true; return; }
        pumping = pumpOnce().catch(() => { done = true; finish(); }).finally(() => {
          pumping = null;
          if (again && !done) { again = false; pump(); }
        });
      };

      const offLog = bus.on('deployment.log', (p) => { if (p.deploymentId === d.id) pump(); });
      const offStatus = bus.on('deployment.status', (p) => { if (p.deploymentId === d.id) pump(); });
      const hb = setInterval(() => { stream.write(': ping\n\n').catch(() => {}); pump(); }, HEARTBEAT_MS);
      stream.onAbort(() => { done = true; finish(); });
      try {
        pump(); // replay existing lines + current status
        await finished;
        if (pumping) await pumping;
      } finally {
        offLog();
        offStatus();
        clearInterval(hb);
      }
    });
  });

  app.post(`${API}/deployments/:id/cancel`, requireUser, (c) => {
    const d = cancelDeployment(c.req.param('id'));
    logActivity(c.get('actor'), 'deployment.cancel', 'deployment', d.id);
    return c.json(d);
  });
}

/** Recover deployments interrupted by a restart and start the queue worker. */
export function startDeploy(): void {
  recoverStale();
  watchAppDeletes();
  startWorker();
}

export { enqueueDeployment } from './queue.ts';
