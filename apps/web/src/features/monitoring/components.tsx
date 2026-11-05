/** Building blocks shared by the monitoring pages. Flat, grayscale (see apps/web/DESIGN.md). */
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import clsx from 'clsx';
import { Check, Copy, X } from 'lucide-react';
import type { Liveness, MetricsRange, Severity } from '@docksy/shared';
import { RANGES, useCopy } from './hooks.ts';
import { ensureMonitoringStyles } from './styles.ts';

ensureMonitoringStyles();

// ───────────── brand ─────────────

/** Monochrome mark, identical to /favicon.svg. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="7" fill="#0a0a0a" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="6.5" fill="none" stroke="#333" />
      <path d="M7 18.5h18l-2.2 5a1.6 1.6 0 0 1-1.5 1H10.7a1.6 1.6 0 0 1-1.5-1z" fill="#ededed" />
      <rect x="10" y="12" width="5" height="5" rx="1" fill="#8f8f8f" />
      <rect x="16" y="12" width="5" height="5" rx="1" fill="#ededed" />
      <rect x="16" y="6" width="5" height="5" rx="1" fill="#8f8f8f" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={clsx('flex items-center gap-2', className)}>
      <Logo className="size-6" />
      <span className="text-lg font-semibold">Docksy</span>
    </span>
  );
}

// ───────────── status bits ─────────────

/** Small static status dot: green online, red offline, gray otherwise. */
export function LiveDot({ state, className }: { state: Liveness | 'connecting' | 'open' | 'closed'; className?: string }) {
  const on = state === 'online' || state === 'open';
  const color = on ? 'bg-ok' : state === 'offline' || state === 'closed' ? 'bg-bad' : 'bg-faint';
  return <span className={clsx('inline-block size-2 shrink-0 rounded-full', color, className)} aria-label={String(state)} />;
}

export const severityTone = (s: Severity): 'bad' | 'warn' | 'brand' => (s === 'critical' ? 'bad' : s === 'warning' ? 'warn' : 'brand');

/** "● critical" — a colored dot and the word. Info stays gray. */
export function SeverityBadge({ severity }: { severity: Severity }) {
  const dot = severity === 'critical' ? 'bg-bad' : severity === 'warning' ? 'bg-warn' : 'bg-faint';
  const text = severity === 'critical' ? 'text-bad' : severity === 'warning' ? 'text-warn' : 'text-muted';
  return (
    <span className={clsx('inline-flex shrink-0 items-center gap-1.5 text-xs', text)}>
      <span className={clsx('size-1.5 rounded-full', dot)} />{severity}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('rounded-md bg-surface-2', className)} />;
}

// ───────────── copy ─────────────

export function CopyButton({ text, className, label }: { text: string; className?: string; label?: string }) {
  const [copied, copy] = useCopy();
  return (
    <button type="button" onClick={() => copy(text)} title="Copy to clipboard"
      className={clsx('inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border-strong bg-surface-2 px-2 text-xs text-muted transition-colors duration-150 hover:bg-surface-3 hover:text-fg cursor-pointer', className)}>
      {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
      {label && <span>{copied ? 'Copied' : label}</span>}
    </button>
  );
}

/** A monospace one-liner with a copy button. */
export function CopyField({ value, prompt = '$', className, wrap }: { value: string; prompt?: string | null; className?: string; wrap?: boolean }) {
  return (
    <div className={clsx('flex items-start gap-2 rounded-md border border-border bg-surface px-3 py-1.5', className)}>
      <code className={clsx('min-w-0 flex-1 font-mono text-xs leading-7', wrap ? 'break-all whitespace-pre-wrap' : 'dx-scroll overflow-x-auto whitespace-nowrap')}>
        {prompt && <span className="mr-2 select-none text-faint">{prompt}</span>}{value}
      </code>
      <CopyButton text={value} label="Copy" />
    </div>
  );
}

// ───────────── range picker ─────────────

export function RangePicker({ value, onChange, ranges = RANGES }: { value: MetricsRange; onChange: (r: MetricsRange) => void; ranges?: MetricsRange[] }) {
  return (
    <div role="radiogroup" aria-label="Time range" className="inline-flex h-8 items-center rounded-md border border-border-strong bg-surface p-0.5">
      {ranges.map((r) => (
        <button key={r} type="button" role="radio" aria-checked={value === r} onClick={() => onChange(r)}
          className={clsx('h-full rounded px-2 text-xs tabular-nums transition-colors duration-150 cursor-pointer',
            value === r ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg')}>
          {r}
        </button>
      ))}
    </div>
  );
}

// ───────────── modal ─────────────

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); };
    window.addEventListener('keydown', onKey);
    const t = setTimeout(() => ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus(), 30);
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(t); prevFocus?.focus?.(); };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div ref={ref} className={clsx('relative flex max-h-[92vh] w-full flex-col rounded-t-md border border-border-strong bg-surface sm:rounded-md', wide ? 'sm:max-w-2xl' : 'sm:max-w-lg')}>
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg cursor-pointer" aria-label="Close"><X className="size-4" /></button>
        </header>
        <div className="dx-scroll overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

// ───────────── misc ─────────────

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={clsx('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-150 cursor-pointer disabled:opacity-50',
        checked ? 'border-fg bg-fg' : 'border-border-strong bg-surface-2')}>
      <span className={clsx('inline-block size-3.5 rounded-full transition-transform duration-150', checked ? 'translate-x-[18px] bg-bg' : 'translate-x-[2px] bg-muted')} />
    </button>
  );
}

/** Inline thin usage bar with a value label (tables). Gray; red only at ≥90%. `color` is accepted for compatibility. */
export function InlineBar({ value, label }: { value: number; color?: string; label: ReactNode }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="flex min-w-[120px] items-center gap-2.5">
      <span className="w-16 shrink-0 text-xs tabular-nums text-fg">{label}</span>
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-3">
        <div className={clsx('h-full rounded-full', v >= 90 ? 'bg-bad' : 'bg-fg/60')} style={{ width: `${Math.max(v, v > 0 ? 2 : 0)}%` }} />
      </div>
    </div>
  );
}

export function SectionTitle({ children, right, icon }: { children: ReactNode; right?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium">{icon && <span className="text-muted">{icon}</span>}{children}</h2>
      {right}
    </div>
  );
}

export function ServerLink({ id, name }: { id: string | null; name?: string | null }) {
  if (!id) return null;
  return <Link to={`/servers/${id}`} className="text-fg underline-offset-2 hover:underline">{name ?? 'server'}</Link>;
}
