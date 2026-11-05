/** Diagnose: runs the deterministic /diagnose report and renders it as a formal list, plus a copyable Claude prompt. */
import { useState } from 'react';
import clsx from 'clsx';
import { RefreshCw, Stethoscope, X } from 'lucide-react';
import type { DiagnoseFinding, DiagnoseReport, Severity } from '@docksy/shared';
import { api, ApiError } from '../../lib/api.ts';
import { Button, ErrorBox, StatusDot } from '../../components/ui.tsx';
import { timeAgo } from '../../lib/format.ts';
import { CopyButton, CopyField, SeverityBadge, Skeleton } from './components.tsx';

const ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export function diagnosePrompt(target: string): string {
  return `Use /docksy:diagnose ${target}`;
}

/** State for the diagnose panel. Render <DiagnosePanel> where you want the results. */
export function useDiagnose(query: { serverId?: string; appId?: string }) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<DiagnoseReport | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const run = async () => {
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (query.serverId) qs.set('serverId', query.serverId);
      if (query.appId) qs.set('appId', query.appId);
      setReport(await api<DiagnoseReport>(`/diagnose?${qs}`));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };
  return { open, setOpen, report, error, loading, run };
}

export function DiagnoseButton({ onClick, loading }: { onClick: () => void; loading?: boolean }) {
  return (
    <Button variant="secondary" onClick={onClick} loading={loading} icon={<Stethoscope className="size-4 text-muted" />}>
      Diagnose
    </Button>
  );
}

function Finding({ f }: { f: DiagnoseFinding }) {
  const actionText = f.action ? `${f.action.tool}(${JSON.stringify(f.action.args)})` : '';
  return (
    <li className="grid gap-x-6 gap-y-2 border-t border-border px-4 py-4 first:border-t-0 md:grid-cols-[120px_minmax(0,1fr)]">
      <div className="pt-0.5"><SeverityBadge severity={f.severity} /></div>
      <div className="min-w-0">
        <h4 className="text-sm font-medium">{f.title}</h4>
        {f.detail && <p className="mt-0.5 text-sm text-muted">{f.detail}</p>}
        {f.evidence.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-xs text-muted">Evidence</div>
            <ul className="dx-scroll max-h-48 space-y-0.5 overflow-auto rounded-md border border-border bg-bg px-3 py-2 font-mono text-[11px] leading-relaxed text-fg/85">
              {f.evidence.map((e, i) => <li key={i} className="whitespace-pre-wrap break-words">{e}</li>)}
            </ul>
          </div>
        )}
        {f.suggestion && (
          <div className="mt-3">
            <div className="mb-0.5 text-xs text-muted">Suggestion</div>
            <p className="text-sm">{f.suggestion}</p>
          </div>
        )}
        {f.action && (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-bg px-3 py-1.5">
            <span className="shrink-0 text-xs text-muted">Fix</span>
            <code className="dx-scroll min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[11px]">{actionText}</code>
            <CopyButton text={actionText} />
          </div>
        )}
      </div>
    </li>
  );
}

export function DiagnosePanel({ state, target, onClose }: { state: ReturnType<typeof useDiagnose>; target: string; onClose?: () => void }) {
  const { report, error, loading, run } = state;
  const findings = report ? [...report.findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]) : [];
  const counts = { critical: 0, warning: 0, info: 0 } as Record<Severity, number>;
  findings.forEach((f) => counts[f.severity]++);
  const notFound = error instanceof ApiError && error.status === 404;

  return (
    <section className="mb-8 rounded-md border border-border bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold">Diagnosis</h3>
          <p className="text-xs text-muted">Deterministic checks over metrics, alerts, containers and deployments{report ? ` · ${timeAgo(report.generatedAt)}` : ''}.</p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={run} loading={loading} icon={<RefreshCw className="size-3.5" />}>Re-run</Button>
          {onClose && <button type="button" onClick={onClose} aria-label="Close diagnosis" className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg cursor-pointer"><X className="size-4" /></button>}
        </div>
      </header>

      {loading && !report && <div className="space-y-2 p-4"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-16 w-full" /></div>}
      {error != null && <div className="p-4"><ErrorBox error={notFound ? "Diagnose isn't available on this Docksy server yet." : error} /></div>}

      {report && (
        <>
          <div className="flex flex-wrap items-start gap-x-6 gap-y-2 border-b border-border px-4 py-3">
            <div className="flex min-w-0 flex-1 items-start gap-2.5">
              <StatusDot tone={report.healthy ? 'ok' : counts.critical ? 'bad' : 'warn'} className="mt-1.5" />
              <div className="min-w-0">
                <div className="text-sm font-medium">{report.healthy ? 'Everything looks healthy' : 'Something needs attention'}</div>
                <p className="mt-0.5 text-sm text-muted">{report.summary}</p>
              </div>
            </div>
            <div className="flex gap-4 text-xs text-muted tabular-nums">
              <span><span className={clsx(counts.critical && 'text-bad')}>{counts.critical}</span> critical</span>
              <span><span className={clsx(counts.warning && 'text-warn')}>{counts.warning}</span> warning</span>
              <span>{counts.info} info</span>
            </div>
          </div>
          {report.context.trend1h && (
            <dl className="grid grid-cols-2 border-b border-border text-xs sm:grid-cols-4">
              {([
                ['CPU avg (1h)', report.context.trend1h.cpuAvg], ['CPU max (1h)', report.context.trend1h.cpuMax],
                ['Memory avg (1h)', report.context.trend1h.memAvgPct], ['Memory max (1h)', report.context.trend1h.memMaxPct],
              ] as const).map(([k, v]) => (
                <div key={k} className="px-4 py-2.5">
                  <dt className="text-muted">{k}</dt>
                  <dd className="mt-0.5 text-sm font-medium tabular-nums">{v.toFixed(0)}%</dd>
                </div>
              ))}
            </dl>
          )}
          <ul>
            {findings.map((f, i) => <Finding key={i} f={f} />)}
            {findings.length === 0 && <li className="px-4 py-4 text-sm text-muted">No findings.</li>}
          </ul>
        </>
      )}

      <div className="border-t border-border px-4 py-3">
        <div className="mb-2 text-xs text-muted">To go deeper, ask Claude Code. It can read metrics and logs, then propose a fix:</div>
        <CopyField value={diagnosePrompt(target)} prompt="›" />
      </div>
    </section>
  );
}
