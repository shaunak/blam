import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, DT, RULES, BOXES, idle, move, makePlayer, validInput } from '../src/game.js';
const input = (seq = 1) => ({ seq, x: 0, z: 1, yaw: 0, pitch: 0, jump: false });

test('movement is bounded, collides with cover, and jump returns to floor', () => {
  const p = makePlayer('a', 0); p.x = 0; p.z = -6;
  for (let i = 0; i < 180; i++) move(p, input(), DT);
  assert.ok(p.z < -1.8, 'central cover stops movement');
  p.x = 10; p.z = 0;
  for (let i = 0; i < 300; i++) move(p, input(), DT);
  assert.ok(p.z <= 11.65);
  move(p, { ...input(), z: 0, jump: true }, DT);
  assert.ok(p.y > 0);
  for (let i = 0; i < 120; i++) move(p, { ...input(), z: 0 }, DT);
  assert.equal(p.y, 0);
});

test('invalid inputs cannot enter the simulation', () => {
  assert.equal(validInput({ ...input(), yaw: NaN }), false);
  assert.equal(validInput({ ...input(), x: 100 }), false);
  assert.equal(validInput(input()), true);
});

test('lost input releases movement after timeout', () => {
  const g = new Game(); const p = g.add('a')!;
  g.input('a', input());
  for (let i = 0; i < 20; i++) g.step();
  const z = p.z;
  for (let i = 0; i < 60; i++) g.step();
  assert.equal(p.z, z);
});

test('server resolves shields, deduplicates damage, rejects late shots, kills and respawns', () => {
  const g = new Game(); const a = g.add('a')!; const b = g.add('b')!;
  a.x = b.x = 8; a.z = -4; b.z = 4;
  const shot = (seq: number) => ({ seq, tick: g.tick, life: a.life, yaw: 0, pitch: 0 });
  g.shoot('a', shot(1)); assert.equal(b.shield, 20); assert.equal(b.health, 100);
  g.shoot('a', shot(1)); assert.equal(b.shield, 20);
  for (let i = 0; i < 16; i++) g.step();
  g.shoot('a', { ...shot(2), tick: g.tick - 31 }); assert.equal(b.shield, 20);
  g.shoot('a', shot(3)); assert.equal(b.shield, 0); assert.equal(b.health, 90);
  for (let n = 4; n <= 6; n++) {
    for (let i = 0; i < 16; i++) g.step();
    g.shoot('a', shot(n));
  }
  assert.equal(b.health, 0); assert.equal(a.kills, 1);
  for (let i = 0; i < 121; i++) g.step();
  assert.equal(b.health, 100); assert.equal(b.life, 2);
  g.shoot('b', { seq: 1, tick: g.tick, life: 1, yaw: Math.PI, pitch: 0 });
  assert.equal(a.shield, 50);
});

test('cover blocks shots and shields recharge without restoring health', () => {
  const g = new Game(); const a = g.add('a')!; const b = g.add('b')!;
  a.x = b.x = 0; a.z = -4; b.z = 4;
  g.shoot('a', { seq: 1, tick: 0, life: 1, yaw: 0, pitch: 0 });
  assert.equal(b.shield, 50);
  b.shield = 0; b.health = 70;
  for (let i = 0; i < 400; i++) g.step();
  assert.equal(b.shield, 50); assert.equal(b.health, 70);
});

test('respawn emits a reliable event and future or non-finite shots never damage', () => {
  const g = new Game(); const a = g.add('a')!; const b = g.add('b')!;
  a.x = b.x = 8; a.z = -4; b.z = 4;
  g.shoot('a', { seq: 1, tick: 1, life: 1, yaw: 0, pitch: 0 });
  g.shoot('a', { seq: 2, tick: 0, life: 1, yaw: Infinity, pitch: 0 });
  assert.equal(b.shield, 50);
  b.health = 0; b.respawnAt = 1; g.step();
  assert.ok(g.events.some(e => e.type === 'respawn'));
});


test('jumping against every cover face never pushes the player under the floor', () => {
  for (const box of BOXES.slice(5)) for (const axis of ['x', 'z'] as const) for (const sign of [-1, 1]) {
    const p = makePlayer('a', 0); p.x = box.x; p.z = box.z;
    p[axis] += sign * ((axis === 'x' ? box.w : box.d) / 2 + 1);
    const control = { ...idle(), x: axis === 'x' ? -sign : 0, z: axis === 'z' ? -sign : 0, jump: true };
    for (let i = 0; i < 180; i++) {
      move(p, control, DT);
      assert.ok(p.y >= -0.00001, `fell through cover at ${box.x},${box.z}, face ${axis}/${sign}, tick ${i}`);
    }
  }
});

test('falling below the arena kills once and respawns without awarding a kill', () => {
  const g = new Game(), p = g.add('a')!, other = g.add('b')!;
  p.y = -6; p.grounded = false; g.step();
  assert.equal(p.health, 0); assert.equal(p.shield, 0); assert.equal(p.deaths, 1);
  assert.equal(other.kills, 0); assert.equal(p.kills, 0);
  assert.ok(g.events.some(e => e.type === 'fall'));
  for (let i = 0; i < RULES.respawnTicks - 1; i++) g.step();
  assert.equal(p.health, 0); assert.equal(p.deaths, 1);
  g.step();
  assert.equal(p.health, 100); assert.equal(p.shield, 50); assert.equal(p.y, 0);
  assert.equal(p.life, 2); assert.equal(p.deaths, 1);
});

test('a held jump clears the tallest cover and lands back on the floor', () => {
  const p = makePlayer('a', 0); p.x = 0; p.z = -2;
  let peak = 0;
  for (let i = 0; i < 150; i++) {
    move(p, { ...input(), jump: i < 40 }, DT);
    peak = Math.max(peak, p.y);
    assert.ok(p.y >= -0.00001);
  }
  assert.ok(peak > 2.6, 'feet clear the tallest cover');
  assert.ok(p.z > 1.85, 'player travels past the box');
  assert.equal(p.y, 0); assert.equal(p.grounded, true);
});


test('holding jump longer increases height and airtime up to the full jump', () => {
  const flights = [1, 12, 40].map(holdTicks => {
    const p = makePlayer('a', 0); let peak = 0, ticks = 0;
    do {
      move(p, { ...idle(), jump: ticks < holdTicks }, DT);
      peak = Math.max(peak, p.y); ticks++;
    } while (!p.grounded && ticks < 180);
    assert.equal(p.grounded, true);
    return { peak, ticks };
  });
  assert.ok(flights[0].peak < flights[1].peak && flights[1].peak < flights[2].peak);
  assert.ok(flights[0].ticks < flights[1].ticks && flights[1].ticks < flights[2].ticks);
  assert.ok(flights[2].peak > 2.6 && flights[2].peak < 3.1);
});

test('holding jump through landing does not bounce; release and press jumps again', () => {
  const p = makePlayer('a', 0);
  for (let i = 0; i < 100; i++) move(p, { ...idle(), jump: true }, DT);
  assert.equal(p.y, 0); assert.equal(p.grounded, true);
  move(p, idle(), DT);
  move(p, { ...idle(), jump: true }, DT);
  assert.ok(p.y > 0);
  move(p, idle(), DT);
  const velocity = p.vy;
  move(p, { ...idle(), jump: true }, DT);
  assert.ok(p.vy < velocity, 'pressing again in midair cannot boost the jump');
});

test('both player slots hit a moving target at its displayed historical position', () => {
  for (const shooterId of ['a', 'b']) {
    const g = new Game(); const a = g.add('a')!, b = g.add('b')!;
    const shooter = shooterId === 'a' ? a : b, victim = shooterId === 'a' ? b : a;
    shooter.x = victim.x = 8; shooter.z = -4; victim.z = 4;
    g.step(); const seen = g.tick;
    victim.x = 10;
    for (let i = 0; i < 12; i++) g.step();
    assert.equal(g.shoot(shooterId, { seq: 1, tick: seen + 6, viewTick: seen, life: 1, yaw: 0, pitch: 0 }), 'accepted');
    assert.equal(victim.shield, 20, 'rewind hits the position shown on the shooter screen');
    assert.equal(g.shoot(shooterId, { seq: 1, tick: seen + 6, viewTick: seen, life: 1, yaw: 0, pitch: 0 }), 'duplicate');
    assert.equal(victim.shield, 20);
  }
});
test('rewind rejects forged ages and never damages a new life using an old pose', () => {
  const g = new Game(), a = g.add('a')!, b = g.add('b')!;
  a.x = b.x = 8; a.z = -4; b.z = 4;
  g.step(); const seen = g.tick;
  b.life++; b.x = 10; g.step();
  assert.equal(g.shoot('a', { seq: 1, tick: seen, viewTick: seen, life: 1, yaw: 0, pitch: 0 }), 'accepted');
  assert.equal(b.shield, 50);
  for (let i = 0; i < 35; i++) g.step();
  assert.equal(g.shoot('a', { seq: 2, tick: seen, viewTick: seen, life: 1, yaw: 0, pitch: 0 }), 'late');
  assert.equal(g.shoot('a', { seq: 3, tick: g.tick, viewTick: 0, life: 1, yaw: 0, pitch: 0 }), 'invalid-view');
});

test('fire rate absorbs a two-shot delivery burst but blocks sustained rapid fire', () => {
  const g = new Game(), a = g.add('a')!, b = g.add('b')!;
  a.x = b.x = 8; a.z = -4; b.z = 4;
  const shot = (seq: number) => ({ seq, tick: g.tick, life: 1, yaw: 0, pitch: 0 });
  assert.equal(g.shoot('a', shot(1)), 'accepted');
  assert.equal(g.shoot('a', shot(2)), 'accepted');
  assert.equal(g.shoot('a', shot(3)), 'cooldown');
  assert.equal(b.health, 90);
  for (let i = 0; i < 15; i++) g.step();
  assert.equal(g.shoot('a', shot(4)), 'accepted');
  assert.equal(g.shoot('a', shot(5)), 'cooldown');
});
