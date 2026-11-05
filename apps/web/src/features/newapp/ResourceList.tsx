/** Step 1 of "New resource": plain bordered rows grouped by Applications / Databases / Services. */
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { AppWindow, Box, ChevronRight, Database, GitBranch, Lock } from 'lucide-react';
import type { Template } from '@docksy/shared';
import { ErrorBox, Loading } from '../../components/ui.tsx';

export interface Choice { key: string; to: string; name: string; description: string; icon: ReactNode }

const APPLICATIONS: Choice[] = [
  { key: 'git-public', to: '?type=git', name: 'Public Git repository', description: 'Build and deploy any public repository from GitHub, GitLab or another Git host.', icon: <GitBranch /> },
  { key: 'git-private', to: '?type=git&private=1', name: 'Private Git repository', description: 'Deploy a private repository using a read-only access token.', icon: <Lock /> },
  { key: 'image', to: '?type=image', name: 'Docker Image', description: 'Run an existing image from Docker Hub, GHCR or any registry.', icon: <Box /> },
];

const DB_ORDER = ['postgres', 'mysql', 'mariadb', 'redis', 'mongodb'];
const SERVICE_ORDER = ['n8n', 'uptime-kuma', 'umami', 'minio', 'ghost', 'wordpress'];
const rank = (order: string[], id: string) => (order.indexOf(id) === -1 ? 99 : order.indexOf(id));

/** First sentence of a template description, for the one-line row. */
const firstSentence = (s: string) => s.match(/^.*?[.!?](\s|$)/)?.[0].trim() ?? s;

export function ResourceList({ templates, loading, error }: { templates?: Template[]; loading: boolean; error: unknown }) {
  const dbs = (templates ?? []).filter((t) => t.kind === 'database').sort((a, b) => rank(DB_ORDER, a.id) - rank(DB_ORDER, b.id));
  const services = (templates ?? []).filter((t) => t.kind !== 'database').sort((a, b) => rank(SERVICE_ORDER, a.id) - rank(SERVICE_ORDER, b.id));
  const toChoice = (t: Template, icon: ReactNode): Choice => ({
    key: t.id, to: `?type=template&template=${encodeURIComponent(t.id)}`, name: t.name, description: firstSentence(t.description), icon,
  });
  return (
    <div>
      <Group title="Applications" description="Deploy your own code or a prebuilt container image." items={APPLICATIONS} />
      {loading ? <Loading label="Loading templates…" /> : error ? <ErrorBox error={error} /> : (
        <>
          <Group title="Databases" description="Private by default, reachable from your other apps on the docksy network." items={dbs.map((t) => toChoice(t, <Database />))} />
          <Group title="Services" description="Popular open-source services, preconfigured and ready to deploy." items={services.map((t) => toChoice(t, <AppWindow />))} />
        </>
      )}
    </div>
  );
}

function Group({ title, description, items }: { title: string; description: string; items: Choice[] }) {
  if (items.length === 0) return null;
  return (
    <section className="mb-10">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mb-4 text-sm text-muted">{description}</p>
      <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
        {items.map((c) => (
          <li key={c.key}>
            <Link to={c.to} className="group flex items-center gap-4 px-4 py-3 transition-colors duration-150 hover:bg-surface">
              <span className="text-muted [&>svg]:size-4">{c.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-fg">{c.name}</span>
                <span className="block truncate text-xs text-muted">{c.description}</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-faint group-hover:text-fg" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
