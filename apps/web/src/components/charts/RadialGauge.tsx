/**
 * Formerly a radial gauge; now a plain metric tile: label, big number and a thin Meter bar.
 * Props are unchanged for backward compatibility (`color` and `size` are accepted but the look is monochrome).
 */
import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface RadialGaugeProps {
  value: number | null;
  label: string;
  /** Secondary line under the number, e.g. "3.1 / 8 GB". */
  sub?: ReactNode;
  color?: string;
  size?: number;
  icon?: ReactNode;
  /** Switch to warn/bad colors above these thresholds. */
  thresholds?: [warn: number, bad: number];
}

export function RadialGauge({ value, label, sub, icon, thresholds = [80, 92] }: RadialGaugeProps) {
  const v = value == null || !isFinite(value) ? 0 : Math.max(0, Math.min(100, value));
  const bar = v >= thresholds[1] ? 'bg-bad' : v >= thresholds[0] ? 'bg-warn' : 'bg-fg/70';
  return (
    <div className="min-w-0" role="meter" aria-label={label} aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
      <div className="flex items-center gap-1.5 text-xs text-muted [&_svg]:size-3.5">{icon}{label}</div>
      <div className={clsx('mt-1.5 text-2xl font-semibold tabular-nums leading-none', v >= thresholds[1] && value != null && 'text-bad')}>
        {value == null ? '—' : <>{v.toFixed(v < 10 ? 1 : 0)}<span className="ml-0.5 text-base font-normal text-muted">%</span></>}
      </div>
      <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-surface-3">
        <div className={clsx('h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none', bar)} style={{ width: `${v}%` }} />
      </div>
      {sub && <div className="mt-2 truncate text-xs tabular-nums text-muted">{sub}</div>}
    </div>
  );
}

export default RadialGauge;
