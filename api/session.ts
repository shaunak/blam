import { get } from '@vercel/blob';
import type { IncomingMessage, ServerResponse } from 'node:http';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  const reply = (status: number, body: object) => { res.statusCode = status; res.end(JSON.stringify(body)); };
  if (req.method !== 'GET' && req.method !== 'POST') { reply(405, { error: 'Method not allowed' }); return; }
  const code = new URL(req.url!, 'https://localhost').searchParams.get('room') || '';
  if (req.method === 'GET' && !/^[a-z]{2,9}-[a-z]{2,9}-[a-z]{2,9}$/.test(code)) { reply(404, { error: 'This invite is not valid.' }); return; }
  try {
    const blob = await get('host.json', { access: 'private', useCache: false });
    if (!blob || blob.statusCode !== 200) throw new Error('Host not registered');
    const host = await new Response(blob.stream).json();
    if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(host.origin) || typeof host.key !== 'string') throw new Error('Invalid host record');
    const upstream = await fetch(`${host.origin}/api/session?room=${encodeURIComponent(code)}`, {
      method: req.method, headers: { Authorization: `Bearer ${host.key}` }, signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    const body = await upstream.json();
    reply(upstream.status, body);
  } catch { reply(503, { error: 'The game server is offline. Start the server on the host laptop, then try again.' }); }
}
