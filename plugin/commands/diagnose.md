---
description: Diagnose a slow, failing or down Docksy server or app; explains the cause and proposes fixes (acts only with your OK).
argument-hint: "[server-or-app]"
allowed-tools: Read Grep Glob mcp__plugin_docksy_docksy__diagnose mcp__plugin_docksy_docksy__get_fleet_overview mcp__plugin_docksy_docksy__list_servers mcp__plugin_docksy_docksy__get_server mcp__plugin_docksy_docksy__get_server_metrics mcp__plugin_docksy_docksy__list_containers mcp__plugin_docksy_docksy__list_apps mcp__plugin_docksy_docksy__get_app mcp__plugin_docksy_docksy__list_deployments mcp__plugin_docksy_docksy__get_deployment_logs mcp__plugin_docksy_docksy__get_app_logs mcp__plugin_docksy_docksy__list_alerts mcp__plugin_docksy_docksy__list_uptime_checks mcp__plugin_docksy_docksy__list_backups
---

Diagnose "$ARGUMENTS" with Docksy (if it's empty, find the unhealthiest server or app via `get_fleet_overview` and firing alerts).

Follow the **docksy-diagnose** skill:
1. Resolve the target, then call `diagnose` with its `serverId` or `appId`.
2. Add evidence only where the findings point (metrics, containers, logs, deployments).
3. Explain the cause as a short causal chain backed by the numbers and log lines you saw. Separate facts from hypotheses.
4. Propose 1–3 fixes, safest first, each with the exact Docksy tool call. **Ask before running any write tool**, then verify with a second `diagnose`.
