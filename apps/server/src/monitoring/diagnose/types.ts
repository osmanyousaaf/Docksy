import type { Alert, App, AppStatus, ContainerInfo, Deployment, MetricPoint, Server, UptimeCheck } from '@docksy/shared';

/** Subset of `docker inspect` we care about (collected over SSH). */
export interface InspectInfo {
  id: string; // 12-char short id
  name: string; // without leading "/"
  status: string; // running | exited | restarting | ...
  oomKilled: boolean;
  exitCode: number;
  restartCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  health: string | null; // healthy | unhealthy | starting | null (no healthcheck)
  healthFailingStreak: number;
  healthLastOutput: string | null;
  memLimit: number; // bytes, 0 = no limit
  labels: Record<string, string>;
}

/** One row of `docker system df`. Sizes are docker's human strings ("5.2GB"). */
export interface DockerDfRow { type: string; totalCount: string; size: string; reclaimable: string }

export interface TlsInfo {
  host: string;
  reachable: boolean; // TCP+TLS handshake completed on :443
  ok: boolean; // certificate trusted for this host
  validTo: string | null;
  daysLeft: number | null;
  issuer: string | null;
  error: string | null;
  errorCode: string | null;
}

export interface AppBrief {
  id: string;
  name: string;
  status: AppStatus;
  kind: string;
  currentDeploymentId: string | null;
  /** most recent finished deployment (succeeded/failed/cancelled) */
  lastDeploy: Deployment | null;
  /** tail of the build log, only filled when lastDeploy failed */
  lastDeployLogTail: string[];
  /** newest succeeded deployment with an image that isn't the current one — what rollback_app would use */
  rollbackTarget: Deployment | null;
}

export interface UptimeBrief {
  check: UptimeCheck;
  lastError: string | null;
  lastStatusCode: number | null;
  consecutiveFails: number;
}

export interface TrendStats { cpuAvg: number; cpuMax: number; memAvgPct: number; memMaxPct: number }

/** Everything the rules look at. Built by gather.ts; rules are pure functions of this. */
export interface DiagnoseContext {
  now: number;
  /** "prod-1" or "app api on prod-1" — used in titles and the summary */
  label: string;
  server: Server | null;
  /** set in app scope: container/log/TLS rules focus on this app */
  app: App | null;
  apps: AppBrief[];
  latest: MetricPoint | null;
  /** last hour of points, oldest first */
  points1h: MetricPoint[];
  trend1h: TrendStats | null;
  /** all containers on the server (agent snapshot) */
  containers: ContainerInfo[];
  /** null when SSH wasn't attempted or failed */
  inspect: InspectInfo[] | null;
  dockerDf: DockerDfRow[] | null;
  sshAttempted: boolean;
  sshError: string | null;
  firingAlerts: Alert[];
  recentDeployments: Deployment[];
  recentLogs: string[];
  logsContainer: string | null;
  uptime: UptimeBrief[];
  tls: TlsInfo | null;
}
