/** Configuration → Persistent Storage, Health Check, Resource Limits, Webhooks, Danger Zone. */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Plus, X } from 'lucide-react';
import type { App, Server, Volume } from '@docksy/shared';
import { api, useApi } from '../../../lib/api.ts';
import { bytes } from '../../../lib/format.ts';
import { Button, Callout, Checkbox, ErrorBox, Field, FieldGrid, Input, Loading, Section, cx } from '../../../components/ui.tsx';
import { CopyButton, TypedConfirm } from '../components.tsx';
import { useAction } from '../hooks.ts';
import { FieldError, SaveActions, SectionError, useSectionForm, type UpdateAppRequest } from './form.tsx';

const enc = encodeURIComponent;

/* ───────────────────────── Persistent Storage ───────────────────────── */

const VOL_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const MOUNT_RE = /^\/[A-Za-z0-9._/-]*$/;

interface StorageForm { vols: Volume[] }
const toStorage = (a: App): StorageForm => ({ vols: a.volumes.map((v) => ({ ...v })) });
const cleanVols = (vols: Volume[]) => vols.map((v) => ({ name: v.name.trim(), mountPath: v.mountPath.trim() })).filter((v) => v.name || v.mountPath);
function diffStorage(a: App, f: StorageForm): UpdateAppRequest {
  const next = cleanVols(f.vols);
  return JSON.stringify(next) === JSON.stringify(a.volumes) ? {} : { volumes: next };
}
function volErrors(vols: Volume[]): Record<number, string> {
  const out: Record<number, string> = {};
  const names = new Set<string>();
  const mounts = new Set<string>();
  vols.forEach((v, i) => {
    const n = v.name.trim();
    const m = v.mountPath.trim();
    if (!n && !m) return;
    if (!VOL_NAME_RE.test(n)) out[i] = 'Name: lowercase letters, digits, . _ - (starting with a letter or digit)';
    else if (!MOUNT_RE.test(m) || m === '/') out[i] = 'Mount path must be absolute, e.g. /data (not /)';
    else if (names.has(n)) out[i] = 'Volume names must be unique';
    else if (mounts.has(m)) out[i] = 'Mount paths must be unique';
    names.add(n);
    mounts.add(m);
  });
  return out;
}

export function StorageSection({ app }: { app: App }) {
  const form = useSectionForm(app, toStorage, diffStorage, (f) => ({ vols: Object.values(volErrors(f.vols))[0] }));
  const { f, set } = form;
  const errs = volErrors(f.vols);
  const update = (i: number, p: Partial<Volume>) => set({ vols: f.vols.map((v, j) => (j === i ? { ...v, ...p } : v)) });
  const removed = app.volumes.filter((v) => !cleanVols(f.vols).some((x) => x.name === v.name));

  return (
    <Section title="Persistent Storage" description="Docker volumes that keep data across deploys and restarts."
      actions={<SaveActions form={form} savedText="Saved. Changes apply on the next deploy." />}>
      <SectionError error={form.error} />
      <div className="overflow-hidden rounded-md border border-border">
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_40px] bg-surface text-xs font-medium text-muted">
          <div className="px-3 py-2">Volume name</div>
          <div className="px-3 py-2">Mount path in container</div>
          <div />
        </div>
        {f.vols.length === 0 && <div className="border-t border-border px-3 py-6 text-center text-sm text-muted">No volumes. Data written inside the container is lost on redeploy.</div>}
        {f.vols.map((v, i) => (
          <div key={i} className="border-t border-border">
            <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_40px] items-center gap-2 px-3 py-2">
              <Input value={v.name} onChange={(e) => update(i, { name: e.target.value.toLowerCase() })} placeholder="data" spellCheck={false}
                aria-label="Volume name" className={cx('font-mono text-[13px]', errs[i]?.startsWith('Name') && 'border-bad/60')} />
              <Input value={v.mountPath} onChange={(e) => update(i, { mountPath: e.target.value })} placeholder="/data" spellCheck={false}
                aria-label="Mount path" className="font-mono text-[13px]" />
              <button type="button" onClick={() => set({ vols: f.vols.filter((_, j) => j !== i) })} aria-label="Remove volume"
                className="grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg cursor-pointer"><X className="size-4" /></button>
            </div>
            {errs[i] && <p className="px-3 pb-2 text-xs text-bad">{errs[i]}</p>}
          </div>
        ))}
      </div>
      <div className="mt-3">
        <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => set({ vols: [...f.vols, { name: '', mountPath: '' }] })}>Add volume</Button>
      </div>
      <div className="mt-5 space-y-3">
        <Callout>Changes apply on the next deploy. Volumes live on the server as <code className="font-mono text-fg">docksy-{app.name}-&lt;name&gt;</code> and survive redeploys.</Callout>
        {removed.length > 0 && (
          <Callout tone="warn">Removing {removed.map((v) => v.name).join(', ')} detaches it from the app. The data stays on the server until you delete the app with its volumes.</Callout>
        )}
      </div>
    </Section>
  );
}

/* ───────────────────────── Health Check ───────────────────────── */

interface HealthForm { path: string }
const toHealth = (a: App): HealthForm => ({ path: a.healthcheckPath ?? '' });
const diffHealth = (a: App, f: HealthForm): UpdateAppRequest => ((f.path.trim() || null) !== a.healthcheckPath ? { healthcheckPath: f.path.trim() || null } : {});
const validateHealth = (f: HealthForm) => ({ path: f.path.trim() && !/^\/[^\s'"`$\\]*$/.test(f.path.trim()) ? 'The path must start with / and contain no spaces or quotes' : undefined });

export function HealthSection({ app }: { app: App }) {
  const form = useSectionForm(app, toHealth, diffHealth, validateHealth);
  const { f, set, errors } = form;
  return (
    <Section title="Health Check" description="How Docksy decides a new deployment is ready to receive traffic."
      actions={<SaveActions form={form} savedText="Saved. Used from the next deploy." />}>
      <SectionError error={form.error} />
      <FieldGrid>
        <Field label="Health Check Path" help={`Requested inside the container on port ${app.port ?? '(not set)'}. Any 2xx response counts as healthy. Leave empty to only wait for the container to stay running.`}>
          <Input value={f.path} onChange={(e) => set({ path: e.target.value })} placeholder="/health" spellCheck={false} className={cx('font-mono text-[13px]', errors.path && 'border-bad/60')} />
          <FieldError>{errors.path}</FieldError>
        </Field>
      </FieldGrid>
      <div className="mt-8">
        <h3 className="mb-3 text-base font-semibold">Zero-downtime deploys</h3>
        <ol className="space-y-2.5 text-sm text-muted">
          {[
            'Docksy starts the new container next to the one that is serving traffic.',
            f.path.trim()
              ? <>It requests <code className="font-mono text-fg">{f.path.trim()}</code> until it answers with 2xx, for up to 120 seconds.</>
              : 'Without a path, it waits until the new container has been running for 5 seconds.',
            'Once healthy, traffic switches to the new container and the old one is removed.',
            'If it never becomes healthy, the new container is removed, the old one keeps serving, and the deployment is marked failed.',
          ].map((s, i) => (
            <li key={i} className="flex gap-3"><span className="w-4 shrink-0 text-right tabular-nums text-faint">{i + 1}.</span><span>{s}</span></li>
          ))}
        </ol>
      </div>
    </Section>
  );
}

/* ───────────────────────── Resource Limits ───────────────────────── */

interface LimitsForm { cpu: string; mem: string }
const toLimits = (a: App): LimitsForm => ({ cpu: a.cpuLimit != null ? String(a.cpuLimit) : '', mem: a.memLimitMb != null ? String(a.memLimitMb) : '' });
function diffLimits(a: App, f: LimitsForm): UpdateAppRequest {
  const out: UpdateAppRequest = {};
  const cpu = f.cpu.trim() ? Number(f.cpu) : null;
  const mem = f.mem.trim() ? Number(f.mem) : null;
  if (cpu !== a.cpuLimit) out.cpuLimit = cpu;
  if (mem !== a.memLimitMb) out.memLimitMb = mem;
  return out;
}
function validateLimits(f: LimitsForm) {
  const cpu = Number(f.cpu);
  const mem = Number(f.mem);
  return {
    cpu: f.cpu.trim() && (!isFinite(cpu) || cpu < 0.05 || cpu > 256) ? 'Enter a number of cores between 0.05 and 256' : undefined,
    mem: f.mem.trim() && (!Number.isInteger(mem) || mem < 16 || mem > 1_048_576) ? 'Enter whole megabytes, at least 16' : undefined,
  };
}

export function LimitsSection({ app, server }: { app: App; server?: Server }) {
  const form = useSectionForm(app, toLimits, diffLimits, validateLimits);
  const { f, set, errors } = form;
  return (
    <Section title="Resource Limits" description="Cap how much CPU and memory this app can use on its server."
      actions={<SaveActions form={form} savedText="Saved. Applies on the next deploy." />}>
      <SectionError error={form.error} />
      <FieldGrid>
        <Field label="CPU Limit" hint="cores" help={`For example 0.5 for half a core. Leave empty for no limit.${server?.cpuCores ? ` ${server.name} has ${server.cpuCores} cores.` : ''}`}>
          <Input value={f.cpu} onChange={(e) => set({ cpu: e.target.value.replace(/[^\d.]/g, '') })} inputMode="decimal" placeholder="Unlimited"
            className={cx(errors.cpu && 'border-bad/60')} />
          <FieldError>{errors.cpu}</FieldError>
        </Field>
        <Field label="Memory Limit" hint="MB" help={`The container is restarted if it goes over. Leave empty for no limit.${server?.memTotal ? ` ${server.name} has ${bytes(server.memTotal)}.` : ''}`}>
          <Input value={f.mem} onChange={(e) => set({ mem: e.target.value.replace(/\D/g, '') })} inputMode="numeric" placeholder="Unlimited"
            className={cx(errors.mem && 'border-bad/60')} />
          <FieldError>{errors.mem}</FieldError>
        </Field>
      </FieldGrid>
      <div className="mt-5"><Callout>Limits apply on the next deploy. Redeploy to apply them to the running container.</Callout></div>
    </Section>
  );
}

/* ───────────────────────── Webhooks ───────────────────────── */

function CopyField({ label, value, secret, help }: { label: string; value: string; secret?: boolean; help?: string }) {
  const [show, setShow] = useState(!secret);
  return (
    <Field label={label} help={help}>
      <div className="flex items-center gap-2">
        <Input readOnly value={show ? value : '•'.repeat(32)} onFocus={(e) => show && e.target.select()} className="min-w-0 flex-1 font-mono text-[13px]" />
        {secret && <Button className="h-9" variant="ghost" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</Button>}
        <CopyButton text={value} label="Copy" size="md" className="h-9 border-border-strong bg-surface-2 text-fg hover:bg-surface-3" />
      </div>
    </Field>
  );
}

export function WebhooksSection({ app, onSection }: { app: App; onSection: (id: string) => void }) {
  const { data, isLoading, error } = useApi<{ url: string; secret: string }>(`/apps/${enc(app.id)}/webhook`);
  const repoPath = app.repoUrl?.match(/github\.com[/:]([^/]+\/[^/.]+)/)?.[1];
  const local = data ? /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)[:/]/.test(data.url) : false;
  const git = app.sourceType === 'git';
  return (
    <Section title="Webhooks" description="Deploy automatically when you push to GitHub.">
      {isLoading ? <Loading /> : error ? <ErrorBox error={error} /> : data && (
        <>
          <div className="mb-5 space-y-3">
            {!git && <Callout>This app runs a prebuilt image, so push webhooks are ignored. They apply to apps built from a git repository.</Callout>}
            {git && (
              <p className="text-sm text-muted">
                Auto-deploy is <span className="text-fg">{app.autoDeploy ? 'on' : 'off'}</span> for <code className="font-mono text-fg">{app.branch ?? 'main'}</code>
                {app.watchPaths.length > 0 && <> and limited to {app.watchPaths.length} watch path{app.watchPaths.length === 1 ? '' : 's'}</>}.{' '}
                <button type="button" className="text-fg underline underline-offset-2 hover:text-white cursor-pointer" onClick={() => onSection('general')}>Change in General</button>
              </p>
            )}
            {local && <Callout tone="warn">GitHub can’t reach this address. Set a public URL under Settings so GitHub can deliver webhooks to Docksy.</Callout>}
          </div>
          <FieldGrid cols={1}>
            <CopyField label="Payload URL" value={data.url} />
            <CopyField label="Secret" value={data.secret} secret help="GitHub signs every delivery with this secret; Docksy rejects unsigned requests." />
          </FieldGrid>
          <div className="mt-8">
            <h3 className="mb-3 text-base font-semibold">Set up on GitHub</h3>
            <ol className="space-y-2.5 text-sm text-muted [&_b]:font-medium [&_b]:text-fg">
              {[
                <>Open {repoPath
                  ? <a className="text-fg underline underline-offset-2" target="_blank" rel="noreferrer" href={`https://github.com/${repoPath}/settings/hooks/new`}>{repoPath} → Settings → Webhooks</a>
                  : <>your repository → <b>Settings → Webhooks</b></>} and choose <b>Add webhook</b>.</>,
                <>Paste the <b>Payload URL</b> above.</>,
                <>Set <b>Content type</b> to <code className="font-mono text-fg">application/json</code>.</>,
                <>Paste the <b>Secret</b> above.</>,
                <>Select <b>Just the push event</b>, keep <b>Active</b> checked, and save.</>,
              ].map((s, i) => (
                <li key={i} className="flex gap-3"><span className="w-4 shrink-0 text-right tabular-nums text-faint">{i + 1}.</span><span>{s}</span></li>
              ))}
            </ol>
            <p className="mt-4 text-xs text-muted">GitHub sends a ping when the webhook is created; Docksy answers it without deploying.</p>
          </div>
        </>
      )}
    </Section>
  );
}

/* ───────────────────────── Danger Zone ───────────────────────── */

export function DangerSection({ app }: { app: App }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [withVolumes, setWithVolumes] = useState(false);
  const del = useAction(() => api(`/apps/${enc(app.id)}${withVolumes ? '?volumes=1' : ''}`, { method: 'DELETE' }), ['/apps', '/deployments']);
  return (
    <Section title="Danger Zone" description="Irreversible actions. Please be careful.">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-border px-4 py-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">Delete application</div>
          <p className="mt-0.5 text-sm text-muted">Stops and removes its containers, deployment history and settings. Volumes are kept unless you choose otherwise.</p>
        </div>
        <Button variant="danger" onClick={() => { setWithVolumes(false); del.reset(); setOpen(true); }}>Delete</Button>
      </div>
      <TypedConfirm open={open} onClose={() => setOpen(false)} title={`Delete ${app.name}`} word={app.name} action="Delete application"
        loading={del.isPending} error={<ErrorBox error={del.error} />}
        onConfirm={() => del.mutate(undefined, { onSuccess: () => navigate('/apps', { replace: true }) })}>
        <p className="text-muted">This permanently deletes <span className="text-fg">{app.name}</span>. It can’t be undone.</p>
        {app.volumes.length > 0 && (
          <Checkbox checked={withVolumes} onChange={setWithVolumes} label="Also delete its volumes"
            help={`Removes ${app.volumes.map((v) => v.name).join(', ')} and all data in them.`} />
        )}
      </TypedConfirm>
    </Section>
  );
}
