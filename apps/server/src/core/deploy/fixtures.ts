/** Test-only fixtures (rows + a scriptable fake SSH). Import './testenv.ts' before this. */
import { db, migrate, newId, now } from '../../db/index.ts';
import { encrypt } from '../../lib/crypto.ts';
import type { ExecOptions, ExecResult } from '../../lib/ssh.ts';
import type { Remote } from './remote.ts';

let migrated = false;
export function setupDb(): void {
  if (!migrated) { migrate(); migrated = true; }
}

export function insertServer(host = '203.0.113.7'): string {
  const id = newId();
  db.prepare("INSERT INTO servers (id, name, host, port, ssh_user, status, created_at, updated_at) VALUES (?, ?, ?, 22, 'root', 'ready', ?, ?)")
    .run(id, `srv-${id.slice(0, 4)}`, host, now(), now());
  return id;
}

export interface AppFixture {
  name: string;
  serverId: string;
  sourceType?: 'git' | 'image';
  repoUrl?: string | null;
  branch?: string | null;
  gitToken?: string | null;
  image?: string | null;
  buildType?: string;
  port?: number | null;
  domains?: string[];
  healthcheckPath?: string | null;
  kind?: string;
  template?: string | null;
  env?: Record<string, string>;
  currentDeploymentId?: string | null;
}

export function insertApp(f: AppFixture): string {
  const id = newId();
  db.prepare(`INSERT INTO apps (id, name, server_id, kind, template, source_type, repo_url, branch, git_token_enc, image, build_type, port, domains,
      healthcheck_path, volumes, status, webhook_secret, current_deployment_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', 'whs_x', ?, ?, ?)`)
    .run(id, f.name, f.serverId, f.kind ?? 'app', f.template ?? null, f.sourceType ?? 'git', f.repoUrl ?? null, f.branch ?? 'main',
      f.gitToken ? encrypt(f.gitToken) : null, f.image ?? null, f.buildType ?? 'auto', f.port ?? null, JSON.stringify(f.domains ?? []),
      f.healthcheckPath ?? null, '[]', f.currentDeploymentId ?? null, now(), now());
  for (const [k, v] of Object.entries(f.env ?? {})) db.prepare('INSERT INTO app_env (app_id, key, value_enc) VALUES (?, ?, ?)').run(id, k, encrypt(v));
  return id;
}

type Reply = Partial<ExecResult> | ((cmd: string) => Partial<ExecResult>);

/** Fake SSH: first matching rule wins; unmatched commands succeed with empty output. */
export class FakeRemote implements Remote {
  rules: [RegExp | string, Reply][] = [];
  commands: string[] = [];
  files: { path: string; content: string; mode?: number }[] = [];
  on(match: RegExp | string, reply: Reply): this {
    this.rules.push([match, reply]);
    return this;
  }
  async exec(_serverId: string, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    this.commands.push(command);
    if (opts.signal?.aborted) throw new Error('aborted');
    const rule = this.rules.find(([m]) => (typeof m === 'string' ? command.includes(m) : m.test(command)));
    const r = rule ? (typeof rule[1] === 'function' ? rule[1](command) : rule[1]) : {};
    const res: ExecResult = { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    if (res.stdout) opts.onData?.(res.stdout, 'stdout');
    if (res.stderr) opts.onData?.(res.stderr, 'stderr');
    return res;
  }
  async putFile(_serverId: string, path: string, content: string | Buffer, mode?: number): Promise<void> {
    this.files.push({ path, content: String(content), mode });
  }
  ran(match: RegExp | string): string[] {
    return this.commands.filter((c) => (typeof match === 'string' ? c.includes(match) : match.test(c)));
  }
}
