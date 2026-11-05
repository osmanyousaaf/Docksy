# syntax=docker/dockerfile:1.7
# Docksy control plane image.
#   docker build -t docksy .
#   docker run -d -p 8080:8080 -v docksy-data:/data docksy
#
# Stages: agent (Go, cross-compiled for linux amd64+arm64) -> web (Vite build)
#         -> deps (server prod node_modules) -> runtime (node:24-slim, non-root).
ARG NODE_VERSION=24
ARG GO_VERSION=1.24

# ── 1. metrics agent ────────────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION} AS agent
ARG VERSION=0.0.0-dev
WORKDIR /src
COPY agent/ ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    set -eu; mkdir -p /out; \
    if [ -f go.mod ]; then \
      pkg=./cmd/docksy-agent; [ -d "$pkg" ] || pkg=.; \
      for arch in amd64 arm64; do \
        CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath \
          -ldflags "-s -w -X main.version=${VERSION}" -o /out/docksy-agent-linux-$arch "$pkg"; \
      done; \
    else \
      echo "agent/go.mod not found: building the image without agent binaries" >&2; \
    fi

# ── 2. web UI ───────────────────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-slim AS web
WORKDIR /app
COPY package.json package-lock.json tsconfig*.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace @docksy/web --include-workspace-root --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/web apps/web
# Types are checked in CI; the image only needs the bundle.
RUN rm -rf apps/web/dist && npm exec -w @docksy/web -- vite build

# ── 3. server production dependencies ───────────────────────────────────────
# Pure JS only (ssh2's optional native bindings are skipped), so this runs on the
# build platform and is copied into every target architecture.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --workspace @docksy/server --include-workspace-root=false \
      --ignore-scripts --no-audit --no-fund \
 && find node_modules -maxdepth 2 -type l -lname '../*' -delete

# ── 4. runtime ──────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-slim AS runtime
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="Docksy" \
      org.opencontainers.image.description="Deploy to your own servers. Monitoring on by default, Claude-native. Free forever." \
      org.opencontainers.image.source="https://github.com/osmanyousaaf/docksy" \
      org.opencontainers.image.url="https://github.com/osmanyousaaf/docksy" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"

ENV NODE_ENV=production \
    DOCKSY_DATA_DIR=/data \
    DOCKSY_VERSION=${VERSION} \
    PORT=8080 \
    HOST=0.0.0.0 \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

WORKDIR /app
COPY --chown=root:root package.json ./
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root apps/server/package.json apps/server/
COPY --chown=root:root apps/server/src apps/server/src
COPY --chown=root:root packages/shared packages/shared
COPY --from=web --chown=root:root /app/apps/web/dist apps/web/dist
COPY --chown=root:root deploy/scripts deploy/scripts
COPY --from=agent --chown=root:root /out/ agent/bin/

RUN find apps/server/src -name '*.test.ts' -delete \
 && find deploy/scripts -name '*.sh' -exec chmod 0755 {} + \
 && mkdir -p /data && chown node:node /data

USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/server/src/index.ts"]
