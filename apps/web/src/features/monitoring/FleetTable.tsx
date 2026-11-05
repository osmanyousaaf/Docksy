/** Formal fleet table used by Overview and Servers: status dot, CPU/memory/disk numbers with thin bars, sparkline, apps. */
import { Link, useNavigate } from 'react-router';
import clsx from 'clsx';
import type { FleetOverview } from '@docksy/shared';
import { Status } from '../../components/ui.tsx';
import { bytes, ratio, timeAgo } from '../../lib/format.ts';
import { Sparkline } from '../../components/charts/Sparkline.tsx';
import { LiveDot } from './components.tsx';

export type FleetServer = FleetOverview['servers'][number];

function Usage({ value, detail }: { value: number | null; detail?: string }) {
  if (value == null) return <span className="text-xs text-faint">—</span>;
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="w-28">
      <div className="flex items-baseline justify-between gap-2">
        <span className={clsx('text-sm tabular-nums', v >= 90 ? 'text-bad' : 'text-fg')}>{v.toFixed(v < 10 ? 1 : 0)}%</span>
        {detail && <span className="truncate text-[11px] tabular-nums text-faint">{detail}</span>}
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3">
        <div className={clsx('h-full rounded-full', v >= 90 ? 'bg-bad' : 'bg-fg/60')} style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}

function serverStatus(s: FleetServer['server']): { status: string; label: string } {
  if (s.status !== 'ready') return { status: s.status === 'new' ? 'idle' : s.status, label: s.status === 'new' ? 'Not provisioned' : s.status.charAt(0).toUpperCase() + s.status.slice(1) };
  return { status: s.liveness, label: s.liveness === 'online' ? 'Online' : s.liveness === 'offline' ? 'Offline' : 'Unknown' };
}

export function FleetTable({ servers, showLastSeen }: { servers: FleetServer[]; showLastSeen?: boolean }) {
  const nav = useNavigate();
  return (
    <div className="dx-scroll overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[860px] text-sm">
        <thead>
          <tr className="bg-surface text-left text-xs text-muted">
            <th className="px-4 py-2 font-medium">Server</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">CPU</th>
            <th className="px-4 py-2 font-medium">Memory</th>
            <th className="px-4 py-2 font-medium">Disk</th>
            <th className="px-4 py-2 font-medium">CPU trend</th>
            <th className="px-4 py-2 text-right font-medium">Apps</th>
            {showLastSeen && <th className="px-4 py-2 text-right font-medium">Last seen</th>}
          </tr>
        </thead>
        <tbody>
          {servers.map(({ server: s, latest, spark, appsCount, firingAlerts }) => {
            const st = serverStatus(s);
            const mem = latest ? ratio(latest.memUsed, latest.memTotal) : null;
            const disk = latest ? ratio(latest.diskUsed, latest.diskTotal) : null;
            return (
              <tr key={s.id} onClick={() => nav(`/servers/${s.id}`)} className="cursor-pointer border-t border-border transition-colors duration-150 hover:bg-surface/60">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <LiveDot state={s.liveness} />
                    <div className="min-w-0">
                      <Link to={`/servers/${s.id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-fg hover:underline underline-offset-2">{s.name}</Link>
                      <div className="truncate font-mono text-[11px] text-muted">{s.host}{s.os ? ` · ${s.os}` : ''}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <Status status={st.status} label={st.label} />
                  {firingAlerts > 0 && <div className="mt-0.5 text-xs text-bad">{firingAlerts} firing alert{firingAlerts > 1 ? 's' : ''}</div>}
                </td>
                <td className="px-4 py-3"><Usage value={latest?.cpu ?? null} detail={s.cpuCores ? `${s.cpuCores} cores` : undefined} /></td>
                <td className="px-4 py-3"><Usage value={mem} detail={latest ? bytes(latest.memUsed) : undefined} /></td>
                <td className="px-4 py-3"><Usage value={disk} detail={latest ? bytes(latest.diskUsed, 0) : undefined} /></td>
                <td className="px-4 py-3">
                  {spark.length > 1
                    ? <div className="h-7 w-32"><Sparkline values={spark} max={Math.max(10, ...spark) * 1.15} height={28} color="#a3a3a3" strokeWidth={1.25} /></div>
                    : <span className="text-xs text-faint">—</span>}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-fg">{appsCount}</td>
                {showLastSeen && (
                  <td className={clsx('whitespace-nowrap px-4 py-3 text-right text-xs', s.liveness === 'offline' ? 'text-bad' : 'text-muted')}>
                    {s.lastSeenAt ? timeAgo(s.lastSeenAt) : 'never'}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
