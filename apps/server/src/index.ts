import { serve } from '@hono/node-server';
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { migrate } from './db/index.ts';
import { config } from './config.ts';
import { createApp, startJobs } from './app.ts';

migrate();
const app = createApp();

// ── static web UI (apps/web/dist) with SPA fallback ──
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};
app.get('*', (c) => {
  if (!existsSync(config.webDist)) return c.text('Docksy API is running. Web UI not built (run: npm run build -w @docksy/web).', 200);
  const rel = normalize(decodeURIComponent(c.req.path)).replace(/^(\.\.[/\\])+/, '');
  let file = join(config.webDist, rel);
  if (!file.startsWith(config.webDist) || !existsSync(file) || rel === '/' ) file = join(config.webDist, 'index.html');
  try {
    const buf = readFileSync(file);
    const ext = extname(file);
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
    return c.body(buf, 200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': cache });
  } catch {
    return c.body(readFileSync(join(config.webDist, 'index.html')), 200, { 'content-type': MIME['.html']! });
  }
});

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[docksy] v${config.version} listening on http://${config.host}:${info.port}  (data: ${config.dataDir})`);
  startJobs();
});
