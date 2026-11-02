import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { startSignaling } from '../src/signaling.js';
import { startHost } from '../src/host.js';
import { getIceServers } from '../src/ice.js';
import { loadEnvFile } from 'node:process';
const signal = await startSignaling(0);
const room = 'browser-test-room-123';
const cloudflare = process.env.TEST_CLOUDFLARE === '1' || process.argv.includes('--cloudflare');
if (cloudflare) loadEnvFile('.env');
const relay = cloudflare || process.env.TEST_RELAY === '1';
const ice = relay ? [{ urls: `turn:127.0.0.1:3479?transport=${process.env.TEST_TURN_TRANSPORT || 'udp'}`, username: 'blam', credential: 'local-test-password' }] : [];
const logs: string[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => { if (typeof args[0] === 'string' && args[0].startsWith('[blam] ')) logs.push(args[0].slice(7)); originalLog(...args); };
process.env.BLAM_DEBUG = '1';
const signalUrl = process.env.TEST_SIGNAL_URL || `ws://127.0.0.1:${signal.port}/signal`;
const host = await startHost(signalUrl, room, cloudflare ? getIceServers : ice, relay);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const url = `${process.env.TEST_CLIENT_URL || `http://127.0.0.1:${signal.port}/`}#room=${room}&signal=${encodeURIComponent(signalUrl)}`;
try {
  const a = await browser.newPage(), b = await browser.newPage();
  const errors: string[] = [];
  for (const page of [a, b]) {
    page.on('pageerror', e => { errors.push(e.message); console.error('Page error:', e.message); });
    await page.addInitScript(() => {
      const original = RTCPeerConnection.prototype.createDataChannel;
      (window as any).wire = { channels: {}, messages: [] };
      RTCPeerConnection.prototype.createDataChannel = function(label, options) {
        const ch = original.call(this, label, options);
        (window as any).wire.channels[label] = ch;
        ch.addEventListener('message', e => (window as any).wire.messages.push(JSON.parse(e.data)));
        return ch;
      };
    });
    console.log('Opening browser client');
    page.on('console', m => { if (m.type() === 'error') console.log('Browser:', m.text()); });
    if (cloudflare) page.on('websocket', ws => {
      ws.on('framereceived', frame => {
        const payload = String(frame.payload);
        assert.equal(payload.includes(process.env.CF_TURN_API_TOKEN!), false, 'API token never reaches the browser');
        assert.equal(payload.includes(process.env.CF_TURN_KEY_ID!), false, 'TURN key ID never reaches the browser');
      });
    });
    if (process.env.TEST_LATENCY) await page.addInitScript(() => {
      const create = RTCPeerConnection.prototype.createDataChannel;
      RTCPeerConnection.prototype.createDataChannel = function(label, options) {
        const channel = create.call(this, label, options), send = channel.send.bind(channel);
        channel.send = (data: any) => { setTimeout(() => { if (channel.readyState === 'open') send(data); }, 100); };
        Object.defineProperty(channel, 'onmessage', { set(callback) {
          channel.addEventListener('message', event => setTimeout(() => callback(event), 100));
        } });
        return channel;
      };
    });
    if (process.env.TRACE_CAPTURE) await page.addInitScript(`const timer = window.setTimeout; window.setTimeout = (fn, ms, ...args) => timer(fn, ms === 120 ? 12000 : ms, ...args);`);
    await page.goto(url);
    if (page === a && !relay) {
      await page.locator('#options').evaluate((el: HTMLDetailsElement) => { el.open = true; });
      await page.getByLabel('Force TURN relay').check();
      await page.getByRole('button', { name: 'Join Game' }).click();
      await page.locator('#status').filter({ hasText: /TURN/ }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Join Game' }).isVisible(), true, 'missing TURN keeps the form available');
      assert.match(await page.locator('#status').innerText(), /Uncheck/);
      await page.getByLabel('Force TURN relay').uncheck();
    }
    await page.getByRole('button', { name: 'Join Game' }).click();
    await page.getByRole('button', { name: 'Enter arena' }).waitFor({ timeout: 25000 }).catch(async e => { console.log(await page.locator('#status').textContent()); throw e; });
  }
  console.log('Both peers ready');
  assert.equal(await a.getByRole('heading', { name: 'Invite a friend' }).isVisible(), true);
  const invite = new URL(await a.locator('#invite').inputValue());
  assert.equal(new URLSearchParams(invite.hash.slice(1)).get('room'), room);
  assert.equal(new URLSearchParams(invite.hash.slice(1)).get('signal'), signalUrl);
  await a.getByText(/2 \/ 2 players/).waitFor();
  await a.evaluate("Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } }, configurable: true })");
  await a.getByRole('button', { name: 'Copy invite link' }).click();
  assert.match(await a.locator('#share-status').innerText(), /Copy the selected link/);
  await a.evaluate("Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copiedInvite = text; } }, configurable: true })");
  await a.getByRole('button', { name: 'Copy invite link' }).click();
  assert.equal(await a.evaluate('(window.copiedInvite)'), invite.href);
  await mkdir('artifacts', { recursive: true });
  await a.screenshot({ path: 'artifacts/invite-menu.png' });
  if (relay) for (const page of [a, b]) await page.waitForFunction(() => document.getElementById('connection')?.textContent?.includes('TURN RELAY'), null, { timeout: 10000 });
  assert.equal(host.game.players.size, 2);
  const third = await browser.newPage(); await third.goto(url);
  await third.getByRole('button', { name: 'Join Game' }).click();
  await third.getByText(/Room full \(2\/2\)|Room unavailable or full/).waitFor(); await third.close();
  const players = [...host.game.players.values()];
  const settings = await a.evaluate(() => {
    const c = (window as any).wire.channels;
    return { ordered: c.state.ordered, retries: c.state.maxRetransmits, reliable: c.events.maxRetransmits };
  });
  assert.deepEqual(settings, { ordered: false, retries: 0, reliable: null });
  // Network delivery can bunch normal movement inputs together after a short stall.
  await a.evaluate(() => {
    for (let i = 0; i < 24; i++) (window as any).wire.channels.state.send(JSON.stringify({ seq: 0, x: 0, z: 0, yaw: 0, pitch: 0, jump: false }));
  });
  await a.waitForTimeout(200);
  assert.equal(host.game.players.size, 2, 'normal input bursts do not disconnect players');
  await a.bringToFront();
  await a.getByRole('button', { name: 'Enter arena' }).click();
  await a.waitForFunction(() => document.pointerLockElement !== null, undefined, { timeout: 3000 });
  await a.evaluate(() => document.exitPointerLock());
  await a.getByRole('button', { name: 'Resume' }).waitFor();
  assert.equal(await a.getByRole('button', { name: 'Copy invite link' }).isVisible(), true);
  await a.getByRole('button', { name: 'Resume' }).click();
  await a.waitForFunction(() => document.pointerLockElement !== null, undefined, { timeout: 3000 });
  const before = players[0].z;
  await a.keyboard.down('w'); await a.waitForTimeout(400); await a.keyboard.up('w');
  assert.ok(players[0].z > before + 1, 'keyboard movement reaches the authoritative server');
  players[0].x = -8; players[0].z = -8; players[1].x = -8; players[1].z = 0;
  await a.waitForTimeout(300);
  await mkdir('artifacts', { recursive: true });
  await a.screenshot({ path: relay ? 'artifacts/relay-arena.png' : 'artifacts/direct-arena.png' });
  for (let i = 0; i < 5; i++) { await a.mouse.down(); await a.mouse.up(); await a.waitForTimeout(300); }
  if (process.env.TRACE_CAPTURE) {
    const shot = await a.screenshot({ path: 'artifacts/tracer.png' });
    const brightPixels = await a.evaluate(async data => {
      const image = new Image(); image.src = data; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(630, 350, 180, 150).data;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 220 && pixels[i + 1] < 110 && pixels[i + 2] < 130) count++;
      return count;
    }, 'data:image/png;base64,' + shot.toString('base64'));
    assert.ok(brightPixels > 80, `visible bright tracer pixels: ${brightPixels}`);
  }
  assert.equal(players[1].health, 0, 'five clicks kill the target');
  assert.equal(players[0].kills, 1);
  const kills = logs.map(line => JSON.parse(line)).filter(e => e.event === 'kill');
  assert.equal(kills.length, 1, 'one confirmed kill appears in the dev log');
  assert.equal(kills[0].shooter, players[0].id); assert.equal(kills[0].victim, players[1].id);
  await b.waitForFunction(() => (window as any).wire.messages.some((m: any) => m.type === 'shot' && m.killed));
  await a.waitForTimeout(2200);
  assert.equal(players[1].health, 100); assert.equal(players[1].life, 2);
  await mkdir('artifacts', { recursive: true });
  await a.screenshot({ path: 'artifacts/arena.png' });
  // Both player slots must be able to aim and damage through the same transport.
  players[0].x = 8; players[0].z = 0; players[1].x = 8; players[1].z = 8;
  await a.evaluate(() => document.exitPointerLock());
  await b.bringToFront();
  await b.getByRole('button', { name: 'Enter arena' }).click();
  await b.waitForFunction(() => document.pointerLockElement !== null);
  await b.waitForTimeout(500);
  for (let i = 0; i < 5; i++) { await b.mouse.down(); await b.mouse.up(); await b.waitForTimeout(320); }
  await b.waitForTimeout(300);
  assert.equal(players[0].health, 0, 'the second player can also kill the first player');
  assert.equal(players[1].kills, 1);
  assert.ok(logs.map(line => JSON.parse(line)).some(e => e.event === 'client-metrics'), 'browser diagnostics reach the host');
  // Closing the host browser must leave the separate simulation and second browser running.
  await a.close(); await b.waitForTimeout(400);
  assert.equal(host.game.players.size, 1);
  await host.close();
  await b.getByText(/Host stopped|Connection ended|Signaling disconnected/).first().waitFor({ timeout: 5000 });
  assert.deepEqual(errors, []);
  console.log('PASS: two browser peers, channel policies, keyboard movement, shooting, death, respawn, browser exit, server shutdown.');
} catch (e) { console.error(e); throw e; } finally { await browser.close(); await host.close(); await signal.close(); console.log = originalLog; console.log('Cleanup complete'); }

// ponytail: werift keeps a TURN refresh timer after close; exit after all cleanup until upstream cancels it.
process.exit(0);
