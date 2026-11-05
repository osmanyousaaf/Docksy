/**
 * Test-only setup for core/deploy tests. Import FIRST (before anything touching db):
 * it points the DB at :memory: and the data dir at a temp folder.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOCKSY_DB_PATH = ':memory:';
process.env.DOCKSY_DISABLE_JOBS = '1';
process.env.DOCKSY_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'docksy-deploy-test-'));
process.env.DOCKSY_SECRET ??= 'a'.repeat(64);
