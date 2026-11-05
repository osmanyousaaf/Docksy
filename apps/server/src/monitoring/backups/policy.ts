/** Pure scheduling + retention logic for backups (unit-tested, no I/O). */
import type { BackupConfig } from '@docksy/shared';
import { STAMP_FILE_RE } from './engines.ts';

export type Schedule = BackupConfig['schedule'];

export const SCHEDULE_MS: Record<Schedule, number> = {
  hourly: 3_600_000,
  daily: 86_400_000,
  weekly: 7 * 86_400_000,
};

/** The scheduler ticks every 60s; this slack keeps runs from drifting a minute later each time. */
export const SCHEDULE_SLACK_MS = 30_000;

/** Is a backup due? Never-run backups are due right away. */
export function isDue(schedule: Schedule, lastRunAt: number | null | undefined, nowMs: number): boolean {
  if (lastRunAt == null) return true;
  const every = SCHEDULE_MS[schedule] ?? SCHEDULE_MS.daily;
  return nowMs - Number(lastRunAt) >= every - SCHEDULE_SLACK_MS;
}

export interface RunFile { id: string; path: string; startedAt: number }

/** Keep the newest `retention` runs that still have a file; return the ones to prune (newest first). */
export function selectPrune<T extends RunFile>(runs: T[], retention: number): T[] {
  const keep = Math.max(1, Math.floor(retention));
  return [...runs].filter((r) => !!r.path).sort((a, b) => b.startedAt - a.startedAt).slice(keep);
}

/**
 * S3 retention: among keys that look like Docksy backup files (`…/<ISO basic>.gz`), keep the newest
 * `retention` (the timestamped names sort chronologically) and return the rest. Other objects in the
 * bucket are never touched.
 */
export function selectS3Prune(keys: string[], retention: number): string[] {
  const keep = Math.max(1, Math.floor(retention));
  const ours = keys.filter((k) => STAMP_FILE_RE.test(k.slice(k.lastIndexOf('/') + 1)));
  const byName = (k: string) => k.slice(k.lastIndexOf('/') + 1);
  return ours.sort((a, b) => (byName(a) < byName(b) ? 1 : byName(a) > byName(b) ? -1 : 0)).slice(keep);
}
