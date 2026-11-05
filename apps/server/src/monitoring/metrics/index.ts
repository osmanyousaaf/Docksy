import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AgentReport, AgentReportResponse, MetricsRange } from '@docksy/shared';
import { HttpError, badRequest, type AppEnv } from '../../lib/http.ts';
import { requireUser, resolveAgent } from '../../lib/auth.ts';
import { bus } from '../../lib/events.ts';
import { config } from '../../config.ts';
import { getServerRow } from '../../core/servers/model.ts';
import { getAppRow } from '../../core/apps/model.ts';
import { isRange, RANGES } from './downsample.ts';
import {
  fleetOverview, forgetServer, ingestReport, latestLive, listContainers, queryAppMetrics, queryServerMetrics,
} from './store.ts';
import { startRollupJob } from './rollup.ts';

export const MAX_REPORT_BYTES = 1024 * 1024;
export const HEARTBEAT_MS = 15_000;

// ───────────── agent report schema (loose: unknown fields pass, missing optional bits default) ─────────────

const n = z.number().finite();
const n0 = n.nullish().transform((v) => v ?? 0);
const str = z.string().nullish().transform((v) => v ?? '');
/** Go marshals nil slices/maps as null. */
const arr = <T extends z.ZodType>(s: T) => z.array(s).nullish().transform((v) => v ?? []);

const containerSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1).transform((v) => v.replace(/^\//, '')),
  image: str,
  state: z.string().min(1),
  status: str,
  restartCount: n0,
  startedAt: z.string().nullish().transform((v) => v || null),
  cpuPercent: n0,
  memUsed: n0,
  memLimit: n0,
  netRx: n0,
  netTx: n0,
  labels: z.record(z.string(), z.string()).nullish().transform((v) => v ?? {}),
});

export const agentReportSchema = z.looseObject({
  agentVersion: str,
  hostname: str,
  os: str,
  arch: str,
  uptimeSec: n0,
  ts: n0,
  cpu: z.looseObject({
    percent: n,
    cores: n0,
    perCore: arr(n),
    load1: n0,
    load5: n0,
    load15: n0,
  }),
  mem: z.looseObject({
    total: n,
    used: n,
    available: n0,
    swapTotal: n0,
    swapUsed: n0,
  }),
  disks: arr(z.looseObject({ mount: z.string(), fs: str, total: n0, used: n0 })),
  net: z.looseObject({ rxBytesPerSec: n0, txBytesPerSec: n0 }).nullish().transform((v) => v ?? { rxBytesPerSec: 0, txBytesPerSec: 0 }),
  containers: arr(containerSchema),
});

function parseRange(v: string | undefined): MetricsRange {
  if (v === undefined || v === '') return '1h';
  if (!isRange(v)) throw badRequest(`range must be one of ${RANGES.join(', ')}`);
  return v;
}

export function registerMetrics(app: Hono<AppEnv>): void {
  // ── agent ingest (agent token auth, outside /api/v1) ──
  app.post(
    '/api/agent/v1/report',
    bodyLimit({
      maxSize: MAX_REPORT_BYTES,
      onError: (c) => c.json({ error: { code: 'payload_too_large', message: 'Report body exceeds 1 MB' } }, 413),
    }),
    async (c) => {
      const server = resolveAgent(c);
      if (!server) throw new HttpError(401, 'unauthorized', 'Invalid or missing agent token');
      let raw: unknown;
      try { raw = await c.req.json(); } catch { throw badRequest('Body must be JSON'); }
      const parsed = agentReportSchema.safeParse(raw);
      if (!parsed.success) throw badRequest('Invalid agent report', parsed.error.issues);
      const report = parsed.data as unknown as AgentReport;
      ingestReport(server.id, report);
      try {
        bus.emit('server.report', { serverId: server.id, report });
      } catch (e) {
        console.error('[docksy] server.report listener failed', e);
      }
      return c.json({ ok: true, intervalSec: config.agentIntervalSec } satisfies AgentReportResponse);
    },
  );

  // ── user-facing reads ──
  app.get('/api/v1/servers/:id/metrics', requireUser, (c) => {
    const id = getServerRow(c.req.param('id')).id as string;
    return c.json(queryServerMetrics(id, parseRange(c.req.query('range'))));
  });

  app.get('/api/v1/servers/:id/metrics/live', requireUser, (c) => {
    const id = getServerRow(c.req.param('id')).id as string;
    return streamSSE(c, async (stream) => {
      let closed = false;
      let wake: (() => void) | null = null;
      // Serialize writes so heartbeats and events never interleave.
      let chain: Promise<unknown> = Promise.resolve();
      const send = (write: () => Promise<unknown>) => {
        chain = chain.then(() => (closed ? undefined : write())).catch(() => { closed = true; wake?.(); });
        return chain;
      };
      const sendLatest = () => {
        const ev = latestLive(id);
        if (ev) void send(() => stream.writeSSE({ event: 'metrics', data: JSON.stringify(ev) }));
      };
      const off = bus.on('server.report', (p) => { if (p.serverId === id) sendLatest(); });
      stream.onAbort(() => { closed = true; wake?.(); });

      try {
        sendLatest();
        while (!closed && !stream.aborted) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, HEARTBEAT_MS);
            wake = () => { clearTimeout(timer); resolve(); };
          });
          wake = null;
          if (closed || stream.aborted) break;
          await send(() => stream.write(': ping\n\n'));
        }
      } finally {
        off();
      }
    });
  });

  app.get('/api/v1/servers/:id/containers', requireUser, (c) => {
    const id = getServerRow(c.req.param('id')).id as string;
    return c.json({ items: listContainers(id) });
  });

  app.get('/api/v1/apps/:id/metrics', requireUser, (c) => {
    const appId = getAppRow(c.req.param('id')).id as string;
    return c.json({ points: queryAppMetrics(appId, parseRange(c.req.query('range'))).points });
  });

  app.get('/api/v1/overview', requireUser, (c) => c.json(fleetOverview()));

  bus.on('server.deleted', ({ serverId }) => forgetServer(serverId));
}

let started = false;

/** Background jobs: rollups + retention every 60s. */
export function startMetrics(): void {
  if (started) return;
  started = true;
  startRollupJob();
}
