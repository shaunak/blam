import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getIceServers } from '../src/ice.js';

test('Cloudflare credentials are minted per request, filtered, and contain no API key', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    requests++;
    assert.equal(url, 'https://rtc.live.cloudflare.com/v1/turn/keys/example-key/credentials/generate-ice-servers');
    assert.equal((options.headers as Record<string, string>).Authorization, 'Bearer server-secret');
    assert.deepEqual(JSON.parse(String(options.body)), { ttl: 86400 });
    return new Response(JSON.stringify({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: `user-${requests}`, credential: 'temporary', extra: 'server-secret' }] }), { status: 201 });
  });
  const env = { CF_TURN_KEY_ID: 'example-key', CF_TURN_API_TOKEN: 'server-secret' };
  const first = await getIceServers(env), second = await getIceServers(env);
  assert.equal(requests, 2); assert.notEqual(first[1].username, second[1].username);
  assert.equal(JSON.stringify(first).includes('server-secret'), false);
  assert.equal(JSON.stringify(first).includes(':53'), false);
  assert.equal(first[1].credential, 'temporary');
});

test('credential failures stop relay setup without exposing secrets', async t => {
  const env = { CF_TURN_KEY_ID: 'example-key', CF_TURN_API_TOKEN: 'server-secret' };
  await assert.rejects(getIceServers({ CF_TURN_KEY_ID: 'example-key' }), /CF_TURN_API_TOKEN/);
  t.mock.method(globalThis, 'fetch', async () => new Response('server-secret', { status: 401 }));
  await assert.rejects(getIceServers(env), { message: 'Cloudflare TURN credential request failed (HTTP 401).' });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ iceServers: [] })));
  await assert.rejects(getIceServers(env), /no usable TURN/);
});

test('direct and static TURN configuration still work', async () => {
  assert.deepEqual(await getIceServers({}), [{ urls: 'stun:stun.l.google.com:19302' }]);
  await assert.rejects(getIceServers({ TURN_URL: 'turn:example.com:3478' }), /TURN_USERNAME/);
  const ice = await getIceServers({ TURN_URL: 'turn:example.com:3478', TURN_USERNAME: 'user', TURN_PASSWORD: 'temporary' });
  assert.equal(ice[1].username, 'user');
});
