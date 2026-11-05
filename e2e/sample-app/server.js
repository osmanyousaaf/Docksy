// Tiny HTTP app used by the Docksy e2e test. No dependencies.
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 3000);
const started = Date.now();
const name = process.env.APP_NAME ?? 'docksy-sample';

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptimeSec: Math.round((Date.now() - started) / 1000) }));
    return;
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Hello from ${name}, deployed by Docksy.\n`);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found\n');
});

server.listen(port, '0.0.0.0', () => console.log(`[sample] listening on :${port}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
