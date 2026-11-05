import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const here = import.meta.dirname; // apps/server/src

export const VERSION = process.env.DOCKSY_VERSION ?? '0.1.0';

const dataDir = resolve(process.env.DOCKSY_DATA_DIR ?? join(here, '..', 'data'));
mkdirSync(dataDir, { recursive: true });

export const config = {
  version: VERSION,
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir,
  dbPath: join(dataDir, 'docksy.db'),
  keysDir: join(dataDir, 'keys'),
  /** Overrides settings.publicUrl when set. */
  publicUrl: process.env.DOCKSY_PUBLIC_URL ?? null,
  /** Built web UI (apps/web/dist). */
  webDist: resolve(process.env.DOCKSY_WEB_DIST ?? join(here, '..', '..', 'web', 'dist')),
  /** Shell scripts run on servers over SSH (deploy/scripts). */
  scriptsDir: resolve(process.env.DOCKSY_SCRIPTS_DIR ?? join(here, '..', '..', '..', 'deploy', 'scripts')),
  /** Prebuilt agent binaries: docksy-agent-linux-amd64, docksy-agent-linux-arm64. */
  agentBinDir: resolve(process.env.DOCKSY_AGENT_BIN_DIR ?? join(here, '..', '..', '..', 'agent', 'bin')),
  agentIntervalSec: Number(process.env.DOCKSY_AGENT_INTERVAL ?? 10),
  /** "1" in tests: skip background loops. */
  disableJobs: process.env.DOCKSY_DISABLE_JOBS === '1',
  dev: process.env.NODE_ENV !== 'production',
} as const;
