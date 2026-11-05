# docksy-agent

The small Go program Docksy installs on every server it manages. Every few seconds it reads host metrics from `/proc` and container stats from the Docker socket, then POSTs one JSON report to your Docksy instance.

- One static binary (`CGO_ENABLED=0`), Go standard library only, no gopsutil.
- Runs unprivileged. The only extra access it needs is read access to `/var/run/docker.sock`.
- Aims to stay under 15 MB RSS and 1% CPU.
- It talks only to your own Docksy server. There is no telemetry.

## What it reports

The body is the `AgentReport` type from `packages/shared/src/index.ts`:

| Field | Source |
|---|---|
| `cpu.percent`, `cpu.perCore` | deltas between two `/proc/stat` samples |
| `cpu.load1/5/15` | `/proc/loadavg` |
| `mem` | `/proc/meminfo`; used = `MemTotal − MemAvailable` |
| `disks` | real filesystems from `/proc/mounts` (no tmpfs/overlay/squashfs/proc…), sized with `statfs` and deduplicated per device |
| `net` | bytes/s summed over interfaces except `lo`, `veth*`, `docker*`, `br-*` (`/proc/net/dev`) |
| `os`, `uptimeSec`, `hostname`, `arch` | `/etc/os-release`, `/proc/uptime`, the kernel, `GOARCH` |
| `containers` | Docker Engine API: `/containers/json?all=1`, inspect (`RestartCount`, `StartedAt`) and one-shot `/containers/{id}/stats?stream=false` for running containers, 8 in parallel with a 3s timeout each |

Container CPU is computed the way `docker stats` does it, so a container busy on two cores shows 200%. Container memory is usage minus `inactive_file` (page cache). Container network is bytes/s since the previous report.

If Docker is missing or the socket isn't readable, the agent still reports host metrics with `containers: []` and logs a warning every 10 minutes.

## Configuration

Docksy's `install-agent.sh` writes these to `/etc/docksy/agent.env` and runs the binary from the `docksy-agent.service` systemd unit.

| Env | Flag | Default | |
|---|---|---|---|
| `DOCKSY_URL` | `--url` | (required) | Docksy base URL, e.g. `https://docksy.example.com` |
| `DOCKSY_AGENT_TOKEN` | `--token` | (required) | this server's agent token (`dsa_…`). Use the env var: flags are visible in `ps`. |
| `DOCKSY_AGENT_INTERVAL` | `--interval` | `10` | seconds between reports |
| `DOCKER_HOST` | | `unix:///var/run/docker.sock` | only `unix://` is supported |

Other flags:

- `--once` prints one report as indented JSON to stdout and exits. It doesn't need a URL or token, so it's the quickest way to see what the agent sees.
- `--version` prints the version, which is set at build time with `-ldflags "-X main.version=1.2.3"`.

## Protocol

`POST ${DOCKSY_URL}/api/agent/v1/report` with `Authorization: Bearer ${DOCKSY_AGENT_TOKEN}` and the JSON report.

- The server replies `{"ok": true, "intervalSec": N}`, and the agent switches to that interval (clamped to 1s–1h).
- On failure it waits the interval, then doubles the wait on each further failure, up to 60s. It keeps retrying forever.
- Reports are never queued. Each attempt sends a fresh report, so after an outage only the latest state is delivered.
- A 401/403 is logged as "server rejected the agent token". Re-provisioning the server from the Docksy UI issues a new one.

## Building

Go doesn't have to be installed: `build.sh` uses the `golang:1.24` Docker image when there is no local `go`.

```bash
./build.sh          # bin/docksy-agent-linux-amd64 and bin/docksy-agent-linux-arm64
./build.sh test     # go vet ./... && go test ./...
./build.sh once     # build, then run --once in a Linux container with the docker socket mounted
VERSION=1.2.3 ./build.sh
```

Binaries are built with `CGO_ENABLED=0 -trimpath -ldflags "-s -w -X main.version=$VERSION"`. The Docksy server serves them from `agent/bin/` at `/api/agent/v1/binary/linux-<arch>`.

The equivalent raw Docker command for the tests is:

```bash
docker run --rm -v "$PWD":/src -v docksy-gomod:/go/pkg/mod -w /src golang:1.24 go test ./...
```

## Layout

```
cmd/docksy-agent/   flags, env, wiring
internal/collect/   /proc parsers + Collector (keeps the previous sample for rates)
internal/docker/    unix-socket Engine API client, docker-style CPU% and memory math
internal/report/    the AgentReport wire types (JSON shape pinned by a test)
internal/push/      POST with bearer token, backoff, server-driven interval
*/testdata/         fixture files for the parser tests
```

## Troubleshooting

```bash
systemctl status docksy-agent
journalctl -u docksy-agent -f
docksy-agent --once | head -40
```

If containers are missing, make sure the service user can read the socket. It must be in the `docker` group, or run the agent as root.
