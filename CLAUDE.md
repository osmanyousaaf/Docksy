# Docksy

Docksy is a free-forever, open-source, self-hosted PaaS: a simpler Coolify with monitoring on by default and first-class Claude integration (MCP + Claude Code plugin). The repo is `github.com/osmanyousaaf/docksy`; npm packages live under `@crovenai/*`.

- **Read `CONTRACT.md` first.** It is the source of truth for architecture, API, ownership and conventions.
- **Layout:**
  - `apps/server`: Hono API, run directly by Node 24 type stripping
  - `apps/web`: React/Vite UI
  - `packages/shared`: types only
  - `packages/client`, `packages/cli`, `packages/mcp`
  - `agent/`: Go metrics agent
  - `plugin/`: Claude Code plugin
  - `deploy/`: server scripts
  - `e2e/`
- **Server code:**
  - relative imports end in `.ts`
  - only erasable TypeScript syntax (no enums, namespaces or parameter properties)
  - shared types are imported with `import type`
- **Go is not installed locally.** Build and test the agent with `docker run --rm -v "$PWD/agent":/src -v docksy-gomod:/go/pkg/mod -w /src golang:1.24 …`.
- **Dependencies are managed by the integrator.** Don't add packages without asking.
- **Verify before claiming done:**
  - `npm run typecheck -w @docksy/server`
  - `npm test -w @docksy/server`
  - `npm run build -w @docksy/web`
- **Principles:**
  - free forever: no telemetry and no paid features
  - safe by default: destructive actions need confirmation
  - simple, kind UX copy
