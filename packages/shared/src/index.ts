/**
 * Docksy shared types — the single source of truth for API JSON shapes.
 * Types only. Import with `import type { ... } from '@docksy/shared'`.
 * All timestamps in API JSON are ISO-8601 strings. All IDs are opaque strings.
 * Byte values are integers (bytes). Percentages are 0–100 floats.
 */

// ───────────────────────────── common ─────────────────────────────

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export interface Page<T> {
  items: T[];
  total: number;
}

export interface Health {
  ok: true;
  version: string;
  uptimeSec: number;
}

// ───────────────────────────── auth ─────────────────────────────

export type Role = 'owner' | 'admin' | 'viewer';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
}

export interface AuthState {
  setupRequired: boolean;
  user: User | null;
}

export interface SetupRequest { email: string; name: string; password: string }
export interface LoginRequest { email: string; password: string }

export type TokenScope = 'full' | 'read';

export interface ApiToken {
  id: string;
  name: string;
  prefix: string; // first 10 chars, e.g. "dsk_ab12cd"
  scope: TokenScope;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CreateTokenRequest { name: string; scope?: TokenScope }
export interface CreateTokenResponse { token: ApiToken; plaintext: string } // plaintext shown once

// ───────────────────────────── settings ─────────────────────────────

export interface Settings {
  instanceName: string;
  publicUrl: string; // URL agents + webhooks use to reach this control plane
  statusPageEnabled: boolean;
  statusPageTitle: string;
  metricsRetentionDays: number;
}

// ───────────────────────────── servers ─────────────────────────────

export type ServerStatus = 'new' | 'provisioning' | 'ready' | 'error';
export type Liveness = 'online' | 'offline' | 'unknown';

export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  sshUser: string;
  status: ServerStatus;
  liveness: Liveness; // online if agent reported within 60s
  lastSeenAt: string | null;
  agentVersion: string | null;
  os: string | null;
  arch: string | null;
  cpuCores: number | null;
  memTotal: number | null;
  diskTotal: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateServerRequest { name: string; host: string; port?: number; sshUser?: string }
export interface UpdateServerRequest { name?: string; host?: string; port?: number; sshUser?: string }

export interface SshKeyInfo {
  publicKey: string; // "ssh-ed25519 AAAA... docksy"
  fingerprint: string;
  instructions: string; // one-liner the user pastes on the VPS
}

export interface ValidateServerResponse {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[]; // ssh, sudo/root, os, docker, disk
}

export interface ProvisionJob {
  serverId: string;
  status: 'running' | 'succeeded' | 'failed';
  log: string;
}

// ───────────────────────────── apps ─────────────────────────────

export type AppKind = 'app' | 'database' | 'service';
export type BuildType = 'auto' | 'dockerfile' | 'compose' | 'image';
export type AppStatus = 'idle' | 'deploying' | 'running' | 'stopped' | 'failed';

export interface Volume { name: string; mountPath: string }

export interface App {
  id: string;
  name: string; // slug: lowercase a-z0-9-
  description: string | null;
  serverId: string;
  kind: AppKind;
  template: string | null; // e.g. "postgres"
  sourceType: 'git' | 'image';
  repoUrl: string | null;
  branch: string | null;
  hasGitToken: boolean;
  image: string | null;
  buildType: BuildType;
  dockerfilePath: string; // default "Dockerfile"
  buildContext: string; // default "."
  composePath: string; // default "docker-compose.yml"
  port: number | null; // container port to route to
  domains: string[]; // first is primary; auto sslip.io domain added if empty
  healthcheckPath: string | null; // e.g. "/health"; null = container running is enough
  volumes: Volume[];
  startCommand: string | null; // overrides the image CMD
  watchPaths: string[]; // globs; push webhooks deploy only when a changed file matches (empty = always)
  cpuLimit: number | null; // cores, e.g. 0.5
  memLimitMb: number | null; // MB
  suggestedDomain: string | null; // <name>.<server-ip>.sslip.io, for the "Generate domain" button
  status: AppStatus;
  autoDeploy: boolean;
  webhookUrl: string; // {publicUrl}/api/v1/webhooks/github/{id}
  currentDeploymentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAppRequest {
  name: string;
  description?: string | null;
  startCommand?: string | null;
  watchPaths?: string[];
  cpuLimit?: number | null;
  memLimitMb?: number | null;
  serverId: string;
  template?: string; // if set, image/port/volumes/env come from the template
  sourceType?: 'git' | 'image';
  repoUrl?: string;
  branch?: string;
  gitToken?: string;
  image?: string;
  buildType?: BuildType;
  dockerfilePath?: string;
  buildContext?: string;
  composePath?: string;
  port?: number;
  domains?: string[];
  healthcheckPath?: string | null;
  volumes?: Volume[];
  env?: Record<string, string>;
  autoDeploy?: boolean;
}

export type UpdateAppRequest = Partial<Omit<CreateAppRequest, 'serverId' | 'template'>>;

export interface EnvVars { vars: Record<string, string> }

/** POST /apps/:id/exec — run one command inside the app's running container (30s limit). */
export interface ExecRequest { command: string }
export interface ExecResponse { code: number; stdout: string; stderr: string; container: string | null; durationMs: number } // GET returns values masked unless ?reveal=1

export interface Template {
  id: string; // "postgres"
  name: string; // "PostgreSQL"
  kind: AppKind;
  description: string;
  image: string;
  port: number | null;
  volumes: Volume[];
  env: Record<string, string>; // values may contain "{{random:32}}" placeholders
  backupSupported: boolean;
}

// ───────────────────────────── deployments ─────────────────────────────

export type DeploymentStatus = 'queued' | 'building' | 'deploying' | 'succeeded' | 'failed' | 'cancelled';
export type DeploymentTrigger = 'manual' | 'webhook' | 'rollback' | 'api' | 'mcp';

export interface Deployment {
  id: string;
  appId: string;
  status: DeploymentStatus;
  trigger: DeploymentTrigger;
  commitSha: string | null;
  commitMessage: string | null;
  imageTag: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface DeployRequest { ref?: string; trigger?: DeploymentTrigger }
export interface RollbackRequest { deploymentId?: string } // default: previous succeeded deployment

export interface LogLine { ts: string; stream: 'stdout' | 'stderr' | 'system'; line: string }

/** SSE events on GET /api/v1/deployments/:id/logs/stream */
export type DeploymentStreamEvent =
  | { event: 'log'; data: LogLine }
  | { event: 'status'; data: { status: DeploymentStatus; error: string | null } };

// ───────────────────────────── agent protocol ─────────────────────────────

/** Body of POST /api/agent/v1/report (Authorization: Bearer dsa_...). Sent every intervalSec. */
export interface AgentReport {
  agentVersion: string;
  hostname: string;
  os: string; // "ubuntu 24.04"
  arch: string; // "amd64" | "arm64"
  uptimeSec: number;
  ts: number; // unix ms, agent clock
  cpu: { percent: number; cores: number; perCore: number[]; load1: number; load5: number; load15: number };
  mem: { total: number; used: number; available: number; swapTotal: number; swapUsed: number };
  disks: { mount: string; fs: string; total: number; used: number }[];
  net: { rxBytesPerSec: number; txBytesPerSec: number };
  containers: AgentContainer[];
}

export interface AgentContainer {
  id: string; // 12-char short id
  name: string;
  image: string;
  state: 'running' | 'exited' | 'restarting' | 'paused' | 'created' | 'dead' | 'removing';
  status: string; // docker human status, e.g. "Up 3 hours (healthy)"
  restartCount: number;
  startedAt: string | null;
  cpuPercent: number;
  memUsed: number;
  memLimit: number;
  netRx: number; // bytes/s
  netTx: number; // bytes/s
  labels: Record<string, string>; // includes docksy.app / docksy.deployment when managed
}

export interface AgentReportResponse { ok: true; intervalSec: number }

// ───────────────────────────── metrics ─────────────────────────────

export type MetricsRange = '15m' | '1h' | '6h' | '24h' | '7d' | '30d';

export interface MetricPoint {
  ts: string;
  cpu: number;
  load1: number;
  load5: number;
  load15: number;
  memUsed: number;
  memTotal: number;
  swapUsed: number;
  diskUsed: number; // root/largest mount
  diskTotal: number;
  netRx: number;
  netTx: number;
}

export interface ServerMetrics { serverId: string; range: MetricsRange; stepSec: number; points: MetricPoint[] }

export interface ContainerMetricPoint { ts: string; cpu: number; memUsed: number; netRx: number; netTx: number }

export interface ContainerInfo extends AgentContainer { serverId: string; appId: string | null; updatedAt: string }

/** SSE event "metrics" on GET /api/v1/servers/:id/metrics/live — data is the latest point + containers */
export interface LiveMetricsEvent { serverId: string; point: MetricPoint; perCore: number[]; containers: ContainerInfo[] }

export interface FleetOverview {
  servers: {
    server: Server;
    latest: MetricPoint | null;
    spark: number[]; // last 30 CPU values for sparklines
    appsCount: number;
    firingAlerts: number;
  }[];
  totals: { servers: number; online: number; apps: number; runningContainers: number; firingAlerts: number };
}

// ───────────────────────────── alerts ─────────────────────────────

export type AlertMetric =
  | 'cpu' | 'mem' | 'disk' | 'load' | 'swap'
  | 'server_offline' | 'container_down' | 'container_restarts'
  | 'deploy_failed' | 'uptime_down' | 'backup_failed';

export type Severity = 'info' | 'warning' | 'critical';

export interface AlertRule {
  id: string;
  name: string;
  metric: AlertMetric;
  op: '>' | '<';
  threshold: number; // percent for cpu/mem/disk/swap, absolute for load, count for restarts; ignored for event metrics
  durationSec: number; // condition must hold this long before firing
  severity: Severity;
  serverId: string | null; // null = all servers
  appId: string | null;
  channelIds: string[]; // empty = all enabled channels
  enabled: boolean;
  isDefault: boolean;
  createdAt: string;
}

export type CreateAlertRuleRequest = Omit<AlertRule, 'id' | 'createdAt' | 'isDefault'>;

export interface Alert {
  id: string;
  ruleId: string | null;
  serverId: string | null;
  appId: string | null;
  state: 'firing' | 'resolved';
  severity: Severity;
  title: string;
  message: string;
  value: number | null;
  startedAt: string;
  resolvedAt: string | null;
  ackedAt: string | null;
}

export type ChannelType = 'discord' | 'slack' | 'telegram' | 'webhook' | 'email';

export interface NotificationChannel {
  id: string;
  name: string;
  type: ChannelType;
  /** discord/slack: {url}; telegram: {botToken, chatId}; webhook: {url, secret?}; email: {host, port, secure, user, pass, from, to} — secrets masked in GET */
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
}

// ───────────────────────────── uptime ─────────────────────────────

export interface UptimeCheck {
  id: string;
  name: string;
  url: string;
  appId: string | null;
  intervalSec: number; // min 30
  timeoutMs: number;
  expectedStatus: number; // 0 = any 2xx/3xx
  public: boolean; // shown on status page
  enabled: boolean;
  lastStatus: 'up' | 'down' | 'unknown';
  uptime24h: number | null; // percent
  avgLatencyMs24h: number | null;
  createdAt: string;
}

export interface UptimeResult { ts: string; ok: boolean; statusCode: number | null; latencyMs: number | null; error: string | null }

export interface PublicStatus {
  title: string;
  overall: 'operational' | 'degraded' | 'down';
  checks: { name: string; status: 'up' | 'down' | 'unknown'; uptime90d: number | null; days: { date: string; uptime: number | null }[] }[];
  updatedAt: string;
}

// ───────────────────────────── backups ─────────────────────────────

export interface BackupConfig {
  id: string;
  appId: string; // must be a database app with backupSupported template
  schedule: 'hourly' | 'daily' | 'weekly';
  retention: number; // keep last N
  destination: 'local' | 's3';
  s3: { endpoint: string; bucket: string; region: string; accessKey: string; prefix: string } | null; // secretKey write-only
  verify: boolean; // after each run, restore into a throwaway container and sanity-check
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
}

export interface BackupS3Input { endpoint: string; bucket: string; region?: string; accessKey: string; secretKey?: string; prefix?: string }

/** POST /backups. s3.secretKey is required on create, optional on PATCH (kept if omitted). */
export interface CreateBackupRequest {
  appId: string;
  schedule?: BackupConfig['schedule'];
  retention?: number;
  destination?: BackupConfig['destination'];
  s3?: BackupS3Input | null;
  verify?: boolean;
  enabled?: boolean;
}
export type UpdateBackupRequest = Partial<Omit<CreateBackupRequest, 'appId'>>;

/** POST /backup-runs/:id/restore → { ok: true, log } (synchronous). Run/verify return 202 + BackupRun. */
export interface RestoreResponse { ok: true; log: string }

export interface BackupRun {
  id: string;
  backupId: string;
  status: 'running' | 'succeeded' | 'failed';
  verified: 'pending' | 'passed' | 'failed' | 'skipped';
  sizeBytes: number | null;
  path: string | null;
  log: string;
  startedAt: string;
  finishedAt: string | null;
}

// ───────────────────────────── diagnose (AI-native) ─────────────────────────────

export interface DiagnoseFinding {
  severity: Severity;
  title: string; // "Memory is 96% used"
  detail: string;
  evidence: string[]; // concrete numbers / log lines
  suggestion: string; // what to do; may reference a Docksy action
  action?: { tool: string; args: Record<string, unknown> }; // optional MCP tool call that would fix it
}

/** GET /api/v1/diagnose?serverId=&appId= — deterministic, no LLM. Built to be read by Claude via MCP. */
export interface DiagnoseReport {
  generatedAt: string;
  scope: { serverId: string | null; appId: string | null };
  healthy: boolean;
  summary: string;
  findings: DiagnoseFinding[];
  context: {
    server: Server | null;
    latest: MetricPoint | null;
    trend1h: { cpuAvg: number; cpuMax: number; memAvgPct: number; memMaxPct: number } | null;
    firingAlerts: Alert[];
    recentDeployments: Deployment[];
    containers: ContainerInfo[];
    recentLogs: string[]; // last ~100 lines of the app container (if appId)
  };
}

// ───────────────────────────── activity ─────────────────────────────

export interface ActivityEntry {
  id: number;
  ts: string;
  actor: string; // "user:<email>" | "token:<name>" | "system" | "webhook"
  action: string; // "app.deploy", "server.create", ...
  targetType: string | null;
  targetId: string | null;
  detail: string | null;
}
