/**
 * Docksy UI kit — formal black & gray (see apps/web/DESIGN.md).
 * Every page builds from these. Add new shared pieces here; keep them neutral and flat.
 */
import clsx from 'clsx';
import { Check, Loader2 } from 'lucide-react';
import { NavLink, Link } from 'react-router';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

export { clsx as cx };

type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'bad' | 'ai';

// ───────────────────────────── status ─────────────────────────────

const dotColor: Record<Tone, string> = {
  neutral: 'bg-faint', brand: 'bg-fg', ai: 'bg-fg', ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad',
};
const textColor: Record<Tone, string> = {
  neutral: 'text-muted', brand: 'text-fg', ai: 'text-fg', ok: 'text-ok', warn: 'text-warn', bad: 'text-bad',
};

/** Small colored dot. The only place color appears besides status text. */
export function StatusDot({ tone = 'neutral', className }: { tone?: Tone; className?: string }) {
  return <span className={clsx('inline-block size-2 shrink-0 rounded-full', dotColor[tone], className)} />;
}

/** Status text with a dot: "● Running". Plain, no pill background. */
export function Status({ status, label, className }: { status: string; label?: ReactNode; className?: string }) {
  const tone = statusTone(status);
  return (
    <span className={clsx('inline-flex items-center gap-1.5 text-sm', textColor[tone], className)}>
      <StatusDot tone={tone} />
      {label ?? status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

/** Subtle bordered label. Colored text only for ok/warn/bad. */
export function Badge({ tone = 'neutral', children, dot, className }: { tone?: Tone; children: ReactNode; dot?: boolean; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-1.5 rounded border border-border bg-surface px-1.5 py-0.5 text-xs font-medium', textColor[tone], className)}>
      {dot && <StatusDot tone={tone} className="size-1.5" />}
      {children}
    </span>
  );
}

// ───────────────────────────── buttons ─────────────────────────────

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'ai';
const btn: Record<BtnVariant, string> = {
  primary: 'bg-fg text-bg hover:bg-white font-medium border border-fg',
  secondary: 'bg-surface-2 text-fg border border-border-strong hover:bg-surface-3',
  ghost: 'text-muted hover:text-fg hover:bg-surface-2 border border-transparent',
  danger: 'bg-surface-2 text-bad border border-border-strong hover:bg-bad/10 hover:border-bad/40',
  ai: 'bg-surface-2 text-fg border border-border-strong hover:bg-surface-3', // legacy alias: no special styling
};

export function Button({ variant = 'secondary', size = 'md', loading, icon, children, className, disabled, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md whitespace-nowrap transition-colors cursor-pointer',
        'disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-1 focus-visible:outline-muted',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
        btn[variant], className,
      )}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
}

// ───────────────────────────── layout pieces ─────────────────────────────

export function Card({ children, className, title, actions, padded = true }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode; padded?: boolean }) {
  return (
    <section className={clsx('rounded-md border border-border bg-surface', className)}>
      {(title || actions) && (
        <header className="flex min-h-11 items-center justify-between gap-3 border-b border-border px-4 py-2">
          <h3 className="text-sm font-medium">{title}</h3>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={clsx(padded && 'p-4')}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="rounded-md border border-border bg-surface px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={clsx('mt-1 text-xl font-semibold tabular-nums', tone && textColor[tone])}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

/** Page title row. `icon` is accepted for compatibility but rendered plain (no tile). */
export function PageHeader({ title, subtitle, actions, icon }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          {icon && <span className="text-muted [&>svg]:size-5">{icon}</span>}
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** "Apps › production › my-app" */
export function Breadcrumbs({ items }: { items: { label: ReactNode; to?: string }[] }) {
  return (
    <nav className="mb-2 flex flex-wrap items-center gap-1.5 text-sm text-muted">
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-faint">›</span>}
          {it.to ? <Link to={it.to} className="hover:text-fg">{it.label}</Link> : <span className="text-fg">{it.label}</span>}
        </span>
      ))}
    </nav>
  );
}

/** Top-level tabs under a page header ("Configuration · Deployments · Logs"). Use `to` for routes or `onClick`. */
export function PageTabs({ tabs, value, onChange, actions }: {
  tabs: { id: string; label: ReactNode; to?: string; end?: boolean }[];
  value?: string;
  onChange?: (id: string) => void;
  actions?: ReactNode;
}) {
  const cls = (active: boolean) => clsx('-mb-px border-b-2 px-1 pb-2.5 text-sm whitespace-nowrap cursor-pointer', active ? 'border-fg text-fg' : 'border-transparent text-muted hover:text-fg');
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b border-border">
      <div className="flex gap-5 overflow-x-auto">
        {tabs.map((t) => t.to
          ? <NavLink key={t.id} to={t.to} end={t.end} className={({ isActive }) => cls(isActive)}>{t.label}</NavLink>
          : <button key={t.id} type="button" onClick={() => onChange?.(t.id)} className={cls(value === t.id)}>{t.label}</button>)}
      </div>
      {actions && <div className="mb-2 flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Settings-style layout: left sub-navigation + content (like Coolify's configuration screen). */
export function SubNavLayout({ items, value, onChange, children }: {
  items: { id: string; label: ReactNode; hidden?: boolean; danger?: boolean }[];
  value: string;
  onChange: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <nav className="flex shrink-0 gap-1 overflow-x-auto md:w-52 md:flex-col">
        {items.filter((i) => !i.hidden).map((i) => (
          <button key={i.id} type="button" onClick={() => onChange(i.id)}
            className={clsx('rounded-md px-3 py-1.5 text-left text-sm whitespace-nowrap cursor-pointer',
              value === i.id ? 'bg-surface-2 text-fg' : 'text-muted hover:bg-surface-2/60 hover:text-fg',
              i.danger && value !== i.id && 'hover:text-bad')}>
            {i.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** A titled form section: "General [Save]" + description, then fields. */
export function Section({ title, description, actions, children, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={clsx('mb-10', className)}>
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        {actions}
      </div>
      {description && <p className="mb-5 text-sm text-muted">{description}</p>}
      {!description && <div className="mb-4" />}
      {children}
    </section>
  );
}

/** Two-column responsive field grid. */
export function FieldGrid({ children, cols = 2 }: { children: ReactNode; cols?: 1 | 2 | 3 }) {
  return <div className={clsx('grid gap-x-4 gap-y-5', cols === 2 && 'md:grid-cols-2', cols === 3 && 'md:grid-cols-3')}>{children}</div>;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border px-6 py-12 text-center">
      {icon && <div className="mb-3 text-faint [&>svg]:size-6">{icon}</div>}
      <h3 className="text-sm font-medium">{title}</h3>
      {children && <p className="mt-1 max-w-md text-sm text-muted">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-4 animate-spin text-muted', className)} />;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="flex items-center gap-2 p-6 text-sm text-muted"><Spinner className="size-4" />{label}</div>;
}

/** Server or network error. Pass `retry` (usually the query's refetch) to show a Retry button. */
export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="flex items-start gap-3 rounded-md border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
      <span className="flex-1">{msg}</span>
      {retry && <Button size="sm" variant="secondary" onClick={retry}>Retry</Button>}
    </div>
  );
}

/** Neutral info / warning callout. */
export function Callout({ tone = 'neutral', children }: { tone?: 'neutral' | 'warn' | 'bad'; children: ReactNode }) {
  return (
    <div className={clsx('rounded-md border px-3 py-2 text-sm',
      tone === 'neutral' && 'border-border bg-surface text-muted',
      tone === 'warn' && 'border-warn/30 bg-warn/5 text-warn',
      tone === 'bad' && 'border-bad/30 bg-bad/5 text-bad')}>{children}</div>
  );
}

// ───────────────────────────── form fields ─────────────────────────────

const field = 'w-full rounded-md border border-border bg-surface px-3 text-sm text-fg outline-none placeholder:text-faint focus:border-muted disabled:opacity-60 read-only:text-muted';

export function Label({ children, hint, htmlFor, required }: { children: ReactNode; hint?: ReactNode; htmlFor?: string; required?: boolean }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 flex items-center gap-1 text-sm text-fg">
      {children}
      {required && <span className="text-bad">*</span>}
      {hint && <span className="ml-1 text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={clsx(field, 'h-9', className)} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={clsx(field, 'py-2 font-mono text-[13px] leading-relaxed', className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...rest} className={clsx(field, 'h-9', className)}>{children}</select>;
}

/** Label + control + optional help text. */
export function Field({ label, hint, help, required, children }: { label: string; hint?: ReactNode; help?: ReactNode; required?: boolean; children: ReactNode }) {
  return (
    <div>
      <Label hint={hint} required={required}>{label}</Label>
      {children}
      {help && <p className="mt-1.5 text-xs text-muted">{help}</p>}
    </div>
  );
}

/** Checkbox row like Coolify's "Preserve Repository During Deployment □". */
export function Checkbox({ label, help, checked, onChange, disabled }: { label: ReactNode; help?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={clsx('flex items-start gap-3 text-sm', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <span className="relative mt-0.5 inline-flex size-4 shrink-0">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)}
          className="peer size-4 cursor-pointer appearance-none rounded border border-border-strong bg-surface checked:border-fg checked:bg-fg disabled:cursor-not-allowed" />
        <Check className="pointer-events-none absolute inset-0 m-auto hidden size-3 text-bg peer-checked:block" strokeWidth={3} />
      </span>
      <span>
        <span className="text-fg">{label}</span>
        {help && <span className="mt-0.5 block text-xs text-muted">{help}</span>}
      </span>
    </label>
  );
}

/** Underlined in-panel tabs (secondary level). */
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="mb-5 flex gap-5 overflow-x-auto border-b border-border">
      {tabs.map((t) => (
        <button key={t.id} type="button" onClick={() => onChange(t.id)}
          className={clsx('-mb-px whitespace-nowrap border-b-2 px-0.5 pb-2 text-sm cursor-pointer',
            value === t.id ? 'border-fg text-fg' : 'border-transparent text-muted hover:text-fg')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Thin usage bar, 0–100. Gray by default; turns warn/bad only above thresholds. */
export function Meter({ value, tone, className }: { value: number; tone?: 'ok' | 'warn' | 'bad' | 'brand'; className?: string }) {
  const t = tone ?? (value >= 90 ? 'bad' : value >= 75 ? 'warn' : 'brand');
  const color = t === 'bad' ? 'bg-bad' : t === 'warn' ? 'bg-warn' : t === 'ok' ? 'bg-ok' : 'bg-fg/70';
  return (
    <div className={clsx('h-1 w-full overflow-hidden rounded-full bg-surface-3', className)}>
      <div className={clsx('h-full rounded-full transition-[width] duration-500', color)} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return <pre className={clsx('overflow-x-auto rounded-md border border-border bg-surface p-3 font-mono text-xs leading-relaxed text-fg', className)}>{children}</pre>;
}

/** Simple table primitives. */
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('overflow-x-auto rounded-md border border-border', className)}>
      <table className="w-full text-sm [&_td]:border-t [&_td]:border-border [&_td]:px-4 [&_td]:py-2.5 [&_th]:bg-surface [&_th]:px-4 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted">
        {children}
      </table>
    </div>
  );
}

/** Status → tone mapping used across pages. */
export function statusTone(s: string): Tone {
  if (['running', 'succeeded', 'ready', 'online', 'up', 'passed', 'operational', 'resolved', 'healthy'].includes(s)) return 'ok';
  if (['deploying', 'building', 'queued', 'provisioning', 'pending', 'degraded', 'warning', 'restarting'].includes(s)) return 'warn';
  if (['failed', 'error', 'offline', 'down', 'critical', 'firing', 'dead', 'exited', 'unhealthy'].includes(s)) return 'bad';
  return 'neutral';
}
