#!/usr/bin/env bash
# Docksy one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/osmanyousaaf/docksy/main/install.sh | sudo bash
#   curl -fsSL …/install.sh | sudo bash -s -- --port 9000 --version 0.2.0
#
# Options:
#   --version <v>    image tag to run (default: latest, or the one already installed)
#   --port <n>       port for the web UI and API (default: 8080)
#   --host <ip>      address of this server, used for its URL (default: auto-detected)
#   --no-localhost   do not authorize Docksy's SSH key for root on this host
#   --uninstall      stop and remove Docksy (keeps your data unless --purge)
#   --purge          with --uninstall: also delete all Docksy data, the agent and the SSH key
#   -y, --yes        do not ask for confirmation
#   -h, --help
#
# Safe to run again: it keeps your secret and settings, and upgrades the image.
# Environment overrides: DOCKSY_DIR (/opt/docksy), DOCKSY_IMAGE (ghcr.io/osmanyousaaf/docksy).
set -euo pipefail

DOCKSY_DIR="${DOCKSY_DIR:-/opt/docksy}"
DOCKSY_IMAGE="${DOCKSY_IMAGE:-}"
VOLUME=docksy-data
CONTAINER=docksy

opt_version="" opt_port="" opt_host="" opt_localhost=1 opt_uninstall=0 opt_purge=0 opt_yes=0

if [ -t 1 ]; then B=$'\033[1m' D=$'\033[2m' G=$'\033[32m' Y=$'\033[33m' R=$'\033[31m' C=$'\033[36m' N=$'\033[0m'
else B="" D="" G="" Y="" R="" C="" N=""; fi
step() { printf '%s==>%s %s%s%s\n' "$C" "$N" "$B" "$*" "$N"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '    %s!%s %s\n' "$Y" "$N" "$*" >&2; }
DIED=0
die()  { DIED=1; printf '%serror:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "$DIED" = 0 ]; then printf '%serror:%s the installer stopped unexpectedly (exit %s)\n' "$R" "$N" "$rc" >&2; fi
}
trap on_exit EXIT

usage() {
  cat <<'EOF'
Docksy installer

  curl -fsSL https://raw.githubusercontent.com/osmanyousaaf/docksy/main/install.sh | sudo bash -s -- [options]

  --version <v>    image tag to run (default: latest, or the one already installed)
  --port <n>       port for the web UI and API (default: 8080)
  --host <ip>      address of this server, used for its URL (default: auto-detected)
  --no-localhost   do not authorize Docksy's SSH key for root on this host
  --uninstall      stop and remove Docksy (keeps your data unless --purge)
  --purge          with --uninstall: also delete all data, the agent and the SSH key
  -y, --yes        do not ask for confirmation
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs a value, e.g. --version 0.1.0"; opt_version="${2#v}"; shift 2 ;;
    --version=*) opt_version="${1#*=}"; opt_version="${opt_version#v}"; shift ;;
    --port) [ $# -ge 2 ] || die "--port needs a value"; opt_port="$2"; shift 2 ;;
    --port=*) opt_port="${1#*=}"; shift ;;
    --host) [ $# -ge 2 ] || die "--host needs a value"; opt_host="$2"; shift 2 ;;
    --host=*) opt_host="${1#*=}"; shift ;;
    --no-localhost) opt_localhost=0; shift ;;
    --uninstall) opt_uninstall=1; shift ;;
    --purge) opt_purge=1; shift ;;
    -y|--yes) opt_yes=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

if [ -n "$opt_port" ]; then
  [[ "$opt_port" =~ ^[0-9]+$ ]] && [ "$opt_port" -ge 1 ] && [ "$opt_port" -le 65535 ] || die "--port must be a number between 1 and 65535"
fi
if [ -n "$opt_version" ]; then
  [[ "$opt_version" =~ ^[A-Za-z0-9._-]+$ ]] || die "--version looks wrong: $opt_version"
fi
[ "$(id -u)" -eq 0 ] || die "Please run as root, e.g.: curl -fsSL …/install.sh | sudo bash"
[ "$(uname -s)" = Linux ] || die "Docksy installs on Linux servers (found $(uname -s))."

has() { command -v "$1" >/dev/null 2>&1; }
has_systemd() { [ -d /run/systemd/system ] && has systemctl; }

confirm() {
  [ "$opt_yes" = 1 ] && return 0
  local answer=""
  if [ -r /dev/tty ] && { exec 3</dev/tty; } 2>/dev/null; then
    printf '%s [y/N] ' "$1" >/dev/tty
    read -r answer <&3 || true
    exec 3<&-
  else
    die "$1 Re-run with --yes to confirm (no terminal to ask on)."
  fi
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]
}

compose() { docker compose --project-directory "$DOCKSY_DIR" -f "$DOCKSY_DIR/docker-compose.yml" "$@"; }

# Read KEY from the .env file (empty when missing).
env_get() { [ -f "$DOCKSY_DIR/.env" ] && sed -n "s/^$1=//p" "$DOCKSY_DIR/.env" | tail -n 1 || true; }
# Set KEY=VALUE in the .env file, replacing an existing line.
env_set() {
  local key="$1" val="$2" tmp
  tmp="$(mktemp "$DOCKSY_DIR/.env.XXXXXX")"
  if [ -f "$DOCKSY_DIR/.env" ]; then grep -v "^$key=" "$DOCKSY_DIR/.env" >"$tmp" || true; fi
  printf '%s=%s\n' "$key" "$val" >>"$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$DOCKSY_DIR/.env"
}

detect_ip() {
  local ip=""
  if has ip; then ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')"; fi
  [ -n "$ip" ] || ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "$ip" ] || ip=127.0.0.1
  printf '%s' "$ip"
}

# ── uninstall ───────────────────────────────────────────────────────────────
if [ "$opt_uninstall" = 1 ]; then
  if [ "$opt_purge" = 1 ]; then
    confirm "This deletes Docksy and ALL its data (servers, apps, metrics, keys). Apps already running keep running. Continue?" \
      || die "Cancelled. Nothing was changed."
  fi
  step "Stopping Docksy"
  if [ -f "$DOCKSY_DIR/docker-compose.yml" ] && has docker; then
    compose down --remove-orphans || warn "docker compose down failed"
  elif has docker; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  ok "control plane removed"
  if [ "$opt_purge" = 1 ]; then
    step "Deleting data"
    has docker && { docker volume rm "$VOLUME" >/dev/null 2>&1 || true; }
    if [ -f "$DOCKSY_DIR/localhost.pub" ] && [ -f /root/.ssh/authorized_keys ]; then
      key="$(cat "$DOCKSY_DIR/localhost.pub")"
      if [ -n "$key" ]; then
        grep -vxF "$key" /root/.ssh/authorized_keys >/root/.ssh/authorized_keys.docksy-tmp || true
        cat /root/.ssh/authorized_keys.docksy-tmp >/root/.ssh/authorized_keys && rm -f /root/.ssh/authorized_keys.docksy-tmp
        ok "removed Docksy's SSH key from /root/.ssh/authorized_keys"
      fi
    fi
    if has_systemd && [ -f /etc/systemd/system/docksy-agent.service ]; then
      systemctl disable --now docksy-agent.service >/dev/null 2>&1 || true
      rm -f /etc/systemd/system/docksy-agent.service
      systemctl daemon-reload || true
    fi
    rm -f /usr/local/bin/docksy-agent /etc/docksy/agent.env
    rm -rf "$DOCKSY_DIR"
    ok "data volume, $DOCKSY_DIR and the metrics agent removed"
    info "${D}Left in place: Docker, the docksy-proxy container and any deployed app containers.${N}"
    info "${D}Remove them with: docker rm -f docksy-proxy \$(docker ps -aq --filter label=docksy.managed=true)${N}"
  else
    info "Your data is kept in the Docker volume '$VOLUME' and $DOCKSY_DIR."
    info "Reinstall any time with the same command, or delete everything with: --uninstall --purge"
  fi
  exit 0
fi

# ── install ─────────────────────────────────────────────────────────────────
printf '\n%sDocksy%s %s· deploy to your own servers, watched by default%s\n\n' "$B" "$N" "$D" "$N"

FAMILY=other
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  case " ${ID:-} ${ID_LIKE:-} " in
    *" debian "*|*" ubuntu "*|*" raspbian "*) FAMILY=debian ;;
    *" rhel "*|*" fedora "*|*" centos "*|*" rocky "*|*" almalinux "*|*" amzn "*) FAMILY=rhel ;;
  esac
fi
pkg_install() {
  case "$FAMILY" in
    debian) DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@" >/dev/null ;;
    rhel) if has dnf; then dnf install -y -q "$@" >/dev/null; else yum install -y -q "$@" >/dev/null; fi ;;
    *) return 1 ;;
  esac
}

step "Checking prerequisites"
if ! has curl; then pkg_install curl ca-certificates || die "Please install curl and run this again."; fi
ok "${PRETTY_NAME:-Linux} ($(uname -m))"

if ! has docker; then
  step "Installing Docker"
  curl -fsSL --retry 3 https://get.docker.com | sh >/tmp/docksy-docker-install.log 2>&1 \
    || { tail -n 20 /tmp/docksy-docker-install.log >&2; die "Docker install failed (log: /tmp/docksy-docker-install.log)."; }
  ok "Docker installed"
fi
if ! docker info >/dev/null 2>&1; then
  if has_systemd; then systemctl enable --now docker >/dev/null 2>&1 || true; fi
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
  docker info >/dev/null 2>&1 || die "Docker is installed but not running. Try: systemctl status docker"
fi
if ! docker compose version >/dev/null 2>&1; then
  pkg_install docker-compose-plugin || die "The Docker Compose plugin is missing. Install docker-compose-plugin and run this again."
fi
ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null) with Compose $(docker compose version --short 2>/dev/null)"

step "Writing $DOCKSY_DIR"
mkdir -p "$DOCKSY_DIR"
chmod 0700 "$DOCKSY_DIR"

secret="$(env_get DOCKSY_SECRET)"
if [[ ! "$secret" =~ ^[0-9a-fA-F]{64}$ ]]; then
  secret="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  [ "${#secret}" -eq 64 ] || die "Could not generate a secret from /dev/urandom."
  env_set DOCKSY_SECRET "$secret"
  ok "generated DOCKSY_SECRET (keep $DOCKSY_DIR/.env safe: it encrypts your stored credentials)"
else
  ok "kept the existing DOCKSY_SECRET"
fi

version="${opt_version:-$(env_get DOCKSY_TAG)}"; version="${version:-latest}"
port="${opt_port:-$(env_get DOCKSY_PORT)}"; port="${port:-8080}"
host="${opt_host:-$(env_get DOCKSY_HOST)}"; host="${host:-$(detect_ip)}"
env_set DOCKSY_TAG "$version"
env_set DOCKSY_PORT "$port"
env_set DOCKSY_HOST "$host"
DOCKSY_IMAGE="${DOCKSY_IMAGE:-$(env_get DOCKSY_IMAGE)}"; DOCKSY_IMAGE="${DOCKSY_IMAGE:-ghcr.io/osmanyousaaf/docksy}"
env_set DOCKSY_IMAGE "$DOCKSY_IMAGE"

cat >"$DOCKSY_DIR/docker-compose.yml" <<'EOF'
# Written by the Docksy installer. Settings live in .env next to this file.
name: docksy
services:
  docksy:
    image: ${DOCKSY_IMAGE:-ghcr.io/osmanyousaaf/docksy}:${DOCKSY_TAG:-latest}
    container_name: docksy
    restart: unless-stopped
    init: true
    env_file: .env
    environment:
      DOCKSY_DATA_DIR: /data
      PORT: "8080"
    ports:
      - "${DOCKSY_PORT:-8080}:8080"
    volumes:
      - docksy-data:/data
    extra_hosts:
      - "host.docker.internal:host-gateway"
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    read_only: true
    tmpfs:
      - /tmp
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
volumes:
  docksy-data:
    name: docksy-data
EOF
chmod 0600 "$DOCKSY_DIR/docker-compose.yml"
ok "docker-compose.yml and .env (image $DOCKSY_IMAGE:$version, port $port)"

step "Starting Docksy"
if compose pull --quiet >/tmp/docksy-pull.log 2>&1; then
  ok "pulled $DOCKSY_IMAGE:$version"
else
  warn "could not pull $DOCKSY_IMAGE:$version; using a local image if there is one ($(tail -n 1 /tmp/docksy-pull.log))"
fi
compose up -d --remove-orphans --quiet-pull >/tmp/docksy-up.log 2>&1 \
  || { sed 's/^/    /' /tmp/docksy-up.log >&2; die "docker compose up failed. Logs: docker logs $CONTAINER"; }

healthy=0
for _ in $(seq 1 90); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$port/api/v1/health" >/dev/null 2>&1; then healthy=1; break; fi
  if [ "$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null)" = exited ]; then break; fi
  sleep 1
done
if [ "$healthy" != 1 ]; then
  docker logs --tail 30 "$CONTAINER" >&2 2>&1 || true
  die "Docksy did not become healthy on port $port. See the logs above (docker logs $CONTAINER)."
fi
ok "healthy: $(curl -fsS --max-time 2 "http://127.0.0.1:$port/api/v1/health" 2>/dev/null)"

url="http://$host:$port"

# Agents and webhooks need a reachable URL. Seed it once; it stays editable in Settings.
if docker exec -e "SEED_URL=$url" "$CONTAINER" node --no-warnings --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  const db = new DatabaseSync(process.env.DOCKSY_DATA_DIR + "/docksy.db");
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").run("publicUrl", JSON.stringify(process.env.SEED_URL));
  db.close();
' >/dev/null 2>&1; then
  ok "public URL: $url (change it in Settings once you add a domain)"
else
  warn "could not set the public URL; set it in Settings → Public URL"
fi

# ── this host as a server ───────────────────────────────────────────────────
if [ "$opt_localhost" = 1 ]; then
  step "Letting Docksy manage this server over SSH"
  pubkey="$(docker exec -w /app/apps/server "$CONTAINER" node --no-warnings --input-type=module -e '
    import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
    import ssh2 from "ssh2";
    const dir = process.env.DOCKSY_DATA_DIR + "/keys", priv = dir + "/id_ed25519", pub = priv + ".pub";
    if (!existsSync(priv)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const kp = ssh2.utils.generateKeyPairSync("ed25519", { comment: "docksy" });
      writeFileSync(priv, kp.private.endsWith("\n") ? kp.private : kp.private + "\n", { mode: 0o600 });
      writeFileSync(pub, kp.public.trim() + "\n", { mode: 0o644 });
    } else if (!existsSync(pub)) {
      const k = [].concat(ssh2.utils.parseKey(readFileSync(priv, "utf8")))[0];
      writeFileSync(pub, k.type + " " + k.getPublicSSH().toString("base64") + " docksy\n", { mode: 0o644 });
    }
    process.stdout.write(readFileSync(pub, "utf8").trim());
  ' 2>/dev/null || true)"
  if [[ "$pubkey" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+ ]]; then
    mkdir -p /root/.ssh && chmod 700 /root/.ssh
    touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
    if grep -qxF "$pubkey" /root/.ssh/authorized_keys; then
      ok "Docksy's key is already in /root/.ssh/authorized_keys"
    else
      printf '%s\n' "$pubkey" >>/root/.ssh/authorized_keys
      ok "added Docksy's key to /root/.ssh/authorized_keys"
    fi
    printf '%s\n' "$pubkey" >"$DOCKSY_DIR/localhost.pub"
    if has sshd && sshd -T 2>/dev/null | grep -qi '^permitrootlogin no$'; then
      warn "sshd has 'PermitRootLogin no'. Set it to 'prohibit-password', or add this server with a sudo user instead."
    fi
  else
    warn "could not read Docksy's SSH key; add this server from the UI (Servers → New) instead."
  fi
fi

# ── done ────────────────────────────────────────────────────────────────────
printf '\n%s%sDocksy is running.%s\n\n' "$G" "$B" "$N"
printf '  %sOpen%s        %s%s%s\n' "$B" "$N" "$C" "$url" "$N"
printf '  %s1.%s Create your owner account (the first visit asks for it).\n' "$B" "$N"
if [ "$opt_localhost" = 1 ]; then
  printf '  %s2.%s Servers → New server: name %slocalhost%s, host %s%s%s, user %sroot%s. The SSH key is already authorized.\n' \
    "$B" "$N" "$B" "$N" "$B" "$host" "$N" "$B" "$N"
else
  printf '  %s2.%s Servers → New server, and follow the steps.\n' "$B" "$N"
fi
printf '  %s3.%s Connect Claude Code: %s/plugin marketplace add osmanyousaaf/docksy%s\n\n' "$B" "$N" "$C" "$N"
printf '  %sUpgrade: run this installer again. Uninstall: --uninstall. Files: %s%s\n\n' "$D" "$DOCKSY_DIR" "$N"
