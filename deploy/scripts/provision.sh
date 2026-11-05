#!/usr/bin/env bash
# Docksy server provisioning. Run by the Docksy control plane over SSH (`bash -s`),
# or by hand: `curl -fsSL <docksy>/... | sudo bash`. Safe to run any number of times.
#
# What it does:
#   1. checks the OS and that we can act as root
#   2. installs Docker (get.docker.com) if it is missing, and makes sure it runs
#   3. creates the `docksy` Docker network
#   4. starts or updates the `docksy-proxy` container (Caddy, automatic TLS)
#   5. creates /var/lib/docksy/{builds,backups,volumes} and /etc/docksy
#   6. opens 80/443 in ufw/firewalld when one of them is active
#
# Progress lines look like `::step:: <text>` so the UI can show them.
#
# Environment (all optional):
#   DOCKSY_PROXY_IMAGE      proxy image (default: pinned caddy-docker-proxy below)
#   DOCKSY_OPEN_FIREWALL    1 (default) opens 80/443 if ufw/firewalld is active; 0 skips
#   DOCKSY_SKIP_DOCKER_INSTALL  1 fails instead of installing Docker when it is missing
set -euo pipefail

DOCKSY_PROXY_IMAGE="${DOCKSY_PROXY_IMAGE:-lucaslorentz/caddy-docker-proxy:2.13.1-alpine}"
DOCKSY_OPEN_FIREWALL="${DOCKSY_OPEN_FIREWALL:-1}"
DOCKSY_SKIP_DOCKER_INSTALL="${DOCKSY_SKIP_DOCKER_INSTALL:-0}"
NETWORK=docksy
PROXY_NAME=docksy-proxy
PROXY_VOLUME=docksy-caddy-data
# Bump when the proxy's run flags change, so existing proxies get recreated.
PROXY_SPEC=1

export DEBIAN_FRONTEND=noninteractive
export LC_ALL=C

step() { printf '::step:: %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '::warn:: %s\n' "$*" >&2; }
DIED=0
die()  { DIED=1; printf '::error:: %s\n' "$*" >&2; exit 1; }
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "$DIED" = 0 ]; then printf '::error:: provisioning failed (exit %s)\n' "$rc" >&2; fi
}
trap on_exit EXIT

# ── privileges ──────────────────────────────────────────────────────────────
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    SUDO=1
  else
    die "This needs root. Connect as root, or give $(id -un) passwordless sudo."
  fi
fi
as_root() { if [ -n "$SUDO" ]; then sudo -n "$@"; else "$@"; fi; }
docker_() { as_root docker "$@"; }
has() { command -v "$1" >/dev/null 2>&1; }
has_systemd() { [ -d /run/systemd/system ] && has systemctl; }

# ── OS ──────────────────────────────────────────────────────────────────────
step "Checking the operating system"
[ "$(uname -s)" = "Linux" ] || die "Docksy servers must run Linux (found $(uname -s))."
OS_ID=unknown OS_LIKE="" OS_NAME="Linux"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-unknown}" OS_LIKE="${ID_LIKE:-}" OS_NAME="${PRETTY_NAME:-$OS_ID}"
fi
case " $OS_ID $OS_LIKE " in
  *" debian "*|*" ubuntu "*|*" raspbian "*) FAMILY=debian ;;
  *" rhel "*|*" fedora "*|*" centos "*|*" rocky "*|*" almalinux "*|*" amzn "*) FAMILY=rhel ;;
  *) FAMILY=other ;;
esac
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64|aarch64|arm64) ;;
  *) die "Unsupported CPU architecture: $ARCH (Docksy supports amd64 and arm64)." ;;
esac
info "$OS_NAME ($ARCH), family: $FAMILY"
[ "$FAMILY" = other ] && warn "Untested OS. Debian and Ubuntu are supported; continuing on a best-effort basis."

pkg_install() {
  case "$FAMILY" in
    debian)
      as_root apt-get update -qq >/dev/null || as_root apt-get update -qq
      as_root apt-get install -y -qq --no-install-recommends "$@" >/dev/null ;;
    rhel)
      if has dnf; then as_root dnf install -y -q "$@" >/dev/null; else as_root yum install -y -q "$@" >/dev/null; fi ;;
    *) return 1 ;;
  esac
}

# ── base tools ──────────────────────────────────────────────────────────────
missing=()
has curl || missing+=(curl)
[ -e /etc/ssl/certs/ca-certificates.crt ] || [ -e /etc/pki/tls/certs/ca-bundle.crt ] || missing+=(ca-certificates)
has git || missing+=(git)
if [ "${#missing[@]}" -gt 0 ]; then
  step "Installing base packages: ${missing[*]}"
  pkg_install "${missing[@]}" || die "Could not install ${missing[*]}. Install them and run this again."
fi

# ── Docker ──────────────────────────────────────────────────────────────────
docker_ready() { docker_ info >/dev/null 2>&1; }

start_docker() {
  if has_systemd; then
    as_root systemctl enable --now docker >/dev/null 2>&1 || as_root systemctl start docker || true
  elif has service; then
    as_root service docker start >/dev/null 2>&1 || true
  fi
  for _ in $(seq 1 30); do docker_ready && return 0; sleep 1; done
  return 1
}

INSTALLED_DOCKER=0
if has docker; then
  step "Docker is installed"
else
  [ "$DOCKSY_SKIP_DOCKER_INSTALL" = 1 ] && die "Docker is not installed (DOCKSY_SKIP_DOCKER_INSTALL=1)."
  step "Installing Docker (this takes a minute or two)"
  tmp="$(mktemp)"
  curl -fsSL --retry 3 --connect-timeout 15 https://get.docker.com -o "$tmp" || die "Could not download the Docker installer from get.docker.com."
  if ! as_root sh "$tmp" >/tmp/docksy-docker-install.log 2>&1; then
    if [ "$FAMILY" = rhel ] && has dnf; then
      # get.docker.com does not know every RHEL clone; the CentOS repo works for them.
      warn "get.docker.com failed; trying the CentOS docker-ce repository"
      as_root dnf -y -q install dnf-plugins-core >/dev/null 2>&1 || true
      as_root dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo >/dev/null 2>&1 || true
      as_root dnf -y -q install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null \
        || { rm -f "$tmp"; die "Docker install failed. See /tmp/docksy-docker-install.log"; }
    else
      tail -n 20 /tmp/docksy-docker-install.log >&2 || true
      rm -f "$tmp"
      die "Docker install failed. See /tmp/docksy-docker-install.log"
    fi
  fi
  rm -f "$tmp"
  INSTALLED_DOCKER=1
fi

# Rotate container logs so a chatty app cannot fill the disk. Only on a fresh
# Docker install (changing an existing daemon config would need a restart).
if [ "$INSTALLED_DOCKER" = 1 ] && ! as_root test -e /etc/docker/daemon.json; then
  as_root mkdir -p /etc/docker
  printf '{\n  "log-driver": "json-file",\n  "log-opts": { "max-size": "10m", "max-file": "3" }\n}\n' | as_root tee /etc/docker/daemon.json >/dev/null
  has_systemd && as_root systemctl restart docker >/dev/null 2>&1 || true
fi

step "Starting Docker"
docker_ready || start_docker || die "Docker is installed but not running. Try: systemctl status docker"
info "Docker $(docker_ version --format '{{.Server.Version}}' 2>/dev/null || echo '?')"

if ! docker_ compose version >/dev/null 2>&1; then
  step "Installing the Docker Compose plugin"
  pkg_install docker-compose-plugin || warn "Docker Compose plugin is missing; compose apps will not deploy until it is installed."
fi

# ── network ─────────────────────────────────────────────────────────────────
step "Creating the '$NETWORK' Docker network"
if docker_ network inspect "$NETWORK" >/dev/null 2>&1; then
  info "already exists"
else
  docker_ network create --driver bridge "$NETWORK" >/dev/null || docker_ network inspect "$NETWORK" >/dev/null 2>&1 \
    || die "Could not create the $NETWORK network."
fi

# ── directories ─────────────────────────────────────────────────────────────
step "Creating Docksy directories"
as_root mkdir -p /var/lib/docksy/builds /var/lib/docksy/backups /var/lib/docksy/volumes /etc/docksy
as_root chmod 0755 /var/lib/docksy
as_root chmod 0700 /var/lib/docksy/backups
as_root chmod 0755 /etc/docksy

# ── proxy ───────────────────────────────────────────────────────────────────
step "Starting the Docksy proxy ($DOCKSY_PROXY_IMAGE)"
want_proxy=1
if docker_ container inspect "$PROXY_NAME" >/dev/null 2>&1; then
  cur_image="$(docker_ container inspect -f '{{.Config.Image}}' "$PROXY_NAME")"
  cur_spec="$(docker_ container inspect -f '{{index .Config.Labels "docksy.proxy.spec"}}' "$PROXY_NAME" 2>/dev/null || true)"
  if [ "$cur_image" = "$DOCKSY_PROXY_IMAGE" ] && [ "$cur_spec" = "$PROXY_SPEC" ]; then
    want_proxy=0
    if [ "$(docker_ container inspect -f '{{.State.Running}}' "$PROXY_NAME")" != true ]; then
      info "proxy exists but is stopped; starting it"
      docker_ start "$PROXY_NAME" >/dev/null || die "Could not start $PROXY_NAME. Check: docker logs $PROXY_NAME"
    else
      info "already running and up to date"
    fi
  fi
fi

if [ "$want_proxy" = 1 ]; then
  docker_ pull -q "$DOCKSY_PROXY_IMAGE" >/dev/null || die "Could not pull $DOCKSY_PROXY_IMAGE. Is outbound internet access available?"
  if docker_ container inspect "$PROXY_NAME" >/dev/null 2>&1; then
    info "replacing the old proxy container"
    docker_ rm -f "$PROXY_NAME" >/dev/null
  fi
  # Something else on :80/:443 (nginx, apache, another proxy) would make Docker fail with a vague error.
  if has ss; then
    busy="$(as_root ss -Hltnp 2>/dev/null | awk '$4 ~ /:(80|443)$/ {print $4" "$6}' | head -n 3 || true)"
    if [ -n "$busy" ]; then
      die "Ports 80/443 are already in use by another program: $busy. Stop it (for example: systemctl disable --now nginx apache2) and run this again."
    fi
  fi
  docker_ run -d \
    --name "$PROXY_NAME" \
    --restart unless-stopped \
    --network "$NETWORK" \
    -p 80:80 -p 443:443 -p 443:443/udp \
    -e CADDY_INGRESS_NETWORKS="$NETWORK" \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    -v "$PROXY_VOLUME":/data \
    --label docksy.role=proxy \
    --label docksy.proxy.spec="$PROXY_SPEC" \
    --log-opt max-size=10m --log-opt max-file=3 \
    "$DOCKSY_PROXY_IMAGE" >/dev/null || die "Could not start the proxy. Check: docker logs $PROXY_NAME"
fi

for _ in $(seq 1 15); do
  [ "$(docker_ container inspect -f '{{.State.Running}}' "$PROXY_NAME" 2>/dev/null)" = true ] && break
  sleep 1
done
[ "$(docker_ container inspect -f '{{.State.Running}}' "$PROXY_NAME" 2>/dev/null)" = true ] \
  || die "The proxy did not stay up. Last logs: $(docker_ logs --tail 10 "$PROXY_NAME" 2>&1 | tr '\n' ' ')"

# ── firewall ────────────────────────────────────────────────────────────────
if [ "$DOCKSY_OPEN_FIREWALL" = 1 ]; then
  if has ufw && as_root ufw status 2>/dev/null | grep -q '^Status: active'; then
    step "Opening ports 80 and 443 in ufw"
    as_root ufw allow 80/tcp >/dev/null
    as_root ufw allow 443/tcp >/dev/null
    as_root ufw allow 443/udp >/dev/null
  elif has firewall-cmd && as_root firewall-cmd --state >/dev/null 2>&1; then
    step "Opening ports 80 and 443 in firewalld"
    as_root firewall-cmd --permanent --add-service=http >/dev/null
    as_root firewall-cmd --permanent --add-service=https >/dev/null
    as_root firewall-cmd --permanent --add-port=443/udp >/dev/null
    as_root firewall-cmd --reload >/dev/null
  fi
fi

step "Server is ready for Docksy"
info "docker: $(docker_ version --format '{{.Server.Version}}' 2>/dev/null), network: $NETWORK, proxy: $PROXY_NAME"
