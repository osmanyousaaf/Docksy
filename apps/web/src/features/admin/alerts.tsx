/** Alert rule + notification channel forms and metadata (used by pages/Alerts.tsx). */
import { useState, type FormEvent } from 'react';
import type { AlertMetric, AlertRule, ChannelType, CreateAlertRuleRequest, NotificationChannel, Server, Severity } from '@docksy/shared';
import { useApiMutation } from '../../lib/api.ts';
import { Button, Checkbox, ErrorBox, Field, FieldGrid, Input, Select } from '../../components/ui.tsx';
import { Modal } from './kit.tsx';

// ───────────── metric metadata ─────────────

type MetricKind = 'percent' | 'absolute' | 'count' | 'offline' | 'event';
export const METRICS: { id: AlertMetric; label: string; kind: MetricKind; help: string }[] = [
  { id: 'cpu', label: 'CPU usage', kind: 'percent', help: 'Average CPU across all cores.' },
  { id: 'mem', label: 'Memory usage', kind: 'percent', help: 'Used memory (total minus available).' },
  { id: 'disk', label: 'Disk usage', kind: 'percent', help: 'Root filesystem, or the largest disk.' },
  { id: 'swap', label: 'Swap usage', kind: 'percent', help: 'Swap in use, as a percentage of swap size.' },
  { id: 'load', label: 'Load average (1m)', kind: 'absolute', help: 'Absolute load. Compare it with the number of cores.' },
  { id: 'server_offline', label: 'Server offline', kind: 'offline', help: 'The agent has not reported for the given time.' },
  { id: 'container_down', label: 'Container down', kind: 'event', help: 'A managed container is not running.' },
  { id: 'container_restarts', label: 'Container restarts', kind: 'count', help: 'Restarts within the time window.' },
  { id: 'deploy_failed', label: 'Deployment failed', kind: 'event', help: 'A deployment ended in failure.' },
  { id: 'uptime_down', label: 'Uptime check down', kind: 'event', help: 'An HTTP uptime check started failing.' },
  { id: 'backup_failed', label: 'Backup failed', kind: 'event', help: 'A scheduled backup run failed.' },
];
export const metricMeta = (m: AlertMetric) => METRICS.find((x) => x.id === m) ?? METRICS[0];

export function dur(sec: number): string {
  if (sec <= 0) return '';
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

export function ruleCondition(r: Pick<AlertRule, 'metric' | 'op' | 'threshold' | 'durationSec'>): string {
  const m = metricMeta(r.metric);
  const d = dur(r.durationSec);
  switch (m.kind) {
    case 'percent': return `${m.label.replace(' usage', '')} ${r.op} ${r.threshold}%${d ? ` for ${d}` : ''}`;
    case 'absolute': return `Load ${r.op} ${r.threshold}${d ? ` for ${d}` : ''}`;
    case 'count': return `More than ${r.threshold} restarts${d ? ` in ${d}` : ''}`;
    case 'offline': return `No report for ${d || '2m'}`;
    default: return 'On event';
  }
}

const DURATIONS = [0, 60, 120, 300, 600, 900, 1800, 3600];

export function emptyRule(): CreateAlertRuleRequest {
  return { name: '', metric: 'cpu', op: '>', threshold: 80, durationSec: 300, severity: 'warning', serverId: null, appId: null, channelIds: [], enabled: true };
}

export function ruleToRequest(r: AlertRule): CreateAlertRuleRequest {
  return { name: r.name, metric: r.metric, op: r.op, threshold: r.threshold, durationSec: r.durationSec, severity: r.severity, serverId: r.serverId, appId: r.appId, channelIds: r.channelIds, enabled: r.enabled };
}

// ───────────── rule form ─────────────

export function RuleForm({ initial, editingId, onClose, servers, channels }: {
  initial: CreateAlertRuleRequest; editingId: string | null; onClose: () => void; servers: Server[]; channels: NotificationChannel[];
}) {
  const [r, setR] = useState<CreateAlertRuleRequest>(initial);
  const save = useApiMutation<CreateAlertRuleRequest, AlertRule>(editingId ? 'PATCH' : 'POST', editingId ? `/alert-rules/${editingId}` : '/alert-rules', ['/alert-rules']);
  const meta = metricMeta(r.metric);
  const hasThreshold = meta.kind === 'percent' || meta.kind === 'absolute' || meta.kind === 'count';
  const hasDuration = meta.kind !== 'event';
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate({ ...r, name: r.name.trim() || ruleCondition(r) }, { onSuccess: onClose }); };
  const toggleChannel = (id: string, on: boolean) => setR({ ...r, channelIds: on ? [...r.channelIds, id] : r.channelIds.filter((x) => x !== id) });
  const durations = DURATIONS.includes(r.durationSec) ? DURATIONS : [...DURATIONS, r.durationSec].sort((a, b) => a - b);

  return (
    <Modal open onClose={onClose} wide title={editingId ? 'Edit rule' : 'New rule'} description="A condition Docksy evaluates against your servers and apps."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="rule-form" loading={save.isPending}>{editingId ? 'Save' : 'Create rule'}</Button></>}>
      <form id="rule-form" onSubmit={submit} className="space-y-5">
        <FieldGrid>
          <Field label="Name" help="Leave blank to use the condition as the name.">
            <Input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder={ruleCondition(r)} />
          </Field>
          <Field label="Metric" required help={meta.help}>
            <Select value={r.metric} onChange={(e) => {
              const m = e.target.value as AlertMetric;
              const k = metricMeta(m).kind;
              setR({ ...r, metric: m, threshold: k === 'percent' ? 90 : k === 'count' ? 3 : k === 'absolute' ? 4 : 0, durationSec: k === 'offline' ? 120 : k === 'event' ? 0 : k === 'count' ? 600 : 300 });
            }}>
              {METRICS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </Select>
          </Field>
        </FieldGrid>
        {(hasThreshold || hasDuration) && (
          <FieldGrid cols={3}>
            {hasThreshold && meta.kind !== 'count' && (
              <Field label="Operator" required>
                <Select value={r.op} onChange={(e) => setR({ ...r, op: e.target.value as '>' | '<' })}>
                  <option value=">">Above</option><option value="<">Below</option>
                </Select>
              </Field>
            )}
            {hasThreshold && (
              <Field label={meta.kind === 'percent' ? 'Threshold (%)' : meta.kind === 'count' ? 'Restarts' : 'Load'} required>
                <Input type="number" step="any" min={0} max={meta.kind === 'percent' ? 100 : undefined} required value={r.threshold}
                  onChange={(e) => setR({ ...r, threshold: Number(e.target.value) })} />
              </Field>
            )}
            {hasDuration && (
              <Field label={meta.kind === 'count' ? 'Within' : meta.kind === 'offline' ? 'Silent for' : 'For at least'} required>
                <Select value={r.durationSec} onChange={(e) => setR({ ...r, durationSec: Number(e.target.value) })}>
                  {durations.map((d) => <option key={d} value={d}>{d === 0 ? 'Immediately' : dur(d)}</option>)}
                </Select>
              </Field>
            )}
          </FieldGrid>
        )}
        <FieldGrid>
          <Field label="Severity" required>
            <Select value={r.severity} onChange={(e) => setR({ ...r, severity: e.target.value as Severity })}>
              <option value="info">Info</option><option value="warning">Warning</option><option value="critical">Critical</option>
            </Select>
          </Field>
          <Field label="Scope">
            <Select value={r.serverId ?? ''} onChange={(e) => setR({ ...r, serverId: e.target.value || null })}>
              <option value="">All servers</option>
              {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        </FieldGrid>
        <Field label="Notify" help="If none are selected, every enabled channel is notified.">
          {channels.length === 0 ? <p className="text-sm text-muted">No notification channels yet.</p> : (
            <div className="space-y-2.5 pt-1">
              {channels.map((c) => (
                <Checkbox key={c.id} checked={r.channelIds.includes(c.id)} onChange={(v) => toggleChannel(c.id, v)}
                  label={<>{c.name} <span className="text-muted">· {TYPE_LABEL[c.type]}</span></>} />
              ))}
            </div>
          )}
        </Field>
        <Checkbox checked={r.enabled} onChange={(v) => setR({ ...r, enabled: v })} label="Enabled" help="Disabled rules are not evaluated." />
        <ErrorBox error={save.error} />
      </form>
    </Modal>
  );
}

// ───────────── channels ─────────────

interface FieldSpec { key: string; label: string; placeholder?: string; secret?: boolean; type?: 'text' | 'number' | 'bool'; optional?: boolean; help?: string }
export const CHANNEL_FIELDS: Record<ChannelType, FieldSpec[]> = {
  discord: [{ key: 'url', label: 'Webhook URL', placeholder: 'https://discord.com/api/webhooks/…', secret: true, help: 'Channel settings → Integrations → Webhooks.' }],
  slack: [{ key: 'url', label: 'Incoming webhook URL', placeholder: 'https://hooks.slack.com/services/…', secret: true, help: 'Create one under Slack apps → Incoming Webhooks.' }],
  telegram: [
    { key: 'botToken', label: 'Bot token', placeholder: '123456:ABC-DEF…', secret: true, help: 'From @BotFather.' },
    { key: 'chatId', label: 'Chat ID', placeholder: '-1001234567890' },
  ],
  webhook: [
    { key: 'url', label: 'URL', placeholder: 'https://example.com/hooks/docksy', help: 'Docksy sends a JSON POST on fire and resolve.' },
    { key: 'secret', label: 'Signing secret', secret: true, optional: true },
  ],
  email: [
    { key: 'host', label: 'SMTP host', placeholder: 'smtp.example.com' },
    { key: 'port', label: 'Port', type: 'number', placeholder: '587' },
    { key: 'user', label: 'Username', optional: true },
    { key: 'pass', label: 'Password', secret: true, optional: true },
    { key: 'from', label: 'From', placeholder: 'docksy@example.com' },
    { key: 'to', label: 'To', placeholder: 'you@example.com' },
    { key: 'secure', label: 'Use TLS (port 465)', type: 'bool' },
  ],
};
export const TYPE_LABEL: Record<ChannelType, string> = { discord: 'Discord', slack: 'Slack', telegram: 'Telegram', webhook: 'Webhook', email: 'Email' };

export function channelSummary(c: NotificationChannel): string {
  const cfg = c.config as Record<string, unknown>;
  if (c.type === 'email') return `${cfg.to ?? ''} via ${cfg.host ?? 'SMTP'}`;
  if (c.type === 'telegram') return `Chat ${cfg.chatId ?? ''}`;
  try { return new URL(String(cfg.url)).host; } catch { return String(cfg.url ?? ''); }
}

export function ChannelForm({ channel, initialType = 'discord', onClose }: { channel: NotificationChannel | null; initialType?: ChannelType; onClose: () => void }) {
  const [type, setType] = useState<ChannelType>(channel?.type ?? initialType);
  const [name, setName] = useState(channel?.name ?? '');
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);
  const [cfg, setCfg] = useState<Record<string, unknown>>(() => {
    if (!channel) return initialType === 'email' ? { port: 587, secure: false } : {};
    // Secrets come back masked: leave them blank so they're only sent when changed.
    const out: Record<string, unknown> = {};
    for (const f of CHANNEL_FIELDS[channel.type]) if (!f.secret) out[f.key] = channel.config[f.key];
    return out;
  });
  const save = useApiMutation<Partial<NotificationChannel>, NotificationChannel>(channel ? 'PATCH' : 'POST', channel ? `/notification-channels/${channel.id}` : '/notification-channels', ['/notification-channels']);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const config: Record<string, unknown> = {};
    for (const f of CHANNEL_FIELDS[type]) {
      const v = cfg[f.key];
      if (f.type === 'bool') config[f.key] = !!v;
      else if (f.type === 'number') { if (v !== '' && v != null) config[f.key] = Number(v); }
      else if (typeof v === 'string' && v.trim() !== '') config[f.key] = v.trim();
    }
    save.mutate({ name: name.trim() || TYPE_LABEL[type], type, config, enabled }, { onSuccess: onClose });
  };

  const fields = CHANNEL_FIELDS[type];
  return (
    <Modal open onClose={onClose} wide={type === 'email'} title={channel ? `Edit ${channel.name}` : 'New notification channel'}
      description="Where Docksy sends alerts when they fire and resolve."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="channel-form" loading={save.isPending}>{channel ? 'Save' : 'Add channel'}</Button></>}>
      <form id="channel-form" onSubmit={submit} className="space-y-5">
        <FieldGrid>
          <Field label="Type" required>
            <Select value={type} disabled={!!channel} onChange={(e) => { const t = e.target.value as ChannelType; setType(t); setCfg(t === 'email' ? { port: 587, secure: false } : {}); }}>
              {(Object.keys(TYPE_LABEL) as ChannelType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </Select>
          </Field>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${TYPE_LABEL[type]} alerts`} />
          </Field>
        </FieldGrid>
        <div className="border-t border-border pt-5">
          <FieldGrid cols={type === 'email' ? 2 : 1}>
            {fields.filter((f) => f.type !== 'bool').map((f) => (
              <Field key={f.key} label={f.label} required={!f.optional && !(channel && f.secret)}
                hint={f.optional ? 'optional' : undefined}
                help={channel && f.secret ? 'Leave blank to keep the current value.' : f.help}>
                <Input type={f.secret ? 'password' : f.type === 'number' ? 'number' : 'text'} autoComplete="off"
                  required={!f.optional && !(channel && f.secret)} value={String(cfg[f.key] ?? '')}
                  placeholder={channel && f.secret ? 'Unchanged' : f.placeholder}
                  className={f.key === 'url' || f.key === 'botToken' ? 'font-mono text-xs' : undefined}
                  onChange={(e) => setCfg({ ...cfg, [f.key]: e.target.value })} />
              </Field>
            ))}
          </FieldGrid>
          {fields.filter((f) => f.type === 'bool').map((f) => (
            <div key={f.key} className="mt-5"><Checkbox checked={!!cfg[f.key]} onChange={(v) => setCfg({ ...cfg, [f.key]: v })} label={f.label} /></div>
          ))}
        </div>
        <Checkbox checked={enabled} onChange={setEnabled} label="Enabled" help="Disabled channels receive nothing." />
        <ErrorBox error={save.error} />
      </form>
    </Modal>
  );
}
