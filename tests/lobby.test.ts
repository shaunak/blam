import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { startLobby } from '../src/lobby.js';
import { words } from '../src/words.js';

test('rooms use three-word invites, require gateway auth, resolve exactly, and bound capacity', async t => {
  assert.equal(new Set(words).size, 1295);
  assert.ok(words.every(w => /^[a-z]{2,9}$/.test(w)));
  const lobby = await startLobby('test-gateway-key');
  const base = `http://127.0.0.1:${lobby.port}/api/session`;
  const headers = { Authorization: 'Bearer test-gateway-key' };
  try {
    assert.equal((await fetch(base, { method: 'POST' })).status, 403);
    const response = await fetch(base, { method: 'POST', headers });
    assert.equal(response.status, 200);
    const room = await response.json();
    assert.equal(room.code.split('-').length, 3);
    assert.ok(room.code.length <= 29);
    assert.match(room.room, /^[a-zA-Z0-9_-]{24}$/);
    assert.deepEqual(await (await fetch(`${base}?room=${room.code}`, { headers })).json(), room);
    assert.equal((await fetch(`${base}?room=missing-game-code`, { headers })).status, 404);
    assert.equal((await fetch(base, { method: 'DELETE', headers })).status, 405);
    for (let i = 0; i < 7; i++) assert.equal((await fetch(base, { method: 'POST', headers })).status, 200);
    assert.equal((await fetch(base, { method: 'POST', headers })).status, 503);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.mock.timers.setTime(Date.now() + 61000);
    await delay(1100);
    assert.equal((await fetch(`${base}?room=${room.code}`, { headers })).status, 404, 'empty rooms expire');
    assert.equal((await fetch(base, { method: 'POST', headers })).status, 200, 'expired rooms release capacity');
  } finally { await lobby.close(); }
});
