/**
 * docksy-mcp: lets Claude deploy, monitor and fix servers managed by Docksy.
 *
 *   docksy-mcp                 stdio (what Claude Code / Claude Desktop launch)
 *   docksy-mcp --http [--port 3939]   streamable HTTP on 127.0.0.1 only
 *
 * Env: DOCKSY_URL, DOCKSY_TOKEN, DOCKSY_READONLY=1 (read tools only).
 */
import { ConfigError, loadConfig } from './config.ts';
import { runHttp } from './http.ts';
import { runStdio, VERSION } from './server.ts';

export { createDocksyMcpServer, runStdio, apiFromConfig, VERSION } from './server.ts';
export { runHttp } from './http.ts';
export { loadConfig, ConfigError } from './config.ts';

const HELP = `docksy-mcp ${VERSION}: the Docksy MCP server

Usage:
  docksy-mcp                     serve over stdio (default)
  docksy-mcp --http [--port N]   serve streamable HTTP on http://127.0.0.1:N/mcp (default 3939)

Environment:
  DOCKSY_URL        your Docksy instance, e.g. https://docksy.example.com   (required)
  DOCKSY_TOKEN      API token from Settings → API tokens (dsk_…)          (required)
  DOCKSY_READONLY   set to 1 to expose read-only tools only

Claude Code:
  claude mcp add docksy -e DOCKSY_URL=… -e DOCKSY_TOKEN=… -- npx -y @crovenai/docksy-mcp
`;

export interface CliArgs {
  http: boolean;
  port: number;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { http: false, port: 3939, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--http') out.http = true;
    else if (a === '--port' || a.startsWith('--port=')) {
      const v = a.includes('=') ? a.split('=')[1] : argv[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new ConfigError(`--port must be a number between 0 and 65535 (got "${v ?? ''}").`);
      out.port = n;
    } else if (a === '-h' || a === '--help') out.help = true;
    else if (a === '-v' || a === '--version') out.version = true;
    else if (a === '--stdio') out.http = false;
    else throw new ConfigError(`Unknown option "${a}". Run docksy-mcp --help.`);
  }
  return out;
}

export async function main(argv = process.argv.slice(2), env: Record<string, string | undefined> = process.env): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const config = loadConfig(env);
  if (args.http) {
    const h = await runHttp(config, args.port);
    process.stderr.write(`docksy-mcp ${VERSION} listening on ${h.url} → ${config.url}${config.readonly ? ' (read-only)' : ''}\n`);
    const stop = () => void h.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } else {
    await runStdio(config);
  }
}

/** True when this file is the process entry (node dist/docksy-mcp.js, or node src/index.ts). */
function isEntry(): boolean {
  const entry = process.argv[1] ?? '';
  return /(docksy-mcp(\.js)?|[\\/]mcp[\\/]src[\\/]index\.ts)$/.test(entry) || process.env.DOCKSY_MCP_FORCE_MAIN === '1';
}

if (isEntry()) {
  main().catch((e) => {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n`);
    } else {
      const err = e as NodeJS.ErrnoException;
      process.stderr.write(`docksy-mcp failed to start: ${err.code === 'EADDRINUSE' ? 'that port is already in use; pick another with --port' : (err?.message ?? String(e))}\n`);
    }
    process.exit(1);
  });
}
