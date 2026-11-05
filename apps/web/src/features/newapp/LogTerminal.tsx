/** Plain dark deployment log: mono 12px, muted timestamps, red stderr, muted system lines. Auto-scrolls while following. */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { LogLine } from '@docksy/shared';
import { cx } from '../../components/ui.tsx';
import { stripAnsi } from './data.ts';

const time = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

export function LogTerminal({ lines, follow, onFollowChange, header, empty, className }: {
  lines: LogLine[]; follow: boolean; onFollowChange: (v: boolean) => void; header?: ReactNode; empty: ReactNode; className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const programmatic = useRef(false);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !follow) return;
    programmatic.current = true;
    el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onScroll = () => {
      if (programmatic.current) { programmatic.current = false; return; }
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      if (atBottom !== follow) onFollowChange(atBottom);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [follow, onFollowChange]);

  return (
    <div className={cx('flex flex-col overflow-hidden rounded-md border border-border bg-[#050505]', className)}>
      {header && <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">{header}</div>}
      <div ref={box} className="min-h-0 flex-1 overflow-auto py-2 font-mono text-[12px] leading-[1.6]">
        {lines.length === 0 ? (
          <div className="px-4 py-2 text-faint">{empty}</div>
        ) : lines.map((l, i) => (
          <div key={i} className="flex gap-4 px-4 hover:bg-white/[0.03]">
            <span className="shrink-0 select-none tabular-nums text-faint">{time(l.ts)}</span>
            <span className={cx('min-w-0 whitespace-pre-wrap break-words',
              l.stream === 'stderr' ? 'text-bad' : l.stream === 'system' ? 'text-muted' : 'text-[#d4d4d4]')}>
              {stripAnsi(l.line) || ' '}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function downloadLog(filename: string, lines: LogLine[]) {
  const text = lines.map((l) => `${l.ts} [${l.stream}] ${stripAnsi(l.line)}`).join('\n') + '\n';
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
