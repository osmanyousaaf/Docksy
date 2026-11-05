#!/bin/sh
# Copies SSH_AUTHORIZED_KEYS from PID 1's environment (docker run -e) into
# /root/.ssh/authorized_keys. systemd does not pass the container env to units.
set -eu
keys="$(tr '\0' '\n' </proc/1/environ | sed -n 's/^SSH_AUTHORIZED_KEYS=//p')"
mkdir -p /root/.ssh
chmod 700 /root/.ssh
touch /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
[ -n "$keys" ] || exit 0
printf '%s\n' "$keys" | while IFS= read -r k; do
  [ -n "$k" ] || continue
  grep -qxF "$k" /root/.ssh/authorized_keys || printf '%s\n' "$k" >>/root/.ssh/authorized_keys
done
