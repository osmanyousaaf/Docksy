/** Builds the Docksy MCP server (tools, resources, prompts). Reusable in-process, e.g. by `docksy mcp`. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DocksyApi } from './api.ts';
import type { McpConfig } from './config.ts';
import { registerPrompts } from './prompts.ts';
import { registerResources } from './resources.ts';
import { registerTools, type ToolDef } from './registry.ts';
import { ALL_TOOLS } from './tools/index.ts';

export const VERSION = '0.1.0';

export const INSTRUCTIONS = `Docksy is a self-hosted PaaS: it deploys apps and databases to the user's own servers (VPS) with Docker and Caddy, and monitors them (CPU, memory, disk, network, containers, alerts, uptime).

How to work with it:
- Start broad: get_fleet_overview for "how is everything?", list_servers / list_apps to find ids. Tools accept names as well as ids.
- When something is slow, down or alerting, call diagnose first; it returns findings by severity with evidence and suggested fix tool calls. Confirm with get_server_metrics, list_containers, get_app_logs, get_deployment_logs.
- Deploy flow: create_app → set_env_vars (if needed) → deploy_app (wait: true). Broken deploy in production → rollback_app.
- Ask the user before any change to production. Destructive tools (delete_app, delete_server, restore_backup) need confirm: true, and only after the user explicitly agreed.
- Never print secret values (env vars, tokens) back to the user.`;

export interface CreateServerOptions {
  api: DocksyApi;
  readonly?: boolean;
  tools?: ToolDef[];
}

export function createDocksyMcpServer(opts: CreateServerOptions): { server: McpServer; toolNames: string[] } {
  const readonly = !!opts.readonly;
  const server = new McpServer(
    { name: 'docksy', title: 'Docksy', version: VERSION },
    {
      instructions: readonly ? `${INSTRUCTIONS}\n- This server is in READ-ONLY mode (DOCKSY_READONLY=1): only read tools are available; tell the user what you would change instead.` : INSTRUCTIONS,
      capabilities: { tools: {}, resources: {}, prompts: {} },
    },
  );
  const toolNames = registerTools(server, opts.tools ?? ALL_TOOLS, { api: opts.api }, { readonly });
  registerResources(server, opts.api);
  registerPrompts(server);
  return { server, toolNames };
}

export function apiFromConfig(config: McpConfig, fetchImpl?: typeof fetch): DocksyApi {
  return new DocksyApi({ url: config.url, token: config.token, fetch: fetchImpl, userAgent: `docksy-mcp/${VERSION}` });
}

/** Serves MCP over stdin/stdout until the client disconnects. Logs go to stderr only. */
export async function runStdio(config: McpConfig): Promise<void> {
  const { server } = createDocksyMcpServer({ api: apiFromConfig(config), readonly: config.readonly });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`docksy-mcp ${VERSION} ready on stdio → ${config.url}${config.readonly ? ' (read-only)' : ''}\n`);
}
