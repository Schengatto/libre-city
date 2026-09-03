<h1 align="center">Libre City</h1>

<p align="center">
  <b>A GTA-style sandbox city that runs in a browser tab.</b><br>
  Explore on foot or by car, take jobs, outrun the police — or share the city with other players.
</p>

<p align="center">
  <a href="https://libre-city.schengatto.cloud/"><b>▶ Play now</b></a>
</p>

<p align="center">
  <img alt="JavaScript" src="https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black">
  <img alt="Canvas 2D" src="https://img.shields.io/badge/Canvas%202D-FF6F00?style=flat-square&logo=html5&logoColor=white">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=nodedotjs&logoColor=white">
  <img alt="WebSocket" src="https://img.shields.io/badge/WebSocket-010101?style=flat-square&logo=socketdotio&logoColor=white">
  <img alt="PWA" src="https://img.shields.io/badge/PWA-5A0FC8?style=flat-square&logo=pwa&logoColor=white">
</p>

---

## What it is

A top-down open-world arcade game, written in plain JavaScript and drawn on a 2D canvas. No engine,
no framework, no bundler — fourteen classic scripts and a `<canvas>`. The client has **zero
dependencies**; the multiplayer server has exactly one (`ws`).

The city is not stored anywhere. It is generated from the room code, so the same code always
produces the same city on every machine — which is why a multiplayer map never has to travel over
the wire.

Nothing to install: it is a PWA, so you can also add it to your home screen and play it like an app.

## The city

- **Drive anything you can get into** — cars, bikes, taxis, delivery scooters, ambulances, fire
  engines, patrol cars, army jeeps and tanks.
- **Jobs, if you want them.** Drive fares home in a taxi, deliver pizza while it is hot, rescue the
  injured with the ambulance, put fires out with the hose, chase fleeing thieves in a patrol car.
  Press <kbd>M</kbd> to switch jobs off and just cruise.
- **Simulated traffic and pedestrians**, traffic lights, a railway with running trains.
- **A police force that reacts.** Run someone over or start shooting and the stars come out:
  officers get out of their cars and open fire, and if they stop your vehicle you get *busted* and
  restart at the station.
- **A gun shop** (pistol, SMG, shotgun, grenades, flamethrower, rocket launcher) and a fenced
  **barracks** whose yard holds jeeps and tanks — guarded by soldiers who shoot on sight.
- **Two languages**, English and Italian, picked on first run.

Single-player matches let you choose a duration (5/10/15/30/60 minutes, or no limit), a map size,
and whether to enable weapons at all — there is a violence-free mode for a purely civilian city.

## Controls

Touch controls appear automatically on devices with a coarse pointer; on desktop you get keyboard
and mouse. Both schemes are always live, so a laptop with a touchscreen can use either.

### Desktop

| Input | Action |
| --- | --- |
| <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / arrow keys | Move on foot · accelerate, brake/reverse and steer while driving |
| Mouse | Aim |
| Left click *(hold)* | Punch or shoot · hold to keep firing automatic weapons and the fire hose |
| <kbd>E</kbd> | Enter / exit a vehicle (walk up to one to carjack it) |
| <kbd>Space</kbd> | Horn — or toggle the siren in a patrol car, ambulance or fire engine |
| <kbd>1</kbd>–<kbd>5</kbd> | Buy and equip weapons |
| <kbd>M</kbd> | Turn vehicle jobs on / off |
| <kbd>Shift</kbd>+<kbd>M</kbd> | Full-screen map |
| <kbd>Tab</kbd> | Match scoreboard (multiplayer) |
| <kbd>H</kbd> | Full in-game guide |
| <kbd>Esc</kbd> | Pause (or close the full-screen map) |

### Mobile

| Input | Action |
| --- | --- |
| **Left half of the screen** | Virtual stick — move on foot. While driving, point it where you want to go on screen and the vehicle lines itself up. |
| **Right half of the screen** | Aim stick — push it past half travel to fire (or to work the fire hose); a quick tap fires a single shot. |
| 🚗 | Enter / exit a vehicle *(= <kbd>E</kbd>)* |
| 📣 | Horn / siren *(= <kbd>Space</kbd>)* |
| 📋 | Jobs on / off *(= <kbd>M</kbd>)* |
| ⏸ | Pause |
| 🏆 | Match scoreboard |
| Weapon bar *(top of the screen)* | Buy and equip weapons |

Both sticks are placed where your thumb lands, not at a fixed spot on screen.

## Multiplayer

One city per room, hosted by an authoritative Node server. The world — traffic, pedestrians, police
— is simulated server-side at 60 Hz and broadcast to everyone; each client predicts its own player
locally so controls stay responsive regardless of ping. Remote players and world entities are
smoothed with snapshot interpolation.

**Rooms.** The host picks a match length (5, 10 or 15 minutes), a player cap (2–8, default 4) and a
map size, then shares the six-character room code. Its **first letter is the map size**, which is
how both sides can build the same city without exchanging it:

| Code starts with | Map | Size |
| --- | --- | --- |
| `P` | Small | 184 × 184 tiles |
| `M` | Medium | 184 × 368 tiles |
| `G` | Large | 368 × 368 tiles |

**Joining.** Sharing a link with `#room=CODE` drops a friend straight into the city. Joining an
existing room never waits — only *creating* one can queue, when all room slots are busy.

**Reconnection is automatic.** If your connection drops or you background the tab on a phone, you
have a 30-second grace period to come back with the same identity, score and car. The same applies
while waiting in the queue: losing the socket does not lose your place in line.

**Leaderboard.** Ranked on points per minute rather than raw score, so a long session is not
automatically a winning one. You need at least three minutes of play to qualify, and it is served
over `GET /leaderboard`.

## Running it locally

You need **Node.js 18 or newer**. Nothing else.

```bash
git clone https://github.com/Schengatto/libre-city.git
cd libre-city
```

### Single player

The game itself is just static files, so any HTTP server works:

```bash
npx serve .          # or: python -m http.server 5173
```

Then open the address it prints. Opening `index.html` straight off the disk (`file://`) also works
for a quick look, but you lose the service worker, the install prompt and the version check.

### With the multiplayer server

Install and start the server (it listens on **8787**):

```bash
cd server
npm install
npm start            # npm run dev for auto-restart on changes
```

Serve the game in a second terminal as above. On `localhost` the client points itself at
`ws://localhost:8787` automatically — no configuration needed. Check the server with:

```bash
curl http://localhost:8787/health
# {"ok":true,"rooms":0,"live":0,"max":20,"queue":0,"players":0}
```

To run everything on **one origin** instead, build first and let the server serve the result:

```bash
npm run build                              # from the repo root → dist/
STATIC_DIR=dist node server/index.js       # game + WebSocket on http://localhost:8787
```

## Building for production

```bash
npm run build                                          # → dist/
LC_SERVER=wss://your-server.example.com npm run build  # baked-in server address
```

`build.js` copies the sources into `dist/`, fingerprints every script (`js/ui.js` →
`js/ui.406921ff2f.js`) and rewrites the tags in `index.html`, then emits a service worker,
`version.json`, both web manifests, the icons and cache headers for Netlify/Cloudflare Pages
(`_headers`) and Apache (`.htaccess`). It does not minify, and it pulls in no build dependencies.

Deploy by uploading the **contents** of `dist/` to your site root. The multiplayer server address is
written into the page as `<meta name="lc-server">`; it can also be overridden at runtime with
`?server=wss://…` for testing.

## Server configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `STATIC_DIR` | *(unset)* | Serve the built game from this folder on the same origin |
| `MAX_ROOMS` | `20` | Simultaneous live rooms; beyond this, new rooms queue |
| `MAX_QUEUE` | `30` | Waiting-queue length |
| `LEADERBOARD_FILE` | `server/data/leaderboard.json` | Where the leaderboard is stored |
| `LEADERBOARD_QUALIFY_MS` | `180000` | Play time required to be ranked |
| `LEADERBOARD_MAX` | `500` | Entries kept before pruning |

Endpoints: `GET /health` and `GET /leaderboard?limit=N`.

The leaderboard is written atomically on a debounce and flushed on `SIGTERM`/`SIGINT`, so a redeploy
does not lose it. Point `LEADERBOARD_FILE` at a persistent volume in production.

## Project layout

```
index.html            markup, styles and menus for every screen
js/                   14 classic scripts, loaded in order (shared global scope)
  core.js             canvas, seeded RNG, room code
  city.js train.js    map generation, railway
  entities.js         vehicles, pedestrians, weapons
  gameplay.js         player, driving, police, combat
  missions.js army.js jobs, barracks
  render.js audio.js  drawing and sound
  input.js ui.js      controls, menus, game loop
  net.js              client networking
  i18n.js save.js     translations, saved games
  server-sim-glue.js  adapter that runs the sim headless
server/               authoritative multiplayer server (only dependency: ws)
build.js              production build → dist/
tools/gen-icons.js    icon generation
```

The server runs the *same* simulation code as the browser: `server/sim-runtime.js` concatenates nine
of those client scripts into a single `vm` context per room, with the render, audio, UI, input and
network layers stubbed out. Gameplay therefore cannot drift between client and server — but it does
mean **a new file used by the simulation must be added to `SIM_FILES`** in `server/sim-runtime.js`,
and that simulation code must never call into `render.js`, `audio.js`, `ui.js` or `input.js`.

## Tests

```bash
cd server
npm test
```

Covers the protocol, translations, traffic behaviour, the room queue, the leaderboard, and the
headless simulation and scoring. Two notes:

- `test-traffic.mjs` is **statistical, not deterministic** — the traffic AI uses `Math.random`, so
  each run gets a different world. Confirm an isolated failure by re-running before blaming a change.
- On **Windows**, the leaderboard's restart check cannot pass: the test stops the server with
  `SIGTERM`, which Windows does not deliver, so the shutdown flush never runs. It passes on
  Linux/macOS and in Docker.

## Deployment

`server/` ships a `Dockerfile`, a `docker-compose.yml`, an nginx reverse-proxy config and a
`fly.toml`.

One caveat: the image expects the simulation sources at `server/sim/`, staged from `js/` at deploy
time. That directory is gitignored and the script that populated it is not in the repository, so a
`docker build` from a fresh clone fails until you stage them yourself — copy the nine files listed
in `SIM_FILES` (`server/sim-runtime.js`) from `js/` into `server/sim/`. Running the server directly
from a clone needs none of this: it falls back to reading `js/` in place.

## Credits

Made by [Enrico Schintu](https://enricoschintu.com) · © 2026
