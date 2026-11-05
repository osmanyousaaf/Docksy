/** App shell: Coolify-style sidebar, flat mobile top bar + drawer, user + logout, ⌘K quick switcher. Dark only. */
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Activity, Bell, Boxes, CornerDownLeft, LayoutDashboard, LogOut, Menu, Plus, Search, Server, Settings, Sparkles, X,
} from 'lucide-react';
import type { Alert, App, AuthState, Health, Server as ServerT } from '@docksy/shared';
import { api, useApi } from '../lib/api.ts';
import { LiveDot } from '../features/monitoring/components.tsx';

// Dev-only mock backend (?mock=1). Stripped from production builds.
if (import.meta.env.DEV) await import('../features/monitoring/mock.ts').then((m) => m.installMock());

type Icon = ComponentType<{ className?: string }>;
const NAV: { to: string; label: string; icon: Icon; end?: boolean; badge?: 'alerts' }[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/servers', label: 'Servers', icon: Server },
  { to: '/apps', label: 'Apps', icon: Boxes },
  { to: '/alerts', label: 'Alerts', icon: Bell, badge: 'alerts' },
  { to: '/uptime', label: 'Uptime', icon: Activity },
  { to: '/claude', label: 'Claude', icon: Sparkles },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function useFiringCount(): number {
  const { data } = useApi<{ items: Alert[] }>('/alerts?state=firing', { refetchInterval: 30_000 });
  return data?.items.filter((a) => a.state === 'firing').length ?? 0;
}

const itemCls = 'flex items-center gap-3 rounded-md px-2.5 py-[7px] text-sm transition-colors duration-150';

function NavItems({ onNavigate, firing }: { onNavigate?: () => void; firing: number }) {
  return (
    <nav className="flex flex-col gap-0.5" aria-label="Main">
      {NAV.map(({ to, label, icon: I, end, badge }) => (
        <NavLink key={to} to={to} end={end} onClick={onNavigate}
          className={({ isActive }) => clsx(itemCls, isActive ? 'bg-surface-2 text-fg' : 'text-muted hover:bg-surface-2/60 hover:text-fg')}>
          <I className="size-4 shrink-0 text-muted" />
          <span className="flex-1">{label}</span>
          {badge === 'alerts' && firing > 0 && (
            <span className="text-xs font-medium tabular-nums text-bad" aria-label={`${firing} firing alerts`}>{firing > 99 ? '99+' : firing}</span>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

function UserFooter() {
  const { data } = useApi<AuthState>('/auth/state', { key: ['/auth/state'] });
  const qc = useQueryClient();
  const nav = useNavigate();
  const u = data?.user;
  const logout = async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* signed out anyway */ }
    qc.setQueryData<AuthState>(['/auth/state'], { setupRequired: false, user: null });
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== '/auth/state' });
    nav('/login', { replace: true });
  };
  return (
    <div className="border-t border-border pt-3">
      {u && (
        <div className="mb-1 px-2.5 py-1">
          <div className="truncate text-sm text-fg">{u.name || u.email}</div>
          <div className="truncate text-xs text-muted">{u.email}</div>
        </div>
      )}
      <button type="button" onClick={logout} className={clsx(itemCls, 'w-full text-muted hover:bg-surface-2/60 hover:text-fg cursor-pointer')}>
        <LogOut className="size-4 text-muted" />Logout
      </button>
    </div>
  );
}

// ───────────── ⌘K quick switcher ─────────────

interface Cmd { id: string; label: string; hint?: string; group: string; to: string; icon: Icon; dot?: ServerT['liveness'] }

function QuickSwitcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const servers = useApi<{ items: ServerT[] }>(open ? '/servers' : null);
  const apps = useApi<{ items: App[] }>(open ? '/apps' : null);

  useEffect(() => { if (open) { setQ(''); setSel(0); } }, [open]);

  const items = useMemo<Cmd[]>(() => {
    const all: Cmd[] = [
      ...(servers.data?.items ?? []).map((s) => ({ id: `s-${s.id}`, label: s.name, hint: s.host, group: 'Servers', to: `/servers/${s.id}`, icon: Server, dot: s.liveness })),
      ...(apps.data?.items ?? []).map((a) => ({ id: `a-${a.id}`, label: a.name, hint: a.domains[0] ?? a.status, group: 'Apps', to: `/apps/${a.id}`, icon: Boxes })),
      ...NAV.map((n) => ({ id: `p-${n.to}`, label: n.label, group: 'Pages', to: n.to, icon: n.icon })),
      { id: 'x-new-server', label: 'Add a server', group: 'Actions', to: '/servers/new', icon: Plus },
      { id: 'x-new-app', label: 'Deploy a new app', group: 'Actions', to: '/apps/new', icon: Plus },
    ];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all
      .map((c) => {
        const hay = `${c.label} ${c.hint ?? ''}`.toLowerCase();
        const i = hay.indexOf(needle);
        return { c, score: i < 0 ? -1 : (c.label.toLowerCase().startsWith(needle) ? 0 : 1) + i / 100 };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score)
      .map((x) => x.c);
  }, [servers.data, apps.data, q]);

  useEffect(() => { setSel((s) => Math.min(s, Math.max(0, items.length - 1))); }, [items.length]);
  useEffect(() => { listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  if (!open) return null;
  const go = (c: Cmd | undefined) => { if (!c) return; onClose(); nav(c.to); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % Math.max(1, items.length)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + items.length) % Math.max(1, items.length)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(items[sel]); }
    else if (e.key === 'Escape') onClose();
  };

  let lastGroup = '';
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Quick switcher">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-full max-w-xl overflow-hidden rounded-md border border-border-strong bg-surface">
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search className="size-4 text-muted" />
          <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }} onKeyDown={onKey}
            placeholder="Jump to a server, app or page…" aria-label="Search"
            className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-faint" />
          <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted">esc</kbd>
        </div>
        <div ref={listRef} className="dx-scroll max-h-[50vh] overflow-y-auto p-1.5">
          {items.length === 0 && <div className="px-3 py-8 text-center text-sm text-muted">Nothing matches “{q}”.</div>}
          {items.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            const I = c.icon;
            return (
              <div key={c.id}>
                {header && <div className="px-2.5 pb-1 pt-2 text-xs text-faint">{header}</div>}
                <button type="button" data-idx={i} onMouseMove={() => setSel(i)} onClick={() => go(c)}
                  className={clsx('flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm cursor-pointer', sel === i ? 'bg-surface-2' : '')}>
                  <I className="size-4 shrink-0 text-muted" />
                  <span className="truncate text-fg">{c.label}</span>
                  {c.dot && <LiveDot state={c.dot} />}
                  {c.hint && <span className="ml-auto truncate text-xs text-muted">{c.hint}</span>}
                  {sel === i && <CornerDownLeft className={clsx('size-3.5 shrink-0 text-muted', !c.hint && 'ml-auto')} />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ───────────── shell ─────────────

export default function Layout() {
  const firing = useFiringCount();
  const health = useApi<Health>('/health', { staleTime: 5 * 60_000 });
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const loc = useLocation();

  useEffect(() => { setDrawer(false); }, [loc.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    document.title = firing > 0 ? `(${firing}) Docksy` : 'Docksy';
  }, [firing]);

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const version = health.data?.version;

  const sidebar = (onNavigate?: () => void) => (
    <>
      <div className="mb-5 flex items-start gap-2.5 px-2.5 pt-1">
        <img src="/favicon.svg" alt="" className="mt-0.5 size-7" />
        <div className="min-w-0">
          <NavLink to="/" onClick={onNavigate} className="block text-xl font-semibold leading-tight">Docksy</NavLink>
          <div className="text-xs text-muted">{version ? `v${version}` : ' '}</div>
        </div>
      </div>
      <button type="button" onClick={() => { onNavigate?.(); setPalette(true); }}
        className="mb-5 flex h-8 items-center gap-2 rounded-md border border-border bg-bg px-2.5 text-sm text-muted transition-colors duration-150 hover:border-border-strong hover:text-fg cursor-pointer">
        <Search className="size-4" /><span className="flex-1 text-left">Search</span>
        <kbd className="font-sans text-xs text-faint">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <NavItems onNavigate={onNavigate} firing={firing} />
      <div className="mt-auto">
        <UserFooter />
      </div>
    </>
  );

  return (
    <div className="flex min-h-full bg-bg">
      <div className="hidden w-56 shrink-0 border-r border-border bg-surface md:block">
        <aside className="sticky top-0 flex h-screen flex-col px-3 py-4">
          {sidebar()}
        </aside>
      </div>

      {/* mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/70" onClick={() => setDrawer(false)} />
          <aside className="relative flex h-full w-64 max-w-[85vw] flex-col border-r border-border bg-surface px-3 py-4">
            <button type="button" onClick={() => setDrawer(false)} className="absolute right-3 top-4 rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg cursor-pointer" aria-label="Close menu"><X className="size-4" /></button>
            {sidebar(() => setDrawer(false))}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* mobile top bar */}
        <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-border bg-surface px-2 md:hidden">
          <button type="button" onClick={() => setDrawer(true)} className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-fg cursor-pointer" aria-label="Open menu"><Menu className="size-5" /></button>
          <NavLink to="/" className="flex items-center gap-2"><img src="/favicon.svg" alt="" className="size-6" /><span className="font-semibold">Docksy</span></NavLink>
          <div className="ml-auto flex items-center gap-1">
            <button type="button" onClick={() => setPalette(true)} className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-fg cursor-pointer" aria-label="Search"><Search className="size-4" /></button>
            <NavLink to="/alerts" className="flex items-center gap-1 rounded-md p-2 text-muted hover:bg-surface-2 hover:text-fg" aria-label={`Alerts${firing ? `, ${firing} firing` : ''}`}>
              <Bell className="size-4" />
              {firing > 0 && <span className="text-xs font-medium tabular-nums text-bad">{firing}</span>}
            </NavLink>
          </div>
        </header>
        <main className="mx-auto w-full min-w-0 max-w-[1400px] flex-1 px-4 py-6 md:px-8 md:py-8">
          <Outlet />
        </main>
      </div>

      <QuickSwitcher open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}
