export function bytes(n: number | null | undefined, digits = 1): string {
  if (n == null || !isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${n < 0 ? '-' : ''}${v.toFixed(i === 0 ? 0 : digits)} ${u[i]}`;
}
export const rate = (n: number | null | undefined) => (n == null ? '—' : `${bytes(n)}/s`);
export const pct = (n: number | null | undefined, digits = 0) => (n == null || !isFinite(n) ? '—' : `${n.toFixed(digits)}%`);
export const ratio = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function duration(fromIso: string | null, toIso?: string | null): string {
  if (!fromIso) return '—';
  const ms = (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Color token for a usage percentage: ok < 70 ≤ warn < 90 ≤ bad */
export const usageTone = (p: number): 'ok' | 'warn' | 'bad' => (p >= 90 ? 'bad' : p >= 70 ? 'warn' : 'ok');
