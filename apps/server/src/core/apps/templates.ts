import type { Template } from '@docksy/shared';

/**
 * One-click templates (single container each). Owned by core-apps.
 *
 * Env placeholders, resolved once when the app is created (see expand.ts):
 *   {{random:N}}  N random alphanumerics (fresh value per occurrence)
 *   {{domain}}    the app's primary domain (or the default sslip.io domain)
 *
 * Images are pinned to a major (or exact) version so a redeploy never jumps majors.
 * Databases are not routed through the proxy; they're reachable on the `docksy` network only.
 *
 * Plausible is intentionally omitted: it needs ClickHouse + PostgreSQL alongside it,
 * which doesn't fit the single-container template model.
 */
export const TEMPLATES: Template[] = [
  // ── databases ──
  {
    id: 'postgres',
    name: 'PostgreSQL',
    kind: 'database',
    description: 'PostgreSQL 17, the reliable relational database. Backups use pg_dumpall.',
    image: 'postgres:17',
    port: 5432,
    volumes: [{ name: 'data', mountPath: '/var/lib/postgresql/data' }],
    env: {
      POSTGRES_USER: 'postgres',
      POSTGRES_PASSWORD: '{{random:32}}',
      POSTGRES_DB: 'app',
      PGDATA: '/var/lib/postgresql/data/pgdata',
    },
    backupSupported: true,
  },
  {
    id: 'mysql',
    name: 'MySQL',
    kind: 'database',
    description: 'MySQL 8.4 LTS. Backups use mysqldump --all-databases.',
    image: 'mysql:8.4',
    port: 3306,
    volumes: [{ name: 'data', mountPath: '/var/lib/mysql' }],
    env: {
      MYSQL_ROOT_PASSWORD: '{{random:32}}',
      MYSQL_DATABASE: 'app',
      MYSQL_USER: 'app',
      MYSQL_PASSWORD: '{{random:32}}',
    },
    backupSupported: true,
  },
  {
    id: 'mariadb',
    name: 'MariaDB',
    kind: 'database',
    description: 'MariaDB 11, the community fork of MySQL. Backups use mysqldump --all-databases.',
    image: 'mariadb:11',
    port: 3306,
    volumes: [{ name: 'data', mountPath: '/var/lib/mysql' }],
    env: {
      MARIADB_ROOT_PASSWORD: '{{random:32}}',
      MARIADB_DATABASE: 'app',
      MARIADB_USER: 'app',
      MARIADB_PASSWORD: '{{random:32}}',
    },
    backupSupported: true,
  },
  {
    id: 'redis',
    name: 'Redis',
    kind: 'database',
    description: 'Redis 7 with append-only persistence and a password. Backups use BGSAVE + dump.rdb.',
    image: 'redis:7',
    port: 6379,
    volumes: [{ name: 'data', mountPath: '/data' }],
    env: {
      REDIS_PASSWORD: '{{random:32}}',
    },
    backupSupported: true,
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    kind: 'database',
    description: 'MongoDB 8 document database. Backups use mongodump --archive.',
    image: 'mongo:8',
    port: 27017,
    volumes: [{ name: 'data', mountPath: '/data/db' }],
    env: {
      MONGO_INITDB_ROOT_USERNAME: 'root',
      MONGO_INITDB_ROOT_PASSWORD: '{{random:32}}',
    },
    backupSupported: true,
  },

  // ── services ──
  {
    id: 'n8n',
    name: 'n8n',
    kind: 'service',
    description: 'Workflow automation with 400+ integrations. Uses built-in SQLite storage.',
    image: 'n8nio/n8n:2.10.2',
    port: 5678,
    volumes: [{ name: 'data', mountPath: '/home/node/.n8n' }],
    env: {
      N8N_HOST: '{{domain}}',
      N8N_PROTOCOL: 'https',
      N8N_PORT: '5678',
      WEBHOOK_URL: 'https://{{domain}}/',
      N8N_EDITOR_BASE_URL: 'https://{{domain}}/',
      N8N_ENCRYPTION_KEY: '{{random:32}}',
      N8N_PROXY_HOPS: '1',
      GENERIC_TIMEZONE: 'UTC',
      TZ: 'UTC',
    },
    backupSupported: false,
  },
  {
    id: 'uptime-kuma',
    name: 'Uptime Kuma',
    kind: 'service',
    description: 'Self-hosted status monitoring with a friendly UI.',
    image: 'louislam/uptime-kuma:2',
    port: 3001,
    volumes: [{ name: 'data', mountPath: '/app/data' }],
    env: {},
    backupSupported: false,
  },
  {
    id: 'umami',
    name: 'Umami',
    kind: 'service',
    description:
      'Privacy-friendly web analytics. Needs PostgreSQL: create one from the PostgreSQL template first, then set DATABASE_URL to point at it.',
    image: 'ghcr.io/umami-software/umami:3.0.3',
    port: 3000,
    volumes: [],
    env: {
      DATABASE_URL: 'postgresql://postgres:CHANGE_ME@postgres:5432/umami',
      APP_SECRET: '{{random:64}}',
    },
    backupSupported: false,
  },
  {
    id: 'minio',
    name: 'MinIO',
    kind: 'service',
    description: 'S3-compatible object storage. The web console is routed; the S3 API listens on port 9000 inside the docksy network.',
    image: 'minio/minio:RELEASE.2025-04-22T22-12-26Z',
    port: 9001,
    volumes: [{ name: 'data', mountPath: '/data' }],
    env: {
      MINIO_ROOT_USER: 'admin',
      MINIO_ROOT_PASSWORD: '{{random:32}}',
      MINIO_BROWSER_REDIRECT_URL: 'https://{{domain}}',
    },
    backupSupported: false,
  },
  {
    id: 'ghost',
    name: 'Ghost',
    kind: 'service',
    description: 'Publishing platform for blogs and newsletters. Uses SQLite stored in its content volume.',
    image: 'ghost:5',
    port: 2368,
    volumes: [{ name: 'content', mountPath: '/var/lib/ghost/content' }],
    env: {
      url: 'https://{{domain}}',
      database__client: 'sqlite3',
      database__connection__filename: '/var/lib/ghost/content/data/ghost.db',
      database__useNullAsDefault: 'true',
      database__debug: 'false',
    },
    backupSupported: false,
  },
  {
    id: 'wordpress',
    name: 'WordPress',
    kind: 'service',
    description:
      'The classic CMS. Needs MySQL or MariaDB: create one from a template first, then set the WORDPRESS_DB_* variables to match it.',
    image: 'wordpress:6-apache',
    port: 80,
    volumes: [{ name: 'html', mountPath: '/var/www/html' }],
    env: {
      WORDPRESS_DB_HOST: 'mariadb:3306',
      WORDPRESS_DB_USER: 'app',
      WORDPRESS_DB_PASSWORD: 'CHANGE_ME',
      WORDPRESS_DB_NAME: 'app',
    },
    backupSupported: false,
  },
];

/**
 * Container command overrides for templates whose image needs arguments to start.
 * `Template` has no `command` field yet, so core-deploy can read this for template apps:
 *   const cmd = templateCommand(app.template); // append to `docker run … <image> ${cmd.map(q).join(' ')}`
 */
const TEMPLATE_COMMANDS: Record<string, string[]> = {
  redis: ['sh', '-c', 'exec redis-server --appendonly yes --requirepass "$REDIS_PASSWORD"'],
  minio: ['server', '/data', '--console-address', ':9001'],
};

export function templateCommand(templateId: string | null | undefined): string[] | null {
  return (templateId && TEMPLATE_COMMANDS[templateId]) || null;
}

export function getTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
