#!/usr/bin/env node
/**
 * Screenshot Docksy pages with headless Chrome (no extra deps; uses the Chrome DevTools Protocol).
 *
 *   node scripts/shot.mjs <outDir> /path1 /path2 ...
 *
 * Env: DOCKSY_URL (http://localhost:8080), DOCKSY_EMAIL, DOCKSY_PASSWORD (logs in to get a session cookie),
 *      SHOT_WIDTH (1440), SHOT_HEIGHT (900), SHOT_FULL=1 for full-page, CHROME (path to chrome binary),
 *      SHOT_CLICK (CSS selector to click first), SHOT_KEY (key to press first, e.g. 'Meta+k').
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const [outDir, ...paths] = process.argv.slice(2);
if (!outDir || paths.length === 0) {
  console.error('usage: node scripts/shot.mjs <outDir> /path ...');
  process.exit(2);
}
const BASE = (process.env.DOCKSY_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const W = Number(process.env.SHOT_WIDTH ?? 1440);
const H = Number(process.env.SHOT_HEIGHT ?? 900);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
mkdirSync(outDir, { recursive: true });

async function login() {
  if (!process.env.DOCKSY_EMAIL) return null;
  const r = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.DOCKSY_EMAIL, password: process.env.DOCKSY_PASSWORD }),
  });
  if (!r.ok) throw new Error(`login failed: ${r.status} ${await r.text()}`);
  const m = /docksy_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');
  return m ? m[1] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const session = await login();
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), 'docksy-shot-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', `--window-size=${W},${H}`, 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl;
  for (let i = 0; i < 50 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error('chrome did not start');

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else listeners.forEach((l) => l(msg));
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

  await send('Page.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  if (session) {
    const u = new URL(BASE);
    await send('Network.setCookie', { name: 'docksy_session', value: session, domain: u.hostname, path: '/', httpOnly: true });
  }

  for (const p of paths) {
    const loaded = new Promise((res) => listeners.push((m) => { if (m.method === 'Page.loadEventFired') res(); }));
    await send('Page.navigate', { url: `${BASE}${p}` });
    await Promise.race([loaded, sleep(8000)]);
    await sleep(Number(process.env.SHOT_WAIT ?? 2500)); // let SPA fetch + render + SSE
    if (process.env.SHOT_CLICK) { // click a CSS selector before capturing (e.g. '[aria-label="Open menu"]')
      await send('Runtime.enable');
      await send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(process.env.SHOT_CLICK)})?.click()` });
      await sleep(600);
    }
    if (process.env.SHOT_KEY) { // press a key before capturing, e.g. 'Meta+k' or 'Escape'
      const parts = process.env.SHOT_KEY.split('+');
      const key = parts.pop();
      const modifiers = (parts.includes('Alt') ? 1 : 0) | (parts.includes('Control') ? 2 : 0) | (parts.includes('Meta') ? 4 : 0) | (parts.includes('Shift') ? 8 : 0);
      for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, modifiers, text: key.length === 1 ? key : undefined });
      await sleep(600);
    }
    let clip;
    if (process.env.SHOT_FULL === '1') {
      const m = await send('Page.getLayoutMetrics');
      const cs = m.result.cssContentSize ?? m.result.contentSize;
      clip = { x: 0, y: 0, width: W, height: Math.min(Math.ceil(cs.height), 6000), scale: 1 };
    }
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!clip, ...(clip ? { clip } : {}) });
    const name = (p.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root') + '.png';
    writeFileSync(join(outDir, name), Buffer.from(shot.result.data, 'base64'));
    console.log(join(outDir, name));
  }
  ws.close();
  chrome.kill();
}

main().catch((e) => { console.error(e); process.exit(1); });
