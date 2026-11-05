---
description: Roll a Docksy app back to a previous successful deployment with zero downtime (confirms the target first).
argument-hint: "<app> [deploymentId]"
allowed-tools: mcp__plugin_docksy_docksy__list_apps mcp__plugin_docksy_docksy__get_app mcp__plugin_docksy_docksy__list_deployments mcp__plugin_docksy_docksy__get_deployment_logs mcp__plugin_docksy_docksy__get_app_logs mcp__plugin_docksy_docksy__diagnose
---

Roll back a Docksy app. Arguments: "$ARGUMENTS" (app, then an optional deployment id).

1. Resolve the app (`list_apps` / `get_app`). If none was given, ask.
2. `list_deployments` for the app (limit 10). Pick the target:
   - if a deployment id was given, use it. It must be `succeeded` and have an image.
   - otherwise, use the most recent **succeeded** deployment **before** the current one.
3. Show a small table (current vs. target: id, commit, message, age) and ask: "Roll back <app> to <id8> (<commit7> "<message>", <age>)?"
4. On yes, call `rollback_app`. Watch `list_deployments` until it succeeds, then confirm with `get_app_logs` (no crash loop) and `diagnose` for the app.
5. Report what's live now, and remind the user that the next push or deploy will roll forward again. If auto-deploy is on, suggest they fix or revert the bad commit.
