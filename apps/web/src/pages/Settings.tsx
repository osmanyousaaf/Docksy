/** Settings: Coolify-style sub-navigation with flat forms on the page background. */
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ExternalLink, Plus } from 'lucide-react';
import type { ApiToken, CreateTokenResponse, Health, Settings as SettingsT, SshKeyInfo, TokenScope } from '@docksy/shared';
import { api, useApi, useApiMutation } from '../lib/api.ts';
import { timeAgo } from '../lib/format.ts';
import { Button, Checkbox, EmptyState, ErrorBox, Field, FieldGrid, Input, Loading, PageHeader, Section, Select, SubNavLayout, Table } from '../components/ui.tsx';
import { CodeBlock, ConfirmDialog, CopyField, useParamState } from '../features/admin/kit.tsx';

const SECTIONS = ['general', 'status-page', 'monitoring', 'tokens', 'ssh-key', 'about'] as const;
type SectionId = (typeof SECTIONS)[number];

/** Local form state for a subset of settings, with dirty tracking and a PATCH of only the changed keys. */
function useSettingsForm<K extends keyof SettingsT>(s: SettingsT, keys: K[]) {
  const pick = () => Object.fromEntries(keys.map((k) => [k, s[k]])) as Pick<SettingsT, K>;
  const [f, setF] = useState(pick);
  const [saved, setSaved] = useState(false);
  // Reset when the server copy changes.
  useEffect(() => setF(pick()), [s]);
  const changes = Object.fromEntries(keys.filter((k) => f[k] !== s[k]).map((k) => [k, f[k]])) as Partial<SettingsT>;
  const dirty = Object.keys(changes).length > 0;
  const save = useApiMutation<Partial<SettingsT>, SettingsT>('PATCH', '/settings', ['/settings']);
  const set = (p: Partial<Pick<SettingsT, K>>) => { setSaved(false); setF((x) => ({ ...x, ...p })); };
  const submit = () => save.mutate(changes, { onSuccess: () => setSaved(true) });
  return { f, set, dirty, save, submit, saved: saved && !dirty };
}

function SaveButton({ dirty, loading, disabled, onClick, saved }: { dirty: boolean; loading: boolean; disabled?: boolean; onClick: () => void; saved: boolean }) {
  return (
    <span className="inline-flex items-center gap-3">
      <Button variant={dirty ? 'primary' : 'secondary'} disabled={!dirty || disabled} loading={loading} onClick={onClick}>Save</Button>
      {saved && <span className="text-xs text-muted">Saved.</span>}
    </span>
  );
}

// ───────────── general ─────────────

function General({ s }: { s: SettingsT }) {
  const { f, set, dirty, save, submit, saved } = useSettingsForm(s, ['instanceName', 'publicUrl']);
  const urlErr = f.publicUrl && !/^https?:\/\/[^\s/]+/.test(f.publicUrl) ? 'Use a full URL, for example https://docksy.example.com' : null;
  const isLocal = /localhost|127\.0\.0\.1/.test(f.publicUrl);
  return (
    <Section title="General" description="How this Docksy instance identifies itself and where it can be reached."
      actions={<SaveButton dirty={dirty} saved={saved} loading={save.isPending} disabled={!!urlErr || !f.instanceName.trim()} onClick={submit} />}>
      <FieldGrid>
        <Field label="Instance name" required help="Shown in the browser title and in alert notifications.">
          <Input value={f.instanceName} onChange={(e) => set({ instanceName: e.target.value })} />
        </Field>
        <Field label="Public URL" required help={urlErr
          ? <span className="text-bad">{urlErr}</span>
          : 'The address server agents report metrics to, GitHub sends push webhooks to, and Claude connects through. It must be reachable from your servers. No trailing slash.'}>
          <Input value={f.publicUrl} onChange={(e) => set({ publicUrl: e.target.value.trim() })} placeholder="https://docksy.example.com" spellCheck={false} className="font-mono text-xs" />
        </Field>
      </FieldGrid>
      {isLocal && <p className="mt-4 text-xs text-warn">A localhost URL only works for agents running on this same machine.</p>}
      <div className="mt-4"><ErrorBox error={save.error} /></div>
    </Section>
  );
}

// ───────────── status page ─────────────

function StatusPageSettings({ s }: { s: SettingsT }) {
  const { f, set, dirty, save, submit, saved } = useSettingsForm(s, ['statusPageEnabled', 'statusPageTitle']);
  const link = `${window.location.origin}/status`;
  return (
    <Section title="Status Page" description="A public page that lists the uptime checks marked as public."
      actions={<SaveButton dirty={dirty} saved={saved} loading={save.isPending} onClick={submit} />}>
      <div className="space-y-5">
        <Checkbox checked={f.statusPageEnabled} onChange={(v) => set({ statusPageEnabled: v })} label="Enable public status page"
          help="Anyone with the link can see the name, status and 90-day history of public checks. Nothing else is exposed." />
        <FieldGrid>
          <Field label="Title" required>
            <Input value={f.statusPageTitle} onChange={(e) => set({ statusPageTitle: e.target.value })} disabled={!f.statusPageEnabled} />
          </Field>
          <Field label="Public link" help={s.statusPageEnabled ? 'Share this link with your users.' : 'Available once the status page is enabled and saved.'}>
            <div className="flex gap-2">
              <div className="min-w-0 flex-1"><CopyField value={link} /></div>
              {s.statusPageEnabled && (
                <a href="/status" target="_blank" rel="noreferrer"><Button size="md" icon={<ExternalLink className="size-3.5" />}>Open</Button></a>
              )}
            </div>
          </Field>
        </FieldGrid>
        <p className="text-sm text-muted">Choose which checks are public on the <Link to="/uptime" className="text-fg underline underline-offset-2 hover:text-white">Uptime</Link> page.</p>
        <ErrorBox error={save.error} />
      </div>
    </Section>
  );
}

// ───────────── monitoring ─────────────

function Monitoring({ s }: { s: SettingsT }) {
  const { f, set, dirty, save, submit, saved } = useSettingsForm(s, ['metricsRetentionDays']);
  const days = Number(f.metricsRetentionDays);
  const daysErr = !Number.isInteger(days) || days < 1 || days > 3650 ? 'Enter a whole number of days between 1 and 3650.' : null;
  return (
    <Section title="Monitoring" description="How long Docksy keeps server and container metrics."
      actions={<SaveButton dirty={dirty} saved={saved} loading={save.isPending} disabled={!!daysErr} onClick={submit} />}>
      <FieldGrid>
        <Field label="Metrics retention (days)" required help={daysErr ? <span className="text-bad">{daysErr}</span> : 'Hourly rollups older than this are deleted.'}>
          <Input type="number" min={1} max={3650} value={Number.isFinite(days) ? f.metricsRetentionDays : ''} onChange={(e) => set({ metricsRetentionDays: Number(e.target.value) })} />
        </Field>
      </FieldGrid>
      <div className="mt-6 max-w-xl">
        <Table>
          <thead><tr><th>Resolution</th><th>Kept for</th></tr></thead>
          <tbody>
            <tr><td>Raw (every report)</td><td className="text-muted">48 hours</td></tr>
            <tr><td>1-minute rollups</td><td className="text-muted">14 days</td></tr>
            <tr><td>1-hour rollups</td><td className="text-muted">{s.metricsRetentionDays} days</td></tr>
          </tbody>
        </Table>
      </div>
      <div className="mt-4"><ErrorBox error={save.error} /></div>
    </Section>
  );
}

// ───────────── tokens ─────────────

function Tokens() {
  const { data, isLoading, error } = useApi<{ items: ApiToken[] }>('/tokens');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<TokenScope>('full');
  const [created, setCreated] = useState<CreateTokenResponse | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const create = useApiMutation<{ name: string; scope: TokenScope }, CreateTokenResponse>('POST', '/tokens', ['/tokens']);
  const revoke = useApiMutation<string, unknown>('DELETE', (id) => `/tokens/${encodeURIComponent(id)}`, ['/tokens']);
  const submit = () => name.trim() && create.mutate({ name: name.trim(), scope }, { onSuccess: (r) => { setCreated(r); setName(''); } });
  const rows = data?.items ?? [];

  return (
    <>
      <Section title="API Tokens" description={<>Tokens let the CLI, CI and Claude act on your behalf. <Link to="/claude" className="text-fg underline underline-offset-2">Connect Claude Code</Link></>}>
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="grid gap-4 md:grid-cols-[minmax(0,1fr)_200px_auto] md:items-end">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. laptop, github-actions" />
          </Field>
          <Field label="Scope" required>
            <Select value={scope} onChange={(e) => setScope(e.target.value as TokenScope)}>
              <option value="full">Full access</option>
              <option value="read">Read only</option>
            </Select>
          </Field>
          <Button type="submit" variant="primary" icon={<Plus className="size-4" />} disabled={!name.trim()} loading={create.isPending} className="h-9">Create token</Button>
        </form>
        <p className="mt-1.5 text-xs text-muted">{scope === 'full' ? 'Full access can deploy, change settings and delete resources.' : 'Read only can view everything and change nothing.'}</p>
        <div className="mt-3"><ErrorBox error={create.error} /></div>

        {created && (
          <div className="mt-6 rounded-md border border-border-strong p-4">
            <div className="mb-1 text-sm font-medium">Token “{created.token.name}” created</div>
            <p className="mb-3 text-xs text-muted">Copy it now. It is shown only once.</p>
            <CopyField value={created.plaintext} />
            <div className="mt-3 flex justify-end"><Button size="sm" variant="ghost" onClick={() => setCreated(null)}>Done</Button></div>
          </div>
        )}

        <div className="mt-8">
          {isLoading ? <Loading /> : error ? <ErrorBox error={error} /> : rows.length === 0 ? (
            <EmptyState title="No tokens yet">Create one above to use the CLI or connect Claude.</EmptyState>
          ) : (
            <Table>
              <thead><tr><th>Name</th><th>Token</th><th>Scope</th><th>Created</th><th>Last used</th><th /></tr></thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td className="font-medium">{t.name}</td>
                    <td className="whitespace-nowrap font-mono text-xs text-muted">{t.prefix}…</td>
                    <td className="whitespace-nowrap">{t.scope === 'read' ? 'Read only' : 'Full access'}</td>
                    <td className="whitespace-nowrap text-muted" title={new Date(t.createdAt).toLocaleString()}>{timeAgo(t.createdAt)}</td>
                    <td className="whitespace-nowrap text-muted">{t.lastUsedAt ? timeAgo(t.lastUsedAt) : 'Never'}</td>
                    <td className="text-right"><Button size="sm" variant="danger" onClick={() => setRevoking(t)}>Revoke</Button></td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </Section>
      <ConfirmDialog open={!!revoking} title={`Revoke “${revoking?.name}”?`} confirmLabel="Revoke token" loading={revoke.isPending}
        error={<ErrorBox error={revoke.error} />} onClose={() => setRevoking(null)}
        onConfirm={() => revoking && revoke.mutate(revoking.id, { onSuccess: () => setRevoking(null) })}>
        Anything using this token (CLI, CI, Claude) stops working immediately.
      </ConfirmDialog>
    </>
  );
}

// ───────────── ssh key ─────────────

function SshKey() {
  const { data, isLoading, error } = useApi<SshKeyInfo>('/ssh-key');
  return (
    <Section title="SSH Key" description="Docksy connects to your servers over SSH with this key. Authorize it on every server you add.">
      {isLoading ? <Loading /> : error ? <ErrorBox error={error} /> : data && (
        <div className="space-y-6">
          <Field label="Public key">
            <CopyField value={data.publicKey} />
          </Field>
          <Field label="Fingerprint">
            <Input readOnly value={data.fingerprint} className="font-mono text-xs" />
          </Field>
          <div>
            <div className="mb-1.5 text-sm">Authorize on a server</div>
            <p className="mb-3 text-xs text-muted">Run this once on the server as the SSH user Docksy will connect with (usually root).</p>
            <CodeBlock code={data.instructions} caption="Shell" wrap />
          </div>
          <p className="text-xs text-muted">The private key never leaves this machine. It is stored in the Docksy data directory.</p>
        </div>
      )}
    </Section>
  );
}

// ───────────── about ─────────────

function uptime(s: number) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function About() {
  const { data, error } = useApi<Health>('/health');
  const rows: [string, ReactNode][] = [
    ['Version', data ? <span className="font-mono text-xs">v{data.version.replace(/^v/, '')}</span> : '…'],
    ['Uptime', data ? uptime(data.uptimeSec) : '…'],
    ['License', 'Open source'],
    ['Source', <a href="https://github.com/osmanyousaaf/docksy" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-fg hover:underline">github.com/osmanyousaaf/docksy<ExternalLink className="size-3.5 text-muted" /></a>],
    ['Issues', <a href="https://github.com/osmanyousaaf/docksy/issues" target="_blank" rel="noreferrer" className="text-fg hover:underline">Report a problem</a>],
  ];
  return (
    <Section title="About" description="Free and open source, forever. No paid tiers and no telemetry.">
      <ErrorBox error={error} />
      <dl className="max-w-xl divide-y divide-border border-y border-border text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[140px_1fr] gap-4 py-2.5">
            <dt className="text-muted">{k}</dt><dd className="min-w-0">{v}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

// ───────────── page ─────────────

export default function Settings() {
  const s = useApi<SettingsT>('/settings');
  const [section, setSection] = useParamState<SectionId>('section', SECTIONS, 'general');
  const needsSettings = section === 'general' || section === 'status-page' || section === 'monitoring';
  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader title="Settings" subtitle="Instance configuration, access and maintenance." />
      <SubNavLayout value={section} onChange={(v) => setSection(v as SectionId)} items={[
        { id: 'general', label: 'General' },
        { id: 'status-page', label: 'Status Page' },
        { id: 'monitoring', label: 'Monitoring' },
        { id: 'tokens', label: 'API Tokens' },
        { id: 'ssh-key', label: 'SSH Key' },
        { id: 'about', label: 'About' },
      ]}>
        <div className="max-w-4xl">
          {needsSettings && (s.isLoading ? <Loading /> : s.error ? <ErrorBox error={s.error} /> : s.data && (
            <>
              {section === 'general' && <General s={s.data} />}
              {section === 'status-page' && <StatusPageSettings s={s.data} />}
              {section === 'monitoring' && <Monitoring s={s.data} />}
            </>
          ))}
          {section === 'tokens' && <Tokens />}
          {section === 'ssh-key' && <SshKey />}
          {section === 'about' && <About />}
        </div>
      </SubNavLayout>
    </div>
  );
}
