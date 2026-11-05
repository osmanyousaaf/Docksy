/** Live runtime logs (SSE /apps/:id/logs/stream) in a terminal view. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Clock, Download, Eraser, Pause, Play, Search } from 'lucide-react';
import type { App } from '@docksy/shared';
import { useSSE } from '../../lib/api.ts';
import { Button, Callout, Input, cx } from '../../components/ui.tsx';
import { stripAnsi } from './ansi.ts';
import { Terminal, type TermLine } from './components.tsx';

const MAX_LINES = 5000;

export function ConnDot({ state }: { state: 'connecting' | 'open' | 'closed' }) {
  return (
    <span className={cx('flex items-center gap-1.5 text-xs', state === 'open' ? 'text-ok' : state === 'connecting' ? 'text-warn' : 'text-muted')}>
      <span className={cx('size-1.5 rounded-full', state === 'open' ? 'bg-ok' : state === 'connecting' ? 'bg-warn' : 'bg-faint')} />
      {state === 'open' ? 'Live' : state === 'connecting' ? 'Connecting…' : 'Disconnected'}
    </span>
  );
}

/** Line buffer with pause support. Lines arriving while paused are held and flushed on resume. */
export function useLineBuffer(max = MAX_LINES) {
  const [lines, setLines] = useState<TermLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [heldCount, setHeldCount] = useState(0);
  const held = useRef<TermLine[]>([]);
  const nextId = useRef(1);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  const append = useCallback((text: string, stream?: TermLine['stream'], ts?: string) => {
    const l: TermLine = { id: nextId.current++, text, stream, ts };
    if (pausedRef.current) { held.current.push(l); if (held.current.length > max) held.current.splice(0, held.current.length - max); setHeldCount(held.current.length); return; }
    setLines((prev) => { const next = prev.length >= max ? prev.slice(prev.length - max + 1) : prev.slice(); next.push(l); return next; });
  }, [max]);

  const setPause = (p: boolean) => {
    setPaused(p);
    if (!p && held.current.length) {
      const h = held.current;
      held.current = [];
      setHeldCount(0);
      setLines((prev) => [...prev, ...h].slice(-max));
    }
  };
  const clear = () => { held.current = []; setHeldCount(0); setLines([]); };
  return { lines, setLines, append, paused, setPause, clear, heldCount };
}

export function downloadText(name: string, lines: TermLine[]) {
  const blob = new Blob([lines.map((l) => stripAnsi(l.text)).join('\n')], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function LogsTab({ app }: { app: App }) {
  const buf = useLineBuffer();
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState('');
  const [showTs, setShowTs] = useState(false);
  const state = useSSE(`/apps/${encodeURIComponent(app.id)}/logs/stream`, (_e, data) => {
    const line = typeof data === 'string' ? data : data?.line;
    if (typeof line === 'string') buf.append(line, undefined, new Date().toISOString());
  }, ['log']);

  const wasOpen = useRef(false);
  useEffect(() => {
    if (state === 'open') {
      if (wasOpen.current) buf.append('— reconnected —', 'system');
      wasOpen.current = true;
    }
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  const notRunning = app.status !== 'running' && app.status !== 'deploying';

  return (
    <section>
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">Logs</h2>
        <ConnDot state={state} />
      </div>
      <p className="mb-5 text-sm text-muted">Live output from the running container (stdout and stderr). Build output is under each deployment.</p>
      {notRunning && <div className="mb-4"><Callout>This app isn’t running, so there may be no live output. Deploy or start it to see logs.</Callout></div>}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter lines" aria-label="Filter lines" className="h-8 w-56 pl-8" />
        </div>
        <span className="text-xs text-muted tabular-nums">{buf.lines.length} line{buf.lines.length === 1 ? '' : 's'}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button size="sm" variant={follow ? 'secondary' : 'ghost'} aria-pressed={follow} onClick={() => setFollow(!follow)}
            icon={<ArrowDownToLine className="size-3.5" />}>{follow ? 'Following' : 'Follow'}</Button>
          <Button size="sm" variant="ghost" onClick={() => buf.setPause(!buf.paused)}
            icon={buf.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}>
            {buf.paused ? `Resume${buf.heldCount ? ` (${buf.heldCount} new)` : ''}` : 'Pause'}
          </Button>
          <Button size="sm" variant="ghost" aria-pressed={showTs} onClick={() => setShowTs(!showTs)} icon={<Clock className="size-3.5" />}>{showTs ? 'Hide times' : 'Times'}</Button>
          <Button size="sm" variant="ghost" onClick={buf.clear} icon={<Eraser className="size-3.5" />}>Clear</Button>
          <Button size="sm" variant="ghost" onClick={() => downloadText(`${app.name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`, buf.lines)}
            disabled={buf.lines.length === 0} icon={<Download className="size-3.5" />}>Download</Button>
        </div>
      </div>
      <Terminal className="h-[64vh] min-h-80" lines={buf.lines} follow={follow} onFollowChange={setFollow} filter={filter} showTs={showTs}
        empty={state === 'open' ? 'Connected. Waiting for the container to write something…' : 'Connecting to the container…'} />
    </section>
  );
}
