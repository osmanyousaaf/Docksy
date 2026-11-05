/** MCP prompts: guided workflows Claude can run with the Docksy tools. */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

type Msg = { role: 'user'; content: { type: 'text'; text: string } };
const user = (text: string): { messages: Msg[] } => ({ messages: [{ role: 'user', content: { type: 'text', text } }] });

export function diagnoseServerPrompt(server?: string, symptom?: string): string {
  const target = server ? `the server "${server}"` : 'my servers';
  return [
    `Diagnose ${target} with the Docksy tools${symptom ? `. Symptom reported: ${symptom}` : ''}.`,
    '',
    'Steps:',
    server ? `1. Run \`diagnose\` with serverId "${server}".` : '1. Run `get_fleet_overview` to find the unhealthy server, then `diagnose` it.',
    '2. Confirm with evidence: `get_server_metrics` (range 1h, and 24h for trends), `list_containers` (sort by CPU/memory, look for restarts), and `get_app_logs` (filter "error|exception|fatal|killed") for any suspicious app. For a failed deploy, read `get_deployment_logs`.',
    '3. Explain the root cause in plain language, citing the numbers and log lines you saw.',
    '4. Propose a fix as concrete Docksy tool calls (e.g. restart_app, rollback_app, set_env_vars, provision_server) or server commands. Ask me before running anything that changes state.',
    '5. After a fix, re-run `diagnose` to verify, and acknowledge related alerts with `ack_alert`.',
  ].join('\n');
}

export function deployNewAppPrompt(source?: string, server?: string, name?: string): string {
  return [
    `Deploy a new app with Docksy${source ? ` from ${source}` : ''}${server ? ` on server "${server}"` : ''}${name ? ` named "${name}"` : ''}.`,
    '',
    'Steps:',
    `1. ${server ? `Check "${server}" with \`get_server\`` : 'Pick a server with `list_servers`'} (it must be status ready and online; if not, \`provision_server\`).`,
    '2. Work out the source: a git repo (look for a Dockerfile, package.json, requirements.txt, go.mod or index.html; if there is no Dockerfile, "auto" detects one, or write a good Dockerfile), a Docker image, or a one-click template (`list_templates`) for databases and services.',
    '3. Find the port the app listens on and a health endpoint if it has one. Ask me for any required environment variables or secrets; never invent secret values.',
    '4. `create_app` with name, serverId, source, port, healthcheckPath and env. Use domains only if I gave one (DNS must point at the server); otherwise the free sslip.io domain is used.',
    '5. `deploy_app` with wait: true. If it fails, read the log tail, fix the cause (Dockerfile, port, env) and redeploy.',
    '6. Report the live URL, and suggest `create_backup` for databases and that an uptime check is added automatically for apps with a domain.',
  ].join('\n');
}

export function incidentResponsePrompt(alert?: string, description?: string): string {
  return [
    `Run incident response with Docksy${alert ? ` for alert ${alert}` : ''}${description ? `: ${description}` : ''}.`,
    '',
    'Steps:',
    '1. Triage: `list_alerts` (state firing) and `get_fleet_overview`. State the impact (which apps or sites are affected, since when) in one or two sentences.',
    '2. Investigate: `diagnose` the affected server/app; check `list_deployments` for a recent deploy that lines up with the start of the incident; `get_app_logs` with an error filter; `list_uptime_checks`.',
    '3. Mitigate first, fix later. Prefer the fastest safe action: `rollback_app` if a deploy caused it, `restart_app` for a hung or leaking process, freeing disk (docker prune over SSH) for a full disk. Ask me before each change.',
    '4. Verify recovery: re-run `diagnose`, watch `get_server_metrics` (15m), confirm uptime checks are up; then `ack_alert`.',
    '5. Write a short incident summary: timeline, root cause, what was done, and follow-ups (alert rules, backups, resource limits).',
  ].join('\n');
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'diagnose_server',
    {
      title: 'Diagnose a server',
      description: 'Find out why a server or its apps are slow, down or alerting, and propose fixes.',
      argsSchema: {
        server: z.string().optional().describe('Server id, name or host (omit to check the whole fleet).'),
        symptom: z.string().optional().describe('What the user noticed, e.g. "site is slow".'),
      },
    },
    ({ server, symptom }) => user(diagnoseServerPrompt(server, symptom)),
  );

  server.registerPrompt(
    'deploy_new_app',
    {
      title: 'Deploy a new app',
      description: 'Take a repo, image or template to a live HTTPS URL on one of your servers.',
      argsSchema: {
        source: z.string().optional().describe('Git repo URL, Docker image, or template id (e.g. "postgres").'),
        server: z.string().optional().describe('Target server id or name.'),
        name: z.string().optional().describe('App name (lowercase slug).'),
      },
    },
    ({ source, server, name }) => user(deployNewAppPrompt(source, server, name)),
  );

  server.registerPrompt(
    'incident_response',
    {
      title: 'Incident response',
      description: 'Triage, mitigate and summarize a production incident (firing alert, outage, errors).',
      argsSchema: {
        alert: z.string().optional().describe('Alert id or title, if known.'),
        description: z.string().optional().describe('What is happening.'),
      },
    },
    ({ alert, description }) => user(incidentResponsePrompt(alert, description)),
  );
}
