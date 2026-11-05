import { useState } from 'react';
import { Link } from 'react-router';
import { Plus, Search } from 'lucide-react';
import type { FleetOverview } from '@docksy/shared';
import { useApi } from '../lib/api.ts';
import { Button, EmptyState, ErrorBox, Input, PageHeader } from '../components/ui.tsx';
import { Skeleton } from '../features/monitoring/components.tsx';
import { FleetTable } from '../features/monitoring/FleetTable.tsx';
import { useNow } from '../features/monitoring/hooks.ts';

export default function Servers() {
  const { data, isLoading, error, refetch } = useApi<FleetOverview>('/overview', { refetchInterval: 10_000 });
  const [q, setQ] = useState('');
  useNow(10_000);
  const rows = (data?.servers ?? []).filter((s) => !q || `${s.server.name} ${s.server.host}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div>
      <PageHeader title="Servers"
        subtitle={data ? `Every VPS Docksy manages. ${data.totals.online} of ${data.totals.servers} online.` : 'Every VPS Docksy manages.'}
        actions={<Link to="/servers/new"><Button variant="primary" icon={<Plus className="size-4" />}>Add server</Button></Link>} />
      <ErrorBox error={error} retry={() => void refetch()} />
      {isLoading && <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>}
      {data && data.servers.length === 0 && (
        <EmptyState title="No servers yet"
          action={<Link to="/servers/new"><Button variant="primary" icon={<Plus className="size-4" />}>Add your first server</Button></Link>}>
          Connect any VPS over SSH. Docksy installs Docker, a proxy and a small metrics agent for you.
        </EmptyState>
      )}
      {data && data.servers.length > 0 && (
        <>
          {data.servers.length > 5 && (
            <div className="relative mb-4 max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter servers" className="pl-9" />
            </div>
          )}
          <FleetTable servers={rows} showLastSeen />
          {rows.length === 0 && <p className="mt-4 text-sm text-muted">No servers match “{q}”.</p>}
        </>
      )}
    </div>
  );
}
