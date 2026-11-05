/** Shared UI pieces for the apps/deploy pages (web-apps agent). */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity, AppWindow, BarChart3, Box, Check, Copy, Database, Ghost, HardDrive, Leaf, Newspaper, PieChart, Workflow, X, Zap,
} from 'lucide-react';
import type { AppKind, AppStatus } from '@docksy/shared';
import { Button, Input, Status, cx } from '../../components/ui.tsx';
import { ANSI_COLORS, lineLevel, parseAnsi, stripAnsi } from './ansi.ts';

/* ───────────────────────── icons ───────────────────────── */

/** GitHub mark (lucide 1.x dropped brand icons). */
export function GithubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={cx('size-4', className)}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

const TEMPLATE_ICON: Record<string, typeof Box> = {
  postgres: Database, mysql: Database, mariadb: Database, mongodb: Leaf, redis: Zap,
  n8n: Workflow, 'uptime-kuma': Activity, plausible: BarChart3, umami: PieChart, minio: HardDrive, ghost: Ghost, wordpress: Newspaper,
};

export function TemplateIcon({ id, kind, className }: { id: string | null; kind?: AppKind; className?: string }) {
  const Icon = (id && TEMPLATE_ICON[id]) || (kind === 'database' ? Database : kind === 'service' ? Box : AppWindow);
  return (
    <div className={cx('grid size-10 shrink-0 place-items-center rounded-md border border-border bg-surface text-muted', className)}>
      <Icon className="size-5" />
    </div>
  );
}

/* ───────────────────────── status ───────────────────────── */

const APP_STATUS_LABEL: Record<AppStatus, string> = { idle: 'Not deployed', deploying: 'Deploying', running: 'Running', stopped: 'Stopped', failed: 'Failed' };

export const appStatusLabel = (s: AppStatus) => APP_STATUS_LABEL[s] ?? s;

/** "● Running" in status color (no pill). */
export function AppStatusBadge({ status }: { status: AppStatus }) {
  return <Status status={status} label={appStatusLabel(status)} />;
}

export function StatusBadge({ status }: { status: string }) {
  return <Status status={status} />;
}

/* ───────────────────────── small controls ───────────────────────── */

export function useCopy(timeout = 1500) {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), timeout);
  };
  return { copied, copy };
}

export function CopyButton({ text, label, className, size = 'sm' }: { text: string; label?: string; className?: string; size?: 'sm' | 'md' }) {
  const { copied, copy } = useCopy();
  return (
    <Button size={size} variant="ghost" className={className} onClick={() => copy(text)} title="Copy"
      icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}>
      {label && (copied ? 'Copied' : label)}
    </Button>
  );
}

/** Code block with a copy button in the corner. */
export function Snippet({ code, className, tone = 'brand' }: { code: string; className?: string; tone?: 'brand' | 'ai' }) {
  return (
    <div className={cx('group relative rounded-md border border-border bg-bg', tone === 'ai' && 'border-border-strong', className)}>
      <pre className="overflow-x-auto p-3 pr-12 font-mono text-xs leading-relaxed text-fg/90">{code}</pre>
      <div className="absolute right-1.5 top-1.5"><CopyButton text={code} /></div>
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx('inline-flex select-none items-center gap-2.5 text-sm', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
        className={cx('relative h-5 w-9 shrink-0 rounded-full border transition-colors',
          checked ? 'border-fg bg-fg' : 'border-border-strong bg-surface-2')}>
        <span className={cx('absolute top-0.5 size-3.5 rounded-full transition-[left] duration-150', checked ? 'left-[18px] bg-bg' : 'left-0.5 bg-muted')} />
      </button>
      {label}
    </label>
  );
}

/** Segmented control (range pickers, view toggles). */
export function Segmented<T extends string>({ options, value, onChange, className }: { options: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cx('inline-flex rounded-md border border-border bg-surface p-0.5', className)}>
      {options.map((o) => (
        <button key={o.id} type="button" onClick={() => onChange(o.id)}
          className={cx('rounded px-2.5 py-1 text-xs transition-colors cursor-pointer',
            value === o.id ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ───────────────────────── modal & confirmations ───────────────────────── */

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className={cx('relative w-full overflow-hidden rounded-md border border-border-strong bg-surface', wide ? 'max-w-2xl' : 'max-w-md')}>
        <header className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h3 className="text-base font-semibold">{title}</h3>
          <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg cursor-pointer" aria-label="Close"><X className="size-4" /></button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/** Destructive confirmation that requires typing an exact word (usually the app name). */
export function TypedConfirm({ open, onClose, onConfirm, title, word, children, action = 'Delete', loading, error }: {
  open: boolean; onClose: () => void; onConfirm: () => void; title: string; word: string; children?: ReactNode; action?: string; loading?: boolean; error?: ReactNode;
}) {
  const [typed, setTyped] = useState('');
  useEffect(() => { if (open) setTyped(''); }, [open]);
  const ok = typed.trim() === word;
  return (
    <Modal open={open} onClose={onClose} title={title}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="danger" disabled={!ok} loading={loading} onClick={onConfirm}>{action}</Button>
      </>}>
      <div className="space-y-3 text-sm">
        {children}
        <p className="text-muted">Type <code className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-fg">{word}</code> to confirm.</p>
        <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={word}
          onKeyDown={(e) => { if (e.key === 'Enter' && ok && !loading) onConfirm(); }} />
        {error}
      </div>
    </Modal>
  );
}

/* ───────────────────────── toast ───────────────────────── */

export interface ToastMsg { id: number; tone: 'ok' | 'bad' | 'info'; text: ReactNode }

export function useToasts() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const push = (tone: ToastMsg['tone'], text: ReactNode) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  };
  const view = (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} role="status" className={cx('pointer-events-auto flex items-start gap-2 rounded-md border border-border-strong bg-surface px-4 py-3 text-sm',
          t.tone === 'bad' && 'text-bad')}>
          {t.tone !== 'info' && <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', t.tone === 'ok' ? 'bg-ok' : 'bg-bad')} />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
  return { push, view };
}

/* ───────────────────────── time ───────────────────────── */

/** Re-render every `ms` while `active` (for live durations). */
export function useTick(active: boolean, ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
}

/* ───────────────────────── terminal ───────────────────────── */

export interface TermLine { id: number; text: string; stream?: 'stdout' | 'stderr' | 'system'; ts?: string }

const LogRow = memo(function LogRow({ line, n, showTs }: { line: TermLine; n: number; showTs: boolean }) {
  const segs = useMemo(() => parseAnsi(line.text), [line.text]);
  const hasColor = segs.some((s) => s.fg !== undefined);
  const level = hasColor ? null : lineLevel(line.text);
  const sys = line.stream === 'system';
  return (
    <div className={cx('group flex gap-3 px-3 hover:bg-white/[0.03]', sys && 'text-[#8f8f8f]')}>
      <span className="w-10 shrink-0 select-none text-right text-[#3d3d3d] group-hover:text-[#5c5c5c]">{n}</span>
      {showTs && line.ts && <span className="shrink-0 select-none text-[#5c5c5c]">{new Date(line.ts).toLocaleTimeString()}</span>}
      <span className={cx('min-w-0 whitespace-pre-wrap break-all',
        line.stream === 'stderr' && !hasColor && 'text-[#f87171]',
        level === 'error' && 'text-[#f87171]', level === 'warn' && 'text-[#eab308]', level === 'step' && 'font-semibold text-white')}>
        {segs.length === 0 ? ' ' : segs.map((s, i) => (
          <span key={i} style={s.fg !== undefined ? { color: ANSI_COLORS[s.fg] } : undefined}
            className={cx(s.bold && 'font-semibold', s.dim && 'opacity-60', s.italic && 'italic', s.underline && 'underline')}>{s.text}</span>
        ))}
      </span>
    </div>
  );
});

/**
 * Terminal-look log viewer. Auto-scrolls while `follow` is on; scrolling up turns follow off,
 * scrolling back to the bottom turns it on again.
 */
export function Terminal({ lines, follow, onFollowChange, filter = '', showTs = false, className, empty, header }: {
  lines: TermLine[]; follow: boolean; onFollowChange: (v: boolean) => void; filter?: string; showTs?: boolean; className?: string; empty?: ReactNode; header?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const programmatic = useRef(false);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const numbered = lines.map((l, i) => ({ l, n: i + 1 }));
    return f ? numbered.filter(({ l }) => stripAnsi(l.text).toLowerCase().includes(f)) : numbered;
  }, [lines, filter]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !follow) return;
    programmatic.current = true;
    el.scrollTop = el.scrollHeight;
  }, [shown, follow]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    if (programmatic.current) { programmatic.current = false; return; }
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== follow) onFollowChange(atBottom);
  };

  return (
    <div className={cx('flex flex-col overflow-hidden rounded-md border border-border bg-[#050505]', className)}>
      {header && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">{header}</div>}
      <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto py-2 font-mono text-[12px] leading-[1.65] text-[#d4d4d4]">
        {shown.length === 0
          ? <div className="px-4 py-6 text-[#5c5c5c]">{filter && lines.length ? 'No lines match the filter.' : empty ?? 'Waiting for output…'}</div>
          : shown.map(({ l, n }) => <LogRow key={l.id} line={l} n={n} showTs={showTs} />)}
      </div>
    </div>
  );
}

/** Window chrome for terminal headers. Kept for compatibility; renders neutral gray dots. */
export function TermDots() {
  return (
    <span className="mr-1 flex gap-1.5" aria-hidden>
      <span className="size-2 rounded-full bg-[#333]" />
      <span className="size-2 rounded-full bg-[#333]" />
      <span className="size-2 rounded-full bg-[#333]" />
    </span>
  );
}
