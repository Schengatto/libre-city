# MP Host-Player Sim with Host Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One player's browser simulates the room's city in a Web Worker; the Node server only relays, keeps the clock and elects/migrates the host.

**Architecture:** The existing headless sim bundle (`SIM_FILES` + `js/server-sim-glue.js`) runs unchanged inside a Web Worker behind a shared stub preamble. The worker owns a dedicated "hostlink" WebSocket: it receives forwarded inputs/roster, sends per-player snapshots `W|pid|json` and a periodic `hst` state. The server tracks `room.hostId`, re-elects on close/stall/resign, and falls back per room to the existing server sim (restored from `hst`) when no player can host.

**Tech Stack:** Node 22 + `ws`, browser classic scripts, Web Worker `importScripts`, `node:vm` for headless tests.

**Spec:** `docs/superpowers/specs/2026-11-23-mp-host-sim-design.md`

## Global Constraints

- English identifiers, NO code comments in new/changed code; never delete existing comments you do not touch.
- All `js/*.js` classic scripts share ONE global scope: every new top-level name must be unique across `js/` (grep before adding).
- `SIM_MODE` env: `host` (default) or `server` (current behaviour). Existing sim-dependent tests run with `SIM_MODE=server`.
- `HOST_STALL_MS = 2000`; `hst` every `500` ms; snapshots every 2 ticks (~30/s); sim 60 Hz fixed step, catch-up cap `MAX_CATCHUP_MS = 250`.
- Election: connected, `build` equal to the server's (`serverBuild()`; both null in dev), not resigned; prefer `dev === 'desktop'`, then lowest numeric id (`p3` → 3).
- Server never `JSON.parse`s `W` frames; drops `W`/`hst` from anything but the current hostlink; drops `W` for ids not in the room.
- Run only the test files a task touches, once at the end of the task (`cd server && node <file>`). No full suite.
- Commits: conventional, no Co-Authored-By, no attribution lines.

## Review Focus

1. Host tab hidden/backgrounded: the worker and its own socket keep ticking; no election as long as hostlink frames flow. → Task 4 test `stall election only when hostlink silent`.
2. Old host reconnects with its token after a migration: gets `ok` with `host` ≠ itself, never starts a worker, its late hostlink is refused. → Task 4 test `stale hostlink refused`.
3. Player joins while `hostId === null` (between election and hostlink): is in the `hoststart` roster once the new host links. → Task 4 test `join during migration lands in roster`.
4. Every player is on an old cached client after a deploy (build mismatch): room falls back to the server sim instead of dying. → Task 5 test `fallback when nobody eligible`.
5. Host is the last player and leaves: normal grace → room destroyed, no election loop. → Task 4 test `lone host leaving ends room`.

---

### Task 1: Shared sim stubs

**Files:**
- Create: `js/sim-stubs.js`
- Modify: `server/sim-runtime.js:35-77` (remove `makeBrowserStub` body, use the shared one)
- Test: `server/test-sim.mjs` (unchanged, must stay green), `server/test-sim-stubs.mjs` (new)

**Interfaces:**
- Produces: `js/sim-stubs.js` defines a single global `function makeSimStubs(roomCode, viewSize, timers)` returning the stub object (same keys as today's `makeBrowserStub`, `location.hash = '#room=' + roomCode`, `timers = { setTimeout, clearTimeout, setInterval, clearInterval }`). Ends with `if (typeof module !== 'undefined') module.exports = { makeSimStubs };`.

- [ ] **Step 1:** Write `server/test-sim-stubs.mjs`: `makeSimStubs('ABCD', 900, timers)` has `location.hash === '#room=ABCD'`, `innerWidth === 900`, `netActive() === false`, `typeof sfx.anything === 'function'`, and every key of the old stub list (copy the key list from `sim-runtime.js:52-74`) is present.
- [ ] **Step 2:** Run `node test-sim-stubs.mjs` → FAIL (module missing).
- [ ] **Step 3:** Move the stub into `js/sim-stubs.js`; `sim-runtime.js` requires it from `JS_DIR` and calls `makeSimStubs(code.toUpperCase(), view, { setTimeout, clearTimeout, setInterval, clearInterval })`. Add `'sim-stubs.js'` to the deploy copy in `.github/workflows/deploy.yml:75-77` next to `SIM_FILES`.
- [ ] **Step 4:** Run `node test-sim-stubs.mjs && node test-sim.mjs` → PASS.
- [ ] **Step 5:** Commit `refactor(sim): share the headless stubs between server and worker`.

### Task 2: Glue export/restore of player state

**Files:**
- Modify: `js/server-sim-glue.js` (`__sim` object, ~260-311)
- Test: `server/test-sim-restore.mjs` (new, add to `server/package.json` test script)

**Interfaces:**
- Produces on `__sim`:
  - `exportPlayers(): Array<{id,name,shirtIdx,x,y,hp,cash,k,d,s,stk,b,own,wp,wanted,wantedHeat}>` (`hp` = health, `k/d/s/stk/b` = kills/deaths/score/streak/bounty, `own` = owned array copy, `wp` = weaponIdx).
  - `restorePlayer(id, name, shirtIdx, state)`: like `addPlayer(name, shirtIdx, id)`, then applies every field of `state` that is present; vehicle not restored (on foot). Returns nothing.

- [ ] **Step 1:** Test: sim A, add `p1`, mutate via `_player('p1')` (x/y on a road node, health 40, cash 300, kills 2, deaths 1, score 250, streak 2, bounty 150, owned[2]=true, weaponIdx 2, wanted 3, wantedHeat 3.4); `exportPlayers()` round-trips into sim B via `restorePlayer`; `B.scores()` equals `A.scores()` for p1; `B.playerState('p1')` has same x/y/hp/cash/wanted; `B._player('p1').car === null`.
- [ ] **Step 2:** Run → FAIL (`exportPlayers is not a function`).
- [ ] **Step 3:** Implement both on `__sim`.
- [ ] **Step 4:** Run `node test-sim-restore.mjs && node test-sim.mjs` → PASS.
- [ ] **Step 5:** Commit `feat(sim): export and restore player state`.

### Task 3: Sim worker + build step

**Files:**
- Create: `js/sim-worker.js`
- Modify: `build.js` (new step after the script hashing, ~:68-91), `index.html` (add `<meta name="lc-sim-worker" content="js/sim-worker.js">`)
- Test: `server/test-sim-worker.mjs` (new, in test script)

**Interfaces:**
- Consumes: `makeSimStubs` (Task 1), `__sim.exportPlayers/restorePlayer/scores/snapshotFor/applyInput/addPlayer/removePlayer/tick/clearFx` (Task 2).
- Produces: worker protocol.
  - Main → worker: `{type:'start', url, code, token, hostId}`, `{type:'input', input}` (host's own `i` payload), `{type:'stop'}`.
  - Worker → main: `{type:'snapshot', snapshot}` (host's own `w` object, with `sc`), `{type:'error', message}`, `{type:'ready'}`.
  - Worker ↔ server over its own WebSocket (hostlink): sends `{t:'hostlink', code, token}` on open; receives `{t:'hoststart', roster:[{id,name,shirtIdx}], state:[exportPlayers rows]}`, `{t:'i', id, ...}`, `{t:'join', id, name, shirtIdx}`, `{t:'leave', id}`; sends `'W|' + pid + '|' + JSON.stringify(snap)` per non-host player every 2 ticks, and `{t:'hst', players: exportPlayers(), scores: scores()}` every 500 ms.
  - Dev load: `importScripts('sim-stubs.js')`, then copy each stub key onto `self` only when `!(key in self)`, so the worker's native `location`, `navigator`, `console` and timers stay untouched; then `importScripts(...SIM_FILES)`.
  - Built load: one bundle `sim-worker.<hash>.js` with stubs + sim files + worker body, no `importScripts`.
  - Room code: the worker is started with URL `<worker>#room=CODE`; the sim reads it through the native `self.location.hash`.
  - Sim files load only on the `start` message, so a load failure is caught and posted as `{type:'error', message}`.
  - Game loop: `setInterval(16)` with fixed-step accumulator (`accumulateSimTime` logic duplicated as a local function with the 250 ms cap).
  - On `hoststart`: for each roster entry, `restorePlayer` when a `state` row with that id exists, else `addPlayer`.
  - `build.js`: concatenate `js/sim-stubs.js` + `SIM_FILES` (same order as `server/sim-runtime.js`) + `js/sim-worker.js` minus its `importScripts` line into `dist/js/sim-worker.<sha256-10>.js`, rewrite the `lc-sim-worker` meta content, add it to the sw.js precache list.

- [ ] **Step 1:** Test: load `js/sim-worker.js` in a `vm` context emulating a worker (`self` = context, `location.hash='#room=TEST'`, `importScripts` reads from `js/`, `postMessage` captured, `WebSocket` = fake class recording `send` and exposing `onmessage`). Post `start`; fake socket open → assert first send is `hostlink`; deliver `hoststart` with roster `p1`(host), `p2` and a `state` row for `p2` with score 250; advance timers ~200 ms → assert a `postMessage({type:'snapshot'})` for p1, at least one `W|p2|` frame whose JSON has `t === 'w'` and `me`, and after 500 ms an `hst` whose `scores` has p2 with `s === 250`. Deliver `{t:'i', id:'p2', ax:1}` and assert p2 moved in the next `hst`.
- [ ] **Step 2:** Run `node test-sim-worker.mjs` → FAIL.
- [ ] **Step 3:** Implement `js/sim-worker.js` and the `build.js` step.
- [ ] **Step 4:** Run `node test-sim-worker.mjs` → PASS; run `node build.js` and assert `dist/js/sim-worker.*.js` exists, contains no `importScripts(`, and `dist/index.html` meta points at it.
- [ ] **Step 5:** Commit `feat(mp): run the room sim in a host Web Worker`.

### Task 4: Server host mode — election, hostlink, relay

**Files:**
- Modify: `server/index.js` (constants ~:45-80, `addPlayer` ~:390-408, `createRoom` ~:444-461, `handleJoin` token branch ~:469-484, `onGameMessage` ~:497-521, `onDisconnect` ~:526-543, `ws.on('message')` ~:630-645)
- Modify: `server/test-server-sim.mjs`, `server/test-leaderboard.mjs`, `server/test-queue.mjs` (spawn with `SIM_MODE=server`)
- Test: `server/test-host-mode.mjs` (new, in test script)

**Interfaces:**
- Consumes: hostlink protocol from Task 3.
- Produces:
  - `SIM_MODE` (env, default `'host'`), `HOST_STALL_MS = 2000`.
  - Room fields: `hostId`, `hostLink` (ws|null), `hostLastFrameAt`, `hostState` (last `hst` body), `resigned` (Set of ids).
  - `electHost(room, excludeId)`: picks per Global Constraints, sets `hostId`, closes old `hostLink`, broadcasts `{t:'host', id, name}`; with no candidate sets `hostId = null` and calls `fallbackToServerSim(room)` (Task 5; until then a no-op).
  - Hello (`create`/`join`) carries `dev: 'desktop'|'touch'` and `build`; stored on the player.
  - `ok` gets `host: room.hostId` in host mode; `sim: true` in both modes.
  - Messages: `hostlink` (bind by token, only if that player is `hostId`, else close socket; on bind send `hoststart` with roster of all room players incl. those in grace and `state: room.hostState?.players || []`); raw text frames starting `W|` from the hostlink → forward the JSON slice to that pid's ws; `hst` from hostlink → `room.hostState`; `i` from a non-host player → `hostLink.send({...m, id})`; `resign` → add to `resigned`, `electHost(room, p.id)`; `join`/`leave` also sent to `hostLink`.
  - Stall check: an interval (500 ms) per room in host mode: if `hostLink` silent for `HOST_STALL_MS` and another candidate exists → `electHost(room, hostId)`.
  - Host socket close (main or hostlink) → immediate `electHost(room, hostId)` if another candidate exists, else wait for its token resume.
  - `end`/`finishRoom`: also close `hostLink`.

- [ ] **Step 1:** Write `test-host-mode.mjs` (spawn server with `SIM_MODE=host`, fake WS clients; hostlink played by a third raw socket). Cases:
  - `creator is host`: `ok.host === ok.id`, `ok.sim === true`.
  - `input forwarded to host with id`: B sends `i` → hostlink receives `{t:'i', id: B}`.
  - `W frame routed to target only`: hostlink sends `W|<B>|{"t":"w","x":1}` → B receives parsed `{t:'w',x:1}`, A receives nothing; `W|p99|...` dropped.
  - `election on host close carries state`: hostlink sends `hst` with p1 score 250, host A closes → B gets `{t:'host', id:B}`; B's hostlink gets `hoststart` whose `state` has p1 score 250 and roster includes A (in grace).
  - `stall election only when hostlink silent`: hostlink keeps sending `hst` every 400 ms for 3 s → no `host` message; then silence → `host` within 2.6 s.
  - `desktop preferred`: A(touch) host, B(touch), C(desktop); A closes → C elected.
  - `stale hostlink refused`: after migration A resumes by token → `ok.host === B`; A's `hostlink` is closed by server and its `W` frames are not forwarded.
  - `join during migration lands in roster`: host closes with no other connected player (B in grace) → D joins → D elected (`host`), D's `hoststart` roster contains A, B, D.
  - `lone host leaving ends room`: single host closes; after grace the room is gone (`join` → `no notfound`).
  - Use `GRACE_MS`-independent waits: add env `GRACE_MS` override if not present (`Number(process.env.GRACE_MS) || 30_000`), set 1500 in the test.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; set `SIM_MODE=server` in the env of the three existing tests' server spawn.
- [ ] **Step 4:** Run `node test-host-mode.mjs && node test-server-sim.mjs && node test-leaderboard.mjs && node test-queue.mjs` → PASS.
- [ ] **Step 5:** Commit `feat(server): host-player mode with election and migration`.

### Task 5: Server — scores from host and per-room fallback

**Files:**
- Modify: `server/index.js` (`scoreOf`/`recordAll` ~:164-183, `startSim` ~:349-384, new `fallbackToServerSim`)
- Test: `server/test-host-mode.mjs` (extend)

**Interfaces:**
- Consumes: `electHost`, `room.hostState` (Task 4); `restorePlayer` (Task 2).
- Produces: `scoreOf` reads `room.sim ? room.sim.scores() : room.hostState?.scores || room.finalScores`; `recordAll` snapshots the same source. `fallbackToServerSim(room)`: if `createRoomSim` and not `room.sim`: `startSim(room)` with players added through `restorePlayer` from `room.hostState.players` (fresh `addPlayer` for the rest), broadcast `{t:'host', id:null}`; `i` then goes to `room.sim.applyInput` exactly as server mode.

- [ ] **Step 1:** Extend tests:
  - `leaderboard from hst`: short match (minutes 0.05) in host mode, hostlink sends `hst` scores p1 s=300 → after `end`, `/leaderboard` (or the store the existing leaderboard test reads) has the player with score 300.
  - `fallback when nobody eligible`: A and B connect with `build:'old'` against a server whose build is set (env `LC_BUILD` or the same mechanism `serverBuild()` uses; check it) → `ok.host === null`, then both receive `w` snapshots from the server sim; with a prior `hst` (made by letting A host first with matching build, then A resigns while B has `build:'old'`) the fallback sim's `me.sco` for A equals the `hst` score.
  - `resign elects another`: host sends `resign` → B gets `host`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `node test-host-mode.mjs && node test-leaderboard.mjs` → PASS.
- [ ] **Step 5:** Commit `feat(server): host scores and server-sim fallback per room`.

### Task 6: Client host role

**Files:**
- Create: `js/sim-host.js` (add `<script src="js/sim-host.js">` in `index.html` right after `net.js`)
- Modify: `js/net.js` (`netStartHost`/`netJoin` hellos ~:86-108, `netOnJoined` ~:196-217, `onServerMessage` ~:237-256, `netSendInput` ~:749-772, `netShutdown` ~:259-272), `js/i18n.js` (new key `net.newHost` in every language block, e.g. it `Nuovo host: {name}`, en `New host: {name}`)
- Test: `server/test-i18n.mjs` (must stay green), manual two-tab browser check

**Interfaces:**
- Consumes: worker protocol (Task 3), `ok.host`, `{t:'host', id, name}` (Task 4/5).
- Produces (globals, names unique in `js/`): `simHostStart()`, `simHostStop()`, `simHostSendInput(payload)`, `simHostActive(): boolean`.
  - Hellos add `dev: usingTouch ? 'touch' : 'desktop'` and `build: window.LC_BUILD || null`.
  - `netOnJoined`: `net.hostId = m.host ?? null`; start host when `m.host === net.myId`, else stop.
  - `case 'host'`: same start/stop rule; toast `t('net.newHost', {name})` when `id` is not null and not me.
  - `netSendInput`: when `simHostActive()`, `simHostSendInput(msg)` instead of the socket.
  - Worker `snapshot` → `netOnSnapshot(snapshot)`; worker `error` → `netSend({t:'resign'})` + `simHostStop()`.
  - Worker URL: `document.querySelector('meta[name="lc-sim-worker"]').content + '#room=' + ROOM_CODE`.
  - `end` and `netShutdown` → `simHostStop()`.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Run `node test-i18n.mjs` → PASS.
- [ ] **Step 3:** Browser check via the `browser` agent: `npm run server` (SIM_MODE default host) + static server; tab A creates a 2-minute room, tab B joins; verify B sees traffic moving and A's ghost; close tab A → B shows the new-host toast and the world keeps moving within ~3 s with B's score unchanged. Screenshots into `.tmp/`.
- [ ] **Step 4:** Commit `feat(mp): a player hosts the room sim in a worker`.

### Task 7: Bandwidth check and docs

**Files:**
- Modify: `MULTIPLAYER.md` (new "Fase 3 — Host giocatore" section: roles, election rules, `SIM_MODE`, fallback)
- Create: `.tmp/host-bandwidth.mjs` (scratch, untracked)

- [ ] **Step 1:** Scratch script: run the worker in the Task 3 harness with 4 players for 10 s, sum `W` frame bytes after `zlib.deflateRawSync` level 3 per frame → print KB/s.
- [ ] **Step 2:** If > 300 KB/s, record the number in the PR and open a follow-up task (no throttling in this plan); otherwise record the number in `MULTIPLAYER.md`.
- [ ] **Step 3:** Commit `docs(mp): document host-player mode`.
