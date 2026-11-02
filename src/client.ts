import '@babylonjs/core/Rendering/edgesRenderer';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { Ray } from '@babylonjs/core/Culling/ray';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Vector3, Color3, Color4 } from '@babylonjs/core/Maths/math';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { BOXES, RULES, DT, idle, makePlayer, move, type Player, type Input, type Snapshot, type GameEvent } from './game';
import './style.css';
import { createRifle, weaponBob, updateWeaponBob } from './weapon';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('arena'), menu = $('menu'), enter = $<HTMLButtonElement>('enter');
const watchWithoutMouse = typeof canvas.requestPointerLock !== 'function' || matchMedia('(pointer: coarse)').matches;
const openMenu = $('open-menu');
const status = $('status'), form = $<HTMLFormElement>('join'), retry = $('retry');
const engine = new Engine(canvas, true);
const scene = new Scene(engine); scene.clearColor = new Color4(.055, .05, .055, 1);
const camera = new FreeCamera('eyes', new Vector3(-8, RULES.eye, -8), scene);
camera.minZ = .05; camera.fov = 1.3; camera.inputs.clear();
const orbit = new FreeCamera('menu-orbit', new Vector3(28, 30, 28), scene);
orbit.inputs.clear(); orbit.fov = .95;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let orbitAngle = Math.PI / 4;
new HemisphericLight('sky', new Vector3(.3, 1, .4), scene).intensity = 1.2;
function material(name: string, color: string) {
  const m = new StandardMaterial(name, scene); m.diffuseColor = Color3.FromHexString(color); m.specularColor = Color3.Black(); return m;
}
const floor = material('floor', '#cccccc'), wall = material('wall', '#eeeeee'), cover = material('cover', '#fafafa');
BOXES.forEach((b, i) => {
  const mesh = MeshBuilder.CreateBox(`arena-${i}`, { width: b.w, height: b.h, depth: b.d }, scene);
  mesh.position.set(b.x, b.y, b.z); mesh.material = i === 0 ? floor : i < 5 ? wall : cover;
  mesh.enableEdgesRendering(); mesh.edgesWidth = 1; mesh.edgesColor = new Color4(.12, .10, .11, .7);
});
const grid = material('grid', '#b0b0b0');
for (let n = -10; n <= 10; n += 2) for (const axis of ['x', 'z']) {
  const line = MeshBuilder.CreateBox('floor-line', { width: axis === 'x' ? .015 : 24, height: .006, depth: axis === 'z' ? .015 : 24 }, scene);
  line.position.set(axis === 'x' ? n : 0, .003, axis === 'z' ? n : 0); line.material = grid;
}
const colors = ['#c92332', '#ed7734'];
const avatars = colors.map((c, i) => {
  const body = MeshBuilder.CreateBox(`player-${i}`, { width: RULES.radius * 2, height: RULES.height, depth: RULES.radius * 2 }, scene);
  body.material = material(`player-color-${i}`, c); body.setEnabled(false); return body;
});
const { gun, muzzle } = createRifle(scene);
gun.parent = camera; gun.position.set(.3, -.25, .6);
const tracerMaterial = material('tracer', '#ff3344');
tracerMaterial.emissiveColor = Color3.FromHexString('#ff3344'); tracerMaterial.disableLighting = true;
let audio: AudioContext | undefined;
function beep(frequency: number, length: number, volume = .035) {
  if (!audio || audio.state !== 'running') return;
  const o = audio.createOscillator(), g = audio.createGain(); o.type = 'triangle'; o.frequency.setValueAtTime(frequency, audio.currentTime);
  o.frequency.exponentialRampToValueAtTime(frequency / 3, audio.currentTime + length);
  g.gain.setValueAtTime(volume, audio.currentTime); g.gain.exponentialRampToValueAtTime(.001, audio.currentTime + length);
  o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + length);
}
const params = new URLSearchParams(location.hash.slice(1));
let createdRoom = false;
let shortCode = params.has('room') ? '' : location.hash.slice(1);
const start = $<HTMLButtonElement>('start');
if (shortCode || params.has('room')) { start.textContent = 'Join Game'; $('back-menu').hidden = false; }
start.onclick = async () => {
  if (params.has('room') && !shortCode) { form.requestSubmit(); return; }
  start.disabled = true; status.textContent = shortCode ? 'Finding your friend’s game…' : 'Starting your game…';
  try {
    const response = await fetch(`/api/session${shortCode ? '?room=' + encodeURIComponent(shortCode) : ''}`, { method: shortCode ? 'GET' : 'POST', signal: AbortSignal.timeout(20000) });
    const room = await response.json();
    if (!response.ok) throw new Error(room.error || 'Could not start the game. Try again.');
    if (typeof room.code !== 'string' || !/^[a-z]{2,9}-[a-z]{2,9}-[a-z]{2,9}$/.test(room.code)) throw new Error('The host returned an invalid invite.');
    createdRoom = !shortCode;
    shortCode = room.code;
    $<HTMLInputElement>('room').value = room.room;
    $<HTMLInputElement>('signal').value = room.signal;
    form.requestSubmit();
  } catch (error) { status.textContent = error instanceof Error ? error.message : 'Could not reach the host.'; }
  finally { start.disabled = false; }
};
$<HTMLInputElement>('room').value = params.get('room') || '';
$<HTMLInputElement>('signal').value = params.get('signal') || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/signal`;
let pc: RTCPeerConnection | undefined, socket: WebSocket | undefined, state: RTCDataChannel | undefined, events: RTCDataChannel | undefined;
let me = '', local = makePlayer('', 0), connected = false, ended = false;
let history: Input[] = [], snapshots: { data: Snapshot; at: number }[] = [], lastTick = -1;
let yaw = 0, pitch = 0, seq = 0, shotSeq = 0, lastShot = -1000, lastSnapshot = 0;
let noticeUntil = 0, hitUntil = 0, damageUntil = 0, flashUntil = 0, ping = 0;
let viewTick = 0, route = 'UNKNOWN', metricsAt = performance.now(), frames = 0, maxFrameMs = 0;
let maxSnapshotGap = 0, maxCorrection = 0, shotsSent = 0, shotsConfirmed = 0, shotsRejected = 0, browserErrors = 0;
window.addEventListener('error', () => browserErrors++);
window.addEventListener('unhandledrejection', () => browserErrors++);
let phase = 'Not connected';
let timeoutReason = '';
function connectionStep(text: string, timeout: string) {
  phase = text; timeoutReason = timeout; status.textContent = text; updateNetwork();
}
function updateNetwork() {
  $<HTMLTextAreaElement>('network-details').value = `${phase}\nWebRTC: ${pc?.connectionState || 'not started'}\nICE: ${pc?.iceConnectionState || 'not started'} / gathering: ${pc?.iceGatheringState || 'not started'}\nMovement: ${state?.readyState || 'not started'} / events: ${events?.readyState || 'not started'}`;
}
const invite = $<HTMLInputElement>('invite');
$('copy-invite').onclick = async () => {
  try { await navigator.clipboard.writeText(invite.value); if (menu.classList.contains('paused')) $('copy-invite').textContent = 'Copied'; $('share-status').textContent = 'Invite copied. Send it to your friend.'; }
  catch { menu.classList.add('copy-fallback'); invite.focus(); invite.select(); $('share-status').textContent = 'Copy the selected link with Ctrl+C or Command+C.'; }
};
invite.onclick = () => invite.select();
let connectionTimeout: ReturnType<typeof setTimeout> | undefined;
let correction = new Vector3(), pendingCandidates: RTCIceCandidateInit[] = [];
const keys = new Set<string>();
function notice(text: string, seconds = 2) { $('notice').textContent = text; noticeUntil = performance.now() + seconds * 1000; }
function fail(reason: string) {
  if (ended) return; menu.classList.remove('paused', 'copy-fallback'); clearTimeout(connectionTimeout); ended = true; connected = false; keys.clear();
  pc?.close(); socket?.close();
  menu.hidden = false; openMenu.hidden = true; enter.hidden = true; form.hidden = true; start.hidden = true; $('options').hidden = true; retry.hidden = false;
  $('back-menu').hidden = false; phase = reason; updateNetwork(); $('share').hidden = true; $('leave').hidden = true; status.textContent = reason; $('connection').textContent = 'DISCONNECTED';
  // Mouse capture is optional on phones and must never block network cleanup.
  try { document.exitPointerLock?.(); } catch {}
}
retry.onclick = () => location.reload();
$('leave').onclick = () => { fail('You left the room.'); location.assign('/'); };
function receiveSnapshot(data: Snapshot) {
  if (data.tick <= lastTick) return;
  const receivedAt = performance.now();
  if (lastSnapshot) maxSnapshotGap = Math.max(maxSnapshotGap, receivedAt - lastSnapshot);
  lastTick = data.tick; lastSnapshot = receivedAt;
  snapshots.push({ data, at: lastSnapshot }); if (snapshots.length > 12) snapshots.shift();
  const authoritative = data.players.find(p => p.id === me); if (!authoritative) return;
  const old = local, newLife = authoritative.life !== old.life;
  history = history.filter(i => i.seq > authoritative.ack);
  local = { ...authoritative };
  if (newLife) { history = []; yaw = local.yaw; pitch = 0; correction.setAll(0); notice('FINISH THE FIGHT'); }
  else {
    for (const input of history) move(local, input, DT);
    const delta = new Vector3(old.x - local.x, old.y - local.y, old.z - local.z);
    maxCorrection = Math.max(maxCorrection, delta.length());
    if (delta.length() < 2) correction.addInPlace(delta); else correction.setAll(0);
  }
  if (authoritative.health + authoritative.shield < old.health + old.shield && !newLife) { damageUntil = performance.now() + 250; beep(100, .15); }
  $('health').textContent = String(Math.ceil(authoritative.health)); $('shield').textContent = String(Math.ceil(authoritative.shield));
  $<HTMLMeterElement>('healthbar').value = authoritative.health; $<HTMLMeterElement>('shieldbar').value = authoritative.shield;
  const other = data.players.find(p => p.id !== me);
  $('players').textContent = `${data.players.length} / 2 players · ${other ? 'Room full. Close extra tabs before inviting someone else.' : 'Friend slot open'}`;
  $('score').innerHTML = `${authoritative.kills} <span>:</span> ${other?.kills ?? 0}`;
  if (!local.health) notice(`ELIMINATED · RESPAWN IN ${Math.max(1, Math.ceil((local.respawnAt - data.tick) * DT))}`, .2);
  else if (!other && performance.now() > noticeUntil) notice('WAITING FOR YOUR FRIEND', .2);
}
function showTracer(origin: Vector3, end: Vector3) {
  if (Vector3.DistanceSquared(origin, end) < .0001) return;
  const tracer = MeshBuilder.CreateTube('tracer', { path: [origin, end], radius: .01, tessellation: 6 }, scene);
  tracer.material = tracerMaterial; setTimeout(() => tracer.dispose(), 120);
}
function gameEvent(e: Extract<GameEvent, { type: 'shot' }>) {
  if (e.shooter === me) shotsConfirmed++;
  if (e.shooter === me && e.hit) { hitUntil = performance.now() + 180; beep(e.killed ? 800 : 500, .09); if (e.killed) notice('ELIMINATION'); }
  if (e.hit === me) { damageUntil = performance.now() + 250; if (e.killed) notice('ELIMINATED'); }
  const shooter = snapshots.at(-1)?.data.players.find(p => p.id === e.shooter);
  if (shooter && e.shooter !== me) {
    showTracer(new Vector3(shooter.x, shooter.y + RULES.eye, shooter.z), Vector3.FromArray(e.end));
    beep(150, .08, .015);
  }
}
form.onsubmit = e => {
  e.preventDefault();
  const signalUrl = $<HTMLInputElement>('signal').value.trim();
  try { const parsed = new URL(signalUrl); if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.hash || parsed.username || parsed.password) throw new Error(); }
  catch { status.textContent = 'Enter a valid ws:// or wss:// signaling URL without a fragment or password.'; return; }
  if (location.protocol === 'https:' && !signalUrl.startsWith('wss://')) { status.textContent = 'HTTPS pages require a wss:// signaling URL.'; return; }
  const room = $<HTMLInputElement>('room').value.trim();
  if (!/^[a-zA-Z0-9_-]{16,64}$/.test(room)) { status.textContent = 'Paste the full room code from the host.'; return; }
  const link = new URL(location.href); link.hash = shortCode || new URLSearchParams({ room, signal: signalUrl }).toString();
  invite.value = link.href; $('invite-code').textContent = shortCode; $('invite-code').hidden = !shortCode; window.history.replaceState(null, '', link.href);
  form.querySelector('button')!.disabled = true; start.hidden = true; $('options').hidden = true; $('diagnostics').hidden = false;
  connectionStep('1 / 3 · Reaching the session…', 'Cannot reach the session. The host must keep the session running. Ask for a fresh invite or try another network.');
  connectionTimeout = setTimeout(() => { if (!connected) fail(timeoutReason); }, 25000);
  try { socket = new WebSocket(signalUrl); } catch { fail('The browser could not open the signaling connection. Try a fresh invite.'); return; }
  socket.onopen = () => {
    connectionStep('2 / 3 · Looking for the host…', 'The signaling service did not answer. Ask the host to restart the session.');
    socket!.send(JSON.stringify({ type: 'join', room }));
  };
  socket.onerror = () => fail('Cannot reach the session. The host must keep the session running. Ask for a fresh invite or try another network.');
  socket.onclose = e => fail(e.reason || 'Signaling disconnected. Ask the host to keep the session running, then reconnect.');
  socket.onmessage = async e => {
    try {
      const m = JSON.parse(e.data);
      if (ended) return;
      if (m.type === 'joined') connectionStep('Host found. Waiting for connection details…', 'The host did not send connection details. Ask the host to restart the session.');
      if (m.type === 'error') { fail(m.message || 'Connection setup failed.'); return; }
      if (m.type === 'config' && !pc) {
        if (m.relay) $<HTMLInputElement>('relay').checked = true;
        const relay = m.relay || $<HTMLInputElement>('relay').checked;
        if (relay && !m.iceServers.some((s: RTCIceServer) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some(url => /^turns?:/.test(url)))) {
          clearTimeout(connectionTimeout);
          socket!.onclose = null; socket!.onerror = null; socket!.onmessage = null; socket!.close();
          form.querySelector('button')!.disabled = false; start.hidden = false; $('options').hidden = false;
          status.textContent = 'This host has no TURN server. Uncheck Force TURN relay to play directly, or configure TURN on the host.';
          return;
        }
        connectionStep('3 / 3 · Opening the game connection…', 'The game connection timed out. Reconnect with Force TURN relay selected, or try another network.');
        pc = new RTCPeerConnection({ iceServers: m.iceServers, iceTransportPolicy: relay ? 'relay' : 'all' });
        pc.onicecandidate = e => { if (e.candidate && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'candidate', candidate: e.candidate })); };
        const networkChanged = () => {
          updateNetwork();
          if (pc?.iceConnectionState === 'failed' || pc?.connectionState === 'failed' || pc?.connectionState === 'closed') fail('The game connection failed. Reconnect with Force TURN relay selected, or try another network.');
        };
        pc.oniceconnectionstatechange = networkChanged; pc.onconnectionstatechange = networkChanged; pc.onicegatheringstatechange = updateNetwork;
        state = pc.createDataChannel('state', { ordered: false, maxRetransmits: 0 });
        events = pc.createDataChannel('events', { ordered: true });
        state.onopen = updateNetwork; events.onopen = updateNetwork;
        state.onmessage = e => receiveSnapshot(JSON.parse(e.data));
        events.onmessage = e => {
          const data = JSON.parse(e.data);
          if (data.type === 'welcome') {
            clearTimeout(connectionTimeout);
            me = data.id; local = { ...data.players.find((p: Player) => p.id === me) }; yaw = local.yaw;
            connected = true; menu.classList.add('compact'); lastTick = -1; viewTick = Math.max(0, data.tick - 6); receiveSnapshot(data);
            form.hidden = true; enter.hidden = false; $('back-menu').hidden = true; $('share').hidden = false; $('leave').hidden = false; phase = 'Connected'; updateNetwork();
            enter.textContent = 'Enter arena';
            status.textContent = watchWithoutMouse ? 'Connected. Touch controls are not available yet.' : 'Connected. Click the arena to capture your mouse.';
            if (createdRoom) {
              menu.classList.add('invite-prompt');
              $('share').querySelector('h2')!.textContent = 'Copy your invite before playing';
              status.textContent = 'Copy the link and send it to a friend, then enter the arena.';
            } else if (shortCode) { menu.hidden = true; openMenu.hidden = false; enter.textContent = watchWithoutMouse ? 'Resume view' : 'Resume game'; notice(watchWithoutMouse ? 'CONNECTED · WAITING FOR YOUR FRIEND' : 'CLICK TO PLAY · MENU TO INVITE A FRIEND', 4); }
          } else if (data.type === 'shot') gameEvent(data);
          else if (data.type === 'shot-rejected') {
            shotsRejected++;
            if (data.reason === 'late') notice('SHOT ARRIVED TOO LATE · HIGH LATENCY', 1);
          }
          else if (data.type === 'respawn' && data.player.id === me && data.player.life > local.life) {
            lastTick = Math.max(lastTick, data.tick - 1);
            local = { ...data.player }; history = []; correction.setAll(0); yaw = local.yaw; pitch = 0; notice('FINISH THE FIGHT');
          }
          else if (data.type === 'fall' && data.player === me) notice('FELL OUT OF THE ARENA');
          else if (data.type === 'pong') ping = Math.round(performance.now() - data.at);
        };
        events.onclose = () => fail('Connection ended.'); state.onclose = () => fail('Connection ended.');
        await pc.setLocalDescription(await pc.createOffer());
        socket!.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription }));
      } else if (m.type === 'answer' && pc && !pc.remoteDescription) {
        await pc.setRemoteDescription(m.sdp);
        for (const c of pendingCandidates) await pc.addIceCandidate(c); pendingCandidates = [];
      } else if (m.type === 'candidate') {
        if (pc?.remoteDescription) await pc.addIceCandidate(m.candidate); else pendingCandidates.push(m.candidate);
      }
    } catch (error) { fail(`Connection failed: ${error instanceof Error ? error.message : 'unknown error'}`); }
  };

};
function pauseMenu() {
  keys.clear(); menu.hidden = false; openMenu.hidden = true;
  menu.classList.add('paused'); menu.classList.remove('copy-fallback');
  enter.textContent = 'Resume'; $('leave').textContent = 'Quit'; $('copy-invite').textContent = 'Copy invite link';
  enter.focus();
}
openMenu.onclick = pauseMenu;
canvas.addEventListener('click', () => { if (connected && !watchWithoutMouse && document.pointerLockElement !== canvas) enter.click(); });
enter.onclick = async () => {
  menu.classList.remove('invite-prompt', 'paused', 'copy-fallback');
  $('share').querySelector('h2')!.textContent = 'Invite a friend';
  if (watchWithoutMouse) { menu.hidden = true; openMenu.hidden = false; return; }
  audio ??= new AudioContext(); await audio.resume();
  try { await canvas.requestPointerLock(); } catch { status.textContent = 'Click Enter arena again to capture the mouse.'; }
};
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas; menu.hidden = locked; if (locked) openMenu.hidden = true;
  if (!locked) { keys.clear(); if (connected) pauseMenu(); }
});
document.addEventListener('mousemove', e => {
  if (document.pointerLockElement !== canvas) return;
  yaw = ((yaw + e.movementX * .0025) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  pitch = Math.max(-1.45, Math.min(1.45, pitch + e.movementY * .0025));
});
document.addEventListener('keydown', e => { if (document.pointerLockElement === canvas) { keys.add(e.code); if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) e.preventDefault(); } });
document.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
document.addEventListener('mousedown', e => {
  const now = performance.now();
  if (e.button !== 0 || document.pointerLockElement !== canvas || !connected || !local.health || now - lastShot < RULES.fireTicks * DT * 1000 || events?.readyState !== 'open') return;
  if (events.bufferedAmount > 65536) { fail('Connection stalled. Reconnect to continue.'); return; }
  events.send(JSON.stringify({ type: 'shoot', seq: ++shotSeq, tick: lastTick, viewTick: Math.max(0, Math.min(lastTick, viewTick)), life: local.life, yaw, pitch }));
  shotsSent++;
  // Cosmetic feedback is local; damage and hit markers still require server confirmation.
  const ray = new Ray(camera.position.clone(), camera.getForwardRay().direction, 100);
  const hit = scene.pickWithRay(ray, mesh => mesh.isEnabled() && (mesh.name.startsWith('arena-') || mesh.name.startsWith('player-')));
  muzzle.computeWorldMatrix(true);
  showTracer(muzzle.getAbsolutePosition().clone(), hit?.pickedPoint ?? ray.origin.add(ray.direction.scale(100)));
  lastShot = now; flashUntil = now + 70; beep(220, .09, .06);
});
const bob = weaponBob();
let frame = performance.now(), accumulator = 0;
engine.runRenderLoop(() => {
  const now = performance.now(), elapsed = Math.min((now - frame) / 1000, .1);
  frames++; maxFrameMs = Math.max(maxFrameMs, now - frame); frame = now; accumulator += elapsed;
  while (accumulator >= DT) {
    let walked = 0;
    if (connected && state?.readyState === 'open') {
      const input: Input = { ...idle(), seq: ++seq, x: Number(keys.has('KeyD')) - Number(keys.has('KeyA')),
        z: Number(keys.has('KeyW')) - Number(keys.has('KeyS')), yaw, pitch, jump: keys.has('Space') };
      if (state.bufferedAmount < 16384) state.send(JSON.stringify(input));
      const beforeX = local.x, beforeZ = local.z;
      move(local, input, DT);
      if (local.grounded) walked += Math.hypot(local.x - beforeX, local.z - beforeZ);
      history.push(input); if (history.length > 120) history.shift();
    }
    updateWeaponBob(bob, walked, DT, connected && !!local.health && local.grounded && menu.hidden && !reducedMotion.matches);
    accumulator -= DT;
  }
  correction.scaleInPlace(Math.exp(-elapsed * 15));
  camera.position.set(local.x + correction.x, local.y + RULES.eye + correction.y, local.z + correction.z);
  camera.rotation.set(pitch, yaw, 0);
  const newest = snapshots.at(-1);
  if (newest) {
    const desired = newest.data.tick - 6 + Math.min(6, (now - newest.at) / 1000 / DT);
    // Advance steadily between snapshots instead of resetting the animation clock at each arrival.
    const previousView = viewTick;
    viewTick += elapsed / DT;
    viewTick += (desired - viewTick) * (1 - Math.exp(-elapsed * 4));
    viewTick = Math.max(snapshots[0].data.tick, newest.data.tick - 9, Math.min(newest.data.tick, Math.max(previousView, viewTick)));
    const target = viewTick;
    let left = snapshots[0], right = newest;
    for (const snap of snapshots) { if (snap.data.tick <= target) left = snap; else { right = snap; break; } }
    const t = Math.max(0, Math.min(1, (target - left.data.tick) / Math.max(1, right.data.tick - left.data.tick)));
    for (let slot = 0; slot < 2; slot++) {
      const b = right.data.players.find(p => p.slot === slot && p.id !== me);
      avatars[slot].setEnabled(!!b?.health);
      if (b) {
        const a = left.data.players.find(p => p.id === b.id && p.life === b.life) || b;
        avatars[slot].position.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t + RULES.height / 2, a.z + (b.z - a.z) * t);
      }
    }
  }
  gun.position.x = .3 + bob.x; gun.position.y = -.25 + bob.y;
  gun.position.z = .6 - (now < flashUntil ? .07 : 0); muzzle.setEnabled(now < flashUntil);
  $('hitmarker').style.opacity = now < hitUntil ? '1' : '0'; $('damage').style.opacity = now < damageUntil ? '.65' : '0';
  if (now > noticeUntil) $('notice').textContent = '';
  const inMenu = !menu.hidden && !menu.classList.contains('paused');
  if (inMenu) {
    if (!reducedMotion.matches) orbitAngle += elapsed * .055;
    // Keep the whole arena in frame, including on narrow phone screens.
    const distance = Math.max(38, 30 / engine.getAspectRatio(orbit));
    orbit.position.set(Math.cos(orbitAngle) * distance, distance * .85, Math.sin(orbitAngle) * distance);
    orbit.setTarget(new Vector3(0, 0, 0));
  }
  scene.clearColor.set(inMenu ? 1 : .055, inMenu ? 1 : .05, inMenu ? 1 : .055, 1);
  scene.activeCamera = inMenu ? orbit : camera;
  gun.setEnabled(!inMenu);
  scene.render();
});
// Connection health must not depend on animation frames.
setInterval(() => {
  const now = performance.now();
  if (connected && now - lastSnapshot > 5000) fail('Connection ended. No updates from the host.');
  if (connected && events?.readyState === 'open' && events.bufferedAmount < 16384) {
    events.send(JSON.stringify({ type: 'ping', at: now }));
    void pc?.getStats().then(stats => {
      route = 'UNKNOWN';
      stats.forEach(report => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
          const a = stats.get(report.localCandidateId), b = stats.get(report.remoteCandidateId);
          route = a?.candidateType === 'relay' || b?.candidateType === 'relay' ? 'TURN RELAY' : 'DIRECT';
        }
      });
      if (connected) $('connection').textContent = `${route} / ${ping} MS`;
    }).catch(() => {});
    if (now - metricsAt >= 5000) {
      events.send(JSON.stringify({ type: 'telemetry', rtt: ping, route, snapshotAge: now - lastSnapshot,
        maxSnapshotGap, correction: maxCorrection, pendingInputs: history.length, fps: frames * 1000 / (now - metricsAt),
        maxFrameMs, browserErrors, shotsSent, shotsConfirmed, shotsRejected, stateBuffered: state?.bufferedAmount ?? 0,
        eventsBuffered: events.bufferedAmount, viewLag: Math.max(0, lastTick - viewTick), paused: !menu.hidden, hidden: document.hidden }));
      metricsAt = now; frames = 0; maxFrameMs = 0; maxSnapshotGap = 0; maxCorrection = 0;
    }
  }
}, 1000);
window.addEventListener('resize', () => engine.resize());
window.addEventListener('beforeunload', () => { pc?.close(); socket?.close(); });
