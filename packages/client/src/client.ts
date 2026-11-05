import type {
  ActivityEntry, CreateBackupRequest, UpdateBackupRequest, RestoreResponse, AgentReport, AgentReportResponse, Alert, AlertRule, ApiToken, App, AuthState, BackupConfig, BackupRun,
  ContainerInfo, ContainerMetricPoint, CreateAlertRuleRequest, CreateAppRequest, CreateServerRequest, CreateTokenRequest,
  CreateTokenResponse, Deployment, DeploymentStatus, DeploymentStreamEvent, DeployRequest, DiagnoseReport, EnvVars,
  FleetOverview, Health, LiveMetricsEvent, LoginRequest, LogLine, NotificationChannel, ProvisionJob, PublicStatus,
  RollbackRequest, Server, ServerMetrics, Settings, SetupRequest, SshKeyInfo, Template, UpdateAppRequest,
  UpdateServerRequest, UptimeCheck, UptimeResult, User, ValidateServerResponse,
} from './types.ts';
import type {
  CallOptions, CreateChannelRequest, CreateUptimeCheckRequest, DiagnoseQuery, ListAlertsQuery,
  ListDeploymentsQuery, MetricsQuery, UpdateAlertRuleRequest, UpdateChannelRequest,
  UpdateSettingsRequest, UpdateUptimeCheckRequest, UptimeResultsQuery,
} from './requests.ts';
import { DocksyApiError } from './errors.ts';
import { SseParser, type SseEvent } from './sse.ts';
import { VERSION } from './version.ts';

export interface DocksyClientOptions {
  /** Base URL of the Docksy control plane, e.g. "https://docksy.example.com". A trailing "/api/v1" is tolerated. */
  url: string;
  /** API token ("dsk_…"). Optional for public routes and for login(). */
  token?: string;
  /** Default request timeout in ms (default 30000). Streams only use it for the initial connection. */
  timeoutMs?: number;
  /** Override the User-Agent (default "docksy-client/<version>"). Ignored by browsers. */
  userAgent?: string;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /** Custom fetch implementation (default globalThis.fetch). */
  fetch?: typeof fetch;
}

type Query = Record<string, string | number | boolean | null | undefined>;

interface RequestOptions extends CallOptions {
  query?: Query;
  body?: unknown;
  /** Return the raw Response instead of parsing JSON (caller owns the body). */
  raw?: boolean;
  /** Bearer token to use instead of the client's (agent routes). */
  bearer?: string;
}

export type ProvisionStreamEvent =
  | { event: 'log'; data: { line: string } }
  | { event: 'status'; data: { status: ProvisionJob['status'] } };

export type AppLogStreamEvent = { event: 'log'; data: { line: string } };

export type LiveMetricsStreamEvent = { event: 'metrics'; data: LiveMetricsEvent };

const SESSION_COOKIE = 'docksy_session';
const enc = encodeURIComponent;

/**
 * Typed client for the Docksy HTTP API (`/api/v1`).
 * Works in Node 20+ and browsers. Every failure throws DocksyApiError.
 *
 * ```ts
 * const docksy = new DocksyClient({ url: 'https://docksy.example.com', token: process.env.DOCKSY_TOKEN });
 * const apps = await docksy.listApps();
 * for await (const ev of docksy.streamDeploymentLogs(id)) console.log(ev);
 * ```
 */
export class DocksyClient {
  readonly baseUrl: string;
  readonly userAgent: string;
  token: string | undefined;
  /** Session cookie captured from login()/setup(), sent when no token is set. */
  sessionCookie: string | undefined;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DocksyClientOptions) {
    if (!opts || !opts.url) throw new TypeError('DocksyClient: `url` is required');
    this.baseUrl = normalizeBaseUrl(opts.url);
    this.token = opts.token || undefined;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.userAgent = opts.userAgent ?? `docksy-client/${VERSION}`;
    this.extraHeaders = { ...opts.headers };
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Absolute URL for an API path ("/apps" → "<base>/api/v1/apps"). Paths starting with "/api/" are used as-is. */
  url(path: string, query?: Query): string {
    const p = path.startsWith('/api/') ? path : `/api/v1${path.startsWith('/') ? path : `/${path}`}`;
    const qs = toQueryString(query);
    return `${this.baseUrl}${p}${qs}`;
  }

  /** Low-level JSON request. Prefer the typed methods. */
  async request<T>(method: string, path: string, o: RequestOptions = {}): Promise<T> {
    const url = this.url(path, o.query);
    const headers = this.headers(o.bearer);
    let body: string | undefined;
    if (o.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(o.body);
    }
    const timeoutMs = o.timeoutMs ?? this.timeoutMs;
    const signals: AbortSignal[] = [];
    if (o.signal) signals.push(o.signal);
    if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
    const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body, signal });
    } catch (e) {
      throw transportError(e, method, path, url, timeoutMs, o.signal);
    }
    this.captureSession(res);
    if (!res.ok) throw await toApiError(res, method, path);
    if (o.raw) return res as T;
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      throw transportError(e, method, path, url, timeoutMs, o.signal);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new DocksyApiError({ status: res.status, code: 'invalid_response', message: `Expected JSON from ${method} ${path}`, details: text.slice(0, 500), method, path });
    }
  }

  /**
   * Open an SSE stream and iterate its events. Breaking out of the loop (or aborting `signal`) closes the connection.
   * The client's timeout applies only until response headers arrive.
   */
  async *stream<T = SseEvent>(path: string, o: { query?: Query; signal?: AbortSignal; timeoutMs?: number } = {}): AsyncGenerator<T, void, undefined> {
    const url = this.url(path, o.query);
    const headers = { ...this.headers(), accept: 'text/event-stream', 'cache-control': 'no-cache' };
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(o.signal?.reason);
    if (o.signal?.aborted) onAbort();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const timeoutMs = o.timeoutMs ?? this.timeoutMs;
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs) : undefined;
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method: 'GET', headers, signal: ctl.signal });
      } catch (e) {
        if (timedOut) throw new DocksyApiError({ status: 0, code: 'timeout', message: `Timed out after ${timeoutMs}ms connecting to ${url}`, method: 'GET', path, cause: e });
        throw transportError(e, 'GET', path, url, timeoutMs, o.signal);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw await toApiError(res, 'GET', path);
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      try {
        for (;;) {
          let chunk;
          try {
            chunk = await reader.read();
          } catch (e) {
            if (o.signal?.aborted) return;
            throw transportError(e, 'GET', path, url, 0, o.signal);
          }
          if (chunk.done) {
            for (const ev of parser.push(decoder.decode())) yield ev as T;
            for (const ev of parser.end()) yield ev as T;
            return;
          }
          for (const ev of parser.push(decoder.decode(chunk.value, { stream: true }))) yield ev as T;
        }
      } finally {
        ctl.abort();
        reader.cancel().catch(() => {});
      }
    } finally {
      o.signal?.removeEventListener('abort', onAbort);
    }
  }

  private headers(bearer?: string): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json', ...this.extraHeaders };
    // Browsers forbid setting User-Agent; only send it where it is allowed.
    if (!('document' in globalThis)) h['user-agent'] = this.userAgent;
    const tok = bearer ?? this.token;
    if (tok) h.authorization = `Bearer ${tok}`;
    else if (this.sessionCookie) h.cookie = `${SESSION_COOKIE}=${this.sessionCookie}`;
    return h;
  }

  private captureSession(res: Response): void {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
    for (const c of list) {
      const m = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;,]*)`).exec(c);
      if (!m) continue;
      const expired = /max-age=0\b/i.test(c) || /expires=Thu, 01 Jan 1970/i.test(c);
      this.sessionCookie = expired || !m[1] ? undefined : m[1];
    }
  }

  private get<T>(path: string, query?: Query, o?: CallOptions) { return this.request<T>('GET', path, { ...o, query }); }
  private post<T>(path: string, body?: unknown, o?: CallOptions) { return this.request<T>('POST', path, { ...o, body: body ?? {} }); }
  private patch<T>(path: string, body: unknown, o?: CallOptions) { return this.request<T>('PATCH', path, { ...o, body }); }
  private put<T>(path: string, body: unknown, o?: CallOptions) { return this.request<T>('PUT', path, { ...o, body }); }
  private del<T>(path: string, query?: Query, o?: CallOptions) { return this.request<T>('DELETE', path, { ...o, query }); }
  private async items<T>(path: string, query?: Query, o?: CallOptions): Promise<T[]> {
    return (await this.get<{ items: T[] }>(path, query, o)).items;
  }

  // ───────────────────────────── health + auth ─────────────────────────────

  health(o?: CallOptions) { return this.get<Health>('/health', undefined, o); }
  getAuthState(o?: CallOptions) { return this.get<AuthState>('/auth/state', undefined, o); }
  /** Create the owner account (only when no users exist). Captures the session cookie. */
  setup(req: SetupRequest, o?: CallOptions) { return this.post<User>('/auth/setup', req, o); }
  /** Log in with email + password. Captures the session cookie, so you can then call createToken(). */
  login(req: LoginRequest, o?: CallOptions) { return this.post<User>('/auth/login', req, o); }
  async logout(o?: CallOptions) {
    const r = await this.post<{ ok: true }>('/auth/logout', {}, o);
    this.sessionCookie = undefined;
    return r;
  }
  me(o?: CallOptions) { return this.get<User>('/auth/me', undefined, o); }

  listTokens(o?: CallOptions) { return this.items<ApiToken>('/tokens', undefined, o); }
  /** The plaintext token is returned once. */
  createToken(req: CreateTokenRequest, o?: CallOptions) { return this.post<CreateTokenResponse>('/tokens', req, o); }
  deleteToken(id: string, o?: CallOptions) { return this.del<{ ok: true }>(`/tokens/${enc(id)}`, undefined, o); }

  getSettings(o?: CallOptions) { return this.get<Settings>('/settings', undefined, o); }
  updateSettings(req: UpdateSettingsRequest, o?: CallOptions) { return this.patch<Settings>('/settings', req, o); }

  listActivity(q: { limit?: number } = {}, o?: CallOptions) { return this.items<ActivityEntry>('/activity', q, o); }

  // ───────────────────────────── servers ─────────────────────────────

  getSshKey(o?: CallOptions) { return this.get<SshKeyInfo>('/ssh-key', undefined, o); }
  listServers(o?: CallOptions) { return this.items<Server>('/servers', undefined, o); }
  getServer(id: string, o?: CallOptions) { return this.get<Server>(`/servers/${enc(id)}`, undefined, o); }
  createServer(req: CreateServerRequest, o?: CallOptions) { return this.post<Server>('/servers', req, o); }
  updateServer(id: string, req: UpdateServerRequest, o?: CallOptions) { return this.patch<Server>(`/servers/${enc(id)}`, req, o); }
  /** Fails with 409 while apps still exist on the server. */
  deleteServer(id: string, o?: CallOptions) { return this.del<{ ok: true }>(`/servers/${enc(id)}`, undefined, o); }
  validateServer(id: string, o?: CallOptions) { return this.post<ValidateServerResponse>(`/servers/${enc(id)}/validate`, {}, { timeoutMs: 90_000, ...o }); }
  provisionServer(id: string, o?: CallOptions) { return this.post<ProvisionJob>(`/servers/${enc(id)}/provision`, {}, o); }
  getProvisionJob(id: string, o?: CallOptions) { return this.get<ProvisionJob>(`/servers/${enc(id)}/provision`, undefined, o); }
  streamProvision(id: string, o?: { signal?: AbortSignal }) { return this.stream<ProvisionStreamEvent>(`/servers/${enc(id)}/provision/stream`, o); }

  // ───────────────────────────── apps ─────────────────────────────

  listApps(q: { serverId?: string } = {}, o?: CallOptions) { return this.items<App>('/apps', q, o); }
  /** `id` may be the app id or its name. */
  getApp(id: string, o?: CallOptions) { return this.get<App>(`/apps/${enc(id)}`, undefined, o); }
  createApp(req: CreateAppRequest, o?: CallOptions) { return this.post<App>('/apps', req, o); }
  updateApp(id: string, req: UpdateAppRequest, o?: CallOptions) { return this.patch<App>(`/apps/${enc(id)}`, req, o); }
  /** Removes the app's containers. Volumes are kept unless `volumes: true`. */
  deleteApp(id: string, q: { volumes?: boolean } = {}, o?: CallOptions) {
    return this.del<{ ok: true }>(`/apps/${enc(id)}`, { volumes: q.volumes ? 1 : undefined }, o);
  }
  /** Values are masked unless `reveal: true`. */
  getEnv(id: string, q: { reveal?: boolean } = {}, o?: CallOptions) {
    return this.get<EnvVars>(`/apps/${enc(id)}/env`, { reveal: q.reveal ? 1 : undefined }, o);
  }
  /** Replaces the full set of env vars. */
  setEnv(id: string, vars: Record<string, string>, o?: CallOptions) { return this.put<EnvVars>(`/apps/${enc(id)}/env`, { vars }, o); }
  /** Merge `set` into the current vars and drop `unset` keys (read-modify-write of the revealed env). */
  async patchEnv(id: string, change: { set?: Record<string, string>; unset?: string[] }, o?: CallOptions) {
    const cur = (await this.getEnv(id, { reveal: true }, o)).vars;
    const next: Record<string, string> = { ...cur, ...change.set };
    for (const k of change.unset ?? []) delete next[k];
    return this.setEnv(id, next, o);
  }
  getWebhook(id: string, o?: CallOptions) { return this.get<{ url: string; secret: string }>(`/apps/${enc(id)}/webhook`, undefined, o); }
  listTemplates(o?: CallOptions) { return this.items<Template>('/templates', undefined, o); }

  // ───────────────────────────── deploy ─────────────────────────────

  deployApp(id: string, req: DeployRequest = {}, o?: CallOptions) { return this.post<Deployment>(`/apps/${enc(id)}/deploy`, req, o); }
  /** Without `deploymentId` the server picks the previous succeeded deployment. */
  rollbackApp(id: string, req: RollbackRequest = {}, o?: CallOptions) { return this.post<Deployment>(`/apps/${enc(id)}/rollback`, req, o); }
  restartApp(id: string, o?: CallOptions) { return this.post<App | { ok: true }>(`/apps/${enc(id)}/restart`, {}, { timeoutMs: 90_000, ...o }); }
  stopApp(id: string, o?: CallOptions) { return this.post<App | { ok: true }>(`/apps/${enc(id)}/stop`, {}, { timeoutMs: 90_000, ...o }); }
  startApp(id: string, o?: CallOptions) { return this.post<App | { ok: true }>(`/apps/${enc(id)}/start`, {}, { timeoutMs: 90_000, ...o }); }
  async getAppLogs(id: string, q: { tail?: number } = {}, o?: CallOptions) {
    return (await this.get<{ lines: string[] }>(`/apps/${enc(id)}/logs`, q, o)).lines;
  }
  streamAppLogs(id: string, o?: { signal?: AbortSignal }) { return this.stream<AppLogStreamEvent>(`/apps/${enc(id)}/logs/stream`, o); }
  listDeployments(q: ListDeploymentsQuery = {}, o?: CallOptions) { return this.items<Deployment>('/deployments', { ...q }, o); }
  getDeployment(id: string, o?: CallOptions) { return this.get<Deployment>(`/deployments/${enc(id)}`, undefined, o); }
  getDeploymentLogs(id: string, o?: CallOptions) { return this.items<LogLine>(`/deployments/${enc(id)}/logs`, undefined, o); }
  /** Replays existing lines first, then streams live `log` and `status` events. */
  streamDeploymentLogs(id: string, o?: { signal?: AbortSignal }) { return this.stream<DeploymentStreamEvent>(`/deployments/${enc(id)}/logs/stream`, o); }
  cancelDeployment(id: string, o?: CallOptions) { return this.post<Deployment | { ok: true }>(`/deployments/${enc(id)}/cancel`, {}, o); }

  /**
   * Follow a deployment until it finishes: yields log lines and status changes, then returns the final Deployment.
   * Falls back to polling if the stream drops before a terminal status.
   */
  async *followDeployment(id: string, o: { signal?: AbortSignal; pollMs?: number } = {}): AsyncGenerator<DeploymentStreamEvent, Deployment, undefined> {
    try {
      for await (const ev of this.streamDeploymentLogs(id, o)) {
        yield ev;
        if (ev.event === 'status' && isTerminal(ev.data.status)) return await this.getDeployment(id, o);
      }
    } catch (e) {
      if (!(e instanceof DocksyApiError) || e.status !== 0 || o.signal?.aborted) throw e;
    }
    for (;;) {
      const d = await this.getDeployment(id, o);
      if (isTerminal(d.status)) {
        yield { event: 'status', data: { status: d.status, error: d.error } };
        return d;
      }
      await sleep(o.pollMs ?? 2000, o.signal);
    }
  }

  // ───────────────────────────── metrics ─────────────────────────────

  getServerMetrics(id: string, q: MetricsQuery = {}, o?: CallOptions) { return this.get<ServerMetrics>(`/servers/${enc(id)}/metrics`, { ...q }, o); }
  /** Sends the latest sample immediately, then one `metrics` event per agent report. */
  streamServerMetrics(id: string, o?: { signal?: AbortSignal }) { return this.stream<LiveMetricsStreamEvent>(`/servers/${enc(id)}/metrics/live`, o); }
  listContainers(id: string, o?: CallOptions) { return this.items<ContainerInfo>(`/servers/${enc(id)}/containers`, undefined, o); }
  async getAppMetrics(id: string, q: MetricsQuery = {}, o?: CallOptions) {
    return (await this.get<{ points: ContainerMetricPoint[] }>(`/apps/${enc(id)}/metrics`, { ...q }, o)).points;
  }
  getFleetOverview(o?: CallOptions) { return this.get<FleetOverview>('/overview', undefined, o); }

  // ───────────────────────────── alerts ─────────────────────────────

  listAlertRules(o?: CallOptions) { return this.items<AlertRule>('/alert-rules', undefined, o); }
  createAlertRule(req: CreateAlertRuleRequest | (Partial<CreateAlertRuleRequest> & Pick<CreateAlertRuleRequest, 'name' | 'metric'>), o?: CallOptions) {
    return this.post<AlertRule>('/alert-rules', req, o);
  }
  updateAlertRule(id: string, req: UpdateAlertRuleRequest, o?: CallOptions) { return this.patch<AlertRule>(`/alert-rules/${enc(id)}`, req, o); }
  deleteAlertRule(id: string, o?: CallOptions) { return this.del<{ ok: true }>(`/alert-rules/${enc(id)}`, undefined, o); }
  listAlerts(q: ListAlertsQuery = {}, o?: CallOptions) { return this.items<Alert>('/alerts', { ...q }, o); }
  ackAlert(id: string, o?: CallOptions) { return this.post<Alert>(`/alerts/${enc(id)}/ack`, {}, o); }
  listChannels(o?: CallOptions) { return this.items<NotificationChannel>('/notification-channels', undefined, o); }
  createChannel(req: CreateChannelRequest, o?: CallOptions) { return this.post<NotificationChannel>('/notification-channels', req, o); }
  updateChannel(id: string, req: UpdateChannelRequest, o?: CallOptions) { return this.patch<NotificationChannel>(`/notification-channels/${enc(id)}`, req, o); }
  deleteChannel(id: string, o?: CallOptions) { return this.del<{ ok: true }>(`/notification-channels/${enc(id)}`, undefined, o); }
  testChannel(id: string, o?: CallOptions) { return this.post<{ ok: boolean; error?: string }>(`/notification-channels/${enc(id)}/test`, {}, o); }

  // ───────────────────────────── uptime + status + diagnose ─────────────────────────────

  listUptimeChecks(o?: CallOptions) { return this.items<UptimeCheck>('/uptime-checks', undefined, o); }
  createUptimeCheck(req: CreateUptimeCheckRequest, o?: CallOptions) { return this.post<UptimeCheck>('/uptime-checks', req, o); }
  updateUptimeCheck(id: string, req: UpdateUptimeCheckRequest, o?: CallOptions) { return this.patch<UptimeCheck>(`/uptime-checks/${enc(id)}`, req, o); }
  deleteUptimeCheck(id: string, o?: CallOptions) { return this.del<{ ok: true }>(`/uptime-checks/${enc(id)}`, undefined, o); }
  listUptimeResults(id: string, q: UptimeResultsQuery = {}, o?: CallOptions) { return this.items<UptimeResult>(`/uptime-checks/${enc(id)}/results`, { ...q }, o); }
  getPublicStatus(o?: CallOptions) { return this.get<PublicStatus>('/public/status', undefined, o); }
  /** Deterministic, rule-based health report for a server, an app, or the whole fleet. */
  diagnose(q: DiagnoseQuery = {}, o?: CallOptions) { return this.get<DiagnoseReport>('/diagnose', { ...q }, { timeoutMs: 90_000, ...o }); }

  // ───────────────────────────── backups ─────────────────────────────

  listBackups(q: { appId?: string } = {}, o?: CallOptions) { return this.items<BackupConfig>('/backups', q, o); }
  createBackup(req: CreateBackupRequest, o?: CallOptions) { return this.post<BackupConfig>('/backups', req, o); }
  updateBackup(id: string, req: UpdateBackupRequest, o?: CallOptions) { return this.patch<BackupConfig>(`/backups/${enc(id)}`, req, o); }
  deleteBackup(id: string, o?: CallOptions) { return this.del<{ ok: true }>(`/backups/${enc(id)}`, undefined, o); }
  runBackup(id: string, o?: CallOptions) { return this.post<BackupRun>(`/backups/${enc(id)}/run`, {}, { timeoutMs: 600_000, ...o }); }
  listBackupRuns(id: string, o?: CallOptions) { return this.items<BackupRun>(`/backups/${enc(id)}/runs`, undefined, o); }
  verifyBackupRun(id: string, o?: CallOptions) { return this.post<BackupRun>(`/backup-runs/${enc(id)}/verify`, {}, { timeoutMs: 600_000, ...o }); }
  /** Destructive: overwrites the database with this dump. */
  restoreBackupRun(id: string, o?: CallOptions) {
    return this.post<RestoreResponse>(`/backup-runs/${enc(id)}/restore`, { confirm: true }, { timeoutMs: 600_000, ...o });
  }

  // ───────────────────────────── agent (outside /api/v1) ─────────────────────────────

  /** Download URL for the metrics agent binary. */
  agentBinaryUrl(platform: 'linux-amd64' | 'linux-arm64'): string { return this.url(`/api/agent/v1/binary/${platform}`); }
  /** URL of the agent install script. */
  agentInstallScriptUrl(): string { return this.url('/api/agent/v1/install.sh'); }
  /** Send a metrics report with an agent token ("dsa_…"). Normally done by the Go agent. */
  reportAgent(agentToken: string, report: AgentReport, o?: CallOptions) {
    return this.request<AgentReportResponse>('POST', '/api/agent/v1/report', { ...o, body: report, bearer: agentToken });
  }
}

// ───────────────────────────── helpers ─────────────────────────────

export function isTerminal(s: DeploymentStatus): boolean {
  return s === 'succeeded' || s === 'failed' || s === 'cancelled';
}

export function normalizeBaseUrl(raw: string): string {
  let u = raw.trim();
  if (!/^https?:\/\//i.test(u)) u = `${/^(localhost|127\.|\[::1\])/.test(u) ? 'http' : 'https'}://${u}`;
  let parsed: URL;
  try { parsed = new URL(u); } catch { throw new TypeError(`DocksyClient: invalid url "${raw}"`); }
  let path = parsed.pathname.replace(/\/+$/, '');
  path = path.replace(/\/api(\/v1)?$/, '');
  return `${parsed.origin}${path}`;
}

function toQueryString(q?: Query): string {
  if (!q) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

async function toApiError(res: Response, method: string, path: string): Promise<DocksyApiError> {
  let text = '';
  try { text = await res.text(); } catch { /* body unreadable */ }
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  const err = (parsed as { error?: { code?: unknown; message?: unknown; details?: unknown } } | undefined)?.error;
  if (err && typeof err === 'object') {
    return new DocksyApiError({
      status: res.status,
      code: typeof err.code === 'string' ? err.code : `http_${res.status}`,
      message: typeof err.message === 'string' ? err.message : `${method} ${path} failed with HTTP ${res.status}`,
      details: err.details,
      method, path,
    });
  }
  const snippet = text.trim().slice(0, 200);
  return new DocksyApiError({
    status: res.status,
    code: `http_${res.status}`,
    message: `${method} ${path} failed with HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${snippet && !snippet.startsWith('<') ? `: ${snippet}` : ''}`,
    details: text ? text.slice(0, 2000) : undefined,
    method, path,
  });
}

function transportError(e: unknown, method: string, path: string, url: string, timeoutMs: number, callerSignal?: AbortSignal): DocksyApiError {
  const name = (e as { name?: string } | null)?.name;
  if (callerSignal?.aborted) {
    return new DocksyApiError({ status: 0, code: 'aborted', message: `${method} ${path} was aborted`, method, path, cause: e });
  }
  if (name === 'TimeoutError' || (name === 'AbortError' && timeoutMs > 0)) {
    return new DocksyApiError({ status: 0, code: 'timeout', message: `${method} ${path} timed out after ${timeoutMs}ms`, method, path, cause: e });
  }
  const cause = (e as { cause?: { code?: string; message?: string } } | null)?.cause;
  const why = cause?.code ?? cause?.message ?? (e as Error)?.message ?? String(e);
  return new DocksyApiError({ status: 0, code: 'network_error', message: `Could not reach Docksy at ${url} (${why})`, method, path, cause: e });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal?.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
