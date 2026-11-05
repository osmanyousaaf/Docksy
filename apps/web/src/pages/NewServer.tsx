import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowRight, Check, Loader2, Play, RefreshCw } from 'lucide-react';
import type { CreateServerRequest, ProvisionJob, Server, SshKeyInfo, ValidateServerResponse } from '@docksy/shared';
import { api, ApiError, useApi, useSSE } from '../lib/api.ts';
import { Breadcrumbs, Button, Callout, Card, ErrorBox, Field, Input, Loading, Section, StatusDot } from '../components/ui.tsx';
import { CopyButton, CopyField, Skeleton } from '../features/monitoring/components.tsx';

type Step = 1 | 2 | 3;
const STEPS: { n: Step; label: string; desc: string }[] = [
  { n: 1, label: 'Connect', desc: 'Host and SSH access' },
  { n: 2, label: 'Validate', desc: 'Check the server' },
  { n: 3, label: 'Provision', desc: 'Install Docker and the agent' },
];

function Stepper({ step }: { step: Step }) {
  return (
    <ol className="mb-10 flex items-center gap-3 border-b border-border pb-5">
      {STEPS.map(({ n, label, desc }, i) => (
        <li key={n} className="flex min-w-0 flex-1 items-center gap-3 last:flex-none">
          <span className={clsx('grid size-6 shrink-0 place-items-center rounded-full border text-xs tabular-nums',
            step === n ? 'border-fg bg-fg text-bg' : step > n ? 'border-border-strong bg-surface-2 text-fg' : 'border-border-strong text-muted')}>
            {step > n ? <Check className="size-3.5" /> : n}
          </span>
          <span className="min-w-0">
            <span className={clsx('block text-sm', step >= n ? 'text-fg' : 'text-muted')}>{label}</span>
            <span className="hidden truncate text-xs text-muted sm:block">{desc}</span>
          </span>
          {i < STEPS.length - 1 && <span className="h-px min-w-4 flex-1 bg-border" />}
        </li>
      ))}
    </ol>
  );
}

// ───────────── step 1 ─────────────

function ConnectStep({ existing, onDone }: { existing: Server | null; onDone: (s: Server) => void }) {
  const key = useApi<SshKeyInfo>('/ssh-key', { staleTime: Infinity });
  const [form, setForm] = useState({ name: existing?.name ?? '', host: existing?.host ?? '', port: String(existing?.port ?? 22), sshUser: existing?.sshUser ?? 'root' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const port = Number(form.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return setError('Port must be a number between 1 and 65535.');
    setBusy(true);
    setError(null);
    const body: CreateServerRequest = { name: form.name.trim(), host: form.host.trim(), port, sshUser: form.sshUser.trim() || 'root' };
    try {
      const s = existing
        ? await api<Server>(`/servers/${existing.id}`, { method: 'PATCH', body })
        : await api<Server>('/servers', { body });
      qc.invalidateQueries({ predicate: (q) => /^\/(servers|overview)/.test(String(q.queryKey[0] ?? '')) });
      onDone(s);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-x-12 lg:grid-cols-2">
      <Section title="Server details" description="How Docksy reaches your VPS over SSH.">
        <form onSubmit={submit} className="space-y-5">
          <Field label="Name" required help="Shown in the dashboard, e.g. prod-eu-1.">
            <Input required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="prod-eu-1" />
          </Field>
          <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-4">
            <Field label="Host" required help="IP address or hostname.">
              <Input required value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="203.0.113.10" className="font-mono" />
            </Field>
            <Field label="SSH port" required>
              <Input required inputMode="numeric" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} className="font-mono" />
            </Field>
          </div>
          <Field label="SSH user" required help="root, or a user with passwordless sudo.">
            <Input required value={form.sshUser} onChange={(e) => setForm({ ...form, sshUser: e.target.value })} className="font-mono" />
          </Field>
          <ErrorBox error={error} />
          <Button type="submit" variant="primary" loading={busy} icon={<ArrowRight className="size-4" />}>{existing ? 'Save and validate' : 'Add and validate'}</Button>
        </form>
      </Section>
      <Section title="Authorize Docksy’s SSH key" description="Run this once on the server, as the SSH user. It adds Docksy’s public key to ~/.ssh/authorized_keys.">
        {key.isLoading && <Skeleton className="h-20" />}
        <ErrorBox error={key.error} />
        {key.data && (
          <div className="space-y-5">
            <Field label="Command">
              <CopyField value={key.data.instructions} wrap />
            </Field>
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-sm text-fg">Public key</span>
                <CopyButton text={key.data.publicKey} label="Copy key" />
              </div>
              <code className="block break-all rounded-md border border-border bg-surface px-3 py-2 font-mono text-[11px] text-muted">{key.data.publicKey}</code>
              <p className="mt-1.5 font-mono text-xs text-muted">{key.data.fingerprint}</p>
            </div>
            <p className="text-xs text-muted">Works with any fresh Ubuntu or Debian VPS. Docksy installs Docker and everything else in the next steps.</p>
          </div>
        )}
      </Section>
    </div>
  );
}

// ───────────── step 2 ─────────────

function ValidateStep({ server, onBack, onProvisioned }: { server: Server; onBack: () => void; onProvisioned: () => void }) {
  const [res, setRes] = useState<ValidateServerResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const started = useRef(false);

  const run = async () => {
    setRunning(true);
    setError(null);
    try { setRes(await api<ValidateServerResponse>(`/servers/${server.id}/validate`, { method: 'POST' })); }
    catch (e) { setError(e); setRes(null); }
    finally { setRunning(false); }
  };
  useEffect(() => { if (!started.current) { started.current = true; run(); } }, []);

  const ssh = res?.checks.find((c) => /ssh/i.test(c.name));
  const canProvision = !!res && (ssh ? ssh.ok : res.ok);
  const provision = async () => {
    setStarting(true);
    setError(null);
    try { await api<ProvisionJob>(`/servers/${server.id}/provision`, { method: 'POST' }); onProvisioned(); }
    catch (e) { setError(e); setStarting(false); }
  };

  const placeholder = ['SSH connection', 'Root or sudo', 'Operating system', 'Docker', 'Free disk'];
  const checks = res?.checks ?? placeholder.map((name) => ({ name, ok: false, detail: '' }));
  return (
    <Section title="Validation" description={`Checking ${server.sshUser}@${server.host}:${server.port} before provisioning.`}
      actions={<Button size="sm" variant="secondary" onClick={run} loading={running} icon={<RefreshCw className="size-3.5" />}>Re-run</Button>}>
      <Card padded={false}>
        <ul>
          {checks.map((c) => {
            const pending = running || !res;
            const tone = pending ? 'neutral' : c.ok ? 'ok' : /docker/i.test(c.name) ? 'warn' : 'bad';
            return (
              <li key={c.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 border-t border-border px-4 py-3 first:border-t-0 sm:grid-cols-[200px_minmax(0,1fr)_auto]">
                <span className="text-sm text-fg">{c.name}</span>
                <span className="col-span-2 row-start-2 text-sm text-muted sm:col-span-1 sm:row-start-auto">{pending ? 'Checking…' : c.detail}</span>
                <span className="col-start-2 row-start-1 flex items-center gap-1.5 text-xs sm:col-start-auto">
                  {pending ? <Loader2 className="size-3.5 animate-spin text-muted" /> : <StatusDot tone={tone} />}
                  <span className={clsx(tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : 'text-muted')}>
                    {pending ? 'Pending' : c.ok ? 'Passed' : tone === 'warn' ? 'Will install' : 'Failed'}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </Card>
      <div className="mt-4 space-y-3">
        <ErrorBox error={error} />
        {res && !canProvision && (
          <Callout tone="bad">Docksy can’t connect yet. Check the host, port and user, and make sure you ran the key command from step 1.</Callout>
        )}
        {res && canProvision && !res.ok && (
          <p className="text-sm text-muted">Some checks need attention, but provisioning installs missing pieces such as Docker.</p>
        )}
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button variant="primary" disabled={!canProvision || running} loading={starting} onClick={provision}>Provision server</Button>
        <Button variant="secondary" onClick={onBack}>Edit details</Button>
      </div>
    </Section>
  );
}

// ───────────── step 3 ─────────────

const STEP_RE = /^::step::\s*(.*)$/;

function ProvisionStep({ server }: { server: Server }) {
  const job = useApi<ProvisionJob>(`/servers/${server.id}/provision`, { key: ['provision', server.id], staleTime: 0, gcTime: 0, retry: false });
  const [lines, setLines] = useState<string[] | null>(null);
  const [status, setStatus] = useState<ProvisionJob['status'] | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [follow, setFollow] = useState(true);
  const cursor = useRef(0);
  const initial = useRef<string[]>([]);
  const term = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  useEffect(() => {
    if (!job.data || lines !== null) return;
    const ls = job.data.log ? job.data.log.split('\n').filter((l) => l.length > 0) : [];
    initial.current = ls;
    cursor.current = 0;
    setLines(ls);
    setStatus(job.data.status);
  }, [job.data, lines]);
  const notStarted = job.error instanceof ApiError && job.error.status === 404;

  useSSE(status === 'running' ? `/servers/${server.id}/provision/stream` : null, (ev, data) => {
    if (ev === 'log') {
      const line = typeof data === 'string' ? data : String(data?.line ?? '');
      // Skip lines the stream replays that we already loaded from GET /provision.
      if (cursor.current < initial.current.length && initial.current[cursor.current] === line) { cursor.current++; return; }
      cursor.current = initial.current.length;
      setLines((prev) => [...(prev ?? []), ...line.split('\n')]);
    } else if (ev === 'status') {
      const st = (typeof data === 'string' ? data : data?.status) as ProvisionJob['status'];
      if (st === 'succeeded' || st === 'failed' || st === 'running') setStatus(st);
      if (st !== 'running') qc.invalidateQueries({ predicate: (q) => /^\/(servers|overview)/.test(String(q.queryKey[0] ?? '')) });
    }
  }, ['log', 'status']);

  useLayoutEffect(() => {
    if (follow && term.current) term.current.scrollTop = term.current.scrollHeight;
  }, [lines, follow]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const j = await api<ProvisionJob>(`/servers/${server.id}/provision`, { method: 'POST' });
      initial.current = [];
      cursor.current = 0;
      setLines([]);
      setStatus(j.status);
    } catch (e) { setError(e); }
    finally { setStarting(false); }
  };

  const steps = useMemo(() => (lines ?? []).map((l) => STEP_RE.exec(l)?.[1]).filter((s): s is string => !!s), [lines]);
  if (job.isLoading) return <Loading label="Loading provisioning job…" />;
  const done = status === 'succeeded';
  const failed = status === 'failed';
  const idle = notStarted || (status === null && !job.isLoading);

  return (
    <div className="space-y-6">
      {done && (
        <div className="flex flex-wrap items-center gap-4 rounded-md border border-border bg-surface px-4 py-3">
          <StatusDot tone="ok" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{server.name} is ready</div>
            <div className="text-sm text-muted">Docker, the proxy and the metrics agent are running. Live metrics start in a few seconds.</div>
          </div>
          <div className="flex gap-2">
            <Link to={`/apps/new?serverId=${server.id}`}><Button variant="secondary">Deploy an app</Button></Link>
            <Link to={`/servers/${server.id}`}><Button variant="primary">Open server</Button></Link>
          </div>
        </div>
      )}
      {failed && (
        <div className="flex flex-wrap items-center gap-4 rounded-md border border-border bg-surface px-4 py-3">
          <StatusDot tone="bad" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-bad">Provisioning failed</div>
            <div className="text-sm text-muted">The log below shows where it stopped. Provisioning is safe to re-run.</div>
          </div>
          <Button variant="primary" loading={starting} onClick={start} icon={<RefreshCw className="size-4" />}>Try again</Button>
        </div>
      )}
      {idle && !done && !failed && (
        <Section title="Provision" description={`Install Docker, the Caddy proxy and the Docksy agent on ${server.host}. It takes about two minutes and is safe to re-run.`}>
          <Button variant="primary" loading={starting} onClick={start} icon={<Play className="size-4" />}>Start provisioning</Button>
        </Section>
      )}
      <ErrorBox error={error ?? (job.error && !notStarted ? job.error : null)} />

      {(lines?.length || status === 'running') ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
          <div>
            <h2 className="mb-3 text-lg font-semibold">Progress</h2>
            <ol className="space-y-2">
              {steps.map((s, i) => {
                const current = i === steps.length - 1 && status === 'running';
                const bad = i === steps.length - 1 && failed;
                return (
                  <li key={i} className="flex items-start gap-2.5 text-sm">
                    {current ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted" />
                      : <StatusDot tone={bad ? 'bad' : 'ok'} className="mx-1 mt-1.5" />}
                    <span className={clsx(current ? 'text-fg' : bad ? 'text-bad' : 'text-muted')}>{s}</span>
                  </li>
                );
              })}
              {steps.length === 0 && <li className="flex items-center gap-2 text-sm text-muted"><Loader2 className="size-4 animate-spin" />Starting…</li>}
            </ol>
          </div>
          <section className="overflow-hidden rounded-md border border-border bg-bg">
            <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2">
              <span className="font-mono text-xs text-muted">{server.sshUser}@{server.host}</span>
              <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted">
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-[#ededed]" />Follow output
              </label>
            </header>
            <div ref={term} onWheel={(e) => { if (e.deltaY < 0) setFollow(false); }}
              className="dx-scroll h-[420px] overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed text-muted">
              {(lines ?? []).map((l, i) => {
                const st = STEP_RE.exec(l);
                return st
                  ? <div key={i} className="mt-2 font-medium text-fg">› {st[1]}</div>
                  : <div key={i} className={clsx('whitespace-pre-wrap break-words', /error|fail|fatal/i.test(l) && 'text-bad')}>{l}</div>;
              })}
              {status === 'running' && <span className="dx-caret inline-block h-3.5 w-2 translate-y-0.5 bg-muted" />}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

// ───────────── page ─────────────

export default function NewServer() {
  const [params, setParams] = useSearchParams();
  const serverId = params.get('server');
  const rawStep = Number(params.get('step') ?? 1);
  const step: Step = serverId && (rawStep === 2 || rawStep === 3) ? rawStep : 1;
  const server = useApi<Server>(serverId ? `/servers/${serverId}` : null);

  const go = (s: Step, id = serverId) => setParams(id ? { server: id, step: String(s) } : {}, { replace: false });

  const title = server.data && step > 1 ? `Set up ${server.data.name}` : 'Add a server';
  return (
    <div className="max-w-5xl">
      <Breadcrumbs items={serverId && server.data
        ? [{ label: 'Servers', to: '/servers' }, { label: server.data.name, to: `/servers/${serverId}` }, { label: 'Setup' }]
        : [{ label: 'Servers', to: '/servers' }, { label: 'New' }]} />
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mb-6 mt-1 text-sm text-muted">Connect a VPS, check it, and provision it with Docker, a proxy and monitoring.</p>
      <Stepper step={step} />
      {serverId && server.isLoading && <Loading />}
      <ErrorBox error={server.error} />
      {step === 1 && (!serverId || server.data) && (
        <ConnectStep key={serverId ?? 'new'} existing={server.data ?? null} onDone={(s) => go(2, s.id)} />
      )}
      {step === 2 && server.data && <ValidateStep key={server.data.id} server={server.data} onBack={() => go(1)} onProvisioned={() => go(3)} />}
      {step === 3 && server.data && <ProvisionStep key={server.data.id} server={server.data} />}
    </div>
  );
}
