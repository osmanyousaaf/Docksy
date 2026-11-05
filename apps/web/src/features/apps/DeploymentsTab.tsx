/** Deployment history table + rollback modal. */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { GitCommitHorizontal, History, ScrollText, Undo2 } from 'lucide-react';
import type { App, Deployment } from '@docksy/shared';
import { duration, timeAgo } from '../../lib/format.ts';
import { Badge, Button, EmptyState, ErrorBox, Loading, Status, Table } from '../../components/ui.tsx';
import { Modal, useTick } from './components.tsx';
import { appActions, isActive, rollbackTargets, shortId, shortSha, useAction } from './hooks.ts';

const TRIGGER_LABEL: Record<Deployment['trigger'], string> = { manual: 'Manual', webhook: 'Git push', rollback: 'Rollback', api: 'API', mcp: 'Claude (MCP)' };

export function DeploymentRow({ d, app, onRollback }: { d: Deployment; app: App; onRollback?: (d: Deployment) => void }) {
  const current = app.currentDeploymentId === d.id;
  const canRollback = !!onRollback && d.status === 'succeeded' && !!d.imageTag && !current;
  const title = d.commitMessage ?? (d.trigger === 'rollback' ? 'Rollback' : app.sourceType === 'image' ? (app.image ?? 'Image') : 'Deployment');
  return (
    <tr className="hover:bg-surface-2/40">
      <td className="whitespace-nowrap">
        <div className="flex items-center gap-2">
          <Status status={d.status} />
          {current && <Badge>Current</Badge>}
        </div>
      </td>
      <td className="max-w-0 w-[40%]">
        <Link to={`/deployments/${d.id}`} className="group block min-w-0">
          <div className="truncate group-hover:underline">{title}</div>
          <div className="mt-0.5 flex items-center gap-3 font-mono text-xs text-muted">
            {d.commitSha && <span className="flex items-center gap-1"><GitCommitHorizontal className="size-3" />{shortSha(d.commitSha)}</span>}
            {d.imageTag && <span className="truncate">{d.imageTag}</span>}
            {!d.commitSha && !d.imageTag && <span>#{shortId(d.id)}</span>}
          </div>
          {d.status === 'failed' && d.error && <div className="mt-0.5 truncate text-xs text-bad">{d.error}</div>}
        </Link>
      </td>
      <td className="whitespace-nowrap text-muted">{TRIGGER_LABEL[d.trigger] ?? d.trigger}</td>
      <td className="whitespace-nowrap text-muted" title={new Date(d.createdAt).toLocaleString()}>{timeAgo(d.createdAt)}</td>
      <td className="whitespace-nowrap font-mono text-xs text-muted">{d.startedAt ? duration(d.startedAt, d.finishedAt) : '—'}</td>
      <td className="whitespace-nowrap text-right">
        <div className="flex justify-end gap-1">
          <Link to={`/deployments/${d.id}`}><Button size="sm" variant="ghost" icon={<ScrollText className="size-3.5" />}>Logs</Button></Link>
          {canRollback && <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} onClick={() => onRollback!(d)}>Rollback</Button>}
        </div>
      </td>
    </tr>
  );
}

export function DeploymentsTable({ deps, app, onRollback }: { deps: Deployment[]; app: App; onRollback?: (d: Deployment) => void }) {
  useTick(deps.some((d) => isActive(d.status)));
  return (
    <Table>
      <thead>
        <tr>
          <th>Status</th>
          <th>{app.sourceType === 'image' ? 'Image' : 'Commit'}</th>
          <th>Trigger</th>
          <th>Created</th>
          <th>Duration</th>
          <th className="!text-right">Actions</th>
        </tr>
      </thead>
      <tbody>{deps.map((d) => <DeploymentRow key={d.id} d={d} app={app} onRollback={onRollback} />)}</tbody>
    </Table>
  );
}

/** Rollback confirmation. With `target` it confirms that one; without, lets the user pick. */
export function RollbackModal({ app, deps, open, onClose, target }: { app: App; deps: Deployment[]; open: boolean; onClose: () => void; target?: Deployment | null }) {
  const options = rollbackTargets(deps, app.currentDeploymentId);
  const [picked, setPicked] = useState<string | null>(null);
  const navigate = useNavigate();
  const sel = target ?? options.find((d) => d.id === picked) ?? options[0] ?? null;
  const rollback = useAction((depId: string) => appActions.rollback(app.id, depId));
  return (
    <Modal open={open} onClose={onClose} title={`Roll back ${app.name}`}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon={<Undo2 className="size-4" />} disabled={!sel} loading={rollback.isPending}
          onClick={() => sel && rollback.mutate(sel.id, { onSuccess: (d) => { onClose(); navigate(`/deployments/${d.id}`); } })}>
          Roll back
        </Button>
      </>}>
      {options.length === 0 && !target ? (
        <p className="text-sm text-muted">There is no earlier successful deployment with a saved image yet.</p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted">Docksy restarts the app from the saved image, with zero downtime. No rebuild needed.</p>
          {target ? (
            <RollbackOption d={target} checked />
          ) : (
            <div className="space-y-1.5">
              {options.slice(0, 8).map((d) => (
                <button key={d.id} type="button" className="block w-full text-left" onClick={() => setPicked(d.id)}>
                  <RollbackOption d={d} checked={sel?.id === d.id} />
                </button>
              ))}
            </div>
          )}
          <ErrorBox error={rollback.error} />
        </div>
      )}
    </Modal>
  );
}

function RollbackOption({ d, checked }: { d: Deployment; checked: boolean }) {
  return (
    <div className={`flex items-center gap-3 rounded-md border px-3 py-2.5 transition-colors cursor-pointer ${checked ? 'border-muted bg-surface-2' : 'border-border hover:border-border-strong'}`}>
      <span className={`size-3.5 shrink-0 rounded-full border-2 ${checked ? 'border-fg bg-fg' : 'border-border-strong'}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{d.commitMessage ?? d.imageTag}</div>
        <div className="font-mono text-xs text-muted">{shortSha(d.commitSha) ?? shortId(d.id)} · {timeAgo(d.finishedAt ?? d.createdAt)}</div>
      </div>
    </div>
  );
}

export function DeploymentsTab({ app, deps, loading, error }: { app: App; deps: Deployment[]; loading: boolean; error: unknown }) {
  const [target, setTarget] = useState<Deployment | null>(null);
  const ok = deps.filter((d) => d.status === 'succeeded').length;
  return (
    <section>
      <div className="mb-1 flex flex-wrap items-baseline gap-3">
        <h2 className="text-lg font-semibold">Deployments</h2>
        {deps.length > 0 && <span className="text-sm text-muted">{deps.length} total · {ok} succeeded</span>}
      </div>
      <p className="mb-5 text-sm text-muted">Every build and release of this app. Roll back to any earlier successful deployment that still has its image.</p>
      {loading ? <Loading /> : error ? <ErrorBox error={error} /> : deps.length === 0
        ? <EmptyState icon={<History className="size-8" />} title="No deployments yet">Use Deploy to ship the first version.</EmptyState>
        : <DeploymentsTable deps={deps} app={app} onRollback={setTarget} />}
      <RollbackModal app={app} deps={deps} open={!!target} target={target} onClose={() => setTarget(null)} />
    </section>
  );
}
