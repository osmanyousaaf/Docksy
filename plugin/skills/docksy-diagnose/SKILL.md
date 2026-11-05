---
name: docksy-diagnose
description: Find out why a Docksy server or app is slow, down, crashing, out of memory or out of disk, using Docksy's deterministic diagnose report plus metrics and logs, then propose fixes and apply them only with the user's consent. Use for "why is my app down", "server is slow", "high CPU", "502", "it keeps restarting", "disk full", or after a Docksy alert.
when_to_use: Trigger phrases include "diagnose", "what's wrong with", "investigate", "debug my server", "check my app", "alert fired", "OOM", "restart loop", "deploy failed". For an active outage that needs mitigation first, prefer docksy-incident.
argument-hint: "[server-or-app]"
allowed-tools: Read Grep Glob mcp__plugin_docksy_docksy__diagnose mcp__plugin_docksy_docksy__list_servers mcp__plugin_docksy_docksy__get_server mcp__plugin_docksy_docksy__get_server_metrics mcp__plugin_docksy_docksy__list_containers mcp__plugin_docksy_docksy__get_fleet_overview mcp__plugin_docksy_docksy__list_apps mcp__plugin_docksy_docksy__get_app mcp__plugin_docksy_docksy__list_deployments mcp__plugin_docksy_docksy__get_deployment_logs mcp__plugin_docksy_docksy__get_app_logs mcp__plugin_docksy_docksy__list_alerts mcp__plugin_docksy_docksy__list_uptime_checks mcp__plugin_docksy_docksy__list_backups
---

# Diagnose with Docksy

Docksy never calls an LLM. Its `diagnose` tool is rule-based and returns **evidence**: findings with numbers, log lines, a suggestion and often a ready-made `action` (an MCP tool call). **You** do the reasoning. Be a calm, careful SRE: look first, explain clearly, and change nothing without consent.

Target: `$ARGUMENTS` (a server or app name or id). If it's empty, start from the fleet.

## 1. Scope it

- No target: call `get_fleet_overview` and `list_alerts` (state `firing`). Pick the worst server or app and tell the user which one and why.
- If the target is a name, resolve it with `list_apps` / `list_servers`. App ids and names are both accepted.

## 2. Collect evidence (read-only, no permission needed)

1. `diagnose` with the `serverId` or `appId`. This is the backbone.
2. Add evidence based on what it says:
   - **CPU/memory:** `get_server_metrics` (range `1h`, then `24h` to see whether it's new or chronic) and `list_containers` to see who is using it.
   - **App crash/restarts:** `get_app_logs` (tail 200) and `list_deployments` (did it start right after a deploy?).
   - **Failed deploy:** `get_deployment_logs` for that deployment.
   - **Down from outside:** `list_uptime_checks`.
   - **Database:** `list_backups` (when did a good, verified backup last run?).
3. Stop collecting once you can explain the problem. Don't dump every tool's output on the user.

## 3. Reason

Build a short causal chain, and back every link with evidence you actually saw:

> Memory hit 97% at 14:02 → `api` container OOM-killed (OOMKilled=true, 6 restarts in 10m) → 502s on api.example.com. It started with deployment `a1b2c3d` at 13:58, which added an in-memory cache.

Separate **facts** (from the report) from **hypotheses** (yours), and say how confident you are. If the evidence doesn't explain it, say so and say what you'd look at next.

## 4. Propose fixes

Give 1–3 options, ordered from safest to most involved. For each one: what it does, the risk, and the exact Docksy tool call. Use the finding's `action` when there is one. Common fixes:

| Problem | Fix |
|---|---|
| Bad deploy | `rollback_app` to the last succeeded deployment |
| Wedged or leaking container | `restart_app` (fast, temporary) |
| Missing or wrong config | `set_env_vars` then `deploy_app` |
| Disk nearly full | prune old images/build cache on the server (explain the command), raise backup retention limits |
| Chronic resource pressure | a bigger server, or move an app to another server |
| Code bug | point to the file and line in the user's repo if it's open here, and offer a patch |

## 5. Act only with consent

- Ask before any write tool (`restart_app`, `rollback_app`, `deploy_app`, `set_env_vars`, `stop_app`…). One clear question: "Roll back `api` to deployment `9f8e7d6` (yesterday 18:20)? It takes ~30s with zero downtime."
- Never call `delete_app`, `delete_server` or `restore_backup` as a fix during diagnosis.
- After acting, **verify**: run `diagnose` again, check the metrics and the uptime check, and report the before/after.

## 6. Report

```
🩺 <target>: <one-line verdict>
Cause:     <causal chain, 1–2 lines>
Evidence:  <2–4 bullet facts with numbers>
Fixed:     <what you did, or "nothing yet: waiting for your OK">
Prevent:   <one suggestion, e.g. alert rule, healthcheck, memory limit>
```
