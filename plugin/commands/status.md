---
description: Show the health of your Docksy fleet (servers, apps, firing alerts and uptime) at a glance.
argument-hint: "[server-or-app]"
allowed-tools: mcp__plugin_docksy_docksy__get_fleet_overview mcp__plugin_docksy_docksy__list_servers mcp__plugin_docksy_docksy__get_server mcp__plugin_docksy_docksy__get_server_metrics mcp__plugin_docksy_docksy__list_apps mcp__plugin_docksy_docksy__get_app mcp__plugin_docksy_docksy__list_deployments mcp__plugin_docksy_docksy__list_alerts mcp__plugin_docksy_docksy__list_uptime_checks mcp__plugin_docksy_docksy__list_containers
---

Give a Docksy status report. Focus: "$ARGUMENTS" (empty means the whole fleet). This is read-only: don't change anything.

1. Call `get_fleet_overview` and `list_alerts` (state `firing`). Also call `list_uptime_checks`.
2. If a server or app was named, also call `get_server` + `get_server_metrics` (range `1h`), or `get_app` + `list_deployments` (limit 5).
3. Render it compactly:

```
Docksy · 3 servers · 9 apps · 1 alert firing
SERVER      STATUS   CPU   MEM   DISK  LOAD
prod-1      online   23%   61%   48%   0.42
...
APPS   ✓ 8 running · ✗ 1 failed (worker: deploy failed 12m ago)
ALERTS ⚠ Memory > 90% on prod-2 (since 14:02)
UPTIME 5/5 up · 99.98% (24h)
```

4. End with at most 2 suggested next actions (e.g. `/docksy:diagnose prod-2`). If everything is healthy, say so in one line.
