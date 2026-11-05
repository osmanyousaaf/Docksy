/** Monochrome time-series chart (recharts): thin 1.5px lines, a flat ≤0.06 fill, a quiet grid and a plain tooltip. */
import { useMemo, type ReactNode } from 'react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export interface AreaSeries {
  key: string;
  label: string;
  color: string;
  /** 'line' draws no fill (e.g. a total/limit). */
  kind?: 'area' | 'line';
  dashed?: boolean;
}

export interface AreaMetricProps {
  /** Rows with a numeric `t` (unix ms) plus one numeric field per series key. */
  data: readonly { t: number }[];
  series: AreaSeries[];
  /** y-axis + tooltip value formatter */
  format?: (v: number) => string;
  height?: number;
  /** y domain, e.g. [0, 100] for percent */
  domain?: [number | 'auto' | 'dataMin' | 'dataMax', number | 'auto' | 'dataMin' | 'dataMax'];
  /** Span of the data in ms, used to choose tick labels. Defaults to data extent. */
  spanMs?: number;
  syncId?: string;
  /** Horizontal guide lines, e.g. alert thresholds. */
  guides?: { y: number; label?: string; color?: string }[];
  empty?: ReactNode;
  /** Compact formatter for y-axis ticks (defaults to `format`). */
  axisFormat?: (v: number) => string;
}

function tickFmt(span: number) {
  return (t: number) => {
    const d = new Date(t);
    if (span <= 36 * 3600e3) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
}

interface TipEntry { dataKey?: unknown; value?: unknown; color?: string }

function ChartTooltip({ active, payload, label, series, format }: { active?: boolean; payload?: readonly TipEntry[]; label?: unknown; series: AreaSeries[]; format: (v: number) => string }) {
  if (!active || !payload?.length) return null;
  const t = typeof label === 'number' ? label : Number(label);
  return (
    <div className="rounded-md border border-border-strong bg-surface px-3 py-2 text-xs">
      <div className="mb-1.5 text-[11px] text-muted">{isFinite(t) ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''}</div>
      {series.map((s) => {
        const e = payload.find((p) => p.dataKey === s.key);
        if (!e || typeof e.value !== 'number') return null;
        return (
          <div key={s.key} className="flex items-center justify-between gap-6 py-0.5">
            <span className="flex items-center gap-1.5 text-muted"><span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />{s.label}</span>
            <span className="font-medium tabular-nums">{format(e.value)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function AreaMetric({ data, series, format = (v) => v.toFixed(1), height = 180, domain = [0, 'auto'], spanMs, syncId, guides, empty, axisFormat }: AreaMetricProps) {
  const span = spanMs ?? (data.length > 1 ? data[data.length - 1].t - data[0].t : 3600e3);
  const fmtTick = useMemo(() => tickFmt(span), [span]);

  if (data.length === 0) {
    return (
      <div className="grid place-items-center rounded-md border border-dashed border-border text-xs text-muted" style={{ height }}>
        {empty ?? 'No data in this range yet'}
      </div>
    );
  }

  const axisTick = { fill: '#5c5c5c', fontSize: 11 };
  const pctTicks = domain[0] === 0 && domain[1] === 100 ? [0, 25, 50, 75, 100] : undefined;
  return (
    <div style={{ height }} className="-ml-2">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data as { t: number }[]} syncId={syncId} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#1f1f1f" vertical={false} />
          <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={fmtTick}
            tick={axisTick} tickLine={false} axisLine={{ stroke: '#1f1f1f' }} minTickGap={56} />
          <YAxis domain={domain} tickFormatter={(v: number) => (axisFormat ?? format)(v)} width={60}
            tick={axisTick} tickLine={false} axisLine={false} tickCount={4} ticks={pctTicks} allowDecimals />
          <Tooltip
            cursor={{ stroke: '#333', strokeWidth: 1 }}
            isAnimationActive={false}
            content={(p) => <ChartTooltip active={p.active} payload={p.payload as readonly TipEntry[] | undefined} label={p.label} series={series} format={format} />}
          />
          {guides?.map((g, i) => (
            <ReferenceLine key={i} y={g.y} stroke={g.color ?? '#333'} strokeDasharray="4 4"
              label={g.label ? { value: g.label, position: 'insideTopRight', fill: '#5c5c5c', fontSize: 11 } : undefined} />
          ))}
          {series.map((s) => (
            <Area key={s.key} dataKey={s.key} name={s.label} type="monotone"
              stroke={s.color} strokeWidth={s.kind === 'line' ? 1 : 1.5}
              strokeDasharray={s.dashed ? '4 4' : undefined}
              fill={s.kind === 'line' ? 'transparent' : s.color} fillOpacity={s.kind === 'line' ? 0 : 0.06}
              dot={false} activeDot={s.kind === 'line' ? false : { r: 3, strokeWidth: 0, fill: s.color }}
              isAnimationActive={false}
              connectNulls />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export default AreaMetric;
