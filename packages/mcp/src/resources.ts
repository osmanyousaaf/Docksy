/** MCP resources: docksy://overview and docksy://servers/{id}/metrics. */
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FleetOverview, Server, ServerMetrics } from '@docksy/shared';
import { seg, type DocksyApi } from './api.ts';
import { renderMetrics, renderOverview } from './render.ts';
import { resolveServer } from './resolve.ts';

export function registerResources(server: McpServer, api: DocksyApi): void {
  server.registerResource(
    'overview',
    'docksy://overview',
    {
      title: 'Docksy fleet overview',
      description: 'Every server with live CPU/memory/disk, CPU trend, app count and firing alerts, plus fleet totals.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const o = await api.get<FleetOverview>('/overview');
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: renderOverview(o) }] };
    },
  );

  server.registerResource(
    'server-metrics',
    new ResourceTemplate('docksy://servers/{id}/metrics', {
      list: async () => {
        const { items } = await api.get<{ items: Server[] }>('/servers');
        return {
          resources: items.map((s) => ({
            uri: `docksy://servers/${seg(s.id)}/metrics`,
            name: `${s.name} metrics`,
            description: `Last hour of CPU, memory, disk and network for ${s.name} (${s.host}).`,
            mimeType: 'text/markdown',
          })),
        };
      },
      complete: {
        id: async (value) => {
          const { items } = await api.get<{ items: Server[] }>('/servers');
          return items.map((s) => s.id).filter((id) => id.startsWith(value));
        },
      },
    }),
    {
      title: 'Server metrics (last hour)',
      description: 'Sparklines with current/avg/max for CPU, memory, disk, swap, load and network of one server over the last hour.',
      mimeType: 'text/markdown',
    },
    async (uri, vars) => {
      const raw = Array.isArray(vars.id) ? vars.id[0] : vars.id;
      const s = await resolveServer(api, decodeURIComponent(String(raw)));
      const m = await api.get<ServerMetrics>(`/servers/${seg(s.id)}/metrics`, { range: '1h' });
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: renderMetrics(m, s.name).text }] };
    },
  );
}
