// Imported first by the alerts tests: must run before db/config/crypto are evaluated.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOCKSY_DB_PATH = ':memory:';
process.env.DOCKSY_DISABLE_JOBS = '1';
process.env.DOCKSY_SECRET ??= 'a'.repeat(64);
process.env.DOCKSY_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'docksy-alerts-test-'));
