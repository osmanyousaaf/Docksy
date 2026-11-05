---
name: docksy-dockerize
description: Write a production-grade Dockerfile and .dockerignore for the user's repository (Node, Next.js, Python, Go, Rust, Ruby, PHP, static sites, monorepos), with multi-stage builds, small images, a non-root user, a healthcheck-friendly port and fast layer caching, so it builds and runs on Docksy. Use for "dockerize this", "write a Dockerfile", "containerize my app", "my Docker image is huge", or when a Docksy auto build fails.
when_to_use: Trigger phrases include "dockerize", "Dockerfile", "containerize", "docker image too big", "build fails on docksy", ".dockerignore". Called by docksy-deploy when a repo has no usable Dockerfile.
argument-hint: "[path]"
allowed-tools: Read Grep Glob Bash(docker build *) Bash(docker images *) Bash(docker run --rm *) Bash(docker info*)
---

# Dockerize a repo for Docksy

Goal: a Dockerfile that builds reproducibly, runs as non-root, listens on one clear port, and gives a small image. Docksy builds it on the user's server with `docker build -f <dockerfilePath> <context>`.

Target directory: `$ARGUMENTS` (defaults to the repo root).

## 1. Read before writing

Find out:
- the language and version: `.nvmrc`, `engines`, `.python-version`, `go.mod`'s `go` line, `rust-toolchain`
- the package manager and lockfile: `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `bun.lockb`, `poetry.lock` / `uv.lock`, `Gemfile.lock`
- the build and start commands: `scripts.build` / `scripts.start`, `Procfile`, `main.go`, `manage.py`, `uvicorn` usage
- the port: look for `PORT` env usage and defaults. Prefer reading `PORT` from env
- any monorepo layout: workspaces, turbo/nx. Note which package is the deployable one
- native dependencies (sharp, bcrypt, psycopg, Pillow), which need build tools in the build stage
- a health endpoint, or offer to add a trivial `/health`

If there's already a Dockerfile, improve it rather than replacing it wholesale, and explain each change.

## 2. Principles (apply all of them)

1. **Multi-stage:** deps → build → a slim runtime. Never ship compilers or dev dependencies.
2. **Pinned bases:** `node:22-slim`, `python:3.12-slim`, `golang:1.24` → `gcr.io/distroless/static-debian12` or `alpine:3.21`. No `latest`.
3. **Cache-friendly order:** copy lockfiles → install → copy the source → build.
4. **Deterministic installs:** `npm ci`, `pnpm install --frozen-lockfile`, `pip install --no-cache-dir -r requirements.txt`, `uv sync --frozen`, `go mod download`.
5. **Non-root:** `USER node`, or create an app user; `chown` only what needs to be written.
6. **One process, in the foreground, exec form:** `CMD ["node", "server.js"]`, not `npm start` (signals and graceful shutdown work properly).
7. **Config from env:** `ENV NODE_ENV=production`, plus `PORT` with a default, and `EXPOSE` that port. Bind to `0.0.0.0`, not `localhost`.
8. **No secrets in the image:** no `.env` and no tokens in `ARG`. Docksy injects env at runtime.
9. **Healthcheck-friendly:** Docksy checks `healthcheckPath` with wget/curl inside the container. Keep `wget` or `curl` in the runtime image if you set one, or note it.

## 3. Reference skeletons (adapt, don't paste blindly)

**Node (generic):**
```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build --chown=node:node /app ./
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

**Next.js:** set `output: "standalone"` in `next.config.*` (ask first), then copy `.next/standalone`, `.next/static` and `public` into the runtime image, with `CMD ["node", "server.js"]` and `HOSTNAME=0.0.0.0`.

**Python (FastAPI/Django):**
```dockerfile
FROM python:3.12-slim AS build
WORKDIR /app
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
COPY requirements.txt .
RUN pip install --prefix=/install -r requirements.txt

FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PORT=8000
COPY --from=build /install /usr/local
COPY . .
RUN useradd -r -u 10001 app && chown -R app /app
USER app
EXPOSE 8000
CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
```

**Go:**
```dockerfile
FROM golang:1.24 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/app ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/app /app
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/app"]
```

**Static site:** build stage → `caddy:2-alpine` serving `/srv` on port 80, or `nginx:alpine`.

## 4. Always write a `.dockerignore`

```
.git
node_modules
dist
build
.next
__pycache__
*.pyc
.venv
.env
.env.*
!.env.example
*.log
coverage
.DS_Store
Dockerfile*
docker-compose*.yml
```
Adjust it to the stack, and never ignore files the build needs.

## 5. Verify locally if Docker is available

`docker info` → if it works:
1. `docker build -t docksy-test .` (fix errors until it builds)
2. `docker images docksy-test` (report the size; flag anything above ~300 MB for Node/Python, or ~30 MB for Go)
3. `docker run --rm -e PORT=3000 -p 3000:3000 docksy-test`, then curl it, then stop it. Ask before running a long-lived container.

If Docker isn't available locally, say so. The first Docksy deploy is then the build test.

## 6. Hand off

Summarize the base image, the stages, the final size, the port and the start command. Then tell the user what to set in Docksy: `buildType: dockerfile`, `port`, and optionally `healthcheckPath`. Offer to commit the files, or to continue with **docksy-deploy**.
