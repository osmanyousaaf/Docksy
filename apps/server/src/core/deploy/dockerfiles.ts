import type { Probe } from './commands.ts';

/**
 * Dockerfile autodetection for `buildType: 'auto'` and the built-in templates used
 * when a repo has no Dockerfile. Pure: input is the repo probe, output is text.
 */

export type ProjectKind = 'node' | 'node-static' | 'python' | 'go' | 'static';

export interface Detection {
  kind: ProjectKind;
  /** Port the generated image listens on (also exported as $PORT). */
  port: number;
  dockerfile: string;
  /** One line for the deploy log, e.g. "Node.js 22 (pnpm), start: pnpm start". */
  summary: string;
}

export type AutoPlan = { kind: 'dockerfile' } | Detection | null;

export const DEFAULT_PORTS: Record<ProjectKind, number> = { node: 3000, 'node-static': 80, python: 8000, go: 8080, static: 80 };

/** Written into the build context when it has no .dockerignore of its own. */
export const DEFAULT_DOCKERIGNORE = ['.git', 'node_modules', '**/node_modules', '__pycache__', '*.pyc', '.venv', 'venv', '.DS_Store', ''].join('\n');

export const GENERATED_DOCKERFILE = 'Dockerfile.docksy';

const has = (p: Probe, f: string) => p.files.includes(f) || p.files.includes(`${f}/`);

/** Decide how to build: an existing Dockerfile wins, otherwise detect a stack. */
export function planAutoBuild(probe: Probe, port: number | null): AutoPlan {
  if (probe.hasDockerfile) return { kind: 'dockerfile' };
  return detectProject(probe, port);
}

export function detectProject(probe: Probe, port: number | null): Detection | null {
  if (has(probe, 'package.json')) return detectNode(probe, port);
  if (has(probe, 'requirements.txt') || has(probe, 'pyproject.toml')) return detectPython(probe, port);
  if (has(probe, 'go.mod')) return detectGo(probe, port);
  if (has(probe, 'index.html')) return staticSite(port);
  return null;
}

// ───────────────────────────── node ─────────────────────────────

interface Pkg {
  main?: string;
  scripts?: Record<string, string>;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

type Pm = 'npm' | 'pnpm' | 'yarn' | 'bun';

function parsePkg(text: string | undefined): Pkg {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Pkg) : {};
  } catch {
    return {};
  }
}

/** Node major from engines.node (">=20", "20.x", "^18.17.0"), clamped to a sane range. */
export function nodeMajor(engines: string | undefined): number {
  const m = engines?.match(/(\d{2})/);
  const n = m ? Number(m[1]) : NaN;
  return n >= 18 && n <= 30 ? n : 22;
}

function packageManager(p: Probe): { pm: Pm; lock: string | null } {
  if (has(p, 'pnpm-lock.yaml')) return { pm: 'pnpm', lock: 'pnpm-lock.yaml' };
  if (has(p, 'yarn.lock')) return { pm: 'yarn', lock: 'yarn.lock' };
  if (has(p, 'bun.lock')) return { pm: 'bun', lock: 'bun.lock' };
  if (has(p, 'bun.lockb')) return { pm: 'bun', lock: 'bun.lockb' };
  if (has(p, 'package-lock.json')) return { pm: 'npm', lock: 'package-lock.json' };
  return { pm: 'npm', lock: null };
}

function installCmd(pm: Pm, lock: string | null): string {
  switch (pm) {
    case 'pnpm': return '(corepack enable 2>/dev/null || npm install -g pnpm) && pnpm install --frozen-lockfile';
    case 'yarn': return 'yarn install';
    case 'bun': return 'bun install';
    default: return lock ? 'npm ci' : 'npm install';
  }
}

const runScript = (pm: Pm, script: string) => (pm === 'npm' ? `npm run ${script}` : pm === 'yarn' ? `yarn ${script}` : `${pm} run ${script}`);
const startCmd = (pm: Pm) => (pm === 'npm' ? 'npm start' : pm === 'yarn' ? 'yarn start' : `${pm} run start`);

/** Static-site frameworks whose `build` output is served by Caddy, and their output dir. */
const STATIC_FRAMEWORKS: [dep: string, outDir: string][] = [['vite', 'dist'], ['astro', 'dist'], ['react-scripts', 'build'], ['@vue/cli-service', 'dist'], ['parcel', 'dist']];

const jsonArgs = (cmd: string) => JSON.stringify(['sh', '-c', cmd]);

function detectNode(p: Probe, port: number | null): Detection {
  const pkg = parsePkg(p.contents['package.json']);
  const scripts = pkg.scripts ?? {};
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const { pm, lock } = packageManager(p);
  const major = nodeMajor(pkg.engines?.node);
  const base = pm === 'bun' ? 'oven/bun:1' : `node:${major}-slim`;
  const copyManifest = ['package.json', lock].filter(Boolean).join(' ');
  const install = installCmd(pm, lock);
  const build = scripts.build ? runScript(pm, 'build') : null;

  const entry = scripts.start ? null : pkg.main ?? ['server.js', 'index.js', 'app.js', 'main.js'].find((f) => has(p, f)) ?? null;
  const framework = STATIC_FRAMEWORKS.find(([dep]) => dep in deps);
  if (!scripts.start && !entry && build && framework) {
    const outDir = framework[1];
    const listen = port ?? DEFAULT_PORTS['node-static'];
    const dockerfile = [
      `FROM ${base} AS build`,
      'WORKDIR /app',
      `COPY ${copyManifest} ./`,
      `RUN ${install}`,
      'COPY . .',
      `RUN ${build}`,
      '',
      'FROM caddy:2-alpine',
      ...caddySpaLines(),
      `COPY --from=build /app/${outDir} /srv`,
      `ENV PORT=${listen}`,
      `EXPOSE ${listen}`,
      '',
    ].join('\n');
    return { kind: 'node-static', port: listen, dockerfile, summary: `Static site built with ${framework[0]} (${pm}), served by Caddy from ${outDir}/` };
  }

  const listen = port ?? DEFAULT_PORTS.node;
  const start = scripts.start ? startCmd(pm) : `${pm === 'bun' ? 'bun' : 'node'} ${entry ?? 'index.js'}`;
  const dockerfile = [
    `FROM ${base}`,
    'WORKDIR /app',
    `COPY ${copyManifest} ./`,
    `RUN ${install}`,
    'COPY . .',
    ...(build ? [`RUN ${build}`] : []),
    'ENV NODE_ENV=production',
    `ENV PORT=${listen}`,
    `EXPOSE ${listen}`,
    `CMD ${jsonArgs(start)}`,
    '',
  ].join('\n');
  const runtime = pm === 'bun' ? 'Bun' : `Node.js ${major}`;
  return { kind: 'node', port: listen, dockerfile, summary: `${runtime} (${pm}), start: ${start}` };
}

// ───────────────────────────── python ─────────────────────────────

function pyModule(p: Probe): string | null {
  return ['main', 'app', 'wsgi', 'server'].find((m) => has(p, `${m}.py`)) ?? null;
}

function detectPython(p: Probe, port: number | null): Detection {
  const listen = port ?? DEFAULT_PORTS.python;
  const reqs = `${p.contents['requirements.txt'] ?? ''}\n${p.contents['pyproject.toml'] ?? ''}`.toLowerCase();
  const dep = (name: string) => new RegExp(`(^|[^a-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_-]|$)`, 'm').test(reqs);
  const extra: string[] = [];
  let start: string;
  let how: string;

  const procWeb = (p.contents.Procfile ?? '').split('\n').map((l) => l.match(/^web:\s*(.+)$/)?.[1]?.trim()).find(Boolean);
  const mod = pyModule(p);
  if (procWeb) {
    start = procWeb;
    how = 'Procfile web process';
  } else if (has(p, 'manage.py') && dep('django')) {
    const wsgi = p.files.find((f) => /^[^/]+\/wsgi\.py$/.test(f));
    if (wsgi) {
      if (!dep('gunicorn')) extra.push('gunicorn');
      start = `gunicorn ${wsgi.split('/')[0]}.wsgi:application --bind 0.0.0.0:$PORT`;
      how = 'Django via gunicorn';
    } else {
      start = 'python manage.py runserver 0.0.0.0:$PORT';
      how = 'Django dev server';
    }
  } else if ((dep('fastapi') || dep('starlette')) && mod) {
    if (!dep('uvicorn')) extra.push('uvicorn');
    start = `uvicorn ${mod}:app --host 0.0.0.0 --port $PORT`;
    how = 'ASGI via uvicorn';
  } else if (dep('flask') && mod) {
    if (!dep('gunicorn')) extra.push('gunicorn');
    start = `gunicorn --bind 0.0.0.0:$PORT ${mod}:app`;
    how = 'Flask via gunicorn';
  } else {
    start = `python ${mod ?? 'main'}.py`;
    how = 'plain Python';
  }

  const install = has(p, 'requirements.txt')
    ? ['COPY requirements.txt ./', 'RUN pip install -r requirements.txt', 'COPY . .']
    : ['COPY . .', 'RUN pip install .'];
  const dockerfile = [
    'FROM python:3.12-slim',
    'ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1',
    'WORKDIR /app',
    ...install,
    ...(extra.length ? [`RUN pip install ${extra.join(' ')}`] : []),
    `ENV PORT=${listen}`,
    `EXPOSE ${listen}`,
    `CMD ${jsonArgs(start)}`,
    '',
  ].join('\n');
  return { kind: 'python', port: listen, dockerfile, summary: `Python 3.12 (${how}), start: ${start}` };
}

// ───────────────────────────── go ─────────────────────────────

/** "go 1.22.3" → "1.22"; anything older than 1.21 or unparsable → 1.24. */
export function goVersion(goMod: string | undefined): string {
  const m = goMod?.match(/^go\s+1\.(\d+)/m);
  const minor = m ? Number(m[1]) : NaN;
  return minor >= 21 && minor < 100 ? `1.${minor}` : '1.24';
}

function detectGo(p: Probe, port: number | null): Detection {
  const listen = port ?? DEFAULT_PORTS.go;
  const ver = goVersion(p.contents['go.mod']);
  const cmdDirs = p.files.filter((f) => /^cmd\/[^/]+\/$/.test(f)).map((f) => f.slice(0, -1));
  const pkg = has(p, 'main.go') || !cmdDirs.length ? '.' : `./${cmdDirs[0]}`;
  const dockerfile = [
    `FROM golang:${ver}-alpine AS build`,
    'WORKDIR /src',
    `COPY ${has(p, 'go.sum') ? 'go.mod go.sum' : 'go.mod'} ./`,
    'RUN go mod download',
    'COPY . .',
    `RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/app ${pkg}`,
    '',
    'FROM alpine:3.20',
    'RUN apk add --no-cache ca-certificates tzdata',
    'COPY --from=build /out/app /usr/local/bin/app',
    `ENV PORT=${listen}`,
    `EXPOSE ${listen}`,
    'CMD ["app"]',
    '',
  ].join('\n');
  return { kind: 'go', port: listen, dockerfile, summary: `Go ${ver}, building ${pkg}` };
}

// ───────────────────────────── static ─────────────────────────────

/** Caddyfile with SPA fallback, listening on $PORT (Caddy expands {$PORT} at runtime). */
function caddySpaLines(): string[] {
  return [`RUN printf '%s\\n' ':{$PORT}' 'root * /srv' 'encode gzip' 'try_files {path} /index.html' 'file_server' > /etc/caddy/Caddyfile`];
}

function staticSite(port: number | null): Detection {
  const listen = port ?? DEFAULT_PORTS.static;
  const dockerfile = [
    'FROM caddy:2-alpine',
    ...caddySpaLines(),
    'COPY . /srv',
    `ENV PORT=${listen}`,
    `EXPOSE ${listen}`,
    '',
  ].join('\n');
  return { kind: 'static', port: listen, dockerfile, summary: 'Static site served by Caddy' };
}
