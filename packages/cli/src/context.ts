/** Everything a command needs from the outside world, injectable for tests. */
import { DocksyClient } from '@crovenai/docksy-client';
import { configPath, loadConfig, resolveConnection, saveConfig, type DocksyConfig } from './config.ts';

export interface Out {
  write(s: string): unknown;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

export interface Ctx {
  env: NodeJS.ProcessEnv;
  stdout: Out;
  stderr: Out;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(mode: boolean): unknown };
  configPath: string;
  loadConfig(): DocksyConfig;
  saveConfig(cfg: DocksyConfig): void;
  /** Client for the configured instance; throws a friendly CliError when not logged in. */
  client(): DocksyClient;
  /** Build a client for an explicit URL/token (login). */
  newClient(url: string, token?: string): DocksyClient;
  /** Write a line to stdout. */
  print(s?: string): void;
  /** Write a line to stderr. */
  warn(s?: string): void;
  /** Terminal width (default 100 when not a TTY). */
  width(): number;
  /** Opens a URL in the browser. */
  openUrl(url: string): void;
}

/** A user-facing error: printed as "✖ message" plus an optional hint, exits with `exitCode`. */
export class CliError extends Error {
  hint?: string;
  exitCode: number;
  constructor(message: string, o: { hint?: string; exitCode?: number } = {}) {
    super(message);
    this.name = 'CliError';
    this.hint = o.hint;
    this.exitCode = o.exitCode ?? 1;
  }
}

/** Exit silently with a code (the command already explained what happened). */
export class ExitCode extends Error {
  code: number;
  constructor(code: number) { super(`exit ${code}`); this.code = code; }
}

export function createContext(o: Partial<Pick<Ctx, 'env' | 'stdout' | 'stderr' | 'stdin' | 'openUrl'>> & { fetch?: typeof fetch } = {}): Ctx {
  const env = o.env ?? process.env;
  const stdout = o.stdout ?? process.stdout;
  const stderr = o.stderr ?? process.stderr;
  const path = configPath(env);
  let cached: DocksyClient | undefined;
  const ctx: Ctx = {
    env,
    stdout,
    stderr,
    stdin: o.stdin ?? process.stdin,
    configPath: path,
    loadConfig: () => loadConfig(path),
    saveConfig: (cfg) => saveConfig(path, cfg),
    newClient: (url, token) => new DocksyClient({ url, token, fetch: o.fetch }),
    client() {
      if (cached) return cached;
      const conn = resolveConnection(ctx.loadConfig(), env);
      if (!conn.url) {
        throw new CliError('Not connected to a Docksy instance yet.', { hint: 'Run `docksy login <url>` or set DOCKSY_URL and DOCKSY_TOKEN.' });
      }
      cached = ctx.newClient(conn.url, conn.token);
      return cached;
    },
    print: (s = '') => { stdout.write(s + '\n'); },
    warn: (s = '') => { stderr.write(s + '\n'); },
    width: () => Math.max(40, stdout.columns || 100),
    openUrl: o.openUrl ?? defaultOpenUrl,
  };
  return ctx;
}

function defaultOpenUrl(url: string): void {
  // Lazy import keeps child_process out of the hot path.
  void import('node:child_process').then(({ spawn }) => {
    const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
    try {
      const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
      child.on('error', () => {});
      child.unref();
    } catch { /* printing the URL is enough */ }
  });
}
