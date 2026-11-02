import type { RTCIceServer } from 'werift';

export async function getIceServers(env: NodeJS.ProcessEnv = process.env): Promise<RTCIceServer[]> {
  if (env.CF_TURN_KEY_ID || env.CF_TURN_API_TOKEN) {
    if (!env.CF_TURN_KEY_ID || !env.CF_TURN_API_TOKEN) throw new Error('CF_TURN_KEY_ID and CF_TURN_API_TOKEN are required together.');
    let response: Response;
    try {
      response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.CF_TURN_KEY_ID)}/credentials/generate-ice-servers`, {
        method: 'POST', headers: { Authorization: `Bearer ${env.CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }), signal: AbortSignal.timeout(10000),
      });
    } catch { throw new Error('Cloudflare TURN credential request timed out or could not connect.'); }
    if (!response.ok) throw new Error(`Cloudflare TURN credential request failed (HTTP ${response.status}).`);
    let data: any;
    try { data = await response.json(); } catch { throw new Error('Cloudflare returned invalid TURN configuration.'); }
    if (!Array.isArray(data?.iceServers)) throw new Error('Cloudflare returned invalid TURN configuration.');
    const servers: RTCIceServer[] = [];
    for (const server of data.iceServers) {
      const urls: unknown[] = Array.isArray(server?.urls) ? server.urls : [server?.urls];
      // Chrome blocks port 53. Keep the normal UDP, TCP, and TLS endpoints.
      const usable = urls.filter((url): url is string => typeof url === 'string' && /^(stun|turn|turns):/.test(url) && !/:53(?:\?|$)/.test(url));
      if (!usable.length) continue;
      if (usable.some(url => /^turns?:/.test(url))) {
        if (typeof server.username !== 'string' || !server.username || typeof server.credential !== 'string' || !server.credential) throw new Error('Cloudflare returned invalid TURN credentials.');
        servers.push({ urls: usable, username: server.username, credential: server.credential });
      } else servers.push({ urls: usable });
    }
    if (!servers.some(s => (s.urls as string[]).some(url => /^turns?:/.test(url)))) throw new Error('Cloudflare returned no usable TURN servers.');
    return servers;
  }
  const servers: RTCIceServer[] = [{ urls: env.STUN_URL || 'stun:stun.l.google.com:19302' }];
  if (env.TURN_URL) {
    if (!env.TURN_USERNAME || !env.TURN_PASSWORD) throw new Error('TURN_USERNAME and TURN_PASSWORD are required.');
    servers.push({ urls: env.TURN_URL, username: env.TURN_USERNAME, credential: env.TURN_PASSWORD });
  }
  return servers;
}
