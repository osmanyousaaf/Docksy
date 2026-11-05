/** Uptime strip: N thin bars (e.g. 90 days). Status colors only (green/yellow/red), gray for no data. Hover shows the bucket detail. */
import { useState } from 'react';
import clsx from 'clsx';

export interface UptimeBar {
  /** e.g. "2026-10-31" or "14:20–14:36" */
  label: string;
  /** percent 0–100, null = no data */
  value: number | null;
  /** optional extra line, e.g. "avg 120 ms" */
  detail?: string;
}

export function uptimeColor(v: number | null): string {
  if (v == null) return 'var(--color-surface-3)';
  if (v >= 99.5) return 'var(--color-ok)';
    if (v >= 95) return 'var(--color-warn)';
  return 'var(--color-bad)';
}

export function UptimeBars({ bars, height = 28, className, legend }: { bars: UptimeBar[]; height?: number; className?: string; legend?: [string, string] }) {
  const [hover, setHover] = useState<number | null>(null);
  const h = hover != null ? bars[hover] : null;
  return (
    <div className={clsx('relative', className)} onMouseLeave={() => setHover(null)}>
      <div className="flex items-end gap-[2px]" style={{ height }}>
        {bars.map((b, i) => (
          <div key={i}
            onMouseEnter={() => setHover(i)}
            className={clsx('min-w-[2px] flex-1 rounded-[1px] transition-opacity duration-150', hover != null && hover !== i && 'opacity-60')}
            style={{ height: '100%', backgroundColor: uptimeColor(b.value) }}
            aria-label={`${b.label}: ${b.value == null ? 'no data' : `${b.value.toFixed(2)}%`}`} />
        ))}
      </div>
      {legend && (
        <div className="mt-1 flex justify-between text-[11px] text-faint">
          <span>{legend[0]}</span><span>{legend[1]}</span>
        </div>
      )}
      {h && (
        <div className="pointer-events-none absolute z-20 -translate-x-1/2 whitespace-nowrap rounded-md border border-border-strong bg-surface px-2 py-1 text-[11px]"
          style={{ left: `${Math.min(88, Math.max(12, ((hover! + 0.5) / bars.length) * 100))}%`, bottom: height + 8 }}>
          <div className="font-medium">{h.label}</div>
          <div className="text-muted">{h.value == null ? 'No data' : `${h.value.toFixed(2)}% up`}{h.detail ? ` · ${h.detail}` : ''}</div>
        </div>
      )}
    </div>
  );
}

export default UptimeBars;
