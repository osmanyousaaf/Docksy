---
description: Show recent runtime logs (or the latest build log) for a Docksy app, with errors highlighted and explained.
argument-hint: "<app> [--build] [tail]"
allowed-tools: mcp__plugin_docksy_docksy__list_apps mcp__plugin_docksy_docksy__get_app mcp__plugin_docksy_docksy__get_app_logs mcp__plugin_docksy_docksy__list_deployments mcp__plugin_docksy_docksy__get_deployment_logs
---

Show logs for Docksy app(s). Arguments: "$ARGUMENTS".

- The first argument is the app name or id. If it's missing, call `list_apps` and ask which app.
- `--build`: show the build log of the most recent deployment instead (`list_deployments` limit 1 → `get_deployment_logs`).
- A number sets the tail length (default 100, max 1000).

Otherwise call `get_app_logs` with that tail.

Output:
1. The log lines in a code block. Trim them if they're very noisy, and say what you trimmed.
2. Then a short **Highlights** list: errors, exceptions, restarts or OOM messages, with their timestamps, and what they most likely mean. If the logs look clean, say so in one line.
3. If you see a crash or an error loop, suggest `/docksy:diagnose <app>`.
