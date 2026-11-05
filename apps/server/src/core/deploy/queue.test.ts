import './testenv.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, type Row } from '../../db/index.ts';
import { bus } from '../../lib/events.ts';
import { insertApp, insertServer, setupDb } from './fixtures.ts';
import { finishDeployment, getDeployment } from './model.ts';
import { cancelDeployment, enqueueDeployment, MAX_CONCURRENT, recoverStale, runningDeploymentIds, setRunner, startWorker, stopWorker } from './queue.ts';

const tick = () => new Promise((r) => setImmediate(r));

let serverId = '';
before(() => {
  setupDb();
  serverId = insertServer();
});
afterEach(() => {
  stopWorker();
  setRunner(null);
  db.exec("UPDATE deployments SET status = 'cancelled' WHERE status NOT IN ('succeeded','failed','cancelled')");
});

/** A runner whose deployments finish only when the test says so. */
function controlledRunner() {
  const started: string[] = [];
  const signals = new Map<string, AbortSignal>();
  const release = new Map<string, () => void>();
  setRunner(async (id, signal) => {
    started.push(id);
    signals.set(id, signal);
    db.prepare("UPDATE deployments SET status = 'building' WHERE id = ?").run(id);
    await new Promise<void>((resolve) => {
      release.set(id, resolve);
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    finishDeployment(id, signal.aborted ? 'cancelled' : 'succeeded', null);
  });
  return {
    started, signals,
    async done(id: string) { release.get(id)!(); await tick(); await tick(); },
  };
}

test('enqueueDeployment inserts a queued deployment (by id or name) and emits status', () => {
  const appId = insertApp({ name: 'q-basic', serverId, repoUrl: 'https://github.com/a/b' });
  const seen: string[] = [];
  const off = bus.on('deployment.status', (p) => seen.push(p.status));
  const d = enqueueDeployment('q-basic', 'webhook', { commitSha: 'abc1234', commitMessage: 'hi' });
  off();
  assert.equal(d.status, 'queued');
  assert.equal(d.appId, appId);
  assert.equal(d.trigger, 'webhook');
  assert.equal(d.commitSha, 'abc1234');
  assert.deepEqual(seen, ['queued']);
  assert.throws(() => enqueueDeployment('nope-missing', 'manual'), /App not found/);
});

test('one per app, max 3 overall, FIFO order', async () => {
  const r = controlledRunner();
  const apps = ['qa', 'qb', 'qc', 'qd'].map((n) => insertApp({ name: `${n}-app`, serverId, repoUrl: 'https://x/y' }));
  const a1 = enqueueDeployment(apps[0]!, 'manual').id;
  const a2 = enqueueDeployment(apps[0]!, 'manual').id;
  const b1 = enqueueDeployment(apps[1]!, 'manual').id;
  const c1 = enqueueDeployment(apps[2]!, 'manual').id;
  const d1 = enqueueDeployment(apps[3]!, 'manual').id;
  startWorker();
  await tick();
  assert.deepEqual(r.started, [a1, b1, c1]);
  assert.equal(runningDeploymentIds().length, MAX_CONCURRENT);

  await r.done(b1); // frees a slot; a2 is blocked by a1, so d1 goes next
  assert.deepEqual(r.started, [a1, b1, c1, d1]);

  await r.done(a1); // now a2 can run
  assert.deepEqual(r.started, [a1, b1, c1, d1, a2]);
  for (const id of [c1, d1, a2]) await r.done(id);
  assert.equal(runningDeploymentIds().length, 0);
  for (const id of [a1, a2, b1, c1, d1]) assert.equal(getDeployment(id).status, 'succeeded');
});

test('cancel a queued deployment: it never runs', async () => {
  const r = controlledRunner();
  const app = insertApp({ name: 'q-cancel', serverId, repoUrl: 'https://x/y' });
  const first = enqueueDeployment(app, 'manual').id;
  const second = enqueueDeployment(app, 'manual').id;
  startWorker();
  await tick();
  const finished: string[] = [];
  const off = bus.on('deployment.finished', (p) => finished.push(`${p.deploymentId}:${p.status}`));
  const c = cancelDeployment(second);
  assert.equal(c.status, 'cancelled');
  assert.deepEqual(finished, [`${second}:cancelled`]);
  await r.done(first);
  off();
  assert.deepEqual(r.started, [first]);
  assert.throws(() => cancelDeployment(second), /already cancelled/);
});

test('cancel a running deployment aborts its signal', async () => {
  const r = controlledRunner();
  const app = insertApp({ name: 'q-abort', serverId, repoUrl: 'https://x/y' });
  const id = enqueueDeployment(app, 'manual').id;
  startWorker();
  await tick();
  cancelDeployment(id);
  assert.equal(r.signals.get(id)!.aborted, true);
  await tick(); await tick();
  assert.equal(getDeployment(id).status, 'cancelled');
});

test('the worker does nothing until started; a crashing runner still finishes the deployment', async () => {
  setRunner(async () => { throw new Error('boom'); });
  const app = insertApp({ name: 'q-crash', serverId, repoUrl: 'https://x/y' });
  const id = enqueueDeployment(app, 'manual').id;
  await tick();
  assert.equal(getDeployment(id).status, 'queued');
  const orig = console.error;
  console.error = () => {};
  try {
    startWorker();
    await tick(); await tick(); await tick();
  } finally { console.error = orig; }
  const d = getDeployment(id);
  assert.equal(d.status, 'failed');
  assert.equal(d.error, 'Deployment ended unexpectedly');
});

test('recoverStale marks interrupted deployments failed and fixes app status', () => {
  const app = insertApp({ name: 'q-stale', serverId, repoUrl: 'https://x/y' });
  const id = enqueueDeployment(app, 'manual').id;
  db.prepare("UPDATE deployments SET status = 'building' WHERE id = ?").run(id);
  db.prepare("UPDATE apps SET status = 'deploying' WHERE id = ?").run(app);
  assert.ok(recoverStale() >= 1);
  assert.equal(getDeployment(id).status, 'failed');
  assert.equal((db.prepare('SELECT status FROM apps WHERE id = ?').get(app) as Row).status, 'failed');
});
