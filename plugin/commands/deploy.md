---
description: Deploy an app to your Docksy server and verify it's live (creates the app on first deploy).
argument-hint: "[app-name]"
allowed-tools: Read Grep Glob Bash(git remote *) Bash(git status *) Bash(git log *) Bash(git rev-parse *) Bash(curl -sS -o /dev/null *) mcp__plugin_docksy_docksy__list_servers mcp__plugin_docksy_docksy__get_server mcp__plugin_docksy_docksy__list_apps mcp__plugin_docksy_docksy__get_app mcp__plugin_docksy_docksy__deploy_app mcp__plugin_docksy_docksy__list_deployments mcp__plugin_docksy_docksy__get_deployment_logs mcp__plugin_docksy_docksy__get_app_logs mcp__plugin_docksy_docksy__diagnose
---

Deploy with Docksy. Target app: "$ARGUMENTS".

- **An existing app name was given** (check with `list_apps`): call `deploy_app` for it right away. The user asked for this deploy by running the command. Then watch it with `list_deployments` / `get_deployment_logs`, giving short progress notes.
- **No app was given, or it doesn't exist yet:** follow the **docksy-deploy** skill. Detect the stack, make sure there's a Dockerfile, create the app (ask before `create_app`), deploy, then verify.

When it finishes:
1. On success, `curl` the primary domain (retry for up to a minute while TLS is issued), check `get_app_logs` for crashes, and print the URL, the commit and the build time.
2. On failure, find the first real error in `get_deployment_logs`, explain it in plain words and propose a fix. The previous version is still serving traffic.
