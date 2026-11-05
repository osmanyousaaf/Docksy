/** Live containers table with plain CPU / memory bars, status text and app links. */
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';
import type { ContainerInfo } from '@docksy/shared';
import { Status } from '../../components/ui.tsx';
import { bytes, rate } from '../../lib/format.ts';
import { InlineBar } from './components.tsx';

type SortKey = 'name' | 'cpu' | 'mem';

/** Managed containers are named dx-<appName>-<deploy8> (CONTRACT §6). */
export function appNameFromContainer(name: string): string | null {
  const m = /^\/?dx-(.+)-[a-z0-9]{8}$/i.exec(name);
  return m ? m[1] : null;
}

export function ContainersTable({ containers, hostMem, loading }: { containers: ContainerInfo[]; hostMem?: number | null; loading?: boolean }) {
  const [sort, setSort] = useState<SortKey>('cpu');
  const rows = useMemo(() => {
    const xs = [...containers];
    const running = (c: ContainerInfo) => (c.state === 'running' ? 0 : 1);
    xs.sort((a, b) => running(a) - running(b)
      || (sort === 'name' ? a.name.localeCompare(b.name) : sort === 'cpu' ? b.cpuPercent - a.cpuPercent : b.memUsed - a.memUsed));
    return xs;
  }, [containers, sort]);

  if (!loading && containers.length === 0) {
    return <div className="px-4 py-10 text-center text-sm text-muted">No containers on this server yet. Deploy an app and it appears here.</div>;
  }

  const th = (k: SortKey | null, label: string, cls?: string) => (
    <th className={clsx('bg-surface px-4 py-2 text-left text-xs font-medium text-muted', cls)}>
      {k ? (
        <button type="button" onClick={() => setSort(k)} className={clsx('cursor-pointer hover:text-fg', sort === k && 'text-fg')}>{label}{sort === k ? ' ↓' : ''}</button>
      ) : label}
    </th>
  );

  return (
    <div className="dx-scroll overflow-x-auto">
      <table className="w-full min-w-[820px] text-sm">
        <thead>
          <tr>
            {th('name', 'Container')}
            {th(null, 'State')}
            {th('cpu', 'CPU', 'w-48')}
            {th('mem', 'Memory', 'w-52')}
            {th(null, 'Net in / out')}
            {th(null, 'Restarts', 'text-right')}
            {th(null, 'App', 'text-right')}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const limit = c.memLimit > 0 ? c.memLimit : hostMem ?? 0;
            const memPct = limit > 0 ? (c.memUsed / limit) * 100 : 0;
            const running = c.state === 'running';
            const app = appNameFromContainer(c.name);
            return (
              <tr key={c.id} className="border-t border-border transition-colors duration-150 hover:bg-surface/60">
                <td className="max-w-[280px] px-4 py-2.5">
                  <div className={clsx('truncate', running ? 'text-fg' : 'text-muted')}>{c.name}</div>
                  <div className="truncate font-mono text-[11px] text-faint" title={c.image}>{c.image}</div>
                </td>
                <td className="px-4 py-2.5">
                  <Status status={c.state} className="text-xs" />
                  <div className="mt-0.5 truncate text-[11px] text-faint">{c.status}</div>
                </td>
                <td className="px-4 py-2.5">
                  {running ? <InlineBar value={c.cpuPercent} label={`${c.cpuPercent.toFixed(1)}%`} /> : <span className="text-xs text-faint">—</span>}
                </td>
                <td className="px-4 py-2.5">
                  {running ? <InlineBar value={memPct} label={bytes(c.memUsed)} /> : <span className="text-xs text-faint">—</span>}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-xs tabular-nums text-muted">
                  {rate(c.netRx)}<span className="mx-1 text-faint">/</span>{rate(c.netTx)}
                </td>
                <td className={clsx('px-4 py-2.5 text-right text-xs tabular-nums', c.restartCount > 3 ? 'text-warn' : 'text-muted')}>{c.restartCount}</td>
                <td className="px-4 py-2.5 text-right text-xs">
                  {c.appId
                    ? <Link to={`/apps/${c.appId}`} className="text-fg underline-offset-2 hover:underline">{app ?? 'Open app'}</Link>
                    : <span className="text-faint">unmanaged</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
