/** Minimal interactive prompts (no dependencies). */
import { createInterface } from 'node:readline';
import type { Ctx } from './context.ts';
import { CliError } from './context.ts';

export function isInteractive(ctx: Ctx): boolean {
  return Boolean(ctx.stdin.isTTY && ctx.stderr.isTTY);
}

/** Ask a question on stderr (keeps stdout clean for --json/pipes). */
export function ask(ctx: Ctx, question: string, o: { hidden?: boolean } = {}): Promise<string> {
  if (!isInteractive(ctx)) {
    return Promise.reject(new CliError(`Can't ask "${question.trim()}" without an interactive terminal.`));
  }
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: ctx.stdin, output: ctx.stderr as NodeJS.WritableStream, terminal: true });
    let muted = false;
    if (o.hidden) {
      // Echo nothing while the user types a password.
      const r = rl as unknown as { _writeToOutput: (s: string) => void };
      const orig = r._writeToOutput.bind(rl);
      r._writeToOutput = (s: string) => { if (!muted || s.includes(question)) orig(s); };
    }
    rl.on('SIGINT', () => { rl.close(); ctx.stderr.write('\n'); reject(new CliError('Cancelled.', { exitCode: 130 })); });
    rl.question(question, (answer) => {
      rl.close();
      if (o.hidden) ctx.stderr.write('\n');
      resolve(answer.trim());
    });
    muted = true;
  });
}

/**
 * Confirm a destructive action. `--yes` skips it; without a TTY we refuse rather than guess.
 */
export async function confirm(ctx: Ctx, question: string, o: { yes?: boolean } = {}): Promise<void> {
  if (o.yes) return;
  if (!isInteractive(ctx)) {
    throw new CliError(`${question} Refusing without confirmation.`, { hint: 'Re-run with --yes to confirm.' });
  }
  const a = (await ask(ctx, `${question} [y/N] `)).toLowerCase();
  if (a !== 'y' && a !== 'yes') throw new CliError('Cancelled. Nothing was changed.', { exitCode: 1 });
}
