/**
 * Streamable HTTP transport, bound to 127.0.0.1 only. Stateless: every POST gets a fresh
 * McpServer + transport, so there is no session state to leak or expire.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpConfig } from './config.ts';
import { apiFromConfig, createDocksyMcpServer, VERSION } from './server.ts';

export const MCP_PATH = '/mcp';
const HOST = '127.0.0.1';
const LOCAL_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Host header must be a loopback name (DNS-rebinding protection). */
export function isLocalHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const name = hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0];
  return LOCAL_NAMES.has(name.toLowerCase());
}

/** Browsers send Origin; only allow pages served from loopback. Non-browser clients send none. */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return LOCAL_NAMES.has(u.hostname === '::1' ? '[::1]' : u.hostname.toLowerCase()) || LOCAL_NAMES.has(u.host.toLowerCase());
  } catch {
    return false;
  }
}

function jsonRpcError(res: ServerResponse, status: number, message: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

export interface HttpHandle {
  url: string;
  server: HttpServer;
  close(): Promise<void>;
}

export async function runHttp(config: McpConfig, port: number, fetchImpl?: typeof fetch): Promise<HttpHandle> {
  const api = apiFromConfig(config, fetchImpl);

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '/').split('?')[0];
    if (!isLocalHost(req.headers.host)) return jsonRpcError(res, 403, 'Forbidden host');
    if (!isAllowedOrigin(req.headers.origin)) return jsonRpcError(res, 403, 'Forbidden origin');

    if (path === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: 'docksy-mcp', version: VERSION, readonly: config.readonly }));
      return;
    }
    if (path !== MCP_PATH) return jsonRpcError(res, 404, `Not found. The MCP endpoint is ${MCP_PATH}`);
    if (req.method !== 'POST') return jsonRpcError(res, 405, 'Method not allowed (stateless server: POST only)', { allow: 'POST' });

    const { server } = createDocksyMcpServer({ api, readonly: config.readonly });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      process.stderr.write(`docksy-mcp: request failed: ${e instanceof Error ? e.message : String(e)}\n`);
      if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error');
    }
  };

  const http = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error');
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, HOST, () => {
      http.off('error', reject);
      resolve();
    });
  });
  const addr = http.address() as AddressInfo;
  const url = `http://${HOST}:${addr.port}${MCP_PATH}`;
  return {
    url,
    server: http,
    close: () => new Promise<void>((r) => http.close(() => r())),
  };
}
