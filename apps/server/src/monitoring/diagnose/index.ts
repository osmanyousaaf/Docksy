import type { Hono } from 'hono';
import type { AppEnv } from '../../lib/http.ts';
import { requireUser } from '../../lib/auth.ts';
import { diagnose } from './gather.ts';

export { diagnose, setDiagnoseDeps } from './gather.ts';
export { runRules, summarize } from './rules.ts';

/**
 * GET /api/v1/diagnose?serverId=&appId= → DiagnoseReport (CONTRACT.md §4.2).
 * Deterministic and rule-based; built to be read by Claude via the `diagnose` MCP tool.
 */
export function registerDiagnose(app: Hono<AppEnv>): void {
  app.get('/api/v1/diagnose', requireUser, async (c) => {
    const report = await diagnose({ serverId: c.req.query('serverId') || null, appId: c.req.query('appId') || null });
    c.header('cache-control', 'no-store');
    return c.json(report);
  });
}
