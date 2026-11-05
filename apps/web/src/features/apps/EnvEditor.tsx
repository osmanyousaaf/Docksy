/** Key/value editor for environment variables with bulk .env paste. */
import { useState } from 'react';
import { ClipboardPaste, Eye, EyeOff, Plus, X } from 'lucide-react';
import { Button, Input, Textarea, cx } from '../../components/ui.tsx';
import { Modal } from './components.tsx';
import { mergeRows, parseDotenv, validateRows, type EnvRow } from './env.ts';

export function PasteEnvModal({ open, onClose, onApply }: { open: boolean; onClose: () => void; onApply: (vars: Record<string, string>) => void }) {
  const [text, setText] = useState('');
  const parsed = parseDotenv(text);
  const n = Object.keys(parsed).length;
  return (
    <Modal open={open} onClose={onClose} title="Paste a .env file" wide
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={n === 0} onClick={() => { onApply(parsed); setText(''); onClose(); }}>
          {n ? `Add ${n} variable${n === 1 ? '' : 's'}` : 'Add variables'}
        </Button>
      </>}>
      <p className="mb-3 text-sm text-muted">Paste <code className="font-mono">KEY=value</code> lines. Comments, <code className="font-mono">export</code> and quotes are fine. Existing keys are updated.</p>
      <Textarea autoFocus rows={12} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
        placeholder={'# .env\nDATABASE_URL=postgres://user:pass@postgres:5432/app\nNODE_ENV=production'} />
    </Modal>
  );
}

/**
 * Key/value table editor. Props are stable (also used by the New App page).
 * `hideToolbar` hides the bottom "Add variable / Paste .env" row when the caller renders its own.
 */
export function EnvEditor({ rows, onChange, readOnly, defaultHidden = true, hideToolbar }: {
  rows: EnvRow[]; onChange: (rows: EnvRow[]) => void; readOnly?: boolean; defaultHidden?: boolean; hideToolbar?: boolean;
}) {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [shown, setShown] = useState<Record<number, boolean>>({});
  const errs = validateRows(rows);
  const set = (i: number, patch: Partial<EnvRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const cols = readOnly ? 'grid-cols-[minmax(0,2fr)_minmax(0,3fr)]' : 'grid-cols-[minmax(0,2fr)_minmax(0,3fr)_40px]';

  return (
    <div>
      <div className="overflow-hidden rounded-md border border-border">
        <div className={cx('grid bg-surface text-xs font-medium text-muted', cols)}>
          <div className="px-3 py-2">Key</div>
          <div className="px-3 py-2">Value</div>
          {!readOnly && <div />}
        </div>
        {rows.length === 0 && <div className="border-t border-border px-3 py-6 text-center text-sm text-muted">No variables yet.</div>}
        {rows.map((r, i) => {
          const visible = !defaultHidden || shown[i];
          return (
            <div key={i} className="border-t border-border">
              <div className={cx('grid items-center gap-2 px-3 py-2', cols)}>
                <Input value={r.key} readOnly={readOnly} placeholder="KEY" spellCheck={false} aria-label="Variable name"
                  onChange={(e) => set(i, { key: e.target.value.replace(/\s/g, '') })}
                  onPaste={(e) => {
                    const t = e.clipboardData.getData('text');
                    if (t.includes('=') && (t.includes('\n') || /^[A-Za-z_][\w.-]*=/.test(t))) {
                      const vars = parseDotenv(t);
                      if (Object.keys(vars).length) { e.preventDefault(); onChange(mergeRows(rows.filter((_, j) => j !== i || r.key || r.value), vars)); }
                    }
                  }}
                  className={cx('font-mono text-[13px]', errs[i] && 'border-bad/60')} />
                <div className="relative">
                  <Input value={r.value} readOnly={readOnly} placeholder="value" spellCheck={false} aria-label={`Value of ${r.key || 'variable'}`}
                    type={visible ? 'text' : 'password'} autoComplete="off"
                    onChange={(e) => set(i, { value: e.target.value })} className={cx('font-mono text-[13px]', defaultHidden && 'pr-9')} />
                  {defaultHidden && (
                    <button type="button" onClick={() => setShown((s) => ({ ...s, [i]: !s[i] }))} aria-label={visible ? 'Hide value' : 'Show value'}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-fg cursor-pointer">
                      {visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    </button>
                  )}
                </div>
                {!readOnly && (
                  <button type="button" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove variable"
                    className="grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg cursor-pointer"><X className="size-4" /></button>
                )}
              </div>
              {errs[i] && <p className="px-3 pb-2 text-xs text-bad">{errs[i]}</p>}
            </div>
          );
        })}
      </div>
      {!readOnly && !hideToolbar && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => onChange([...rows, { key: '', value: '' }])}>Add variable</Button>
          <Button size="sm" variant="ghost" icon={<ClipboardPaste className="size-3.5" />} onClick={() => setPasteOpen(true)}>Paste .env</Button>
        </div>
      )}
      <PasteEnvModal open={pasteOpen} onClose={() => setPasteOpen(false)} onApply={(v) => onChange(mergeRows(rows, v))} />
    </div>
  );
}
