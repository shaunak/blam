export const weaponBob = () => ({ phase: 0, amount: 0, x: 0, y: 0 });
export function updateWeaponBob(bob: ReturnType<typeof weaponBob>, distance: number, elapsed: number, active: boolean) {
  const walking = active && distance > .0001;
  if (walking) bob.phase = (bob.phase + distance * 2.4) % (Math.PI * 2);
  bob.amount += ((walking ? 1 : 0) - bob.amount) * (1 - Math.exp(-elapsed * 12));
  const swing = Math.sin(bob.phase);
  bob.x = swing * .035 * bob.amount;
  // A U-shaped parabola: lowest at the center, higher at either side.
  bob.y = (swing * swing - 1) * .018 * bob.amount;
}
