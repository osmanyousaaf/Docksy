/** Configuration → General and Source. */
import { useState } from 'react';
import type { App, BuildType } from '@docksy/shared';
import { Button, Checkbox, Field, FieldGrid, Input, Section, Select, Textarea, cx } from '../../../components/ui.tsx';
import { appNameError, parseDomains } from '../hooks.ts';
import { FieldError, SaveActions, SectionError, Subsection, lines, sameList, useSectionForm, type UpdateAppRequest } from './form.tsx';

const PACKS: { id: BuildType; label: string; help: string }[] = [
  { id: 'auto', label: 'Auto-detect', help: 'Uses the Dockerfile if the repository has one; otherwise detects Node.js, Python, Go or a static site and builds it.' },
  { id: 'dockerfile', label: 'Dockerfile', help: 'Builds the image from the Dockerfile at the location below.' },
  { id: 'compose', label: 'Docker Compose', help: 'Builds and runs every service in the Compose file below as one project.' },
  { id: 'image', label: 'Docker Image', help: 'Pulls and runs a prebuilt image from a registry. There is no build step.' },
];

/* ───────────────────────── General ───────────────────────── */

interface GeneralForm {
  name: string; description: string; pack: BuildType; repoUrl: string; branch: string; image: string;
  domains: string; port: string; buildContext: string; dockerfilePath: string; composePath: string;
  startCommand: string; watchPaths: string; autoDeploy: boolean;
}

const toGeneral = (a: App): GeneralForm => ({
  name: a.name, description: a.description ?? '', pack: a.buildType, repoUrl: a.repoUrl ?? '', branch: a.branch ?? 'main', image: a.image ?? '',
  domains: a.domains.join('\n'), port: a.port ? String(a.port) : '', buildContext: a.buildContext, dockerfilePath: a.dockerfilePath,
  composePath: a.composePath, startCommand: a.startCommand ?? '', watchPaths: a.watchPaths.join('\n'), autoDeploy: a.autoDeploy,
});

function diffGeneral(a: App, f: GeneralForm): UpdateAppRequest {
  const out: UpdateAppRequest = {};
  if (f.name.trim() !== a.name) out.name = f.name.trim();
  if ((f.description.trim() || null) !== a.description) out.description = f.description.trim() || null;
  const git = f.pack !== 'image';
  if (f.pack !== a.buildType) {
    out.buildType = f.pack;
    if (!git && a.sourceType === 'git') { out.sourceType = 'image'; if (f.image.trim() !== (a.image ?? '')) out.image = f.image.trim(); }
    if (git && a.sourceType === 'image') {
      out.sourceType = 'git';
      if (f.repoUrl.trim() !== (a.repoUrl ?? '')) out.repoUrl = f.repoUrl.trim();
      if (f.branch.trim() && f.branch.trim() !== (a.branch ?? '')) out.branch = f.branch.trim();
    }
  }
  const doms = parseDomains(f.domains);
  if (!sameList(doms, a.domains)) out.domains = doms;
  const port = f.port.trim() ? Number(f.port) : null;
  if (port !== a.port) out.port = port;
  if (git) {
    if (f.buildContext.trim() !== a.buildContext) out.buildContext = f.buildContext.trim();
    if (f.dockerfilePath.trim() !== a.dockerfilePath) out.dockerfilePath = f.dockerfilePath.trim();
    if (f.composePath.trim() !== a.composePath) out.composePath = f.composePath.trim();
    const wp = lines(f.watchPaths);
    if (!sameList(wp, a.watchPaths)) out.watchPaths = wp;
    if (f.autoDeploy !== a.autoDeploy) out.autoDeploy = f.autoDeploy;
  }
  if ((f.startCommand.trim() || null) !== a.startCommand) out.startCommand = f.startCommand.trim() || null;
  return out;
}

function validateGeneral(f: GeneralForm, a: App): Partial<Record<keyof GeneralForm, string>> {
  const p = Number(f.port);
  const switchingToGit = f.pack !== 'image' && a.sourceType === 'image';
  const switchingToImage = f.pack === 'image' && a.sourceType === 'git';
  return {
    name: f.name !== a.name ? appNameError(f.name) ?? undefined : undefined,
    port: f.port && (!Number.isInteger(p) || p < 1 || p > 65535) ? 'Port must be a number from 1 to 65535' : undefined,
    repoUrl: switchingToGit && !f.repoUrl.trim() ? 'A repository is required to build from git' : undefined,
    image: switchingToImage && !f.image.trim() ? 'An image reference is required' : undefined,
    description: f.description.length > 500 ? 'Keep it under 500 characters' : undefined,
  };
}

export function GeneralSection({ app, deployed }: { app: App; deployed: boolean }) {
  const form = useSectionForm(app, toGeneral, diffGeneral, validateGeneral);
  const { f, set, errors } = form;
  const git = f.pack !== 'image';
  const pack = PACKS.find((p) => p.id === f.pack) ?? PACKS[0];
  const doms = parseDomains(f.domains);
  const suggested = app.suggestedDomain;
  const generate = () => {
    if (!suggested || doms.includes(suggested)) return;
    set({ domains: [...doms, suggested].join('\n') });
  };

  return (
    <Section title="General" description="General configuration for your application." actions={<SaveActions form={form} savedText="Saved. Changes apply on the next deploy." />}>
      <SectionError error={form.error} />
      <FieldGrid>
        <Field label="Name" required help={deployed
          ? 'Fixed after the first deploy: containers, volumes and the default domain are named after it.'
          : 'Lowercase letters, digits and dashes. It can’t change after the first deploy.'}>
          <Input value={f.name} readOnly={deployed} onChange={(e) => set({ name: e.target.value.toLowerCase() })} spellCheck={false}
            className={cx(errors.name && 'border-bad/60')} aria-invalid={!!errors.name} />
          <FieldError>{errors.name}</FieldError>
        </Field>
        <Field label="Description">
          <Input value={f.description} onChange={(e) => set({ description: e.target.value })} placeholder="What this app does" />
          <FieldError>{errors.description}</FieldError>
        </Field>
        <Field label="Build Pack" required help={app.template ? 'Apps created from a template always run their image.' : pack.help}>
          <Select value={f.pack} disabled={!!app.template} onChange={(e) => set({ pack: e.target.value as BuildType })}>
            {PACKS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
        </Field>
        <Field label="Port" help="The port your app listens on inside the container. Traffic for the domains is routed here.">
          <Input value={f.port} onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })} inputMode="numeric" placeholder="3000"
            className={cx(errors.port && 'border-bad/60')} />
          <FieldError>{errors.port}</FieldError>
        </Field>
        {git && app.sourceType === 'image' && (
          <>
            <Field label="Repository URL" required help="Switching to a git build. You can add an access token under Source after saving.">
              <Input value={f.repoUrl} onChange={(e) => set({ repoUrl: e.target.value })} placeholder="https://github.com/acme/web" spellCheck={false} />
              <FieldError>{errors.repoUrl}</FieldError>
            </Field>
            <Field label="Branch">
              <Input value={f.branch} onChange={(e) => set({ branch: e.target.value })} placeholder="main" spellCheck={false} />
            </Field>
          </>
        )}
        {!git && app.sourceType === 'git' && (
          <Field label="Image" required help="Switching to a prebuilt image, e.g. ghcr.io/acme/web:1.4.">
            <Input value={f.image} onChange={(e) => set({ image: e.target.value })} placeholder="nginx:1.27-alpine" spellCheck={false} className="font-mono text-[13px]" />
            <FieldError>{errors.image}</FieldError>
          </Field>
        )}
      </FieldGrid>

      <Subsection title="Domains" description="One per line. The first is the primary domain. HTTPS certificates are issued automatically once DNS points at the server.">
        <div>
          <div className="flex items-start gap-2">
            <Textarea rows={Math.max(2, doms.length + 1)} value={f.domains} onChange={(e) => set({ domains: e.target.value })}
              placeholder={suggested ?? 'app.example.com'} spellCheck={false} aria-label="Domains" className="min-w-0 flex-1 resize-y font-sans text-sm" />
            <Button className="h-9" onClick={generate} disabled={!suggested || doms.includes(suggested)}
              title={suggested ? `Add ${suggested}` : 'No suggestion available for this server'}>Generate Domain</Button>
          </div>
          {suggested && !doms.includes(suggested) && <p className="mt-1.5 text-xs text-muted">Generate Domain adds <span className="font-mono text-fg">{suggested}</span>, a free wildcard DNS name that resolves to the server.</p>}
        </div>
      </Subsection>

      <Subsection title="Build" description={git ? undefined : 'This app runs a prebuilt image, so there is no build step. You can still override the start command.'}>
        <FieldGrid>
          {git && (
            <>
              <Field label="Base Directory" help="Directory inside the repository used as the build context.">
                <Input value={f.buildContext} onChange={(e) => set({ buildContext: e.target.value })} placeholder="." spellCheck={false} />
              </Field>
              {f.pack === 'compose' ? (
                <Field label="Docker Compose Location" help="Path to the Compose file, relative to the repository root.">
                  <Input value={f.composePath} onChange={(e) => set({ composePath: e.target.value })} placeholder="docker-compose.yml" spellCheck={false} />
                </Field>
              ) : (
                <Field label="Dockerfile Location" help={f.pack === 'auto' ? 'Used when present; otherwise Docksy generates one.' : 'Path to the Dockerfile, relative to the repository root.'}>
                  <Input value={f.dockerfilePath} onChange={(e) => set({ dockerfilePath: e.target.value })} placeholder="Dockerfile" spellCheck={false} />
                </Field>
              )}
            </>
          )}
          {f.pack !== 'compose' && (
            <Field label="Custom Start Command" help="Overrides the image’s default command (CMD). Leave empty to use the image default.">
              <Input value={f.startCommand} onChange={(e) => set({ startCommand: e.target.value })} placeholder="npm run start" spellCheck={false} className="font-mono text-[13px]" />
            </Field>
          )}
        </FieldGrid>
        {git && (
          <div className="mt-5 space-y-5">
            <Field label="Watch Paths" help="One glob per line, relative to the repository root. A push only triggers a deploy when a changed file matches. Leave empty to deploy on every push.">
              <Textarea rows={3} value={f.watchPaths} onChange={(e) => set({ watchPaths: e.target.value })} placeholder={'src/**\npackage.json'} spellCheck={false} />
            </Field>
            <Checkbox checked={f.autoDeploy} onChange={(v) => set({ autoDeploy: v })} label="Auto-deploy on push"
              help={`Deploy automatically when commits are pushed to ${app.branch ?? 'main'}. Requires the GitHub webhook (see Webhooks).`} />
          </div>
        )}
      </Subsection>
    </Section>
  );
}

/* ───────────────────────── Source ───────────────────────── */

interface SourceForm { repoUrl: string; branch: string; token: string; tokenMode: 'keep' | 'replace' | 'remove'; image: string }

const toSource = (a: App): SourceForm => ({ repoUrl: a.repoUrl ?? '', branch: a.branch ?? '', token: '', tokenMode: 'keep', image: a.image ?? '' });

function diffSource(a: App, f: SourceForm): UpdateAppRequest {
  const out: UpdateAppRequest = {};
  if (a.sourceType === 'git') {
    if (f.repoUrl.trim() !== (a.repoUrl ?? '')) out.repoUrl = f.repoUrl.trim();
    if (f.branch.trim() !== (a.branch ?? '')) out.branch = f.branch.trim();
    if (f.tokenMode === 'remove') out.gitToken = null;
    else if (f.token.trim() && (f.tokenMode === 'replace' || !a.hasGitToken)) out.gitToken = f.token.trim();
  } else if (f.image.trim() !== (a.image ?? '')) out.image = f.image.trim();
  return out;
}

const validateSource = (f: SourceForm, a: App) => ({
  repoUrl: a.sourceType === 'git' && !f.repoUrl.trim() ? 'A repository is required' : undefined,
  branch: a.sourceType === 'git' && !f.branch.trim() ? 'A branch is required' : undefined,
  image: a.sourceType === 'image' && !f.image.trim() ? 'An image reference is required' : undefined,
});

export function SourceSection({ app }: { app: App }) {
  const form = useSectionForm(app, toSource, diffSource, validateSource);
  const { f, set, errors } = form;
  const [showToken, setShowToken] = useState(false);
  const git = app.sourceType === 'git';

  return (
    <Section title="Source" description={git ? 'Where Docksy fetches your code from on each deploy.' : 'The container image Docksy pulls and runs on each deploy.'}
      actions={<SaveActions form={form} savedText="Saved. Changes apply on the next deploy." />}>
      <SectionError error={form.error} />
      {git ? (
        <FieldGrid>
          <Field label="Repository URL" required help="HTTPS URL or owner/repo for GitHub.">
            <Input value={f.repoUrl} onChange={(e) => set({ repoUrl: e.target.value })} placeholder="https://github.com/acme/web" spellCheck={false} />
            <FieldError>{errors.repoUrl}</FieldError>
          </Field>
          <Field label="Branch" required help="Deploys and push webhooks use this branch.">
            <Input value={f.branch} onChange={(e) => set({ branch: e.target.value })} placeholder="main" spellCheck={false} />
            <FieldError>{errors.branch}</FieldError>
          </Field>
          <div className="md:col-span-2">
            <Field label="Access Token" help="Needed for private repositories. Stored encrypted and never shown again.">
              {app.hasGitToken && f.tokenMode === 'keep' ? (
                <div className="flex items-center gap-2">
                  <Input readOnly value="••••••••••••  set" className="min-w-0 flex-1 font-mono" aria-label="Access token is set" />
                  <Button className="h-9" onClick={() => set({ tokenMode: 'replace', token: '' })}>Replace</Button>
                  <Button className="h-9" variant="danger" onClick={() => set({ tokenMode: 'remove', token: '' })}>Remove</Button>
                </div>
              ) : f.tokenMode === 'remove' ? (
                <div className="flex items-center gap-2">
                  <Input readOnly value="Token will be removed when you save" className="min-w-0 flex-1" />
                  <Button className="h-9" onClick={() => set({ tokenMode: 'keep' })}>Undo</Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Input type={showToken ? 'text' : 'password'} value={f.token} onChange={(e) => set({ token: e.target.value })}
                    placeholder="github_pat_…" autoComplete="off" spellCheck={false} className="min-w-0 flex-1 font-mono" />
                  <Button className="h-9" variant="ghost" onClick={() => setShowToken(!showToken)}>{showToken ? 'Hide' : 'Show'}</Button>
                  {app.hasGitToken && <Button className="h-9" onClick={() => set({ tokenMode: 'keep', token: '' })}>Cancel</Button>}
                </div>
              )}
            </Field>
          </div>
        </FieldGrid>
      ) : (
        <FieldGrid>
          <div className="md:col-span-2">
            <Field label="Image" required help={app.template
              ? `Created from the ${app.template} template. Changing the tag upgrades or downgrades it on the next deploy; check the vendor’s upgrade notes first.`
              : 'Any registry reference, e.g. ghcr.io/acme/web:1.4. Private registries must be logged in on the server.'}>
              <Input value={f.image} onChange={(e) => set({ image: e.target.value })} spellCheck={false} className="font-mono text-[13px]" />
              <FieldError>{errors.image}</FieldError>
            </Field>
          </div>
          {!app.template && (
            <p className="text-xs text-muted md:col-span-2">To build from a git repository instead, change the Build Pack under General.</p>
          )}
        </FieldGrid>
      )}
    </Section>
  );
}
