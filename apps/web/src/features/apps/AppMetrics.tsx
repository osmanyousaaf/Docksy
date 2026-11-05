/** Metrics tab: container CPU / memory / network for one app (GET /apps/:id/metrics). Monochrome charts. */
import { useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { App, ContainerMetricPoint, MetricsRange } from '@docksy/shared';
import { useApi } from '../../lib/api.ts';
import { bytes, pct, rate } from '../../lib/format.ts';
import { Card, EmptyState, ErrorBox, Meter, Spinner } from '../../components/ui.tsx';
import { Segmented } from './components.tsx';

const RANGES: MetricsRange[] = ['15m', '1h', '6h', '24h', '7d'];
const GRID = '#1f1f1f';
const AXIS = { fill: '#5c5c5c', fontSize: 11 };

function fmtTime(ts: string, range: MetricsRange) {
  const d = new Date(ts);
  return range === '7d' || range === '30d'
    ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

interface Series { key: string; label: string; color: string }

function Chart({ data, series, format, axis, range, limit }: {
  data: object[]; series: Series[]; format: (n: number) => string; axis?: (n: number) => string; range: MetricsRange; limit?: { y: number; label: string };
}) {
  return (
    <div className="h-52">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="ts" tickFormatter={(t) => fmtTime(t, range)} tick={AXIS} axisLine={{ stroke: GRID }} tickLine={false} minTickGap={48} />
          <YAxis tickFormatter={(v) => (axis ?? format)(Number(v))} tick={AXIS} axisLine={false} tickLine={false} width={60}
            domain={limit ? [0, (max: number) => Math.max(max, limit.y) * 1.05] : [0, 'auto']} />
          <Tooltip
            cursor={{ stroke: '#333' }}
            contentStyle={{ background: '#121212', border: '1px solid #333', borderRadius: 6, fontSize: 12, padding: '6px 10px' }}
            labelStyle={{ color: '#8f8f8f', marginBottom: 2 }} itemStyle={{ color: '#ededed', padding: 0 }}
            labelFormatter={(t) => new Date(String(t)).toLocaleString()}
            formatter={(v, name) => [format(Number(v)), series.find((s) => s.key === name)?.label ?? String(name)]} />
          {limit && <ReferenceLine y={limit.y} stroke="#333" strokeDasharray="4 4" label={{ value: limit.label, position: 'insideTopRight', fill: '#5c5c5c', fontSize: 11 }} />}
          {series.map((s) => (
            <Area key={s.key} type="monotone" dataKey={s.key} name={s.key} stroke={s.color} strokeWidth={1.5} fill={s.color} fillOpacity={0.06}
              isAnimationActive={false} dot={false} activeDot={{ r: 3, strokeWidth: 0, fill: s.color }} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function Legend({ series }: { series: Series[] }) {
  return (
    <span className="flex items-center gap-4 text-xs font-normal text-muted">
      {series.map((s) => <span key={s.key} className="flex items-center gap-1.5"><span className="h-0.5 w-3" style={{ background: s.color }} />{s.label}</span>)}
    </span>
  );
}

function Tile({ label, value, sub, meter }: { label: string; value: string; sub?: string; meter?: number }) {
  return (
    <div className="rounded-md border border-border bg-surface px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {meter !== undefined && <Meter value={meter} className="mt-2" />}
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const peak = (xs: number[]) => (xs.length ? Math.max(...xs) : null);

export function MetricsTab({ app }: { app: App }) {
  const [range, setRange] = useState<MetricsRange>('1h');
  const { data, isLoading, error } = useApi<{ points: ContainerMetricPoint[] }>(`/apps/${encodeURIComponent(app.id)}/metrics?range=${range}`, {
    refetchInterval: range === '15m' || range === '1h' ? 15_000 : 60_000,
  });
  const points = useMemo(() => data?.points ?? [], [data]);
  const last = points[points.length - 1];
  const memLimit = app.memLimitMb ? app.memLimitMb * 1024 * 1024 : null;
  const cpu = points.map((p) => p.cpu);
  const mem = points.map((p) => p.memUsed);

  const cpuS: Series[] = [{ key: 'cpu', label: 'CPU', color: 'var(--color-cpu)' }];
  const memS: Series[] = [{ key: 'memUsed', label: 'Memory', color: 'var(--color-mem)' }];
  const netS: Series[] = [{ key: 'netRx', label: 'Received', color: 'var(--color-net-rx)' }, { key: 'netTx', label: 'Sent', color: 'var(--color-net-tx)' }];

  return (
    <section>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Metrics</h2>
        <Segmented options={RANGES.map((r) => ({ id: r, label: r }))} value={range} onChange={setRange} />
      </div>
      <p className="mb-5 text-sm text-muted">Container resource usage, reported by the server’s agent every few seconds.</p>
      {isLoading ? (
        <div className="grid h-64 place-items-center"><Spinner /></div>
      ) : error ? <ErrorBox error={error} /> : points.length === 0 ? (
        <EmptyState title="No metrics for this range">They appear once the container is running and the server’s agent reports in.</EmptyState>
      ) : (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="CPU" value={pct(last?.cpu, 1)} sub={`avg ${pct(avg(cpu), 1)} · peak ${pct(peak(cpu), 1)}${app.cpuLimit ? ` · limit ${app.cpuLimit} cores` : ''}`} />
            <Tile label="Memory" value={bytes(last?.memUsed)} meter={memLimit && last ? (last.memUsed / memLimit) * 100 : undefined}
              sub={memLimit ? `of ${bytes(memLimit)} limit · peak ${bytes(peak(mem))}` : `no limit · peak ${bytes(peak(mem))}`} />
            <Tile label="Network in" value={rate(last?.netRx)} sub={`avg ${rate(avg(points.map((p) => p.netRx)))}`} />
            <Tile label="Network out" value={rate(last?.netTx)} sub={`avg ${rate(avg(points.map((p) => p.netTx)))}`} />
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <Card title="CPU usage" actions={<Legend series={cpuS} />}>
              <Chart data={points} series={cpuS} format={(n) => pct(n, 2)} axis={(n) => pct(n, n < 1 ? 1 : 0)} range={range} />
            </Card>
            <Card title="Memory usage" actions={<Legend series={memS} />}>
              <Chart data={points} series={memS} format={(n) => bytes(n)} axis={(n) => bytes(n, 0)} range={range}
                limit={memLimit ? { y: memLimit, label: `limit ${bytes(memLimit, 0)}` } : undefined} />
            </Card>
            <Card className="xl:col-span-2" title="Network" actions={<Legend series={netS} />}>
              <Chart data={points} series={netS} format={(n) => rate(n)} axis={(n) => bytes(n, 0)} range={range} />
            </Card>
          </div>
        </>
      )}
    </section>
  );
}
