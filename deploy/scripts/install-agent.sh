#!/usr/bin/env bash
# Install (or update) the Docksy metrics agent on this server. Safe to re-run.
# Run by the Docksy control plane over SSH (`bash -s`), or by hand:
#   curl -fsSL <docksy-url>/api/agent/v1/install.sh | sudo DOCKSY_URL=… DOCKSY_AGENT_TOKEN=… bash
#
# Required environment:
#   DOCKSY_URL            public URL of the Docksy control plane, e.g. https://docksy.example.com
#   DOCKSY_AGENT_TOKEN    this server's agent token (dsa_…)
# Optional:
#   DOCKSY_AGENT_INTERVAL report interval in seconds (default 10)
#
# Installs /usr/local/bin/docksy-agent, /etc/docksy/agent.env and the hardened
# systemd unit docksy-agent.service. Progress lines look like `::step:: <text>`.
set -euo pipefail

DOCKSY_URL="${DOCKSY_URL:-}"
DOCKSY_AGENT_TOKEN="${DOCKSY_AGENT_TOKEN:-}"
DOCKSY_AGENT_INTERVAL="${DOCKSY_AGENT_INTERVAL:-10}"
GITHUB_RELEASE="https://github.com/osmanyousaaf/docksy/releases/latest/download"
BIN=/usr/local/bin/docksy-agent
ENV_FILE=/etc/docksy/agent.env
UNIT=docksy-agent.service
UNIT_FILE=/etc/systemd/system/$UNIT
AGENT_USER=docksy-agent

step() { printf '::step:: %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '::warn:: %s\n' "$*" >&2; }
DIED=0
die()  { DIED=1; printf '::error:: %s\n' "$*" >&2; exit 1; }
TMP=""
cleanup() {
  rc=$?
  [ -n "$TMP" ] && rm -rf "$TMP"
  if [ "$rc" -ne 0 ] && [ "$DIED" = 0 ]; then printf '::error:: agent install failed (exit %s)\n' "$rc" >&2; fi
}
trap cleanup EXIT

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then SUDO=1
  else die "This needs root. Connect as root, or give $(id -un) passwordless sudo."; fi
fi
as_root() { if [ -n "$SUDO" ]; then sudo -n "$@"; else "$@"; fi; }
has() { command -v "$1" >/dev/null 2>&1; }
has_systemd() { [ -d /run/systemd/system ] && has systemctl; }

# ── inputs ──────────────────────────────────────────────────────────────────
step "Checking settings"
[ -n "$DOCKSY_URL" ] || die "DOCKSY_URL is not set (the URL this server uses to reach Docksy)."
[ -n "$DOCKSY_AGENT_TOKEN" ] || die "DOCKSY_AGENT_TOKEN is not set."
DOCKSY_URL="${DOCKSY_URL%/}"
# Characters allowed in the URL (it ends up in a systemd EnvironmentFile): no spaces, quotes or backslashes.
url_re='^https?://[]A-Za-z0-9._~:@%+/?#&=[-]+$'
[[ "$DOCKSY_URL" =~ $url_re ]] || die "DOCKSY_URL does not look like a URL: $DOCKSY_URL"
[[ "$DOCKSY_AGENT_TOKEN" =~ ^[A-Za-z0-9_.~+/=-]+$ ]] || die "DOCKSY_AGENT_TOKEN contains unexpected characters."
[[ "$DOCKSY_AGENT_INTERVAL" =~ ^[0-9]+$ ]] && [ "$DOCKSY_AGENT_INTERVAL" -ge 1 ] || die "DOCKSY_AGENT_INTERVAL must be a positive number of seconds."
has curl || die "curl is required. Run provision.sh first (or install curl)."

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "Unsupported CPU architecture: $(uname -m) (the agent ships for amd64 and arm64)." ;;
esac
info "control plane: $DOCKSY_URL, arch: $ARCH, interval: ${DOCKSY_AGENT_INTERVAL}s"

# ── binary ──────────────────────────────────────────────────────────────────
step "Downloading the agent (linux-$ARCH)"
TMP="$(mktemp -d)"
is_elf() { [ -s "$1" ] && [ "$(head -c 4 "$1" | od -An -c | tr -d ' ')" = '177ELF' ]; }
fetch() { curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 10 --max-time 180 "$1" -o "$2"; }

got=""
for url in "$DOCKSY_URL/api/agent/v1/binary/linux-$ARCH" "$GITHUB_RELEASE/docksy-agent-linux-$ARCH"; do
  if fetch "$url" "$TMP/docksy-agent" 2>"$TMP/err" && is_elf "$TMP/docksy-agent"; then
    got="$url"; break
  fi
  warn "could not get the agent from $url ($(tr '\n' ' ' <"$TMP/err" | cut -c1-160))"
done
[ -n "$got" ] || die "Could not download the agent binary from Docksy or GitHub. Check that this server can reach $DOCKSY_URL."
info "from $got"
chmod 0755 "$TMP/docksy-agent"

changed_bin=1
if [ -x "$BIN" ] && cmp -s "$TMP/docksy-agent" "$BIN"; then
  changed_bin=0
  info "binary is already up to date"
else
  as_root install -m 0755 -o root -g root "$TMP/docksy-agent" "$BIN.new"
  as_root mv -f "$BIN.new" "$BIN"
fi
ver=""
has timeout && ver="$(timeout 5 "$BIN" --version 2>/dev/null </dev/null | head -n 1 || true)"
[ -n "$ver" ] && info "version: $ver"

# ── user ────────────────────────────────────────────────────────────────────
step "Creating the $AGENT_USER system user"
if ! id "$AGENT_USER" >/dev/null 2>&1; then
  nologin="$(command -v nologin || echo /usr/sbin/nologin)"
  if has useradd; then
    as_root useradd --system --no-create-home --home-dir /nonexistent --shell "$nologin" --user-group "$AGENT_USER"
  elif has adduser; then
    as_root adduser -S -D -H -h /nonexistent -s "$nologin" "$AGENT_USER"
  else
    die "Neither useradd nor adduser is available to create the $AGENT_USER user."
  fi
fi
DOCKER_GROUP=""
if getent group docker >/dev/null 2>&1; then
  DOCKER_GROUP=docker
  # Read access to the Docker socket is the only privilege the agent has.
  id -nG "$AGENT_USER" | tr ' ' '\n' | grep -qx docker || as_root usermod -aG docker "$AGENT_USER" 2>/dev/null || true
else
  warn "No 'docker' group found: container metrics will be missing until Docker is installed."
fi

# ── config ──────────────────────────────────────────────────────────────────
step "Writing $ENV_FILE"
as_root mkdir -p /etc/docksy
as_root chmod 0755 /etc/docksy
{
  echo "# Written by Docksy install-agent.sh. Re-run the installer to change it."
  echo "DOCKSY_URL=$DOCKSY_URL"
  echo "DOCKSY_AGENT_TOKEN=$DOCKSY_AGENT_TOKEN"
  echo "DOCKSY_AGENT_INTERVAL=$DOCKSY_AGENT_INTERVAL"
} >"$TMP/agent.env"
changed_env=1
if as_root test -f "$ENV_FILE" && as_root cmp -s "$TMP/agent.env" "$ENV_FILE"; then
  changed_env=0
else
  as_root install -m 0640 -o root -g "$AGENT_USER" "$TMP/agent.env" "$ENV_FILE"
fi
# Make sure perms are right even if the file did not change.
as_root chown "root:$AGENT_USER" "$ENV_FILE"
as_root chmod 0640 "$ENV_FILE"

# ── service ─────────────────────────────────────────────────────────────────
if has_systemd; then
  step "Installing the $UNIT systemd service"
  supp=""
  [ -n "$DOCKER_GROUP" ] && supp="SupplementaryGroups=$DOCKER_GROUP"
  cat >"$TMP/unit" <<EOF
# Managed by Docksy (install-agent.sh). Local changes are overwritten on re-install;
# use \`systemctl edit $UNIT\` for overrides.
[Unit]
Description=Docksy metrics agent
Documentation=https://github.com/osmanyousaaf/docksy
After=network-online.target docker.service
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
ExecStart=$BIN
Restart=always
RestartSec=5
User=$AGENT_USER
Group=$AGENT_USER
$supp

# Hardening: the agent only reads /proc, statfs()s mounts and talks to the Docker socket.
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged
SystemCallErrorNumber=EPERM
UMask=0077

# Resource guard rails (the agent targets <15 MB RSS and <1% CPU).
MemoryMax=96M
TasksMax=64
CPUQuota=20%
Nice=5

[Install]
WantedBy=multi-user.target
EOF
  changed_unit=1
  if [ -f "$UNIT_FILE" ] && cmp -s "$TMP/unit" "$UNIT_FILE"; then changed_unit=0
  else as_root install -m 0644 -o root -g root "$TMP/unit" "$UNIT_FILE"; fi
  [ "$changed_unit" = 1 ] && as_root systemctl daemon-reload
  as_root systemctl enable "$UNIT" >/dev/null 2>&1

  step "Starting the agent"
  if [ "$changed_bin" = 1 ] || [ "$changed_env" = 1 ] || [ "$changed_unit" = 1 ] || ! systemctl is-active --quiet "$UNIT"; then
    as_root systemctl restart "$UNIT"
  else
    info "already running with this version and config"
  fi
  sleep 3
  if ! systemctl is-active --quiet "$UNIT"; then
    as_root journalctl -u "$UNIT" -n 20 --no-pager >&2 2>/dev/null || true
    die "The agent did not stay running. See: journalctl -u $UNIT"
  fi
else
  # No systemd (containers, some minimal images): run it in the background.
  # This does not survive a reboot; a systemd host is recommended.
  warn "systemd not found: starting the agent in the background (it will not restart on reboot)."
  { has setpriv && has setsid; } || die "systemd is not running and setpriv/setsid (util-linux) are missing, so the agent cannot be started."
  step "Starting the agent"
  as_root mkdir -p /var/log/docksy
  as_root touch /var/log/docksy/agent.log
  as_root chown "$AGENT_USER:$AGENT_USER" /var/log/docksy/agent.log
  as_root pkill -x docksy-agent 2>/dev/null || true
  sleep 1
  groups_arg="--groups=$AGENT_USER"
  [ -n "$DOCKER_GROUP" ] && groups_arg="--groups=$AGENT_USER,$DOCKER_GROUP"
  as_root env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin \
    DOCKSY_URL="$DOCKSY_URL" DOCKSY_AGENT_TOKEN="$DOCKSY_AGENT_TOKEN" DOCKSY_AGENT_INTERVAL="$DOCKSY_AGENT_INTERVAL" \
    setsid setpriv --reuid="$AGENT_USER" --regid="$AGENT_USER" "$groups_arg" --no-new-privs \
    "$BIN" >>/var/log/docksy/agent.log 2>&1 </dev/null &
  sleep 3
  pgrep -x docksy-agent >/dev/null || { tail -n 20 /var/log/docksy/agent.log >&2 || true; die "The agent did not stay running. See /var/log/docksy/agent.log"; }
fi

step "Agent installed: reporting to $DOCKSY_URL every ${DOCKSY_AGENT_INTERVAL}s"
