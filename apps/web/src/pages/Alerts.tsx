/** Alerts: firing, history, rules and notification channels. Formal tables, no tinted panels. */
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Pencil, Plus, Send, Trash2 } from 'lucide-react';
import type { Alert, AlertRule, ChannelType, CreateAlertRuleRequest, NotificationChannel, Server } from '@docksy/shared';
import { api, useApi, useApiMutation } from '../lib/api.ts';
import { Button, Checkbox, EmptyState, ErrorBox, Loading, PageHeader, PageTabs, Section, Table, cx } from '../components/ui.tsx';
import { duration, timeAgo } from '../lib/format.ts';
import { ConfirmDialog, RowButton, SeverityLabel, useParamState } from '../features/admin/kit.tsx';
import { ChannelForm, RuleForm, TYPE_LABEL, channelSummary, emptyRule, ruleCondition, ruleToRequest } from '../features/admin/alerts.tsx';

const TABS = ['firing', 'history', 'rules', 'notifications'] as const;
type Tab = (typeof TABS)[number];

function useServerNames() {
  const servers = useApi<{ items: Server[] }>('/servers');
  return useMemo(() => Object.fromEntries((servers.data?.items ?? []).map((s) => [s.id, s.name])) as Record<string, string>, [servers.data]);
}

function Target({ a, names }: { a: Alert; names: Record<string, string> }) {
  if (!a.serverId && !a.appId) return <span className="text-faint">—</span>;
  return (
    <span className="whitespace-nowrap">
      {a.serverId && <Link to={`/servers/${a.serverId}`} className="text-fg hover:underline">{names[a.serverId] ?? 'Server'}</Link>}
      {a.serverId && a.appId && <span className="text-faint"> / </span>}
      {a.appId && <Link to={`/apps/${a.appId}`} className="text-fg hover:underline">App</Link>}
    </span>
  );
}

const formatValue = (v: number | null) => (v == null ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(1));

// ───────────── firing ─────────────

function Firing({ names }: { names: Record<string, string> }) {
  const q = useApi<{ items: Alert[] }>('/alerts?state=firing', { refetchInterval: 15_000 });
  const ack = useApiMutation<string, unknown>('POST', (id) => `/alerts/${id}/ack`, ['/alerts']);
  const rows = (q.data?.items ?? []).filter((a) => a.state === 'firing');
  return (
    <Section title="Firing" description="Alerts whose condition is true right now. They resolve on their own when it clears.">
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : rows.length === 0 ? (
        <EmptyState title="Nothing is firing">Docksy is watching CPU, memory, disk, containers, deployments, uptime and backups.</EmptyState>
      ) : (
        <Table>
          <thead className="[&_th]:whitespace-nowrap"><tr><th>Severity</th><th>Alert</th><th>Target</th><th>Value</th><th>Firing for</th><th>State</th><th /></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td className="w-28"><SeverityLabel severity={a.severity} /></td>
                <td className="min-w-72">
                  <div className="font-medium">{a.title}</div>
                  <div className="mt-0.5 text-xs text-muted">{a.message}</div>
                </td>
                <td><Target a={a} names={names} /></td>
                <td className="tabular-nums text-muted">{formatValue(a.value)}</td>
                <td className="whitespace-nowrap tabular-nums text-muted" title={new Date(a.startedAt).toLocaleString()}>{duration(a.startedAt)}</td>
                <td className="whitespace-nowrap text-muted">{a.ackedAt ? `Acknowledged ${timeAgo(a.ackedAt)}` : 'Open'}</td>
                <td className="text-right">
                  {!a.ackedAt && <Button size="sm" loading={ack.isPending && ack.variables === a.id} onClick={() => ack.mutate(a.id)}>Acknowledge</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <div className="mt-3"><ErrorBox error={ack.error} /></div>
    </Section>
  );
}

// ───────────── history ─────────────

function History({ names }: { names: Record<string, string> }) {
  const q = useApi<{ items: Alert[] }>('/alerts?state=resolved&limit=100');
  const rows = q.data?.items ?? [];
  return (
    <Section title="History" description="The last 100 resolved alerts.">
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : rows.length === 0 ? (
        <EmptyState title="No alert history yet">Resolved alerts appear here.</EmptyState>
      ) : (
        <Table>
          <thead><tr><th>Severity</th><th>Alert</th><th>Target</th><th>Started</th><th>Duration</th><th>Resolved</th></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td className="w-28"><SeverityLabel severity={a.severity} /></td>
                <td className="min-w-72 max-w-xl">
                  <div className="font-medium">{a.title}</div>
                  <div className="mt-0.5 truncate text-xs text-muted" title={a.message}>{a.message}</div>
                </td>
                <td><Target a={a} names={names} /></td>
                <td className="whitespace-nowrap text-muted" title={new Date(a.startedAt).toLocaleString()}>{new Date(a.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</td>
                <td className="whitespace-nowrap tabular-nums text-muted">{duration(a.startedAt, a.resolvedAt)}</td>
                <td className="whitespace-nowrap text-muted">{timeAgo(a.resolvedAt)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Section>
  );
}

// ───────────── rules ─────────────

function Rules({ names }: { names: Record<string, string> }) {
  const rules = useApi<{ items: AlertRule[] }>('/alert-rules');
  const servers = useApi<{ items: Server[] }>('/servers');
  const channels = useApi<{ items: NotificationChannel[] }>('/notification-channels');
  const patch = useApiMutation<{ id: string; enabled: boolean }, AlertRule>('PATCH', (b) => `/alert-rules/${b.id}`, ['/alert-rules']);
  const del = useApiMutation<string, unknown>('DELETE', (id) => `/alert-rules/${id}`, ['/alert-rules']);
  const [params] = useSearchParams();
  const [editing, setEditing] = useState<{ id: string | null; data: CreateAlertRuleRequest } | null>(() => (params.get('add') ? { id: null, data: emptyRule() } : null));
  const [confirmDel, setConfirmDel] = useState<AlertRule | null>(null);
  const chName = Object.fromEntries((channels.data?.items ?? []).map((c) => [c.id, c.name]));
  const rows = [...(rules.data?.items ?? [])].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));

  return (
    <Section title="Rules" description="Conditions Docksy evaluates against every server and app. Defaults cover the common failures."
      actions={<Button icon={<Plus className="size-4" />} onClick={() => setEditing({ id: null, data: emptyRule() })}>Add</Button>}>
      {rules.isLoading ? <Loading /> : rules.error ? <ErrorBox error={rules.error} /> : (
        <Table>
          <thead><tr><th className="w-12">On</th><th>Name</th><th>Condition</th><th>Severity</th><th>Scope</th><th>Notify</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={cx(!r.enabled && 'text-muted')}>
                <td>
                  <Checkbox checked={r.enabled} onChange={(v) => patch.mutate({ id: r.id, enabled: v })} label={<span className="sr-only">Enable {r.name}</span>} />
                </td>
                <td className="min-w-56">
                  <span className="font-medium">{r.name}</span>
                  {r.isDefault && <span className="ml-2 text-xs text-faint">Default</span>}
                </td>
                <td className="whitespace-nowrap font-mono text-xs text-muted">{ruleCondition(r)}</td>
                <td><SeverityLabel severity={r.severity} /></td>
                <td className="whitespace-nowrap text-muted">{r.serverId ? names[r.serverId] ?? 'One server' : 'All servers'}</td>
                <td className="max-w-48 truncate text-muted">{r.channelIds.length ? r.channelIds.map((id) => chName[id] ?? 'Channel').join(', ') : 'All channels'}</td>
                <td>
                  <div className="flex justify-end gap-0.5">
                    <RowButton label={`Edit ${r.name}`} onClick={() => setEditing({ id: r.id, data: ruleToRequest(r) })}><Pencil className="size-3.5" /></RowButton>
                    {!r.isDefault && <RowButton danger label={`Delete ${r.name}`} onClick={() => setConfirmDel(r)}><Trash2 className="size-3.5" /></RowButton>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <div className="mt-3"><ErrorBox error={patch.error} /></div>
      {editing && <RuleForm initial={editing.data} editingId={editing.id} onClose={() => setEditing(null)} servers={servers.data?.items ?? []} channels={channels.data?.items ?? []} />}
      <ConfirmDialog open={!!confirmDel} title={`Delete “${confirmDel?.name}”?`} confirmLabel="Delete rule" loading={del.isPending}
        error={<ErrorBox error={del.error} />} onClose={() => setConfirmDel(null)}
        onConfirm={() => confirmDel && del.mutate(confirmDel.id, { onSuccess: () => setConfirmDel(null) })}>
        Docksy stops evaluating this rule. Alerts it already fired stay in history.
      </ConfirmDialog>
    </Section>
  );
}

// ───────────── notifications ─────────────

function TestCell({ id }: { id: string }) {
  const [state, setState] = useState<{ s: 'idle' | 'busy' | 'ok' | 'err'; msg?: string }>({ s: 'idle' });
  const run = async () => {
    setState({ s: 'busy' });
    try { await api(`/notification-channels/${id}/test`, { method: 'POST' }); setState({ s: 'ok' }); }
    catch (e) { setState({ s: 'err', msg: e instanceof Error ? e.message : String(e) }); }
  };
  return (
    <span className="inline-flex items-center gap-2">
      {state.s === 'ok' && <span className="text-xs text-ok">Sent</span>}
      {state.s === 'err' && <span className="max-w-48 truncate text-xs text-bad" title={state.msg}>{state.msg}</span>}
      <Button size="sm" loading={state.s === 'busy'} icon={<Send className="size-3.5" />} onClick={run}>Test</Button>
    </span>
  );
}

function Notifications() {
  const q = useApi<{ items: NotificationChannel[] }>('/notification-channels');
  const patch = useApiMutation<{ id: string; enabled: boolean }, NotificationChannel>('PATCH', (b) => `/notification-channels/${b.id}`, ['/notification-channels']);
  const del = useApiMutation<string, unknown>('DELETE', (id) => `/notification-channels/${id}`, ['/notification-channels']);
  const [params] = useSearchParams();
  const addType = params.get('add');
  const [editing, setEditing] = useState<NotificationChannel | 'new' | null>(() => (addType ? 'new' : null));
  const [confirmDel, setConfirmDel] = useState<NotificationChannel | null>(null);
  const rows = q.data?.items ?? [];

  return (
    <Section title="Notifications" description="Channels that receive alerts: Discord, Slack, Telegram, a webhook or email."
      actions={<Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Add</Button>}>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : rows.length === 0 ? (
        <EmptyState title="No notification channels" action={<Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Add channel</Button>}>
          Alerts are listed here either way. Add a channel to be told when one fires.
        </EmptyState>
      ) : (
        <Table>
          <thead><tr><th className="w-12">On</th><th>Name</th><th>Type</th><th>Destination</th><th>Added</th><th /></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className={cx(!c.enabled && 'text-muted')}>
                <td><Checkbox checked={c.enabled} onChange={(v) => patch.mutate({ id: c.id, enabled: v })} label={<span className="sr-only">Enable {c.name}</span>} /></td>
                <td className="font-medium">{c.name}</td>
                <td className="text-muted">{TYPE_LABEL[c.type]}</td>
                <td className="max-w-64 truncate font-mono text-xs text-muted">{channelSummary(c)}</td>
                <td className="whitespace-nowrap text-muted">{timeAgo(c.createdAt)}</td>
                <td>
                  <div className="flex items-center justify-end gap-1">
                    <TestCell id={c.id} />
                    <RowButton label={`Edit ${c.name}`} onClick={() => setEditing(c)}><Pencil className="size-3.5" /></RowButton>
                    <RowButton danger label={`Delete ${c.name}`} onClick={() => setConfirmDel(c)}><Trash2 className="size-3.5" /></RowButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <div className="mt-3"><ErrorBox error={patch.error} /></div>
      {editing && <ChannelForm channel={editing === 'new' ? null : editing} initialType={addType && addType in TYPE_LABEL ? addType as ChannelType : undefined} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!confirmDel} title={`Delete “${confirmDel?.name}”?`} confirmLabel="Delete channel" loading={del.isPending}
        error={<ErrorBox error={del.error} />} onClose={() => setConfirmDel(null)}
        onConfirm={() => confirmDel && del.mutate(confirmDel.id, { onSuccess: () => setConfirmDel(null) })}>
        Rules that only notify this channel fall back to every enabled channel.
      </ConfirmDialog>
    </Section>
  );
}

// ───────────── page ─────────────

export default function Alerts() {
  const [tab, setTab] = useParamState<Tab>('tab', TABS, 'firing');
  const firing = useApi<{ items: Alert[] }>('/alerts?state=firing', { refetchInterval: 15_000 });
  const names = useServerNames();
  const n = firing.data?.items.filter((a) => a.state === 'firing').length ?? 0;

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader title="Alerts" subtitle={n ? `${n} alert${n === 1 ? '' : 's'} firing.` : 'No alerts firing. Rules are watching your servers and apps.'} />
      <PageTabs value={tab} onChange={(t) => setTab(t as Tab)} tabs={[
        { id: 'firing', label: <span className="inline-flex items-center gap-1.5">Firing{n > 0 && <span className="tabular-nums text-bad">{n}</span>}</span> },
        { id: 'history', label: 'History' },
        { id: 'rules', label: 'Rules' },
        { id: 'notifications', label: 'Notifications' },
      ]} />
      {tab === 'firing' && <Firing names={names} />}
      {tab === 'history' && <History names={names} />}
      {tab === 'rules' && <Rules names={names} />}
      {tab === 'notifications' && <Notifications />}
    </div>
  );
}
