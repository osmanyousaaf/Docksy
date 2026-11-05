---
name: docksy-setup-server
description: Add a new VPS or bare-metal server to Docksy and provision it (Docker, the docksy network, the Caddy proxy with automatic HTTPS, and the metrics agent), then confirm that live metrics arrive. Use when the user says "add a server", "connect my VPS", "set up a new box", "I bought a Hetzner/DigitalOcean/Linode server", or there are no servers yet.
when_to_use: Trigger phrases include "add server", "new server", "provision", "connect VPS", "set up hetzner", "install docksy agent". Use before docksy-deploy when list_servers is empty.
argument-hint: "[name] [host]"
allowed-tools: Read mcp__plugin_docksy_docksy__list_servers mcp__plugin_docksy_docksy__get_server mcp__plugin_docksy_docksy__get_server_metrics mcp__plugin_docksy_docksy__list_containers mcp__plugin_docksy_docksy__diagnose
---

# Set up a server with Docksy

End state: the server shows **ready** and **online** in Docksy, with CPU, memory, disk and network flowing in every ~10 seconds.

Arguments: `$ARGUMENTS` (optional name and host).

## 1. Gather what you need

Ask only for what's missing:
- **host**: an IP or hostname. A fresh Ubuntu 22.04/24.04 or Debian 12 box is ideal; 1 vCPU / 1 GB RAM is the minimum, 2 GB+ is better.
- **name**: short and memorable, e.g. `prod-1` or `hetzner-fsn`.
- **SSH user and port**: default `root` on port 22. A sudo user works too.

Check `list_servers` so you don't add the same host twice.

## 2. Authorize Docksy's SSH key

Docksy connects over SSH with its own ed25519 key. The user has to add that public key to the server once:

1. The key and a one-line command are in the Docksy UI at **Servers → Add server**, which shows the one-liner to paste on the VPS. It looks like:
   ```bash
   mkdir -p ~/.ssh && echo "ssh-ed25519 AAAA… docksy" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
   ```
2. Ask the user to run it on the server (from the provider's console or their own SSH session), and to say when it's done.
3. Many providers also let you paste the key when you create the server. Mention this for next time.

Never ask the user for their root password or private keys.

## 3. Add and provision

1. `create_server` with `name`, `host` and optionally `port`/`sshUser`.
2. `provision_server` with the new id. It's idempotent and takes 1–4 minutes:
   - installs Docker if it's missing
   - creates the `docksy` network
   - starts `docksy-proxy` (Caddy, ports 80/443, automatic TLS)
   - creates `/var/lib/docksy/…`
   - installs `docksy-agent` as a systemd service
3. Poll `get_server` every ~15s and narrate the status (`provisioning` → `ready`).

If it fails (`status: error`), read the provision log in `get_server` and map it to a fix:

| Symptom | Likely fix |
|---|---|
| SSH auth failed | the key isn't in `authorized_keys` for that user, or the user/port is wrong |
| Connection timed out | firewall/security group: allow inbound 22 from the Docksy host |
| `sudo: a password is required` | use root, or give the user passwordless sudo |
| Ports 80/443 in use | another web server (nginx/apache) is running. Ask before suggesting it be stopped |
| Agent can't reach Docksy | Settings → Public URL must be reachable from the server |

Fix it with the user, then run `provision_server` again (it's safe to re-run).

## 4. Confirm it's alive

1. `get_server`: `liveness` should be `online` and `lastSeenAt` recent.
2. `get_server_metrics` (range `15m`): you should see points with CPU/memory/disk.
3. `list_containers`: at least `docksy-proxy` should be running.

## 5. Report

```
🖥️  <name> (<host>) is ready
OS:      Ubuntu 24.04 · 2 vCPU · 3.8 GB RAM · 75 GB disk
Agent:   online, reporting every 10s
Proxy:   docksy-proxy running (80/443, automatic HTTPS)
Next:    deploy an app (docksy-deploy) · add a database (docksy-add-database)
```

Default alerts (CPU, memory, disk, offline, container down, deploy failed…) already cover the new server. Suggest adding a notification channel in **Alerts → Channels** if none exists.
