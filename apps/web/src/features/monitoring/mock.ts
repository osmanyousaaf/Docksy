/**
 * Dev-only mock backend for visual checks: open any page with `?mock=1` while running `vite`.
 * Intercepts fetch('/api/v1/…') and EventSource('/api/v1/…') with realistic, animated fake data.
 * The choice is remembered for the tab (sessionStorage); `?mock=0` turns it off.
 * Variants: `?mock=1` (fleet), `?mock=empty` (first run), `?mock=signedout` (login), `?mock=setup` (setup),
 * `?mock=provision` (server new-box mid-provisioning: open /servers/new?server=s4&step=3).
 * Never active in production builds: installMock() is only called behind `import.meta.env.DEV`.
 */
import type {
  Alert, AlertRule, App, AuthState, ContainerInfo, DiagnoseReport, FleetOverview, LiveMetricsEvent, MetricPoint,
  MetricsRange, NotificationChannel, ProvisionJob, PublicStatus, Server, ServerMetrics, SshKeyInfo, UptimeCheck,
  UptimeResult, User, ValidateServerResponse,
} from '@docksy/shared';

const KEY = 'docksy-mock';
const GB = 1024 ** 3;
const MB = 1024 ** 2;

function mockMode(): string | null {
  try {
    const q = new URLSearchParams(location.search).get('mock');
    if (q === '0') { sessionStorage.removeItem(KEY); return null; }
    if (q) { sessionStorage.setItem(KEY, q); return q; }
    return sessionStorage.getItem(KEY);
  } catch { return null; }
}

// ───────────── deterministic signal generators ─────────────

const frac = (x: number) => x - Math.floor(x);
const noise = (seed: number, t: number) => frac(Math.sin(seed * 12.9898 + t * 78.233) * 43758.5453);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const iso = (t: number) => new Date(t).toISOString();

interface Profile { cpu: number; amp: number; mem: number; disk: number; net: number; seed: number }
const PROFILES: Record<string, Profile> = {
  s1: { cpu: 34, amp: 18, mem: 0.58, disk: 0.63, net: 420e3, seed: 1 },
  s2: { cpu: 71, amp: 16, mem: 0.86, disk: 0.88, net: 160e3, seed: 2 },
  s3: { cpu: 12, amp: 6, mem: 0.31, disk: 0.41, net: 40e3, seed: 3 },
};

function point(sid: string, t: number): MetricPoint {
  const p = PROFILES[sid] ?? PROFILES.s1;
  const s = servers.find((x) => x.id === sid)!;
  const n = noise(p.seed, Math.floor(t / 10e3));
  const cpu = clamp(p.cpu + p.amp * Math.sin(t / 540e3 + p.seed) + 7 * Math.sin(t / 97e3) + (n - 0.5) * 12, 1, 99.5);
  const memTotal = s.memTotal ?? 8 * GB;
  const diskTotal = s.diskTotal ?? 100 * GB;
  return {
    ts: iso(t),
    cpu,
    load1: (cpu / 100) * (s.cpuCores ?? 4) * 1.08,
    load5: (p.cpu / 100) * (s.cpuCores ?? 4),
    load15: (p.cpu / 100) * (s.cpuCores ?? 4) * 0.95,
    memUsed: memTotal * clamp(p.mem + 0.06 * Math.sin(t / 1800e3 + p.seed) + (n - 0.5) * 0.02, 0.05, 0.98),
    memTotal,
    swapUsed: sid === 's2' ? 1.2 * GB : 0,
    diskUsed: diskTotal * clamp(p.disk + 0.004 * Math.sin(t / 86400e3), 0, 0.99),
    diskTotal,
    netRx: p.net * (1 + 0.6 * Math.sin(t / 300e3 + 1) + n * 0.8),
    netTx: p.net * 0.45 * (1 + 0.5 * Math.sin(t / 240e3) + n * 0.6),
  };
}

function perCore(sid: string, t: number, cpu: number): number[] {
  const cores = servers.find((x) => x.id === sid)?.cpuCores ?? 4;
  return Array.from({ length: cores }, (_, i) =>
    clamp(cpu + 30 * Math.sin(i * 1.7 + t / 23e3) + (noise(i + 7, Math.floor(t / 2e3)) - 0.5) * 22, 0, 100));
}

// ───────────── fixtures ─────────────

const NOW = Date.now();
const user: User = { id: 'u1', email: 'founder@example.com', name: 'Ada Founder', role: 'owner', createdAt: iso(NOW - 40 * 86400e3) };

function mkServer(id: string, name: string, host: string, o: Partial<Server>): Server {
  return {
    id, name, host, port: 22, sshUser: 'root', status: 'ready', liveness: 'online', lastSeenAt: iso(Date.now() - 4000),
    agentVersion: '0.1.0', os: 'ubuntu 24.04', arch: 'amd64', cpuCores: 4, memTotal: 8 * GB, diskTotal: 80 * GB,
    createdAt: iso(NOW - 30 * 86400e3), updatedAt: iso(NOW - 86400e3), ...o,
  };
}

let servers: Server[] = [
  mkServer('s1', 'prod-eu-1', '49.12.104.17', { cpuCores: 8, memTotal: 16 * GB, diskTotal: 160 * GB }),
  mkServer('s2', 'staging', '65.21.88.3', { cpuCores: 4, memTotal: 8 * GB, diskTotal: 80 * GB, arch: 'arm64' }),
  mkServer('s3', 'edge-sg', '139.59.2.200', { liveness: 'offline', lastSeenAt: iso(NOW - 2 * 3600e3), cpuCores: 2, memTotal: 4 * GB, diskTotal: 50 * GB }),
  mkServer('s4', 'new-box', '5.75.200.9', { status: 'new', liveness: 'unknown', lastSeenAt: null, agentVersion: null, os: null, arch: null, cpuCores: null, memTotal: null, diskTotal: null }),
];

function mkApp(id: string, name: string, serverId: string, o: Partial<App> = {}): App {
  return {
    id, name, description: null, serverId, kind: 'app', template: null, sourceType: 'git', repoUrl: `https://github.com/acme/${name}`, branch: 'main',
    hasGitToken: false, image: null, buildType: 'auto', dockerfilePath: 'Dockerfile', buildContext: '.', composePath: 'docker-compose.yml',
    port: 3000, domains: [`${name}.49.12.104.17.sslip.io`], healthcheckPath: '/health', volumes: [], status: 'running', autoDeploy: true,
    startCommand: null, watchPaths: [], cpuLimit: null, memLimitMb: null, suggestedDomain: `${name}.49.12.104.17.sslip.io`,
    webhookUrl: `http://localhost:5173/api/v1/webhooks/github/${id}`, currentDeploymentId: null, createdAt: iso(NOW - 20 * 86400e3), updatedAt: iso(NOW), ...o,
  };
}
const apps: App[] = [
  mkApp('a1', 'web', 's1'), mkApp('a2', 'api', 's1'), mkApp('a3', 'postgres', 's1', { kind: 'database', template: 'postgres', sourceType: 'image', image: 'postgres:17' }),
  mkApp('a4', 'worker', 's1', { status: 'failed' }), mkApp('a5', 'redis', 's2', { kind: 'database', template: 'redis', sourceType: 'image', image: 'redis:7' }),
  mkApp('a6', 'docs', 's2'),
];

interface CSpec { id: string; name: string; image: string; appId: string | null; cpu: number; mem: number; state?: ContainerInfo['state']; restarts?: number; status?: string }
const CONTAINERS: Record<string, CSpec[]> = {
  s1: [
    { id: 'a1b2c3d4e5f6', name: 'dx-web-7f3a91c2', image: 'docksy/web:7f3a91c2', appId: 'a1', cpu: 18, mem: 410 * MB },
    { id: 'b2c3d4e5f6a1', name: 'dx-api-2be41d07', image: 'docksy/api:2be41d07', appId: 'a2', cpu: 26, mem: 780 * MB },
    { id: 'c3d4e5f6a1b2', name: 'dx-postgres-0c9d11ee', image: 'postgres:17', appId: 'a3', cpu: 9, mem: 1.9 * GB },
    { id: 'd4e5f6a1b2c3', name: 'dx-worker-91aa20f3', image: 'docksy/worker:91aa20f3', appId: 'a4', cpu: 0, mem: 0, state: 'restarting', restarts: 7, status: 'Restarting (1) 12 seconds ago' },
    { id: 'e5f6a1b2c3d4', name: 'docksy-proxy', image: 'lucaslorentz/caddy-docker-proxy:2.9', appId: null, cpu: 1.2, mem: 48 * MB },
    { id: 'f6a1b2c3d4e5', name: 'old-cron', image: 'alpine:3.20', appId: null, cpu: 0, mem: 0, state: 'exited', status: 'Exited (0) 3 days ago' },
  ],
  s2: [
    { id: 'aa11bb22cc33', name: 'dx-redis-55e0aa12', image: 'redis:7', appId: 'a5', cpu: 4, mem: 1.1 * GB },
    { id: 'bb22cc33dd44', name: 'dx-docs-8d7e6f5a', image: 'docksy/docs:8d7e6f5a', appId: 'a6', cpu: 61, mem: 3.4 * GB },
    { id: 'cc33dd44ee55', name: 'docksy-proxy', image: 'lucaslorentz/caddy-docker-proxy:2.9', appId: null, cpu: 0.8, mem: 40 * MB },
  ],
  s3: [],
  s4: [],
};

function containers(sid: string, t: number): ContainerInfo[] {
  return (CONTAINERS[sid] ?? []).map((c, i) => {
    const running = (c.state ?? 'running') === 'running';
    const j = noise(i + 31, Math.floor(t / 2e3));
    return {
      id: c.id, name: c.name, image: c.image, state: c.state ?? 'running', status: c.status ?? 'Up 3 days (healthy)',
      restartCount: c.restarts ?? 0, startedAt: iso(NOW - 3 * 86400e3),
      cpuPercent: running ? clamp(c.cpu * (0.7 + j * 0.6), 0, 100) : 0,
      memUsed: running ? c.mem * (0.95 + j * 0.1) : 0, memLimit: c.name.includes('postgres') ? 4 * GB : 0,
      netRx: running ? 20e3 + j * 90e3 : 0, netTx: running ? 10e3 + j * 40e3 : 0,
      labels: (c.appId ? { 'docksy.managed': 'true', 'docksy.app': c.appId } : {}) as Record<string, string>,
      serverId: sid, appId: c.appId, updatedAt: iso(t),
    };
  });
}

const RANGE_MS: Record<MetricsRange, number> = { '15m': 900e3, '1h': 3600e3, '6h': 21600e3, '24h': 86400e3, '7d': 604800e3, '30d': 2592000e3 };

function history(sid: string, range: MetricsRange): ServerMetrics {
  const s = servers.find((x) => x.id === sid);
  if (!s || !PROFILES[sid]) return { serverId: sid, range, stepSec: 10, points: [] };
  const span = RANGE_MS[range];
  const stepSec = Math.max(10, Math.ceil(span / 1000 / 360 / 10) * 10);
  const end = s.liveness === 'offline' ? new Date(s.lastSeenAt!).getTime() : Date.now();
  const start = Date.now() - span;
  const points: MetricPoint[] = [];
  for (let t = Math.max(start, end - span); t <= end; t += stepSec * 1000) points.push(point(sid, t));
  return { serverId: sid, range, stepSec, points };
}

let rules: AlertRule[] = [
  ['CPU high', 'cpu', 90, 300, 'warning'], ['Memory high', 'mem', 90, 300, 'critical'], ['Disk filling up', 'disk', 85, 0, 'warning'],
  ['Disk almost full', 'disk', 95, 0, 'critical'], ['Server offline', 'server_offline', 0, 120, 'critical'], ['Container down', 'container_down', 0, 0, 'critical'],
  ['Container restart loop', 'container_restarts', 3, 600, 'warning'], ['Deploy failed', 'deploy_failed', 0, 0, 'warning'],
  ['Uptime check down', 'uptime_down', 0, 0, 'critical'], ['Backup failed', 'backup_failed', 0, 0, 'critical'],
].map(([name, metric, threshold, durationSec, severity], i) => ({
  id: `r${i + 1}`, name: name as string, metric: metric as AlertRule['metric'], op: '>' as const, threshold: threshold as number,
  durationSec: durationSec as number, severity: severity as AlertRule['severity'], serverId: null, appId: null, channelIds: [],
  enabled: true, isDefault: true, createdAt: iso(NOW - 30 * 86400e3),
}));

let alerts: Alert[] = [
  { id: 'al1', ruleId: 'r2', serverId: 's2', appId: null, state: 'firing', severity: 'critical', title: 'Memory 91% on staging', message: 'Memory has been above 90% for 6 minutes. Ask Claude: /docksy:diagnose staging', value: 91.2, startedAt: iso(NOW - 7 * 60e3), resolvedAt: null, ackedAt: null },
  { id: 'al2', ruleId: 'r7', serverId: 's1', appId: 'a4', state: 'firing', severity: 'warning', title: 'worker is restart-looping', message: '7 restarts in the last 10 minutes. Ask Claude: /docksy:diagnose worker', value: 7, startedAt: iso(NOW - 12 * 60e3), resolvedAt: null, ackedAt: null },
  { id: 'al3', ruleId: 'r5', serverId: 's3', appId: null, state: 'firing', severity: 'critical', title: 'edge-sg is offline', message: 'No agent report for 2 hours. Ask Claude: /docksy:diagnose edge-sg', value: null, startedAt: iso(NOW - 2 * 3600e3), resolvedAt: null, ackedAt: iso(NOW - 3000e3) },
  ...Array.from({ length: 6 }, (_, i): Alert => ({
    id: `alh${i}`, ruleId: 'r1', serverId: i % 2 ? 's1' : 's2', appId: null, state: 'resolved', severity: i % 3 ? 'warning' : 'critical',
    title: ['CPU 94% on prod-eu-1', 'Disk 86% on staging', 'api uptime check down', 'Deploy failed: web', 'CPU 91% on staging', 'Memory 92% on prod-eu-1'][i],
    message: 'Resolved automatically when the condition cleared.', value: 90 + i, startedAt: iso(NOW - (i + 1) * 9 * 3600e3), resolvedAt: iso(NOW - (i + 1) * 9 * 3600e3 + (i + 2) * 7 * 60e3), ackedAt: null,
  })),
];

let channels: NotificationChannel[] = [
  { id: 'c1', name: 'Discord #ops', type: 'discord', config: { url: 'https://discord.com/api/webhooks/••••' }, enabled: true, createdAt: iso(NOW - 10 * 86400e3) },
  { id: 'c2', name: 'Founder email', type: 'email', config: { host: 'smtp.example.com', port: 587, secure: false, user: 'alerts', pass: '••••', from: 'docksy@example.com', to: 'founder@example.com' }, enabled: true, createdAt: iso(NOW - 9 * 86400e3) },
];

let checks: UptimeCheck[] = [
  { id: 'u1', name: 'web', url: 'https://web.49.12.104.17.sslip.io', appId: 'a1', intervalSec: 60, timeoutMs: 10000, expectedStatus: 0, public: true, enabled: true, lastStatus: 'up', uptime24h: 100, avgLatencyMs24h: 84, createdAt: iso(NOW - 20 * 86400e3) },
  { id: 'u2', name: 'api', url: 'https://api.example.com/health', appId: 'a2', intervalSec: 30, timeoutMs: 5000, expectedStatus: 200, public: true, enabled: true, lastStatus: 'up', uptime24h: 99.31, avgLatencyMs24h: 142, createdAt: iso(NOW - 20 * 86400e3) },
  { id: 'u3', name: 'docs', url: 'https://docs.example.com', appId: 'a6', intervalSec: 60, timeoutMs: 10000, expectedStatus: 0, public: false, enabled: true, lastStatus: 'down', uptime24h: 96.2, avgLatencyMs24h: 310, createdAt: iso(NOW - 5 * 86400e3) },
];

function results(id: string): UptimeResult[] {
  const seed = id.charCodeAt(1);
  const out: UptimeResult[] = [];
  for (let t = Date.now() - 86400e3; t <= Date.now(); t += 5 * 60e3) {
    const n = noise(seed, Math.floor(t / 300e3));
    const ok = id === 'u3' ? !(t > Date.now() - 50 * 60e3 || n > 0.97) : id === 'u2' ? n > 0.008 : true;
    out.push({ ts: iso(t), ok, statusCode: ok ? 200 : id === 'u3' ? 502 : null, latencyMs: ok ? Math.round((id === 'u3' ? 260 : id === 'u2' ? 120 : 70) + n * 80) : null, error: ok ? null : 'Bad gateway' });
  }
  return out;
}

function publicStatus(): PublicStatus {
  return {
    title: 'Acme Status',
    overall: 'degraded',
    updatedAt: iso(Date.now()),
    checks: checks.filter((c) => c.public).concat(checks[2]).map((c, ci) => ({
      name: c.name,
      status: c.lastStatus,
      uptime90d: [99.98, 99.71, 98.2][ci] ?? 100,
      days: Array.from({ length: 90 }, (_, i) => {
        const d = new Date(Date.now() - (89 - i) * 86400e3);
        const n = noise(ci + 3, i);
        return { date: d.toISOString().slice(0, 10), uptime: ci === 0 && i < 4 ? null : n > 0.95 ? 92 + n * 5 : n > 0.9 ? 99.2 : 100 };
      }),
    })),
  };
}

function diagnose(sid: string | null): DiagnoseReport {
  const s = servers.find((x) => x.id === sid) ?? null;
  const latest = s && PROFILES[s.id] ? point(s.id, Date.now()) : null;
  return {
    generatedAt: iso(Date.now()),
    scope: { serverId: sid, appId: null },
    healthy: false,
    summary: `${s?.name ?? 'Fleet'}: 1 critical and 2 warnings. Memory pressure is driven by the docs container; worker is crash-looping.`,
    findings: [
      { severity: 'critical', title: 'Memory is 91% used', detail: 'Available memory has stayed under 10% for 6 minutes and swap is in use.', evidence: ['mem 7.3 GB / 8.0 GB (91.2%)', 'swap 1.2 GB used', 'top: dx-docs-8d7e6f5a 3.4 GB, dx-redis-55e0aa12 1.1 GB'], suggestion: 'Set a memory limit on docs or move it to prod-eu-1, which has 6 GB free.', action: { tool: 'update_app', args: { app: 'docs', memoryLimit: '2g' } } },
      { severity: 'warning', title: 'worker is in a restart loop', detail: 'The container restarted 7 times in 10 minutes. Last exit code 1.', evidence: ['restartCount 7', 'Error: connect ECONNREFUSED 10.0.1.4:6379', 'at TCPConnectWrap.afterConnect [as oncomplete]'], suggestion: 'REDIS_URL points to an old address. Update the env var and redeploy.', action: { tool: 'set_env_vars', args: { app: 'worker', vars: { REDIS_URL: 'redis://dx-redis:6379' } } } },
      { severity: 'warning', title: 'Disk is 88% full', detail: 'Docker images and build cache use 21 GB.', evidence: ['/ 70.4 GB / 80 GB', 'docker system df: images 14.2 GB reclaimable'], suggestion: 'Run `docker system prune -af --filter until=168h` or let Docksy prune old images.' },
      { severity: 'info', title: 'TLS certificate renews in 61 days', detail: 'docs.example.com is served by Caddy with automatic HTTPS.', evidence: ['notAfter 2027-01-01'], suggestion: 'Nothing to do, Caddy renews it automatically.' },
    ],
    context: { server: s, latest, trend1h: { cpuAvg: 68, cpuMax: 93, memAvgPct: 88, memMaxPct: 92 }, firingAlerts: alerts.filter((a) => a.state === 'firing'), recentDeployments: [], containers: sid ? containers(sid, Date.now()) : [], recentLogs: [] },
  };
}

function overview(): FleetOverview {
  const items = servers.map((s) => {
    const has = !!PROFILES[s.id];
    const end = s.liveness === 'offline' ? new Date(s.lastSeenAt!).getTime() : Date.now();
    const t0 = Math.floor(end / 10e3) * 10e3;
    return {
      server: { ...s, lastSeenAt: s.liveness === 'online' ? iso(Date.now() - 3000) : s.lastSeenAt },
      latest: has ? point(s.id, t0) : null,
      spark: has ? Array.from({ length: 30 }, (_, i) => point(s.id, t0 - (29 - i) * 10e3).cpu) : [],
      appsCount: apps.filter((a) => a.serverId === s.id).length,
      firingAlerts: alerts.filter((a) => a.state === 'firing' && a.serverId === s.id).length,
    };
  });
  return {
    servers: items,
    totals: {
      servers: servers.length, online: servers.filter((s) => s.liveness === 'online').length, apps: apps.length,
      runningContainers: Object.values(CONTAINERS).flat().filter((c) => (c.state ?? 'running') === 'running').length,
      firingAlerts: alerts.filter((a) => a.state === 'firing').length,
    },
  };
}

// ───────────── provisioning script ─────────────

const PROVISION = [
  '::step:: Connecting over SSH', 'Connected to root@HOST (Ubuntu 24.04 LTS)', '::step:: Installing Docker',
  '# Executing docker install script, commit: 4c94a56', '+ sh -c apt-get update -qq >/dev/null', '+ sh -c DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-ce docker-ce-cli containerd.io >/dev/null',
  'Docker version 28.4.0, build d8eb465', '::step:: Creating network docksy', '7f1c0b9e2d3a docksy', '::step:: Starting docksy-proxy (Caddy)',
  'Unable to find image lucaslorentz/caddy-docker-proxy:2.9 locally', '2.9: Pulling from lucaslorentz/caddy-docker-proxy', 'Status: Downloaded newer image', 'docksy-proxy started on :80, :443',
  '::step:: Opening firewall ports 80/443', 'Rules updated', '::step:: Installing the Docksy agent', 'Downloading docksy-agent-linux-amd64 (5.8 MB)',
  'Created symlink /etc/systemd/system/multi-user.target.wants/docksy-agent.service', '::step:: Waiting for the first metrics report', 'Agent reported: 4 cores, 7.8 GB RAM', 'Done. Your server is ready.',
];

// ───────────── mock transport ─────────────

const json = (data: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const err = (status: number, code: string, message: string) => json({ error: { code, message } }, status);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let auth: AuthState = { setupRequired: false, user };
let empty = false;
let seq = 100;
const nid = (p: string) => `${p}${++seq}`;

async function route(method: string, url: URL, body: any): Promise<Response> {
  const p = url.pathname.replace(/^\/api\/v1/, '');
  const q = url.searchParams;
  const seg = p.split('/').filter(Boolean);
  const srv = (id: string) => servers.find((s) => s.id === id || s.name === id);

  // auth
  if (p === '/auth/state') return json(auth);
  if (p === '/auth/me') return auth.user ? json(auth.user) : err(401, 'unauthorized', 'Sign in first');
  if (p === '/auth/login' && method === 'POST') {
    if (!body?.password || body.password.length < 3) return err(401, 'invalid_credentials', 'That email and password don’t match.');
    auth = { setupRequired: false, user: { ...user, email: body.email } };
    return json(auth.user);
  }
  if (p === '/auth/setup' && method === 'POST') { auth = { setupRequired: false, user: { ...user, email: body.email, name: body.name } }; return json(auth.user); }
  if (p === '/auth/logout') { auth = { setupRequired: false, user: null }; return json({ ok: true }); }

  // fleet
  if (p === '/overview') return json(empty ? { servers: [], totals: { servers: 0, online: 0, apps: 0, runningContainers: 0, firingAlerts: 0 } } : overview());
  if (p === '/ssh-key') return json({ publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM0ckPq3Wz5d1zXb9cQm7n0x2c3y8sJqJr8yYb6Kk1aT docksy', fingerprint: 'SHA256:Qk3v1T3xq8n6j9W0n5b2Vb7nZb3mM7d0Yb4tq2Yb7c8', instructions: "mkdir -p ~/.ssh && echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM0ckPq3Wz5d1zXb9cQm7n0x2c3y8sJqJr8yYb6Kk1aT docksy' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys" } satisfies SshKeyInfo);
  if (p === '/servers' && method === 'GET') return json({ items: empty ? [] : servers });
  if (p === '/servers' && method === 'POST') {
    const s = mkServer(nid('s'), body.name, body.host, { port: body.port ?? 22, sshUser: body.sshUser ?? 'root', status: 'new', liveness: 'unknown', lastSeenAt: null, os: null, arch: null, cpuCores: null, memTotal: null, diskTotal: null, agentVersion: null });
    servers = [...servers, s];
    return json(s, 201);
  }
  if (seg[0] === 'servers' && seg[1]) {
    const s = srv(seg[1]);
    if (!s) return err(404, 'not_found', 'Server not found');
    if (seg.length === 2 && method === 'GET') return json(s);
    if (seg.length === 2 && method === 'PATCH') { Object.assign(s, body); return json(s); }
    if (seg.length === 2 && method === 'DELETE') {
      if (apps.some((a) => a.serverId === s.id)) return err(409, 'conflict', 'This server still has apps. Delete or move them first.');
      servers = servers.filter((x) => x !== s); return json({ ok: true });
    }
    if (seg[2] === 'metrics' && !seg[3]) return json(history(s.id, (q.get('range') as MetricsRange) ?? '1h'));
    if (seg[2] === 'containers') return json({ items: containers(s.id, Date.now()) });
    if (seg[2] === 'validate') {
      await sleep(1400);
      const bad = s.host.startsWith('10.');
      return json({ ok: !bad, checks: [
        { name: 'SSH connection', ok: !bad, detail: bad ? 'Connection timed out after 10s' : `Connected as ${s.sshUser}@${s.host}:${s.port}` },
        { name: 'Root or sudo', ok: !bad, detail: bad ? 'Skipped' : 'Running as root' },
        { name: 'Operating system', ok: !bad, detail: bad ? 'Skipped' : 'Ubuntu 24.04 LTS (amd64)' },
        { name: 'Docker', ok: false, detail: 'Not installed. Docksy will install it during provisioning.' },
        { name: 'Free disk', ok: !bad, detail: bad ? 'Skipped' : '71 GB free on /' },
      ] } satisfies ValidateServerResponse);
    }
    if (seg[2] === 'provision' && !seg[3]) {
      if (method === 'POST') s.status = 'provisioning';
      else if (s.status === 'new') return err(404, 'not_found', 'Not provisioned yet');
      return json({ serverId: s.id, status: s.status === 'provisioning' ? 'running' : s.status === 'ready' ? 'succeeded' : 'failed', log: '' } satisfies ProvisionJob);
    }
  }
  if (p === '/apps') return json({ items: empty ? [] : apps.filter((a) => !q.get('serverId') || a.serverId === q.get('serverId')) });

  // alerts
  if (p === '/alerts') {
    const st = q.get('state');
    return json({ items: alerts.filter((a) => !st || a.state === st).slice(0, Number(q.get('limit') ?? 100)) });
  }
  if (seg[0] === 'alerts' && seg[2] === 'ack') { const a = alerts.find((x) => x.id === seg[1]); if (a) a.ackedAt = iso(Date.now()); return json(a ?? { ok: true }); }
  if (p === '/alert-rules' && method === 'GET') return json({ items: rules });
  if (p === '/alert-rules' && method === 'POST') { const r: AlertRule = { ...body, id: nid('r'), isDefault: false, createdAt: iso(Date.now()) }; rules = [...rules, r]; return json(r, 201); }
  if (seg[0] === 'alert-rules' && seg[1]) {
    if (method === 'DELETE') { rules = rules.filter((r) => r.id !== seg[1]); return json({ ok: true }); }
    rules = rules.map((r) => (r.id === seg[1] ? { ...r, ...body } : r)); return json(rules.find((r) => r.id === seg[1]));
  }
  if (p === '/notification-channels' && method === 'GET') return json({ items: channels });
  if (p === '/notification-channels' && method === 'POST') { const c: NotificationChannel = { ...body, id: nid('c'), createdAt: iso(Date.now()) }; channels = [...channels, c]; return json(c, 201); }
  if (seg[0] === 'notification-channels' && seg[1]) {
    if (seg[2] === 'test') { await sleep(700); return seg[1] === 'c2' ? err(502, 'delivery_failed', 'SMTP 535: authentication failed') : json({ ok: true }); }
    if (method === 'DELETE') { channels = channels.filter((c) => c.id !== seg[1]); return json({ ok: true }); }
    channels = channels.map((c) => (c.id === seg[1] ? { ...c, ...body } : c)); return json(channels.find((c) => c.id === seg[1]));
  }

  // uptime
  if (p === '/uptime-checks' && method === 'GET') return json({ items: checks });
  if (p === '/uptime-checks' && method === 'POST') {
    const c: UptimeCheck = { appId: null, timeoutMs: 10000, expectedStatus: 0, public: false, enabled: true, intervalSec: 60, ...body, id: nid('u'), lastStatus: 'unknown', uptime24h: null, avgLatencyMs24h: null, createdAt: iso(Date.now()) };
    checks = [...checks, c]; return json(c, 201);
  }
  if (seg[0] === 'uptime-checks' && seg[1]) {
    if (seg[2] === 'results') return json({ items: results(seg[1]) });
    if (method === 'DELETE') { checks = checks.filter((c) => c.id !== seg[1]); return json({ ok: true }); }
    checks = checks.map((c) => (c.id === seg[1] ? { ...c, ...body } : c)); return json(checks.find((c) => c.id === seg[1]));
  }
  if (p === '/public/status') return json(publicStatus());
  if (p === '/diagnose') { await sleep(900); return json(diagnose(q.get('serverId'))); }
  if (p === '/settings') return json({ instanceName: 'Docksy', publicUrl: location.origin, statusPageEnabled: true, statusPageTitle: 'Acme Status', metricsRetentionDays: 30 });

  return method === 'GET' ? err(404, 'not_found', `mock: no handler for ${p}`) : json({ ok: true });
}

type Emit = (event: string, data: unknown) => void;

/** Starts a fake event stream for an SSE path; returns a stop function. */
function stream(path: string, emit: Emit): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const live = /^\/servers\/([^/]+)\/metrics\/live$/.exec(path);
  if (live) {
    const s = servers.find((x) => x.id === live[1] || x.name === live[1]);
    if (!s || !PROFILES[s.id] || s.liveness !== 'online') return () => {};
    const send = () => {
      const t = Date.now();
      const pt = point(s.id, t);
      emit('metrics', { serverId: s.id, point: pt, perCore: perCore(s.id, t, pt.cpu), containers: containers(s.id, t) } satisfies LiveMetricsEvent);
    };
    send();
    timers.push(setInterval(send, 2000));
    return () => timers.forEach(clearInterval);
  }
  const prov = /^\/servers\/([^/]+)\/provision\/stream$/.exec(path);
  if (prov) {
    const s = servers.find((x) => x.id === prov[1]);
    const lines = PROVISION.map((l) => l.replace('HOST', s?.host ?? 'server'));
    let i = 0;
    const tick = () => {
      if (i < lines.length) { emit('log', { line: lines[i++] }); timers.push(setTimeout(tick, 250 + Math.random() * 450)); return; }
      if (s) { s.status = 'ready'; s.liveness = 'online'; }
      emit('status', { status: 'succeeded' });
    };
    timers.push(setTimeout(tick, 400));
    return () => timers.forEach(clearTimeout);
  }
  return () => {};
}

export function installMock(): void {
  const mode = mockMode();
  if (!mode || typeof window === 'undefined' || (window as any).__docksyMock) return;
  (window as any).__docksyMock = mode;
  empty = mode === 'empty';
  if (mode === 'signedout') auth = { setupRequired: false, user: null };
  if (mode === 'setup') auth = { setupRequired: true, user: null };
  if (mode === 'provision') servers = servers.map((s) => (s.id === 's4' ? { ...s, status: 'provisioning' } : s));
  console.info(`%c[docksy] mock backend on (${mode}). Use ?mock=0 to turn it off.`, 'color:#38bdf8');

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/v1/')) return realFetch(input, init);
    await sleep(120 + Math.random() * 180);
    let body: unknown;
    try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
    return route((init?.method ?? 'GET').toUpperCase(), url, body);
  };

  const RealES = window.EventSource;
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
    private stop: () => void = () => {};
    constructor(url: string | URL, init?: EventSourceInit) {
      super();
      const u = new URL(String(url), location.origin);
      this.url = u.href;
      this.withCredentials = !!init?.withCredentials;
      if (!u.pathname.startsWith('/api/v1/')) return new RealES(url, init) as unknown as MockEventSource;
      setTimeout(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        this.onopen?.(new Event('open'));
        this.stop = stream(u.pathname.replace(/^\/api\/v1/, ''), (event, data) => {
          if (this.readyState !== 1) return;
          const ev = new MessageEvent(event, { data: JSON.stringify(data) });
          this.dispatchEvent(ev);
          if (event === 'message') this.onmessage?.(ev);
        });
      }, 150);
    }
    close() { this.readyState = 2; this.stop(); }
  }
  window.EventSource = MockEventSource as unknown as typeof EventSource;
}
