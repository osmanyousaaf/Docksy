/** Step 2 of "New resource": one formal form on the page background (Coolify-style sections). */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Rocket } from 'lucide-react';
import type { App, BuildType, CreateAppRequest, Deployment, Server, Template } from '@docksy/shared';
import { api } from '../../lib/api.ts';
import { parseDotenv } from '../apps/env.ts';
import { Button, Checkbox, ErrorBox, Field, FieldGrid, Input, Section, Select, Textarea, cx } from '../../components/ui.tsx';
import { BUILD_PACKS, actions, appNameError, isIPv4, parseDomains, repoName, slugify, sslipDomain, useAction } from './data.ts';

export type Kind = 'git' | 'image' | 'template';

const err = (on: boolean) => cx(on && 'border-bad/60');
function FieldError({ msg }: { msg: string | null | false | undefined }) {
  return msg ? <p className="mt-1.5 text-xs text-bad">{msg}</p> : null;
}

export function ResourceForm({ kind, isPrivate, template, servers, defaultServerId }: {
  kind: Kind; isPrivate: boolean; template: Template | null; servers: Server[]; defaultServerId?: string | null;
}) {
  const navigate = useNavigate();
  const isDb = kind === 'template' && template?.kind === 'database';

  const [serverId, setServerId] = useState(() => {
    const pre = servers.find((s) => s.id === defaultServerId);
    return (pre ?? servers.find((s) => s.status === 'ready') ?? servers[0])?.id ?? '';
  });
  const server = servers.find((s) => s.id === serverId);

  const [name, setName] = useState(kind === 'template' && template ? template.id : '');
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState('');
  // source
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [gitToken, setGitToken] = useState('');
  const [image, setImage] = useState('');
  // build
  const [buildType, setBuildType] = useState<Exclude<BuildType, 'image'>>('auto');
  const [buildContext, setBuildContext] = useState('/');
  const [dockerfilePath, setDockerfilePath] = useState('/Dockerfile');
  const [composePath, setComposePath] = useState('/docker-compose.yml');
  const [startCommand, setStartCommand] = useState('');
  const [watchPaths, setWatchPaths] = useState('');
  // network
  const [port, setPort] = useState(template?.port ? String(template.port) : '');
  const [domains, setDomains] = useState('');
  const [healthcheckPath, setHealthcheckPath] = useState('');
  // limits
  const [cpu, setCpu] = useState('');
  const [mem, setMem] = useState('');
  // env
  const [envText, setEnvText] = useState('');
  const [autoDeploy, setAutoDeploy] = useState(true);
  const [tried, setTried] = useState(false);

  // Suggest a name from the source until the user types one.
  useEffect(() => {
    if (nameTouched) return;
    if (kind === 'git') setName(slugify(repoName(repoUrl)));
    else if (kind === 'image') setName(slugify((image.split('/').pop() ?? '').split(/[:@]/)[0] ?? ''));
  }, [kind, repoUrl, image, nameTouched]);

  const vars = useMemo(() => parseDotenv(envText), [envText]);
  const nVars = Object.keys(vars).length;
  const defaultDomain = sslipDomain(name, server?.host);
  const portNum = port.trim() ? Number(port) : undefined;
  const cpuNum = cpu.trim() ? Number(cpu) : null;
  const memNum = mem.trim() ? Number(mem) : null;

  const errors = {
    name: appNameError(name),
    server: !serverId ? 'Select a server.' : null,
    repo: kind === 'git' && !/^(https?:\/\/|git@)\S+$/.test(repoUrl.trim()) ? 'Enter a repository URL, e.g. https://github.com/acme/web.' : null,
    token: kind === 'git' && isPrivate && !gitToken.trim() ? 'A token is required for private repositories.' : null,
    image: kind === 'image' && !image.trim() ? 'Enter an image, e.g. nginx:alpine or ghcr.io/acme/web:latest.' : null,
    port: port.trim() && (!Number.isInteger(portNum) || portNum! < 1 || portNum! > 65535) ? 'Port must be between 1 and 65535.' : null,
    cpu: cpu.trim() && (!Number.isFinite(cpuNum) || cpuNum! <= 0) ? 'Use a positive number of cores, e.g. 0.5.' : null,
    mem: mem.trim() && (!Number.isInteger(memNum) || memNum! < 16) ? 'Use whole megabytes, at least 16.' : null,
    env: envText.trim() && nVars === 0 ? 'No KEY=value lines found.' : null,
  };
  const firstError = Object.values(errors).find(Boolean) ?? null;
  const show = (k: keyof typeof errors) => (tried ? errors[k] : null);

  const create = useAction(async (req: CreateAppRequest) => {
    const app = await api<App>('/apps', { method: 'POST', body: req });
    let dep: Deployment | null = null;
    try { dep = await actions.deploy(app.id); } catch { /* the app exists; it can be deployed from its page */ }
    return { app, dep };
  });

  const submit = () => {
    setTried(true);
    if (firstError) return;
    const common = {
      name, serverId,
      description: description.trim() || null,
      ...(nVars > 0 && { env: vars }),
      ...(!isDb && parseDomains(domains).length > 0 && { domains: parseDomains(domains) }),
      ...(cpuNum != null && { cpuLimit: cpuNum }),
      ...(memNum != null && { memLimitMb: memNum }),
    };
    const stripSlash = (p: string) => p.trim().replace(/^\/+/, '');
    let req: CreateAppRequest;
    if (kind === 'template') {
      req = { ...common, template: template!.id };
    } else if (kind === 'image') {
      req = {
        ...common, sourceType: 'image', image: image.trim(), buildType: 'image', port: portNum,
        healthcheckPath: healthcheckPath.trim() || null, startCommand: startCommand.trim() || null, autoDeploy: false,
      };
    } else {
      req = {
        ...common, sourceType: 'git', repoUrl: repoUrl.trim(), branch: branch.trim() || 'main', buildType, port: portNum,
        buildContext: stripSlash(buildContext) || '.',
        ...(buildType !== 'compose' && { dockerfilePath: stripSlash(dockerfilePath) || 'Dockerfile' }),
        ...(buildType === 'compose' && { composePath: stripSlash(composePath) || 'docker-compose.yml' }),
        ...(gitToken.trim() && { gitToken: gitToken.trim() }),
        healthcheckPath: healthcheckPath.trim() || null,
        startCommand: startCommand.trim() || null,
        watchPaths: watchPaths.split('\n').map((s) => s.trim()).filter(Boolean),
        autoDeploy,
      };
    }
    create.mutate(req, { onSuccess: ({ app, dep }) => navigate(dep ? `/deployments/${dep.id}` : `/apps/${app.id}`) });
  };

  const generate = () => { if (defaultDomain) setDomains(defaultDomain); };
  const serverHint = server && !isIPv4(server.host) ? `${name || 'app'}.<server-ip>.sslip.io` : null;

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
      <Section title="General" description="Name, description and the server this resource runs on.">
        <div className="space-y-5">
          <FieldGrid>
            <Field label="Name" required help={!show('name') && 'Lowercase letters, digits and dashes.'}>
              <Input value={name} onChange={(e) => { setNameTouched(true); setName(e.target.value.toLowerCase()); }}
                placeholder="my-app" spellCheck={false} className={err(!!show('name'))} />
              <FieldError msg={show('name')} />
            </Field>
            <Field label="Description">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
            </Field>
          </FieldGrid>
          <FieldGrid>
            <Field label="Server" required>
              <Select value={serverId} onChange={(e) => setServerId(e.target.value)} className={err(!!show('server'))}>
                {servers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.host}){s.status !== 'ready' ? `, ${s.status}` : ''}</option>)}
              </Select>
              <FieldError msg={show('server')} />
            </Field>
          </FieldGrid>
        </div>
      </Section>

      {kind === 'git' && (
        <Section title="Source" description={isPrivate ? 'The private repository to build. The token needs read access to its contents.' : 'The public repository to build.'}>
          <div className="space-y-5">
            <FieldGrid>
              <Field label="Repository URL" required>
                <Input autoFocus value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/acme/web" spellCheck={false} className={err(!!show('repo'))} />
                <FieldError msg={show('repo')} />
              </Field>
              <Field label="Branch" required>
                <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" spellCheck={false} />
              </Field>
            </FieldGrid>
            <FieldGrid>
              <Field label="Access token" required={isPrivate}
                help={!show('token') && (isPrivate ? 'A fine-grained GitHub token with Contents: read, or a GitLab deploy token.' : 'Optional. Only needed for private repositories.')}>
                <Input type="password" value={gitToken} onChange={(e) => setGitToken(e.target.value)} placeholder="github_pat_…" autoComplete="off" className={err(!!show('token'))} />
                <FieldError msg={show('token')} />
              </Field>
            </FieldGrid>
          </div>
        </Section>
      )}

      {kind === 'image' && (
        <Section title="Source" description="The container image to run. Public registries work without credentials.">
          <FieldGrid>
            <Field label="Image" required>
              <Input autoFocus value={image} onChange={(e) => setImage(e.target.value)} placeholder="nginx:alpine" spellCheck={false} className={err(!!show('image'))} />
              <FieldError msg={show('image')} />
            </Field>
          </FieldGrid>
        </Section>
      )}

      {kind === 'template' && template && (
        <Section title={template.name} description={template.description}>
          <dl className="grid gap-x-4 gap-y-4 text-sm sm:grid-cols-3">
            <div><dt className="mb-1 text-xs text-muted">Image</dt><dd className="font-mono text-[13px]">{template.image}</dd></div>
            <div><dt className="mb-1 text-xs text-muted">Port</dt><dd className="font-mono text-[13px]">{template.port ?? '—'}</dd></div>
            <div><dt className="mb-1 text-xs text-muted">Volumes</dt><dd className="font-mono text-[13px]">{template.volumes.map((v) => v.mountPath).join(', ') || '—'}</dd></div>
          </dl>
          {isDb && (
            <p className="mt-5 text-sm text-muted">
              Databases are not exposed publicly. Other apps reach it at <code className="font-mono text-fg">{name || template.id}:{template.port}</code> on the docksy network.
              Passwords are generated for you.
            </p>
          )}
        </Section>
      )}

      {kind === 'git' && (
        <Section title="Build" description="How Docksy turns your repository into an image.">
          <div className="space-y-5">
            <FieldGrid>
              <Field label="Build Pack" required help={BUILD_PACKS.find((b) => b.id === buildType)?.help}>
                <Select value={buildType} onChange={(e) => setBuildType(e.target.value as Exclude<BuildType, 'image'>)}>
                  {BUILD_PACKS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
                </Select>
              </Field>
            </FieldGrid>
            <FieldGrid>
              <Field label="Base Directory" help="Where the build runs, relative to the repository root.">
                <Input value={buildContext} onChange={(e) => setBuildContext(e.target.value)} placeholder="/" spellCheck={false} />
              </Field>
              {buildType === 'compose' ? (
                <Field label="Docker Compose Location">
                  <Input value={composePath} onChange={(e) => setComposePath(e.target.value)} placeholder="/docker-compose.yml" spellCheck={false} />
                </Field>
              ) : (
                <Field label="Dockerfile Location" help={buildType === 'auto' ? 'Used when present; otherwise the stack is detected.' : undefined}>
                  <Input value={dockerfilePath} onChange={(e) => setDockerfilePath(e.target.value)} placeholder="/Dockerfile" spellCheck={false} />
                </Field>
              )}
            </FieldGrid>
            <FieldGrid>
              <Field label="Custom Start Command" help="Overrides the image's default command.">
                <Input value={startCommand} onChange={(e) => setStartCommand(e.target.value)} placeholder="npm run start" spellCheck={false} />
              </Field>
              <Field label="Watch Paths" help="One glob per line. Pushes deploy only when a matching file changes.">
                <Textarea rows={1} value={watchPaths} onChange={(e) => setWatchPaths(e.target.value)} placeholder="services/api/**" spellCheck={false} className="min-h-9 resize-y" />
              </Field>
            </FieldGrid>
          </div>
        </Section>
      )}

      {!isDb && (
        <Section title="Network" description="The port your container listens on and the domains that route to it.">
          <div className="space-y-5">
            <FieldGrid>
              {kind !== 'template' && (
                <Field label="Port" help={!show('port') && 'The container port to route traffic to.'}>
                  <Input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} placeholder="3000" inputMode="numeric" className={err(!!show('port'))} />
                  <FieldError msg={show('port')} />
                </Field>
              )}
              {kind !== 'template' && (
                <Field label="Health Check Path" help="Optional. Deploys wait for this path to return 2xx.">
                  <Input value={healthcheckPath} onChange={(e) => setHealthcheckPath(e.target.value)} placeholder="/health" spellCheck={false} />
                </Field>
              )}
            </FieldGrid>
            <div>
              <Field label="Domains"
                help={<>Comma separated. Leave empty to use the default, <span className="font-mono text-fg/80">{defaultDomain ?? serverHint ?? `${name || 'app'}.<server-ip>.sslip.io`}</span>.</>}>
                <div className="flex gap-2">
                  <Input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder={defaultDomain ? `https://${defaultDomain}` : 'https://app.example.com'} spellCheck={false} />
                  <Button onClick={generate} disabled={!defaultDomain} className="h-9"
                    title={defaultDomain ? `Use ${defaultDomain}` : 'Available when the server host is an IPv4 address'}>Generate Domain</Button>
                </div>
              </Field>
            </div>
          </div>
        </Section>
      )}

      <Section title="Environment Variables" description={kind === 'template' ? 'Optional. Added to the template defaults; your values win.' : 'Paste the contents of a .env file. Values are stored encrypted.'}>
        <Field label=".env" help={show('env') ? undefined : nVars > 0 ? `${nVars} variable${nVars === 1 ? '' : 's'}: ${Object.keys(vars).slice(0, 6).join(', ')}${nVars > 6 ? ', …' : ''}` : 'KEY=value lines. Comments, export and quotes are supported.'}>
          <Textarea rows={6} value={envText} onChange={(e) => setEnvText(e.target.value)} spellCheck={false} className={err(!!show('env'))}
            placeholder={kind === 'template' ? '# .env\nKEY=value' : '# .env\nNODE_ENV=production\nDATABASE_URL=postgres://user:pass@postgres:5432/app'} />
          <FieldError msg={show('env')} />
        </Field>
        {kind === 'template' && template && Object.keys(template.env).length > 0 && (
          <p className="mt-3 text-xs text-muted">Template defaults: <span className="font-mono">{Object.keys(template.env).join(', ')}</span></p>
        )}
      </Section>

      <Section title="Resource Limits" description="Optional. Leave empty for no limit.">
        <FieldGrid>
          <Field label="CPU (cores)" help={!show('cpu') && 'For example 0.5 or 2.'}>
            <Input value={cpu} onChange={(e) => setCpu(e.target.value.replace(/[^\d.]/g, ''))} placeholder="No limit" inputMode="decimal" className={err(!!show('cpu'))} />
            <FieldError msg={show('cpu')} />
          </Field>
          <Field label="Memory (MB)" help={!show('mem') && 'For example 512.'}>
            <Input value={mem} onChange={(e) => setMem(e.target.value.replace(/\D/g, ''))} placeholder="No limit" inputMode="numeric" className={err(!!show('mem'))} />
            <FieldError msg={show('mem')} />
          </Field>
        </FieldGrid>
      </Section>

      {kind === 'git' && (
        <div className="mb-10">
          <Checkbox checked={autoDeploy} onChange={setAutoDeploy}
            label={<>Auto deploy on push to <code className="font-mono text-[13px]">{branch || 'main'}</code></>}
            help="Add the webhook shown on the app page to your repository after creation." />
        </div>
      )}

      <div className="flex flex-col-reverse gap-3 border-t border-border pt-6 sm:flex-row sm:items-center">
        <Button variant="primary" type="submit" icon={<Rocket className="size-4" />} loading={create.isPending}>Create & Deploy</Button>
        <Link to="/apps/new"><Button variant="ghost" className="w-full sm:w-auto">Back</Button></Link>
        <span className={cx('text-sm sm:ml-2', tried && firstError ? 'text-bad' : 'text-muted')}>
          {tried && firstError ? firstError : 'Creates the resource and starts the first deployment.'}
        </span>
      </div>
      {create.error && <div className="mt-4"><ErrorBox error={create.error} /></div>}
    </form>
  );
}
