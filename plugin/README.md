# Docksy plugin for Claude Code

Let Claude deploy, monitor and fix the servers you run with [Docksy](https://github.com/osmanyousaaf/docksy), the free, open-source, self-hosted PaaS.

## Install

```bash
# 1. Point the plugin at your Docksy instance. Create a token in Docksy → Settings → API tokens.
export DOCKSY_URL="https://docksy.example.com"
export DOCKSY_TOKEN="dsk_..."

# 2. Inside Claude Code
/plugin marketplace add osmanyousaaf/docksy
/plugin install docksy@docksy
```

Restart Claude Code (or run `/reload-plugins`), then run `/mcp` to check that the `docksy` server is connected.

Tips:
- Put the two `export` lines in your shell profile (`~/.zshrc`, `~/.bashrc`) so every session has them.
- Use a **read-only** token, or `export DOCKSY_READONLY=1`, to give Claude visibility with no write tools at all.
- The MCP server runs via `npx -y @crovenai/docksy-mcp`, so Node 20+ is required.

## What's inside

| Type | Name | What it does |
|---|---|---|
| MCP server | `docksy` | 34 tools: servers, apps, deploys, logs, metrics, alerts, uptime, backups, `diagnose` |
| Command | `/docksy:deploy [app]` | Deploy (creating the app on the first run), watch the build, verify the URL |
| Command | `/docksy:status [target]` | Fleet health at a glance: servers, apps, alerts, uptime |
| Command | `/docksy:diagnose [target]` | Root-cause a slow, failing or down server or app |
| Command | `/docksy:logs <app> [--build] [n]` | Recent logs with errors highlighted and explained |
| Command | `/docksy:rollback <app> [id]` | Zero-downtime rollback to a previous good deploy |
| Skill | `docksy-deploy` | Detect the stack → Dockerfile → create app → deploy → watch → verify |
| Skill | `docksy-diagnose` | Evidence-first diagnosis; changes things only with your OK |
| Skill | `docksy-incident` | Triage → mitigate → root cause → postmortem |
| Skill | `docksy-setup-server` | Add and provision a VPS, then confirm metrics flow |
| Skill | `docksy-add-database` | One-click Postgres/MySQL/Redis/Mongo + daily **verified** backups |
| Skill | `docksy-dockerize` | Write a production Dockerfile and .dockerignore for your repo |
| Agent | `docksy-sre` | An SRE subagent Claude can delegate investigations to |
| Hook | `PreToolUse` | Always asks before `delete_app`, `delete_server`, `restore_backup` |

Skills load automatically when they're relevant: just say "deploy this to my server" or "why is prod slow?". You can also invoke them directly as `/docksy:docksy-deploy`, and so on.

## Safety

Docksy is safe by default, in three layers:
1. **Destructive tools require `confirm: true`** in their input. The MCP server refuses them otherwise.
2. **This plugin's hook** returns `permissionDecision: "ask"` for those three tools, so you're always prompted, even in auto mode or when the tool is allow-listed. The prompt is labelled `[plugin:docksy]`.
3. **The skills and the SRE agent** ask before every write and never use destructive tools as a fix.

## Without the plugin

You only want the MCP server? Then run:

```bash
claude mcp add docksy --env DOCKSY_URL=https://docksy.example.com --env DOCKSY_TOKEN=dsk_... -- npx -y @crovenai/docksy-mcp
```

The confirmation hook also matches tools from a server you added by hand under the name `docksy` (`mcp__docksy__delete_app`…), but only while the plugin is enabled.

## Develop

```bash
claude --plugin-dir ./plugin      # load the plugin from a checkout
claude plugin validate ./plugin   # validate the manifest, skills, hooks and MCP config
```

Full docs: <https://osmanyousaaf.github.io/Docksy/claude.html>. License: Apache-2.0.
