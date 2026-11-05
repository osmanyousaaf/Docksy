/** Shared hooks for the monitoring UI: motion, tweening, clipboard, live server metrics. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContainerInfo, LiveMetricsEvent, MetricPoint, MetricsRange, ServerMetrics } from '@docksy/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, useApi, useSSE, type ApiError } from '../../lib/api.ts';

// ───────────── motion ─────────────

const RM_QUERY = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  try { return typeof window !== 'undefined' && window.matchMedia(RM_QUERY).matches; } catch { return false; }
}

export function useReducedMotion(): boolean {
  const [rm, setRm] = useState(prefersReducedMotion);
  useEffect(() => {
    let mq: MediaQueryList;
    try { mq = window.matchMedia(RM_QUERY); } catch { return; }
    const on = () => setRm(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return rm;
}

const ease = (t: number) => 1 - Math.pow(1 - t, 3);

/** Smoothly animates a number toward `target` (instant when reduced motion is on). */
export function useTween(target: number, duration = 700): number {
  const rm = useReducedMotion();
  const [val, setVal] = useState(target);
  const from = useRef(target);
  const cur = useRef(target);
  useEffect(() => {
    if (rm || !isFinite(target)) { cur.current = target; setVal(target); return; }
    from.current = cur.current;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const v = from.current + (target - from.current) * ease(t);
      cur.current = v;
      setVal(v);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, rm]);
  return val;
}

// ───────────── clipboard ─────────────

export function useCopy(timeout = 1600): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback((text: string) => {
    const done = () => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), timeout);
    };
    try {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text) && done());
    } catch {
      if (fallbackCopy(text)) done();
    }
  }, [timeout]);
  return [copied, copy];
}

function fallbackCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

// ───────────── metrics ─────────────

export const RANGES: MetricsRange[] = ['15m', '1h', '6h', '24h', '7d', '30d'];
export const RANGE_MS: Record<MetricsRange, number> = {
  '15m': 15 * 60e3, '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3,
};
/** Ranges served from raw points: live SSE points are appended to these. */
const LIVE_RANGES = new Set<MetricsRange>(['15m', '1h', '6h']);

/** Kept for compatibility: MetricPoint now always carries load5/load15. */
export type MetricPointX = MetricPoint;

export interface ChartRow {
  t: number;
  cpu: number;
  load1: number;
  load5: number;
  load15: number;
  memUsed: number;
  memTotal: number;
  swapUsed: number;
  diskUsed: number;
  diskTotal: number;
  netRx: number;
  netTx: number;
}

export const toRow = (p: MetricPoint): ChartRow => ({
  t: new Date(p.ts).getTime(),
  cpu: p.cpu, load1: p.load1, load5: p.load5, load15: p.load15, memUsed: p.memUsed, memTotal: p.memTotal, swapUsed: p.swapUsed,
  diskUsed: p.diskUsed, diskTotal: p.diskTotal, netRx: p.netRx, netTx: p.netTx,
});

/**
 * Range history from /servers/:id/metrics merged with the live SSE stream.
 * Live points are appended to short ranges; gauges, cores and containers always follow the stream.
 */
export function useLiveServerMetrics(serverId: string | undefined, range: MetricsRange) {
  const history = useApi<ServerMetrics>(serverId ? `/servers/${serverId}/metrics?range=${range}` : null, {
    refetchInterval: LIVE_RANGES.has(range) ? 60_000 : 300_000,
    placeholderData: (prev) => (prev && prev.serverId === serverId ? prev : undefined),
  });
  const containersQ = useApi<{ items: ContainerInfo[] }>(serverId ? `/servers/${serverId}/containers` : null, { refetchInterval: 60_000 });

  const [live, setLive] = useState<MetricPoint[]>([]);
  const [perCore, setPerCore] = useState<number[]>([]);
  const [liveContainers, setLiveContainers] = useState<ContainerInfo[] | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);

  useEffect(() => { setLive([]); setPerCore([]); setLiveContainers(null); setLastEventAt(null); }, [serverId]);

  const sse = useSSE(serverId ? `/servers/${serverId}/metrics/live` : null, (ev, data: LiveMetricsEvent) => {
    if (ev !== 'metrics' || !data || typeof data !== 'object' || !data.point) return;
    setLive((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.ts >= data.point.ts) return prev;
      const next = [...prev, data.point];
      return next.length > 720 ? next.slice(next.length - 720) : next;
    });
    if (Array.isArray(data.perCore)) setPerCore(data.perCore);
    if (Array.isArray(data.containers)) setLiveContainers(data.containers);
    setLastEventAt(Date.now());
  }, ['metrics']);

  const points = useMemo(() => {
    const base = history.data?.points ?? [];
    if (!LIVE_RANGES.has(range)) return base;
    const lastTs = base.length ? base[base.length - 1].ts : '';
    const merged = base.concat(live.filter((p) => p.ts > lastTs));
    const cutoff = Date.now() - RANGE_MS[range];
    return merged.filter((p) => new Date(p.ts).getTime() >= cutoff);
  }, [history.data, live, range]);

  const rows = useMemo(() => points.map(toRow), [points]);
  const latest: MetricPointX | null = live[live.length - 1] ?? history.data?.points.at(-1) ?? null;

  return {
    history,
    points,
    rows,
    latest,
    perCore,
    containers: liveContainers ?? containersQ.data?.items ?? [],
    containersLoading: containersQ.isLoading && !liveContainers,
    sse,
    lastEventAt,
  };
}

/** Load averages 1/5/15 straight from the latest point. `points` and `approx` are kept for compatibility. */
export function loadAverages(latest: MetricPoint | null, _points?: MetricPoint[]): { l1: number | null; l5: number | null; l15: number | null; approx: boolean } {
  if (!latest) return { l1: null, l5: null, l15: null, approx: false };
  return { l1: latest.load1, l5: latest.load5 ?? null, l15: latest.load15 ?? null, approx: false };
}

/** Re-render every `ms` (for "x seconds ago" labels). */
export function useNow(ms = 5000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * Mutation that calls the API with an explicit method/path/body per call (no stray bodies on DELETE/ack),
 * then invalidates queries whose key starts with any of the given path prefixes.
 */
export function useAction<V>(build: (v: V) => { method: string; path: string; body?: unknown }, invalidate: string[] = []) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, V>({
    mutationFn: (v) => { const r = build(v); return api(r.path, { method: r.method, body: r.body }); },
    onSuccess: () => {
      for (const p of invalidate) qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith(p) });
    },
  });
}
