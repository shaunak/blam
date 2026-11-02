// One source of truth for server collision and client prediction. Units are meters.
export const DT = 1 / 60;
export const RULES = { speed: 6, jump: 11, jumpReleaseSpeed: 4, gravity: 20, radius: 0.35, height: 1.8,
  eye: 1.55, damage: 30, fireTicks: 15, shieldDelay: 180, shieldRate: 20, respawnTicks: 120, fallLimit: -5 };
export type Box = { x: number; y: number; z: number; w: number; h: number; d: number };
export const BOXES: Box[] = [
  { x: 0, y: -0.5, z: 0, w: 24, h: 1, d: 24 },
  { x: -12.5, y: 2, z: 0, w: 1, h: 4, d: 26 },
  { x: 12.5, y: 2, z: 0, w: 1, h: 4, d: 26 },
  { x: 0, y: 2, z: -12.5, w: 24, h: 4, d: 1 },
  { x: 0, y: 2, z: 12.5, w: 24, h: 4, d: 1 },
  { x: 0, y: 1.3, z: 0, w: 3, h: 2.6, d: 3 },
  { x: -6, y: 0.65, z: -3, w: 3, h: 1.3, d: 2 },
  { x: 6, y: 0.65, z: 3, w: 3, h: 1.3, d: 2 },
  { x: -5, y: 1.1, z: 6, w: 2, h: 2.2, d: 3 },
  { x: 5, y: 1.1, z: -6, w: 2, h: 2.2, d: 3 },
];
export type Input = { seq: number; x: number; z: number; yaw: number; pitch: number; jump: boolean };
export type Shot = { seq: number; tick: number; viewTick?: number; life: number; yaw: number; pitch: number };
export type Player = { id: string; slot: number; x: number; y: number; z: number; vy: number;
  yaw: number; pitch: number; grounded: boolean; jumpHeld: boolean; health: number; shield: number; life: number;
  kills: number; deaths: number; ack: number; respawnAt: number; damagedAt: number };
export type GameEvent = { type: 'shot'; shooter: string; seq: number; hit: string | null; killed: boolean; end: number[] } | { type: 'respawn'; player: Player; tick: number } | { type: 'fall'; player: string };
export type Snapshot = { tick: number; players: Player[] };
export const idle = (): Input => ({ seq: 0, x: 0, z: 0, yaw: 0, pitch: 0, jump: false });
export function makePlayer(id: string, slot: number): Player {
  return { id, slot, x: slot ? 8 : -8, y: 0, z: slot ? 8 : -8, vy: 0,
    yaw: slot ? Math.PI : 0, pitch: 0, grounded: true, jumpHeld: false, health: 100, shield: 50,
    life: 1, kills: 0, deaths: 0, ack: 0, respawnAt: 0, damagedAt: 0 };
}
const finite = (n: unknown, max: number) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= max;
const sequence = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
export function validInput(v: any): v is Input {
  return !!v && sequence(v.seq) && finite(v.x, 1) && finite(v.z, 1)
    && finite(v.yaw, Math.PI * 2) && finite(v.pitch, Math.PI / 2) && typeof v.jump === 'boolean';
}
// Ignore rounding noise at touching faces on every axis, including box sides.
const CONTACT_EPSILON = 0.00001;
function overlaps(p: Player, b: Box) {
  return p.x + RULES.radius > b.x - b.w / 2 + CONTACT_EPSILON && p.x - RULES.radius < b.x + b.w / 2 - CONTACT_EPSILON
    && p.z + RULES.radius > b.z - b.d / 2 + CONTACT_EPSILON && p.z - RULES.radius < b.z + b.d / 2 - CONTACT_EPSILON
    && p.y + RULES.height > b.y - b.h / 2 + CONTACT_EPSILON && p.y < b.y + b.h / 2 - CONTACT_EPSILON;
}
export function move(p: Player, input: Input, dt: number) {
  if (!p.health) return;
  p.yaw = input.yaw; p.pitch = input.pitch;
  const length = Math.max(1, Math.hypot(input.x, input.z));
  const dx = (input.x * Math.cos(input.yaw) + input.z * Math.sin(input.yaw)) / length * RULES.speed * dt;
  const dz = (input.z * Math.cos(input.yaw) - input.x * Math.sin(input.yaw)) / length * RULES.speed * dt;
  for (const [axis, delta] of [['x', dx], ['z', dz]] as const) {
    p[axis] += delta;
    for (const b of BOXES) if (overlaps(p, b)) {
      const half = (axis === 'x' ? b.w : b.d) / 2;
      p[axis] = b[axis] + (delta > 0 ? -1 : 1) * (half + RULES.radius);
    }
  }
  if (input.jump && !p.jumpHeld && p.grounded) { p.vy = RULES.jump; p.grounded = false; }
  // Releasing early cuts the ascent; holding preserves the full jump arc.
  if (!input.jump && p.vy > RULES.jumpReleaseSpeed) p.vy = RULES.jumpReleaseSpeed;
  p.jumpHeld = input.jump;
  p.vy -= RULES.gravity * dt;
  p.y += p.vy * dt; p.grounded = false;
  for (const b of BOXES) if (overlaps(p, b)) {
    if (p.vy <= 0) { p.y = b.y + b.h / 2; p.grounded = true; }
    else p.y = b.y - b.h / 2 - RULES.height;
    p.vy = 0;
  }
}
export function direction(yaw: number, pitch: number) {
  return [Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
}
function rayBox(origin: number[], dir: number[], b: Box): number {
  let near = 0, far = 100;
  const c = [b.x, b.y, b.z], half = [b.w / 2, b.h / 2, b.d / 2];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dir[i]) < 1e-8) {
      if (origin[i] < c[i] - half[i] || origin[i] > c[i] + half[i]) return Infinity;
    } else {
      const a = (c[i] - half[i] - origin[i]) / dir[i], z = (c[i] + half[i] - origin[i]) / dir[i];
      near = Math.max(near, Math.min(a, z)); far = Math.min(far, Math.max(a, z));
      if (near > far) return Infinity;
    }
  }
  return near;
}
export class Game {
  tick = 0;
  players = new Map<string, Player>();
  controls = new Map<string, { input: Input; at: number; shot: number; fired: number; tokens: number }>();
  events: GameEvent[] = [];
  private past: Snapshot[] = [];
  add(id: string) {
    if (this.players.size >= 2 || this.players.has(id)) return undefined;
    const slot = [...this.players.values()].some(p => p.slot === 0) ? 1 : 0;
    const p = makePlayer(id, slot); this.players.set(id, p);
    this.controls.set(id, { input: idle(), at: -100, shot: -1, fired: this.tick, tokens: 2 }); return p;
  }
  remove(id: string) { this.players.delete(id); this.controls.delete(id); }
  input(id: string, v: unknown) {
    const c = this.controls.get(id);
    if (!c || !validInput(v) || v.seq <= c.input.seq) return;
    c.input = v; c.at = this.tick;
  }
  step() {
    this.tick++;
    for (const p of this.players.values()) {
      const c = this.controls.get(p.id)!;
      if (!p.health && this.tick >= p.respawnAt) {
        Object.assign(p, makePlayer(p.id, p.slot), { life: p.life + 1, kills: p.kills, deaths: p.deaths, ack: c.input.seq });
        this.events.push({ type: 'respawn', player: { ...p }, tick: this.tick });
        c.input = { ...idle(), seq: c.input.seq, yaw: p.yaw }; c.at = -100;
      }
      const control = this.tick - c.at <= 9 ? c.input : { ...c.input, x: 0, z: 0, jump: false };
      move(p, control, DT); p.ack = c.input.seq;
      if (p.health && p.y < RULES.fallLimit) {
        p.health = 0; p.shield = 0; p.vy = 0; p.deaths++;
        p.respawnAt = this.tick + RULES.respawnTicks;
        this.events.push({ type: 'fall', player: p.id });
      }
      if (p.health && this.tick - p.damagedAt > RULES.shieldDelay) p.shield = Math.min(50, p.shield + RULES.shieldRate * DT);
    }
    this.past.push(this.snapshot()); if (this.past.length > 40) this.past.shift();
  }
  shoot(id: string, s: any) {
    const p = this.players.get(id), c = this.controls.get(id);
    if (!p || !c || !s || !sequence(s.seq) || !sequence(s.tick) || !sequence(s.life)
      || !finite(s.yaw, Math.PI * 2) || !finite(s.pitch, Math.PI / 2)) return 'invalid';
    if (s.seq <= c.shot) return 'duplicate';
    c.shot = s.seq;
    if (!p.health) return 'dead';
    if (s.life !== p.life) return 'old-life';
    if (s.tick > this.tick) return 'future';
    if (this.tick - s.tick > 30) return 'late';
    if (s.viewTick !== undefined && (!finite(s.viewTick, Number.MAX_SAFE_INTEGER) || s.viewTick < 0 || s.viewTick > s.tick || s.viewTick < s.tick - 9)) return 'invalid-view';
    // Two delivery slots absorb network bunching; refill remains four shots per second.
    c.tokens = Math.min(2, c.tokens + (this.tick - c.fired) / RULES.fireTicks); c.fired = this.tick;
    if (c.tokens < 1 - 1e-8) return 'cooldown';
    c.tokens = Math.max(0, c.tokens - 1);
    // Rewind target poses to the frame the shooter saw, bounded to 500 ms.
    const viewTick = Math.max(this.tick - 30, s.viewTick ?? this.tick);
    let left = this.past[0], right = this.past.at(-1);
    for (const frame of this.past) { if (frame.tick <= viewTick) left = frame; else { right = frame; break; } }
    const blend = left && right ? Math.max(0, Math.min(1, (viewTick - left.tick) / Math.max(1, right.tick - left.tick))) : 1;
    c.fired = this.tick;
    const origin = [p.x, p.y + RULES.eye, p.z], dir = direction(s.yaw, s.pitch);
    let distance = Math.min(100, ...BOXES.map(b => rayBox(origin, dir, b)));
    let victim: Player | undefined;
    for (const other of this.players.values()) {
      if (other.id === id || !other.health) continue;
      let pose = other;
      if (s.viewTick !== undefined) {
        const a = left?.players.find(v => v.id === other.id && v.life === other.life && v.health > 0);
        const b = right?.players.find(v => v.id === other.id && v.life === other.life && v.health > 0);
        if (!a || !b) continue;
        pose = { ...other, x: a.x + (b.x - a.x) * blend, y: a.y + (b.y - a.y) * blend, z: a.z + (b.z - a.z) * blend };
      }
      const d = rayBox(origin, dir, { x: pose.x, y: pose.y + RULES.height / 2, z: pose.z,
        w: RULES.radius * 2, h: RULES.height, d: RULES.radius * 2 });
      if (d < distance) { distance = d; victim = other; }
    }
    if (victim) {
      const absorbed = Math.min(victim.shield, RULES.damage);
      victim.shield -= absorbed; victim.health = Math.max(0, victim.health - (RULES.damage - absorbed)); victim.damagedAt = this.tick;
      if (!victim.health) { victim.deaths++; victim.respawnAt = this.tick + RULES.respawnTicks; p.kills++; }
    }
    this.events.push({ type: 'shot', shooter: id, seq: s.seq, hit: victim?.id ?? null,
      killed: !!victim && !victim.health, end: origin.map((n, i) => n + dir[i] * distance) });
    return 'accepted';
  }
  snapshot(): Snapshot { return { tick: this.tick, players: [...this.players.values()].map(p => ({ ...p })) }; }
}
