#!/usr/bin/env bash
# Docksy end-to-end test against a local fake VPS.
#
#   bash e2e/run.sh            run everything, tear down at the end
#   bash e2e/run.sh --keep     leave the server and the fake VPS running for poking around
#
# Steps:
#   1. start the Docksy server locally (node, temp data dir, port $E2E_PORT)
#   2. setup the owner, create an API token, read Docksy's SSH public key
#   3. start the fake VPS (systemd + sshd + Docker-in-Docker) with that key authorized
#   4. add the server -> validate -> provision (provision.sh + install-agent.sh over SSH)
#   5. build e2e/sample-app inside the VPS and push it to a registry on the VPS
#   6. create an image app -> deploy -> assert it succeeded and the container is up
#   7. assert server metrics arrive within 60s
#   8. tear down (unless --keep)
#
# Env: E2E_PORT (8199), E2E_SSH_PORT (2299), E2E_HTTP_PORT (8299), E2E_HTTPS_PORT (8499),
#      E2E_WORK (temp dir), E2E_TIMEOUT_PROVISION (600), E2E_TIMEOUT_DEPLOY (600).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEEP=0
for a in "$@"; do
  case "$a" in
    --keep) KEEP=1 ;;
    -h|--help) sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $a (try --help)" >&2; exit 2 ;;
  esac
done

PORT="${E2E_PORT:-8199}"
SSH_PORT="${E2E_SSH_PORT:-2299}"
HTTP_PORT="${E2E_HTTP_PORT:-8299}"
HTTPS_PORT="${E2E_HTTPS_PORT:-8499}"
T_PROVISION="${E2E_TIMEOUT_PROVISION:-600}"
T_DEPLOY="${E2E_TIMEOUT_DEPLOY:-600}"
VPS=docksy-e2e-vps
VPS_IMAGE=docksy-e2e-vps:latest
APP_NAME=e2e-sample
APP_DOMAIN=e2e-sample.localhost
API="http://127.0.0.1:$PORT/api/v1"
WORK="${E2E_WORK:-$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/docksy-e2e.XXXXXX")}"
WORK="${WORK%/}"
mkdir -p "$WORK"
SERVER_LOG="$WORK/server.log"
SERVER_PID=""
TOKEN=""
OK=0

if [ -t 1 ]; then B=$'\033[1m' G=$'\033[32m' R=$'\033[31m' Y=$'\033[33m' C=$'\033[36m' D=$'\033[2m' N=$'\033[0m'
else B="" G="" R="" Y="" C="" D="" N=""; fi
T0=$(date +%s)
el() { printf '%4ss' "$(( $(date +%s) - T0 ))"; }
step() { printf '\n%s%s ▸ %s%s\n' "$C$B" "$(el)" "$*" "$N"; }
log()  { printf '%s       %s%s\n' "$D" "$*" "$N"; }
pass() { printf '%s       ✓ %s%s\n' "$G" "$*" "$N"; }
warn() { printf '%s       ! %s%s\n' "$Y" "$*" "$N" >&2; }
fail() { printf '\n%s%s ✗ %s%s\n' "$R$B" "$(el)" "$*" "$N" >&2; exit 1; }

teardown() {
  local rc=$?
  set +e
  if [ "$KEEP" = 1 ]; then
    printf '\n%sLeft running (--keep):%s\n' "$B" "$N"
    printf '  Docksy   http://127.0.0.1:%s  (pid %s, log %s)\n' "$PORT" "${SERVER_PID:-?}" "$SERVER_LOG"
    printf '  Token    %s\n' "${TOKEN:-?}"
    printf '  VPS      ssh -p %s -i %s root@127.0.0.1   |   docker exec -it %s bash\n' "$SSH_PORT" "$WORK/data/keys/id_ed25519" "$VPS"
    printf '  Clean up: kill %s; docker rm -fv %s; rm -rf %s\n' "${SERVER_PID:-<pid>}" "$VPS" "$WORK"
    exit "$rc"
  fi
  step "Tearing down"
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null
  fi
  if [ "$rc" -ne 0 ] && docker container inspect "$VPS" >/dev/null 2>&1; then
    docker exec "$VPS" journalctl -u docksy-agent -n 50 --no-pager >"$WORK/agent.log" 2>&1
    docker exec "$VPS" docker ps -a >"$WORK/vps-containers.log" 2>&1
  fi
  docker rm -fv "$VPS" >/dev/null 2>&1
  if [ "$rc" -eq 0 ] && [ "$OK" = 1 ]; then
    rm -rf "$WORK"
    printf '\n%s%sE2E passed%s in %ss\n' "$G" "$B" "$N" "$(( $(date +%s) - T0 ))"
  else
    printf '\n%s%sE2E failed%s. Logs kept in %s\n' "$R" "$B" "$N" "$WORK"
    [ -f "$SERVER_LOG" ] && { printf '%s--- last server log lines ---%s\n' "$D" "$N"; tail -n 25 "$SERVER_LOG"; }
  fi
  exit "$rc"
}
trap teardown EXIT
trap 'exit 130' INT TERM

# ── helpers ─────────────────────────────────────────────────────────────────
# jq-ish: `... | jget '.items.length'` (a JS property path applied to the parsed JSON).
jget() {
  node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let v; try { v = new Function("o", "return o" + process.argv[1])(JSON.parse(s)); } catch { v = undefined; }
      process.stdout.write(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
    });' "$1"
}

# api METHOD PATH [JSON]  -> prints the body; fails on HTTP >= 400 unless API_ALLOW_FAIL=1.
api() {
  local method="$1" path="$2" data="${3:-}" out code auth=()
  out="$WORK/resp.json"
  [ -n "$TOKEN" ] && auth=(-H "Authorization: Bearer $TOKEN")
  local args=(-sS -o "$out" -w '%{http_code}' -X "$method" -b "$WORK/cookies" -c "$WORK/cookies" -H 'Accept: application/json')
  [ -n "$data" ] && args+=(-H 'Content-Type: application/json' --data "$data")
  code="$(curl "${args[@]}" ${auth[@]+"${auth[@]}"} "$API$path" || echo 000)"
  if [ "$code" -ge 400 ] || [ "$code" = 000 ]; then
    if [ "${API_ALLOW_FAIL:-0}" = 1 ]; then cat "$out" 2>/dev/null; return 1; fi
    fail "$method $path -> HTTP $code: $(cat "$out" 2>/dev/null | head -c 600)"
  fi
  cat "$out"
}

vps() { docker exec "$VPS" "$@"; }

# ── 0. preflight ────────────────────────────────────────────────────────────
step "Preflight"
for bin in docker node curl; do command -v "$bin" >/dev/null 2>&1 || fail "$bin is required"; done
docker info >/dev/null 2>&1 || fail "Docker is not running"
[ -d "$ROOT/node_modules" ] || fail "node_modules missing: run npm ci in $ROOT"
log "work dir: $WORK"
if curl -fsS "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1; then fail "port $PORT is already in use (set E2E_PORT)"; fi

VPS_ARCH="$(docker info --format '{{.Architecture}}')"
case "$VPS_ARCH" in x86_64|amd64) VPS_ARCH=amd64 ;; aarch64|arm64) VPS_ARCH=arm64 ;; esac
AGENT_BIN="$ROOT/agent/bin/docksy-agent-linux-$VPS_ARCH"
if [ ! -s "$AGENT_BIN" ]; then
  if [ -f "$ROOT/agent/go.mod" ]; then
    log "agent binary missing; building agent/bin/docksy-agent-linux-$VPS_ARCH in golang:1.24"
    pkg=./cmd/docksy-agent; [ -d "$ROOT/agent/cmd/docksy-agent" ] || pkg=.
    docker run --rm -v "$ROOT/agent":/src -v docksy-gomod:/go/pkg/mod -w /src \
      -e CGO_ENABLED=0 -e GOOS=linux -e GOARCH="$VPS_ARCH" golang:1.24 \
      go build -trimpath -ldflags "-s -w -X main.version=e2e" -o "bin/docksy-agent-linux-$VPS_ARCH" "$pkg" \
      >"$WORK/agent-build.log" 2>&1 || fail "agent build failed (see $WORK/agent-build.log)"
  else
    warn "no agent source (agent/go.mod) and no binary: install-agent.sh will fall back to GitHub releases"
  fi
fi
[ -s "$AGENT_BIN" ] && pass "agent binary: $AGENT_BIN"

step "Building the fake VPS image"
docker build -q -t "$VPS_IMAGE" "$ROOT/e2e/fake-vps" >"$WORK/vps-build.log" 2>&1 \
  || { cat "$WORK/vps-build.log" >&2; fail "fake VPS image build failed"; }
pass "$VPS_IMAGE"
docker rm -fv "$VPS" >/dev/null 2>&1 || true

# ── 1. Docksy server ────────────────────────────────────────────────────────
step "Starting Docksy on :$PORT"
(
  cd "$ROOT"
  export PORT HOST=0.0.0.0 DOCKSY_DATA_DIR="$WORK/data" DOCKSY_PUBLIC_URL="http://host.docker.internal:$PORT" \
    DOCKSY_AGENT_INTERVAL=5 NODE_ENV=development
  exec node apps/server/src/index.ts
) >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 30); do
  curl -fsS "$API/health" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { cat "$SERVER_LOG" >&2; fail "the server exited during startup"; }
  sleep 1
done
curl -fsS "$API/health" >/dev/null 2>&1 || fail "server did not become healthy (log: $SERVER_LOG)"
pass "healthy: $(curl -fsS "$API/health")"

# ── 2. owner, token, key ────────────────────────────────────────────────────
step "Creating the owner and an API token"
api POST /auth/setup '{"email":"e2e@docksy.local","name":"E2E","password":"e2e-correct-horse-battery"}' >/dev/null
TOKEN="$(api POST /tokens '{"name":"e2e","scope":"full"}' | jget '.plaintext')"
[[ "$TOKEN" == dsk_* ]] || fail "unexpected token response"
rm -f "$WORK/cookies"
[ "$(api GET /auth/me | jget '.email')" = "e2e@docksy.local" ] || fail "token auth did not work"
pass "owner e2e@docksy.local, token ${TOKEN:0:10}…"
PUBKEY="$(api GET /ssh-key | jget '.publicKey')"
[[ "$PUBKEY" == ssh-ed25519\ * ]] || fail "unexpected /ssh-key response: $PUBKEY"
pass "Docksy key $(api GET /ssh-key | jget '.fingerprint')"

# ── 3. fake VPS ─────────────────────────────────────────────────────────────
step "Booting the fake VPS (ssh on 127.0.0.1:$SSH_PORT)"
docker run -d --name "$VPS" --hostname docksy-e2e-vps \
  --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock \
  --add-host host.docker.internal:host-gateway \
  -e SSH_AUTHORIZED_KEYS="$PUBKEY" \
  -p "127.0.0.1:$SSH_PORT:22" -p "127.0.0.1:$HTTP_PORT:80" -p "127.0.0.1:$HTTPS_PORT:443" \
  "$VPS_IMAGE" >/dev/null
for _ in $(seq 1 60); do
  if vps systemctl is-active --quiet ssh 2>/dev/null && vps docker info >/dev/null 2>&1; then break; fi
  sleep 1
done
vps systemctl is-active --quiet ssh || fail "sshd did not start in the fake VPS"
vps docker info >/dev/null 2>&1 || fail "Docker did not start in the fake VPS"
vps grep -qF "$PUBKEY" /root/.ssh/authorized_keys || fail "Docksy's key was not installed in the fake VPS"
pass "systemd, sshd and Docker are up; key authorized"
vps curl -fsS --max-time 5 "http://host.docker.internal:$PORT/api/v1/health" >/dev/null \
  || fail "the fake VPS cannot reach Docksy at http://host.docker.internal:$PORT"
pass "VPS can reach Docksy at http://host.docker.internal:$PORT"

# ── 4. add, validate, provision ─────────────────────────────────────────────
step "Adding the server"
SERVER_ID="$(api POST /servers "{\"name\":\"e2e-vps\",\"host\":\"127.0.0.1\",\"port\":$SSH_PORT,\"sshUser\":\"root\"}" | jget '.id')"
[ -n "$SERVER_ID" ] || fail "no server id returned"
pass "server $SERVER_ID"

step "Validating"
api POST "/servers/$SERVER_ID/validate" >"$WORK/validate.json"
# shellcheck disable=SC2016  # JS template literal, not shell
node -e 'const r=require(process.argv[1]); for (const c of r.checks||[]) console.log(`       ${c.ok?"✓":"✗"} ${c.name}: ${c.detail}`)' "$WORK/validate.json"
[ "$(jget '.ok' <"$WORK/validate.json")" = true ] || fail "validation failed"
pass "validation ok"

step "Provisioning (provision.sh + install-agent.sh)"
api POST "/servers/$SERVER_ID/provision" >/dev/null
shown=0 status=running deadline=$(( $(date +%s) + T_PROVISION ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  api GET "/servers/$SERVER_ID/provision" >"$WORK/provision.json"
  status="$(jget '.status' <"$WORK/provision.json")"
  jget '.log' <"$WORK/provision.json" >"$WORK/provision.log"
  total="$(wc -l <"$WORK/provision.log" | tr -d ' ')"
  if [ "$total" -gt "$shown" ]; then sed -n "$((shown + 1)),${total}p" "$WORK/provision.log" | sed 's/^/       │ /'; shown="$total"; fi
  [ "$status" = running ] || break
  sleep 2
done
[ "$status" = succeeded ] || fail "provisioning ended with status '$status' (log: $WORK/provision.log)"
vps systemctl is-active --quiet docksy-agent || fail "docksy-agent.service is not active on the VPS"
[ "$(vps docker inspect -f '{{.State.Running}}' docksy-proxy 2>/dev/null)" = true ] || fail "docksy-proxy is not running on the VPS"
pass "provisioned: proxy running, agent active"

# ── 5. sample app image ─────────────────────────────────────────────────────
step "Building the sample app inside the VPS"
vps mkdir -p /srv/sample-app
docker cp "$ROOT/e2e/sample-app/." "$VPS:/srv/sample-app/"
if ! vps docker container inspect e2e-registry >/dev/null 2>&1; then
  vps docker run -d -q --name e2e-registry --restart unless-stopped -p 127.0.0.1:5000:5000 registry:2 >/dev/null
fi
IMAGE=localhost:5000/docksy-e2e-sample:1
vps docker build -q -t "$IMAGE" /srv/sample-app >"$WORK/sample-build.log" 2>&1 \
  || { cat "$WORK/sample-build.log" >&2; fail "sample app build failed"; }
for _ in $(seq 1 10); do vps docker push -q "$IMAGE" >/dev/null 2>&1 && break; sleep 1; done
vps docker rmi "$IMAGE" >/dev/null 2>&1 || true   # make the deploy really pull it
pass "$IMAGE pushed to the VPS registry"

# ── 6. app + deploy ─────────────────────────────────────────────────────────
step "Creating app $APP_NAME"
APP_ID="$(api POST /apps "{\"name\":\"$APP_NAME\",\"serverId\":\"$SERVER_ID\",\"sourceType\":\"image\",\"buildType\":\"image\",\"image\":\"$IMAGE\",\"port\":3000,\"healthcheckPath\":\"/health\",\"domains\":[\"$APP_DOMAIN\"],\"env\":{\"APP_NAME\":\"$APP_NAME\"}}" | jget '.id')"
[ -n "$APP_ID" ] || fail "no app id returned"
pass "app $APP_ID"

step "Deploying"
DEP_ID="$(api POST "/apps/$APP_ID/deploy" '{"trigger":"api"}' | jget '.id')"
[ -n "$DEP_ID" ] || fail "no deployment id returned"
log "deployment $DEP_ID"
dstatus=queued deadline=$(( $(date +%s) + T_DEPLOY )) last=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  dstatus="$(api GET "/deployments/$DEP_ID" | jget '.status')"
  [ "$dstatus" != "$last" ] && { log "status: $dstatus"; last="$dstatus"; }
  case "$dstatus" in succeeded|failed|cancelled) break ;; esac
  sleep 2
done
api GET "/deployments/$DEP_ID/logs" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{ try { for (const l of JSON.parse(s).items||[]) console.log(l.line); } catch {} });' \
  >"$WORK/deploy.log" || true
if [ "$dstatus" != succeeded ]; then
  sed 's/^/       │ /' "$WORK/deploy.log" | tail -n 40
  fail "deployment ended with status '$dstatus': $(api GET "/deployments/$DEP_ID" | jget '.error')"
fi
pass "deployment succeeded ($(wc -l <"$WORK/deploy.log" | tr -d ' ') log lines)"

CID="$(vps docker ps -q --filter "label=docksy.app=$APP_ID" --filter status=running | head -n 1)"
[ -n "$CID" ] || fail "no running container labelled docksy.app=$APP_ID on the VPS"
vps docker exec "$CID" wget -qO- http://127.0.0.1:3000/health >/dev/null || fail "the app container does not answer /health"
pass "container $(vps docker inspect -f '{{.Name}}' "$CID" | tr -d /) is running and healthy"
[ "$(api GET "/apps/$APP_ID" | jget '.status')" = running ] || warn "app status is not 'running' yet"

# Routing through Caddy is a bonus check (TLS for *.localhost uses Caddy's internal CA).
routed=0
for _ in $(seq 1 20); do
  if vps curl -fsSk --max-time 3 --resolve "$APP_DOMAIN:443:127.0.0.1" "https://$APP_DOMAIN/health" >/dev/null 2>&1; then routed=1; break; fi
  sleep 1
done
if [ "$routed" = 1 ]; then pass "routed through docksy-proxy: https://$APP_DOMAIN/health"
else warn "https://$APP_DOMAIN/health is not routed through the proxy (yet); check the caddy labels"; fi

# ── 7. metrics ──────────────────────────────────────────────────────────────
step "Waiting for metrics (up to 60s)"
points=0 deadline=$(( $(date +%s) + 60 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  points="$(API_ALLOW_FAIL=1 api GET "/servers/$SERVER_ID/metrics?range=15m" | jget '.points.length' || true)"
  [ "${points:-0}" -gt 0 ] 2>/dev/null && break
  sleep 3
done
[ "${points:-0}" -gt 0 ] 2>/dev/null || fail "no metrics arrived within 60s (agent log: docker exec $VPS journalctl -u docksy-agent)"
pass "$points metric point(s); latest: $(api GET "/servers/$SERVER_ID/metrics?range=15m" | jget '.points.at(-1)' | head -c 200)"
liveness="$(api GET "/servers/$SERVER_ID" | jget '.liveness')"
if [ "$liveness" = online ]; then pass "server liveness: online"; else warn "server liveness: ${liveness:-?}"; fi
seen=0
for _ in $(seq 1 10); do
  if api GET "/servers/$SERVER_ID/containers" | jget '.items' | grep -q "$APP_ID"; then seen=1; break; fi
  sleep 2
done
if [ "$seen" = 1 ]; then pass "the app container shows up in /servers/:id/containers"; else warn "app container not in /servers/:id/containers yet"; fi

OK=1
