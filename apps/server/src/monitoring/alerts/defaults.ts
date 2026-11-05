import type { AlertMetric, Severity } from '@docksy/shared';
import { db, now, newId, tx, type Row } from '../../db/index.ts';

/** Monitoring on by default: these global rules exist out of the box (CONTRACT.md §4.2). */
export interface DefaultRule { name: string; metric: AlertMetric; op: '>' | '<'; threshold: number; durationSec: number; severity: Severity }

export const DEFAULT_RULES: DefaultRule[] = [
  { name: 'CPU above 90% for 5m', metric: 'cpu', op: '>', threshold: 90, durationSec: 300, severity: 'warning' },
  { name: 'Memory above 90% for 5m', metric: 'mem', op: '>', threshold: 90, durationSec: 300, severity: 'critical' },
  { name: 'Disk above 85%', metric: 'disk', op: '>', threshold: 85, durationSec: 0, severity: 'warning' },
  { name: 'Disk above 95%', metric: 'disk', op: '>', threshold: 95, durationSec: 0, severity: 'critical' },
  { name: 'Server offline for 2m', metric: 'server_offline', op: '>', threshold: 0, durationSec: 120, severity: 'critical' },
  { name: 'Container down', metric: 'container_down', op: '>', threshold: 0, durationSec: 0, severity: 'critical' },
  { name: 'Container restarted more than 3 times in 10m', metric: 'container_restarts', op: '>', threshold: 3, durationSec: 600, severity: 'warning' },
  { name: 'Deploy failed', metric: 'deploy_failed', op: '>', threshold: 0, durationSec: 0, severity: 'warning' },
  { name: 'Uptime check down', metric: 'uptime_down', op: '>', threshold: 0, durationSec: 0, severity: 'critical' },
  { name: 'Backup failed', metric: 'backup_failed', op: '>', threshold: 0, durationSec: 0, severity: 'critical' },
];

/** Insert the default rules when no default rules exist yet. Returns how many were inserted. */
export function seedDefaultRules(): number {
  const n = Number((db.prepare('SELECT COUNT(*) AS n FROM alert_rules WHERE is_default = 1').get() as Row).n);
  if (n > 0) return 0;
  const t = now();
  const ins = db.prepare(`INSERT INTO alert_rules (id, name, metric, op, threshold, duration_sec, severity, server_id, app_id, channel_ids, enabled, is_default, created_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, '[]', 1, 1, ?)`);
  tx(() => DEFAULT_RULES.forEach((r, i) => ins.run(newId(), r.name, r.metric, r.op, r.threshold, r.durationSec, r.severity, t + i)));
  return DEFAULT_RULES.length;
}
