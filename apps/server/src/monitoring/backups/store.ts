/** Backup rows ↔ API shapes, plus the encrypted S3 config. */
import type { BackupConfig, BackupRun } from '@docksy/shared';
import { db, iso, isoReq, bool, type Row } from '../../db/index.ts';
import { encrypt, decrypt } from '../../lib/crypto.ts';
import { notFound } from '../../lib/http.ts';
import { normPrefix, type S3Config } from './s3.ts';

/** Decrypted S3 config including the secret key (server-side use only). */
export function readS3(r: Row): S3Config | null {
  if (!r.s3_config_enc) return null;
  try {
    const c = JSON.parse(decrypt(r.s3_config_enc)) as S3Config;
    return { endpoint: c.endpoint, bucket: c.bucket, region: c.region || 'us-east-1', accessKey: c.accessKey, secretKey: c.secretKey, prefix: normPrefix(c.prefix) };
  } catch {
    return null; // DOCKSY_SECRET changed: the config can't be read any more
  }
}

export const writeS3 = (c: S3Config | null): string | null => (c ? encrypt(JSON.stringify({ ...c, prefix: normPrefix(c.prefix) })) : null);

/** The secret key is write-only: it is never part of an API response. */
export function toBackupConfig(r: Row): BackupConfig {
  const s3 = readS3(r);
  return {
    id: r.id,
    appId: r.app_id,
    schedule: r.schedule,
    retention: Number(r.retention),
    destination: r.destination === 's3' ? 's3' : 'local',
    s3: s3 ? { endpoint: s3.endpoint, bucket: s3.bucket, region: s3.region, accessKey: s3.accessKey, prefix: s3.prefix } : null,
    verify: bool(r.verify),
    enabled: bool(r.enabled),
    lastRunAt: iso(r.last_run_at),
    createdAt: isoReq(r.created_at),
  };
}

export const toBackupRun = (r: Row): BackupRun => ({
  id: r.id,
  backupId: r.backup_id,
  status: r.status,
  verified: r.verified,
  sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
  path: r.path ?? null,
  log: r.log ?? '',
  startedAt: isoReq(r.started_at),
  finishedAt: iso(r.finished_at),
});

export function getBackupRow(id: string): Row {
  const r = db.prepare('SELECT * FROM backups WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw notFound('Backup');
  return r;
}

export function getRunRow(id: string): Row {
  const r = db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw notFound('Backup run');
  return r;
}

export const getRun = (id: string): BackupRun => toBackupRun(getRunRow(id));
