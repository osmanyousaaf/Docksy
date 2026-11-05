/** First run: create the owner account. Centered narrow form on black. */
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthState, SetupRequest, User } from '@docksy/shared';
import { api, useApi } from '../lib/api.ts';
import { Button, ErrorBox, Field, Input, Loading } from '../components/ui.tsx';
import { AuthShell } from '../features/admin/kit.tsx';

const MIN_PASSWORD = 8;

export default function Setup() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const state = useApi<AuthState>('/auth/state', { key: ['/auth/state'] });
  const [form, setForm] = useState<SetupRequest & { confirm: string }>({ name: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (state.isLoading) return <Loading />;
  if (state.data && !state.data.setupRequired) return <Navigate to={state.data.user ? '/' : '/login'} replace />;

  const longEnough = form.password.length >= MIN_PASSWORD;
  const matches = form.password.length > 0 && form.password === form.confirm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!longEnough) return setError(`Use at least ${MIN_PASSWORD} characters for your password.`);
    if (!matches) return setError('The two passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      const user = await api<User>('/auth/setup', { body: { name: form.name.trim(), email: form.email.trim(), password: form.password } satisfies SetupRequest });
      qc.setQueryData<AuthState>(['/auth/state'], { setupRequired: false, user });
      nav('/', { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Set up Docksy" subtitle="Create the owner account for this instance."
      footer="Free and open source. Your data stays on your server.">
      <form onSubmit={submit} className="space-y-5">
        <Field label="Name" required>
          <Input autoFocus required autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Email" required>
          <Input type="email" required autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@company.com" />
        </Field>
        <Field label="Password" required help={`At least ${MIN_PASSWORD} characters.`}>
          <Input type="password" required autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <Field label="Confirm password" required
          help={form.confirm && !matches ? <span className="text-bad">Passwords do not match.</span> : undefined}>
          <Input type="password" required autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
        </Field>
        <ErrorBox error={error} />
        <Button type="submit" variant="primary" loading={busy} className="h-9 w-full">Create owner account</Button>
      </form>
    </AuthShell>
  );
}
