// Deployment detail: breadcrumbs, status, facts and the build log (live via SSE). See apps/web/DESIGN.md.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, Ban, Download, RotateCw, Undo2 } from 'lucide-react';
import type { Deployment, DeploymentStatus, LogLine } from '@docksy/shared';
import { useApi, useSSE } from '../lib/api.ts';
import { duration, timeAgo } from '../lib/format.ts';
import { Breadcrumbs, Button, Callout, EmptyState, ErrorBox, Loading, Status, StatusDot, cx } from '../components/ui.tsx';
import { LogTerminal, downloadLog } from '../features/newapp/LogTerminal.tsx';
import { actions, isActive, shortId, shortSha, useAction, useApp } from '../features/newapp/data.ts';

const MAX_LINES = 20_000;
const TRIGGERS: Record<string, string> = { manual: 'Manual', webhook: 'Git push', rollback: 'Rollback', api: 'API', mcp: 'Claude (MCP)' };

export default function DeploymentDetail() {
  const { id } = useParams();
  // keyed so moving to another deployment (after Redeploy / Roll back) starts with a fresh log
  return <DeploymentView key={id} id={id} />;
}

/** Ticks once a second while `on`, so durations of running deployments update. */
function useTick(on: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

/** Line buffer with de-duplication (the stream replays earlier lines) and one render per animation frame. */
function useLines() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const seen = useRef(new Set<string>());
  const pending = useRef<LogLine[]>([]);
  const frame = useRef<number | null>(null);
  const flush = useCallback(() => {
    frame.current = null;
    const add = pending.current;
    pending.current = [];
    setLines((prev) => { const next = prev.concat(add); return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next; });
  }, []);
  const push = useCallback((l: LogLine) => {
    const k = `${l.ts}|${l.stream}|${l.line}`;
    if (seen.current.has(k)) return;
    seen.current.add(k);
    pending.current.push(l);
    if (frame.current == null) frame.current = requestAnimationFrame(flush);
  }, [flush]);
  const replace = useCallback((all: LogLine[]) => {
    seen.current = new Set(all.map((l) => `${l.ts}|${l.stream}|${l.line}`));
    pending.current = [];
    setLines(all.slice(-MAX_LINES));
  }, []);
  useEffect(() => () => { if (frame.current != null) cancelAnimationFrame(frame.current); }, []);
  return { lines, push, replace };
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 truncate text-sm text-fg">{children}</dd>
    </div>
  );
}

function DeploymentView({ id }: { id: string | undefined }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const dq = useApi<Deployment>(id ? `/deployments/${encodeURIComponent(id)}` : null, {
    refetchInterval: (q) => (isActive(q.state.data?.status) ? 5000 : false),
  });
  const d = dq.data;
  const app = useApp(d?.appId);
  const [live, setLive] = useState<{ status: DeploymentStatus; error: string | null } | null>(null);
  const status = live?.status ?? d?.status;
  const error = live ? live.error : d?.error ?? null;
  const active = isActive(status);
  useTick(active);

  const { lines, push, replace } = useLines();
  const [follow, setFollow] = useState(true);

  // Stream while the deployment runs (the stream replays earlier lines); once finished, load the complete log once.
  const streamPath = d && active ? `/deployments/${encodeURIComponent(d.id)}/logs/stream` : null;
  const staticLogs = useApi<{ items: LogLine[] }>(d && status && !active ? `/deployments/${encodeURIComponent(d.id)}/logs` : null);
  useEffect(() => { if (staticLogs.data) replace(staticLogs.data.items); }, [staticLogs.data, replace]);

  const conn = useSSE(streamPath, (event, data) => {
    if (event === 'log' && data && typeof data.line === 'string') push(data as LogLine);
    if (event === 'status' && data?.status) {
      setLive({ status: data.status, error: data.error ?? null });
      if (!isActive(data.status)) qc.invalidateQueries({ predicate: (q) => /^\/(deployments|apps)/.test(String(q.queryKey[0] ?? '')) });
    }
  }, ['log', 'status']);

  const cancel = useAction(() => actions.cancel(d!.id));
  const redeploy = useAction(() => actions.deploy(d!.appId));
  const rollback = useAction(() => actions.rollback(d!.appId, d!.id));

  if (dq.isLoading) return <Loading />;
  if (dq.error || !d) {
    return (
      <div>
        <Breadcrumbs items={[{ label: 'Apps', to: '/apps' }, { label: 'Deployment' }]} />
        <EmptyState title="Deployment not found" action={<Link to="/apps"><Button>Back to apps</Button></Link>}>{dq.error?.message}</EmptyState>
      </div>
    );
  }

  const a = app.data;
  const ghRepo = a?.repoUrl?.match(/github\.com[/:]([^/]+\/[^/.]+)/)?.[1];
  const isCurrent = a?.currentDeploymentId === d.id;
  const canRollback = status === 'succeeded' && !!d.imageTag && !isCurrent;
  const rollbackTitle = isCurrent ? 'This deployment is already live' : !d.imageTag ? 'No image was kept for this deployment' : status !== 'succeeded' ? 'Only successful deployments can be restored' : 'Run this deployment’s image again';
  const started = d.startedAt ?? d.createdAt;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Breadcrumbs items={[
          { label: 'Apps', to: '/apps' },
          { label: a?.name ?? 'App', to: a ? `/apps/${a.id}` : undefined },
          { label: <>Deployment <span className="font-mono">#{shortId(d.id)}</span></> },
        ]} />
        {status && <Status status={status} className="mb-2" />}
      </div>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5 pt-2">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">Deployment <span className="font-mono text-muted">#{shortId(d.id)}</span></h1>
          <p className="mt-1 text-sm text-muted">
            {isCurrent ? 'This deployment is live.' : active ? 'In progress. The log updates as it runs.' : `Created ${timeAgo(d.createdAt)}.`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {active && (
            <Button variant="danger" icon={<Ban className="size-4" />} loading={cancel.isPending}
              onClick={() => { if (confirm('Cancel this deployment? The current version keeps running.')) cancel.mutate(undefined, { onSuccess: () => setLive({ status: 'cancelled', error: null }) }); }}>
              Cancel
            </Button>
          )}
          <Button icon={<RotateCw className="size-4" />} loading={redeploy.isPending} disabled={active}
            onClick={() => redeploy.mutate(undefined, { onSuccess: (n) => navigate(`/deployments/${n.id}`) })}>Redeploy</Button>
          <Button icon={<Undo2 className="size-4" />} loading={rollback.isPending} disabled={!canRollback} title={rollbackTitle}
            onClick={() => { if (confirm(`Roll back ${a?.name ?? 'the app'} to deployment #${shortId(d.id)}?`)) rollback.mutate(undefined, { onSuccess: (n) => navigate(`/deployments/${n.id}`) }); }}>
            Roll back
          </Button>
        </div>
      </div>

      <dl className="mb-6 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
        <Fact label="Trigger">{TRIGGERS[d.trigger] ?? d.trigger}</Fact>
        <Fact label="Commit">
          {d.commitSha ? (
            <span title={d.commitMessage ?? undefined}>
              {ghRepo
                ? <a href={`https://github.com/${ghRepo}/commit/${d.commitSha}`} target="_blank" rel="noreferrer" className="font-mono underline decoration-border-strong underline-offset-4 hover:decoration-fg">{shortSha(d.commitSha)}</a>
                : <span className="font-mono">{shortSha(d.commitSha)}</span>}
              {d.commitMessage && <span className="text-muted"> {d.commitMessage}</span>}
            </span>
          ) : <span className="text-faint">—</span>}
        </Fact>
        <Fact label="Image"><span className="font-mono text-[13px]" title={d.imageTag ?? undefined}>{d.imageTag ?? <span className="text-faint">—</span>}</span></Fact>
        <Fact label="Started"><span title={new Date(started).toLocaleString()}>{d.startedAt ? timeAgo(d.startedAt) : 'Waiting in queue'}</span></Fact>
        <Fact label="Duration"><span className="tabular-nums">{d.startedAt ? duration(d.startedAt, active ? null : d.finishedAt) : '—'}</span></Fact>
      </dl>

      {status === 'failed' && error && (
        <div className="mb-4">
          <Callout tone="bad">
            <div className="font-medium">Deployment failed</div>
            <div className="mt-1 font-mono text-xs text-fg/80">{error}</div>
            <div className="mt-1 text-xs text-muted">The previous version keeps running.</div>
          </Callout>
        </div>
      )}
      {(cancel.error || redeploy.error || rollback.error || staticLogs.error) && (
        <div className="mb-4"><ErrorBox error={cancel.error ?? redeploy.error ?? rollback.error ?? staticLogs.error} /></div>
      )}

      <LogTerminal className="h-[62vh] min-h-80" lines={lines} follow={follow} onFollowChange={setFollow}
        empty={active ? (status === 'queued' ? 'Waiting for a free build slot…' : 'Waiting for output…') : staticLogs.isLoading ? 'Loading log…' : 'No log output was recorded.'}
        header={<>
          <span className="text-sm font-medium">Deployment log</span>
          <span className="text-xs text-muted">{lines.length} line{lines.length === 1 ? '' : 's'}</span>
          {streamPath && (
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <StatusDot tone={conn === 'open' ? 'ok' : conn === 'connecting' ? 'warn' : 'neutral'} className="size-1.5" />
              {conn === 'open' ? 'Live' : conn === 'connecting' ? 'Connecting' : 'Disconnected'}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Button size="sm" variant="ghost" className={cx(follow && 'text-fg')} icon={<ArrowDownToLine className="size-3.5" />}
              onClick={() => setFollow(!follow)} aria-pressed={follow} title="Keep the newest line in view">
              {follow ? 'Following' : 'Follow'}
            </Button>
            <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} disabled={lines.length === 0}
              onClick={() => downloadLog(`deployment-${shortId(d.id)}.log`, lines)}>Download</Button>
          </div>
        </>} />
    </div>
  );
}
