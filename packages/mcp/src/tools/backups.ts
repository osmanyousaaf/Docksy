import { z } from 'zod';
import type { App, BackupConfig, BackupRun } from '@docksy/shared';
import { seg } from '../api.ts';
import { defineTool } from '../registry.ts';
import { resolveApp } from '../resolve.ts';
import { ago, bytes, fence, table, tail } from '../format.ts';

function runLine(r: BackupRun): unknown[] {
  return [r.id, r.status, r.verified, bytes(r.sizeBytes), ago(r.startedAt), r.path];
}

export const listBackups = defineTool({
  name: 'list_backups',
  title: 'List backups',
  description:
    'List database backup configs (schedule, retention, destination, restore verification) with their most recent runs, including run ids and whether each was verified by a test restore. Use it to check backups exist before risky changes, or to pick a runId for restore_backup.',
  kind: 'read',
  input: {
    appId: z.string().optional().describe('Only backups of this database app (id or name).'),
    runs: z.number().int().min(0).max(20).optional().describe('Recent runs to include per backup (default 3, 0 = none).'),
  },
  async run({ appId, runs }, { api }) {
    const app = appId ? await resolveApp(api, appId) : null;
    const [{ items }, apps] = await Promise.all([
      api.get<{ items: BackupConfig[] }>('/backups', { appId: app?.id }),
      api.get<{ items: App[] }>('/apps').catch(() => ({ items: [] as App[] })),
    ]);
    const names = new Map(apps.items.map((a) => [a.id, a.name]));
    const n = runs ?? 3;
    const withRuns = await Promise.all(
      items.map(async (b) => {
        if (n === 0) return { ...b, recentRuns: [] as BackupRun[] };
        const r = await api.get<{ items: BackupRun[] } | BackupRun[]>(`/backups/${seg(b.id)}/runs`).catch(() => ({ items: [] as BackupRun[] }));
        const list = Array.isArray(r) ? r : r.items;
        const sorted = [...list].sort((x, y) => Date.parse(y.startedAt) - Date.parse(x.startedAt));
        return { ...b, recentRuns: sorted.slice(0, n) };
      }),
    );
    if (!items.length) {
      return {
        text: `No backups configured${app ? ` for ${app.name}` : ''}. Create one with \`create_backup\` (postgres, mysql, mariadb, mongodb and redis apps are supported).`,
        data: { items: [] },
      };
    }
    const out = [
      `## Backups (${items.length})`,
      '',
      table(
        ['id', 'app', 'schedule', 'keep', 'destination', 'verify', 'enabled', 'last run'],
        items.map((b) => [b.id, names.get(b.appId) ?? b.appId, b.schedule, b.retention, b.destination === 's3' && b.s3 ? `s3://${b.s3.bucket}/${b.s3.prefix}` : b.destination, b.verify ? 'yes' : 'no', b.enabled ? 'yes' : 'no', ago(b.lastRunAt)]),
      ),
    ];
    for (const b of withRuns) {
      if (!b.recentRuns.length) continue;
      out.push('', `### Recent runs of ${names.get(b.appId) ?? b.appId} (\`${b.id}\`)`, table(['run id', 'status', 'verified', 'size', 'started', 'path'], b.recentRuns.map(runLine)));
    }
    return { text: out.join('\n'), data: { items: withRuns } };
  },
});

export const createBackup = defineTool({
  name: 'create_backup',
  title: 'Create backup schedule',
  description:
    'Schedule automatic backups for a database app (postgres, mysql, mariadb, mongodb, redis). Dumps are stored on the server (or S3-compatible storage) and, with verify=true, test-restored into a throwaway container so you know they actually work. Use run_backup to take one immediately.',
  kind: 'write',
  input: {
    appId: z.string().min(1).describe('Database app id or name.'),
    schedule: z.enum(['hourly', 'daily', 'weekly']).optional().describe('Default "daily".'),
    retention: z.number().int().min(1).max(365).optional().describe('How many backups to keep (default 7).'),
    destination: z.enum(['local', 's3']).optional().describe('"local" (default): /var/lib/docksy/backups on the server. "s3": also upload to S3-compatible storage.'),
    s3: z
      .object({
        endpoint: z.string().describe('e.g. "https://s3.eu-central-1.amazonaws.com" or an R2/MinIO endpoint.'),
        bucket: z.string(),
        region: z.string().describe('e.g. "us-east-1" ("auto" for R2).'),
        accessKey: z.string(),
        secretKey: z.string().describe('Stored encrypted; never shown again.'),
        prefix: z.string().optional().describe('Key prefix, e.g. "docksy/".'),
      })
      .optional()
      .describe('Required when destination is "s3".'),
    verify: z.boolean().optional().describe('Test-restore each backup (default true).'),
  },
  async run(a, { api }) {
    const app = await resolveApp(api, a.appId);
    const backup = await api.post<BackupConfig>('/backups', {
      appId: app.id,
      schedule: a.schedule ?? 'daily',
      retention: a.retention ?? 7,
      destination: a.destination ?? 'local',
      s3: a.s3 ? { ...a.s3, prefix: a.s3.prefix ?? '' } : null,
      verify: a.verify ?? true,
      enabled: true,
    });
    return {
      text: `Backups for **${app.name}** scheduled ${backup.schedule}, keeping ${backup.retention} (\`${backup.id}\`). Take one now with \`run_backup {"backupId":"${backup.id}"}\`.`,
      data: { backup },
    };
  },
});

export const runBackup = defineTool({
  name: 'run_backup',
  title: 'Run backup now',
  description:
    'Take a backup right now (e.g. before a risky migration, upgrade or delete). Returns the run with its status; verification (if enabled) follows shortly after. Check results with list_backups.',
  kind: 'write',
  input: { backupId: z.string().min(1).describe('Backup config id (from list_backups or create_backup).') },
  async run({ backupId }, { api }) {
    const run = await api.post<BackupRun>(`/backups/${seg(backupId)}/run`);
    const lines = [`Backup run \`${run.id}\`: **${run.status}**${run.sizeBytes ? `, ${bytes(run.sizeBytes)}` : ''}${run.verified !== 'pending' ? `, verification ${run.verified}` : ''}.`];
    if (run.status === 'failed' && run.log) lines.push('', fence(tail(run.log, 3000)));
    return { text: lines.join('\n'), data: { run } };
  },
});

export const restoreBackup = defineTool({
  name: 'restore_backup',
  title: 'Restore backup',
  description:
    "Restore a database from a backup run, overwriting the database's current data with the backup's contents. Anything written since that backup is lost. Prefer runs with verified = passed (see list_backups), and suggest run_backup first so the current state can be recovered.",
  kind: 'destructive',
  input: { runId: z.string().min(1).describe('Backup run id to restore (from list_backups).') },
  async run({ runId }, { api }) {
    const res = await api.post<BackupRun | { ok: true }>(`/backup-runs/${seg(runId)}/restore`, { confirm: true });
    const status = res && typeof res === 'object' && 'status' in res ? ` (${res.status})` : '';
    return { text: `Restore from backup run \`${runId}\` started${status}. Check the app with get_app_logs once it finishes.`, data: { ok: true, runId, result: res } };
  },
});

export const backupTools = [listBackups, createBackup, runBackup, restoreBackup];
