import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import { test } from 'node:test';
import { waitForTunnelFailure } from '../src/tunnel';

test('tunnel recovery requires three consecutive failed public health checks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const responses = [503, 503, 200, 503, 503, 503];
  t.mock.method(globalThis, 'fetch', async () => new Response('ok', { status: responses.shift()! }));
  const controller = new AbortController();
  let failed = false;
  const watching = waitForTunnelFailure('https://example.com', controller.signal).then(() => { failed = true; });
  try {
    await flush();
    assert.equal(failed, false);
    for (let i = 0; i < 6; i++) {
      t.mock.timers.tick(30000);
      await flush();
      assert.equal(failed, i === 5, 'a successful check resets the failure count');
    }
    await watching;
  } finally { controller.abort(); await watching; }
});

test('DNS failures trigger recovery and shutdown cancels the health check wait', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
  const controller = new AbortController();
  let failed = false;
  const watching = waitForTunnelFailure('https://example.com', controller.signal).then(() => { failed = true; });
  try {
    for (let i = 0; i < 3; i++) {
      t.mock.timers.tick(30000); await flush();
      assert.equal(failed, i === 2, 'a running process with broken DNS is unhealthy');
    }
    await watching;
    const next = waitForTunnelFailure('https://example.com', controller.signal);
    controller.abort();
    await next;
  } finally { controller.abort(); await watching; }
});
