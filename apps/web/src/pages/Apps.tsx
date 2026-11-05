// Apps list: Coolify-style resources table. See apps/web/DESIGN.md.
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ChevronRight, ExternalLink, Plus, RotateCw, Search } from 'lucide-react';
import type { App, Deployment } from '@docksy/shared';
import { useApi } from '../lib/api.ts';
import { timeAgo } from '../lib/format.ts';
import { Button, EmptyState, ErrorBox, Input, Loading, PageHeader, Select, Status, Table } from '../components/ui.tsx';
import { actions, domainUrl, sourceLine, typeLabel, useAction, useApps, useServers, useTemplates } from '../features/newapp/data.ts';

export default function Apps() {
  const [q, setQ] = useState('');
  const [serverId, setServerId] = useState('');
  const apps = useApps(5000);
  const servers = useServers();
  const templates = useTemplates();
  const recent = useApi<{ items: Deployment[] }>('/deployments?limit=200', { refetchInterval: 10_000 });
  const navigate = useNavigate();
  const deploy = useAction((a: App) => actions.deploy(a.id));

  const serverName = useMemo(() => new Map((servers.data?.items ?? []).map((s) => [s.id, s.name])), [servers.data]);
  const lastDeploy = useMemo(() => {
    const m = new Map<string, Deployment>();
    for (const d of recent.data?.items ?? []) {
      const prev = m.get(d.appId);
      if (!prev || d.createdAt > prev.createdAt) m.set(d.appId, d);
    }
    return m;
  }, [recent.data]);

  const all = apps.data?.items ?? [];
  const list = useMemo(() => {
    const f = q.trim().toLowerCase();
    return all
      .filter((a) => !serverId || a.serverId === serverId)
      .filter((a) => !f || [a.name, a.description ?? '', a.repoUrl ?? '', a.image ?? '', ...a.domains].some((s) => s.toLowerCase().includes(f)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [all, q, serverId]);

  const onRedeploy = (a: App) => deploy.mutate(a, { onSuccess: (d) => navigate(`/deployments/${d.id}`) });
  const running = all.filter((a) => a.status === 'running').length;
  const newButton = (
    <Link to="/apps/new"><Button variant="primary" icon={<Plus className="size-4" />}>New</Button></Link>
  );

  return (
    <div>
      <PageHeader title="Apps"
        subtitle={all.length ? `All applications, databases and services. ${all.length} total, ${running} running.` : 'All applications, databases and services.'}
        actions={newButton} />

      {apps.isLoading ? <Loading /> : apps.error ? <ErrorBox error={apps.error} retry={() => void apps.refetch()} /> : all.length === 0 ? (
        <EmptyState title="No apps yet"
          action={<Link to="/apps/new"><Button icon={<Plus className="size-4" />}>New resource</Button></Link>}>
          Deploy a Git repository, a Docker image, a database or a ready-made service to one of your servers.
        </EmptyState>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, domain or source" className="pl-9" aria-label="Search apps" />
            </div>
            <div className="w-full sm:w-48">
              <Select value={serverId} onChange={(e) => setServerId(e.target.value)} aria-label="Filter by server">
                <option value="">All servers</option>
                {(servers.data?.items ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </div>
            <span className="ml-auto hidden text-xs text-muted sm:inline">{list.length} of {all.length}</span>
          </div>
          <ErrorBox error={deploy.error} />

          {list.length === 0 ? (
            <EmptyState title="No apps match">Try a different search or server.</EmptyState>
          ) : (
            <Table className="mt-0">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th className="hidden md:table-cell">Type</th>
                  <th className="hidden lg:table-cell">Server</th>
                  <th className="hidden md:table-cell">Domain</th>
                  <th className="hidden whitespace-nowrap sm:table-cell">Last deploy</th>
                  <th className="text-right!"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {list.map((a) => {
                  const last = lastDeploy.get(a.id);
                  const t = typeLabel(a, templates.data?.items);
                  const line = sourceLine(a);
                  const busy = (deploy.isPending && deploy.variables?.id === a.id) || a.status === 'deploying';
                  return (
                    <tr key={a.id} className="transition-colors duration-150 hover:bg-surface/60">
                      <td className="max-w-0 w-[34%] min-w-48">
                        <Link to={`/apps/${a.id}`} className="block min-w-0">
                          <div className="truncate font-medium text-fg hover:underline">{a.name}</div>
                          {line && <div className="truncate text-xs text-muted" title={line}>{line}</div>}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap"><Status status={a.status} /></td>
                      <td className="hidden whitespace-nowrap md:table-cell">
                        <span className="text-fg">{t.kind}</span>
                        {t.detail && <span className="text-muted"> · {t.detail}</span>}
                      </td>
                      <td className="hidden whitespace-nowrap text-muted lg:table-cell">{serverName.get(a.serverId) ?? '—'}</td>
                      <td className="hidden max-w-56 md:table-cell">
                        {a.domains[0] ? (
                          <a href={domainUrl(a.domains[0])} target="_blank" rel="noreferrer" className="block truncate text-fg underline decoration-border-strong underline-offset-4 hover:decoration-fg">
                            {a.domains[0]}
                          </a>
                        ) : <span className="text-faint">{a.kind === 'database' ? 'Internal' : '—'}</span>}
                      </td>
                      <td className="hidden whitespace-nowrap text-muted sm:table-cell">
                        {last ? (
                          <Link to={`/deployments/${last.id}`} className="hover:text-fg" title={new Date(last.createdAt).toLocaleString()}>
                            {timeAgo(last.createdAt)}{last.status === 'failed' && <span className="text-bad"> · failed</span>}
                          </Link>
                        ) : 'Never'}
                      </td>
                      <td className="whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button size="sm" icon={<RotateCw className="size-3.5" />} loading={deploy.isPending && deploy.variables?.id === a.id}
                            disabled={busy} onClick={() => onRedeploy(a)} title={`Redeploy ${a.name}`}>
                            <span className="hidden sm:inline">Redeploy</span>
                          </Button>
                          {a.domains[0] && (
                            <a href={domainUrl(a.domains[0])} target="_blank" rel="noreferrer" title="Open in a new tab"
                              className="hidden h-7 items-center rounded-md border border-border-strong bg-surface-2 px-2 text-muted hover:text-fg md:inline-flex">
                              <ExternalLink className="size-3.5" />
                            </a>
                          )}
                          <Link to={`/apps/${a.id}`} title="Open" aria-label={`Open ${a.name}`}
                            className="inline-flex h-7 items-center rounded-md px-1.5 text-muted hover:bg-surface-2 hover:text-fg">
                            <ChevronRight className="size-4" />
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </>
      )}
    </div>
  );
}
