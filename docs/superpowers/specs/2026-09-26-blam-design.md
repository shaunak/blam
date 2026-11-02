# Blam MVP design

Two friends play an FPS in browsers on different networks. A separate Node process on one laptop owns the simulation.
Babylon.js draws one box arena. Shared TypeScript code defines movement, collision, and combat.
A small WebSocket service serves the built client and forwards WebRTC setup messages. It never simulates gameplay.
The host and both browsers connect outward to that service. A random room link grants access to two players.
The host uses werift for WebRTC. Browser clients use native WebRTC.

Movement and snapshots use an unordered channel with zero retransmissions. Shots and combat events use a reliable ordered channel.
The server ticks at 60 Hz and sends snapshots at 20 Hz. Clients predict movement and replay unacknowledged inputs after corrections.
Remote players interpolate buffered snapshots. Missing inputs expire after 150 ms, so lost release packets cannot cause endless movement.
The server validates messages, caps queues, deduplicates shot sequences, and enforces cooldowns.
Shots older than 500 ms are rejected. Shots use current server positions, without historical rewind.
Each shot includes the current life number, so a delayed command cannot fire after respawn.

Players have 100 health, 50 shields, a 250 ms fire interval, and 30 damage per hit.
Shields recharge after three seconds. Players respawn automatically after two seconds.
These values live together for playtesting. No ammunition system is needed.

The host accepts STUN and TURN configuration through environment variables. Clients receive it through the room connection.
A relay-only mode forces TURN. The client shows the selected connection type.
A public HTTPS signaling endpoint and working TURN credentials are deployment requirements.
Local automated tests cannot establish the separate-network acceptance criterion.
