import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, RefreshCw, Trash2 } from 'lucide-react';
import type { MetricsRange, ProvisionJob, Server, UpdateServerRequest, ValidateServerResponse } from '@docksy/shared';
import { api, ApiError, useApi } from '../lib/api.ts';
import {
  Breadcrumbs, Button, Callout, Card, EmptyState, ErrorBox, Field, FieldGrid, Input, Loading, Meter, PageTabs, Section, Status, StatusDot, SubNavLayout,
} from '../components/ui.tsx';
import { bytes, rate, ratio, timeAgo } from '../lib/format.ts';
import { AreaMetric } from '../components/charts/AreaMetric.tsx';
import { RadialGauge } from '../components/charts/RadialGauge.tsx';
import { CoreHeatmap } from '../components/charts/CoreHeatmap.tsx';
import { CopyField, Modal, RangePicker, Skeleton } from '../features/monitoring/components.tsx';
import { ContainersTable } from '../features/monitoring/ContainersTable.tsx';
import { DiagnoseButton, DiagnosePanel, useDiagnose } from '../features/monitoring/DiagnosePanel.tsx';
import { loadAverages, RANGE_MS, RANGES, useLiveServerMetrics, useNow } from '../features/monitoring/hooks.ts';

type Tab = 'overview' | 'containers' | 'configuration' | 'danger';
const TABS: Tab[] = ['overview', 'containers', 'configuration', 'danger'];
const invalidateServers = (qc: ReturnType<typeof useQueryClient>) =>
  qc.invalidateQueries({ predicate: (q) => /^\/(servers|overview)/.test(String(q.queryKey[0] ?? '')) });

function LiveText({ sse, lastEventAt, offline }: { sse: 'connecting' | 'open' | 'closed'; lastEventAt: number | null; offline: boolean }) {
  const now = useNow(1000);
  const ago = lastEventAt ? Math.max(0, Math.round((now - lastEventAt) / 1000)) : null;
  const live = sse === 'open' && !offline && ago !== null && ago < 60;
  if (live) return <span className="inline-flex items-center gap-1.5"><StatusDot tone="ok" className="size-1.5" />Live · updated {ago}s ago</span>;
  return <span>{offline ? 'Agent offline' : sse === 'open' ? 'Waiting for data' : 'Connecting…'}</span>;
}

function serverStatus(s: Server): { status: string; label: string } {
  if (s.status === 'new') return { status: 'idle', label: 'Not provisioned' };
  if (s.status !== 'ready') return { status: s.status, label: s.status.charAt(0).toUpperCase() + s.status.slice(1) };
  return { status: s.liveness, label: s.liveness === 'online' ? 'Online' : s.liveness === 'offline' ? 'Offline' : 'Unknown' };
}

// ───────────── overview tab ─────────────

function Tile({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-border bg-surface px-4 py-4">{children}</div>;
}

function LoadRow({ label, value, cores }: { label: string; value: number | null; cores: number }) {
  const p = value == null ? 0 : (value / Math.max(1, cores)) * 100;
  return (
    <div className="grid grid-cols-[48px_minmax(0,1fr)_56px] items-center gap-3">
      <span className="text-xs text-muted">{label}</span>
      <Meter value={p} tone={p >= 100 ? 'bad' : p >= 75 ? 'warn' : 'brand'} />
      <span className="text-right text-sm tabular-nums">{value == null ? '—' : value.toFixed(2)}</span>
    </div>
  );
}

function ChartCard({ title, value, children }: { title: string; value?: ReactNode; children: ReactNode }) {
  return <Card title={title} actions={value != null ? <span className="text-xs tabular-nums text-muted">{value}</span> : undefined}>{children}</Card>;
}

function Legend({ items }: { items: [string, string][] }) {
  return (
    <span className="flex gap-3 text-xs text-muted">
      {items.map(([label, color]) => <span key={label} className="flex items-center gap-1.5"><span className="h-0.5 w-3 rounded-full" style={{ background: color }} />{label}</span>)}
    </span>
  );
}

function AgentNotReporting({ server }: { server: Server }) {
  const lead = {
    new: ['This server isn’t provisioned yet', 'Provisioning installs Docker, the Caddy proxy and the Docksy agent. It takes about two minutes.'],
    provisioning: ['Provisioning is in progress', 'The agent starts reporting as soon as provisioning finishes.'],
    error: ['Provisioning failed', 'Check the log, fix the problem and run it again.'],
    ready: ['The agent isn’t reporting', 'The server is provisioned, but Docksy hasn’t heard from its agent yet.'],
  }[server.status];
  return (
    <>
      <Section title={lead[0]} description={lead[1]}
        actions={server.status === 'provisioning'
          ? <Link to={`/servers/new?server=${server.id}&step=3`}><Button size="sm" variant="primary">Watch provisioning</Button></Link>
          : <Link to={`/servers/new?server=${server.id}&step=2`}><Button size="sm" variant="primary">{server.status === 'ready' ? 'Re-run provisioning' : 'Provision now'}</Button></Link>}>
        <p className="text-sm text-muted">Make sure <Link to="/settings" className="text-fg underline underline-offset-2">Settings → Public URL</Link> is an address this server can reach.</p>
      </Section>
      <Troubleshooting server={server} />
    </>
  );
}

function Troubleshooting({ server }: { server: Server }) {
  const steps = [
    ['Is the agent running?', 'systemctl status docksy-agent --no-pager'],
    ['What does its log say?', 'journalctl -u docksy-agent -n 50 --no-pager'],
    ['Can the server reach Docksy?', `. /etc/docksy/agent.env && curl -sS -o /dev/null -w '%{http_code}\\n' "$DOCKSY_URL/api/agent/v1/install.sh"`],
    ['Restart it', 'sudo systemctl restart docksy-agent'],
  ];
  return (
    <Section title="Troubleshooting" description="Run these on the server if the agent stops reporting.">
      <div className="space-y-4">
        {steps.map(([t, cmd]) => <Field key={t} label={t}><CopyField value={cmd} /></Field>)}
        <Field label="Or ask Claude Code" help="Claude can diagnose it through Docksy, no SSH needed.">
          <CopyField value={`Use /docksy:diagnose ${server.name}`} prompt="›" />
        </Field>
      </div>
    </Section>
  );
}

function OverviewTab({ server, m, range }: { server: Server; m: ReturnType<typeof useLiveServerMetrics>; range: MetricsRange }) {
  const latest = m.latest;
  const offline = server.liveness === 'offline';
  if (!latest && !m.history.isLoading && server.lastSeenAt == null) return <AgentNotReporting server={server} />;

  const cores = server.cpuCores ?? (m.perCore.length || 1);
  const memPct = latest ? ratio(latest.memUsed, latest.memTotal) : null;
  const diskPct = latest ? ratio(latest.diskUsed, latest.diskTotal) : null;
  const loads = loadAverages(latest);
  const loadPct = loads.l1 == null ? null : (loads.l1 / Math.max(1, cores)) * 100;
  const span = RANGE_MS[range];
  const chart = (node: ReactNode) => (m.history.isLoading ? <Skeleton className="h-[180px]" /> : node);

  return (
    <>
      {offline && latest && (
        <div className="mb-6"><Callout tone="bad">The agent stopped reporting {timeAgo(server.lastSeenAt)}. These are the last known values.</Callout></div>
      )}

      <div className="mb-10 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {latest ? (
          <>
            <Tile><RadialGauge value={latest.cpu} label="CPU" sub={`${cores} cores`} /></Tile>
            <Tile><RadialGauge value={memPct} label="Memory" sub={`${bytes(latest.memUsed)} of ${bytes(latest.memTotal, 0)}`} /></Tile>
            <Tile><RadialGauge value={diskPct} label="Disk" thresholds={[85, 95]} sub={`${bytes(latest.diskUsed, 0)} of ${bytes(latest.diskTotal, 0)}`} /></Tile>
            <Tile>
              <div className="text-xs text-muted">Load (1m)</div>
              <div className="mt-1.5 text-2xl font-semibold leading-none tabular-nums">{loads.l1 == null ? '—' : loads.l1.toFixed(2)}</div>
              <Meter className="mt-3" value={loadPct ?? 0} tone={loadPct != null && loadPct >= 100 ? 'bad' : loadPct != null && loadPct >= 75 ? 'warn' : 'brand'} />
              <div className="mt-2 truncate text-xs tabular-nums text-muted">5m {loads.l5?.toFixed(2) ?? '—'} · 15m {loads.l15?.toFixed(2) ?? '—'}</div>
            </Tile>
          </>
        ) : [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[112px]" />)}
      </div>

      <section className="mb-10">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">History</h2>
            <p className="mt-0.5 text-sm text-muted">Resource usage over the last {range}.{m.history.isFetching ? ' Updating…' : ''}</p>
          </div>
        </div>
        <ErrorBox error={m.history.error} />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ChartCard title="CPU" value={latest ? `${latest.cpu.toFixed(1)}%` : undefined}>
            {chart(<AreaMetric data={m.rows} syncId="server" spanMs={span} domain={[0, 100]} format={(v) => `${v.toFixed(0)}%`}
              series={[{ key: 'cpu', label: 'CPU', color: 'var(--color-cpu)' }]} guides={[{ y: 90, label: 'alert 90%' }]} />)}
          </ChartCard>
          <ChartCard title="Memory" value={latest ? `${bytes(latest.memUsed)} of ${bytes(latest.memTotal, 0)}` : undefined}>
            {chart(<AreaMetric data={m.rows} syncId="server" spanMs={span} domain={[0, 'dataMax']} format={(v) => bytes(v, 1)} axisFormat={(v) => bytes(v, 0)}
              series={[{ key: 'memUsed', label: 'Used', color: 'var(--color-mem)' }, { key: 'memTotal', label: 'Total', color: '#5c5c5c', kind: 'line', dashed: true }]} />)}
          </ChartCard>
          <Card title="Network" actions={<Legend items={[['In', 'var(--color-net-rx)'], ['Out', 'var(--color-net-tx)']]} />}>
            {chart(<AreaMetric data={m.rows} syncId="server" spanMs={span} format={(v) => rate(v)} axisFormat={(v) => bytes(v, 1)}
              series={[{ key: 'netRx', label: 'In', color: 'var(--color-net-rx)' }, { key: 'netTx', label: 'Out', color: 'var(--color-net-tx)' }]} />)}
          </Card>
          <ChartCard title="Disk" value={latest ? `${bytes(latest.diskUsed, 0)} of ${bytes(latest.diskTotal, 0)}` : undefined}>
            {chart(<AreaMetric data={m.rows} syncId="server" spanMs={span} domain={[0, 'dataMax']} format={(v) => bytes(v, 0)}
              series={[{ key: 'diskUsed', label: 'Used', color: 'var(--color-disk)' }, { key: 'diskTotal', label: 'Total', color: '#5c5c5c', kind: 'line', dashed: true }]} />)}
          </ChartCard>
        </div>
      </section>

      <section>
        <div className="mb-3">
          <h2 className="text-lg font-semibold">Right now</h2>
          <p className="mt-0.5 text-sm text-muted">Live per-core usage, load averages and throughput from the agent.</p>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <Card title="Per-core CPU">
            <CoreHeatmap values={m.perCore} />
          </Card>
          <Card title="Load and network">
            <div className="space-y-2.5">
              <LoadRow label="1 min" value={loads.l1} cores={cores} />
              <LoadRow label="5 min" value={loads.l5} cores={cores} />
              <LoadRow label="15 min" value={loads.l15} cores={cores} />
            </div>
            <p className="mt-2 text-xs text-muted">A full bar equals {cores} cores busy.</p>
            <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-border pt-4">
              <div><dt className="text-xs text-muted">Inbound</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{rate(latest?.netRx)}</dd></div>
              <div><dt className="text-xs text-muted">Outbound</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{rate(latest?.netTx)}</dd></div>
              {latest && latest.swapUsed > 0 && <div className="col-span-2"><dt className="text-xs text-muted">Swap in use</dt><dd className="mt-1 text-sm tabular-nums text-warn">{bytes(latest.swapUsed)}</dd></div>}
            </dl>
          </Card>
        </div>
      </section>
    </>
  );
}

// ───────────── configuration tab ─────────────

function GeneralForm({ server }: { server: Server }) {
  const qc = useQueryClient();
  const initial = { name: server.name, host: server.host, port: String(server.port), sshUser: server.sshUser };
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setForm({ name: server.name, host: server.host, port: String(server.port), sshUser: server.sshUser }); }, [server.name, server.host, server.port, server.sshUser]);
  const dirty = form.name !== initial.name || form.host !== initial.host || form.port !== initial.port || form.sshUser !== initial.sshUser;

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    const port = Number(form.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return setError('Port must be a number between 1 and 65535.');
    setBusy(true);
    setError(null);
    try {
      const body: UpdateServerRequest = { name: form.name.trim(), host: form.host.trim(), port, sshUser: form.sshUser.trim() || 'root' };
      await api<Server>(`/servers/${server.id}`, { method: 'PATCH', body });
      await invalidateServers(qc);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) { setError(err); }
    finally { setBusy(false); }
  };

  return (
    <Section title="General" description="Connection details Docksy uses to reach this server over SSH."
      actions={<><Button variant="primary" size="sm" onClick={() => save()} loading={busy} disabled={!dirty}>Save</Button>{saved && <span className="text-xs text-ok">Saved</span>}</>}>
      <form onSubmit={save} className="space-y-5">
        <FieldGrid>
          <Field label="Name" required>
            <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Host" required help="IP address or hostname.">
            <Input required value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} className="font-mono" />
          </Field>
          <Field label="SSH port" required>
            <Input required inputMode="numeric" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} className="font-mono" />
          </Field>
          <Field label="SSH user" required help="root, or a user with passwordless sudo.">
            <Input required value={form.sshUser} onChange={(e) => setForm({ ...form, sshUser: e.target.value })} className="font-mono" />
          </Field>
        </FieldGrid>
        <ErrorBox error={error} />
        <button type="submit" hidden />
      </form>
    </Section>
  );
}

function ValidateSection({ server }: { server: Server }) {
  const [res, setRes] = useState<ValidateServerResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    setError(null);
    try { setRes(await api<ValidateServerResponse>(`/servers/${server.id}/validate`, { method: 'POST' })); }
    catch (e) { setError(e); setRes(null); }
    finally { setRunning(false); }
  };
  return (
    <Section title="Validation" description="Check SSH access, privileges, the operating system, Docker and free disk."
      actions={<Button size="sm" onClick={run} loading={running} icon={<RefreshCw className="size-3.5" />}>Validate</Button>}>
      <ErrorBox error={error} />
      {res ? (
        <Card padded={false}>
          <ul>
            {res.checks.map((c) => (
              <li key={c.name} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 border-t border-border px-4 py-2.5 first:border-t-0 sm:grid-cols-[200px_minmax(0,1fr)_auto]">
                <span className="text-sm">{c.name}</span>
                <span className="col-span-2 row-start-2 text-sm text-muted sm:col-span-1 sm:row-start-auto">{c.detail}</span>
                <span className="col-start-2 row-start-1 sm:col-start-auto"><Status status={c.ok ? 'passed' : 'failed'} className="text-xs" /></span>
              </li>
            ))}
          </ul>
        </Card>
      ) : !error && <p className="text-sm text-muted">{running ? 'Checking…' : 'Not run yet in this session.'}</p>}
    </Section>
  );
}

function ProvisionSection({ server }: { server: Server }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const nav = useNavigate();
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await api<ProvisionJob>(`/servers/${server.id}/provision`, { method: 'POST' });
      nav(`/servers/new?server=${server.id}&step=3`);
    } catch (e) { setError(e); setBusy(false); }
  };
  return (
    <Section title="Provisioning" description="Re-install Docker, the Caddy proxy and the Docksy agent. Running apps keep running; it is safe to repeat."
      actions={<Button size="sm" onClick={() => setConfirm(true)}>Re-provision</Button>}>
      <p className="text-sm text-muted">Current state: <span className="text-fg">{server.status}</span>{server.status === 'provisioning' && <> · <Link to={`/servers/new?server=${server.id}&step=3`} className="text-fg underline underline-offset-2">view the live log</Link></>}</p>
      <Modal open={confirm} onClose={() => setConfirm(false)} title={`Re-provision ${server.name}?`}
        footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={start}>Re-provision</Button></>}>
        <p className="text-sm text-muted">Docksy connects over SSH and re-runs the install script. It takes about two minutes. You can follow the log on the next screen.</p>
        {error != null && <div className="mt-3"><ErrorBox error={error} /></div>}
      </Modal>
    </Section>
  );
}

function AgentSection({ server }: { server: Server }) {
  const rows: [string, ReactNode][] = [
    ['Agent version', server.agentVersion ?? '—'],
    ['Last report', server.lastSeenAt ? timeAgo(server.lastSeenAt) : 'never'],
    ['Operating system', server.os ?? '—'],
    ['Architecture', server.arch ?? '—'],
    ['CPU cores', server.cpuCores ?? '—'],
    ['Memory', server.memTotal != null ? bytes(server.memTotal, 1) : '—'],
    ['Disk', server.diskTotal != null ? bytes(server.diskTotal, 0) : '—'],
    ['Added', timeAgo(server.createdAt)],
  ];
  return (
    <Section title="Agent" description="The Docksy agent reports metrics and containers every few seconds.">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="mt-0.5 text-sm tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function ConfigurationTab({ server }: { server: Server }) {
  const [section, setSection] = useState('general');
  return (
    <SubNavLayout value={section} onChange={setSection}
      items={[
        { id: 'general', label: 'General' },
        { id: 'validation', label: 'Validation' },
        { id: 'provisioning', label: 'Provisioning' },
        { id: 'agent', label: 'Agent' },
      ]}>
      <div className="max-w-4xl">
        {section === 'general' && <GeneralForm server={server} />}
        {section === 'validation' && <ValidateSection server={server} />}
        {section === 'provisioning' && <ProvisionSection server={server} />}
        {section === 'agent' && <><AgentSection server={server} /><Troubleshooting server={server} /></>}
      </div>
    </SubNavLayout>
  );
}

// ───────────── danger zone ─────────────

function DangerZone({ server }: { server: Server }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const qc = useQueryClient();
  const del = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/servers/${server.id}`, { method: 'DELETE' });
      await invalidateServers(qc);
      nav('/servers', { replace: true });
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Section title="Danger Zone" description="Actions here cannot be undone.">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-border px-4 py-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">Remove this server</div>
          <p className="mt-0.5 text-sm text-muted">Docksy forgets the server and stops collecting its metrics. Nothing on the VPS is deleted. Servers that still have apps can’t be removed.</p>
        </div>
        <Button variant="danger" onClick={() => { setTyped(''); setError(null); setOpen(true); }} icon={<Trash2 className="size-4" />}>Remove server</Button>
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title={`Remove ${server.name}?`}
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="danger" loading={busy} disabled={typed !== server.name} onClick={del} icon={<Trash2 className="size-4" />}>Remove server</Button></>}>
        <p className="text-sm text-muted">The agent keeps running on the VPS until you uninstall it. Type <span className="font-mono text-fg">{server.name}</span> to confirm.</p>
        <Input className="mt-3 font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={server.name} aria-label="Server name" />
        {error != null && <div className="mt-3"><ErrorBox error={error instanceof ApiError && error.status === 409 ? 'This server still has apps. Delete or move them first.' : error} /></div>}
      </Modal>
    </Section>
  );
}

// ───────────── page ─────────────

export default function ServerDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const range = (RANGES as string[]).includes(params.get('range') ?? '') ? (params.get('range') as MetricsRange) : '1h';
  const tab = (TABS as string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'overview';
  const setParam = (k: string, v: string, def: string) => setParams((p) => { if (v === def) p.delete(k); else p.set(k, v); return p; }, { replace: true });
  useNow(10_000);

  const serverQ = useApi<Server>(id ? `/servers/${id}` : null, { refetchInterval: 15_000 });
  const m = useLiveServerMetrics(id, range);
  const diag = useDiagnose({ serverId: id });
  const server = serverQ.data;
  const autoDiagnose = params.get('diagnose') === '1';
  useEffect(() => {
    if (!autoDiagnose || !id) return;
    diag.run();
    setParams((p) => { p.delete('diagnose'); return p; }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDiagnose, id]);

  if (serverQ.isLoading) return <Loading label="Loading server…" />;
  if (serverQ.error || !server) {
    return (
      <EmptyState title={serverQ.error?.status === 404 ? 'Server not found' : 'Couldn’t load this server'}
        action={<Link to="/servers"><Button icon={<ArrowLeft className="size-4" />}>Back to servers</Button></Link>}>
        {serverQ.error?.message}
      </EmptyState>
    );
  }

  const st = serverStatus(server);
  const running = m.containers.filter((c) => c.state === 'running').length;
  const info = [
    <span key="ssh" className="font-mono">{server.sshUser}@{server.host}:{server.port}</span>,
    server.os && `${server.os}${server.arch ? ` · ${server.arch}` : ''}`,
    server.cpuCores != null && `${server.cpuCores} cores`,
    server.memTotal != null && `${bytes(server.memTotal, 0)} RAM`,
    server.agentVersion && `agent ${server.agentVersion}`,
  ].filter(Boolean);

  return (
    <div>
      <Breadcrumbs items={[
        { label: 'Servers', to: '/servers' },
        { label: <span className="flex items-center gap-3">{server.name}<Status status={st.status} label={st.label} /></span> },
      ]} />
      <div className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        {info.map((x, i) => <span key={i} className="flex items-center gap-2">{i > 0 && <span className="text-faint">·</span>}{x}</span>)}
        <span className="text-faint">·</span>
        <LiveText sse={m.sse} lastEventAt={m.lastEventAt} offline={server.liveness === 'offline'} />
      </div>

      <PageTabs value={tab} onChange={(t) => setParam('tab', t, 'overview')}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'containers', label: <>Containers{m.containers.length > 0 && <span className="ml-1.5 text-xs text-faint tabular-nums">{m.containers.length}</span>}</> },
          { id: 'configuration', label: 'Configuration' },
          { id: 'danger', label: 'Danger Zone' },
        ]}
        actions={<>
          <DiagnoseButton onClick={diag.run} loading={diag.loading} />
          {tab === 'overview' && <RangePicker value={range} onChange={(r) => setParam('range', r, '1h')} />}
        </>} />

      {diag.open && <DiagnosePanel state={diag} target={server.name} onClose={() => diag.setOpen(false)} />}

      {tab === 'overview' && <OverviewTab server={server} m={m} range={range} />}

      {tab === 'containers' && (
        <Section title="Containers" description={m.containers.length ? `${running} running, ${m.containers.length} total. Updated live from the agent.` : 'Every container on this server, updated live from the agent.'}
          actions={<Link to={`/apps?serverId=${server.id}`}><Button size="sm">Apps on this server</Button></Link>}>
          <div className={clsx('overflow-hidden rounded-md border border-border')}>
            {m.containersLoading ? <div className="space-y-2 p-4"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
              : <ContainersTable containers={m.containers} hostMem={server.memTotal} />}
          </div>
        </Section>
      )}

      {tab === 'configuration' && <ConfigurationTab server={server} />}

      {tab === 'danger' && <div className="max-w-4xl"><DangerZone server={server} /></div>}
    </div>
  );
}
