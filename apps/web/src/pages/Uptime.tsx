/** Uptime: HTTP checks as a formal table with a 90-day strip. Add/Edit in a plain modal form. */
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react';
import type { App, UptimeCheck, UptimeResult } from '@docksy/shared';
import { useApi, useApiMutation } from '../lib/api.ts';
import { Button, Checkbox, EmptyState, ErrorBox, Field, FieldGrid, Input, Loading, PageHeader, Select, StatusDot, Table, cx } from '../components/ui.tsx';
import { timeAgo } from '../lib/format.ts';
import { ConfirmDialog, DayStrip, Modal, RowButton, bucketDays, items } from '../features/admin/kit.tsx';

function Strip({ check }: { check: UptimeCheck }) {
  const q = useApi<{ items: UptimeResult[] }>(`/uptime-checks/${check.id}/results?range=90d`, { refetchInterval: 5 * 60_000 });
  const days = useMemo(() => bucketDays(items(q.data)), [q.data]);
  if (q.isLoading) return <div className="h-5 rounded-sm bg-surface-2" />;
  return <DayStrip days={days} height={20} />;
}

function CheckStatus({ c }: { c: UptimeCheck }) {
  if (!c.enabled) return <span className="inline-flex items-center gap-1.5 text-muted"><StatusDot />Paused</span>;
  if (c.lastStatus === 'up') return <span className="inline-flex items-center gap-1.5 text-ok"><StatusDot tone="ok" />Up</span>;
  if (c.lastStatus === 'down') return <span className="inline-flex items-center gap-1.5 text-bad"><StatusDot tone="bad" />Down</span>;
  return <span className="inline-flex items-center gap-1.5 text-muted"><StatusDot />Pending</span>;
}

const every = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`);

type CheckForm = { name: string; url: string; intervalSec: number; timeoutMs: number; expectedStatus: number; public: boolean; enabled: boolean; appId: string | null };

function CheckModal({ check, onClose }: { check: UptimeCheck | null; onClose: () => void }) {
  const apps = useApi<{ items: App[] }>('/apps');
  const [f, setF] = useState<CheckForm>(() => check
    ? { name: check.name, url: check.url, intervalSec: check.intervalSec, timeoutMs: check.timeoutMs, expectedStatus: check.expectedStatus, public: check.public, enabled: check.enabled, appId: check.appId }
    : { name: '', url: 'https://', intervalSec: 60, timeoutMs: 10000, expectedStatus: 0, public: true, enabled: true, appId: null });
  const save = useApiMutation<CheckForm, UptimeCheck>(check ? 'PATCH' : 'POST', check ? `/uptime-checks/${check.id}` : '/uptime-checks', ['/uptime-checks']);
  const [err, setErr] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    let host = '';
    try { const u = new URL(f.url); if (!/^https?:$/.test(u.protocol)) throw new Error(); host = u.host; }
    catch { return setErr('Enter a full http:// or https:// URL.'); }
    if (f.timeoutMs >= f.intervalSec * 1000) return setErr('The timeout must be shorter than the interval.');
    setErr(null);
    save.mutate({ ...f, name: f.name.trim() || host }, { onSuccess: onClose });
  };
  return (
    <Modal open onClose={onClose} wide title={check ? `Edit ${check.name}` : 'New uptime check'}
      description="Docksy requests this URL from the control plane on a schedule and records the result."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="check-form" loading={save.isPending}>{check ? 'Save' : 'Add check'}</Button></>}>
      <form id="check-form" onSubmit={submit} className="space-y-5">
        <FieldGrid>
          <Field label="URL" required>
            <Input required value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://example.com/health" className="font-mono text-xs" />
          </Field>
          <Field label="Name" help="Defaults to the host name.">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Marketing site" />
          </Field>
        </FieldGrid>
        <FieldGrid cols={3}>
          <Field label="Interval" required>
            <Select value={f.intervalSec} onChange={(e) => setF({ ...f, intervalSec: Number(e.target.value) })}>
              {[30, 60, 120, 300, 600, 1800, 3600].map((s) => <option key={s} value={s}>Every {s < 60 ? `${s} seconds` : s < 3600 ? `${s / 60} minute${s === 60 ? '' : 's'}` : 'hour'}</option>)}
            </Select>
          </Field>
          <Field label="Timeout" required>
            <Select value={f.timeoutMs} onChange={(e) => setF({ ...f, timeoutMs: Number(e.target.value) })}>
              {[2000, 5000, 10000, 20000, 30000].map((ms) => <option key={ms} value={ms}>{ms / 1000} seconds</option>)}
            </Select>
          </Field>
          <Field label="Expected status" help="0 accepts any 2xx or 3xx.">
            <Input type="number" min={0} max={599} value={f.expectedStatus} onChange={(e) => setF({ ...f, expectedStatus: Number(e.target.value) })} />
          </Field>
        </FieldGrid>
        <FieldGrid>
          <Field label="App" help="Link the check to an app so alerts point to it.">
            <Select value={f.appId ?? ''} onChange={(e) => setF({ ...f, appId: e.target.value || null })}>
              <option value="">Not linked</option>
              {(apps.data?.items ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
        </FieldGrid>
        <div className="space-y-3">
          <Checkbox checked={f.public} onChange={(v) => setF({ ...f, public: v })} label="Show on status page" help="Public checks appear on /status when the status page is enabled." />
          <Checkbox checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Enabled" help="Paused checks keep their history." />
        </div>
        <ErrorBox error={err ?? save.error} />
      </form>
    </Modal>
  );
}

export default function Uptime() {
  const q = useApi<{ items: UptimeCheck[] }>('/uptime-checks', { refetchInterval: 30_000 });
  const del = useApiMutation<string, unknown>('DELETE', (id) => `/uptime-checks/${id}`, ['/uptime-checks']);
  const [params] = useSearchParams();
  const [editing, setEditing] = useState<UptimeCheck | 'new' | null>(() => (params.get('add') ? 'new' : null));
  const [confirmDel, setConfirmDel] = useState<UptimeCheck | null>(null);
  const rows = q.data?.items ?? [];
  const down = rows.filter((c) => c.enabled && c.lastStatus === 'down').length;

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader title="Uptime"
        subtitle={rows.length ? (down ? `${down} of ${rows.length} checks down.` : `All ${rows.length} checks up.`) : 'HTTP checks run from your Docksy control plane.'}
        actions={<>
          <Link to="/status" target="_blank"><Button icon={<ExternalLink className="size-4" />}>Status page</Button></Link>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Add check</Button>
        </>} />
      <ErrorBox error={q.error} />
      {q.isLoading && <Loading />}
      {q.data && rows.length === 0 && (
        <EmptyState title="No uptime checks" action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Add check</Button>}>
          Apps with a domain get a check automatically after their first deployment. You can also watch any URL.
        </EmptyState>
      )}
      {rows.length > 0 && (
        <Table>
          <thead className="[&_th]:whitespace-nowrap">
            <tr>
              <th>Name</th><th>URL</th><th>Status</th><th className="text-right!">24h uptime</th><th className="text-right!">Avg latency</th><th>Interval</th>
              <th className="min-w-64">Last 90 days</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className={cx(!c.enabled && 'text-muted')}>
                <td className="whitespace-nowrap font-medium">
                  {c.name}
                  {c.public && <span className="ml-2 text-xs font-normal text-faint">Public</span>}
                </td>
                <td className="max-w-72 truncate">
                  <a href={c.url} target="_blank" rel="noreferrer" className="font-mono text-xs text-muted hover:text-fg hover:underline" title={c.url}>{c.url}</a>
                </td>
                <td className="whitespace-nowrap" title={`Created ${timeAgo(c.createdAt)}`}><CheckStatus c={c} /></td>
                <td className="text-right tabular-nums">{c.uptime24h == null ? <span className="text-faint">—</span> : `${c.uptime24h.toFixed(2)}%`}</td>
                <td className="text-right tabular-nums">{c.avgLatencyMs24h == null ? <span className="text-faint">—</span> : `${Math.round(c.avgLatencyMs24h)} ms`}</td>
                <td className="whitespace-nowrap text-muted">{every(c.intervalSec)}</td>
                <td className="min-w-64"><Strip check={c} /></td>
                <td>
                  <div className="flex justify-end gap-0.5">
                    <RowButton label={`Edit ${c.name}`} onClick={() => setEditing(c)}><Pencil className="size-3.5" /></RowButton>
                    <RowButton danger label={`Delete ${c.name}`} onClick={() => setConfirmDel(c)}><Trash2 className="size-3.5" /></RowButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {rows.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted">
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-1 rounded-[1px] bg-ok/45" />Up</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-1 rounded-[1px] bg-faint" />Partial</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-1 rounded-[1px] bg-bad/60" />Down</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-1 rounded-[1px] bg-surface-3" />No data</span>
        </div>
      )}
      {editing && <CheckModal check={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!confirmDel} title={`Delete “${confirmDel?.name}”?`} confirmLabel="Delete check" loading={del.isPending}
        error={<ErrorBox error={del.error} />} onClose={() => setConfirmDel(null)}
        onConfirm={() => confirmDel && del.mutate(confirmDel.id, { onSuccess: () => setConfirmDel(null) })}>
        Docksy stops checking this URL and removes its history from the status page.
      </ConfirmDialog>
    </div>
  );
}
