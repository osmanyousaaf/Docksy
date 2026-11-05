/**
 * Dev-only mock backend for the apps/deploy pages (stripped from production builds).
 * Enabled with `?mock=1` (sticky per tab via sessionStorage, shared with features/monitoring/mock.ts;
 * `?mock=0` turns it off). Patches window.fetch / window.EventSource and answers the apps, deployments,
 * env, webhook, templates, backups, settings, tokens and health routes, plus the app/deployment log streams.
 * Anything else falls through to whatever fetch was there before: the monitoring mock (which the Layout
 * installs first, and whose servers + signed-in user we adopt) or the real server.
 */
import type {
  ApiToken, App, BackupConfig, BackupRun, ContainerMetricPoint, Deployment, DeploymentStatus, LogLine, Server, Settings, Template,
} from '@docksy/shared';

function enabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const p = new URLSearchParams(window.location.search).get('mock');
    if (p === '1') sessionStorage.setItem('docksy-mock', '1');
    if (p === '0') sessionStorage.removeItem('docksy-mock');
    return sessionStorage.getItem('docksy-mock') === '1';
  } catch {
    return new URLSearchParams(window.location.search).get('mock') === '1';
  }
}

export const MOCK = import.meta.env.DEV && enabled();

/** Everything lives inside install() so production builds (MOCK === false) drop it entirely. */
function install(hasPrev: boolean) {
  /* ───────────────────────── fixtures ───────────────────────── */

  const ago = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();
  let seq = 1000;
  const id = (p: string) => `${p}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const ESC = '\x1b';

  const servers: Server[] = [
    { id: 'srv_prod1', name: 'prod-1', host: '203.0.113.10', port: 22, sshUser: 'root', status: 'ready', liveness: 'online', lastSeenAt: ago(4), agentVersion: '0.1.0', os: 'ubuntu 24.04', arch: 'amd64', cpuCores: 4, memTotal: 8 * 1024 ** 3, diskTotal: 160 * 1024 ** 3, createdAt: ago(86400 * 30), updatedAt: ago(60) },
    { id: 'srv_edge2', name: 'edge-2', host: '198.51.100.7', port: 22, sshUser: 'root', status: 'ready', liveness: 'online', lastSeenAt: ago(7), agentVersion: '0.1.0', os: 'debian 12', arch: 'arm64', cpuCores: 2, memTotal: 4 * 1024 ** 3, diskTotal: 80 * 1024 ** 3, createdAt: ago(86400 * 12), updatedAt: ago(300) },
  ];

  const T = (id: string, name: string, kind: Template['kind'], description: string, image: string, port: number | null, backupSupported = false, vol = '/data'): Template =>
    ({ id, name, kind, description, image, port, volumes: [{ name: 'data', mountPath: vol }], env: {}, backupSupported });
  const templates: Template[] = [
    T('postgres', 'PostgreSQL', 'database', 'The world’s most advanced open-source relational database.', 'postgres:17-alpine', 5432, true, '/var/lib/postgresql/data'),
    T('mysql', 'MySQL', 'database', 'Popular relational database for web apps.', 'mysql:8.4', 3306, true, '/var/lib/mysql'),
    T('mariadb', 'MariaDB', 'database', 'Community-developed fork of MySQL.', 'mariadb:11', 3306, true, '/var/lib/mysql'),
    T('redis', 'Redis', 'database', 'In-memory key/value store, cache and queue.', 'redis:7-alpine', 6379, true),
    T('mongodb', 'MongoDB', 'database', 'Document database for flexible JSON data.', 'mongo:7', 27017, true, '/data/db'),
    T('n8n', 'n8n', 'service', 'Workflow automation you can self-host.', 'n8nio/n8n:latest', 5678),
    T('uptime-kuma', 'Uptime Kuma', 'service', 'A friendly self-hosted monitoring tool.', 'louislam/uptime-kuma:1', 3001),
    T('plausible', 'Plausible', 'service', 'Simple, privacy-friendly web analytics.', 'ghcr.io/plausible/community-edition:v2', 8000),
    T('umami', 'Umami', 'service', 'Lightweight, cookie-free analytics.', 'ghcr.io/umami-software/umami:postgresql-latest', 3000),
    T('minio', 'MinIO', 'service', 'S3-compatible object storage.', 'minio/minio:latest', 9000),
    T('ghost', 'Ghost', 'service', 'Publishing platform for blogs and newsletters.', 'ghost:5-alpine', 2368, false, '/var/lib/ghost/content'),
    T('wordpress', 'WordPress', 'service', 'The classic CMS powering much of the web.', 'wordpress:6', 80, false, '/var/www/html'),
  ];

  const baseApp = (o: Partial<App> & Pick<App, 'id' | 'name' | 'serverId'>): App => ({
    description: null, startCommand: null, watchPaths: [], cpuLimit: null, memLimitMb: null,
    suggestedDomain: `${o.name}.${servers.find((s) => s.id === o.serverId)?.host ?? '127.0.0.1'}.sslip.io`,
    kind: 'app', template: null, sourceType: 'git', repoUrl: null, branch: 'main', hasGitToken: false, image: null, buildType: 'auto',
    dockerfilePath: 'Dockerfile', buildContext: '.', composePath: 'docker-compose.yml', port: 3000, domains: [], healthcheckPath: null,
    volumes: [], status: 'running', autoDeploy: true, webhookUrl: `https://docksy.example.com/api/v1/webhooks/github/${o.id}`,
    currentDeploymentId: null, createdAt: ago(86400 * 9), updatedAt: ago(3600), ...o,
  });

  const apps: App[] = [
    baseApp({ id: 'app_web', name: 'web', serverId: 'srv_prod1', repoUrl: 'https://github.com/acme/web', domains: ['acme.com', 'www.acme.com'], healthcheckPath: '/health', status: 'running' }),
    baseApp({ id: 'app_api', name: 'api', serverId: 'srv_prod1', repoUrl: 'https://github.com/acme/api', buildType: 'dockerfile', port: 8080, domains: ['api.acme.com'], status: 'failed', hasGitToken: true }),
    baseApp({ id: 'app_pg', name: 'postgres', serverId: 'srv_prod1', kind: 'database', template: 'postgres', sourceType: 'image', repoUrl: null, branch: null, image: 'postgres:17-alpine', buildType: 'image', port: 5432, domains: [], volumes: [{ name: 'data', mountPath: '/var/lib/postgresql/data' }], autoDeploy: false }),
    baseApp({ id: 'app_n8n', name: 'n8n', serverId: 'srv_edge2', kind: 'service', template: 'n8n', sourceType: 'image', repoUrl: null, branch: null, image: 'n8nio/n8n:latest', buildType: 'image', port: 5678, domains: ['n8n.198.51.100.7.sslip.io'], status: 'deploying', autoDeploy: false }),
    baseApp({ id: 'app_docs', name: 'docs', serverId: 'srv_edge2', repoUrl: 'https://github.com/acme/docs', port: 80, domains: ['docs.acme.com'], status: 'stopped' }),
  ];

  const envs: Record<string, Record<string, string>> = {
    app_web: { NODE_ENV: 'production', DATABASE_URL: 'postgres://app:s3cr3t-pass@postgres:5432/app', SESSION_SECRET: 'kq83hf02hf0283hf0', PUBLIC_URL: 'https://acme.com' },
    app_api: { PORT: '8080', LOG_LEVEL: 'info', STRIPE_KEY: 'sk_live_51H8xY2eZvKYlo2C' },
    app_pg: { POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'Zx81kPq0LmN3vB7c', POSTGRES_DB: 'app' },
    app_n8n: { N8N_HOST: 'n8n.198.51.100.7.sslip.io', GENERIC_TIMEZONE: 'UTC' },
    app_docs: {},
  };

  const COMMITS = [
    ['a1b2c3d4e5f6', 'feat: new pricing page'], ['9f8e7d6c5b4a', 'fix: handle empty cart'], ['5e4d3c2b1a09', 'chore: bump deps'],
    ['0a9b8c7d6e5f', 'perf: cache product queries'], ['7d6c5b4a3f2e', 'feat: dark mode'], ['3c2b1a0f9e8d', 'Initial commit'],
  ];

  const deployments: Deployment[] = [];
  const depLogs: Record<string, LogLine[]> = {};

  function buildScript(d: Deployment, app: App): LogLine[] {
    const L = (line: string, stream: LogLine['stream'] = 'stdout'): LogLine => ({ ts: new Date().toISOString(), stream, line });
    const lines: LogLine[] = [L(`Deployment ${d.id.slice(0, 8)} for ${app.name} (trigger: ${d.trigger})`, 'system')];
    if (app.sourceType === 'git') {
      lines.push(L(`::step:: Cloning ${app.repoUrl} (${app.branch})`, 'system'), L(`Cloning into '/var/lib/docksy/builds/${app.name}/${d.id.slice(0, 8)}'...`), L(`HEAD is now at ${d.commitSha?.slice(0, 7)} ${d.commitMessage}`),
        L('::step:: Building image', 'system'), L(`${ESC}[34m#1${ESC}[0m [internal] load build definition from Dockerfile`), L(`${ESC}[34m#2${ESC}[0m [internal] load metadata for docker.io/library/node:24-alpine`),
        L(`${ESC}[34m#3${ESC}[0m [1/5] FROM docker.io/library/node:24-alpine`), L(`${ESC}[34m#4${ESC}[0m [2/5] WORKDIR /app`), L(`${ESC}[34m#5${ESC}[0m [3/5] COPY package*.json ./`),
        L(`${ESC}[34m#6${ESC}[0m [4/5] RUN npm ci --omit=dev`), L(`${ESC}[2mnpm warn deprecated inflight@1.0.6: This module is not supported${ESC}[0m`, 'stderr'), L('added 214 packages in 6s'),
        L(`${ESC}[34m#7${ESC}[0m [5/5] COPY . .`), L(`${ESC}[34m#8${ESC}[0m exporting to image`), L(`${ESC}[32m#8 naming to docker.io/docksy/${app.name}:${d.id.slice(0, 8)} done${ESC}[0m`));
    } else {
      lines.push(L(`::step:: Pulling ${app.image}`, 'system'), L(`${app.image?.split(':')[1] ?? 'latest'}: Pulling from ${app.image?.split(':')[0]}`), L('Digest: sha256:4f1c0e6b9d…'), L(`Status: Image is up to date for ${app.image}`));
    }
    lines.push(L('::step:: Starting new container', 'system'), L(`Created dx-${app.name}-${d.id.slice(0, 8)} on network docksy`), L('::step:: Waiting for health check', 'system'),
      L(app.healthcheckPath ? `GET ${app.healthcheckPath} → 200 OK` : 'Container running for 5s'), L('::step:: Switching traffic and removing old container', 'system'));
    return lines;
  }

  function seedDeployments() {
    const mk = (app: App, i: number, status: DeploymentStatus, startedAgo: number, durSec: number, trigger: Deployment['trigger'] = 'webhook', error: string | null = null): Deployment => {
      const [sha, msg] = COMMITS[i % COMMITS.length];
      const d: Deployment = {
        id: `${fnv(app.name + i)}-${app.name}-${i}`, appId: app.id, status, trigger, commitSha: app.sourceType === 'git' ? sha : null, commitMessage: app.sourceType === 'git' ? msg : null,
        imageTag: status === 'succeeded' ? `docksy/${app.name}:${sha.slice(0, 8)}` : null, error,
        startedAt: ago(startedAgo), finishedAt: isLive(status) ? null : ago(startedAgo - durSec), createdAt: ago(startedAgo + 2),
      };
      const lines = buildScript(d, app);
      if (status === 'failed') lines.push({ ts: d.finishedAt!, stream: 'stderr', line: `${ESC}[31merror${ESC}[0m: ${error}` });
      if (status === 'succeeded') lines.push({ ts: d.finishedAt!, stream: 'system', line: `${ESC}[32m✓ Deployed in ${durSec}s${ESC}[0m` });
      depLogs[d.id] = isLive(status) ? lines.slice(0, 6) : lines;
      deployments.push(d);
      return d;
    };
    const [web, api, pg, n8n, docs] = apps;
    const w = [mk(web, 0, 'succeeded', 3600, 48), mk(web, 1, 'succeeded', 86400, 52), mk(web, 2, 'failed', 90000, 31, 'webhook', 'npm ci exited with code 1'), mk(web, 3, 'succeeded', 86400 * 3, 61, 'manual'), mk(web, 4, 'succeeded', 86400 * 5, 44)];
    web.currentDeploymentId = w[0].id;
    const a = [mk(api, 0, 'failed', 1200, 22, 'webhook', 'health check /health timed out after 120s'), mk(api, 1, 'succeeded', 86400 * 2, 70)];
    api.currentDeploymentId = a[1].id;
    pg.currentDeploymentId = mk(pg, 0, 'succeeded', 86400 * 6, 9, 'manual').id;
    const nd = mk(n8n, 0, 'building', 20, 0, 'manual');
    n8n.currentDeploymentId = mk(n8n, 1, 'succeeded', 86400, 14, 'manual').id;
    docs.currentDeploymentId = mk(docs, 0, 'succeeded', 86400 * 4, 33).id;
    simulate(nd.id, 6);
  }

  const fnv = (str: string) => {
    let x = 2166136261;
    for (const ch of str) x = Math.imul(x ^ ch.charCodeAt(0), 16777619);
    return (x >>> 0).toString(16).padStart(8, '0');
  };
  const isLive = (s: DeploymentStatus) => s === 'queued' || s === 'building' || s === 'deploying';

  const backups: BackupConfig[] = [
    { id: 'bk_pg_daily', appId: 'app_pg', schedule: 'daily', retention: 7, destination: 's3', s3: { endpoint: 'https://s3.eu-central-1.amazonaws.com', bucket: 'acme-backups', region: 'eu-central-1', accessKey: 'AKIA…7Q2D', prefix: 'postgres/' }, verify: true, enabled: true, lastRunAt: ago(3600 * 5), createdAt: ago(86400 * 6) },
  ];
  const backupRuns: Record<string, BackupRun[]> = {
    bk_pg_daily: Array.from({ length: 6 }, (_, i): BackupRun => ({
      id: `run_${i}`, backupId: 'bk_pg_daily', status: i === 3 ? 'failed' : 'succeeded', verified: i === 3 ? 'skipped' : i === 0 ? 'passed' : i === 1 ? 'pending' : 'passed',
      sizeBytes: i === 3 ? null : 48_000_000 - i * 1_200_000, path: i === 3 ? null : `/var/lib/docksy/backups/postgres/2026-10-${31 - i}T03-00.gz`,
      log: i === 3 ? 'pg_dumpall: error: connection to server failed: FATAL: too many connections' : 'pg_dumpall … ok\nuploaded to s3://acme-backups/postgres/\nverify: restored into throwaway container, SELECT 1 → 1',
      startedAt: ago(86400 * i + 3600 * 5), finishedAt: ago(86400 * i + 3600 * 5 - 40),
    })),
  };

  let settings: Settings = { instanceName: 'Acme Cloud', publicUrl: 'https://docksy.example.com', statusPageEnabled: true, statusPageTitle: 'Acme status', metricsRetentionDays: 30 };
  const tokens: ApiToken[] = [
    { id: 'tok_1', name: 'claude-code', prefix: 'dsk_9fK2aQ', scope: 'full', lastUsedAt: ago(300), createdAt: ago(86400 * 4) },
    { id: 'tok_2', name: 'ci-readonly', prefix: 'dsk_p02LmZ', scope: 'read', lastUsedAt: null, createdAt: ago(86400 * 20) },
  ];

  function metricPoints(appId: string, range: string): ContainerMetricPoint[] {
    const span = ({ '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000 } as Record<string, number>)[range] ?? 3600;
    const n = 120;
    const seed = [...appId].reduce((a, c) => a + c.charCodeAt(0), 0);
    return Array.from({ length: n }, (_, i) => {
      const t = i / n;
      const wave = Math.sin(t * 9 + seed) * 0.5 + Math.sin(t * 31 + seed * 2) * 0.25;
      return {
        ts: new Date(Date.now() - span * 1000 * (1 - t)).toISOString(),
        cpu: Math.max(0.5, 18 + wave * 14 + (i > 90 && i < 98 ? 35 : 0) + Math.random() * 4),
        memUsed: (220 + wave * 40 + t * 30) * 1024 ** 2,
        netRx: (40 + wave * 30 + Math.random() * 10) * 1024,
        netTx: (90 + wave * 50 + Math.random() * 20) * 1024,
      };
    });
  }

  /* ───────────────────────── simulation / pub-sub ───────────────────────── */

  type Listener = (event: string, data: unknown) => void;
  const depListeners = new Map<string, Set<Listener>>();
  const emitDep = (depId: string, event: string, data: unknown) => depListeners.get(depId)?.forEach((l) => l(event, data));

  function simulate(depId: string, startAt = 0) {
    const d = deployments.find((x) => x.id === depId)!;
    const app = apps.find((a) => a.id === d.appId)!;
    const script = buildScript(d, app);
    let i = startAt;
    const setStatus = (s: DeploymentStatus) => {
      d.status = s;
      emitDep(depId, 'status', { status: s, error: d.error });
    };
    setTimeout(() => {
      if (d.status === 'cancelled') return;
      d.startedAt ??= new Date().toISOString();
      setStatus('building');
      app.status = 'deploying';
      const t = setInterval(() => {
        if (d.status === 'cancelled') { clearInterval(t); return; }
        if (i >= script.length) {
          clearInterval(t);
          const done: LogLine = { ts: new Date().toISOString(), stream: 'system', line: `${ESC}[32m✓ Deployed successfully${ESC}[0m` };
          depLogs[depId].push(done);
          emitDep(depId, 'log', done);
          d.finishedAt = new Date().toISOString();
          d.imageTag = `docksy/${app.name}:${d.id.slice(0, 8)}`;
          app.status = 'running';
          app.currentDeploymentId = d.id;
          setStatus('succeeded');
          return;
        }
        const line = { ...script[i++], ts: new Date().toISOString() };
        depLogs[depId].push(line);
        emitDep(depId, 'log', line);
        if (line.line.includes('Starting new container') && d.status === 'building') setStatus('deploying');
      }, 450);
    }, 900);
  }

  function newDeployment(app: App, trigger: Deployment['trigger'], from?: Deployment): Deployment {
    const [sha, msg] = from?.commitSha ? [from.commitSha, from.commitMessage ?? ''] : COMMITS[Math.floor(Math.random() * COMMITS.length)];
    const d: Deployment = {
      id: id('dep_'), appId: app.id, status: 'queued', trigger, commitSha: app.sourceType === 'git' ? sha : null, commitMessage: app.sourceType === 'git' ? msg : null,
      imageTag: null, error: null, startedAt: null, finishedAt: null, createdAt: new Date().toISOString(),
    };
    deployments.unshift(d);
    depLogs[d.id] = [{ ts: d.createdAt, stream: 'system', line: trigger === 'rollback' ? `Rolling back to ${from?.imageTag}` : 'Queued' }];
    app.status = 'deploying';
    simulate(d.id);
    return d;
  }

  /* ───────────────────────── router ───────────────────────── */

  const PASS = Symbol('pass');
  class MockHttpError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
  }
  const nf = (what: string) => new MockHttpError(404, 'not_found', `${what} not found`);

  const findApp = (key: string) => {
    const a = apps.find((x) => x.id === key || x.name === key);
    if (!a) throw nf('App');
    return a;
  };
  const maskVal = (v: string) => (v.length <= 4 ? '••••' : `${v.slice(0, 2)}${'•'.repeat(Math.min(10, v.length - 4))}${v.slice(-2)}`);

  function route(method: string, url: URL, body: any): unknown {
    const p = url.pathname.replace(/^\/api\/v1/, '');
    const q = url.searchParams;
    const m = (re: RegExp) => p.match(re);
    let r: RegExpMatchArray | null;

    if (hasPrev && (p.startsWith('/auth/') || p.startsWith('/servers'))) throw PASS;
    if (p === '/auth/state') return { setupRequired: false, user: { id: 'usr_1', email: 'you@example.com', name: 'You', role: 'owner', createdAt: ago(86400 * 30) } };
    if (p === '/auth/me') return { id: 'usr_1', email: 'you@example.com', name: 'You', role: 'owner', createdAt: ago(86400 * 30) };
    if (p === '/health') return { ok: true, version: '0.1.0-mock', uptimeSec: 86400 * 3 + 4200 };
    if (p === '/servers' && method === 'GET') return { items: servers };
    if (p === '/templates') return { items: templates };

    if (p === '/settings') {
      if (method === 'PATCH') settings = { ...settings, ...body };
      return settings;
    }
    if (p === '/tokens') {
      if (method === 'POST') {
        const plaintext = `dsk_${Array.from({ length: 40 }, () => 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 57)]).join('')}`;
        const token: ApiToken = { id: id('tok_'), name: body.name, prefix: plaintext.slice(0, 10), scope: body.scope ?? 'full', lastUsedAt: null, createdAt: new Date().toISOString() };
        tokens.unshift(token);
        return { token, plaintext };
      }
      return { items: tokens };
    }
    if ((r = m(/^\/tokens\/([^/]+)$/)) && method === 'DELETE') {
      const i = tokens.findIndex((t) => t.id === r![1]);
      if (i >= 0) tokens.splice(i, 1);
      return { ok: true };
    }

    if (p === '/apps') {
      if (method === 'POST') {
        if (apps.some((a) => a.name === body.name)) throw new MockHttpError(409, 'conflict', `An app named ${body.name} already exists`);
        const tpl = body.template ? templates.find((t) => t.id === body.template) : undefined;
        const appId = id('app_');
        const srv = servers.find((s) => s.id === body.serverId);
        const a = baseApp({
          id: appId, name: body.name, serverId: body.serverId, kind: tpl?.kind ?? 'app', template: tpl?.id ?? null,
          sourceType: tpl ? 'image' : body.sourceType ?? 'git', repoUrl: body.repoUrl ?? null, branch: body.branch ?? (tpl ? null : 'main'),
          hasGitToken: !!body.gitToken, image: tpl?.image ?? body.image ?? null, buildType: tpl ? 'image' : body.buildType ?? 'auto',
          port: tpl?.port ?? body.port ?? null, volumes: tpl?.volumes ?? body.volumes ?? [], status: 'idle', autoDeploy: body.autoDeploy ?? true,
          domains: body.domains?.length ? body.domains : tpl?.kind === 'database' ? [] : [`${body.name}.${srv?.host ?? '127.0.0.1'}.sslip.io`],
          healthcheckPath: body.healthcheckPath ?? null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        apps.push(a);
        envs[appId] = body.env ?? {};
        return a;
      }
      const sid = q.get('serverId');
      return { items: sid ? apps.filter((a) => a.serverId === sid) : apps };
    }
    if ((r = m(/^\/apps\/([^/]+)$/))) {
      const a = findApp(r[1]);
      if (method === 'PATCH') {
        const { gitToken, ...rest } = body ?? {};
        Object.assign(a, rest, { updatedAt: new Date().toISOString() });
        if (gitToken) a.hasGitToken = true;
        if (gitToken === null || gitToken === '') a.hasGitToken = false;
        return a;
      }
      if (method === 'DELETE') { apps.splice(apps.indexOf(a), 1); return { ok: true }; }
      return a;
    }
    if ((r = m(/^\/apps\/([^/]+)\/env$/))) {
      const a = findApp(r[1]);
      if (method === 'PUT') { envs[a.id] = { ...body.vars }; return { vars: envs[a.id] }; }
      const vars = envs[a.id] ?? {};
      return { vars: q.get('reveal') === '1' ? vars : Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, maskVal(v)])) };
    }
    if ((r = m(/^\/apps\/([^/]+)\/webhook$/))) {
      const a = findApp(r[1]);
      return { url: a.webhookUrl, secret: `whs_${a.id.replace(/[^a-z0-9]/gi, '')}Xf83kQp20zLm` };
    }
    if ((r = m(/^\/apps\/([^/]+)\/metrics$/))) return { points: metricPoints(findApp(r[1]).id, q.get('range') ?? '1h') };
    if ((r = m(/^\/apps\/([^/]+)\/deploy$/))) return newDeployment(findApp(r[1]), body?.trigger ?? 'manual');
    if ((r = m(/^\/apps\/([^/]+)\/rollback$/))) {
      const a = findApp(r[1]);
      const from = deployments.find((d) => d.id === body.deploymentId);
      if (!from?.imageTag) throw new MockHttpError(400, 'bad_request', 'That deployment has no image to roll back to');
      return newDeployment(a, 'rollback', from);
    }
    if ((r = m(/^\/apps\/([^/]+)\/(restart|stop|start)$/))) {
      const a = findApp(r[1]);
      a.status = r[2] === 'stop' ? 'stopped' : 'running';
      return { ok: true };
    }
    if ((r = m(/^\/apps\/([^/]+)\/logs$/))) return { lines: runtimeLines(findApp(r[1]), 50) };
    if ((r = m(/^\/apps\/([^/]+)\/exec$/))) {
      const a = findApp(r[1]);
      if (a.status !== 'running') throw new MockHttpError(409, 'conflict', 'The app is not running');
      const cmd = String(body?.command ?? '').trim();
      const out: Record<string, string> = { ls: 'app\nnode_modules\npackage.json\n', pwd: '/app\n', whoami: 'node\n', 'ls /': 'app\nbin\ndev\netc\nhome\nlib\nproc\nroot\nsys\ntmp\nusr\nvar\n' };
      const known = out[cmd];
      return { code: known !== undefined ? 0 : 127, stdout: known ?? '', stderr: known !== undefined ? '' : `sh: ${cmd.split(' ')[0]}: not found\n`, container: `docksy-${a.name}-1`, durationMs: 40 + Math.round(Math.random() * 80) };
    }

    if (p === '/deployments') {
      const appId = q.get('appId');
      const a = appId ? findApp(appId) : null;
      const list = deployments.filter((d) => !a || d.appId === a.id).sort((x, y) => y.createdAt.localeCompare(x.createdAt));
      return { items: list.slice(0, Number(q.get('limit') ?? 50)) };
    }
    if ((r = m(/^\/deployments\/([^/]+)$/))) {
      const d = deployments.find((x) => x.id === r![1]);
      if (!d) throw nf('Deployment');
      return d;
    }
    if ((r = m(/^\/deployments\/([^/]+)\/logs$/))) return { items: depLogs[r[1]] ?? [] };
    if ((r = m(/^\/deployments\/([^/]+)\/cancel$/))) {
      const d = deployments.find((x) => x.id === r![1]);
      if (!d) throw nf('Deployment');
      if (isLive(d.status)) {
        d.status = 'cancelled';
        d.finishedAt = new Date().toISOString();
        const a = apps.find((x) => x.id === d.appId);
        if (a) a.status = a.currentDeploymentId ? 'running' : 'idle';
        emitDep(d.id, 'status', { status: 'cancelled', error: null });
      }
      return { ok: true };
    }

    if (p === '/backups') {
      if (method === 'POST') {
        const { s3Secret: _s, secretKey: _k, ...rest } = body;
        const b: BackupConfig = { id: id('bk_'), lastRunAt: null, createdAt: new Date().toISOString(), enabled: true, s3: null, ...rest };
        backups.push(b);
        backupRuns[b.id] = [];
        return b;
      }
      const appId = q.get('appId');
      return { items: backups.filter((b) => !appId || b.appId === findApp(appId).id) };
    }
    if ((r = m(/^\/backups\/([^/]+)$/))) {
      const b = backups.find((x) => x.id === r![1]);
      if (!b) throw nf('Backup');
      if (method === 'DELETE') { backups.splice(backups.indexOf(b), 1); return { ok: true }; }
      if (method === 'PATCH') Object.assign(b, body);
      return b;
    }
    if ((r = m(/^\/backups\/([^/]+)\/run$/))) {
      const b = backups.find((x) => x.id === r![1]);
      if (!b) throw nf('Backup');
      const run: BackupRun = { id: id('run_'), backupId: b.id, status: 'running', verified: 'pending', sizeBytes: null, path: null, log: 'pg_dumpall …', startedAt: new Date().toISOString(), finishedAt: null };
      (backupRuns[b.id] ??= []).unshift(run);
      b.lastRunAt = run.startedAt;
      setTimeout(() => Object.assign(run, { status: 'succeeded', sizeBytes: 47_500_000, path: `/var/lib/docksy/backups/postgres/${Date.now()}.gz`, finishedAt: new Date().toISOString(), log: 'pg_dumpall … ok' }), 2500);
      setTimeout(() => { if (b.verify) run.verified = 'passed'; else run.verified = 'skipped'; }, 5000);
      return run;
    }
    if ((r = m(/^\/backups\/([^/]+)\/runs$/))) return { items: backupRuns[r[1]] ?? [] };
    if ((r = m(/^\/backup-runs\/([^/]+)\/(verify|restore)$/))) {
      const run = Object.values(backupRuns).flat().find((x) => x.id === r![1]);
      if (!run) throw nf('Backup run');
      if (r[2] === 'restore' && body?.confirm !== true) throw new MockHttpError(400, 'bad_request', 'confirm: true is required');
      if (r[2] === 'verify') { run.verified = 'pending'; setTimeout(() => { run.verified = 'passed'; }, 2500); }
      return r[2] === 'verify' ? run : { ok: true };
    }

    throw PASS; // not ours: let the previous fetch (another mock or the real server) answer
  }

  const RUNTIME = [
    'GET / 200 12ms', 'GET /api/products 200 34ms', 'POST /api/cart 201 18ms', 'GET /health 200 1ms',
    `${ESC}[33mwarn${ESC}[0m slow query (412ms): SELECT * FROM orders WHERE …`, 'GET /assets/app.js 304 2ms',
    `${ESC}[31merror${ESC}[0m Payment provider timeout after 5000ms`, 'GET /api/me 401 3ms', 'cache hit ratio 0.94',
  ];
  function runtimeLines(app: App, n: number): string[] {
    return Array.from({ length: n }, (_, i) => `${new Date(Date.now() - (n - i) * 3000).toISOString()} [${app.name}] ${RUNTIME[(i * 7) % RUNTIME.length]}`);
  }

  /* ───────────────────────── install ───────────────────────── */

  class MockEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readyState = 0;
    url: string;
    withCredentials: boolean;
    onopen: ((e: Event) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    private stop: (() => void)[] = [];

    constructor(url: string, init?: { withCredentials?: boolean }) {
      super();
      this.url = url;
      this.withCredentials = !!init?.withCredentials;
      setTimeout(() => this.start(), 120);
    }

    private send(event: string, data: unknown) {
      if (this.readyState === 2) return;
      this.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) }));
    }

    private start() {
      if (this.readyState === 2) return;
      this.readyState = 1;
      const ev = new Event('open');
      this.onopen?.(ev);
      this.dispatchEvent(ev);
      const p = new URL(this.url, location.origin).pathname.replace(/^\/api\/v1/, '');
      let r: RegExpMatchArray | null;
      if ((r = p.match(/^\/deployments\/([^/]+)\/logs\/stream$/))) {
        const depId = r[1];
        for (const l of depLogs[depId] ?? []) this.send('log', l);
        const d = deployments.find((x) => x.id === depId);
        if (d) this.send('status', { status: d.status, error: d.error });
        const l: Listener = (e, data) => this.send(e, data);
        (depListeners.get(depId) ?? depListeners.set(depId, new Set()).get(depId)!).add(l);
        this.stop.push(() => depListeners.get(depId)?.delete(l));
      } else if ((r = p.match(/^\/apps\/([^/]+)\/logs\/stream$/))) {
        const app = apps.find((a) => a.id === r![1] || a.name === r![1]);
        if (!app) return;
        for (const line of runtimeLines(app, 80)) this.send('log', { line });
        let i = 0;
        const t = setInterval(() => this.send('log', { line: `${new Date().toISOString()} [${app.name}] ${RUNTIME[(i++ * 5) % RUNTIME.length]}` }), 900);
        this.stop.push(() => clearInterval(t));
      }
    }

    close() {
      this.readyState = 2;
      this.stop.forEach((f) => f());
      this.stop = [];
    }
  }

  seedDeployments();
  const realFetch = window.fetch.bind(window);
  // When another mock (e.g. features/monitoring/mock.ts) is already installed, adopt its servers so
  // both mocks describe the same fleet; it keeps answering /auth and /servers routes.
  let synced: Promise<void> | null = null;
  const syncServers = () => (synced ??= (async () => {
    try {
      const r = await realFetch('/api/v1/servers');
      const j = (await r.json()) as { items?: Server[] };
      if (!j.items?.length) return;
      const map = new Map(servers.map((s, i) => [s.id, j.items![Math.min(i, j.items!.length - 1)]]));
      for (const a of apps) a.serverId = map.get(a.serverId)?.id ?? j.items[0].id;
      servers.splice(0, servers.length, ...j.items);
    } catch { /* keep our own servers */ }
  })());
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, location.origin);
    if (!url.pathname.startsWith('/api/v1/')) return realFetch(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
    await new Promise((res) => setTimeout(res, 150 + Math.random() * 200));
    try {
      if (hasPrev) await syncServers();
      const out = route(method, url, body);
      return new Response(JSON.stringify(out), { status: method === 'POST' && /\/deploy$|\/rollback$/.test(url.pathname) ? 202 : 200, headers: { 'content-type': 'application/json' } });
    } catch (e) {
      if (e === PASS) return realFetch(input, init);
      const err = e instanceof MockHttpError ? e : new MockHttpError(500, 'mock_error', String(e));
      return new Response(JSON.stringify({ error: { code: err.code, message: err.message } }), { status: err.status, headers: { 'content-type': 'application/json' } });
    }
  };
  const RealES = window.EventSource;
  window.EventSource = function (url: string | URL, init?: EventSourceInit) {
    const u = new URL(String(url), location.origin);
    const ours = /^\/api\/v1\/(deployments\/[^/]+|apps\/[^/]+)\/logs\/stream$/.test(u.pathname);
    return ours ? new MockEventSource(String(url), init) : new RealES(url, init);
  } as unknown as typeof EventSource;
  Object.assign(window.EventSource, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
  console.info('[docksy] mock API enabled (?mock=0 to turn off)');
}

declare global { interface Window { __docksyAppsMock?: boolean } }
if (MOCK && !window.__docksyAppsMock) {
  window.__docksyAppsMock = true;
  install(!!(window as unknown as { __docksyMock?: unknown }).__docksyMock);
}
