import * as ssh from '../../lib/ssh.ts';
import type { ExecOptions, ExecResult } from '../../lib/ssh.ts';

/**
 * The SSH surface the deploy engine uses. Indirected so tests can swap in a fake
 * (`setRemote(fake)`) without touching lib/ssh.ts.
 */
export interface Remote {
  exec(serverId: string, command: string, opts?: ExecOptions): Promise<ExecResult>;
  putFile(serverId: string, remotePath: string, content: string | Buffer, mode?: number): Promise<void>;
}

const real: Remote = {
  exec: (serverId, command, opts) => ssh.exec(serverId, command, opts),
  putFile: (serverId, remotePath, content, mode) => ssh.putFile(serverId, remotePath, content, mode),
};

export let remote: Remote = real;

/** Test hook: replace the SSH layer (pass null to restore the real one). */
export function setRemote(r: Remote | null): void {
  remote = r ?? real;
}

/** Timing knobs for the health wait (tests shrink these). */
export const timing = {
  healthTimeoutMs: 120_000,
  pollMs: 2_000,
  /** Without an HTTP healthcheck the container must stay running this long. */
  stableMs: 5_000,
};
