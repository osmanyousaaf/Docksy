/**
 * Small, flat building blocks for the admin pages (Alerts, Uptime, Settings, Claude, auth, status).
 * Formal black & gray per apps/web/DESIGN.md: no gradients, glows or tinted panels.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router';
import clsx from 'clsx';
import { Check, Copy, X } from 'lucide-react';
import type { Severity } from '@docksy/shared';
import { Button, StatusDot } from '../../components/ui.tsx';

// ───────────── url state ─────────────

/** A `?name=` search param restricted to a set of values (for tabs / sub-sections). */
export function useParamState<T extends string>(name: string, allowed: readonly T[], fallback: T): [T, (v: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(name);
  const value = (allowed as readonly string[]).includes(raw ?? '') ? (raw as T) : fallback;
  const set = (v: T) => {
    const next = new URLSearchParams(params);
    next.set(name, v);
    setParams(next, { replace: true });
  };
  return [value, set];
}

// ───────────── copy ─────────────

export function useCopy(timeout = 1500): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), timeout);
    return () => clearTimeout(t);
  }, [copied, timeout]);
  const copy = (text: string) => {
    const done = () => setCopied(true);
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text) && done());
    else if (fallbackCopy(text)) done();
  };
  return [copied, copy];
}

function fallbackCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

export function CopyButton({ text, label = 'Copy', size = 'sm', className }: { text: string; label?: string; size?: 'sm' | 'md'; className?: string }) {
  const [copied, copy] = useCopy();
  return (
    <Button size={size} className={className} onClick={() => copy(text)} aria-label={`${label} to clipboard`}
      icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}>
      {copied ? 'Copied' : label}
    </Button>
  );
}

/** Plain code block with an optional caption and a copy button. */
export function CodeBlock({ code, caption, className, wrap }: { code: string; caption?: ReactNode; className?: string; wrap?: boolean }) {
  return (
    <div className={clsx('overflow-hidden rounded-md border border-border bg-surface', className)}>
      <div className="flex min-h-9 items-center justify-between gap-3 border-b border-border px-3 py-1">
        <span className="truncate text-xs text-muted">{caption}</span>
        <CopyButton text={code} />
      </div>
      <pre className={clsx('px-3 py-2.5 font-mono text-xs leading-relaxed text-fg', wrap ? 'whitespace-pre-wrap break-all' : 'overflow-x-auto')}>{code}</pre>
    </div>
  );
}

/** Read-only single-line value with a copy button (tokens, keys, URLs). */
export function CopyField({ value, mono = true }: { value: string; mono?: boolean }) {
  return (
    <div className="flex items-stretch gap-2">
      <input readOnly value={value} onFocus={(e) => e.currentTarget.select()}
        className={clsx('h-9 min-w-0 flex-1 rounded-md border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-muted', mono && 'font-mono text-xs')} />
      <CopyButton text={value} size="md" />
    </div>
  );
}

// ───────────── status ─────────────

const SEV: Record<Severity, { tone: 'bad' | 'warn' | 'neutral'; label: string; text: string }> = {
  critical: { tone: 'bad', label: 'Critical', text: 'text-bad' },
  warning: { tone: 'warn', label: 'Warning', text: 'text-warn' },
  info: { tone: 'neutral', label: 'Info', text: 'text-muted' },
};

/** "● Critical": a small dot plus a word. */
export function SeverityLabel({ severity }: { severity: Severity }) {
  const s = SEV[severity] ?? SEV.info;
  return (
    <span className={clsx('inline-flex items-center gap-1.5 whitespace-nowrap text-sm', s.text)}>
      <StatusDot tone={s.tone} />{s.label}
    </span>
  );
}

/** Square icon-only action in a table row. */
export function RowButton({ label, onClick, children, danger }: { label: string; onClick: () => void; children: ReactNode; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label}
      className={clsx('grid size-7 place-items-center rounded-md text-muted transition-colors cursor-pointer hover:bg-surface-2',
        danger ? 'hover:text-bad' : 'hover:text-fg')}>
      {children}
    </button>
  );
}

// ───────────── modal ─────────────

/** Plain modal: dark overlay, flat panel, title + optional description, footer actions. */
export function Modal({ open, onClose, title, description, children, footer, wide }: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', esc); document.body.style.overflow = prev; };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/75 px-4 py-10 sm:py-16" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" className={clsx('w-full rounded-md border border-border-strong bg-bg', wide ? 'max-w-2xl' : 'max-w-lg')}>
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{title}</h2>
            {description && <p className="mt-1 text-sm text-muted">{description}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-mr-1 grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg cursor-pointer">
            <X className="size-4" />
          </button>
        </div>
        {children && <div className="px-5 pb-1 pt-5">{children}</div>}
        {footer && <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Confirmation dialog for deletes and revokes. */
export function ConfirmDialog({ open, title, children, confirmLabel, loading, error, onConfirm, onClose }: {
  open: boolean; title: ReactNode; children: ReactNode; confirmLabel: string; loading?: boolean; error?: ReactNode; onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} description={children}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={loading} onClick={onConfirm}>{confirmLabel}</Button></>}>
      {error}
    </Modal>
  );
}

// ───────────── brand ─────────────

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-2', className)}>
      <img src="/favicon.svg" alt="" className="size-6" />
      <span className="text-base font-semibold tracking-tight">Docksy</span>
    </span>
  );
}

/** Centered narrow form on the black page. Used by Login and Setup. */
export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-bg px-4 py-12">
      <div className="w-full max-w-sm">
        <Wordmark className="mb-10" />
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        <div className="mt-6">{children}</div>
        {footer && <div className="mt-8 border-t border-border pt-4 text-xs text-muted">{footer}</div>}
      </div>
    </div>
  );
}

/** Only allow same-origin relative redirects (no //evil.com or absolute URLs). */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  if (next.startsWith('/login') || next.startsWith('/setup')) return '/';
  return next;
}

// ───────────── uptime strip ─────────────

export interface Day { date: string; uptime: number | null }

/** Day color: gray when there's no data or partial, muted green for a clean day, muted red for a bad one. */
function dayClass(v: number | null): string {
  if (v == null) return 'bg-surface-3';
  if (v >= 99) return 'bg-ok/45';
  if (v < 95) return 'bg-bad/60';
  return 'bg-faint';
}

/** 90 thin day bars. Native tooltips; no animation. */
export function DayStrip({ days, height = 22, legend }: { days: Day[]; height?: number; legend?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="flex items-stretch gap-px" style={{ height }} role="img"
        aria-label={`Uptime for the last ${days.length} days`}>
        {days.map((d) => (
          <span key={d.date} className={clsx('min-w-px flex-1 rounded-[1px]', dayClass(d.uptime))}
            title={`${fmtDay(d.date)}: ${d.uptime == null ? 'no data' : `${d.uptime.toFixed(2)}% up`}`} />
        ))}
      </div>
      {legend && (
        <div className="mt-1.5 flex justify-between text-[11px] text-faint">
          <span>{days.length} days ago</span><span>Today</span>
        </div>
      )}
    </div>
  );
}

export const fmtDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

/** Local YYYY-MM-DD. */
export function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Bucket check results into the last `n` local days (oldest first). */
export function bucketDays(results: { ts: string; ok: boolean }[], n = 90, now = Date.now()): Day[] {
  const acc = new Map<string, { ok: number; total: number }>();
  for (const r of results) {
    const k = dayKey(new Date(r.ts).getTime());
    const b = acc.get(k) ?? { ok: 0, total: 0 };
    b.total++;
    if (r.ok) b.ok++;
    acc.set(k, b);
  }
  const out: Day[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const k = dayKey(now - i * 86400e3);
    const b = acc.get(k);
    out.push({ date: k, uptime: b ? (b.ok / b.total) * 100 : null });
  }
  return out;
}

export const items = <T,>(d: { items: T[] } | T[] | undefined): T[] => (Array.isArray(d) ? d : d?.items ?? []);
