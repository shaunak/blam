import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { startSignaling } from './signaling.js';
import { startHost } from './host.js';
import { words } from './words.js';

export async function startLobby(key: string, ice: Parameters<typeof startHost>[2] = [], relay = false) {
  type Room = { id: string; host?: Awaited<ReturnType<typeof startHost>>; emptySince: number };
  const rooms = new Map<string, Room>();
  let publicOrigin = '', stopped = false, requests = 0, windowAt = Date.now();
  const signal = await startSignaling(0, '127.0.0.1', async (req, res) => {
    const reply = (status: number, body: object) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    const supplied = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${key}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { reply(403, { error: 'Forbidden' }); return; }
    if (Date.now() - windowAt > 60000) { requests = 0; windowAt = Date.now(); }
    // ponytail: one laptop, bounded rooms and requests. Add per-user limits if this becomes a public service.
    if (++requests > 120) { reply(429, { error: 'Too many requests. Try again in a minute.' }); return; }
    if (stopped) { reply(503, { error: 'The host is offline.' }); return; }
    let code = new URL(req.url!, 'http://localhost').searchParams.get('room') || '';
    if (req.method === 'POST') {
      if (rooms.size >= 8) { reply(503, { error: 'The host is busy. Try again shortly.' }); return; }
      do { code = Array.from({ length: 3 }, () => words[randomInt(words.length)]).join('-'); } while (rooms.has(code));
      const room: Room = { id: randomBytes(18).toString('base64url'), emptySince: Date.now() };
      rooms.set(code, room);
      try {
        room.host = await startHost(`ws://127.0.0.1:${signal.port}/signal`, room.id, ice, relay);
        if (stopped) { await room.host.close(); reply(503, { error: 'The host is offline.' }); return; }
        void room.host.closed.then(() => { if (rooms.get(code) === room) rooms.delete(code); });
      } catch { rooms.delete(code); reply(503, { error: 'Could not start the room. Try again.' }); return; }
    } else if (req.method !== 'GET') { reply(405, { error: 'Method not allowed' }); return; }
    if (!/^[a-z]{2,9}-[a-z]{2,9}-[a-z]{2,9}$/.test(code) || !rooms.get(code)?.host) {
      reply(404, { error: 'This invite expired. Ask your friend for a new link.' }); return;
    }
    reply(200, { code, room: rooms.get(code)!.id, signal: (publicOrigin || `http://127.0.0.1:${signal.port}`).replace(/^http/, 'ws') + '/signal' });
  });
  const timer = setInterval(() => {
    for (const [code, room] of rooms) {
      if (room.host?.game.players.size) room.emptySince = Date.now();
      else if (Date.now() - room.emptySince > 60000) { rooms.delete(code); void room.host?.close(); }
    }
  }, 1000);
  return {
    port: signal.port,
    publish(origin: string) { publicOrigin = origin; },
    async close() { stopped = true; clearInterval(timer); await Promise.allSettled([...rooms.values()].map(r => r.host?.close())); rooms.clear(); await signal.close(); },
  };
}
