/** Environment configuration and friendly startup errors. */

export interface McpConfig {
  url: string;
  token: string;
  readonly: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}


export function loadConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const url = (env.DOCKSY_URL ?? '').trim();
  const token = (env.DOCKSY_TOKEN ?? '').trim();
  const problems: string[] = [];
  if (!url) {
    problems.push('DOCKSY_URL is not set. Point it at your Docksy instance, e.g. DOCKSY_URL=https://docksy.example.com');
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      /* reported below */
    }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) problems.push(`DOCKSY_URL "${url}" is not a valid http(s) URL.`);
  }
  if (!token) {
    problems.push('DOCKSY_TOKEN is not set. Create an API token in Docksy → Settings → API tokens (starts with "dsk_").');
  }
  if (problems.length) {
    throw new ConfigError(
      [
        'docksy-mcp cannot start:',
        ...problems.map((p) => `  • ${p}`),
        '',
        'Example (Claude Code):',
        '  claude mcp add docksy -e DOCKSY_URL=https://docksy.example.com -e DOCKSY_TOKEN=dsk_… -- npx -y @crovenai/docksy-mcp',
        'Set DOCKSY_READONLY=1 to expose read-only tools only.',
      ].join('\n'),
    );
  }
  return { url, token, // Exactly "1": the Claude Code plugin passes an empty string when unset.
    readonly: (env.DOCKSY_READONLY ?? '').trim() === '1' };
}
