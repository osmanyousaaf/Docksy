## What does this change?

<!-- A short description, and the issue it closes (e.g. "Closes #123"). -->

## How was it tested?

<!-- Commands you ran, screenshots for UI changes, or an e2e run (`bash e2e/run.sh`). -->

## Checklist

- [ ] `npm run typecheck` and `npm test` pass
- [ ] UI changes build (`npm run build -w @docksy/web`) and look right in dark mode
- [ ] Agent changes pass `go test ./...` (in `agent/`)
- [ ] Shell scripts pass `bash -n` and `shellcheck`
- [ ] Destructive actions ask for confirmation
- [ ] No telemetry, no paid-only features, no new dependencies without discussion
- [ ] Docs updated (`docs/`, `README.md`) if behavior changed
