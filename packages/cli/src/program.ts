/** Command definitions. `run(argv, ctx)` is the testable entry point; it returns the exit code. */
import { Command, CommanderError, Option } from 'commander';
import pc from 'picocolors';
import { DocksyApiError } from '@crovenai/docksy-client';
import { CliError, ExitCode, type Ctx } from './context.ts';
import { ConfigError } from './config.ts';
import { CLI_VERSION } from './version.ts';
import { ackCmd, alertsCmd, diagnoseCmd, metricsCmd, RANGES, statusCmd } from './commands/fleet.ts';
import { serversAdd, serversLs, serversProvision, serversRm } from './commands/servers.ts';
import { appsCreate, appsLs, appsRm, appsTemplates, appsWebhook, deployCmd, envCmd, logsCmd, rollbackCmd } from './commands/apps.ts';
import { loginCmd, logoutCmd, mcpCmd, openCmd, whoamiCmd } from './commands/auth.ts';

const collect = (v: string, prev: string[] = []) => [...prev, v];

const BANNER = () => `
  ${pc.bold(pc.cyan('▲'))} ${pc.bold('docksy')} ${pc.dim(`v${CLI_VERSION}`)}
  ${pc.dim('Deploy to your own servers. Monitoring on by default. Claude can fix it.')}
`;

const EXAMPLES = () => `
${pc.bold('Examples:')}
  ${pc.dim('$')} docksy login https://docksy.example.com
  ${pc.dim('$')} docksy servers add web-1 203.0.113.10 && docksy servers provision web-1
  ${pc.dim('$')} docksy apps create blog --repo https://github.com/me/blog --server web-1
  ${pc.dim('$')} docksy deploy blog --follow
  ${pc.dim('$')} docksy metrics web-1 --watch
  ${pc.dim('$')} docksy diagnose blog

${pc.bold('Environment:')}
  ${pc.yellow('DOCKSY_URL')}, ${pc.yellow('DOCKSY_TOKEN')}  override ~/.config/docksy/config.json
  ${pc.yellow('NO_COLOR')}, ${pc.yellow('--no-color')}     disable colors

${pc.dim('Docs & source: https://github.com/osmanyousaaf/docksy · free forever, no telemetry')}
`;

export function createProgram(ctx: Ctx): Command {
  const program = new Command('docksy');
  program
    .description('The Docksy command line: deploy apps, watch servers, and let Claude help.')
    .version(CLI_VERSION, '-v, --version', 'print the version')
    .helpOption('-h, --help', 'show help')
    .configureOutput({
      writeOut: (s) => { ctx.stdout.write(s); },
      writeErr: (s) => { ctx.stderr.write(s); },
      outputError: (s, write) => write(pc.red(s)),
      getOutHelpWidth: () => ctx.stdout.columns || 100,
      getErrHelpWidth: () => ctx.stderr.columns || 100,
    })
    .configureHelp({
      sortSubcommands: false,
      styleTitle: (s) => pc.bold(s),
      styleUsage: (s) => pc.cyan(s),
      styleCommandText: (s) => pc.bold(pc.cyan(s)),
      styleSubcommandText: (s) => pc.cyan(s),
      styleOptionText: (s) => pc.yellow(s),
      styleArgumentText: (s) => pc.magenta(s),
      styleDescriptionText: (s) => s,
    })
    .showSuggestionAfterError(true)
    .showHelpAfterError(pc.dim('(add --help for usage)'))
    .exitOverride()
    .helpCommand(false)
    .addHelpText('before', BANNER)
    .addHelpText('after', EXAMPLES);

  // ── Get started ──
  program.commandsGroup('Get started:');
  program.command('login')
    .description('connect the CLI to your Docksy instance')
    .argument('<url>', 'your Docksy URL, e.g. https://docksy.example.com')
    .option('-t, --token <token>', 'use an API token (dsk_…) instead of email + password')
    .option('-e, --email <email>', 'email to log in with')
    .action((url, o) => loginCmd(ctx, url, o));
  program.command('logout').description('forget the saved API token').action(() => logoutCmd(ctx));
  program.command('whoami').description('show who you are logged in as').option('--json', 'output JSON').action((o) => whoamiCmd(ctx, o));
  program.command('status')
    .description('fleet overview with live usage bars and sparklines')
    .option('-w, --watch', 'keep refreshing (full screen, q to quit)')
    .option('--json', 'output JSON')
    .action((o) => statusCmd(ctx, o));
  program.command('open')
    .description('open the web UI (optionally at a server or app)')
    .argument('[target]', 'server or app name')
    .option('-p, --print', 'only print the URL')
    .action((t, o) => openCmd(ctx, t, o));

  // ── Apps & deploys ──
  program.commandsGroup('Apps & deploys:');
  const apps = program.command('apps').description('list, create and delete apps');
  apps.command('ls', { isDefault: true }).alias('list').description('list apps')
    .option('-s, --server <server>', 'only apps on this server')
    .option('--json', 'output JSON')
    .action((o) => appsLs(ctx, o));
  apps.command('create').description('create an app from a git repo, a Docker image or a template')
    .argument('<name>', 'app name (lowercase letters, digits, dashes)')
    .option('-s, --server <server>', 'server to run it on (optional when you have one server)')
    .option('--repo <url>', 'git repository to build')
    .option('--branch <branch>', 'git branch', 'main')
    .option('--image <image>', 'Docker image to run, e.g. nginx:alpine')
    .option('--template <id>', 'one-click template, e.g. postgres (see `docksy apps templates`)')
    .addOption(new Option('--build <type>', 'how to build a repo').choices(['auto', 'dockerfile', 'compose']))
    .option('--dockerfile <path>', 'Dockerfile path in the repo')
    .option('--port <port>', 'container port to route traffic to')
    .option('-d, --domain <domain>', 'domain (repeatable; default <app>.<ip>.sslip.io)', collect)
    .option('--healthcheck <path>', 'HTTP path that must answer before traffic switches, e.g. /health')
    .option('-e, --env <KEY=value>', 'environment variable (repeatable)', collect)
    .option('--git-token <token>', 'token for private repos')
    .option('--no-auto-deploy', 'do not deploy on git push')
    .option('--deploy', 'deploy right away and follow the build')
    .option('--json', 'output JSON')
    .action((name, o) => appsCreate(ctx, name, o));
  apps.command('rm').alias('delete').description('delete an app (asks first)')
    .argument('<app>', 'app name or id')
    .option('--volumes', 'also delete its data volumes')
    .option('-y, --yes', 'skip the confirmation')
    .action((a, o) => appsRm(ctx, a, o));
  apps.command('templates').description('list one-click templates').option('--json', 'output JSON').action((o) => appsTemplates(ctx, o));
  apps.command('webhook').description('show the GitHub webhook URL and secret').argument('<app>').option('--json', 'output JSON').action((a, o) => appsWebhook(ctx, a, o));

  program.command('deploy')
    .description('deploy an app (zero downtime)')
    .argument('<app>', 'app name or id')
    .option('-f, --follow', 'stream the build log until it finishes')
    .option('--ref <ref>', 'git ref to deploy (default: the app branch)')
    .option('--json', 'output JSON')
    .action((a, o) => deployCmd(ctx, a, o));
  program.command('logs')
    .description('show runtime logs of an app')
    .argument('<app>', 'app name or id')
    .option('-f, --follow', 'keep streaming new lines')
    .option('-n, --tail <lines>', 'number of lines', '200')
    .option('--json', 'output JSON')
    .action((a, o) => logsCmd(ctx, a, o));
  program.command('rollback')
    .description('roll back to the last good deployment')
    .argument('<app>', 'app name or id')
    .argument('[deploymentId]', 'deployment to roll back to')
    .option('-f, --follow', 'stream the log until it finishes')
    .option('--json', 'output JSON')
    .action((a, d, o) => rollbackCmd(ctx, a, d, o));
  program.command('env')
    .description('manage environment variables')
    .argument('<app>', 'app name or id')
    .argument('[action]', 'ls (default), set or unset')
    .argument('[args...]', 'KEY=value pairs for set, KEY names for unset')
    .option('--reveal', 'show values instead of masking them')
    .option('--json', 'output JSON')
    .addHelpText('after', `\n${pc.bold('Examples:')}\n  docksy env blog\n  docksy env blog set NODE_ENV=production API_URL=https://api.example.com\n  docksy env blog unset DEBUG`)
    .action((a, act, args, o) => envCmd(ctx, a, act, args, o));

  // ── Servers & monitoring ──
  program.commandsGroup('Servers & monitoring:');
  const servers = program.command('servers').description('list, add, provision and remove servers');
  servers.command('ls', { isDefault: true }).alias('list').description('list servers').option('--json', 'output JSON').action((o) => serversLs(ctx, o));
  servers.command('add').description('add a server reachable over SSH')
    .argument('<name>', 'a short name, e.g. web-1')
    .argument('<host>', 'IP address or hostname')
    .option('-p, --port <port>', 'SSH port', '22')
    .option('-u, --user <user>', 'SSH user', 'root')
    .option('--no-validate', 'skip the SSH / Docker checks')
    .option('--provision', 'provision right away when checks pass')
    .option('--json', 'output JSON')
    .action((n, h, o) => serversAdd(ctx, n, h, o));
  servers.command('rm').alias('delete').description('remove a server from Docksy (asks first)')
    .argument('<server>', 'server name or id')
    .option('-y, --yes', 'skip the confirmation')
    .action((s, o) => serversRm(ctx, s, o));
  servers.command('provision').description('install Docker, the proxy and the metrics agent')
    .argument('<server>', 'server name or id')
    .option('--no-follow', "don't stream the provisioning log")
    .action((s, o) => serversProvision(ctx, s, o));

  program.command('metrics')
    .description('CPU, memory, disk, network and containers of a server')
    .argument('<server>', 'server name or id')
    .option('-w, --watch', 'live, top-like view (q to quit)')
    .addOption(new Option('-r, --range <range>', 'history window').choices(RANGES))
    .option('--json', 'output JSON')
    .action((s, o) => metricsCmd(ctx, s, o));
  program.command('diagnose')
    .description("what's wrong with a server, an app or the fleet")
    .argument('[target]', 'server or app name (default: whole fleet)')
    .option('--json', 'output JSON (great for Claude)')
    .action((t, o) => diagnoseCmd(ctx, t, o));
  const alerts = program.command('alerts').description('firing alerts and history');
  alerts.command('ls', { isDefault: true }).alias('list').description('list alerts (firing by default)')
    .option('-a, --all', 'include resolved alerts')
    .option('-n, --limit <n>', 'max alerts', '50')
    .option('--json', 'output JSON')
    .action((o) => alertsCmd(ctx, o));
  alerts.command('ack').description('acknowledge a firing alert').argument('<id>', 'alert id').action((id) => ackCmd(ctx, id));

  // ── Claude ──
  program.commandsGroup('Claude:');
  program.command('mcp')
    .description('run the Docksy MCP server for Claude (stdio)')
    .argument('[args...]', 'extra flags for the standalone server, e.g. --http')
    .allowUnknownOption(true)
    .helpOption(false)
    .addHelpText('after', `\n  Claude Code: ${pc.cyan('claude mcp add docksy -- docksy mcp')}`)
    .action((args: string[]) => mcpCmd(ctx, args));

  for (const c of program.commands) if (c.commands.length) c.helpCommand(false);
  return program;
}

/** Parse argv (without node + script) and run. Never calls process.exit. */
export async function run(argv: string[], ctx: Ctx): Promise<number> {
  const program = createProgram(ctx);
  // picocolors reads --no-color / --color from process.argv itself; keep commander from rejecting them.
  const args = argv.filter((a) => a !== '--no-color' && a !== '--color');
  try {
    await program.parseAsync(args, { from: 'user' });
    return 0;
  } catch (e) {
    return handleError(ctx, e);
  }
}

export function handleError(ctx: Ctx, e: unknown): number {
  if (e instanceof CommanderError) {
    if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version' || e.code === 'commander.help') return 0;
    return e.exitCode || 1;
  }
  if (e instanceof ExitCode) return e.code;
  if (e instanceof CliError) {
    ctx.warn(` ${pc.red('✖')} ${e.message}`);
    if (e.hint) ctx.warn(`   ${pc.dim(e.hint)}`);
    return e.exitCode;
  }
  if (e instanceof ConfigError) {
    ctx.warn(` ${pc.red('✖')} ${e.message}`);
    return 1;
  }
  if (e instanceof DocksyApiError) {
    ctx.warn(` ${pc.red('✖')} ${apiErrorMessage(e)}`);
    const hint = apiErrorHint(e);
    if (hint) ctx.warn(`   ${pc.dim(hint)}`);
    return 1;
  }
  const err = e as Error;
  ctx.warn(` ${pc.red('✖')} ${err?.message ?? String(e)}`);
  if (ctx.env.DOCKSY_DEBUG && err?.stack) ctx.warn(pc.dim(err.stack));
  return 1;
}

export function apiErrorMessage(e: DocksyApiError): string {
  if (e.code === 'timeout') return `Docksy took too long to answer (${e.method} ${e.path}).`;
  if (e.status === 0) return e.message;
  let msg = e.message;
  if (e.code === 'bad_request' && Array.isArray(e.details)) {
    const issues = (e.details as { path?: (string | number)[]; message?: string }[])
      .map((i) => `${i.path?.length ? `${i.path.join('.')}: ` : ''}${i.message ?? ''}`)
      .filter(Boolean);
    if (issues.length) msg += `\n   ${issues.map((i) => `· ${i}`).join('\n   ')}`;
  }
  return msg;
}

function apiErrorHint(e: DocksyApiError): string | undefined {
  if (e.status === 0 && e.code === 'network_error') return 'Is Docksy running and is the URL right? Check with `docksy whoami`, or set DOCKSY_URL.';
  if (e.code === 'server_unreachable') return 'Docksy could not reach that server over SSH. Is it up? Check with `docksy servers` or `docksy diagnose <server>`.';
  if (e.status === 401) return 'Your token is missing or was revoked. Run `docksy login <url>`.';
  if (e.status === 403) return 'This token is read-only. Create a full-access token in Settings → API tokens.';
  if (e.status >= 500) return 'Something went wrong on the server. Its logs have the details (DOCKSY_DEBUG=1 for more here).';
  return undefined;
}
