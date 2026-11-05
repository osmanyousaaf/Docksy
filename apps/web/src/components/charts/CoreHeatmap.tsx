/** Per-core CPU heatmap in grayscale: white intensity = usage; red only at ≥90%. */
import clsx from 'clsx';

export interface CoreHeatmapProps {
  values: number[];
  className?: string;
  /** Minimum tile width in px. */
  minTile?: number;
}

export function coreColor(v: number): string {
  const p = Math.max(0, Math.min(100, v));
  if (p >= 90) return `color-mix(in srgb, var(--color-bad) ${55 + (p - 90) * 3}%, #1a1a1a)`;
  // #1a1a1a at 0% → ~#d0d0d0 at 89%
  return `color-mix(in srgb, #ededed ${4 + p * 0.85}%, #1a1a1a)`;
}

export function CoreHeatmap({ values, className, minTile = 52 }: CoreHeatmapProps) {
  if (values.length === 0) {
    return <div className={clsx('rounded-md border border-dashed border-border p-6 text-center text-xs text-muted', className)}>Waiting for per-core data from the agent…</div>;
  }
  const n = values.length;
  // Even rows: 12 cores → 2 × 6, 16 → 2 × 8, 64 → 4 × 16. minTile still applies on narrow screens.
  const cols = n <= 8 ? n : n <= 16 ? Math.ceil(n / 2) : n <= 32 ? 8 : 16;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const hottest = Math.max(...values);
  return (
    <div className={className}>
      <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(max(${minTile * 0.6}px, calc((100% - ${(cols - 1) * 4}px) / ${cols})), 1fr))` }}>
        {values.map((v, i) => {
          const light = v >= 50 && v < 90;
          return (
            <div key={i} title={`core ${i}: ${v.toFixed(1)}%`}
              className="flex h-11 flex-col justify-between rounded px-1.5 py-1 transition-[background-color] duration-150"
              style={{ backgroundColor: coreColor(v) }}>
              <span className={clsx('text-[10px] leading-none', light ? 'text-bg/60' : 'text-fg/50')}>{i}</span>
              <span className={clsx('text-right text-xs font-medium leading-none tabular-nums', light ? 'text-bg' : 'text-fg')}>{v.toFixed(0)}%</span>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>{values.length} cores · avg <span className="text-fg tabular-nums">{avg.toFixed(0)}%</span> · hottest <span className="text-fg tabular-nums">{hottest.toFixed(0)}%</span></span>
        <span className="flex items-center gap-1.5">
          0%
          <span className="flex h-1.5 w-24 overflow-hidden rounded-sm">
            {[0, 20, 40, 60, 80, 95].map((p) => <span key={p} className="flex-1" style={{ backgroundColor: coreColor(p) }} />)}
          </span>
          100%
        </span>
      </div>
    </div>
  );
}

export default CoreHeatmap;
