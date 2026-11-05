// New resource: pick a type (step 1), then one formal form (step 2). See apps/web/DESIGN.md.
// Deep links: /apps/new?type=git|image|template[&private=1][&template=postgres][&server=<id>]
import { Link, useSearchParams } from 'react-router';
import { Breadcrumbs, Button, EmptyState, ErrorBox, Loading, PageHeader } from '../components/ui.tsx';
import { ResourceList } from '../features/newapp/ResourceList.tsx';
import { ResourceForm, type Kind } from '../features/newapp/ResourceForm.tsx';
import { useServers, useTemplates } from '../features/newapp/data.ts';

const KINDS: Kind[] = ['git', 'image', 'template'];

export default function NewApp() {
  const [params] = useSearchParams();
  const rawType = params.get('type') ?? '';
  const kind = (KINDS as string[]).includes(rawType) ? (rawType as Kind) : null;
  const isPrivate = params.get('private') === '1';
  const templateId = params.get('template');
  const servers = useServers();
  const templates = useTemplates();
  const template = kind === 'template' ? templates.data?.items.find((t) => t.id === templateId) ?? null : null;

  const title = kind === 'git' ? (isPrivate ? 'Private Git repository' : 'Public Git repository')
    : kind === 'image' ? 'Docker Image'
      : kind === 'template' ? (template?.name ?? 'Template') : null;

  const crumbs = [{ label: 'Apps', to: '/apps' }, { label: 'New', to: kind ? '/apps/new' : undefined }, ...(title ? [{ label: title }] : [])];

  if (servers.isLoading) return <Loading />;
  if (servers.error) return <ErrorBox error={servers.error} />;
  const serverList = servers.data?.items ?? [];

  if (serverList.length === 0) {
    return (
      <div className="max-w-4xl">
        <Breadcrumbs items={crumbs} />
        <PageHeader title="New resource" />
        <EmptyState title="Add a server first" action={<Link to="/servers/new"><Button variant="primary">Add server</Button></Link>}>
          Resources run on your own servers. Connect a VPS over SSH and Docksy installs Docker, the proxy and the metrics agent.
        </EmptyState>
      </div>
    );
  }

  if (!kind) {
    return (
      <div className="max-w-4xl">
        <Breadcrumbs items={crumbs} />
        <PageHeader title="New resource" subtitle="Choose what you want to deploy." />
        <ResourceList templates={templates.data?.items} loading={templates.isLoading} error={templates.error} />
      </div>
    );
  }

  if (kind === 'template' && !template) {
    return (
      <div className="max-w-4xl">
        <Breadcrumbs items={crumbs} />
        {templates.isLoading ? <Loading /> : (
          <EmptyState title="Template not found" action={<Link to="/apps/new"><Button>Choose another</Button></Link>}>
            {templates.error ? String((templates.error as Error).message) : `There is no template named “${templateId ?? ''}”.`}
          </EmptyState>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-4xl">
      <Breadcrumbs items={crumbs} />
      <PageHeader title={`New ${kind === 'template' ? (template!.kind === 'database' ? 'database' : 'service') : 'application'}`}
        subtitle={kind === 'template' ? `${title} from a template. Review the settings below, then create.` : `${title}. Fill in the settings below, then create.`} />
      <ResourceForm key={`${kind}-${isPrivate}-${template?.id ?? ''}`} kind={kind} isPrivate={isPrivate} template={template}
        servers={serverList} defaultServerId={params.get('server')} />
    </div>
  );
}
