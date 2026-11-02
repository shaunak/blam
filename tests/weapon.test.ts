import assert from 'node:assert/strict';
import { test } from 'node:test';
import { weaponBob, updateWeaponBob } from '../src/weapon';

test('weapon sways along a U-shaped parabola and settles when movement stops', () => {
  const bob = weaponBob();
  const samples = [];
  for (let i = 0; i < 120; i++) {
    updateWeaponBob(bob, .1, 1 / 60, true);
    assert.ok(Math.abs(bob.x) <= .035 && bob.y >= -.018 && bob.y <= 0);
    assert.ok(Math.abs(bob.y / bob.amount - .018 * ((bob.x / bob.amount / .035) ** 2 - 1)) < 1e-10);
    samples.push(bob.x);
  }
  assert.ok(Math.min(...samples) < -.03 && Math.max(...samples) > .03);
  for (let i = 0; i < 120; i++) updateWeaponBob(bob, 0, 1 / 60, true);
  assert.ok(Math.abs(bob.x) < .00001 && Math.abs(bob.y) < .00001);
  const phase = bob.phase;
  updateWeaponBob(bob, 1, 1 / 60, false);
  assert.equal(bob.phase, phase, 'airborne, paused, and reduced-motion states do not advance the swing');
});
