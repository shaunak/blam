import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelemetry, clientMetrics } from '../src/telemetry';

test('telemetry rotates within its total budget, survives restart, and stores valid private JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blam-log-'));
  try {
    for (let round = 0; round < 2; round++) {
      const log = createTelemetry(dir, 3000);
      for (let i = 0; i < 100; i++) log.write({ event: 'shot', seq: round * 100 + i });
      await log.flush();
    }
    const files = await readdir(dir);
    assert.ok(files.length <= 10);
    let total = 0;
    for (const file of files) {
      const info = await stat(join(dir, file)); total += info.size;
      assert.equal(info.mode & 0o777, 0o600);
      for (const line of (await readFile(join(dir, file), 'utf8')).trim().split('\n')) JSON.parse(line);
    }
    assert.ok(total <= 3000);
    assert.match(await readFile(join(dir, 'game-0.jsonl'), 'utf8'), /"seq":199/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('browser metrics discard arbitrary text, credentials, and invalid numbers', () => {
  assert.deepEqual(clientMetrics({ rtt: 140, route: 'TURN RELAY', paused: true, fps: NaN, correction: -1, token: 'secret', url: 'private', message: 'anything' }), { rtt: 140, route: 'TURN RELAY', paused: true });
});
