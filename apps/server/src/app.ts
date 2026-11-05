import { Hono } from 'hono';
import { errorHandler, type AppEnv } from './lib/http.ts';
import { config } from './config.ts';
import { registerCore, startCore } from './core/index.ts';
import { registerMonitoring, startMonitoring } from './monitoring/index.ts';

const startedAt = Date.now();

/** Build the Hono app. Static web UI is attached in index.ts (after API routes). */
export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);

  app.get('/api/v1/health', (c) => c.json({ ok: true, version: config.version, uptimeSec: Math.round((Date.now() - startedAt) / 1000) }));

  registerCore(app); // auth, tokens, settings, servers, apps, deployments, webhooks, templates, activity
  registerMonitoring(app); // agent ingest, metrics, overview, alerts, channels, uptime, status page, diagnose, backups

  app.all('/api/*', (c) => c.json({ error: { code: 'not_found', message: `No route ${c.req.method} ${c.req.path}` } }, 404));
  return app;
}

export function startJobs(): void {
  if (config.disableJobs) return;
  startCore(); // deployment queue, provisioning
  startMonitoring(); // rollups, alert evaluation, uptime checks, backup scheduler, retention
}
