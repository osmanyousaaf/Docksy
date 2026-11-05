import type { Hono } from 'hono';
import type { AppEnv } from '../lib/http.ts';
import { registerAuth } from './auth/index.ts';
import { registerServers, startServers } from './servers/index.ts';
import { registerApps } from './apps/index.ts';
import { registerDeploy, startDeploy } from './deploy/index.ts';

/**
 * CORE module (integrator-owned wiring). Each sub-module is owned by one agent — see CONTRACT.md §2.
 * Order matters: public routes (auth/setup, webhooks, agent binary) are registered inside each sub-module.
 */
export function registerCore(app: Hono<AppEnv>): void {
  registerAuth(app); // core-platform: auth, tokens, settings, activity
  registerServers(app); // core-platform: ssh-key, servers, validate, provision, agent binary download
  registerApps(app); // core-apps: apps CRUD, env, templates, github webhooks
  registerDeploy(app); // core-deploy: deploy/rollback/restart/stop/start/logs, deployments, log streams
}

export function startCore(): void {
  startServers();
  startDeploy();
}
