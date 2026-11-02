import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startSignaling } from '../src/signaling.js';
import { startHost } from '../src/host.js';
const signal = await startSignaling(0);
const room = 'disconnect-test-room';
const signalUrl = process.env.TEST_SIGNAL_URL || `ws://127.0.0.1:${signal.port}/signal`;
const host = await startHost(signalUrl, room);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const url = `${process.env.TEST_CLIENT_URL || `http://127.0.0.1:${signal.port}/`}#room=${room}&signal=${encodeURIComponent(signalUrl)}`;
try {
  const desktop = await browser.newPage(), phone = await browser.newPage();
  await phone.addInitScript(`
    const nativeFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => nativeFrame(time => window.pauseFrames ? window.requestAnimationFrame(callback) : callback(time));
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer { constructor(...args) { super(...args); window.testPeer = this; } };
    Object.defineProperty(document, 'exitPointerLock', { value: undefined, configurable: true });
    Object.defineProperty(Element.prototype, 'requestPointerLock', { value: undefined, configurable: true });
  `);
  const errors: string[] = [];
  phone.on('pageerror', e => errors.push(e.message));
  for (const page of [desktop, phone]) {
    await page.goto(url);
    await page.getByRole('button', { name: 'Join Game' }).click();
    await page.locator('#share').waitFor({ timeout: 25000 });
  }
  assert.equal(await phone.locator('#enter').isEnabled(), true);
  await phone.getByRole('button', { name: 'Enter arena', exact: true }).click();
  await phone.locator('#menu').waitFor({ state: 'hidden' });
  [...host.game.players.values()][1].health = 75;
  await phone.locator('#health').filter({ hasText: '75' }).waitFor({ timeout: 2000 });
  await phone.getByRole('button', { name: 'Menu', exact: true }).click();
  await phone.getByRole('button', { name: 'Quit', exact: true }).waitFor();
  assert.equal(host.game.players.size, 2, 'desktop and phone occupy two slots');
  await phone.evaluate('window.pauseFrames = true');
  await phone.waitForTimeout(11500);
  await phone.evaluate('window.pauseFrames = false');
  assert.equal(host.game.players.size, 2, 'a pause in rendering must not time out a healthy connection');
  await phone.evaluate(`Object.defineProperty(window.testPeer, 'connectionState', { value: 'failed' }); window.testPeer.dispatchEvent(new Event('connectionstatechange'));`);
  await phone.getByRole('button', { name: 'Reconnect', exact: true }).waitFor({ timeout: 2000 });
  assert.equal(await phone.locator('#share').isVisible(), false);
  await desktop.getByText(/1 \/ 2 players/).waitFor({ timeout: 2000 });
  assert.equal(host.game.players.size, 1, 'failed phone connection frees its slot');
  await phone.reload();
  await phone.getByRole('button', { name: 'Join Game' }).click();
  await phone.locator('#share').waitFor({ timeout: 25000 });
  await phone.evaluate(`Object.defineProperty(window.testPeer, 'iceConnectionState', { value: 'failed' }); window.testPeer.dispatchEvent(new Event('iceconnectionstatechange'));`);
  await desktop.getByText(/1 \/ 2 players/).waitFor({ timeout: 2000 });
  await phone.reload();
  await phone.getByRole('button', { name: 'Join Game' }).click();
  await phone.locator('#share').waitFor({ timeout: 25000 });
  await phone.getByRole('button', { name: 'Leave room', exact: true }).click();
  await desktop.getByText(/1 \/ 2 players/).waitFor({ timeout: 2000 });
  assert.equal(host.game.players.size, 1, 'leaving frees the slot');
  assert.deepEqual(errors, []);
  console.log('PASS: mobile entry and live updates work without pointer lock; failed and departed players free their slots.');
} finally { await browser.close(); await host.close(); await signal.close(); }
process.exit(0);
