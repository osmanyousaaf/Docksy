import { Link } from 'react-router';
import { Plus } from 'lucide-react';
import type { Alert, App, Deployment, FleetOverview } from '@docksy/shared';
import { useApi } from '../lib/api.ts';
import { Button, Card, ErrorBox, PageHeader, Stat, Status } from '../components/ui.tsx';
import { duration, timeAgo } from '../lib/format.ts';
import { SeverityBadge, Skeleton } from '../features/monitoring/components.tsx';
import { FleetTable } from '../features/monitoring/FleetTable.tsx';
import { useNow } from '../features/monitoring/hooks.ts';

function SectionHead({ title, description, to, linkLabel }: { title: string; description?: string; to?: string; linkLabel?: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {to && <Link to={to} className="text-sm text-muted hover:text-fg">{linkLabel ?? 'View all'}</Link>}
    </div>
  );
}

function FirstRun() {
  const steps = [
    ['Authorize Docksy’s SSH key', 'Paste one line on your VPS so Docksy can connect.'],
    ['Validate and provision', 'Docksy installs Docker, the Caddy proxy and the metrics agent.'],
    ['Deploy and monitor', 'CPU, memory, disk and every container are monitored by default.'],
  ];
  return (
    <div className="rounded-md border border-dashed border-border px-6 py-12">
      <div className="mx-auto max-w-xl text-center">
        <h2 className="text-lg font-semibold">No servers yet</h2>
        <p className="mt-1 text-sm text-muted">Connect any VPS with SSH access. Setup takes about two minutes.</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Link to="/servers/new"><Button variant="primary" icon={<Plus className="size-4" />}>Add a server</Button></Link>
          <Link to="/claude"><Button variant="secondary">Set up with Claude</Button></Link>
        </div>
      </div>
      <ol className="mx-auto mt-10 grid max-w-3xl gap-6 text-left sm:grid-cols-3">
        {steps.map(([title, body], i) => (
          <li key={title}>
            <div className="text-xs tabular-nums text-faint">Step {i + 1}</div>
            <div className="mt-1 text-sm font-medium">{title}</div>
            <div className="mt-0.5 text-sm text-muted">{body}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function FiringAlerts({ names }: { names: Record<string, string> }) {
  const { data, isLoading } = useApi<{ items: Alert[] }>('/alerts?state=firing', { refetchInterval: 30_000 });
  const items = data?.items.filter((a) => a.state === 'firing') ?? [];
  return (
    <section>
      <SectionHead title="Firing alerts" description="Alerts that are active right now." to="/alerts" linkLabel="All alerts" />
      <Card padded={false}>
        {isLoading && <div className="space-y-2 p-4"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>}
        {!isLoading && items.length === 0 && (
          <div className="px-4 py-6 text-sm text-muted">No alerts are firing. Default rules watch CPU, memory, disk, containers and uptime.</div>
        )}
        <ul>
          {items.slice(0, 8).map((a) => (
            <li key={a.id} className="border-t border-border first:border-t-0">
              <Link to={a.serverId ? `/servers/${a.serverId}` : '/alerts'} className="flex items-start gap-4 px-4 py-3 transition-colors duration-150 hover:bg-surface-2/50">
                <span className="w-16 shrink-0 pt-0.5"><SeverityBadge severity={a.severity} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">{a.title}</span>
                  <span className="block truncate text-xs text-muted">
                    {a.serverId && names[a.serverId] ? `${names[a.serverId]} · ` : ''}since {timeAgo(a.startedAt)}{a.ackedAt ? ' · acknowledged' : ''}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

function RecentDeployments() {
  const deps = useApi<{ items: Deployment[] }>('/deployments?limit=6', { refetchInterval: 15_000 });
  const apps = useApi<{ items: App[] }>('/apps');
  const appName = Object.fromEntries((apps.data?.items ?? []).map((a) => [a.id, a.name]));
  const items = deps.data?.items ?? [];
  return (
    <section>
      <SectionHead title="Recent deployments" description="The latest builds across all apps." to="/apps" linkLabel="All apps" />
      <Card padded={false}>
        {deps.isLoading && <div className="space-y-2 p-4"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>}
        {!deps.isLoading && items.length === 0 && <div className="px-4 py-6 text-sm text-muted">No deployments yet.</div>}
        <ul>
          {items.map((d) => (
            <li key={d.id} className="border-t border-border first:border-t-0">
              <Link to={`/deployments/${d.id}`} className="flex items-center gap-4 px-4 py-3 transition-colors duration-150 hover:bg-surface-2/50">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">{appName[d.appId] ?? 'app'}</span>
                  <span className="block truncate text-xs text-muted">
                    {d.commitMessage ?? d.imageTag ?? d.trigger} · {d.trigger}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <Status status={d.status} className="text-xs" />
                  <span className="block text-xs tabular-nums text-faint">
                    {timeAgo(d.createdAt)}{d.startedAt && d.finishedAt ? ` · ${duration(d.startedAt, d.finishedAt)}` : ''}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

export default function Overview() {
  const { data, isLoading, error, refetch } = useApi<FleetOverview>('/overview', { refetchInterval: 10_000 });
  useNow(10_000);
  const servers = data?.servers ?? [];
  const names = Object.fromEntries(servers.map((s) => [s.server.id, s.server.name]));
  const t = data?.totals;

  return (
    <div>
      <PageHeader title="Overview" subtitle="Your servers, apps and alerts at a glance."
        actions={servers.length > 0 && <Link to="/servers/new"><Button variant="primary" icon={<Plus className="size-4" />}>Add server</Button></Link>} />
      <ErrorBox error={error} retry={() => void refetch()} />
      {isLoading && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-[74px]" />)}</div>
          <Skeleton className="h-40" />
        </div>
      )}
      {data && servers.length === 0 && <FirstRun />}
      {data && servers.length > 0 && t && (
        <>
          <div className="mb-10 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Servers" value={t.servers} />
            <Stat label="Online" value={`${t.online} / ${t.servers}`} tone={t.online < t.servers ? 'warn' : undefined} />
            <Stat label="Apps" value={t.apps} />
            <Stat label="Running containers" value={t.runningContainers} />
            <Stat label="Firing alerts" value={t.firingAlerts} tone={t.firingAlerts ? 'bad' : undefined} />
          </div>

          <section className="mb-10">
            <SectionHead title="Servers" description="Live resource usage, refreshed every 10 seconds." to="/servers" linkLabel="Manage servers" />
            <FleetTable servers={servers} />
          </section>

          <div className="grid grid-cols-1 gap-x-8 gap-y-10 xl:grid-cols-2">
            <FiringAlerts names={names} />
            <RecentDeployments />
          </div>
        </>
      )}
    </div>
  );
}
