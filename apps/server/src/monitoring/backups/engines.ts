/**
 * Per-engine shell command builders for backups (pure: no I/O, no DB).
 *
 * Every builder returns a POSIX/bash snippet that the runner executes on the app's server over SSH
 * (wrapped in `bash -c` with `set -o pipefail`). Container references are passed in as shell words,
 * e.g. `"$C"` (a variable the script set from `containerSelector(appId)`) or `q('dx-verify-1a2b3c4d')`.
 *
 * Secrets: passwords are handed to tools through `docker exec -e VAR=…` (PGPASSWORD, MYSQL_PWD,
 * REDISCLI_AUTH) so they never appear in the tool's own argv inside the container. The runner redacts
 * them from anything it logs.
 */
/** POSIX shell single-quoting (same as lib/ssh.ts `q`; kept local so this module stays pure). */
export const q = (arg: string): string => `'${String(arg).replace(/'/g, `'\\''`)}'`;

export type Engine = 'postgres' | 'mysql' | 'mariadb' | 'mongodb' | 'redis';
export const ENGINES: readonly Engine[] = ['postgres', 'mysql', 'mariadb', 'mongodb', 'redis'];

/** Credentials used to talk to a database. Empty strings mean "none". */
export interface Conn { user: string; password: string }

/** Root directory for backup files on each server (CONTRACT.md §6). */
export const BACKUP_ROOT = '/var/lib/docksy/backups';

// ───────────────────────────── detection + credentials ─────────────────────────────

/** Figure out the engine from the app's template id, falling back to its image name. */
export function detectEngine(template: string | null | undefined, image: string | null | undefined): Engine | null {
  if (template && (ENGINES as readonly string[]).includes(template)) return template as Engine;
  if (!image) return null;
  const noDigest = image.split('@')[0];
  const repo = (noDigest.replace(/:[^/]*$/, '').split('/').pop() ?? '').toLowerCase();
  if (/^(postgres|postgis|timescaledb(-ha)?|pgvector)$/.test(repo)) return 'postgres';
  if (repo === 'mariadb') return 'mariadb';
  if (/^(mysql|mysql-server|percona-server)$/.test(repo)) return 'mysql';
  if (/^(mongo|mongodb-community-server)$/.test(repo)) return 'mongodb';
  if (/^(redis|redis-stack-server)$/.test(repo)) return 'redis';
  return null;
}

/** Credentials for the app's own database, read from the app env (as set by the templates). */
export function sourceConn(engine: Engine, env: Record<string, string>): Conn {
  switch (engine) {
    case 'postgres':
      return { user: env.POSTGRES_USER || 'postgres', password: env.POSTGRES_PASSWORD ?? '' };
    case 'mysql':
    case 'mariadb': {
      const rootPw = env.MARIADB_ROOT_PASSWORD || env.MYSQL_ROOT_PASSWORD;
      if (rootPw) return { user: 'root', password: rootPw };
      const user = env.MARIADB_USER || env.MYSQL_USER;
      if (user) return { user, password: env.MARIADB_PASSWORD || env.MYSQL_PASSWORD || '' };
      return { user: 'root', password: '' };
    }
    case 'mongodb':
      return { user: env.MONGO_INITDB_ROOT_USERNAME ?? '', password: env.MONGO_INITDB_ROOT_PASSWORD ?? '' };
    case 'redis':
      return { user: '', password: env.REDIS_PASSWORD || env.REDIS_AUTH || '' };
  }
}

/**
 * Credentials inside the throwaway verify container. Postgres/MySQL reuse the source credentials, so
 * grants restored from the dump keep working; MongoDB and Redis run without auth (nothing is exposed:
 * no ports are published and the container is removed right after).
 */
export function verifyConn(engine: Engine, src: Conn, fallbackPassword: string): Conn {
  switch (engine) {
    case 'postgres':
      return { user: src.user, password: src.password || fallbackPassword };
    case 'mysql':
    case 'mariadb':
      return { user: 'root', password: src.user === 'root' && src.password ? src.password : fallbackPassword };
    case 'mongodb':
    case 'redis':
      return { user: '', password: '' };
  }
}

// ───────────────────────────── helpers ─────────────────────────────

const envFlag = (k: string, v: string) => `-e ${q(`${k}=${v}`)}`;

/** `sh -c` wrapper that execs the first binary that exists (mariadb-dump vs mysqldump, mongosh vs mongo). */
export function tool(bins: string[], args: string[]): string {
  const script = `for b in ${bins.join(' ')}; do if command -v "$b" >/dev/null 2>&1; then exec "$b" "$@"; fi; done; echo "none of ${bins.join(', ')} is installed in the container" >&2; exit 127`;
  return `sh -c ${q(script)} sh${args.length ? ' ' + args.map(q).join(' ') : ''}`;
}

const pgEnv = (c: Conn) => (c.password ? envFlag('PGPASSWORD', c.password) + ' ' : '');
const myEnv = (c: Conn) => (c.password ? envFlag('MYSQL_PWD', c.password) + ' ' : '');
const redisEnv = (c: Conn) => (c.password ? envFlag('REDISCLI_AUTH', c.password) + ' ' : '');
const mongoAuth = (c: Conn) => (c.user ? ['--username', c.user, '--password', c.password, '--authenticationDatabase', 'admin'] : []);
const myDumpBins = (e: Engine) => (e === 'mariadb' ? ['mariadb-dump', 'mysqldump'] : ['mysqldump', 'mariadb-dump']);
const myClientBins = (e: Engine) => (e === 'mariadb' ? ['mariadb', 'mysql'] : ['mysql', 'mariadb']);
const myAdminBins = (e: Engine) => (e === 'mariadb' ? ['mariadb-admin', 'mysqladmin'] : ['mysqladmin', 'mariadb-admin']);
const mongoShell = ['mongosh', 'mongo'];

// ───────────────────────────── dump ─────────────────────────────

/** Command that writes the raw (uncompressed) dump of the whole database server to stdout. */
export function dumpCommand(engine: Engine, ctr: string, c: Conn): string {
  switch (engine) {
    case 'postgres':
      return `docker exec ${pgEnv(c)}${ctr} pg_dumpall -U ${q(c.user)} --clean --if-exists`;
    case 'mysql':
    case 'mariadb': {
      const args = [`-u${c.user}`, '--all-databases', '--single-transaction', '--quick', '--hex-blob', '--triggers'];
      if (c.user === 'root') args.push('--routines', '--events');
      return `docker exec ${myEnv(c)}${ctr} ${tool(myDumpBins(engine), args)}`;
    }
    case 'mongodb':
      return `docker exec ${ctr} mongodump --archive --quiet${mongoAuth(c).map((a) => ' ' + q(a)).join('')}`;
    case 'redis': {
      // BGSAVE, wait for LASTSAVE to move, then stream dump.rdb out of the data dir.
      const r = `docker exec ${redisEnv(c)}${ctr} redis-cli`;
      return [
        '(',
        `  B=$(${r} LASTSAVE) || { echo "could not reach redis" >&2; exit 1; }`,
        `  ${r} BGSAVE >/dev/null 2>&1`,
        '  i=0',
        `  while [ "$(${r} LASTSAVE)" = "$B" ]; do`,
        '    i=$((i+1)); if [ $i -ge 600 ]; then echo "redis BGSAVE did not finish within 600s" >&2; exit 1; fi; sleep 1',
        '  done',
        `  D=$(${r} CONFIG GET dir 2>/dev/null | tail -n1); [ -n "$D" ] || D=/data`,
        `  N=$(${r} CONFIG GET dbfilename 2>/dev/null | tail -n1); [ -n "$N" ] || N=dump.rdb`,
        `  docker exec ${ctr} cat "$D/$N"`,
        ')',
      ].join('\n');
    }
  }
}

/**
 * Full dump script: find the app container, dump → gzip into `<file>.part`, check the archive,
 * move into place and print the size in bytes as the last stdout line.
 */
export function dumpScript(engine: Engine, selector: string, c: Conn, file: string): string {
  const dir = file.slice(0, file.lastIndexOf('/'));
  const part = q(`${file}.part`);
  return [
    `C=${selector}`,
    'if [ -z "$C" ]; then echo "No running container found for this app. Start it, then try again." >&2; exit 3; fi',
    `mkdir -p ${q(dir)}`,
    `${dumpCommand(engine, '"$C"', c)} | gzip -c > ${part}`,
    'rc=$?',
    `if [ $rc -ne 0 ]; then rm -f ${part}; echo "the dump command failed (exit $rc)" >&2; exit $rc; fi`,
    `if ! gzip -t ${part}; then rm -f ${part}; echo "the dump archive is corrupt" >&2; exit 4; fi`,
    `if [ "$(gzip -dc ${part} | head -c 1 | wc -c)" -eq 0 ]; then rm -f ${part}; echo "the dump came out empty" >&2; exit 5; fi`,
    `mv -f ${part} ${q(file)}`,
    `stat -c %s ${q(file)}`,
  ].join('\n');
}

// ───────────────────────────── restore ─────────────────────────────

/** Command that reads a raw dump on stdin and loads it into the database in `ctr`. */
export function restoreCommand(engine: Engine, ctr: string, c: Conn, o: { drop: boolean }): string {
  switch (engine) {
    case 'postgres':
      return `docker exec -i ${pgEnv(c)}${ctr} psql -X -q -U ${q(c.user)} -d postgres -v ON_ERROR_STOP=0 >/dev/null`;
    case 'mysql':
    case 'mariadb':
      return `docker exec -i ${myEnv(c)}${ctr} ${tool(myClientBins(engine), [`-u${c.user}`])}`;
    case 'mongodb':
      return `docker exec -i ${ctr} mongorestore --archive --quiet${o.drop ? ' --drop' : ''}${mongoAuth(c).map((a) => ' ' + q(a)).join('')}`;
    case 'redis':
      throw new Error('redis restores go through redisStartFromDump + redisReplicateCommand');
  }
}

/** Live postgres restore: drop other sessions first so `DROP DATABASE` in the dump can succeed. */
export function pgTerminateCommand(ctr: string, c: Conn): string {
  const sql = 'SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname IS NOT NULL';
  return `docker exec ${pgEnv(c)}${ctr} psql -X -q -U ${q(c.user)} -d postgres -tAc ${q(sql)} >/dev/null`;
}

/**
 * psql keeps going after errors (a pg_dumpall restore always hits a few harmless ones, like
 * "role postgres already exists"). Return the errors that are not harmless.
 */
export function restoreErrors(engine: Engine, stderr: string): string[] {
  if (engine !== 'postgres') return [];
  const benign = /already exists|does not exist|cannot be dropped|current user cannot|is being accessed by other users|cannot drop the currently open database/;
  return stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /\bERROR:/.test(l) && !benign.test(l));
}

// ───────────────────────────── readiness + sanity ─────────────────────────────

/** A probe that exits 0 once the database in `ctr` accepts connections. */
export function probeCommand(engine: Engine, ctr: string, c: Conn): string {
  switch (engine) {
    case 'postgres':
      // -h 127.0.0.1: the image's init-time server only listens on the socket, so TCP means "really up".
      return `docker exec ${ctr} pg_isready -q -h 127.0.0.1 -U ${q(c.user)}`;
    case 'mysql':
    case 'mariadb':
      return `docker exec ${myEnv(c)}${ctr} ${tool(myAdminBins(engine), ['ping', '-h', '127.0.0.1', `-u${c.user}`, '--silent'])}`;
    case 'mongodb':
      return `docker exec ${ctr} ${tool(mongoShell, ['--quiet', ...mongoAuth(c), '--eval', 'db.adminCommand("ping").ok'])}`;
    case 'redis':
      return `[ "$(docker exec ${redisEnv(c)}${ctr} redis-cli ping 2>/dev/null)" = PONG ]`;
  }
}

/** Sanity query; prints a single integer (database count, or DBSIZE for redis). */
export function sanityCommand(engine: Engine, ctr: string, c: Conn): string {
  switch (engine) {
    case 'postgres':
      return `docker exec ${pgEnv(c)}${ctr} psql -X -U ${q(c.user)} -d postgres -tAc ${q('SELECT count(*) FROM pg_database WHERE NOT datistemplate')}`;
    case 'mysql':
    case 'mariadb':
      return `docker exec ${myEnv(c)}${ctr} ${tool(myClientBins(engine), [`-u${c.user}`, '-N', '-B', '-e', 'SELECT COUNT(*) FROM information_schema.SCHEMATA'])}`;
    case 'mongodb':
      return `docker exec ${ctr} ${tool(mongoShell, ['--quiet', ...mongoAuth(c), '--eval', 'var s = db.stats(); print(s.ok == 1 ? db.adminCommand({ listDatabases: 1 }).databases.length : -1)'])}`;
    case 'redis':
      return `docker exec ${redisEnv(c)}${ctr} redis-cli DBSIZE`;
  }
}

export interface SanityResult { ok: boolean; value: number | null; detail: string }

/** What the sanity number means, for humans. */
export const sanityLabel = (engine: Engine): string => (engine === 'redis' ? 'keys' : 'databases');

/** Parse the sanity output. Databases must be ≥ 1; a redis key count just has to be a number. */
export function parseSanity(engine: Engine, stdout: string): SanityResult {
  const last = stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const m = /^(?:\(integer\)\s*)?(-?\d+)$/.exec(last);
  if (!m) return { ok: false, value: null, detail: `unexpected sanity output: ${last.slice(0, 200) || '(empty)'}` };
  const value = Number(m[1]);
  const min = engine === 'redis' ? 0 : 1;
  const ok = value >= min;
  return { ok, value, detail: ok ? `${value} ${sanityLabel(engine)}` : `sanity check returned ${value} ${sanityLabel(engine)}` };
}

// ───────────────────────────── throwaway containers ─────────────────────────────

export interface ThrowawayOpts {
  name: string; // dx-verify-<run8> / dx-restore-<run8>
  image: string;
  conn: Conn; // from verifyConn()
  file: string; // gz dump on the server
  network?: string; // attach to this docker network (redis live restore needs `docksy`)
}

const tmpRdb = (name: string) => `/tmp/${name}.rdb`;

/** Start a throwaway database container of the same image. Redis is started from the dump itself. */
export function startThrowawayCommand(engine: Engine, o: ThrowawayOpts): string {
  const n = q(o.name);
  const base = `--name ${n} --label docksy.verify=true${o.network ? ` --network ${q(o.network)}` : ''}`;
  const clean = `docker rm -fv ${n} >/dev/null 2>&1`;
  switch (engine) {
    case 'postgres':
      return `${clean}; docker run -d ${base} ${envFlag('POSTGRES_USER', o.conn.user)} ${envFlag('POSTGRES_PASSWORD', o.conn.password)} ${q(o.image)} >/dev/null`;
    case 'mysql':
    case 'mariadb':
      return `${clean}; docker run -d ${base} ${envFlag('MYSQL_ROOT_PASSWORD', o.conn.password)} ${envFlag('MARIADB_ROOT_PASSWORD', o.conn.password)} ${q(o.image)} >/dev/null`;
    case 'mongodb':
      return `${clean}; docker run -d ${base} ${q(o.image)} >/dev/null`;
    case 'redis': {
      const t = q(tmpRdb(o.name));
      return [
        clean,
        `gunzip -c ${q(o.file)} > ${t} || exit 1`,
        `docker create ${base} ${q(o.image)} redis-server --dir /data --dbfilename dump.rdb --appendonly no --protected-mode no >/dev/null || exit 1`,
        `docker cp ${t} ${n}:/data/dump.rdb || exit 1`,
        `docker start ${n} >/dev/null`,
      ].join('\n');
    }
  }
}

/** Wait (up to `seconds`) until the throwaway database is ready; fail fast if the container dies. */
export function waitReadyCommand(engine: Engine, name: string, c: Conn, seconds = 180): string {
  const n = q(name);
  return [
    'i=0',
    `until ${probeCommand(engine, n, c)} >/dev/null 2>&1; do`,
    '  i=$((i+1))',
    `  if [ "$(docker inspect -f '{{.State.Running}}' ${n} 2>/dev/null)" != "true" ]; then echo "the verify container stopped unexpectedly:" >&2; docker logs --tail 30 ${n} >&2 2>&1; exit 1; fi`,
    `  if [ $i -ge ${seconds} ]; then echo "the database did not become ready within ${seconds}s:" >&2; docker logs --tail 30 ${n} >&2 2>&1; exit 1; fi`,
    '  sleep 1',
    'done',
  ].join('\n');
}

/** Always-run cleanup for a throwaway container (removes its anonymous volumes too). */
export function cleanupCommand(name: string): string {
  return `docker rm -fv ${q(name)} >/dev/null 2>&1; rm -f ${q(tmpRdb(name))}; true`;
}

/**
 * Live redis restore without restarting the app: make the app's redis a replica of the throwaway
 * instance (which loaded the dump), wait for the full sync, then promote it back. Works with AOF on.
 */
export function redisReplicateCommand(ctr: string, c: Conn, masterHost: string, seconds = 900): string {
  const r = `docker exec ${redisEnv(c)}${ctr} redis-cli`;
  return [
    `${r} REPLICAOF ${q(masterHost)} 6379 >/dev/null || exit 1`,
    'i=0',
    'while :; do',
    `  INFO=$(${r} INFO replication | tr -d '\\r')`,
    '  case "$INFO" in *master_link_status:up*) case "$INFO" in *master_sync_in_progress:0*) break;; esac;; esac',
    '  i=$((i+1))',
    `  if [ $i -ge ${seconds} ]; then ${r} REPLICAOF NO ONE >/dev/null; echo "redis did not finish syncing within ${seconds}s" >&2; exit 1; fi`,
    '  sleep 1',
    'done',
    `${r} REPLICAOF NO ONE >/dev/null`,
    `${r} DBSIZE`,
  ].join('\n');
}

/** Print the image of the app's running container (empty when none is running). */
export function imageOfCommand(selector: string): string {
  return `C=${selector}; if [ -n "$C" ]; then docker inspect -f '{{.Config.Image}}' "$C"; fi`;
}

// ───────────────────────────── naming ─────────────────────────────

/** ISO 8601 basic UTC timestamp, safe in file names and S3 keys: 20261101T120000Z */
export const isoStamp = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');

export const STAMP_FILE_RE = /^\d{8}T\d{6}Z\.gz$/;

export const backupDir = (appName: string): string => `${BACKUP_ROOT}/${appName}`;
export const backupFile = (appName: string, ms: number): string => `${backupDir(appName)}/${isoStamp(ms)}.gz`;
export const verifyName = (runId: string): string => `dx-verify-${runId.slice(0, 8)}`;
export const restoreName = (runId: string): string => `dx-restore-${runId.slice(0, 8)}`;
