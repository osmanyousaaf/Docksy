---
name: docksy-deploy
description: Deploy the user's project (or a Docker image) to their own server with Docksy, then watch the build and prove the URL works. Use when the user says "deploy this", "ship it", "put this on my server", "host this app", "push to production", or asks to redeploy an existing Docksy app.
when_to_use: Trigger phrases include "deploy to docksy", "deploy this repo", "ship this", "redeploy", "launch on my VPS", "make this live". Not for databases (use docksy-add-database) or for new servers (use docksy-setup-server).
argument-hint: "[app-name]"
allowed-tools: Read Grep Glob Bash(git remote *) Bash(git branch *) Bash(git rev-parse *) Bash(git status *) Bash(git log *) Bash(curl -sS -o /dev/null *) mcp__plugin_docksy_docksy__list_servers mcp__plugin_docksy_docksy__get_server mcp__plugin_docksy_docksy__list_apps mcp__plugin_docksy_docksy__get_app mcp__plugin_docksy_docksy__list_deployments mcp__plugin_docksy_docksy__get_deployment_logs mcp__plugin_docksy_docksy__get_app_logs mcp__plugin_docksy_docksy__list_templates mcp__plugin_docksy_docksy__diagnose
---

# Deploy with Docksy

Goal: the user's code is running on their server, behind HTTPS, and you have **seen it answer**. A deploy you didn't verify isn't done.

Arguments: `$ARGUMENTS` (an optional app name). If it's empty, work it out from the repository.

## 0. Preflight

1. Call `list_servers`. If the tool doesn't exist or errors with a config message, Docksy isn't connected. Tell the user to set `DOCKSY_URL` and `DOCKSY_TOKEN` (an API token from Docksy → Settings → API tokens), restart Claude Code, and stop.
2. If there are no servers, hand off to the `docksy-setup-server` skill first.
3. If there are several servers, pick the one the user names. Otherwise ask, and suggest the one with the most free memory (`get_server`).

## 1. Detect the stack

Look at the repo root (Read/Glob, don't guess):

| Found | Stack | Usual port |
|---|---|---|
| `Dockerfile` | use it as is (`buildType: dockerfile`) | the `EXPOSE`d port |
| `docker-compose.yml` / `compose.yaml` | compose (`buildType: compose`) | the web service's port |
| `package.json` | Node (Next.js, Express, Nest, Vite SSR…) | 3000 |
| `requirements.txt` / `pyproject.toml` | Python (FastAPI, Django, Flask) | 8000 |
| `go.mod` | Go | 8080 |
| only `index.html` | static site | 80 |

Also note a health endpoint if one exists (`/health`, `/healthz`, `/api/health`). It makes zero-downtime deploys safer.

## 2. Make sure there's a good Dockerfile

- If a Dockerfile exists, skim it for obvious problems: it runs as root with no reason, it has no `EXPOSE`, it copies `node_modules` in, or it uses `latest` tags. Mention these, but don't block on them.
- If there's no Dockerfile, Docksy's `auto` build can generate one for simple Node, Python, Go and static apps. For anything non-trivial (monorepos, native deps, a custom build step), use the **docksy-dockerize** skill to write a production Dockerfile, and commit it with the user's OK.
- Docksy builds from the **git remote**, not your local files. Check `git status` and `git log origin/<branch>..HEAD`. If there are uncommitted or unpushed changes the deploy needs, say so and ask the user to push (don't push for them unless asked).

## 3. Create the app (first deploy only)

Call `list_apps` first. If an app already points at this repo, or has the requested name, skip to step 4.

Otherwise call `create_app` with:
- `name`: lowercase `a-z0-9-`, derived from the repo name
- `serverId`
- `sourceType: "git"`, `repoUrl` (from `git remote get-url origin`, as https) and `branch` (the current branch, usually `main`)
- `buildType`: `dockerfile`, `compose` or `auto`
- `port`
- `healthcheckPath` if you found one
- `domains`: only if the user gave one. Otherwise Docksy assigns `<app>.<server-ip>.sslip.io` with automatic TLS.
- For a private repo, ask the user for a GitHub token with read access and pass it as `gitToken`. Never echo it back.

If the app needs environment variables (look for `.env.example`, `process.env.X`, `os.environ[...]`), list the ones you found and ask for values. Then call `set_env_vars`. Never invent secrets; generate random ones only for values like `SESSION_SECRET`, and say so.

## 4. Deploy

Call `deploy_app`. It returns a deployment (queued → building → deploying → succeeded/failed).

## 5. Watch it

Poll `list_deployments` for the app (or `get_deployment_logs` for the id) every 10–20 seconds. Give the user short progress notes ("cloning…", "building image…", "waiting for health check…"), not the full log.

- **Succeeded:** go to step 6.
- **Failed:** read `get_deployment_logs`, find the first real error (not the last line), explain it in one or two sentences and propose a fix. Typical ones: a missing build script, a wrong port, a missing env var, out of memory during the build (`diagnose` on the server confirms it). Old containers keep serving traffic on failure, so nothing is down. Fix it, push, and redeploy only with the user's OK.

## 6. Verify

1. `get_app` → take the primary domain.
2. `curl -sS -o /dev/null -w "%{http_code} %{time_total}s" https://<domain><healthcheckPath or />`.
   A fresh sslip.io certificate can take up to a minute, so retry a few times.
3. Call `get_app_logs` (tail ~50) and check that there are no crash loops or stack traces.
4. If anything looks off, run `diagnose` with the app id and reason over the findings.

## 7. Report

Finish with a compact summary:

```
✅ <app> deployed to <server>  (commit <sha7> "<message>")
URL:     https://<domain>   → 200 in 0.21s
Build:   1m 42s · image docksy/<app>:<short>
Next:    auto-deploy on push is <on/off> · uptime check created · /docksy:logs <app>
```

Offer the obvious next steps once: a custom domain (point an A record to the server IP, then `update_app` with `domains`), auto-deploy on push (`get_app` → webhook URL), and a database (`docksy-add-database`).
