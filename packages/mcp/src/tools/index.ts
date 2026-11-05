import type { ToolDef } from '../registry.ts';
import { appTools } from './apps.ts';
import { backupTools } from './backups.ts';
import { deployTools } from './deploy.ts';
import { monitoringTools } from './monitoring.ts';
import { serverTools } from './servers.ts';

/** Every Docksy MCP tool (CONTRACT.md §8). Order is the order clients list them in. */
export const ALL_TOOLS: ToolDef[] = [
  ...monitoringTools.slice(0, 3), // get_server_metrics, get_fleet_overview, diagnose: the most useful first
  ...serverTools,
  ...appTools,
  ...deployTools,
  ...monitoringTools.slice(3),
  ...backupTools,
];
