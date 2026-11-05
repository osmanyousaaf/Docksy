import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from './engines.ts';

const SEL = '$(docker ps -q --filter label=docksy.app=app1 | head -n1)';

test('detectEngine: template first, then image name', () => {
  assert.equal(E.detectEngine('postgres', null), 'postgres');
  assert.equal(E.detectEngine('n8n', 'n8nio/n8n:1'), null);
  assert.equal(E.detectEngine(null, 'postgres:17'), 'postgres');
  assert.equal(E.detectEngine(null, 'docker.io/library/mariadb:11@sha256:abc'), 'mariadb');
  assert.equal(E.detectEngine(null, 'mysql:8.4'), 'mysql');
  assert.equal(E.detectEngine(null, 'mongo:8'), 'mongodb');
  assert.equal(E.detectEngine(null, 'registry.local:5000/redis:7'), 'redis');
  assert.equal(E.detectEngine(null, 'timescale/timescaledb:latest-pg16'), 'postgres');
  assert.equal(E.detectEngine(null, 'nginx:1'), null);
  assert.equal(E.detectEngine(null, null), null);
});

test('sourceConn reads template env names', () => {
  assert.deepEqual(E.sourceConn('postgres', { POSTGRES_USER: 'pg', POSTGRES_PASSWORD: 'pw' }), { user: 'pg', password: 'pw' });
  assert.deepEqual(E.sourceConn('postgres', {}), { user: 'postgres', password: '' });
  assert.deepEqual(E.sourceConn('mysql', { MYSQL_ROOT_PASSWORD: 'r', MYSQL_USER: 'app' }), { user: 'root', password: 'r' });
  assert.deepEqual(E.sourceConn('mariadb', { MARIADB_ROOT_PASSWORD: 'm' }), { user: 'root', password: 'm' });
  assert.deepEqual(E.sourceConn('mysql', { MYSQL_USER: 'app', MYSQL_PASSWORD: 'p' }), { user: 'app', password: 'p' });
  assert.deepEqual(E.sourceConn('mongodb', { MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: 'x' }), { user: 'root', password: 'x' });
  assert.deepEqual(E.sourceConn('redis', { REDIS_PASSWORD: 'rp' }), { user: '', password: 'rp' });
});

test('verifyConn: reuse source creds for SQL, none for mongo/redis', () => {
  assert.deepEqual(E.verifyConn('postgres', { user: 'pg', password: '' }, 'fb'), { user: 'pg', password: 'fb' });
  assert.deepEqual(E.verifyConn('mysql', { user: 'root', password: 'r' }, 'fb'), { user: 'root', password: 'r' });
  assert.deepEqual(E.verifyConn('mysql', { user: 'app', password: 'p' }, 'fb'), { user: 'root', password: 'fb' });
  assert.deepEqual(E.verifyConn('mongodb', { user: 'root', password: 'x' }, 'fb'), { user: '', password: '' });
});

test('postgres dump/restore commands', () => {
  const c = { user: 'postgres', password: 's3cret' };
  const d = E.dumpCommand('postgres', '"$C"', c);
  assert.match(d, /^docker exec -e 'PGPASSWORD=s3cret' "\$C" pg_dumpall -U 'postgres' --clean --if-exists$/);
  const r = E.restoreCommand('postgres', '"$C"', c, { drop: true });
  assert.match(r, /docker exec -i -e 'PGPASSWORD=s3cret' "\$C" psql -X -q -U 'postgres' -d postgres/);
  assert.match(E.sanityCommand('postgres', "'n'", c), /pg_database WHERE NOT datistemplate/);
  assert.match(E.probeCommand('postgres', "'n'", c), /pg_isready -q -h 127\.0\.0\.1/);
});

test('mysql/mariadb use the right binaries and MYSQL_PWD', () => {
  const c = { user: 'root', password: 'pw' };
  const my = E.dumpCommand('mysql', '"$C"', c);
  assert.ok(my.includes("-e 'MYSQL_PWD=pw'"));
  assert.ok(my.includes('for b in mysqldump mariadb-dump'));
  assert.ok(my.includes("'--all-databases'") && my.includes("'--single-transaction'") && my.includes("'--routines'"));
  assert.ok(!my.includes("'-ppw'"), 'password must not be on argv');
  const ma = E.dumpCommand('mariadb', '"$C"', c);
  assert.ok(ma.includes('for b in mariadb-dump mysqldump'));
  assert.ok(E.restoreCommand('mariadb', '"$C"', c, { drop: true }).includes('for b in mariadb mysql'));
  assert.ok(E.sanityCommand('mysql', "'n'", c).includes('information_schema.SCHEMATA'));
  // non-root users can't dump events/routines
  assert.ok(!E.dumpCommand('mysql', '"$C"', { user: 'app', password: 'p' }).includes('--events'));
});

test('mongodb uses archive dump/restore with admin auth', () => {
  const c = { user: 'root', password: 'pw' };
  const d = E.dumpCommand('mongodb', '"$C"', c);
  assert.equal(d, `docker exec "$C" mongodump --archive --quiet '--username' 'root' '--password' 'pw' '--authenticationDatabase' 'admin'`);
  assert.ok(E.restoreCommand('mongodb', '"$C"', c, { drop: true }).includes('mongorestore --archive --quiet --drop'));
  assert.ok(!E.restoreCommand('mongodb', "'n'", { user: '', password: '' }, { drop: false }).includes('--drop'));
  assert.ok(E.sanityCommand('mongodb', "'n'", { user: '', password: '' }).includes('db.stats()'));
});

test('redis dump: BGSAVE, wait on LASTSAVE, cat dump.rdb', () => {
  const d = E.dumpCommand('redis', '"$C"', { user: '', password: 'rp' });
  assert.ok(d.includes("docker exec -e 'REDISCLI_AUTH=rp' \"$C\" redis-cli BGSAVE"));
  assert.ok(d.includes('LASTSAVE'));
  assert.ok(d.includes('docker exec "$C" cat "$D/$N"'));
  assert.ok(!E.dumpCommand('redis', '"$C"', { user: '', password: '' }).includes('REDISCLI_AUTH'));
  assert.throws(() => E.restoreCommand('redis', '"$C"', { user: '', password: '' }, { drop: true }));
  assert.ok(E.redisReplicateCommand('"$C"', { user: '', password: '' }, 'dx-restore-1').includes("REPLICAOF 'dx-restore-1' 6379"));
});

test('dumpScript: container check, gzip to .part, integrity checks, size', () => {
  const s = E.dumpScript('postgres', SEL, { user: 'postgres', password: '' }, '/var/lib/docksy/backups/db/20261101T120000Z.gz');
  assert.ok(s.startsWith(`C=${SEL}\n`));
  assert.ok(s.includes('No running container'));
  assert.ok(s.includes("mkdir -p '/var/lib/docksy/backups/db'"));
  assert.ok(s.includes("| gzip -c > '/var/lib/docksy/backups/db/20261101T120000Z.gz.part'"));
  assert.ok(s.includes('gzip -t'));
  assert.ok(s.trim().endsWith("stat -c %s '/var/lib/docksy/backups/db/20261101T120000Z.gz'"));
});

test('throwaway containers', () => {
  const pg = E.startThrowawayCommand('postgres', { name: 'dx-verify-abcd1234', image: 'postgres:17', conn: { user: 'postgres', password: 'x' }, file: '/f.gz' });
  assert.ok(pg.includes("docker run -d --name 'dx-verify-abcd1234' --label docksy.verify=true -e 'POSTGRES_USER=postgres' -e 'POSTGRES_PASSWORD=x' 'postgres:17'"));
  const rd = E.startThrowawayCommand('redis', { name: 'dx-restore-1', image: 'redis:7', conn: { user: '', password: '' }, file: '/f.gz', network: 'docksy' });
  assert.ok(rd.includes("--network 'docksy'"));
  assert.ok(rd.includes("gunzip -c '/f.gz' > '/tmp/dx-restore-1.rdb'"));
  assert.ok(rd.includes("docker cp '/tmp/dx-restore-1.rdb' 'dx-restore-1':/data/dump.rdb"));
  assert.ok(rd.includes('--appendonly no'));
  const w = E.waitReadyCommand('mysql', 'dx-verify-1', { user: 'root', password: 'p' }, 60);
  assert.ok(w.includes('ping') && w.includes('-ge 60'));
  assert.equal(E.cleanupCommand('dx-verify-1'), "docker rm -fv 'dx-verify-1' >/dev/null 2>&1; rm -f '/tmp/dx-verify-1.rdb'; true");
});

test('parseSanity', () => {
  assert.deepEqual(E.parseSanity('postgres', '2\n'), { ok: true, value: 2, detail: '2 databases' });
  assert.equal(E.parseSanity('postgres', '0').ok, false);
  assert.equal(E.parseSanity('redis', '0').ok, true);
  assert.equal(E.parseSanity('redis', '(integer) 42').value, 42);
  assert.equal(E.parseSanity('mongodb', 'MongoServerError: auth failed').ok, false);
  assert.equal(E.parseSanity('mysql', '').ok, false);
});

test('restoreErrors ignores harmless pg_dumpall noise', () => {
  const stderr = [
    'ERROR:  role "postgres" already exists',
    'ERROR:  current user cannot be dropped',
    'ERROR:  syntax error at or near "garbage"',
  ].join('\n');
  assert.deepEqual(E.restoreErrors('postgres', stderr), ['ERROR:  syntax error at or near "garbage"']);
  assert.deepEqual(E.restoreErrors('mysql', stderr), []);
});

test('naming', () => {
  assert.equal(E.isoStamp(Date.UTC(2026, 10, 1, 12, 0, 5, 123)), '20261101T120005Z');
  assert.equal(E.backupFile('db', Date.UTC(2026, 10, 1, 12, 0, 5)), '/var/lib/docksy/backups/db/20261101T120005Z.gz');
  assert.equal(E.verifyName('1a2b3c4d-5555-6666'), 'dx-verify-1a2b3c4d');
  assert.ok(E.STAMP_FILE_RE.test('20261101T120005Z.gz'));
});
