/** Sign in: centered narrow form on black. */
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthState, LoginRequest, User } from '@docksy/shared';
import { api, useApi } from '../lib/api.ts';
import { Button, ErrorBox, Field, Input, Loading } from '../components/ui.tsx';
import { AuthShell, safeNext } from '../features/admin/kit.tsx';

export default function Login() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const nav = useNavigate();
  const qc = useQueryClient();
  const state = useApi<AuthState>('/auth/state', { key: ['/auth/state'] });
  const [form, setForm] = useState<LoginRequest>({ email: '', password: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (state.isLoading) return <Loading />;
  if (state.data?.setupRequired) return <Navigate to="/setup" replace />;
  if (state.data?.user) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await api<User>('/auth/login', { body: { email: form.email.trim(), password: form.password } });
      qc.setQueryData<AuthState>(['/auth/state'], { setupRequired: false, user });
      nav(next, { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Sign in" subtitle="Sign in to your Docksy control plane." footer="Free and open source. No telemetry.">
      <form onSubmit={submit} className="space-y-5">
        <Field label="Email">
          <Input id="email" type="email" autoComplete="email" required autoFocus
            value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@company.com" />
        </Field>
        <Field label="Password">
          <Input id="password" type="password" autoComplete="current-password" required
            value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <ErrorBox error={error} />
        <Button type="submit" variant="primary" loading={busy} className="h-9 w-full">Sign in</Button>
      </form>
    </AuthShell>
  );
}
