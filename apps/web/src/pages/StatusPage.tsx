/** Public status page (no layout, no auth): GET /public/status. Formal gray, green/red for status only. */
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { PublicStatus } from '@docksy/shared';
import { ApiError, useApi } from '../lib/api.ts';
import { timeAgo } from '../lib/format.ts';
import { Loading, StatusDot } from '../components/ui.tsx';
import { DayStrip } from '../features/admin/kit.tsx';

const OVERALL = {
  operational: { text: 'All systems operational', tone: 'ok', cls: 'text-ok' },
  degraded: { text: 'Some systems are degraded', tone: 'warn', cls: 'text-warn' },
  down: { text: 'Major outage', tone: 'bad', cls: 'text-bad' },
} as const;

const STATUS = {
  up: { text: 'Operational', tone: 'ok', cls: 'text-ok' },
  down: { text: 'Down', tone: 'bad', cls: 'text-bad' },
  unknown: { text: 'No data', tone: 'neutral', cls: 'text-muted' },
} as const;

function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((n) => n + 1), ms); return () => clearInterval(t); }, [ms]);
}

export default function StatusPage() {
  const { data, error, isLoading } = useApi<PublicStatus>('/public/status', { refetchInterval: 60_000, retry: false });
  useTick(30_000);
  useEffect(() => { if (data?.title) document.title = data.title; }, [data?.title]);

  const disabled = error instanceof ApiError && error.status === 404;
  const o = data ? OVERALL[data.overall] : null;

  return (
    <div className="min-h-full bg-bg">
      <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
        <header className="mb-8 border-b border-border pb-6">
          <h1 className="text-xl font-semibold">{data?.title ?? (isLoading ? '' : 'Status')}</h1>
          {data && <p className="mt-1 text-sm text-muted">Updated {timeAgo(data.updatedAt)}. Refreshes every minute.</p>}
        </header>

        {isLoading && <Loading />}

        {disabled && (
          <div className="py-10">
            <h2 className="font-semibold">This status page is not public</h2>
            <p className="mt-1 text-sm text-muted">The owner can enable it in Docksy under Settings → Status Page.</p>
          </div>
        )}
        {error && !disabled && <p className="py-6 text-sm text-bad">The status could not be loaded. Retrying every minute.</p>}

        {data && o && (
          <>
            <div className="mb-10 flex items-center gap-3 rounded-md border border-border bg-surface px-4 py-3.5">
              <StatusDot tone={o.tone} className="size-2.5" />
              <span className={clsx('font-medium', o.cls)}>{o.text}</span>
            </div>

            {data.checks.length === 0 ? (
              <p className="text-sm text-muted">No services are listed yet.</p>
            ) : (
              <>
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="text-lg font-semibold">Services</h2>
                  <span className="text-xs text-muted">Uptime over the last 90 days</span>
                </div>
                <div className="divide-y divide-border rounded-md border border-border">
                  {data.checks.map((c) => {
                    const s = STATUS[c.status];
                    return (
                      <section key={c.name} className="px-4 py-4">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <h3 className="min-w-0 truncate font-medium">{c.name}</h3>
                          <div className="flex shrink-0 items-center gap-4 text-sm">
                            {c.uptime90d != null && <span className="hidden tabular-nums text-muted sm:inline">{c.uptime90d.toFixed(2)}%</span>}
                            <span className={clsx('inline-flex items-center gap-1.5', s.cls)}><StatusDot tone={s.tone} />{s.text}</span>
                          </div>
                        </div>
                        <DayStrip days={c.days} height={28} legend />
                        {c.uptime90d != null && <p className="mt-1 text-xs tabular-nums text-muted sm:hidden">{c.uptime90d.toFixed(2)}% uptime</p>}
                      </section>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}

        <footer className="mt-12 border-t border-border pt-4 text-xs text-muted">
          Powered by <a href="https://github.com/osmanyousaaf/docksy" target="_blank" rel="noreferrer" className="text-fg hover:underline">Docksy</a>
        </footer>
      </div>
    </div>
  );
}
