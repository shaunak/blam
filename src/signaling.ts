import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

export async function startSignaling(port = 8787, address = '127.0.0.1', sessionHandler?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>) {
  type Room = { host: WebSocket; clients: Map<string, WebSocket> };
  const rooms = new Map<string, Room>();
  const root = resolve('dist');
  const server = createServer(async (req, res) => {
    if (req.url?.split('?')[0] === '/api/session' && sessionHandler) { await sessionHandler(req, res); return; }
    if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
    try {
      const path = decodeURIComponent(new URL(req.url!, 'http://localhost').pathname);
      const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
      if (!file.startsWith(root + '/')) { res.writeHead(403); res.end(); return; }
      const body = await readFile(file);
      const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream',
        'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }); res.end(body);
    } catch { res.writeHead(404); res.end('Build the client with npm run build.'); }
  });
  const wss = new WebSocketServer({ server, path: '/signal', maxPayload: 65536 });
  const send = (ws: WebSocket, data: unknown) => {
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 131072) ws.send(JSON.stringify(data));
    else ws.close();
  };
  wss.on('connection', (ws) => {
    if (wss.clients.size > 100) { ws.close(1013, 'Server full'); return; }
    let room: Room | undefined, name = '', id = '', host = false, alive = true;
    let count = 0, windowAt = Date.now();
    const registration = setTimeout(() => ws.close(1008, 'Join timeout'), 10000);
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => { if (!alive) ws.terminate(); else { alive = false; ws.ping(); } }, 15000);
    ws.on('message', raw => {
      if (Date.now() - windowAt > 1000) { count = 0; windowAt = Date.now(); }
      if (++count > 120) { ws.close(1008, 'Too many messages'); return; }
      let m: any;
      try { m = JSON.parse(raw.toString()); } catch { ws.close(1008, 'Invalid JSON'); return; }
      if (!m || typeof m !== 'object') { ws.close(1008, 'Invalid message'); return; }
      if (!room) {
        if (!['host', 'join'].includes(m.type) || typeof m.room !== 'string' || !/^[a-zA-Z0-9_-]{16,64}$/.test(m.room)) {
          ws.close(1008, 'Invalid room'); return;
        }
        name = m.room;
        if (m.type === 'host') {
          if (rooms.has(name)) { ws.close(1008, 'Room already exists'); return; }
          host = true; room = { host: ws, clients: new Map() }; rooms.set(name, room);
          send(ws, { type: 'hosted' });
        } else {
          room = rooms.get(name);
          if (!room) { ws.close(1008, 'Session ended or invite expired. Ask the host for a new invite.'); return; }
          if (room.clients.size >= 2) { room = undefined; ws.close(1008, 'Room full (2/2). Close an extra game tab, then reconnect.'); return; }
          id = randomUUID(); room.clients.set(id, ws); send(ws, { type: 'joined' }); send(room.host, { type: 'join', peer: id });
        }
        clearTimeout(registration); return;
      }
      if (host) {
        if (typeof m.peer !== 'string') return;
        const client = room.clients.get(m.peer);
        if (!client) return;
        if (m.type === 'drop') client.close(1000, 'Connection ended');
        else if (['config', 'answer', 'candidate', 'error'].includes(m.type)) send(client, m);
      } else if (['offer', 'candidate'].includes(m.type)) {
        send(room.host, { ...m, peer: id });
      }
    });
    ws.on('error', () => ws.close());
    ws.on('close', () => {
      clearTimeout(registration); clearInterval(heartbeat);
      if (!room) return;
      if (host) { rooms.delete(name); for (const c of room.clients.values()) c.close(1000, 'Host stopped'); }
      else { room.clients.delete(id); send(room.host, { type: 'leave', peer: id }); }
    });
  });
  await new Promise<void>(r => server.listen(port, address, r));
  return { server, port: (server.address() as import('node:net').AddressInfo).port,
    close: async () => { for (const c of wss.clients) c.terminate(); await new Promise<void>(r => wss.close(() => server.close(() => r()))); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await startSignaling(Number(process.env.PORT || 8787), process.env.BIND || '127.0.0.1');
  console.log(`Signaling and client: http://${process.env.BIND || '127.0.0.1'}:${app.port}`);
}
