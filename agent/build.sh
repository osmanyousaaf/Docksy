#!/usr/bin/env bash
# Build, test and smoke-test docksy-agent. Uses a local Go toolchain if there is
# one, otherwise runs everything inside the golang:1.24 Docker image.
#
#   ./build.sh          cross-compile bin/docksy-agent-linux-{amd64,arm64}
#   ./build.sh test     go vet + go test
#   ./build.sh once     build, then run --once in a Linux container with the docker socket
#
# Env: VERSION (default "dev"), USE_DOCKER=1 to force Docker even if Go is installed.
set -euo pipefail

cd "$(dirname "$0")"
VERSION="${VERSION:-dev}"
GO_IMAGE="${GO_IMAGE:-golang:1.24}"
cmd="${1:-build}"

run_go() {
  if [[ "${USE_DOCKER:-0}" != "1" ]] && command -v go >/dev/null 2>&1; then
    "$@"
  else
    docker run --rm \
      -v "$PWD":/src -w /src \
      -v docksy-gomod:/go/pkg/mod \
      -v docksy-gocache:/root/.cache/go-build \
      -e VERSION="$VERSION" -e GOFLAGS=-buildvcs=false \
      "$GO_IMAGE" "$@"
  fi
}

build() {
  mkdir -p bin
  run_go sh -c '
    set -e
    for arch in amd64 arm64; do
      echo "building bin/docksy-agent-linux-$arch ($VERSION)"
      CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath \
        -ldflags "-s -w -X main.version=$VERSION" \
        -o bin/docksy-agent-linux-$arch ./cmd/docksy-agent
    done
  '
  ls -lh bin/
}

case "$cmd" in
  build) build ;;
  test)  run_go sh -c 'go vet ./... && go test ./...' ;;
  once)
    build
    arch="$(docker version --format '{{.Server.Arch}}' 2>/dev/null || echo amd64)"
    case "$arch" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; esac
    docker run --rm \
      -v "$PWD/bin":/opt/docksy:ro \
      -v /var/run/docker.sock:/var/run/docker.sock \
      "$GO_IMAGE" /opt/docksy/docksy-agent-linux-"$arch" --once
    ;;
  *) echo "usage: $0 [build|test|once]" >&2; exit 2 ;;
esac
