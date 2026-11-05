/** Centered, flat auth card shared by Login and Setup. */
import type { ReactNode } from 'react';
import { Logo } from './components.tsx';
import { ensureMonitoringStyles } from './styles.ts';

ensureMonitoringStyles();

export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-bg px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo className="mb-4 size-10" />
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
        </div>
        <div className="rounded-md border border-border bg-surface p-6">{children}</div>
        {footer && <div className="mt-5 text-center text-xs text-muted">{footer}</div>}
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
