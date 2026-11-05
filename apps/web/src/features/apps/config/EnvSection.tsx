/** Configuration → Environment Variables. Masked by default; reveal to edit; saved with PUT /apps/:id/env. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardPaste, Eye, EyeOff, Plus } from 'lucide-react';
import type { App, EnvVars } from '@docksy/shared';
import { api, useApi } from '../../../lib/api.ts';
import { Button, Callout, ErrorBox, Loading, Section } from '../../../components/ui.tsx';
import { CopyButton } from '../components.tsx';
import { EnvEditor, PasteEnvModal } from '../EnvEditor.tsx';
import { mergeRows, rowsToVars, toDotenv, validateRows, varsToRows, type EnvRow } from '../env.ts';
import { useAction } from '../hooks.ts';
import { SaveStatus, SectionError } from './form.tsx';

const enc = encodeURIComponent;

export function EnvSection({ app }: { app: App }) {
  const base = `/apps/${enc(app.id)}/env`;
  const [revealed, setRevealed] = useState(false);
  const masked = useApi<EnvVars>(base, { staleTime: 0 });
  const real = useApi<EnvVars>(`${base}?reveal=1`, { enabled: revealed, staleTime: 0 });
  const [rows, setRows] = useState<EnvRow[] | null>(null);
  const pending = useRef<Record<string, string> | 'add' | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Start the editable draft once real values arrive; apply any queued "add"/"paste".
  useEffect(() => {
    if (!revealed || !real.data || rows !== null) return;
    let next = varsToRows(real.data.vars);
    const p = pending.current;
    pending.current = null;
    if (p === 'add') next = [...next, { key: '', value: '' }];
    else if (p) next = mergeRows(next, p);
    setRows(next);
  }, [revealed, real.data, rows]);

  const original = useMemo(() => JSON.stringify(real.data?.vars ?? {}), [real.data]);
  const draft = rows ? rowsToVars(rows) : null;
  const dirty = !!draft && JSON.stringify(draft) !== original;
  const invalid = rows ? Object.keys(validateRows(rows)).length > 0 : false;

  const save = useAction((vars: Record<string, string>) => api<EnvVars>(base, { method: 'PUT', body: { vars } }), [base]);

  const reveal = (then?: Record<string, string> | 'add') => {
    if (rows) {
      if (then === 'add') setRows([...rows, { key: '', value: '' }]);
      else if (then) setRows(mergeRows(rows, then));
      return;
    }
    pending.current = then ?? null;
    setRevealed(true);
  };
  const hide = () => {
    if (dirty && !confirm('Discard unsaved changes to environment variables?')) return;
    setRows(null);
    setRevealed(false);
  };

  const count = Object.keys(masked.data?.vars ?? {}).length;
  const shownRows = rows ?? varsToRows(masked.data?.vars ?? {});

  return (
    <Section title="Environment Variables" description="Key/value pairs passed to the container at runtime. Values are encrypted at rest."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!dirty || invalid} loading={save.isPending}
            onClick={() => draft && save.mutate(draft, { onSuccess: (r) => { setRows(varsToRows(r?.vars ?? draft)); setSavedAt(Date.now()); } })}>Save</Button>
          {dirty && <Button size="sm" variant="ghost" onClick={() => real.data && setRows(varsToRows(real.data.vars))}>Discard</Button>}
          <SaveStatus dirty={dirty} saved={!!savedAt && !dirty} savedText="Saved. Redeploy to apply." />
        </div>
      }>
      <SectionError error={save.error} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-muted">{count} variable{count === 1 ? '' : 's'}{!revealed && count > 0 ? ' · values hidden' : ''}</span>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => reveal('add')}>Add variable</Button>
          <Button size="sm" variant="ghost" icon={<ClipboardPaste className="size-3.5" />} onClick={() => setPasteOpen(true)}>Paste .env</Button>
          {rows && <CopyButton text={toDotenv(rowsToVars(rows))} label="Copy as .env" />}
          <Button size="sm" icon={revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />} onClick={() => (revealed ? hide() : reveal())}>
            {revealed ? 'Hide values' : 'Reveal values'}
          </Button>
        </div>
      </div>
      {masked.isLoading || (revealed && !rows && real.isLoading) ? <Loading /> : masked.error ? <ErrorBox error={masked.error} /> : real.error ? <ErrorBox error={real.error} /> : (
        <EnvEditor rows={shownRows} onChange={setRows} readOnly={!rows} defaultHidden={false} hideToolbar />
      )}
      <div className="mt-5">
        <Callout>{revealed ? 'Edit keys and values, then Save. ' : 'Reveal values to edit them. '}Changes apply on the next deploy. Pasting a .env file updates existing keys and adds new ones.</Callout>
      </div>
      <PasteEnvModal open={pasteOpen} onClose={() => setPasteOpen(false)} onApply={(v) => reveal(v)} />
    </Section>
  );
}
