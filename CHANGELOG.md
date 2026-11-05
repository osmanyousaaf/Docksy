# Changelog

All notable changes to Docksy are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Docksy uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-01

The first public release.

### Added

- **Control plane:**
  - a single-container Hono API and React dashboard
  - SQLite storage
  - owner setup and login
  - API tokens with `full`/`read` scopes
  - an activity log
  - secrets encrypted at rest (AES-256-GCM)
- **Servers:**
  - SSH key onboarding with validation
  - idempotent provisioning: Docker, the `docksy` network, the Caddy proxy with automatic HTTPS, and the metrics agent
- **Deploys:**
  - deploy from GitHub repos (`auto`, `dockerfile`, `compose`) or Docker images
  - zero-downtime container switching with health checks
  - one-click rollback
  - auto-deploy on push via a signed GitHub webhook
  - live build and runtime logs
- **Templates:** PostgreSQL, MySQL, MariaDB, Redis, MongoDB, n8n, Uptime Kuma, Plausible, Umami, MinIO, Ghost, WordPress.
- **Monitoring:**
  - a Go agent (static, standard library only, under 15 MB RSS) reporting server and container metrics every 10s
  - live charts with a per-core heatmap
  - 10s/1m/1h rollups with retention
- **Alerts:**
  - ten default rules (CPU, memory, disk, offline, container down/restarts, deploy failed, uptime down, backup failed)
  - Discord, Slack, Telegram, webhook and email channels
  - auto-resolve and acknowledge
- **Uptime:** HTTP checks, auto-created for app domains, and a public status page.
- **Backups:** scheduled dumps for Postgres, MySQL/MariaDB, MongoDB and Redis, to local disk or S3-compatible storage, with **automatic restore verification**.
- **Diagnose:** a deterministic health report for servers and apps, with evidence, suggestions and MCP fix actions.
- **CLI** (`@crovenai/docksy`):
  - status, servers, apps, deploy, logs, rollback, env, metrics TUI, diagnose, alerts, mcp
  - `--json` everywhere
- **MCP server** (`@crovenai/docksy-mcp`):
  - 34 tools, with resources and prompts
  - stdio and loopback-only streamable HTTP
  - a read-only mode
- **Claude Code plugin** (`/plugin install docksy@docksy`):
  - skills: deploy, diagnose, incident, setup-server, add-database, dockerize
  - five slash commands
  - the `docksy-sre` subagent
  - a hook that asks before destructive tools
- **One-line installer** with `--uninstall`, a multi-arch image on GHCR, and the docs site.

[Unreleased]: https://github.com/osmanyousaaf/docksy/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/osmanyousaaf/docksy/releases/tag/v0.1.0
