import { spawn } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { startLobby } from './lobby.js';
import { put } from '@vercel/blob';
import { getIceServers } from './ice.js';
import { flushTelemetry } from './telemetry.js';
process.env.BLAM_LOG_DIR ||= 'logs';

if (existsSync('.env')) loadEnvFile('.env');
if (existsSync('.env.vercel')) loadEnvFile('.env.vercel');
if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('Run vercel env pull .env.vercel --environment production before starting the public host.');
const servers = await getIceServers();
console.log('Starting a public session...');
console.log(`Diagnostics: ${process.env.BLAM_LOG_DIR} (1 GB rotating limit)`);
const key = randomBytes(32).toString('hex');
const relay = process.env.FORCE_RELAY !== '0' && servers.some(s => (Array.isArray(s.urls) ? s.urls : [s.urls]).some(u => /^turns?:/.test(u)));
const signal = await startLobby(key, getIceServers, relay);
const local = `http://127.0.0.1:${signal.port}`;
// ponytail: temporary tunnel for two-player sessions; use a named tunnel for a permanent signaling address.
const tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', local], { stdio: ['ignore', 'ignore', 'pipe'] });
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  tunnel.kill('SIGTERM');
  await signal.close();
  await flushTelemetry();
  process.exit(code);
}
for (const event of ['SIGINT', 'SIGTERM'] as const) process.on(event, () => { void stop(); });
try {
  const publicOrigin = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Tunnel startup timed out. Try npm run play again.')), 60000);
    let output = '';
    tunnel.stderr.on('data', data => {
      output = (output + data.toString()).slice(-8192);
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
    tunnel.once('error', () => { clearTimeout(timeout); reject(new Error('Install cloudflared first: brew install cloudflared')); });
    tunnel.once('exit', () => { clearTimeout(timeout); reject(new Error('Tunnel exited during startup.')); });
  });
  console.log(`Waiting for signaling at ${publicOrigin}`);
  tunnel.once('exit', () => { console.error('Tunnel stopped. Session ended.'); void stop(1); });
  // The assigned hostname can appear before the tunnel accepts requests.
  // Query the provider first so early NXDOMAIN replies do not poison the laptop/router DNS cache.
  const dns = new Resolver({ timeout: 1000, tries: 2 }); dns.setServers(['1.1.1.1', '1.0.0.1']);
  let ready = false, lastError = '';
  let step = 'DNS';
  for (let attempt = 0; attempt < 90 && !stopping; attempt++) {
    try { step = 'DNS'; await dns.resolve4(new URL(publicOrigin).hostname); step = 'HTTPS'; const response = await fetch(`${publicOrigin}/health`, { signal: AbortSignal.timeout(3000) }); ready = response.ok && await response.text() === 'ok'; } catch (error) { const detail = error as { code?: string; cause?: { code?: string } }; lastError = `${step}: ${detail.cause?.code || detail.code || 'connection pending'}`; if (attempt === 0) console.log(`Tunnel startup: ${lastError}`); }
    if (ready) break;
    await delay(1000);
  }
  if (!ready) throw new Error(`Public tunnel did not become ready (${lastError}). Try npm run play again.`);
  signal.publish(publicOrigin);
  await put('host.json', JSON.stringify({ origin: publicOrigin, key }), { access: 'private', addRandomSuffix: false, allowOverwrite: true });
  const client = process.env.CLIENT_URL || 'https://blam-seven.vercel.app/';
  console.log(`Game ready: ${client}\nSelect Start Game to create a room and invite a friend.\nKeep this terminal open. Ctrl+C ends all rooms.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Session startup failed.');
  await stop(1);
}
