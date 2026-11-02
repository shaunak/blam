import { RTCPeerConnection, type RTCDataChannel, type RTCIceServer } from 'werift';
import { WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Game, DT } from './game.js';
import { getIceServers } from './ice.js';
import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { recordTelemetry, clientMetrics } from './telemetry.js';
import { createHash } from 'node:crypto';

export async function startHost(url: string, room: string, iceServers: RTCIceServer[] | (() => Promise<RTCIceServer[]>) = [], relay = false) {
  if (relay && Array.isArray(iceServers) && !iceServers.some(s => (Array.isArray(s.urls) ? s.urls : [s.urls]).some(u => /^turns?:/.test(u)))) {
    throw new Error('FORCE_RELAY requires a TURN server.');
  }
  const debug = process.env.BLAM_DEBUG === '1' || process.argv.includes('--dev');
  const session = createHash('sha256').update(room).digest('hex').slice(0, 12);
  const log = (event: string, details: object = {}) => {
    recordTelemetry({ event, session, tick: game.tick, ...details });
    if (debug) console.log(`[blam] ${JSON.stringify({ event, tick: game.tick, ...details })}`);
  };
  const game = new Game();
  const signal = new WebSocket(url);
  type Peer = { pc: RTCPeerConnection; state?: RTCDataChannel; events?: RTCDataChannel;
    chain: Promise<void>; created: number; last: number; count: number; windowAt: number; candidates: number; metricsAt: number };
  const peers = new Map<string, Peer>();
  const pending = new Set<string>();
  let stopped = false;
  let finish!: () => void;
  const closed = new Promise<void>(resolve => { finish = resolve; });
  const sendSignal = (m: unknown) => { if (signal.readyState === WebSocket.OPEN) signal.send(JSON.stringify(m)); };
  const drop = (id: string, reason = 'connection closed') => {
    pending.delete(id);
    const p = peers.get(id); if (!p) return;
    log('leave', { player: id, reason });
    peers.delete(id); game.remove(id); void p.pc.close(); sendSignal({ type: 'drop', peer: id });
  };
  const send = (id: string, channel: RTCDataChannel | undefined, data: unknown, reliable = false) => {
    if (channel?.readyState !== 'open') return;
    if (channel.bufferedAmount > 65536) { if (reliable) drop(id); return; }
    try { channel.send(JSON.stringify(data)); } catch { drop(id); }
  };
  signal.on('message', async raw => {
    let m: any; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'join') {
      if (peers.size + pending.size >= 2 || peers.has(m.peer) || pending.has(m.peer)) { sendSignal({ type: 'drop', peer: m.peer }); return; }
      pending.add(m.peer);
      let servers: RTCIceServer[];
      try {
        servers = typeof iceServers === 'function' ? await iceServers() : iceServers;
      } catch {
        if (pending.delete(m.peer) && !stopped) {
          log('turn-credentials-failed', { player: m.peer });
          sendSignal({ type: 'error', peer: m.peer, message: 'TURN credentials unavailable. The host must check its Cloudflare configuration.' });
          sendSignal({ type: 'drop', peer: m.peer });
        }
        return;
      }
      if (!pending.delete(m.peer) || stopped) return;
      if (relay && !servers.some(s => (Array.isArray(s.urls) ? s.urls : [s.urls]).some(u => /^turns?:/.test(u)))) {
        sendSignal({ type: 'drop', peer: m.peer }); return;
      }
      log('credentials-ready', { player: m.peer, turnConfigured: servers.some(s => (Array.isArray(s.urls) ? s.urls : [s.urls]).some(u => /^turns?:/.test(u))) });
      const pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: relay ? 'relay' : 'all', maxMessageSize: 4096 });
      pc.iceConnectionStateChange.subscribe(state => { log('ice', { player: m.peer, state }); });
      const peer: Peer = { pc, chain: Promise.resolve(), created: performance.now(), last: performance.now(), count: 0, windowAt: performance.now(), candidates: 0, metricsAt: -10000 };
      peers.set(m.peer, peer);
      pc.onIceCandidate.subscribe(candidate => { if (candidate) sendSignal({ type: 'candidate', peer: m.peer, candidate: candidate.toJSON() }); });
      pc.connectionStateChange.subscribe(state => { log('connection', { player: m.peer, state }); if (state === 'failed' || state === 'closed') drop(m.peer); });
      pc.onDataChannel.subscribe(channel => {
        log('channel', { player: m.peer, label: channel.label, ordered: channel.ordered, maxRetransmits: channel.maxRetransmits });
        if (channel.label === 'state' && !peer.state && !channel.ordered && channel.maxRetransmits === 0) peer.state = channel;
        else if (channel.label === 'events' && !peer.events && channel.ordered && channel.maxRetransmits === null && channel.maxPacketLifeTime === null) peer.events = channel;
        else { drop(m.peer); return; }
        const ready = () => {
          if (peer.state?.readyState !== 'open' || peer.events?.readyState !== 'open' || game.players.has(m.peer)) return;
          const player = game.add(m.peer);
          if (!player) { drop(m.peer); return; }
          log('join', { player: m.peer, slot: player.slot });
          send(m.peer, peer.events, { type: 'welcome', id: m.peer, ...game.snapshot() }, true);
        };
        channel.stateChange.subscribe(ready); ready();
        channel.onMessage.subscribe(rawData => {
          const now = performance.now();
          if (now - peer.windowAt >= 1000) { peer.count = 0; peer.windowAt = now; }
          // Allow network bursts of the 60 Hz input stream while bounding sustained abuse.
          if (rawData.length > 2048 || ++peer.count > 180) { drop(m.peer, 'message limit exceeded'); return; }
          let data: any; try { data = JSON.parse(rawData.toString()); } catch { drop(m.peer); return; }
          if (!data || typeof data !== 'object') return;
          peer.last = performance.now();
          if (channel.label === 'state') game.input(m.peer, data);
          else if (data.type === 'shoot') {
            const result = game.shoot(m.peer, data);
            log('shot-command', { player: m.peer, seq: Number.isSafeInteger(data.seq) ? data.seq : null,
              ageMs: Number.isSafeInteger(data.tick) ? (game.tick - data.tick) * DT * 1000 : null, result,
              aim: ['yaw', 'pitch', 'viewTick'].map(k => typeof data[k] === 'number' && Number.isFinite(data[k]) ? data[k] : null),
              players: [...game.players.values()].map(p => ({ id: p.id, x: p.x, y: p.y, z: p.z, health: p.health, shield: p.shield, life: p.life })) });
            if (result !== 'accepted') send(m.peer, peer.events, { type: 'shot-rejected', seq: data.seq, reason: result }, true);
          } else if (data.type === 'telemetry' && now - peer.metricsAt >= 4000) {
            peer.metricsAt = now; log('client-metrics', { player: m.peer, ...clientMetrics(data) });
          }
          else if (data.type === 'ping' && typeof data.at === 'number') send(m.peer, channel, { type: 'pong', at: data.at }, true);
        });
      });
      sendSignal({ type: 'config', peer: m.peer, iceServers: servers, relay });
    } else if (m.type === 'leave') drop(m.peer, 'browser disconnected');
    else {
      const peer = peers.get(m.peer); if (!peer) return;
      peer.chain = peer.chain.then(async () => {
        if (!peers.has(m.peer)) return;
        if (m.type === 'offer' && !peer.pc.remoteDescription && m.sdp?.type === 'offer' && typeof m.sdp.sdp === 'string') {
          await peer.pc.setRemoteDescription(m.sdp);
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          sendSignal({ type: 'answer', peer: m.peer, sdp: peer.pc.localDescription });
        } else if (m.type === 'candidate' && peer.pc.remoteDescription && ++peer.candidates <= 64) await peer.pc.addIceCandidate(m.candidate);
      }).catch(error => { log('negotiation-failed', { player: m.peer }); drop(m.peer, 'negotiation failed'); });
    }
  });
  let previous = performance.now(), accumulator = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    if (now - previous > 100) log('server-stall', { milliseconds: Math.round(now - previous) });
    accumulator += Math.min((now - previous) / 1000, DT * 5); previous = now;
    while (accumulator >= DT) {
      game.step(); accumulator -= DT;
      for (const event of game.events.splice(0)) {
        if (event.type === 'shot') log(event.killed ? 'kill' : event.hit ? 'hit' : 'miss', { shooter: event.shooter, victim: event.hit, shot: event.seq });
        else log(event.type, { player: event.type === 'respawn' ? event.player.id : event.player });
        for (const [id, p] of peers) send(id, p.events, event, true);
      }
      if (game.tick % 3 === 0) for (const [id, p] of peers) send(id, p.state, game.snapshot());
    }
    for (const [id, p] of peers) if ((game.players.has(id) && now - p.last > 10000) || (!game.players.has(id) && now - p.created > 25000)) drop(id, 'connection timeout');
  }, 4);
  const close = async () => {
    if (stopped) return; stopped = true; clearInterval(timer); pending.clear();
    const closing = [...peers.values()].map(p => p.pc.close()); peers.clear(); game.players.clear();
    signal.close(); await Promise.allSettled(closing); finish();
  };
  signal.on('close', () => { void close(); });
  signal.on('error', () => { log('signaling-failed'); void close(); });
  await new Promise<void>((resolve, reject) => {
    signal.once('open', () => sendSignal({ type: 'host', room }));
    signal.once('error', reject);
    signal.once('close', (_, reason) => reject(new Error(`Signaling closed: ${reason}`)));
    const ready = (raw: import('ws').RawData) => {
      if (JSON.parse(raw.toString()).type === 'hosted') { signal.off('message', ready); resolve(); }
    };
    signal.on('message', ready);
  });
  log('ready', { relayOnly: relay, credentials: typeof iceServers === 'function' ? 'per-player' : 'static' });
  return { game, close, closed };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (existsSync('.env')) loadEnvFile('.env');
  process.env.BLAM_LOG_DIR ||= 'logs';
  const url = process.env.SIGNAL_URL || 'ws://127.0.0.1:8787/signal';
  const room = process.env.ROOM || randomBytes(18).toString('base64url');
  // Fail startup clearly if the provider rejects the key. Each player gets fresh credentials on join.
  await getIceServers();
  const host = await startHost(url, room, getIceServers, process.env.FORCE_RELAY === '1');
  const client = process.env.CLIENT_URL || url.replace(/^ws/, 'http').replace(/\/signal$/, '/');
  // ponytail: werift retains TURN refresh timers; the standalone process exits after transport cleanup.
  void host.closed.then(() => process.exit(0));
  console.log(`Server ready. Open this link on both laptops:\n${client}#room=${room}&signal=${encodeURIComponent(url)}`);
  for (const event of ['SIGINT', 'SIGTERM'] as const) process.on(event, () => { void host.close().then(() => process.exit()); });
}
