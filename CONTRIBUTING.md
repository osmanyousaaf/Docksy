# Contributing to Docksy

Thanks for helping! Docksy is free forever, and contributions of every size matter: typo fixes, templates, docs, bug reports and features.

## Ground rules

- **Free forever.** No telemetry, no paid features, no phoning home. PRs that add any of these won't be merged.
- **Safe by default.** Destructive actions need explicit confirmation (`confirm: true` in the API and MCP, a dialog in the UI).
- **Simple, kind UX copy.** Write for a tired developer at 2 a.m.
- **No AI inside Docksy.** The server never calls an LLM. Claude features live in the MCP server and the plugin, and `diagnose` stays deterministic.
- Be respectful. We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

## Project layout

| Path | What | Stack |
|---|---|---|
| `apps/server` | API + background jobs | Node 24 (runs TypeScript directly), Hono 4, zod 4, `node:sqlite`, ssh2 |
| `apps/web` | Dashboard | React 19, Vite, Tailwind 4, TanStack Query, recharts |
| `packages/shared` | Shared types (types only) | TypeScript |
| `packages/client` | Typed API client | TypeScript |
| `packages/cli` | `docksy` CLI | commander, picocolors, esbuild |
| `packages/mcp` | MCP server | `@modelcontextprotocol/sdk` |
| `agent/` | Metrics agent | Go, standard library only |
| `plugin/` | Claude Code plugin | Markdown + JSON |
| `deploy/scripts` | Server provisioning | Bash |
| `docs/` | Website | Plain HTML/CSS |

`CONTRACT.md` describes the API, conventions and module boundaries. Read it before larger changes.

## Development setup

```bash
git clone https://github.com/osmanyousaaf/docksy && cd docksy
npm install                 # Node 24+
npm run dev:server          # API on :8080
npm run dev:web             # dashboard with hot reload
```

There's no local VPS? `e2e/fake-vps` boots a Debian + sshd + Docker-in-Docker container that behaves like a server: run `e2e/run.sh`.

The Go agent is built and tested in Docker, so you don't need Go installed:

```bash
docker run --rm -v "$PWD/agent":/src -v docksy-gomod:/go/pkg/mod -w /src golang:1.24 go test ./...
```

## Conventions

- **Server TypeScript** runs without a build step:
  - relative imports end in `.ts`
  - only erasable syntax (no `enum`, `namespace` or parameter properties)
  - shared types use `import type`
- **Tests** use `node --test`, with `*.test.ts` files next to the code. No network in tests: inject or mock SSH and HTTP.
- **API:** validate input with zod, throw `HttpError` helpers, and log an activity entry on every write.
- **Dependencies:** please open an issue before adding a new one. Small and few is a feature.

## Before you open a PR

```bash
npm run typecheck
npm test
npm run build -w @docksy/web
claude plugin validate ./plugin   # if you touched plugin/
```

- Keep PRs focused. Small PRs get reviewed fast.
- Add or update tests for logic changes, and docs for user-facing changes (`docs/*.html`, `README.md`).
- Add a line under **Unreleased** in `CHANGELOG.md`.
- Use a clear title in the imperative mood: "Add Gitea webhooks", not "Added gitea".

## Good first contributions

- **One-click templates** in `apps/server/src/core/apps/templates.ts`
- **Notification channels** (ntfy, Gotify, Pushover, Matrix…)
- **Diagnose rules**: new deterministic findings with clear evidence and suggestions
- **Docs**: guides for specific frameworks and VPS providers
- **Plugin skills**: better playbooks in `plugin/skills/*/SKILL.md`

Look for issues labelled [`good first issue`](https://github.com/osmanyousaaf/docksy/labels/good%20first%20issue).

## Reporting bugs

Open an issue with your Docksy version, the server OS, what you expected and what happened, plus the relevant logs (`docker logs docksy`, the deployment log, `journalctl -u docksy-agent`). Remove secrets first.

Security issues go through [SECURITY.md](SECURITY.md), never public issues.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
