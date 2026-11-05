#!/usr/bin/env bash
# Run the Docksy server (node --watch) and the web UI (Vite) together.
#   scripts/dev.sh                 server on :8080, web on :5173
#   PORT=8114 scripts/dev.sh       custom server port
# Ctrl-C stops both. Data goes to apps/server/data unless DOCKSY_DATA_DIR is set.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v node >/dev/null 2>&1 || { echo "node is not installed (Docksy needs Node 24)." >&2; exit 1; }
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 24 ] || echo "warning: Node $major found; Docksy is developed on Node 24." >&2
[ -d node_modules ] || { echo "Dependencies are missing. Run: npm ci" >&2; exit 1; }

export PORT="${PORT:-8080}"
export DOCKSY_DATA_DIR="${DOCKSY_DATA_DIR:-$ROOT/apps/server/data}"
# Vite proxies /api to DOCKSY_API (see apps/web/vite.config.ts).
export DOCKSY_API="${DOCKSY_API:-http://127.0.0.1:$PORT}"

pids=()
kill_tree() {
  local p="$1" c
  for c in $(pgrep -P "$p" 2>/dev/null); do kill_tree "$c"; done
  kill "$p" 2>/dev/null || true
}
cleanup() {
  trap - INT TERM EXIT
  for p in "${pids[@]}"; do kill_tree "$p"; done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

prefix() { local tag="$1" color="$2"; while IFS= read -r line; do printf '\033[%sm%-6s\033[0m %s\n' "$color" "$tag" "$line"; done; }

echo "Docksy dev: server http://127.0.0.1:$PORT  (data: $DOCKSY_DATA_DIR)"
(npm run dev -w @docksy/server 2>&1 | prefix server 36) &
pids+=($!)
(npm run dev -w @docksy/web 2>&1 | prefix web 35) &
pids+=($!)

# Exit when either process stops.
while :; do
  for p in "${pids[@]}"; do
    if ! kill -0 "$p" 2>/dev/null; then echo "a dev process exited; stopping" >&2; exit 1; fi
  done
  sleep 1
done
