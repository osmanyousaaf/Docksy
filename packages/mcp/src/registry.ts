/** Tool definition helpers, read-only filtering, the destructive confirm guard and result shaping. */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DocksyApiError, errorHint, type DocksyApi } from './api.ts';

export type ToolKind = 'read' | 'write' | 'destructive';

export interface ToolOutput {
  /** Concise markdown for the model/human. */
  text: string;
  /** Machine-readable payload (becomes `structuredContent`; arrays are wrapped as `{items}`). */
  data?: unknown;
}

export interface ToolContext {
  api: DocksyApi;
  /** Reports progress on long waits (keeps client request timeouts from firing). No-op if the client didn't ask. */
  progress?: (message: string) => Promise<void>;
}

/** Minimal slice of the SDK's RequestHandlerExtra that we use. */
interface CallExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (n: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void>;
}

export function progressReporter(extra: CallExtra | undefined): ToolContext['progress'] {
  const token = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  if (token === undefined || !send) return undefined;
  let n = 0;
  return async (message) => {
    n++;
    await send({ method: 'notifications/progress', params: { progressToken: token, progress: n, message } }).catch(() => {});
  };
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  /** Teaches Claude when (and when not) to use the tool. */
  description: string;
  kind: ToolKind;
  /** Safe to repeat with the same args (no extra effect). Reads are always idempotent. */
  idempotent?: boolean;
  input: S;
  run: (args: z.output<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolOutput>;
}

/** Identity helper that keeps `run` args typed while letting tools live in one heterogeneous list. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<any> {
  return def as unknown as ToolDef<z.ZodRawShape>;
}

export const confirmField = z
  .boolean()
  .optional()
  .describe(
    'Must be true to proceed. Only set this after the user has explicitly agreed to this exact irreversible action in the conversation.',
  );

/** Final input shape as exposed over MCP (destructive tools get a `confirm` flag). */
export function inputShape(def: ToolDef): z.ZodRawShape {
  return def.kind === 'destructive' ? { ...def.input, confirm: confirmField } : def.input;
}

export function annotations(def: ToolDef) {
  return {
    title: def.title,
    readOnlyHint: def.kind === 'read',
    destructiveHint: def.kind === 'destructive',
    idempotentHint: def.kind === 'read' ? true : (def.idempotent ?? false),
    openWorldHint: false,
  };
}

export function fullDescription(def: ToolDef): string {
  if (def.kind !== 'destructive') return def.description;
  return `${def.description}\n\nDESTRUCTIVE and irreversible: requires \`confirm: true\`. Describe exactly what will be removed, ask the user, and only call with confirm: true after they say yes.`;
}

export function visibleTools(tools: ToolDef[], opts: { readonly: boolean }): ToolDef[] {
  return opts.readonly ? tools.filter((t) => t.kind === 'read') : tools;
}

export function toResult(out: ToolOutput): CallToolResult {
  const result: CallToolResult = { content: [{ type: 'text', text: out.text }] };
  if (out.data !== undefined && out.data !== null) {
    result.structuredContent = (
      Array.isArray(out.data) || typeof out.data !== 'object' ? { items: out.data } : out.data
    ) as Record<string, unknown>;
  }
  return result;
}

export function errorResult(text: string, data?: Record<string, unknown>): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }], ...(data ? { structuredContent: data } : {}) };
}

export function formatError(e: unknown): CallToolResult {
  if (e instanceof DocksyApiError) {
    const hint = errorHint(e);
    const status = e.status ? `HTTP ${e.status}, ${e.code}` : e.code;
    const details = describeDetails(e.details);
    return errorResult(`Docksy error (${status}): ${e.message}${details}${hint ? `\n\n${hint}` : ''}`, {
      error: { status: e.status, code: e.code, message: e.message, details: e.details ?? null },
    });
  }
  if (e instanceof UserFacingError) return errorResult(e.message, { error: { code: e.code, message: e.message } });
  const msg = e instanceof Error ? e.message : String(e);
  return errorResult(`Unexpected error: ${msg}`, { error: { code: 'internal', message: msg } });
}

/** Renders zod-style validation issues ([{path, message}]) as bullet lines. */
export function describeDetails(details: unknown): string {
  if (!Array.isArray(details) || details.length === 0) return '';
  const lines = details.slice(0, 10).map((d) => {
    const issue = d as { path?: unknown[]; message?: string };
    const path = Array.isArray(issue.path) && issue.path.length ? `${issue.path.join('.')}: ` : '';
    return `\n- ${path}${issue.message ?? JSON.stringify(d)}`;
  });
  return lines.join('');
}

/** An error whose message is written for Claude (e.g. "no server named x; known: a, b"). */
export class UserFacingError extends Error {
  readonly code: string;
  constructor(message: string, code = 'invalid') {
    super(message);
    this.name = 'UserFacingError';
    this.code = code;
  }
}

/**
 * Runs one tool with the confirm guard and error shaping. Exposed for tests and for
 * the registration wrapper below.
 */
export async function invokeTool(def: ToolDef, args: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
  if (def.kind === 'destructive' && args.confirm !== true) {
    return errorResult(
      `Not done: \`${def.name}\` is destructive and needs \`confirm: true\`. Tell the user exactly what will be removed, get an explicit yes, then call it again with confirm: true.`,
      { error: { code: 'confirmation_required', message: 'confirm: true is required' }, tool: def.name },
    );
  }
  try {
    const { confirm: _c, ...rest } = args;
    const out = await def.run(def.kind === 'destructive' ? rest : args, ctx);
    return toResult(out);
  } catch (e) {
    return formatError(e);
  }
}

export function registerTools(server: McpServer, tools: ToolDef[], ctx: ToolContext, opts: { readonly: boolean }): string[] {
  const names = new Set<string>();
  for (const def of visibleTools(tools, opts)) {
    if (names.has(def.name)) throw new Error(`duplicate tool name: ${def.name}`);
    names.add(def.name);
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: fullDescription(def),
        inputSchema: inputShape(def),
        annotations: annotations(def),
      },
      // The SDK has already validated args against inputShape(def).
      ((args: Record<string, unknown>, extra: CallExtra) => invokeTool(def, args ?? {}, { ...ctx, progress: progressReporter(extra) })) as never,
    );
  }
  return [...names];
}
