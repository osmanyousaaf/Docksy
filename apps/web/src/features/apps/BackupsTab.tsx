/** Backups tab (database apps): configs, run now, run history with verification, restore. */
import { Fragment, useState } from 'react';
import { ArchiveRestore, Loader2, DatabaseBackup, Play, Plus, ShieldAlert, ShieldCheck, ShieldQuestion, Trash2 } from 'lucide-react';
import type { App, BackupConfig, BackupRun } from '@docksy/shared';
import { api, useApi } from '../../lib/api.ts';
import { bytes, duration, timeAgo } from '../../lib/format.ts';
import { Badge, Button, Callout, Card, Checkbox, EmptyState, ErrorBox, Field, Input, Loading, Section, Select } from '../../components/ui.tsx';
import { Modal, StatusBadge, Switch, TypedConfirm } from './components.tsx';
import { useAction } from './hooks.ts';

const enc = encodeURIComponent;

export function VerifiedBadge({ v }: { v: BackupRun['verified'] }) {
  if (v === 'passed') return <Badge tone="ok"><ShieldCheck className="size-3" />Verified</Badge>;
  if (v === 'failed') return <Badge tone="bad"><ShieldAlert className="size-3" />Verify failed</Badge>;
  if (v === 'pending') return <Badge tone="warn"><Loader2 className="size-3 animate-spin" />Verifying</Badge>;
  return <Badge><ShieldQuestion className="size-3" />Not verified</Badge>;
}

interface NewBackupForm {
  schedule: BackupConfig['schedule'];
  retention: string;
  destination: BackupConfig['destination'];
  verify: boolean;
  endpoint: string; bucket: string; region: string; accessKey: string; secretKey: string; prefix: string;
}

function CreateBackupModal({ app, open, onClose }: { app: App; open: boolean; onClose: () => void }) {
  const [f, setF] = useState<NewBackupForm>({ schedule: 'daily', retention: '7', destination: 'local', verify: true, endpoint: '', bucket: '', region: 'us-east-1', accessKey: '', secretKey: '', prefix: `${app.name}/` });
  const set = (p: Partial<NewBackupForm>) => setF((x) => ({ ...x, ...p }));
  const create = useAction((body: unknown) => api<BackupConfig>('/backups', { method: 'POST', body }), ['/backups']);
  const retention = Number(f.retention);
  const s3ok = f.destination === 'local' || (f.endpoint && f.bucket && f.accessKey && f.secretKey);
  const ok = Number.isInteger(retention) && retention >= 1 && retention <= 365 && s3ok;
  const submit = () => create.mutate({
    appId: app.id, schedule: f.schedule, retention, destination: f.destination, verify: f.verify, enabled: true,
    s3: f.destination === 's3' ? { endpoint: f.endpoint.trim(), bucket: f.bucket.trim(), region: f.region.trim(), accessKey: f.accessKey.trim(), secretKey: f.secretKey, prefix: f.prefix.trim() } : null,
  }, { onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} title="New backup schedule" wide
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!ok} loading={create.isPending} onClick={submit}>Create schedule</Button>
      </>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="How often">
            <Select value={f.schedule} onChange={(e) => set({ schedule: e.target.value as BackupConfig['schedule'] })}>
              <option value="hourly">Every hour</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
            </Select>
          </Field>
          <Field label="Keep the last" hint="backups">
            <Input value={f.retention} onChange={(e) => set({ retention: e.target.value.replace(/\D/g, '') })} inputMode="numeric" />
          </Field>
        </div>
        <Field label="Store on">
          <Select value={f.destination} onChange={(e) => set({ destination: e.target.value as BackupConfig['destination'] })}>
            <option value="local">This server (/var/lib/docksy/backups)</option>
            <option value="s3">S3-compatible storage (AWS, R2, B2, MinIO…)</option>
          </Select>
        </Field>
        {f.destination === 's3' && (
          <div className="grid gap-4 rounded-md border border-border p-4 sm:grid-cols-2">
            <Field label="Endpoint"><Input value={f.endpoint} onChange={(e) => set({ endpoint: e.target.value })} placeholder="https://s3.us-east-1.amazonaws.com" /></Field>
            <Field label="Bucket"><Input value={f.bucket} onChange={(e) => set({ bucket: e.target.value })} placeholder="my-backups" /></Field>
            <Field label="Region"><Input value={f.region} onChange={(e) => set({ region: e.target.value })} /></Field>
            <Field label="Prefix" hint="optional"><Input value={f.prefix} onChange={(e) => set({ prefix: e.target.value })} /></Field>
            <Field label="Access key"><Input value={f.accessKey} onChange={(e) => set({ accessKey: e.target.value })} autoComplete="off" /></Field>
            <Field label="Secret key" hint="stored encrypted, never shown again"><Input type="password" value={f.secretKey} onChange={(e) => set({ secretKey: e.target.value })} autoComplete="off" /></Field>
          </div>
        )}
        <Checkbox checked={f.verify} onChange={(v) => set({ verify: v })} label="Verify every backup"
          help="Restore it into a throwaway container and run a sanity check after each run." />
        <ErrorBox error={create.error} />
      </div>
    </Modal>
  );
}

function RunsTable({ app, config }: { app: App; config: BackupConfig }) {
  const { data, isLoading, error } = useApi<{ items: BackupRun[] }>(`/backups/${enc(config.id)}/runs`, {
    refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === 'running' || r.verified === 'pending') ? 2500 : 30_000),
  });
  const [open, setOpen] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<BackupRun | null>(null);
  const verify = useAction((id: string) => api(`/backup-runs/${enc(id)}/verify`, { method: 'POST', body: {} }), ['/backups']);
  const restore = useAction((id: string) => api(`/backup-runs/${enc(id)}/restore`, { method: 'POST', body: { confirm: true } }), ['/backups', '/apps']);
  const [restored, setRestored] = useState<string | null>(null);

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const runs = data?.items ?? [];
  if (!runs.length) return <p className="px-4 py-6 text-center text-sm text-muted">No runs yet. Use “Run now” to take the first backup.</p>;
  return (
    <>
      {restored && <div className="mx-4 mt-3"><Callout>Restore started from the backup taken {restored}. Watch the app’s logs for progress.</Callout></div>}
      {!!verify.error && <div className="mx-4 mt-3"><ErrorBox error={verify.error} /></div>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-surface text-left text-xs text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Started</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Verification</th>
              <th className="hidden px-4 py-2 font-medium sm:table-cell">Size</th>
              <th className="hidden px-4 py-2 font-medium md:table-cell">Took</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <Fragment key={r.id}>
                <tr className="border-b border-border last:border-0 hover:bg-surface-2/40">
                  <td className="px-4 py-2.5" title={new Date(r.startedAt).toLocaleString()}>
                    <button className="text-left hover:underline cursor-pointer" onClick={() => setOpen(open === r.id ? null : r.id)}>{timeAgo(r.startedAt)}</button>
                  </td>
                  <td className="px-4 py-2.5"><StatusBadge status={r.status} /></td>
                  <td className="px-4 py-2.5"><VerifiedBadge v={r.verified} /></td>
                  <td className="hidden px-4 py-2.5 font-mono text-xs text-muted sm:table-cell">{bytes(r.sizeBytes)}</td>
                  <td className="hidden px-4 py-2.5 font-mono text-xs text-muted md:table-cell">{duration(r.startedAt, r.finishedAt)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-1">
                      {r.status === 'succeeded' && r.verified !== 'pending' && (
                        <Button size="sm" variant="ghost" icon={<ShieldCheck className="size-3.5" />} loading={verify.isPending && verify.variables === r.id} onClick={() => verify.mutate(r.id)}>Verify</Button>
                      )}
                      {r.status === 'succeeded' && (
                        <Button size="sm" variant="ghost" icon={<ArchiveRestore className="size-3.5" />} onClick={() => setRestoring(r)}>Restore</Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Hide' : 'Log'}</Button>
                    </div>
                  </td>
                </tr>
                {open === r.id && (
                  <tr className="border-b border-border">
                    <td colSpan={6} className="bg-bg px-4 py-3">
                      {r.path && <div className="mb-2 font-mono text-xs text-muted">{r.path}</div>}
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-fg/80">{r.log || 'No output.'}</pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <TypedConfirm open={!!restoring} onClose={() => { setRestoring(null); restore.reset(); }} title={`Restore ${app.name}?`} word={app.name} action="Restore backup"
        loading={restore.isPending} error={<ErrorBox error={restore.error} />}
        onConfirm={() => restoring && restore.mutate(restoring.id, { onSuccess: () => { setRestored(timeAgo(restoring.startedAt)); setRestoring(null); } })}>
        <p>
          This replaces the current data in <b>{app.name}</b> with the backup from{' '}
          <b>{restoring && new Date(restoring.startedAt).toLocaleString()}</b>. Anything written since then is lost.
        </p>
        {restoring && restoring.verified !== 'passed' && (
          <Callout tone="warn">This backup hasn’t passed verification. Consider verifying it first.</Callout>
        )}
      </TypedConfirm>
    </>
  );
}

function BackupCard({ app, config }: { app: App; config: BackupConfig }) {
  const patch = useAction((body: Partial<BackupConfig>) => api(`/backups/${enc(config.id)}`, { method: 'PATCH', body }), ['/backups']);
  const del = useAction(() => api(`/backups/${enc(config.id)}`, { method: 'DELETE' }), ['/backups']);
  const run = useAction(() => api<BackupRun>(`/backups/${enc(config.id)}/run`, { method: 'POST', body: {} }), ['/backups']);
  const [confirmDel, setConfirmDel] = useState(false);
  const where = config.destination === 's3' && config.s3 ? `s3://${config.s3.bucket}/${config.s3.prefix}` : 'on the server';
  return (
    <Card padded={false}
      title={<span className="flex items-center gap-2"><span className="capitalize">{config.schedule}</span>
        <span className="font-normal text-muted">· keep {config.retention} · {where}</span></span>}
      actions={<>
        <Switch checked={config.enabled} disabled={patch.isPending} onChange={(v) => patch.mutate({ enabled: v })} label={<span className="text-xs text-muted">{config.enabled ? 'On' : 'Paused'}</span>} />
        <Button size="sm" icon={<Play className="size-3.5" />} loading={run.isPending} onClick={() => run.mutate()}>Run now</Button>
        <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmDel(true)} aria-label="Delete schedule" />
      </>}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border px-4 py-2.5 text-xs text-muted">
        <span>Last run {timeAgo(config.lastRunAt)}</span>
        <Checkbox checked={config.verify} disabled={patch.isPending} onChange={(v) => patch.mutate({ verify: v })} label={<span className="text-xs">Verify after each run</span>} />
      </div>
      {!!(patch.error ?? run.error) && <div className="mx-4 mt-3"><ErrorBox error={patch.error ?? run.error} /></div>}
      <RunsTable app={app} config={config} />
      <Modal open={confirmDel} onClose={() => setConfirmDel(false)} title="Delete this backup schedule?"
        footer={<>
          <Button variant="ghost" onClick={() => setConfirmDel(false)}>Cancel</Button>
          <Button variant="danger" loading={del.isPending} onClick={() => del.mutate(undefined, { onSuccess: () => setConfirmDel(false) })}>Delete schedule</Button>
        </>}>
        <p className="text-sm text-muted">Docksy stops taking new backups on this schedule. Existing backup files are left where they are.</p>
        <ErrorBox error={del.error} />
      </Modal>
    </Card>
  );
}

export function BackupsTab({ app }: { app: App }) {
  const { data, isLoading, error } = useApi<{ items: BackupConfig[] }>(`/backups?appId=${enc(app.id)}`);
  const [creating, setCreating] = useState(false);
  const configs = data?.items ?? [];
  return (
    <Section title="Backups" description="Scheduled database dumps, with optional restore verification."
      actions={configs.length > 0 ? <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>Add schedule</Button> : undefined}>
      {isLoading ? <Loading /> : error ? <ErrorBox error={error} /> : configs.length === 0 ? (
        <EmptyState icon={<DatabaseBackup className="size-8" />} title="No backups yet"
          action={<Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Set up backups</Button>}>
          Schedule automatic dumps of {app.name}, keep the last N, and let Docksy prove each one restores cleanly.
        </EmptyState>
      ) : (
        <div className="space-y-4">{configs.map((c) => <BackupCard key={c.id} app={app} config={c} />)}</div>
      )}
      <CreateBackupModal app={app} open={creating} onClose={() => setCreating(false)} />
    </Section>
  );
}
