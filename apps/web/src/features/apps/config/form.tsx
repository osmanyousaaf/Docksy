/** Shared pieces for the app Configuration sections: per-section form state, Save button, inline status. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { App, UpdateAppRequest as BaseUpdate } from '@docksy/shared';
import { Button, ErrorBox, cx } from '../../../components/ui.tsx';
import { useAppPatch } from '../hooks.ts';

/** PATCH body: the server also accepts null for port (unset) and gitToken (remove). */
export type UpdateAppRequest = Omit<BaseUpdate, 'port' | 'gitToken'> & { port?: number | null; gitToken?: string | null };

/**
 * Form state for one configuration section.
 * `toForm` maps the app to editable strings; `diff` returns only the changed PATCH fields;
 * `validate` returns field errors (any error disables Save).
 */
export function useSectionForm<F>(app: App, toForm: (a: App) => F, diff: (a: App, f: F) => UpdateAppRequest, validate?: (f: F, a: App) => Partial<Record<keyof F, string | undefined>>) {
  const [f, setF] = useState<F>(() => toForm(app));
  const dirtyRef = useRef(false);
  // Re-sync with the server copy when it changes, unless the user has unsaved edits.
  useEffect(() => { if (!dirtyRef.current) setF(toForm(app)); }, [app.id, app.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const changes = diff(app, f);
  const dirty = Object.keys(changes).length > 0;
  dirtyRef.current = dirty;
  const errors: Partial<Record<keyof F, string | undefined>> = validate?.(f, app) ?? {};
  const invalid = Object.values(errors).some(Boolean);
  const patch = useAppPatch(app.id);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => setSavedAt(null), 5000);
    return () => clearTimeout(t);
  }, [savedAt]);

  const save = () => {
    if (!dirty || invalid) return;
    patch.mutate(changes, {
      onSuccess: (a) => { dirtyRef.current = false; setF(toForm(a)); setSavedAt(Date.now()); },
    });
  };
  const reset = () => { patch.reset(); setF(toForm(app)); };
  const set = (p: Partial<F>) => { setSavedAt(null); setF((x) => ({ ...x, ...p })); };
  return { f, set, changes, dirty, errors, invalid, save, reset, pending: patch.isPending, error: patch.error, saved: !!savedAt && !dirty };
}

export type SectionForm = Pick<ReturnType<typeof useSectionForm>, 'dirty' | 'invalid' | 'save' | 'reset' | 'pending' | 'saved'>;

/** "Save" (+ "Discard" while dirty) and an inline status, placed next to a section title. */
export function SaveActions({ form, savedText = 'Saved', extra }: { form: SectionForm; savedText?: ReactNode; extra?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={!form.dirty || form.invalid} loading={form.pending} onClick={form.save}>Save</Button>
      {form.dirty && <Button size="sm" variant="ghost" onClick={form.reset} disabled={form.pending}>Discard</Button>}
      {extra}
      <SaveStatus dirty={form.dirty} saved={form.saved} savedText={savedText} />
    </div>
  );
}

export function SaveStatus({ dirty, saved, savedText = 'Saved' }: { dirty: boolean; saved: boolean; savedText?: ReactNode }) {
  if (saved) return <span className="inline-flex items-center gap-1.5 text-xs text-ok"><span className="size-1.5 rounded-full bg-ok" />{savedText}</span>;
  if (dirty) return <span className="text-xs text-muted">Unsaved changes</span>;
  return null;
}

/** Error banner shown at the top of a section's fields. */
export function SectionError({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="mb-5"><ErrorBox error={error} /></div>;
}

/** Second-level heading inside a section ("Domains", "Build"), like Coolify. */
export function Subsection({ title, description, children, className }: { title: ReactNode; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('mt-9', className)}>
      <h3 className="text-base font-semibold">{title}</h3>
      {description ? <p className="mb-4 mt-1 text-sm text-muted">{description}</p> : <div className="mb-3" />}
      {children}
    </div>
  );
}

export function FieldError({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <p className="mt-1.5 text-xs text-bad">{children}</p>;
}

/** Parse "one per line" text into a trimmed, de-duplicated list. */
export const lines = (s: string) => [...new Set(s.split('\n').map((l) => l.trim()).filter(Boolean))];
export const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
