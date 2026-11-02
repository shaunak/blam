## Play across networks

Open https://blam-seven.vercel.app/ and select **Start Game**.
The game creates a room and prompts you to copy the invite.
Select **Copy invite link**, send it to a friend, then select **Enter arena**.
Open **Menu** or press Escape, then select **Copy invite link**.
Invites look like `https://blam-seven.vercel.app/#quiet-river-fox`.
Your friend opens the link and selects **Join Game**.

Each browser tab occupies one player slot. Select **Leave room** to free the slot.
Phones can watch the arena. Movement and aiming require a desktop mouse and keyboard.

The host laptop must run the server:

```sh
npm run play
```

Use Node 22. Install `cloudflared` with `brew install cloudflared` on macOS.
Keep the Cloudflare TURN credentials in `.env`.
Before the first launch, pull the private Vercel environment:

```sh
vercel env pull .env.vercel --environment production
chmod 600 .env.vercel
```

Keep the terminal open and the laptop awake. Ctrl+C ends its rooms.
The process publishes its current tunnel address in a private Vercel Blob.
The Vercel function uses that record to create and find rooms on the laptop.
It never sends the gateway key or TURN API token to browsers.
Gameplay remains WebRTC. Public rooms use TURN by default when configured.

This MVP registers one laptop at a time. It supports up to eight rooms with two players each.
An empty room expires after one minute. Old invites then show an expiry message.
Restarting the process ends its rooms. Start a new game to get a new invite.

Connection fields remain under **Options** for development. Existing full invite links still work while their host runs.

Deploy client and gateway changes with `vercel --prod`.
Test the menu locally with `npm run test:menu` or against Vercel:

```sh
TEST_CLIENT_URL=https://blam-seven.vercel.app npm run test:menu
```

# BLAM

A two-player browser FPS. Babylon.js draws a greybox arena. A separate Node process owns movement, hits, shields, health, deaths, and respawns.

## Play locally

Use Node 22 and desktop Chrome. If you use nvm, run `nvm use` in this directory.

Install dependencies and build the client:

```sh
npm ci
npm run build
```

In terminal one, start the signaling service:

```sh
npm run signal
```

In terminal two, start the game server:

```sh
npm run host
```

Open the printed room link in two browser windows. Click Join room, then Enter arena in each window.

Use WASD to move and the mouse to aim. Tap Space for a short hop, or hold it for a higher jump.
Release Space before the next jump. Click to fire. Press Escape to release the mouse.
The match continues while the mouse is released. Players respawn automatically after two seconds.

Keep the server terminal open. Closing either browser removes that player. Closing the server ends the match.
A player can reopen the room link to reconnect. Reconnection starts a new score.

## Development logs

Start the host with logging enabled:

```sh
npm run host:dev
```

The host prints one JSON record per connection or combat event, prefixed with `[blam]`.
A `kill` record identifies the shooter, victim, shot number, and server tick.
The host logs confirmed results, so a duplicate shot cannot produce a second kill record.
Logs also include joins, departures, hits, misses, falls, respawns, and connection failures.
Normal `npm run host` leaves these logs off. `BLAM_DEBUG=1 npm run host` also enables them.
Logs go to the host terminal. They do not contain TURN credentials or room links.
The separate startup message still prints the private room link for joining.

## Play across different networks

The default localhost link works only on the host laptop. Internet play requires a public signaling endpoint and TURN credentials.
STUN discovers reachable addresses. TURN relays encrypted game packets when a direct connection fails.

The public machine runs signaling and serves the browser files. The game server remains on Laptop 1.
Both browser clients connect to the game server through WebRTC.

### Public signaling

Copy this project to a public machine with Node 22. Point a domain at that machine.
Replace `play.example.com` below with that domain. Allow inbound TCP ports 80 and 443.

On the public machine, install dependencies, build the client, and start signaling:

```sh
npm ci
npm run build
npm run signal
```

Install Caddy on that machine. Add this site to its Caddyfile:

```caddyfile
play.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Start Caddy with that file. Caddy provides HTTPS and forwards WebSocket traffic.
See the [Caddy proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) and [HTTPS documentation](https://caddyserver.com/docs/automatic-https).

### Cloudflare TURN

The laptop host automatically reads `.env` at startup. Store these values in that file:

```dotenv
CF_TURN_KEY_ID=your-turn-token-id
CF_TURN_API_TOKEN=your-turn-api-token
```

Restrict access to the file, then start the host:

```sh
chmod 600 .env
npm run host:dev
```

The file is ignored by Git. The host validates the key at startup and generates fresh temporary credentials for each joining player.
Only temporary credentials reach browsers. Cloudflare configuration takes priority over the static `TURN_URL` configuration below.

Credentials last 24 hours. Rejoin the room to obtain fresh credentials for a longer session.
No Cloudflare account token belongs in browser code or a `VITE_` environment variable.
The API follows [Cloudflare credential generation](https://developers.cloudflare.com/realtime/turn/generate-credentials/).

To test actual Cloudflare relay traffic, run:

```sh
npm run build
npm run test:cloudflare
```

This test requires `.env` credentials and desktop Chrome. It forces both browsers and the host to use TURN.
It tests movement, combat, death, respawn, normal input bursts, and server shutdown.
It also makes sure that neither the long-lived token nor its key ID reaches browser signaling messages.

TURN does not publish the local signaling service. Use `npm run play` for the Vercel invite and temporary signaling tunnel.

### Other TURN services

Use credentials from a TURN provider, or run coturn on a public machine.
A provider must supply a TURN URL, username, and password.

For coturn, start from [deploy/turnserver.conf.example](deploy/turnserver.conf.example).
Replace the public IP, realm, username, and password. Allow TCP/UDP 3478 and UDP 49160–49200 through the firewall.
If the machine uses NAT, set its public/private mapping in `external-ip`.
These ports and mappings follow the [coturn server documentation](https://github.com/coturn/coturn/wiki/turnserver).

The example supports UDP and TCP. If a network blocks both, use a provider with TURN over TLS on port 443.
For that provider, use its `turns:hostname:443?transport=tcp` URL. The local tests cover UDP and TCP, not TLS.

### Start Laptop 1

Set the service addresses and TURN credentials in the host terminal:

```sh
export SIGNAL_URL='wss://play.example.com/signal'
export TURN_URL='turn:turn.example.com:3478?transport=udp'
export TURN_USERNAME='your-username'
export TURN_PASSWORD='your-password'
npm run host
```

Open the printed link on both laptops. Only Laptop 1 runs `npm run host`.
No inbound port forwarding is required on either laptop when TURN is reachable.

The link grants access to the room. Share it only with your friend.
The two-player limit includes connections that are still starting. Reload after a failed connection.
TURN credentials reach room participants. Use temporary credentials for a shared deployment.

### Force the relay

Leave the checkbox off for ordinary play. WebRTC can still use configured TURN servers as a fallback.
The checkbox requires a relay connection for testing. It does not create a TURN server.
If the host has no TURN server, the form explains this and lets you uncheck the box without reloading.

Stop the host, then restart it with the same environment variables and this flag:

```sh
FORCE_RELAY=1 npm run host
```

Open the new room link on both laptops. Make sure that both status labels show `TURN RELAY`.
Move, jump, trade kills, and respawn. Both scores must agree.
Repeat with the laptops on different networks, such as home Wi-Fi and a phone hotspot.

## Tests

Run the simulation tests and build:

```sh
npm test
npm run build
```

With desktop Chrome installed, run the two-browser test:

```sh
npm run test:browser
npm run test:connection
```

The test starts its own signaling service and host on an available local port.
It tests actual WebRTC channels, keyboard movement, gunfire, damage, death, respawn, room departure, and server shutdown.
It saves screenshots in `artifacts/`.

For a local TURN test, start Docker and run:

```sh
docker run -d --rm --name blam-turn-test \
  -p 127.0.0.1:3479:3478/udp -p 127.0.0.1:3479:3478/tcp \
  -p 127.0.0.1:49200-49220:49200-49220/udp \
  coturn/coturn:4.7.0 \
  --no-cli --no-tls --no-dtls --fingerprint --lt-cred-mech \
  --realm=blam.local --user=blam:local-test-password \
  --external-ip=127.0.0.1 --min-port=49200 --max-port=49220 \
  --allow-loopback-peers --no-multicast-peers --log-file=stdout
TEST_RELAY=1 npm run test:browser
npm run test:connection
TEST_RELAY=1 TEST_TURN_TRANSPORT=tcp npm run test:browser
npm run test:connection
docker stop blam-turn-test
```

Keep this test container bound to localhost. Its loopback permission and fixed password are for local tests only.

## Small implementation, explicit limits

- The server advances at 60 Hz and sends world snapshots at 20 Hz. Movement messages use unordered delivery with zero retransmissions.
- Shots, hit results, deaths, and respawns use a reliable ordered channel. Duplicate shot IDs cannot apply damage twice.
- The server rejects shots from an old life, from the future, or more than 500 ms behind its clock.
- Hit tests use current server positions. There is no historical rewind, so high latency makes moving targets harder to hit.
- Clients predict movement with the shared collision code. They apply server corrections and interpolate the other player between snapshots.
- Input expires after 150 ms without an update. Lost release packets cannot cause endless movement.
- One semiautomatic rifle deals 30 damage, with a 250 ms minimum interval. Players have 50 shields and 100 health.
- Shields recharge at 20 points per second after three seconds without damage. Health stays depleted until respawn.
- Players collide with arena geometry. They can pass through each other. There are no accounts, ammunition rules, bots, or extra modes.

Tune movement and combat in `src/game.ts`. The arena boxes also live there, so rendering and server collision use the same geometry.

## Acceptance status

Local direct, local coturn, and public Cloudflare TURN browser tests pass. The automated test uses two browsers on one machine.
Two people on separate networks still need to test the deployed services and judge whether the movement and combat feel good.
The browser client is deployed on Vercel. Public signaling through a temporary tunnel and forced Cloudflare TURN pass the browser tests.

## Saved diagnostics

`npm run play` and `npm run host` save diagnostics in `logs/` on the host laptop.
Browsers send a small report over their existing WebRTC connection every five seconds.
The host records shot results, rejection reasons, latency, frame timing, movement corrections, and connection changes.
A session ID and player ID link these records together.
The logger excludes TURN credentials, signaling addresses, and arbitrary browser text.

Ten rotating JSONL files share a 1 GB limit. The oldest file is removed when the limit is reached.
`game-0.jsonl` is the current file. Set `BLAM_LOG_DIR` to change the directory.
The logger drops reports if its pending writes exceed 1 MB. A disk error stops logging without stopping the game.
TURN relays the reports to the laptop. Vercel does not store them.

```sh
tail -f logs/game-0.jsonl
```

Shots show immediate local effects. The server confirms hits and rewinds target positions by at most 500 ms.
Older commands are rejected and logged as `late`. Pausing does not pause the match.

Test both shooting directions with 100 ms of delay in each direction:

```sh
TEST_LATENCY=1 npm run test:browser
```
