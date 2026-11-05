import type { Hono } from 'hono';
import type { AppEnv } from '../lib/http.ts';
import { registerMetrics, startMetrics } from './metrics/index.ts';
import { registerAlerts, startAlerts } from './alerts/index.ts';
import { registerUptime, startUptime } from './uptime/index.ts';
import { registerDiagnose } from './diagnose/index.ts';
import { registerBackups, startBackups } from './backups/index.ts';

/** MONITORING module (integrator-owned wiring). Each sub-module is owned by one agent — see CONTRACT.md §2. */
export function registerMonitoring(app: Hono<AppEnv>): void {
  registerMetrics(app); // mon-metrics: agent ingest, metrics, live SSE, overview, containers
  registerAlerts(app); // mon-alerts: alert rules, alerts, notification channels
  registerUptime(app); // mon-uptime: uptime checks, public status page
  registerDiagnose(app); // mon-uptime (diagnose): AI-ready diagnose report
  registerBackups(app); // mon-backups: database backups + restore verification
}

export function startMonitoring(): void {
  startMetrics();
  startAlerts();
  startUptime();
  startBackups();
}
