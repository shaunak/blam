import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRifle, weaponBob, updateWeaponBob } from '../src/weapon';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';

test('rifle parts follow recoil, hide together, and emit shots beyond the barrel', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const { gun, muzzle } = createRifle(scene);
    gun.position.set(.3, -.25, .6);
    const parts = gun.getChildMeshes().filter(part => part !== muzzle);
    assert.ok(parts.length > 1, 'rifle has a shaped body');
    assert.equal(muzzle.isEnabled(), false, 'flash starts hidden');
    muzzle.computeWorldMatrix(true);
    for (const part of parts) {
      part.computeWorldMatrix(true);
      assert.equal(part.isPickable, false, 'view model cannot intercept aim rays');
      assert.ok(part.getBoundingInfo().boundingBox.maximumWorld.z < muzzle.getAbsolutePosition().z, 'tracer starts outside the barrel');
    }
    const before = muzzle.getAbsolutePosition().z;
    gun.position.z -= .07;
    muzzle.computeWorldMatrix(true);
    assert.ok(Math.abs(muzzle.getAbsolutePosition().z - before + .07) < 1e-6);
    gun.setEnabled(false);
    assert.ok(parts.every(part => !part.isEnabled()), 'menu hides the whole rifle');
  } finally { scene.dispose(); engine.dispose(); }
});

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
