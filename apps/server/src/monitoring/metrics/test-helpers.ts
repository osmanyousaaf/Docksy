// Test-only helpers. Import this FIRST in a test file: it sets env before db/config load.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOCKSY_DB_PATH = ':memory:';
process.env.DOCKSY_DISABLE_JOBS = '1';
process.env.DOCKSY_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'docksy-metrics-test-'));

const { db, migrate, newId } = await import('../../db/index.ts');
const { sha256 } = await import('../../lib/crypto.ts');
migrate();

import type { AgentContainer, AgentReport } from '@docksy/shared';

export { db };

export function makeServer(name = 'srv'): { id: string; agentToken: string } {
  const id = newId();
  const agentToken = `dsa_${id.replace(/-/g, '')}`;
  const t = Date.now();
  db.prepare(`INSERT INTO servers (id, name, host, status, agent_token_hash, created_at, updated_at) VALUES (?, ?, '10.0.0.1', 'ready', ?, ?, ?)`)
    .run(id, name, sha256(agentToken), t, t);
  return { id, agentToken };
}

export function makeApp(serverId: string, name: string): string {
  const id = newId();
  const t = Date.now();
  db.prepare(`INSERT INTO apps (id, name, server_id, webhook_secret, created_at, updated_at) VALUES (?, ?, ?, 'whs_x', ?, ?)`)
    .run(id, name, serverId, t, t);
  return id;
}

/** Creates a user + full-scope API token; returns the Authorization header value. */
export function makeUserToken(): string {
  const uid = newId();
  const tok = `dsk_${uid.replace(/-/g, '')}`;
  db.prepare(`INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, 'T', 'x', ?)`).run(uid, `${uid}@t.dev`, Date.now());
  db.prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, created_at) VALUES (?, ?, 'test', ?, 'dsk_', ?)`)
    .run(newId(), uid, sha256(tok), Date.now());
  return `Bearer ${tok}`;
}

export function container(p: Partial<AgentContainer> & { id: string; name: string }): AgentContainer {
  return {
    image: 'nginx:1', state: 'running', status: 'Up 1 minute', restartCount: 0, startedAt: null,
    cpuPercent: 1, memUsed: 1000, memLimit: 10_000, netRx: 1, netTx: 2, labels: {}, ...p,
  };
}

export function report(p: Partial<AgentReport> = {}): AgentReport {
  return {
    agentVersion: '0.1.0', hostname: 'h', os: 'ubuntu 24.04', arch: 'amd64', uptimeSec: 100, ts: Date.now(),
    cpu: { percent: 25, cores: 4, perCore: [10, 20, 30, 40], load1: 0.5, load5: 0.4, load15: 0.3 },
    mem: { total: 8000, used: 2000, available: 6000, swapTotal: 1000, swapUsed: 100 },
    disks: [{ mount: '/', fs: 'ext4', total: 100_000, used: 40_000 }],
    net: { rxBytesPerSec: 500, txBytesPerSec: 250 },
    containers: [],
    ...p,
  };
}
