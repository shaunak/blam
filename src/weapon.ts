import { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math';

export function createRifle(scene: Scene) {
  const gun = new TransformNode('rifle', scene);
  const finish = (name: string, color: string) => {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor = Color3.FromHexString(color);
    m.specularColor = new Color3(.18, .18, .18);
    return m;
  };
  const metal = finish('gun-metal', '#515b65'), dark = finish('gun-dark', '#242a30');
  const polymer = finish('gun-polymer', '#9c8b69'), inset = finish('gun-inset', '#11171c');
  const box = (name: string, w: number, h: number, d: number, x: number, y: number, z: number, material = metal) => {
    const mesh = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
    mesh.parent = gun; mesh.position.set(x, y, z); mesh.material = material; mesh.isPickable = false;
    return mesh;
  };
  box('receiver', .125, .13, .3, 0, 0, -.06);
  box('lower-receiver', .11, .06, .23, 0, -.085, -.055, dark);
  box('stock-tube', .065, .065, .13, 0, .005, -.27, dark);
  box('stock', .105, .14, .17, 0, -.025, -.37, polymer);
  box('butt-pad', .115, .17, .025, 0, -.04, -.465, dark);
  box('pistol-grip', .075, .19, .085, 0, -.18, -.17, polymer).rotation.x = -.25;
  box('magazine', .085, .23, .12, 0, -.19, .025, dark).rotation.x = .14;
  box('magazine-base', .095, .03, .13, 0, -.31, .008, metal);
  box('trigger-guard-base', .035, .018, .105, 0, -.17, -.09, dark);
  box('trigger-guard-front', .035, .075, .018, 0, -.135, -.04, dark);
  box('trigger', .018, .045, .018, 0, -.13, -.105, metal).rotation.x = -.3;
  box('handguard', .115, .12, .29, 0, .005, .235, polymer);
  box('top-rail', .065, .025, .58, 0, .08, .08, dark);
  for (let i = 0; i < 9; i++) box('rail-tooth', .08, .014, .018, 0, .1, -.17 + i * .06, metal);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) box('handguard-vent', .003, .027, .035, side * .058, .025, .13 + i * .06, inset);
    box('rear-sight', .016, .065, .025, side * .027, .135, -.15, dark);
    box('magazine-rib', .006, .17, .018, side * .045, -.2, .02, metal).rotation.x = .14;
  }
  box('front-sight-base', .065, .035, .035, 0, .12, .34, dark);
  box('front-sight-post', .012, .045, .018, 0, .16, .34, metal);
  box('ejection-port', .004, .035, .1, .064, .02, -.04, inset);
  box('charging-handle', .04, .02, .035, -.075, .025, -.14, dark);
  for (const [name, diameter, length, z] of [
    ['barrel', .038, .2, .47], ['muzzle-brake', .065, .08, .6], ['bore', .039, .002, .641],
  ] as const) {
    const mesh = MeshBuilder.CreateCylinder(name, { diameter, height: length, tessellation: 12 }, scene);
    mesh.parent = gun; mesh.rotation.x = Math.PI / 2; mesh.position.set(0, .025, z);
    mesh.material = name === 'bore' ? inset : dark; mesh.isPickable = false;
  }
  // Batch fixed parts by finish so the detailed model needs only four draw calls.
  for (const material of [metal, dark, polymer, inset]) {
    const parts = gun.getChildMeshes().filter(part => part.material === material) as Mesh[];
    const mesh = Mesh.MergeMeshes(parts, true)!;
    mesh.parent = gun; mesh.isPickable = false;
  }
  const muzzle = MeshBuilder.CreateSphere('muzzle', { diameter: .09, segments: 4 }, scene);
  muzzle.parent = gun; muzzle.position.set(0, .025, .7); muzzle.scaling.set(1, 1, 1.8);
  const flash = finish('flash', '#fff0bf'); flash.emissiveColor = Color3.FromHexString('#ffdb87');
  muzzle.material = flash; muzzle.isPickable = false; muzzle.setEnabled(false);
  return { gun, muzzle };
}

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
