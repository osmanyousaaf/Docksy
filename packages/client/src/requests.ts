/** Request/query shapes for routes whose bodies are not spelled out in the shared types. */
import type {
  ChannelType, CreateAlertRuleRequest, MetricsRange, NotificationChannel, Settings,
} from './types.ts';

export type UpdateSettingsRequest = Partial<Settings>;

export type UpdateAlertRuleRequest = Partial<CreateAlertRuleRequest>;

export interface ListAlertsQuery { state?: 'firing' | 'resolved'; limit?: number }

export interface CreateChannelRequest {
  name: string;
  type: ChannelType;
  config: NotificationChannel['config'];
  enabled?: boolean;
}
export type UpdateChannelRequest = Partial<CreateChannelRequest>;

export interface CreateUptimeCheckRequest {
  name: string;
  url: string;
  appId?: string | null;
  intervalSec?: number;
  timeoutMs?: number;
  expectedStatus?: number;
  public?: boolean;
  enabled?: boolean;
}
export type UpdateUptimeCheckRequest = Partial<CreateUptimeCheckRequest>;

// CreateBackupRequest / UpdateBackupRequest live in the shared types.

export interface ListDeploymentsQuery { appId?: string; limit?: number }

export interface DiagnoseQuery { serverId?: string; appId?: string }

export interface MetricsQuery { range?: MetricsRange }

export interface UptimeResultsQuery { range?: '1h' | '24h' | '7d' | '30d' | '90d' | (string & {}) }

/** Options accepted by every client call. */
export interface CallOptions {
  /** Abort the request. */
  signal?: AbortSignal;
  /** Per-call timeout in ms (overrides the client default; ignored for streams). */
  timeoutMs?: number;
}
