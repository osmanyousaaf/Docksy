/** CLI config at ~/.config/docksy/config.json (0600). DOCKSY_URL / DOCKSY_TOKEN env vars override it. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface DocksyConfig {
  url?: string;
  token?: string;
  /** Email of the logged-in user, for display. */
  user?: string;
}

export interface Connection {
  url: string | undefined;
  token: string | undefined;
  urlSource: 'env' | 'config' | 'none';
  tokenSource: 'env' | 'config' | 'none';
}

export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'ConfigError'; }
}

/** Config path: $DOCKSY_CONFIG if set (tests, multiple instances), else ~/.config/docksy/config.json. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DOCKSY_CONFIG || join(homedir(), '.config', 'docksy', 'config.json');
}

export function loadConfig(path: string): DocksyConfig {
  if (!existsSync(path)) return {};
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch (e) { throw new ConfigError(`Can't read ${path}: ${(e as Error).message}`); }
  if (!raw.trim()) return {};
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new ConfigError(`${path} is not valid JSON. Fix it or delete it and run \`docksy login\` again.`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ConfigError(`${path} must contain a JSON object.`);
  const o = data as Record<string, unknown>;
  const cfg: DocksyConfig = {};
  if (typeof o.url === 'string') cfg.url = o.url;
  if (typeof o.token === 'string') cfg.token = o.token;
  if (typeof o.user === 'string') cfg.user = o.user;
  return cfg;
}

/** Atomically write the config with 0600 permissions (directory 0700). */
export function saveConfig(path: string, cfg: DocksyConfig): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const clean: DocksyConfig = {};
  if (cfg.url) clean.url = cfg.url;
  if (cfg.token) clean.token = cfg.token;
  if (cfg.user) clean.user = cfg.user;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function resolveConnection(cfg: DocksyConfig, env: NodeJS.ProcessEnv = process.env): Connection {
  const envUrl = env.DOCKSY_URL?.trim();
  const envToken = env.DOCKSY_TOKEN?.trim();
  return {
    url: envUrl || cfg.url,
    token: envToken || cfg.token,
    urlSource: envUrl ? 'env' : cfg.url ? 'config' : 'none',
    tokenSource: envToken ? 'env' : cfg.token ? 'config' : 'none',
  };
}
