/** Connect Claude Code: numbered steps, plain code blocks, tool reference and example prompts. */
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { CreateTokenResponse, Settings, TokenScope } from '@docksy/shared';
import { useApi, useApiMutation } from '../lib/api.ts';
import { Button, Checkbox, ErrorBox, Field, PageHeader, Select, Table } from '../components/ui.tsx';
import { CodeBlock, CopyButton, CopyField } from '../features/admin/kit.tsx';

type ToolGroup = { id: string; title: string; description: string; tools: [string, string][] };

const TOOLS: ToolGroup[] = [
  {
    id: 'read', title: 'Read', description: 'Always available, including with a read-only token.',
    tools: [
      ['get_fleet_overview', 'All servers with live CPU, memory, disk and firing alerts'],
      ['list_servers', 'Servers and their status'],
      ['get_server', 'One server in detail'],
      ['get_server_metrics', 'CPU, memory, disk, load and network over a time range'],
      ['list_containers', 'Containers on a server with CPU and memory use'],
      ['list_apps', 'Apps, databases and services'],
      ['get_app', 'One app: source, domains, status'],
      ['list_deployments', 'Deployment history for an app'],
      ['get_deployment_logs', 'Build and deploy log of a deployment'],
      ['get_app_logs', 'Recent runtime logs of an app'],
      ['diagnose', 'Rule-based report on what is wrong with a server or app'],
      ['list_alerts', 'Firing and resolved alerts'],
      ['list_alert_rules', 'Alert rules and thresholds'],
      ['list_uptime_checks', 'HTTP checks with 24h uptime and latency'],
      ['list_templates', 'One-click database and service templates'],
      ['list_backups', 'Backup schedules and recent runs'],
    ],
  },
  {
    id: 'write', title: 'Write', description: 'Hidden when DOCKSY_READONLY=1 or the token is read only.',
    tools: [
      ['create_app', 'Create an app from a repository, image or template'],
      ['update_app', 'Change domains, build settings or limits'],
      ['deploy_app', 'Start a deployment'],
      ['rollback_app', 'Return to a previous successful deployment'],
      ['restart_app', 'Restart the running container'],
      ['stop_app', 'Stop an app'],
      ['start_app', 'Start a stopped app'],
      ['set_env_vars', 'Set or remove environment variables'],
      ['create_server', 'Register a new server'],
      ['provision_server', 'Install Docker and the agent on a server'],
      ['create_alert_rule', 'Add an alert rule'],
      ['ack_alert', 'Acknowledge a firing alert'],
      ['create_uptime_check', 'Watch a URL'],
      ['create_backup', 'Schedule database backups'],
      ['run_backup', 'Run a backup now'],
    ],
  },
  {
    id: 'destructive', title: 'Destructive', description: 'Require confirm: true. The plugin asks you before running them.',
    tools: [
      ['delete_app', 'Remove an app and its containers'],
      ['delete_server', 'Remove a server with no apps'],
      ['restore_backup', 'Restore a database from a backup'],
    ],
  },
];

const PROMPTS = [
  'Why is prod-1 slow?',
  'Deploy github.com/acme/web to prod-1 at app.acme.com',
  'Add Postgres with daily verified backups',
  'An alert just fired. What happened and how do I fix it?',
  'The last deploy of api broke checkout. Roll it back.',
  'Write a production Dockerfile for this repo and deploy it',
];

const COMMANDS: [string, string][] = [
  ['/docksy:status', 'Fleet health at a glance'],
  ['/docksy:deploy', 'Deploy an app and follow the build'],
  ['/docksy:diagnose', 'Find out why a server or app misbehaves'],
  ['/docksy:logs', 'Read an app’s recent logs'],
  ['/docksy:rollback', 'Return to the last good version'],
];

function Step({ n, title, description, children }: { n: number; title: string; description: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-10 grid gap-x-4 sm:grid-cols-[32px_minmax(0,1fr)]">
      <div className="mb-2 grid size-7 place-items-center rounded-md border border-border-strong text-sm font-medium tabular-nums text-muted sm:mb-0">{n}</div>
      <div className="min-w-0">
        <h2 className="text-lg font-semibold leading-7">{title}</h2>
        <p className="mb-5 mt-1 text-sm text-muted">{description}</p>
        {children}
      </div>
    </section>
  );
}

export default function Claude() {
  const settings = useApi<Settings>('/settings');
  const url = (settings.data?.publicUrl || window.location.origin).replace(/\/+$/, '');
  const [scope, setScope] = useState<TokenScope>('full');
  const [readonly, setReadonly] = useState(false);
  const [created, setCreated] = useState<CreateTokenResponse | null>(null);
  const create = useApiMutation<{ name: string; scope: TokenScope }, CreateTokenResponse>('POST', '/tokens', ['/tokens']);

  const token = created?.plaintext ?? 'dsk_your_token_here';
  const ro = readonly || created?.token.scope === 'read';
  const envLine = `export DOCKSY_URL=${url}\nexport DOCKSY_TOKEN=${token}${ro ? '\nexport DOCKSY_READONLY=1' : ''}`;
  const mcpAdd = `claude mcp add docksy --scope user \\\n  -e DOCKSY_URL=${url} \\\n  -e DOCKSY_TOKEN=${token} \\${ro ? '\n  -e DOCKSY_READONLY=1 \\' : ''}\n  -- npx -y @crovenai/docksy-mcp`;
  const mcpJson = JSON.stringify({
    mcpServers: {
      docksy: {
        command: 'npx',
        args: ['-y', '@crovenai/docksy-mcp'],
        env: { DOCKSY_URL: url, DOCKSY_TOKEN: token, ...(ro && { DOCKSY_READONLY: '1' }) },
      },
    },
  }, null, 2);

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader title="Claude Code"
        subtitle="Connect Claude Code to Docksy to deploy, read metrics, tail logs, diagnose incidents and roll back from your terminal. Docksy never calls an AI model itself." />

      <div className="max-w-4xl">
        <Step n={1} title="Create a token" description={<>Claude uses an API token to act on your behalf. You can revoke it at any time in <Link to="/settings?section=tokens" className="text-fg underline underline-offset-2">Settings → API Tokens</Link>.</>}>
          {!created ? (
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-full sm:w-56">
                <Field label="Scope" required>
                  <Select value={scope} onChange={(e) => setScope(e.target.value as TokenScope)}>
                    <option value="full">Full access</option>
                    <option value="read">Read only</option>
                  </Select>
                </Field>
              </div>
              <Button variant="primary" className="h-9" loading={create.isPending}
                onClick={() => create.mutate({ name: `claude-code-${new Date().toISOString().slice(0, 10)}`, scope }, { onSuccess: setCreated })}>
                Create token
              </Button>
              <p className="basis-full text-xs text-muted">
                {scope === 'full' ? 'Claude can deploy, restart and change settings. Destructive actions still ask you first.' : 'Claude can view everything and change nothing. Suitable for diagnosis.'}
              </p>
              <div className="basis-full"><ErrorBox error={create.error} /></div>
            </div>
          ) : (
            <div>
              <Field label={`Token “${created.token.name}” · ${created.token.scope === 'read' ? 'Read only' : 'Full access'}`}
                help="Copy it now. It is shown only once. The snippets below already include it.">
                <CopyField value={created.plaintext} />
              </Field>
            </div>
          )}
        </Step>

        <Step n={2} title="Install the plugin" description="In Claude Code, add the Docksy marketplace and install the plugin. It brings the MCP server, skills, slash commands and an SRE agent.">
          <CodeBlock caption="Claude Code" code={'/plugin marketplace add osmanyousaaf/docksy\n/plugin install docksy@docksy'} />
        </Step>

        <Step n={3} title="Point Claude at Docksy" description="The plugin reads two environment variables. Without the plugin, register the MCP server directly or commit a project .mcp.json.">
          <div className="mb-5">
            <Checkbox checked={readonly} onChange={setReadonly} label="Read-only tools" help="Adds DOCKSY_READONLY=1 so Claude only sees read tools." />
          </div>
          <div className="space-y-5">
            <div>
              <div className="mb-1.5 text-sm">Environment (for the plugin)</div>
              <CodeBlock caption="~/.zshrc or ~/.bashrc" code={envLine} />
            </div>
            <div>
              <div className="mb-1.5 text-sm">Or register the MCP server</div>
              <CodeBlock caption="Shell" code={mcpAdd} />
            </div>
            <div>
              <div className="mb-1.5 text-sm">Or a project .mcp.json</div>
              <CodeBlock caption=".mcp.json" code={mcpJson} />
              <p className="mt-1.5 text-xs text-muted">Keep real tokens out of git. In a shared repository, reference environment variables instead.</p>
            </div>
          </div>
          {!created && <p className="mt-4 text-xs text-muted">Create a token in step 1 to fill in DOCKSY_TOKEN.</p>}
          {/localhost|127\.0\.0\.1|host\.docker\.internal/.test(url) && (
            <p className="mt-2 text-xs text-warn">The public URL is {url}. It only works for Claude on this machine. Set a reachable URL in Settings for other machines.</p>
          )}
        </Step>
      </div>

      <section className="mb-10">
        <h2 className="text-lg font-semibold">Tools</h2>
        <p className="mb-5 mt-1 text-sm text-muted">What Claude can do through the Docksy MCP server. Each call uses the same API as this dashboard.</p>
        <div className="grid gap-6 xl:grid-cols-3">
          {TOOLS.map((g) => (
            <div key={g.id} className="min-w-0">
              <div className="mb-1 flex items-baseline gap-2">
                <h3 className="text-sm font-semibold">{g.title}</h3>
                <span className="text-xs tabular-nums text-faint">{g.tools.length}</span>
              </div>
              <p className="mb-3 text-xs text-muted">{g.description}</p>
              <Table>
                <tbody className="[&_tr:first-child_td]:border-t-0">
                  {g.tools.map(([name, desc]) => (
                    <tr key={name}>
                      <td className="align-top py-2!">
                        <div className="font-mono text-xs">{name}</div>
                        <div className="mt-0.5 text-xs text-muted">{desc}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-10 xl:grid-cols-2">
        <section>
          <h2 className="text-lg font-semibold">Example prompts</h2>
          <p className="mb-5 mt-1 text-sm text-muted">Ask in plain language. Claude picks the tools.</p>
          <Table>
            <tbody className="[&_tr:first-child_td]:border-t-0">
              {PROMPTS.map((p) => (
                <tr key={p}>
                  <td>{p}</td>
                  <td className="w-20 text-right"><CopyButton text={p} /></td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
        <section>
          <h2 className="text-lg font-semibold">Slash commands</h2>
          <p className="mb-5 mt-1 text-sm text-muted">Included with the plugin.</p>
          <Table>
            <tbody className="[&_tr:first-child_td]:border-t-0">
              {COMMANDS.map(([c, d]) => (
                <tr key={c}>
                  <td className="w-44 whitespace-nowrap font-mono text-xs">{c}</td>
                  <td className="text-muted">{d}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      </div>
    </div>
  );
}
