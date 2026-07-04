# Paint & Seek

A 2D hide-and-seek game where hiders paint their character to camouflage into
the walls, floor, and furniture around them. Up to 4 players per room, joined
by a 4-letter room code. Real-time sync runs over WebSockets, with the Node
server as the source of truth for room state, phase timers, and tag
validation.

## How it plays

1. One player creates a room and shares the 4-letter code.
2. Up to 3 more players join with that code (max 4 per room).
3. Host hits **Start**. A **15s hiding phase** begins — everyone spreads out
   and paints their character on a little 8x8 pixel canvas, using any mix of
   colors, to match the wall, rug, or furniture around them. **Sample & fill**
   grabs the dominant color under your feet, **Match pattern** auto-paints an
   approximation of the stripes/dots/checker/etc. at your spot, and you can
   always draw by hand for a pixel-perfect blend. There's no outline drawn
   around anyone but yourself (as a faint dashed ring only you can see) — a
   truly well-matched paint job is genuinely invisible to everyone else.
4. A **90s seeking phase** follows — movement and tagging are both live.
   Tap/click near another player's blob to tag them. Names are hidden for
   everyone but yourself during this phase, so it's genuinely about spotting
   camouflage, not reading labels.
5. Game ends when time runs out or only one un-tagged player remains.
   Results screen ranks everyone by how long they stayed hidden; host can
   start a new round in the same room.

## Project layout

```
server.js         Express + ws server, authoritative game/room state
public/index.html Game shell
public/style.css  Visual design (paint-studio theme)
public/game.js    Canvas rendering, input, WebSocket client
Dockerfile         Container build for Northflank (or any Docker host)
```

## Run locally

```bash
npm install
npm start
# open http://localhost:8080 in a few browser tabs/devices
```

## Deploy on Northflank

1. Push this project to a Git repo (GitHub/GitLab/Bitbucket) that Northflank
   can access, or use Northflank's "upload" build source if offered.
2. In Northflank: **Create new → Service → Deployment**, point it at the
   repo, and choose **Dockerfile** as the build method (the included
   `Dockerfile` needs no extra config).
3. Set the service's **public port** to `8080` (matches `EXPOSE 8080` /
   `ENV PORT=8080` in the Dockerfile) and enable **HTTP** with **public
   internet access** so the WebSocket upgrade on `/ws` works.
4. No environment variables or database are required — everything is
   in-memory per instance.
5. **Important:** keep this service at a single replica/instance. Rooms live
   in server memory, so if Northflank scales to multiple instances, players
   in the same room could land on different instances and never see each
   other. (A future improvement would be to back room state with Redis for
   horizontal scaling — not needed for a 4-player casual game.)
6. Once deployed, Northflank gives you a public HTTPS domain — the client
   auto-detects `https:` and upgrades to `wss://` for the socket connection,
   so no URL configuration is needed in the frontend.

## Notes / things you could extend

- Movement is client-reported and trusted; tag attempts are still checked
  server-side against last known positions so you can't tag from across the
  map, but there's no full anti-cheat — fine for a casual game with friends.
- If a socket drops mid-game there's no reconnect flow yet; the player would
  need to refresh and rejoin a new room. Worth adding if this becomes a
  regular hangout game.
- The 16-color palette used to paint the map is defined in both
  `server.js` and referenced by the client via the `palette` field sent on
  join, so they always match — no need to hand-edit two copies of a color
  list if you tweak the palette, just change it in `server.js`.
- The map is built from textured two-color patches (`stripes-h`, `stripes-d`,
  `dots`, `checker`, `grain`, `blotch`, `solid` — see `PATTERNS` in
  `server.js`) over a woodgrain base, so there's always more than a single
  flat color to try to match. Character paint is an 8x8 grid of pixels
  (`SKIN_SIZE` in `server.js`), sent to the server as `paint_skin` messages
  and validated there (64 entries, each a valid `#rrggbb`) before being
  relayed to everyone else in the room.
