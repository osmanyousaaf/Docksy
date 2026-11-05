/** Terminal tab: run one command at a time inside the running container (POST /apps/:id/exec). */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Eraser } from 'lucide-react';
import type { App, ExecResponse } from '@docksy/shared';
import { ApiError } from '../../lib/api.ts';
import { Button, Callout, Spinner, cx } from '../../components/ui.tsx';
import { CopyButton } from './components.tsx';
import { execInApp } from './hooks.ts';

interface Entry { id: number; command: string; at: number; result?: ExecResponse; error?: string }

const EXAMPLES = ['ls -la', 'cat /etc/os-release', 'df -h', 'ps aux', 'printenv | sort'];
const HISTORY_MAX = 100;

function loadHistory(appId: string): string[] {
  try { return JSON.parse(sessionStorage.getItem(`docksy-exec-history:${appId}`) ?? '[]'); } catch { return []; }
}
function saveHistory(appId: string, h: string[]) {
  try { sessionStorage.setItem(`docksy-exec-history:${appId}`, JSON.stringify(h.slice(-HISTORY_MAX))); } catch { /* ignore */ }
}

export function TerminalTab({ app }: { app: App }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const history = useRef<string[]>(loadHistory(app.id));
  const cursor = useRef<number>(history.current.length);
  const draft = useRef('');
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const running = app.status === 'running';
  const container = [...entries].reverse().find((e) => e.result?.container)?.result?.container;

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, busy]);

  const run = async (raw: string) => {
    const command = raw.trim();
    if (!command || busy) return;
    if (command === 'clear') { setEntries([]); setInput(''); return; }
    const h = history.current;
    if (h[h.length - 1] !== command) h.push(command);
    saveHistory(app.id, h);
    cursor.current = h.length;
    draft.current = '';
    setInput('');
    const id = nextId.current++;
    setEntries((xs) => [...xs, { id, command, at: Date.now() }]);
    setBusy(true);
    try {
      const result = await execInApp(app.id, command);
      setEntries((xs) => xs.map((x) => (x.id === id ? { ...x, result } : x)));
    } catch (e) {
      const msg = e instanceof ApiError || e instanceof Error ? e.message : String(e);
      setEntries((xs) => xs.map((x) => (x.id === id ? { ...x, error: msg } : x)));
    } finally {
      setBusy(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const h = history.current;
    if (e.key === 'Enter') { e.preventDefault(); void run(input); return; }
    if (e.key === 'ArrowUp') {
      if (!h.length) return;
      e.preventDefault();
      if (cursor.current === h.length) draft.current = input;
      cursor.current = Math.max(0, cursor.current - 1);
      setInput(h[cursor.current] ?? '');
    } else if (e.key === 'ArrowDown') {
      if (cursor.current >= h.length) return;
      e.preventDefault();
      cursor.current += 1;
      setInput(cursor.current === h.length ? draft.current : h[cursor.current] ?? '');
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      setEntries([]);
    }
  };

  return (
    <section>
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">Terminal</h2>
        {container && <span className="font-mono text-xs text-muted">{container}</span>}
      </div>
      <p className="mb-5 text-sm text-muted">Run a command inside the app’s running container.</p>
      <div className="mb-4">
        <Callout>
          Each command runs on its own with <code className="font-mono text-fg">sh -c</code> and a 30-second limit. There is no persistent shell, so
          {' '}<code className="font-mono text-fg">cd</code> and exported variables don’t carry over. Chain them instead, e.g.{' '}
          <code className="font-mono text-fg">cd /app &amp;&amp; ls</code>. Commands are recorded in the activity log.
        </Callout>
      </div>
      {!running && <div className="mb-4"><Callout tone="warn">This app isn’t running. Start or deploy it before running commands.</Callout></div>}

      <div className="flex h-[60vh] min-h-80 flex-col overflow-hidden rounded-md border border-border bg-[#050505]">
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2 text-xs text-muted">
          <span className="font-mono">{app.name}</span>
          <span className="text-faint">·</span>
          <span>{entries.length} command{entries.length === 1 ? '' : 's'}</span>
          <Button size="sm" variant="ghost" className="ml-auto h-6" icon={<Eraser className="size-3.5" />} onClick={() => setEntries([])} disabled={!entries.length}>Clear</Button>
        </div>
        <div ref={scroller} onClick={() => window.getSelection()?.isCollapsed && inputRef.current?.focus()}
          className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-[12px] leading-[1.65] text-[#d4d4d4]">
          {entries.length === 0 && (
            <div className="text-[#5c5c5c]">
              <div>Type a command and press Enter. ↑ and ↓ browse history; Ctrl+L clears.</div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span>Try:</span>
                {EXAMPLES.map((c) => (
                  <button key={c} type="button" disabled={!running || busy} onClick={() => void run(c)}
                    className="rounded border border-border px-2 py-0.5 text-[#a3a3a3] hover:border-border-strong hover:text-white disabled:opacity-50 cursor-pointer">{c}</button>
                ))}
              </div>
            </div>
          )}
          {entries.map((e) => <EntryBlock key={e.id} e={e} />)}
        </div>
        <form className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-2.5 font-mono text-[12px]"
          onSubmit={(ev) => { ev.preventDefault(); void run(input); }}>
          <span className="select-none text-[#8f8f8f]">$</span>
          <input ref={inputRef} value={input} onChange={(e) => { setInput(e.target.value); cursor.current = history.current.length; }} onKeyDown={onKey}
            disabled={!running} autoFocus={running} spellCheck={false} autoComplete="off" autoCapitalize="off" aria-label="Command"
            placeholder={running ? (busy ? 'Running…' : 'Enter a command') : 'Container not running'}
            className="min-w-0 flex-1 bg-transparent text-[#ededed] outline-none placeholder:text-[#3d3d3d] disabled:opacity-60" />
          {busy && <Spinner className="size-3.5" />}
          <Button size="sm" type="submit" disabled={!running || busy || !input.trim()}>Run</Button>
        </form>
      </div>
    </section>
  );
}

function EntryBlock({ e }: { e: Entry }) {
  const r = e.result;
  const out = r ? [r.stdout, r.stderr].filter(Boolean).join('') : '';
  return (
    <div className="group mb-4 last:mb-1">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="min-w-0 flex-1 break-all text-white"><span className="select-none text-[#8f8f8f]">$ </span>{e.command}</span>
        <span className="flex shrink-0 items-center gap-3 text-[11px] text-[#5c5c5c]">
          {r ? (
            <>
              <span className={cx(r.code === 0 ? 'text-ok' : 'text-bad')}>exit {r.code}</span>
              <span>{r.durationMs < 1000 ? `${r.durationMs} ms` : `${(r.durationMs / 1000).toFixed(1)} s`}</span>
              <span>{new Date(e.at).toLocaleTimeString()}</span>
              {out && <span className="opacity-0 transition-opacity group-hover:opacity-100"><CopyButton text={out} className="h-5 px-1" /></span>}
            </>
          ) : e.error ? <span className="text-bad">failed</span> : <span>running…</span>}
        </span>
      </div>
      {r && r.stdout && <pre className="mt-1 whitespace-pre-wrap break-all text-[#d4d4d4]">{r.stdout.replace(/\n$/, '')}</pre>}
      {r && r.stderr && <pre className="mt-1 whitespace-pre-wrap break-all text-[#f87171]">{r.stderr.replace(/\n$/, '')}</pre>}
      {r && !r.stdout && !r.stderr && <div className="mt-1 text-[#5c5c5c]">(no output)</div>}
      {e.error && <div className="mt-1 text-[#f87171]">{e.error}</div>}
    </div>
  );
}
