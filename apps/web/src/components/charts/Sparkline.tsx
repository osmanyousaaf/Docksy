/** Tiny monochrome SVG sparkline: a thin line, an optional flat fill and an optional static end dot. */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface SparklineProps {
  values: number[];
  color?: string;
  height?: number;
  /** Fixed y max (e.g. 100 for percentages). Defaults to data max + headroom. */
  max?: number;
  min?: number;
  /** Flat, very light fill under the line. */
  fill?: boolean;
  className?: string;
  /** Show a small static dot on the latest value. */
  dot?: boolean;
  strokeWidth?: number;
}

/** Catmull-Rom → cubic bezier path through points. */
export function smoothPath(pts: [number, number][]): string {
  if (pts.length === 0) return '';
  const f = (n: number) => n.toFixed(2);
  let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)},${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)},${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])},${f(p2[1])}`;
  }
  return d;
}

function useWidth<T extends Element>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((e) => setW(e[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function Sparkline({ values, color = 'var(--color-cpu)', height = 36, max, min = 0, fill = false, className, dot = false, strokeWidth = 1.5 }: SparklineProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const n = values.length;
  const W = Math.max(1, width);
  let body = null;
  if (n > 0 && width > 0) {
    const hi = max ?? Math.max(1e-9, ...values) * 1.2;
    const lo = Math.min(min, ...values);
    const pad = 2;
    const y = (v: number) => pad + (height - pad * 2) * (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo || 1));
    const vals = n === 1 ? [values[0], values[0]] : values;
    const step = W / (vals.length - 1);
    const pts: [number, number][] = vals.map((v, i) => [i * step, y(v)]);
    const line = smoothPath(pts);
    const area = `${line} L${W.toFixed(2)},${height} L0,${height} Z`;
    body = (
      <>
        {fill && <path d={area} fill={color} fillOpacity={0.06} />}
        <path d={line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {dot && <circle cx={W} cy={y(values[n - 1])} r={2} fill={color} />}
      </>
    );
  }

  return (
    <div ref={ref} className={className} style={{ height, width: '100%' }}>
      <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} style={{ overflow: 'visible', display: 'block' }} aria-hidden>
        {body}
      </svg>
    </div>
  );
}

export default Sparkline;
