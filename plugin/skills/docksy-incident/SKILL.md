---
name: docksy-incident
description: Run a production incident on Docksy end to end. Triage what's broken, mitigate fast (rollback or restart, with consent), find the root cause, confirm recovery, then write a blameless postmortem. Use when something is down or badly degraded right now, e.g. "site is down", "production is broken", "we're getting 500s", "critical alert", "outage".
when_to_use: Trigger phrases include "incident", "outage", "down", "on fire", "pager", "critical alert fired", "customers can't log in", "postmortem". For a calm investigation with no live impact, prefer docksy-diagnose.
argument-hint: "[server-or-app]"
allowed-tools: Read Grep Glob Write mcp__plugin_docksy_docksy__diagnose mcp__plugin_docksy_docksy__get_fleet_overview mcp__plugin_docksy_docksy__list_servers mcp__plugin_docksy_docksy__get_server mcp__plugin_docksy_docksy__get_server_metrics mcp__plugin_docksy_docksy__list_containers mcp__plugin_docksy_docksy__list_apps mcp__plugin_docksy_docksy__get_app mcp__plugin_docksy_docksy__list_deployments mcp__plugin_docksy_docksy__get_deployment_logs mcp__plugin_docksy_docksy__get_app_logs mcp__plugin_docksy_docksy__list_alerts mcp__plugin_docksy_docksy__list_uptime_checks mcp__plugin_docksy_docksy__list_backups
---

# Incident response with Docksy

Priorities, in order: **stop the bleeding → understand → prevent**. Keep a timeline as you go (UTC timestamps), because you'll need it for the postmortem.

Target: `$ARGUMENTS` (optional).

## Phase 1: Triage (≤ 2 minutes)

1. `list_alerts` (firing) and `get_fleet_overview`. What's red, since when, and how wide is the blast radius (one app, one server, everything)?
2. `list_uptime_checks`: is it down for users, or only internally degraded?
3. `diagnose` on the most affected app or server.
4. Tell the user in 3 lines:
   ```
   🚨 Impact: <who/what is affected> since <time>
   Likely:   <best hypothesis + confidence>
   Plan:     <proposed mitigation>
   ```

## Phase 2: Mitigate (fast and reversible, with consent)

Pick the smallest action that restores service. Ask once, clearly, then act.

| Signal | Mitigation |
|---|---|
| Started right after a deploy (`list_deployments`) | `rollback_app` to the previous **succeeded** deployment. This is the default answer |
| Crash loop / OOM with no recent deploy | `restart_app`; if it repeats, roll back or stop the noisy neighbour (`stop_app`) |
| Server offline (agent silent) | check whether it's the agent or the host: `get_server`, and ping the app's URL. Tell the user to check the VPS provider console |
| Disk full | free space (old images, build cache), then `restart_app` |
| Database down | `restart_app` on the database. **Never** `restore_backup` without explicit, separate consent and a fresh look at `list_backups` |

After every action, re-check: uptime, `diagnose`, and the alert state. Record each action in the timeline. If service is restored, say so plainly and move on. If not, try the next option.

Don't call destructive tools (`delete_app`, `delete_server`, `restore_backup`) to mitigate unless the user explicitly asks. Docksy will ask for confirmation again.

## Phase 3: Root cause

With the pressure off, dig deeper:
- `get_deployment_logs` and the git diff between the good and the bad commit (if the repo is open here: `git log`, `git diff <good>..<bad>`)
- `get_server_metrics` over `24h`/`7d`: was it a sudden spike or a slow creep?
- `get_app_logs`: the first error, not the loudest one

Use the "5 whys", and stop at a cause that someone can act on.

## Phase 4: Recovery check

Confirm that firing alerts have resolved (or ack them with `ack_alert`, with consent), the uptime check is green, and `diagnose` is healthy.

## Phase 5: Postmortem

Write `postmortems/YYYY-MM-DD-<slug>.md` in the user's repo (ask where first if the repo has a docs convention). Keep it blameless and factual:

```markdown
# <Title> (YYYY-MM-DD)

**Status:** resolved · **Duration:** <hh:mm> · **Severity:** <critical/warning>
**Impact:** <users/apps affected, error rate, requests lost if known>

## Summary
<3 sentences: what broke, why, how it was fixed>

## Timeline (UTC)
| Time | Event |
|---|---|
| 13:58 | Deployment a1b2c3d started (webhook, push to main) |
| 14:02 | Alert "Memory > 90%" fired on prod-1 |
| …    | … |

## Root cause
<the causal chain, with evidence>

## What went well / what didn't

## Action items
- [ ] <owner> <preventive fix> (e.g. memory limit, healthcheckPath, alert rule, test)
```

Offer to set up the preventions you can do with Docksy right away: `create_alert_rule`, `create_uptime_check`, a `healthcheckPath` via `update_app`, and `create_backup` with verification.
