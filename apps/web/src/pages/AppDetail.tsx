// Owned by: web-apps (see CONTRACT.md §2).
import '../features/apps/mock.ts';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ExternalLink, Play, RotateCcw, RotateCw, Square, Undo2 } from 'lucide-react';
import { Breadcrumbs, Button, EmptyState, ErrorBox, Loading, PageTabs, Status } from '../components/ui.tsx';
import { Modal, appStatusLabel, useToasts } from '../features/apps/components.tsx';
import { appActions, domainUrl, rollbackTargets, useAction, useApp, useDeployments, useServers, useTemplates } from '../features/apps/hooks.ts';
import { DeploymentsTab, RollbackModal } from '../features/apps/DeploymentsTab.tsx';
import { LogsTab } from '../features/apps/LogsTab.tsx';
import { TerminalTab } from '../features/apps/TerminalTab.tsx';
import { MetricsTab } from '../features/apps/AppMetrics.tsx';
import { ConfigTab, configSections, type ConfigSectionId } from '../features/apps/config/ConfigTab.tsx';

const TABS = [
  { id: 'configuration', label: 'Configuration' },
  { id: 'deployments', label: 'Deployments' },
  { id: 'logs', label: 'Logs' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'metrics', label: 'Metrics' },
] as const;
type Tab = (typeof TABS)[number]['id'];

/** Old tab ids (bookmarks from the previous UI) → new tab/section. */
const LEGACY: Record<string, [Tab, ConfigSectionId?]> = {
  overview: ['configuration', 'general'], settings: ['configuration', 'general'], env: ['configuration', 'environment'],
  webhook: ['configuration', 'webhooks'], backups: ['configuration', 'backups'],
};

export default function AppDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const app = useApp(id);
  const a = app.data;
  const deps = useDeployments(a?.id);
  const servers = useServers();
  const templates = useTemplates();
  const toasts = useToasts();
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);

  const deploy = useAction(() => appActions.deploy(a!.id));
  const restart = useAction(() => appActions.restart(a!.id));
  const stop = useAction(() => appActions.stop(a!.id));
  const start = useAction(() => appActions.start(a!.id));

  if (app.isLoading) return <Loading />;
  if (app.error || !a) {
    return (
      <EmptyState title={app.error?.status === 404 ? 'Application not found' : 'Could not load this application'}
        action={<Link to="/apps"><Button>Back to apps</Button></Link>}>
        {app.error?.status === 404 ? 'It may have been deleted.' : app.error?.message}
      </EmptyState>
    );
  }

  const tpl = templates.data?.items.find((t) => t.id === a.template);
  const hasBackups = a.kind === 'database' && (tpl ? tpl.backupSupported : true);
  const rawTab = params.get('tab') ?? 'configuration';
  const legacy = LEGACY[rawTab];
  const tab: Tab = legacy ? legacy[0] : TABS.some((t) => t.id === rawTab) ? (rawTab as Tab) : 'configuration';
  const sections = configSections(a, hasBackups).filter((s) => !s.hidden);
  const rawSection = params.get('section') ?? legacy?.[1] ?? 'general';
  const section: ConfigSectionId = sections.some((s) => s.id === rawSection) ? (rawSection as ConfigSectionId) : 'general';

  const go = (t: string, s?: string) => {
    const next = new URLSearchParams(params);
    next.set('tab', t);
    if (t === 'configuration') next.set('section', s ?? section); else next.delete('section');
    setParams(next, { replace: false });
  };

  const server = servers.data?.items.find((s) => s.id === a.serverId);
  const depList = deps.data?.items ?? [];
  const deployed = !!a.currentDeploymentId || depList.length > 0;
  const canRollback = rollbackTargets(depList, a.currentDeploymentId).length > 0;
  const down = a.status === 'stopped' || a.status === 'failed';
  const fail = (what: string) => (e: Error) => toasts.push('bad', `${what} failed: ${e.message}`);
  const primaryDomain = a.domains[0];

  const actions = (
    <>
      {canRollback && <Button variant="ghost" icon={<Undo2 className="size-4" />} onClick={() => setRollbackOpen(true)}>Rollback</Button>}
      <Button variant="primary" icon={<RotateCw className="size-4" />} loading={deploy.isPending} disabled={a.status === 'deploying'}
        onClick={() => deploy.mutate(undefined, { onSuccess: (d) => navigate(`/deployments/${d.id}`), onError: fail('Deploy') })}>
        {deployed ? 'Redeploy' : 'Deploy'}
      </Button>
      {a.currentDeploymentId && (
        <>
          <Button icon={<RotateCcw className="size-4" />} loading={restart.isPending} disabled={down || a.status === 'deploying'}
            onClick={() => restart.mutate(undefined, { onSuccess: () => toasts.push('ok', `${a.name} is restarting`), onError: fail('Restart') })}>Restart</Button>
          {down ? (
            <Button icon={<Play className="size-4" />} loading={start.isPending}
              onClick={() => start.mutate(undefined, { onSuccess: () => toasts.push('ok', `${a.name} is starting`), onError: fail('Start') })}>Start</Button>
          ) : (
            <Button icon={<Square className="size-3.5" />} loading={stop.isPending} disabled={a.status === 'deploying'} onClick={() => { stop.reset(); setStopOpen(true); }}>Stop</Button>
          )}
        </>
      )}
    </>
  );

  return (
    <div className="mx-auto max-w-[1400px]">
      <Breadcrumbs items={[
        { label: 'Apps', to: '/apps' },
        { label: server?.name ?? 'Server', to: server ? `/servers/${server.id}` : undefined },
        { label: a.name },
      ]} />
      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold">{a.name}</h1>
        <Status status={a.status} label={appStatusLabel(a.status)} />
        {primaryDomain && (
          <a href={domainUrl(primaryDomain)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
            {primaryDomain}<ExternalLink className="size-3.5" />
          </a>
        )}
        {a.description && <p className="basis-full text-sm text-muted">{a.description}</p>}
      </div>

      <PageTabs tabs={TABS.map((t) => ({ id: t.id, label: t.label }))} value={tab} onChange={(t) => go(t)} actions={actions} />

      {tab === 'configuration' && (
        <ConfigTab app={a} server={server} section={section} onSection={(s) => go('configuration', s)} deployed={deployed} backups={hasBackups} />
      )}
      {tab === 'deployments' && <DeploymentsTab app={a} deps={depList} loading={deps.isLoading} error={deps.error} />}
      {tab === 'logs' && <LogsTab app={a} />}
      {tab === 'terminal' && <TerminalTab app={a} />}
      {tab === 'metrics' && <MetricsTab app={a} />}

      <RollbackModal app={a} deps={depList} open={rollbackOpen} onClose={() => setRollbackOpen(false)} />
      <Modal open={stopOpen} onClose={() => setStopOpen(false)} title={`Stop ${a.name}`}
        footer={<>
          <Button variant="ghost" onClick={() => setStopOpen(false)}>Cancel</Button>
          <Button variant="danger" icon={<Square className="size-3.5" />} loading={stop.isPending}
            onClick={() => stop.mutate(undefined, { onSuccess: () => { setStopOpen(false); toasts.push('ok', `${a.name} stopped`); } })}>Stop application</Button>
        </>}>
        <p className="text-sm text-muted">The container stops and {primaryDomain ? <span className="text-fg">{primaryDomain}</span> : 'the app'} goes offline until you start it again. Data in volumes is kept.</p>
        {stop.error && <div className="mt-3"><ErrorBox error={stop.error} /></div>}
      </Modal>
      {toasts.view}
    </div>
  );
}
