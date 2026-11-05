/** login, logout, open, mcp */
import pc from 'picocolors';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DocksyApiError, normalizeBaseUrl } from '@crovenai/docksy-client';
import type { Ctx } from '../context.ts';
import { CliError } from '../context.ts';
import { resolveConnection } from '../config.ts';
import { sym } from '../format.ts';
import { ask } from '../prompt.ts';
import { resolveTarget } from '../resolve.ts';

export async function loginCmd(ctx: Ctx, rawUrl: string, o: { token?: string; email?: string }): Promise<void> {
  let url: string;
  try { url = normalizeBaseUrl(rawUrl); } catch { throw new CliError(`"${rawUrl}" doesn't look like a URL.`, { hint: 'Example: docksy login https://docksy.example.com' }); }
  const token = o.token ?? ctx.env.DOCKSY_TOKEN;
  const client = ctx.newClient(url, token);
  const state = await client.getAuthState();

  if (token) {
    if (!token.startsWith('dsk_')) throw new CliError('That does not look like a Docksy API token (they start with "dsk_").');
    let user;
    try { user = await client.me(); } catch (e) {
      if (e instanceof DocksyApiError && e.status === 401) throw new CliError('That token was rejected.', { hint: `Create a new one in ${url}/settings → API tokens.` });
      throw e;
    }
    ctx.saveConfig({ url, token, user: user.email });
    ctx.print(` ${sym.ok} Logged in to ${pc.cyan(url)} as ${pc.bold(user.email)}`);
    ctx.print(pc.dim(`   Saved to ${ctx.configPath}`));
    return;
  }

  if (state.setupRequired) {
    throw new CliError(`This Docksy instance has no owner yet.`, { hint: `Open ${url}/setup to create one, then run \`docksy login ${url}\` again.` });
  }
  const email = o.email ?? (await ask(ctx, `  Email: `));
  const password = await ask(ctx, `  Password: `, { hidden: true });
  if (!email || !password) throw new CliError('Email and password are required.');
  let user;
  try { user = await client.login({ email, password }); } catch (e) {
    if (e instanceof DocksyApiError && (e.status === 401 || e.status === 400)) throw new CliError('Wrong email or password.');
    if (e instanceof DocksyApiError && e.status === 429) throw new CliError('Too many login attempts. Wait a minute and try again.');
    throw e;
  }
  const created = await client.createToken({ name: `cli@${hostname()}`, scope: 'full' });
  await client.logout().catch(() => {}); // the CLI keeps the token, not the browser-style session
  ctx.saveConfig({ url, token: created.plaintext, user: user.email });
  ctx.print(` ${sym.ok} Logged in to ${pc.cyan(url)} as ${pc.bold(user.email)}`);
  ctx.print(pc.dim(`   Created API token "${created.token.name}" and saved it to ${ctx.configPath}`));
  ctx.print(`   Try: ${pc.cyan('docksy status')}`);
}

export async function logoutCmd(ctx: Ctx): Promise<void> {
  const cfg = ctx.loadConfig();
  if (!cfg.token) { ctx.print(' Already logged out.'); return; }
  ctx.saveConfig({ url: cfg.url });
  ctx.print(` ${sym.ok} Logged out. The token was removed from ${ctx.configPath}.`);
  ctx.print(pc.dim(`   It still works until you revoke it in ${cfg.url ?? 'Docksy'}/settings.`));
}

export async function whoamiCmd(ctx: Ctx, o: { json?: boolean }): Promise<void> {
  const conn = resolveConnection(ctx.loadConfig(), ctx.env);
  const user = await ctx.client().me();
  if (o.json) { ctx.print(JSON.stringify({ url: ctx.client().baseUrl, user, urlSource: conn.urlSource, tokenSource: conn.tokenSource }, null, 2)); return; }
  ctx.print(` ${pc.bold(user.email)} ${pc.dim(`(${user.role})`)} on ${pc.cyan(ctx.client().baseUrl)}${conn.tokenSource === 'env' ? pc.dim('  · token from DOCKSY_TOKEN') : ''}`);
}

export async function openCmd(ctx: Ctx, ref: string | undefined, o: { print?: boolean }): Promise<void> {
  const client = ctx.client();
  let path = '/';
  if (ref) {
    const t = await resolveTarget(client, ref);
    path = t.kind === 'server' ? `/servers/${encodeURIComponent(t.server.id)}` : `/apps/${encodeURIComponent(t.app.id)}`;
  }
  const url = client.baseUrl + path;
  ctx.print(` ${pc.cyan('↗')} ${url}`);
  if (!o.print) ctx.openUrl(url);
}

/** Find the installed MCP server's bin (works in the monorepo and when both packages are installed side by side). */
export function findMcpBin(from: string = import.meta.url): string | null {
  try {
    const req = createRequire(from);
    const pkgPath = req.resolve('@crovenai/docksy-mcp/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin?: string | Record<string, string> };
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['docksy-mcp'];
    if (!rel) return null;
    const bin = resolve(dirname(pkgPath), rel);
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/**
 * Run the MCP server in this process. The stdio server is bundled into the CLI; `--http` (and other flags)
 * hand over to the installed docksy-mcp bin. stdout belongs to the MCP protocol, so we only write to stderr.
 */
export async function mcpCmd(ctx: Ctx, args: string[]): Promise<void> {
  const conn = resolveConnection(ctx.loadConfig(), ctx.env);
  if (conn.url) process.env.DOCKSY_URL = conn.url;
  if (conn.token) process.env.DOCKSY_TOKEN = conn.token;

  if (args.length === 0) {
    const [{ runStdio }, { loadConfig, ConfigError: McpConfigError }] = await Promise.all([
      import('../../../mcp/src/server.ts'),
      import('../../../mcp/src/config.ts'),
    ]);
    let config;
    try {
      config = loadConfig(process.env);
    } catch (e) {
      if (e instanceof McpConfigError) {
        ctx.warn(e.message);
        throw new CliError('Connect the CLI first.', { hint: 'Run `docksy login <url>` (or set DOCKSY_URL and DOCKSY_TOKEN), then `docksy mcp`.' });
      }
      throw e;
    }
    await runStdio(config);
    return;
  }

  const bin = findMcpBin();
  if (!bin) {
    ctx.warn(` ${sym.warn} \`docksy mcp ${args.join(' ')}\` needs the standalone MCP package.`);
    ctx.warn(`   Run it with npx instead:  ${pc.cyan(`npx -y @crovenai/docksy-mcp ${args.join(' ')}`)}`);
    throw new CliError('MCP server package not found.', { exitCode: 1 });
  }
  process.argv = [process.argv[0], bin, ...args];
  await import(pathToFileURL(bin).href);
}
