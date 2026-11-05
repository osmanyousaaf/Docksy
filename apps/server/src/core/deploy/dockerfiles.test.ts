import './testenv.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectProject, goVersion, nodeMajor, planAutoBuild } from './dockerfiles.ts';
import type { Probe } from './commands.ts';

const probe = (files: string[], contents: Record<string, string> = {}, hasDockerfile = false): Probe => ({ files, contents, hasDockerfile });

test('an existing Dockerfile always wins', () => {
  assert.deepEqual(planAutoBuild(probe(['Dockerfile', 'package.json'], {}, true), null), { kind: 'dockerfile' });
});

test('nothing recognisable → null', () => {
  assert.equal(planAutoBuild(probe(['README.md', 'src/']), null), null);
});

test('node + npm lockfile + start script', () => {
  const d = detectProject(probe(['package.json', 'package-lock.json'], {
    'package.json': JSON.stringify({ scripts: { build: 'tsc', start: 'node dist/index.js' }, engines: { node: '>=20' } }),
  }), null)!;
  assert.equal(d.kind, 'node');
  assert.equal(d.port, 3000);
  assert.match(d.dockerfile, /^FROM node:20-slim$/m);
  assert.match(d.dockerfile, /^COPY package\.json package-lock\.json \.\/$/m);
  assert.match(d.dockerfile, /^RUN npm ci$/m);
  assert.match(d.dockerfile, /^RUN npm run build$/m);
  assert.match(d.dockerfile, /^ENV PORT=3000$/m);
  assert.match(d.dockerfile, /^CMD \["sh","-c","npm start"\]$/m);
  // NODE_ENV=production must come after install/build so devDependencies are available to build
  assert.ok(d.dockerfile.indexOf('NODE_ENV=production') > d.dockerfile.indexOf('npm run build'));
});

test('node + pnpm, no start script → node main entry; honours configured port', () => {
  const d = detectProject(probe(['package.json', 'pnpm-lock.yaml', 'server.js'], { 'package.json': '{"main":"server.js"}' }), 8080)!;
  assert.equal(d.kind, 'node');
  assert.equal(d.port, 8080);
  assert.match(d.dockerfile, /pnpm install --frozen-lockfile/);
  assert.match(d.dockerfile, /^CMD \["sh","-c","node server\.js"\]$/m);
  assert.match(d.dockerfile, /^FROM node:22-slim$/m);
});

test('vite app without start → static build served by caddy', () => {
  const d = detectProject(probe(['package.json', 'yarn.lock', 'index.html'], {
    'package.json': JSON.stringify({ scripts: { build: 'vite build', dev: 'vite' }, devDependencies: { vite: '^6' } }),
  }), null)!;
  assert.equal(d.kind, 'node-static');
  assert.equal(d.port, 80);
  assert.match(d.dockerfile, /^RUN yarn build$/m);
  assert.match(d.dockerfile, /^FROM caddy:2-alpine$/m);
  assert.match(d.dockerfile, /COPY --from=build \/app\/dist \/srv/);
  assert.match(d.dockerfile, /try_files \{path\} \/index\.html/);
});

test('python: fastapi → uvicorn, flask → gunicorn, django wsgi, Procfile wins', () => {
  const fast = detectProject(probe(['requirements.txt', 'main.py'], { 'requirements.txt': 'fastapi==0.115\n' }), null)!;
  assert.equal(fast.kind, 'python');
  assert.equal(fast.port, 8000);
  assert.match(fast.dockerfile, /RUN pip install -r requirements\.txt/);
  assert.match(fast.dockerfile, /RUN pip install uvicorn/);
  assert.match(fast.dockerfile, /uvicorn main:app --host 0\.0\.0\.0 --port \$PORT/);

  const flask = detectProject(probe(['requirements.txt', 'app.py'], { 'requirements.txt': 'Flask\ngunicorn\n' }), null)!;
  assert.match(flask.dockerfile, /gunicorn --bind 0\.0\.0\.0:\$PORT app:app/);
  assert.doesNotMatch(flask.dockerfile, /RUN pip install gunicorn/);

  const dj = detectProject(probe(['requirements.txt', 'manage.py', 'mysite/', 'mysite/wsgi.py'], { 'requirements.txt': 'Django>=5\n' }), null)!;
  assert.match(dj.dockerfile, /gunicorn mysite\.wsgi:application --bind 0\.0\.0\.0:\$PORT/);

  const proc = detectProject(probe(['pyproject.toml', 'Procfile', 'main.py'], { 'pyproject.toml': '[project]\ndependencies=["fastapi"]', Procfile: 'web: hypercorn main:app -b 0.0.0.0:$PORT\n' }), null)!;
  assert.match(proc.dockerfile, /hypercorn main:app/);
  assert.match(proc.dockerfile, /^RUN pip install \.$/m);
});

test('go: version from go.mod, cmd/ subpackage when no root main.go', () => {
  const d = detectProject(probe(['go.mod', 'go.sum', 'cmd/', 'cmd/api/'], { 'go.mod': 'module x\n\ngo 1.23.4\n' }), null)!;
  assert.equal(d.kind, 'go');
  assert.equal(d.port, 8080);
  assert.match(d.dockerfile, /^FROM golang:1\.23-alpine AS build$/m);
  assert.match(d.dockerfile, /^COPY go\.mod go\.sum \.\/$/m);
  assert.match(d.dockerfile, /-o \/out\/app \.\/cmd\/api$/m);
  const root = detectProject(probe(['go.mod', 'main.go'], { 'go.mod': 'module x\n' }), null)!;
  assert.match(root.dockerfile, /-o \/out\/app \.$/m);
  assert.match(root.dockerfile, /^COPY go\.mod \.\/$/m);
});

test('static index.html → caddy', () => {
  const d = detectProject(probe(['index.html', 'style.css']), null)!;
  assert.equal(d.kind, 'static');
  assert.match(d.dockerfile, /^COPY \. \/srv$/m);
  assert.match(d.dockerfile, /':\{\$PORT\}'/);
});

test('version helpers', () => {
  assert.equal(nodeMajor('^18.17.0'), 18);
  assert.equal(nodeMajor('20.x'), 20);
  assert.equal(nodeMajor(undefined), 22);
  assert.equal(nodeMajor('>=8'), 22);
  assert.equal(goVersion('go 1.22'), '1.22');
  assert.equal(goVersion('go 1.16'), '1.24');
});
