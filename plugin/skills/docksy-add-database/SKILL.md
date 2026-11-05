---
name: docksy-add-database
description: Create a one-click database (PostgreSQL, MySQL, MariaDB, MongoDB or Redis) on a Docksy server from a template, wire its connection string into the user's app, and turn on daily backups with automatic restore verification. Use for "add a database", "I need Postgres", "set up Redis", "my app needs a DB", or "back up my database".
when_to_use: Trigger phrases include "add postgres", "create database", "add redis cache", "mysql for my app", "set up backups", "verified backups", "DATABASE_URL". Also for other one-click services in the template gallery (n8n, Uptime Kuma, Plausible, Umami, MinIO, Ghost, WordPress), skipping the backup step.
argument-hint: "[engine] [for-app]"
allowed-tools: Read Grep Glob mcp__plugin_docksy_docksy__list_templates mcp__plugin_docksy_docksy__list_servers mcp__plugin_docksy_docksy__get_server mcp__plugin_docksy_docksy__list_apps mcp__plugin_docksy_docksy__get_app mcp__plugin_docksy_docksy__list_deployments mcp__plugin_docksy_docksy__get_app_logs mcp__plugin_docksy_docksy__list_backups mcp__plugin_docksy_docksy__diagnose
---

# Add a database with Docksy

End state: a running database, a connection string set on the app that needs it, and a **daily backup that's verified by a real restore**.

Arguments: `$ARGUMENTS` (e.g. `postgres for api`).

## 1. Choose the engine and server

1. `list_templates`. Use the `kind: database` entries and note which have `backupSupported`.
2. If the user didn't say: Postgres for general app data, Redis for cache/queues, MongoDB only when the code already uses it. Read the repo (`package.json`, `requirements.txt`, ORM config like `prisma/schema.prisma`) to confirm.
3. Put it **on the same server as the app** that uses it, so traffic stays on the private `docksy` network. `get_app` → `serverId`.

## 2. Create it

`create_app` with:
- `template`: e.g. `postgres`
- `name`: e.g. `api-db`
- `serverId`

The template fills the image, port, volume and env. Passwords come from `{{random:N}}` placeholders, so Docksy generates them and you never choose or see weak ones. Then `deploy_app` and poll `list_deployments` until it succeeds.

Databases get **no public domain**. They're reachable only inside the `docksy` network.

## 3. Wire it into the app

1. Build the connection string from the database app's env. The host is the database **app name** on the `docksy` network, e.g.:
   - Postgres: `postgres://postgres:<POSTGRES_PASSWORD>@api-db:5432/postgres`
   - MySQL/MariaDB: `mysql://root:<MYSQL_ROOT_PASSWORD>@api-db:3306/<db>`
   - Redis: `redis://:<password>@api-db:6379`
   - MongoDB: `mongodb://<user>:<pass>@api-db:27017`

   Don't print passwords in chat. Tell the user they're set, and where.
2. Find the variable the code expects (`DATABASE_URL`, `REDIS_URL`, `MONGO_URI`…) by grepping the repo.
3. With consent: `set_env_vars` on the app, then `deploy_app` (env changes apply on the next deploy).
4. Check `get_app_logs` for connection errors after the deploy.

## 4. Turn on verified backups

Skip this for Redis used purely as a cache (ask).

1. `create_backup` with:
   - `appId`: the database app
   - `schedule: "daily"`
   - `retention: 7` (keep the last 7)
   - `verify: true`, which is the important part: after each run, Docksy restores the dump into a throwaway container and runs a sanity query
   - destination `local`, or `s3` with endpoint/bucket/region/keys if the user wants off-site copies (recommended for production; Backblaze B2, Cloudflare R2, MinIO and AWS all work)
2. `run_backup` once right now, so there's a known-good backup from day one.
3. Poll `list_backups` until the run shows `succeeded` and `verified: passed`. If verification fails, read the run log, explain it, and fix it before calling the job done.

A failed backup fires the default **Backup failed** alert (critical).

## 5. Report

```
🗄️  api-db (PostgreSQL 17) running on prod-1, private to the docksy network
Wired:   DATABASE_URL set on api → redeployed ✓ connected
Backups: daily · keep 7 · local + s3://bucket/api-db · first run 4.2 MB ✓ verified
Restore: Docksy UI → api-db → Backups → Restore (asks for confirmation)
```

Restoring overwrites live data. Only call `restore_backup` when the user explicitly asks, after you've shown them which run (time, size, verified) will be restored.
