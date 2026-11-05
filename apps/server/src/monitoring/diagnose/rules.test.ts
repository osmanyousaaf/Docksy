import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { ContainerInfo, MetricPoint, Server, App, UptimeCheck, Alert } from '@docksy/shared';
import type { DiagnoseContext, InspectInfo, AppBrief } from './types.ts';
import * as R from './rules.ts';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();

const server = (o: Partial<Server> = {}): Server => ({
  id: 's1', name: 'prod-1', host: '203.0.113.7', port: 22, sshUser: 'root', status: 'ready', liveness: 'online',
  lastSeenAt: isoAgo(5000), agentVersion: '0.1.0', os: 'ubuntu 24.04', arch: 'amd64', cpuCores: 4, memTotal: 8 * GiB,
  diskTotal: 100 * GiB, createdAt: isoAgo(30 * 86_400_000), updatedAt: isoAgo(1000), ...o,
});

const point = (o: Partial<MetricPoint> = {}): MetricPoint => ({
  ts: isoAgo(5000), cpu: 12, load1: 0.4, load5: 0.4, load15: 0.4, memUsed: 3 * GiB, memTotal: 8 * GiB, swapUsed: 0,
  diskUsed: 30 * GiB, diskTotal: 100 * GiB, netRx: 1000, netTx: 1000, ...o,
});

const container = (o: Partial<ContainerInfo> = {}): ContainerInfo => ({
  id: 'c0ffee000001', name: 'dx-api-aaaaaaaa', image: 'docksy/api:aaaaaaaa', state: 'running', status: 'Up 3 hours',
  restartCount: 0, startedAt: isoAgo(3 * 3_600_000), cpuPercent: 5, memUsed: 200 * MiB, memLimit: 0, netRx: 0, netTx: 0,
  labels: { 'docksy.managed': 'true', 'docksy.app': 'a1' }, serverId: 's1', appId: 'a1', updatedAt: isoAgo(5000), ...o,
});

const inspect = (o: Partial<InspectInfo> = {}): InspectInfo => ({
  id: 'c0ffee000001', name: 'dx-api-aaaaaaaa', status: 'running', oomKilled: false, exitCode: 0, restartCount: 0,
  startedAt: isoAgo(3 * 3_600_000), finishedAt: null, error: null, health: null, healthFailingStreak: 0, healthLastOutput: null,
  memLimit: 0, labels: { 'docksy.app': 'a1' }, ...o,
});

const brief = (o: Partial<AppBrief> = {}): AppBrief => ({
  id: 'a1', name: 'api', status: 'running', kind: 'app', currentDeploymentId: 'dep-good-2', lastDeploy: null, lastDeployLogTail: [], rollbackTarget: null, ...o,
});

const appObj = (o: Partial<App> = {}): App => ({
  id: 'a1', name: 'api', serverId: 's1', kind: 'app', template: null, sourceType: 'git', repoUrl: 'https://github.com/x/api', branch: 'main',
  hasGitToken: false, image: null, buildType: 'auto', dockerfilePath: 'Dockerfile', buildContext: '.', composePath: 'docker-compose.yml',
  port: 3000, domains: ['api.example.com'], healthcheckPath: null, volumes: [], status: 'running', autoDeploy: true,
  description: null, startCommand: null, watchPaths: [], cpuLimit: null, memLimitMb: null, suggestedDomain: null,
  webhookUrl: 'http://x/api/v1/webhooks/github/a1', currentDeploymentId: 'dep-good-2', createdAt: isoAgo(1e9), updatedAt: isoAgo(1e6), ...o,
});

function ctx(o: Partial<DiagnoseContext> = {}): DiagnoseContext {
  const latest = o.latest === undefined ? point() : o.latest;
  return {
    now: NOW, label: 'prod-1', server: server(), app: null, apps: [brief()], latest,
    points1h: latest ? [latest] : [], trend1h: latest ? R.computeTrend([latest]) : null,
    containers: [container(), container({ id: 'beef00000002', name: 'docksy-proxy', appId: null, labels: {}, cpuPercent: 1, memUsed: 40 * MiB })],
    inspect: [inspect(), inspect({ id: 'beef00000002', name: 'docksy-proxy', labels: {} })], dockerDf: null,
    sshAttempted: true, sshError: null, firingAlerts: [], recentDeployments: [], recentLogs: [], logsContainer: null, uptime: [], tls: null,
    ...o,
  };
}

const only = (ctxv: DiagnoseContext, rule: R.Rule) => rule(ctxv);
const noFindingsFromAllRules = (c: DiagnoseContext) => R.runRules(c);

describe('healthy report', () => {
  test('a calm server has no findings and a friendly summary', () => {
    const c = ctx();
    const f = noFindingsFromAllRules(c);
    assert.deepEqual(f, []);
    assert.ok(R.isHealthy(f));
    const s = R.summarize('prod-1', f, c);
    assert.equal(s, 'prod-1 looks healthy: CPU 12.0%, memory 37.5%, disk 30.0%, 2/2 containers running.');
  });
});

describe('server rules', () => {
  test('high memory names the top containers and suggests restart_app', () => {
    const c = ctx({
      latest: point({ memUsed: 7.8 * GiB, swapUsed: 300 * MiB }),
      containers: [
        container({ memUsed: 5 * GiB, memLimit: 8 * GiB }),
        container({ id: 'aa0000000003', name: 'dx-worker-bbbbbbbb', appId: 'a2', labels: { 'docksy.app': 'a2' }, memUsed: 1.5 * GiB }),
        container({ id: 'beef00000002', name: 'docksy-proxy', appId: null, labels: {}, memUsed: 60 * MiB }),
      ],
      apps: [brief(), brief({ id: 'a2', name: 'worker' })],
    });
    const [f, ...rest] = only(c, R.memoryRule);
    assert.equal(rest.length, 0);
    assert.equal(f!.severity, 'critical');
    assert.equal(f!.title, 'Memory is 97.5% used on prod-1');
    assert.ok(f!.evidence.includes('Memory 7.8 GiB of 8.0 GiB used (97.5%)'));
    assert.ok(f!.evidence.includes('dx-api-aaaaaaaa (app api): 5.0 GiB'));
    assert.ok(f!.evidence.includes('dx-worker-bbbbbbbb (app worker): 1.5 GiB'));
    assert.ok(f!.evidence.includes('Swap used 300 MiB'));
    assert.deepEqual(f!.action, { tool: 'restart_app', args: { appId: 'a1' } });
    assert.match(f!.suggestion, /App api uses the most memory \(5\.0 GiB\)/);
  });

  test('high CPU with load and top container', () => {
    const c = ctx({ latest: point({ cpu: 97, load1: 6.2 }), containers: [container({ cpuPercent: 310 })] });
    const [f] = only(c, R.cpuRule);
    assert.equal(f!.severity, 'critical');
    assert.ok(f!.evidence.includes('Load average 6.20 on 4 cores'));
    assert.ok(f!.evidence.includes('dx-api-aaaaaaaa (app api): 310.0% CPU'));
    assert.equal(f!.action!.tool, 'get_app_logs');
    assert.deepEqual(only(ctx({ latest: point({ cpu: 50 }) }), R.cpuRule), []);
  });

  test('stale metrics do not produce CPU/memory findings', () => {
    const c = ctx({ latest: point({ ts: isoAgo(20 * 60_000), cpu: 99, memUsed: 7.9 * GiB }) });
    assert.deepEqual(only(c, R.cpuRule), []);
    assert.deepEqual(only(c, R.memoryRule), []);
  });

  test('disk nearly full: numbers, docker df, prune suggestions, growth', () => {
    const first = point({ ts: isoAgo(60 * 60_000), diskUsed: 90 * GiB });
    const latest = point({ diskUsed: 96 * GiB });
    const c = ctx({
      latest, points1h: [first, latest],
      dockerDf: [{ type: 'Images', totalCount: '41', size: '38.2GB', reclaimable: '29.1GB (76%)' }, { type: 'Build Cache', totalCount: '120', size: '12GB', reclaimable: '12GB' }],
    });
    const [f] = only(c, R.diskRule);
    assert.equal(f!.severity, 'critical');
    assert.equal(f!.title, 'Disk is 96.0% full on prod-1');
    assert.ok(f!.evidence.includes('Disk 96.0 GiB of 100 GiB used (96.0%), 4.0 GiB free'));
    assert.ok(f!.evidence.includes('Docker Images: 38.2GB (29.1GB (76%) reclaimable)'));
    assert.ok(f!.evidence.some((e) => /Growing about 6\.0 GiB\/h; full in roughly 0\.7 h/.test(e)));
    assert.match(f!.suggestion, /docker builder prune -af/);
    assert.equal(only(ctx({ latest: point({ diskUsed: 86 * GiB }) }), R.diskRule)[0]!.severity, 'warning');
    assert.deepEqual(only(ctx({ latest: point({ diskUsed: 50 * GiB }) }), R.diskRule), []);
  });

  test('swap thrashing', () => {
    const first = point({ ts: isoAgo(3_000_000), swapUsed: 100 * MiB, memUsed: 7 * GiB });
    const latest = point({ swapUsed: 900 * MiB, memUsed: 7 * GiB });
    const [f] = only(ctx({ latest, points1h: [first, latest] }), R.swapRule);
    assert.equal(f!.severity, 'warning');
    assert.ok(f!.evidence.includes('Swap used 900 MiB (was 100 MiB an hour ago)'));
    assert.deepEqual(only(ctx({ latest: point({ swapUsed: 900 * MiB, memUsed: 2 * GiB }) }), R.swapRule), [], 'swap with free RAM is fine');
  });

  test('offline agent: critical, with SSH context and provision_server action', () => {
    const c = ctx({ server: server({ liveness: 'offline', lastSeenAt: isoAgo(14 * 60_000) }), sshError: 'connect ETIMEDOUT 203.0.113.7:22' });
    const [f] = only(c, R.offlineRule);
    assert.equal(f!.severity, 'critical');
    assert.equal(f!.title, 'prod-1 is offline');
    assert.ok(f!.evidence[0]!.startsWith('Last agent report 14 min ago'));
    assert.ok(f!.evidence.includes('SSH also failed: connect ETIMEDOUT 203.0.113.7:22'));
    assert.match(f!.suggestion, /cloud provider/);
    assert.deepEqual(f!.action, { tool: 'provision_server', args: { serverId: 's1' } });

    const [g] = only(ctx({ server: server({ liveness: 'offline', lastSeenAt: isoAgo(5 * 60_000) }) }), R.offlineRule);
    assert.match(g!.suggestion, /systemctl restart docksy-agent/);

    const [h] = only(ctx({ server: server({ liveness: 'unknown', lastSeenAt: null, status: 'new' }) }), R.offlineRule);
    assert.equal(h!.severity, 'warning');
    assert.match(h!.suggestion, /Provision the server/);
    assert.deepEqual(only(ctx(), R.offlineRule), []);
  });

  test('offline server: the summary leads with it', () => {
    const c = ctx({ server: server({ liveness: 'offline', lastSeenAt: isoAgo(10 * 60_000) }), latest: point({ ts: isoAgo(10 * 60_000) }) });
    const f = R.runRules(c);
    assert.equal(f[0]!.title, 'prod-1 is offline');
    assert.ok(!R.isHealthy(f));
    assert.equal(R.summarize('prod-1', f, c), 'prod-1 has 1 critical; most urgent: prod-1 is offline. Suggested first step: provision_server.');
  });
});

describe('container rules', () => {
  test('OOM kill from docker inspect', () => {
    const c = ctx({
      containers: [container({ state: 'restarting', status: 'Restarting (137) 5 seconds ago', restartCount: 7, memUsed: 498 * MiB })],
      inspect: [inspect({ status: 'restarting', oomKilled: true, exitCode: 137, restartCount: 7, memLimit: 512 * MiB, finishedAt: isoAgo(120_000) })],
    });
    const [f, ...rest] = only(c, R.oomRule);
    assert.equal(rest.length, 0);
    assert.equal(f!.severity, 'critical');
    assert.equal(f!.title, 'App api was killed for running out of memory');
    assert.ok(f!.evidence.includes('docker inspect: State.OOMKilled=true, ExitCode=137 (SIGKILL, often out of memory)'));
    assert.ok(f!.evidence.includes('Memory limit: 512 MiB'));
    assert.ok(f!.evidence.includes('Using 498 MiB at the last agent report'));
    assert.deepEqual(f!.action, { tool: 'restart_app', args: { appId: 'a1' } });
    assert.deepEqual(only(c, R.crashLoopRule), [], 'OOM is not double-reported as a crash loop');
    assert.deepEqual(only(c, R.appDownRule), []);
  });

  test('crash loop after a recent deploy suggests rollback_app', () => {
    const good = { id: 'dep-good-1', appId: 'a1', status: 'succeeded' as const, trigger: 'manual' as const, commitSha: null, commitMessage: null, imageTag: 'docksy/api:dep-good', error: null, startedAt: isoAgo(2e7), finishedAt: isoAgo(2e7), createdAt: isoAgo(2e7) };
    const recent = { ...good, id: 'dep-new-22', commitSha: 'abcdef1234567', finishedAt: isoAgo(10 * 60_000) };
    const c = ctx({
      apps: [brief({ lastDeploy: recent, rollbackTarget: good, currentDeploymentId: 'dep-new-22' })],
      containers: [container({ state: 'restarting', status: 'Restarting (1) 3 seconds ago', restartCount: 12, startedAt: isoAgo(3000) })],
      inspect: [inspect({ status: 'restarting', exitCode: 1, restartCount: 12, startedAt: isoAgo(3000) })],
    });
    const [f] = only(c, R.crashLoopRule);
    assert.equal(f!.severity, 'critical');
    assert.equal(f!.title, 'App api is crash-looping (12 restarts)');
    assert.ok(f!.evidence.includes('RestartCount=12'));
    assert.ok(f!.evidence.includes('Last exit code 1 (application error)'));
    assert.ok(f!.evidence.includes('Deployed 10 min ago (deployment dep-new-, commit abcdef1)'));
    assert.deepEqual(f!.action, { tool: 'rollback_app', args: { appId: 'a1', deploymentId: 'dep-good-1' } });
  });

  test('crash loop without a recent deploy points at the logs; old restarts are ignored', () => {
    const c = ctx({ containers: [container({ restartCount: 5, startedAt: isoAgo(60_000) })], inspect: null });
    const [f] = only(c, R.crashLoopRule);
    assert.deepEqual(f!.action, { tool: 'get_app_logs', args: { appId: 'a1', tail: 200 } });
    assert.deepEqual(only(ctx({ containers: [container({ restartCount: 5, startedAt: isoAgo(5 * 86_400_000) })], inspect: null }), R.crashLoopRule), []);
  });

  test('app marked running but its container exited', () => {
    const c = ctx({ containers: [container({ state: 'exited', status: 'Exited (0) 2 hours ago' })], inspect: [inspect({ status: 'exited', exitCode: 0 })] });
    const [f] = only(c, R.appDownRule);
    assert.equal(f!.title, 'App api is not running');
    assert.deepEqual(f!.action, { tool: 'start_app', args: { appId: 'a1' } });
    const [g] = only(ctx({ containers: [] }), R.appDownRule);
    assert.deepEqual(g!.action, { tool: 'deploy_app', args: { appId: 'a1' } });
  });

  test('unhealthy docker healthcheck', () => {
    const c = ctx({ inspect: [inspect({ health: 'unhealthy', healthFailingStreak: 6, healthLastOutput: 'curl: (7) Failed to connect' })] });
    const [f] = only(c, R.healthcheckRule);
    assert.equal(f!.severity, 'warning');
    assert.ok(f!.evidence.includes('Health: unhealthy, FailingStreak=6'));
  });

  test('app scope ignores other apps\' containers', () => {
    const c = ctx({
      app: appObj(),
      apps: [brief(), brief({ id: 'a2', name: 'worker' })],
      containers: [container(), container({ id: 'aa0000000003', name: 'dx-worker-bbbbbbbb', appId: 'a2', labels: { 'docksy.app': 'a2' }, state: 'restarting', restartCount: 9 })],
      inspect: null,
    });
    assert.deepEqual(only(c, R.crashLoopRule), []);
  });
});

describe('deploys, logs, tls, uptime, alerts', () => {
  const failed = { id: 'dep-bad-0001', appId: 'a1', status: 'failed' as const, trigger: 'webhook' as const, commitSha: '1234567890abc', commitMessage: 'bump deps\n\nlong body', imageTag: null,
    error: 'Build failed: exit code 1', startedAt: isoAgo(600_000), finishedAt: isoAgo(540_000), createdAt: isoAgo(600_000) };

  test('failed deploy with previous version still serving: warning + build log tail', () => {
    const c = ctx({ apps: [brief({ lastDeploy: failed, lastDeployLogTail: ['npm ERR! code ERESOLVE', 'npm ERR! could not resolve dependency'] })] });
    const [f] = only(c, R.failedDeployRule);
    assert.equal(f!.severity, 'warning');
    assert.equal(f!.title, 'The last deploy of api failed');
    assert.equal(f!.evidence[0], 'Deployment dep-bad- (webhook, commit 1234567 "bump deps") failed 9 min ago');
    assert.ok(f!.evidence.includes('Error: Build failed: exit code 1'));
    assert.ok(f!.evidence.includes('log: npm ERR! code ERESOLVE'));
    assert.match(f!.suggestion, /docker build/);
    assert.deepEqual(f!.action, { tool: 'get_deployment_logs', args: { deploymentId: 'dep-bad-0001' } });
  });

  test('failed deploy with nothing running: critical + rollback', () => {
    const good = { ...failed, id: 'dep-good-1', status: 'succeeded' as const, imageTag: 'docksy/api:x', error: null };
    const c = ctx({ apps: [brief({ status: 'failed', currentDeploymentId: null, lastDeploy: failed, rollbackTarget: good })] });
    const [f] = only(c, R.failedDeployRule);
    assert.equal(f!.severity, 'critical');
    assert.deepEqual(f!.action, { tool: 'rollback_app', args: { appId: 'a1', deploymentId: 'dep-good-1' } });
  });

  test('deployHint classifies common failures', () => {
    assert.match(R.deployHint('fatal: Authentication failed for https://github.com/x/y', []), /GitHub token/);
    assert.match(R.deployHint(null, ['write /var/lib/docker: no space left on device']), /disk/);
    assert.match(R.deployHint('Health check timed out after 120s', []), /healthy within 120s/);
    assert.match(R.deployHint('weird', []), /full build log/);
  });

  test('log errors in app scope', () => {
    const logs = [
      ...Array.from({ length: 90 }, (_, i) => `2026-11-01T11:59:${String(i % 60).padStart(2, '0')}.000Z GET /health 200`),
      '2026-11-01T11:59:58.000Z Error: connect ECONNREFUSED 10.0.0.5:5432',
      '2026-11-01T11:59:59.000Z Error: connect ECONNREFUSED 10.0.0.5:5432',
      '2026-11-01T12:00:00.000Z FATAL: unhandled exception in worker',
    ];
    const c = ctx({ app: appObj(), recentLogs: logs, logsContainer: 'dx-api-aaaaaaaa' });
    const [f] = only(c, R.logErrorsRule);
    assert.equal(f!.severity, 'warning', 'fatal escalates');
    assert.equal(f!.title, '3 error lines in the last 93 log lines of api');
    assert.ok(f!.evidence[0]!.startsWith('3 of 93 lines match'));
    assert.equal(f!.evidence.length, 3, 'duplicate lines are collapsed');
    assert.deepEqual(f!.action, { tool: 'get_app_logs', args: { appId: 'a1', tail: 200 } });
    assert.deepEqual(only(ctx({ app: appObj(), recentLogs: ['all good'] }), R.logErrorsRule), []);
    assert.deepEqual(only(ctx({ recentLogs: logs }), R.logErrorsRule), [], 'server scope has no app logs');
  });

  test('TLS: expired, expiring, untrusted, DNS missing, unreachable', () => {
    const base = { host: 'api.example.com', reachable: true, ok: true, validTo: isoAgo(-60 * 86_400_000), daysLeft: 60, issuer: "Let's Encrypt", error: null, errorCode: null };
    assert.deepEqual(only(ctx({ tls: base }), R.tlsRule), []);
    assert.equal(only(ctx({ tls: { ...base, daysLeft: 5 } }), R.tlsRule)[0]!.title, 'TLS certificate for api.example.com expires in 5 days');
    const exp = only(ctx({ tls: { ...base, ok: false, daysLeft: -2, error: 'CERT_HAS_EXPIRED' } }), R.tlsRule)[0]!;
    assert.equal(exp.severity, 'critical');
    assert.match(exp.title, /has expired/);
    assert.equal(only(ctx({ tls: { ...base, ok: false, error: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }), R.tlsRule)[0]!.title, 'TLS certificate for api.example.com is not trusted');
    const dns = only(ctx({ tls: { ...base, reachable: false, ok: false, errorCode: 'ENOTFOUND', error: 'getaddrinfo ENOTFOUND api.example.com' } }), R.tlsRule)[0]!;
    assert.match(dns.suggestion, /A record for api\.example\.com pointing at 203\.0\.113\.7/);
    const refused = only(ctx({ tls: { ...base, reachable: false, ok: false, errorCode: 'ECONNREFUSED', error: 'connect ECONNREFUSED' } }), R.tlsRule)[0]!;
    assert.equal(refused.action!.tool, 'provision_server');
  });

  test('uptime: down, flaky, slow', () => {
    const chk = (o: Partial<UptimeCheck>): UptimeCheck => ({ id: 'u1', name: 'api', url: 'https://api.example.com', appId: 'a1', intervalSec: 60, timeoutMs: 10000, expectedStatus: 0, public: true, enabled: true, lastStatus: 'up', uptime24h: 100, avgLatencyMs24h: 120, createdAt: isoAgo(1e8), ...o });
    const down = only(ctx({ uptime: [{ check: chk({ lastStatus: 'down', uptime24h: 97.5 }), lastError: 'HTTP 502', lastStatusCode: 502, consecutiveFails: 4 }] }), R.uptimeRule)[0]!;
    assert.equal(down.severity, 'critical');
    assert.deepEqual(down.evidence.slice(0, 2), ['Last result: HTTP 502', '4 failed checks in a row']);
    assert.deepEqual(down.action, { tool: 'restart_app', args: { appId: 'a1' } });
    assert.equal(only(ctx({ uptime: [{ check: chk({ uptime24h: 96.1 }), lastError: null, lastStatusCode: 200, consecutiveFails: 0 }] }), R.uptimeRule)[0]!.severity, 'warning');
    assert.equal(only(ctx({ uptime: [{ check: chk({ avgLatencyMs24h: 3400 }), lastError: null, lastStatusCode: 200, consecutiveFails: 0 }] }), R.uptimeRule)[0]!.severity, 'info');
  });

  test('firing alerts finding with ack_alert action', () => {
    const al: Alert = { id: 'al1', ruleId: 'r1', serverId: 's1', appId: null, state: 'firing', severity: 'warning', title: 'CPU > 90% on prod-1', message: '', value: 93, startedAt: isoAgo(600_000), resolvedAt: null, ackedAt: null };
    const [f] = only(ctx({ firingAlerts: [al] }), R.alertsRule);
    assert.equal(f!.severity, 'warning');
    assert.equal(f!.evidence[0], 'warning: CPU > 90% on prod-1 (since 10 min ago)');
    assert.deepEqual(f!.action, { tool: 'ack_alert', args: { alertId: 'al1' } });
    assert.equal(only(ctx({ firingAlerts: [{ ...al, ackedAt: isoAgo(1000) }] }), R.alertsRule)[0]!.severity, 'info');
  });

  test('ssh failure is an info note, report stays healthy', () => {
    const c = ctx({ inspect: null, sshError: 'All configured authentication methods failed' });
    const f = R.runRules(c);
    assert.equal(f.length, 1);
    assert.equal(f[0]!.severity, 'info');
    assert.ok(R.isHealthy(f));
    assert.match(R.summarize('prod-1', f, c), /looks healthy.*1 minor note below\.$/);
  });

  test('runRules isolates a throwing rule and sorts by severity', () => {
    const boom: R.Rule = () => { throw new Error('kaboom'); };
    const warn: R.Rule = () => [{ severity: 'warning', title: 'w', detail: '', evidence: [], suggestion: 's' }];
    const crit: R.Rule = () => [{ severity: 'critical', title: 'c', detail: '', evidence: [], suggestion: 's' }];
    const f = R.runRules(ctx(), [boom, warn, crit]);
    assert.deepEqual(f.map((x) => x.severity), ['critical', 'warning', 'info']);
  });
});
