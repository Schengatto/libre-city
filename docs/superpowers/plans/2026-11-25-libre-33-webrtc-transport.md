# LIBRE-33 WebRTC DataChannel Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guest snapshots and inputs travel host↔guest over a WebRTC DataChannel, so VPS stalls (1-2.4 s, LIBRE-37/38) leave the hot path; the VPS relays signaling and stays the fallback.

**Architecture:** The guest opens one `RTCPeerConnection` to the current host, signaled through the existing room WebSocket (`{t:'rtc'}` relayed by the server only between host and guest). Two pre-negotiated channels: `fast` (unordered, `maxRetransmits:0`) for snapshots and plain inputs, `rel` (ordered, reliable) for one-shot world events and edge inputs. Peer connections live on the host page (`RTCPeerConnection` does not exist in Workers); the sim worker routes each guest's frame to the page (P2P) or to the hostlink WS (fallback) per guest.

**Tech Stack:** Browser WebRTC API (no dependency), Node `ws` server, plain-script globals, Node `vm` test harnesses with `ok()` counters.

**Spec:** board task LIBRE-33 (description + DoD), epic LIBRE-28.

## Global Constraints

- No code comments (user rule); English identifiers; descriptive names.
- All `js/*.js` files share one global scope: every new top-level name in `js/rtc.js` starts with `rtc`/`RTC_`.
- STUN only, no TURN: `RTC_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }]`.
- Kill switch: `?rtc=off` query param disables P2P on that client (forces WS, also used for before/after measurement).
- Channels: `fast` = `{ negotiated: true, id: 0, ordered: false, maxRetransmits: 0 }`, `rel` = `{ negotiated: true, id: 1, ordered: true }`.
- A channel is usable only when `channel.readyState === 'open' && pc.connectionState === 'connected'`.
- Retry after failure: `rtcRetryDelay(attempt) = min(5000 * 2 ** attempt, 60000)` ms; connect attempt times out after `RTC_CONNECT_TIMEOUT_MS = 10000`.
- Host skips a `fast` send when `bufferedAmount > RTC_MAX_BUFFERED_BYTES = 262144`; host drops guest DataChannel messages longer than `RTC_MAX_INPUT_BYTES = 2048`.
- Tests run once at the end of each task, only the files the task touches (user rule). Full suite runs only in CI on the PR.
- New test file must be appended to the `test` script in `server/package.json`.

## Review Focus

1. **Client restart with a resumed token:** a reloaded page restarts `net.inSeq` at 1 while the sim keeps the old `input.seq`; the stale-input rule must not freeze the player (window of 64, Task 2 test).
2. **Host migration mid-P2P:** guest must tear down the old peer, renegotiate with the new host and accept the new host's lower ticks (`lastSnapTick` reset on `host`; Task 4 test).
3. **NAT failure:** connect never reaches `connected` → guest stays on WS, retries with backoff, overlay shows `WS` (Task 3 test with a fake PC that never connects).
4. **Spoofed signaling:** guest sending `rtc` to another guest, or with a bogus `k`/oversized `d`, must be dropped server-side (Task 1 test).
5. **Channel closing while events are in flight:** worker must stop routing to P2P as soon as the page reports `open:false`; events posted in that window go out on WS next frame only if the worker has not spliced them yet — accepted race, documented in MULTIPLAYER.md (Task 4).

---

### Task 1: Server signaling relay

**Files:**
- Modify: `server/index.js` — `onGameMessage` (`:710-740`), new `relayRtcSignal(room, sender, m)` next to `forwardInputToHost` (`:581`)
- Test: `server/test-host-mode.mjs`

**Interfaces:**
- Produces (wire): guest/host sends `{ t: 'rtc', to: '<playerId>', k: 'offer'|'answer'|'ice', d }`; the target receives `{ t: 'rtc', from: '<senderId>', k, d }` on its room WS.
- Relay rules: `hostModeActive(room)` and `room.hostId` set; exactly one of sender/target is `room.hostId`; target exists, not `gone`, WS open; `k` in the set; `d` is a string ≤ 16384 chars (offer/answer SDP) or a plain object whose `JSON.stringify` ≤ 2048 chars (ICE). Anything else is dropped silently.

- [ ] **Step 1: Tests** in `test-host-mode.mjs` (reuse `enter`, `openHostLink`, `findType`, `waitFor`): host-mode room with host A and guests B, C.
  - `B → {t:'rtc', to:A.id, k:'offer', d:'v=0...'}` → A receives `{t:'rtc', from:B.id, k:'offer', d:'v=0...'}`.
  - `A → {t:'rtc', to:B.id, k:'ice', d:{candidate:'c', sdpMid:'0'}}` → B receives it with `from:A.id`.
  - `B → to:C.id` → C receives nothing within 300 ms.
  - `B → k:'bogus'`, `B → d:'x'.repeat(16385)` → A receives nothing.
  - Existing check "no election while the hostlink keeps sending hst" (`:263`) is the heartbeat DoD proof: keep it green, do not duplicate.
- [ ] **Step 2: Run** `cd server && node test-host-mode.mjs` → new checks FAIL.
- [ ] **Step 3: Implement** `case 'rtc': relayRtcSignal(room, p, m); break;` plus `relayRtcSignal` with `RTC_SIGNAL_KINDS = new Set(['offer','answer','ice'])`, `MAX_RTC_SDP_CHARS = 16384`, `MAX_RTC_ICE_CHARS = 2048`.
- [ ] **Step 4: Run** `cd server && node test-host-mode.mjs` → all OK.
- [ ] **Step 5: Commit** `feat(net): relay WebRTC signaling between host and guest`.

### Task 2: Sim side — stale inputs, worker P2P routing, host page bridge

**Files:**
- Modify: `js/server-sim-glue.js:285-305` (`applyInput`)
- Modify: `js/sim-worker.js` (`sendSnapshots` `:67-77`, `self.onmessage` `:176-182`, `stopRoom` clears the P2P set)
- Modify: `js/sim-host.js` (worker `onmessage` `:29-35`, new exports)
- Test: `server/test-sim.mjs`, `server/test-sim-worker.mjs`, `server/test-sim-host.mjs`

**Interfaces:**
- Produces (glue): `applyInput` treats `cmd` as stale when `cmd.seq != null && i.seq != null && cmd.seq <= i.seq && i.seq - cmd.seq < STALE_INPUT_WINDOW` (`STALE_INPUT_WINDOW = 64`). Stale → apply only edge bits (`b & 2/4/8` → `fireEdge/enterExit/horn`), `w`, `vr`; skip `ax, ay, aim, seq, fireHeld, drive, lg, px/py/cx…`.
- Produces (page → worker): `{ type: 'p2p', id, open: boolean }`, `{ type: 'guestInput', id, input }` (worker calls `sim.applyInput(id, input)` only if `memberIds.has(id) && id !== hostId`).
- Produces (worker → page): for guests in the P2P set, `{ type: 'guestFrame', id, snapshot: string, events: string|null }` instead of `'W|'+id+'|'+json`. `events` = `JSON.stringify({ t: 'we', tick, ev, fx })` when `snapshot.me.ev` is non-null or `snapshot.fx.length`, else `null`; the snapshot string carries `me.ev = null`, `fx = []`.
- Produces (sim-host.js): `simHostSetP2P(id: string, open: boolean)`, `simHostForwardGuestInput(id: string, input: object)`; worker `guestFrame` messages call `rtcHostSendFrame(id, snapshot, events)` (defined in Task 3). `simHostStop()` also calls `rtcHostCloseAll()`.

- [ ] **Step 1: Tests**
  - `test-sim.mjs`: player with `seq:10, ax:1`; then `{seq:9, ax:-1, b:4}` → `input.ax === 1`, `input.seq === 10`, `enterExit === true`; then `{seq:5, w:2}` → `input.weapon === 2`; then `{seq:1, ax:-1}` with `i.seq = 100` → applied (`ax === -1`, `seq === 1`, outside window).
  - `test-sim-worker.mjs` (existing harness): after `hoststart` with guest `p2`, post `{type:'p2p', id:'p2', open:true}`; next snapshot tick → no `'W|p2|'` frame on the fake socket, one posted `guestFrame` for `p2` whose parsed snapshot has `t:'w'`; a queued `me.ev` lands in `events` (`JSON.parse(events).ev.length === 1`) and the snapshot's `me.ev === null`. `{open:false}` → back to `'W|p2|'`. `guestInput` for `p2` reaches `applyInput`; for an unknown id it does not.
  - `test-sim-host.mjs` (FakeWorker harness, stub `rtcHostSendFrame`/`rtcHostCloseAll` in the context): `simHostSetP2P('p2', true)` posts `{type:'p2p', id:'p2', open:true}`; worker message `guestFrame` calls `rtcHostSendFrame('p2', snap, ev)`; `simHostStop()` calls `rtcHostCloseAll`.
- [ ] **Step 2: Run** `cd server && node test-sim.mjs && node test-sim-worker.mjs && node test-sim-host.mjs` → new checks FAIL.
- [ ] **Step 3: Implement** per Interfaces. Worker keeps `const p2pGuestIds = new Set()`.
- [ ] **Step 4: Run** the same three files → all OK.
- [ ] **Step 5: Commit** `feat(sim): route guest frames to the host page for P2P delivery`.

### Task 3: `js/rtc.js` peer manager (host and guest roles)

**Files:**
- Create: `js/rtc.js`; add `<script src="js/rtc.js"></script>` in `index.html` right after `js/net.js` (`:798`), before `js/sim-host.js`
- Create: `server/test-rtc.mjs`; append `&& node test-rtc.mjs` to `server/package.json` `test`

**Interfaces:**
- Consumes: Task 1 wire format; Task 2 `simHostSetP2P`, `simHostForwardGuestInput`; globals `netSend`, `netOnSnapshot`, `netApplyWorldEvents` (Task 4), `net` (`myId`, `stats`).
- Produces (pure):
  - `rtcSanitizeInput(m) -> object|null`: `null` unless `m.t === 'i'`; copies only finite numbers of `seq, ax, ay, aim, b, px, py, cx, cy, ca, csp, w, vr, lg` (same list as server `FORWARDED_INPUT_NUMBER_FIELDS`) and `drive` as `{active: !!, angle: finite|0}`.
  - `rtcInputNeedsReliable(cmd) -> boolean`: `(cmd.b & 14) !== 0 || cmd.w != null || cmd.vr != null`.
  - `rtcFreshSnapshot(lastTick, tick) -> boolean`: `true` if `tick` not finite, else `tick > lastTick`.
  - `rtcRetryDelay(attempt) -> number`, `rtcEnabled() -> boolean` (`false` when `location.search` has `rtc=off` or `typeof RTCPeerConnection === 'undefined'`).
- Produces (host role, map `rtcHostPeers: Map<guestId, {pc, fast, rel}>`):
  - `rtcHostOnSignal(from, k, d)`: `offer` → close any previous peer for `from`, create PC + both channels, `setRemoteDescription`, `createAnswer`, `setLocalDescription`, `netSend({t:'rtc', to:from, k:'answer', d: pc.localDescription.sdp})`; `ice` → `addIceCandidate`. Local candidates → `netSend({t:'rtc', to:from, k:'ice', d: candidate.toJSON()})`.
  - Usable/unusable transitions (channel open/close, `connectionstatechange`) → `simHostSetP2P(from, usable)`.
  - Channel `message` (both channels): drop if `data.length > RTC_MAX_INPUT_BYTES`; parse; `rtcSanitizeInput`; non-null → `simHostForwardGuestInput(from, input)`.
  - `rtcHostSendFrame(id, snapshot, events)`: if not usable → `simHostSetP2P(id, false)` and return; send `events` on `rel` when non-null; send `snapshot` on `fast` unless `bufferedAmount > RTC_MAX_BUFFERED_BYTES`.
  - `rtcHostClose(id)`, `rtcHostCloseAll()`.
- Produces (guest role, single state object `rtcGuest`):
  - `rtcGuestConnect(hostId)`: no-op if `!rtcEnabled()` or already connecting to `hostId`; else close previous, create PC + channels, offer → `netSend({t:'rtc', to:hostId, k:'offer', d: sdp})`, arm `RTC_CONNECT_TIMEOUT_MS`.
  - `rtcGuestOnSignal(from, k, d)`: ignored unless `from === rtcGuest.hostId`; `answer` → `setRemoteDescription`; `ice` → `addIceCandidate`.
  - `fast` message: parse; `t === 'w'` → `netOnSnapshot(m)`. `rel` message: `t === 'we'` → `netApplyWorldEvents(m.fx, m.ev)`.
  - Failure (timeout, `failed`, `closed`, channel close) → `rtcGuestClose()`, schedule `rtcGuestConnect(hostId)` after `rtcRetryDelay(attempt++)`; success resets `attempt` to 0.
  - `rtcGuestSendInput(cmd) -> boolean`: usable → send on `rel` if `rtcInputNeedsReliable(cmd)` else `fast`, return `true`; else `false`.
  - `rtcGuestClose()` (also cancels retry), `rtcGuestTransport() -> 'P2P'|'WS'`; every change writes `net.stats.transport`.

- [ ] **Step 1: Tests** in `test-rtc.mjs`: load `js/rtc.js` into a `vm` context with `FakePeerConnection` (records `createDataChannel` options, `setRemoteDescription`, `addIceCandidate`; test drives `connectionState`, channel `readyState` and fires `onopen/onmessage/onclose/onicecandidate`), fake `setTimeout`, and stubs for `netSend`, `netOnSnapshot`, `netApplyWorldEvents`, `simHostSetP2P`, `simHostForwardGuestInput`, `location`, `net`.
  - Pure: `rtcSanitizeInput({t:'i', seq:3, ax:1, evil:'x', drive:{active:1, angle:'a'}})` deep-equals `{seq:3, ax:1, drive:{active:true, angle:0}}`; `rtcSanitizeInput({t:'w'}) === null`; `rtcInputNeedsReliable({b:1}) === false`, `({b:4}) === true`, `({w:2}) === true`; `rtcFreshSnapshot(10, 10) === false`, `(10, 11) === true`, `(10, undefined) === true`; `rtcRetryDelay(0) === 5000`, `(5) === 60000`.
  - Channel options: both PCs create `fast` with `{negotiated:true, id:0, ordered:false, maxRetransmits:0}` and `rel` with `{negotiated:true, id:1, ordered:true}`; PC config `iceServers` equals `RTC_ICE_SERVERS`.
  - Guest: `rtcGuestConnect('p1')` sends one `{t:'rtc', to:'p1', k:'offer'}`; `rtcGuestSendInput` returns `false` before connected; after `connected` + open → `{b:1}` goes on `fast`, `{b:2}` on `rel`, `net.stats.transport === 'P2P'`; `fast` message `{t:'w',tick:5}` reaches `netOnSnapshot`; signal from `'p9'` ignored.
  - Guest failure: never connects → after 10000 ms fake clock, transport `'WS'`, a new offer after 5000 ms more; `rtc=off` in `location.search` → no offer.
  - Host: `rtcHostOnSignal('p2','offer',sdp)` sends `{t:'rtc', to:'p2', k:'answer'}`; open+connected → `simHostSetP2P('p2', true)`; message `{t:'i', seq:1, ax:1}` → `simHostForwardGuestInput('p2', {seq:1, ax:1})`; message of 2049 chars dropped; `rtcHostSendFrame('p2', s, e)` sends `e` on `rel` and `s` on `fast`; with `bufferedAmount = 262145` `s` skipped; after `connectionState='failed'` → `simHostSetP2P('p2', false)`; `rtcHostCloseAll()` closes every PC.
- [ ] **Step 2: Run** `cd server && node test-rtc.mjs` → FAIL (file missing).
- [ ] **Step 3: Implement** `js/rtc.js` per Interfaces; wire `index.html`, `server/package.json`.
- [ ] **Step 4: Run** `cd server && node test-rtc.mjs` → all OK; `node ../build.js` exits 0 (rtc.js picked up from `index.html`).
- [ ] **Step 5: Commit** `feat(net): WebRTC peer manager for host and guest`.

### Task 4: Guest integration, migration, overlay, docs

**Files:**
- Modify: `js/net.js` — `netOnJoined` (`:206-231`), `netSyncHostRole` (`:232-235`), `onServerMessage` (`:268-281`), `netShutdown` (`:285-303`), `createNetStats`/`netStatsLines` (`:747`), `netOnSnapshot` (`:835-891`), `netSendInput` (`:1035-1037`)
- Modify: `MULTIPLAYER.md` (new section "Trasporto P2P (WebRTC)", Italian like the rest of the file)
- Test: `server/test-net-stats.mjs`, `server/test-sim-host.mjs` (code-reading guard pattern of `:85-86`)

**Interfaces:**
- Consumes: Task 3 guest API, `rtcFreshSnapshot`.
- Produces: `netApplyWorldEvents(fx: array|null, ev: array|null)` = the `fx` loop (`:867`) + the `me.ev` toast loop (`:882-885`) moved out of `netOnSnapshot`, which now calls `netApplyWorldEvents(m.fx, m.me && m.me.ev)`; Task 3's `rel` handler calls `netApplyWorldEvents(m.fx, m.ev)`.
- `net.lastSnapTick` (init `-1`): `netOnSnapshot` returns early when `!rtcFreshSnapshot(net.lastSnapTick, m.tick)`, else stores `m.tick`. Reset to `-1` in `netOnJoined`, on `case 'host'`, in `netShutdown`.
- `netSyncHostRole`: host → existing `simHostStart()` + `rtcGuestClose()`; guest with `net.hostId !== null && !net.authoritative` → `rtcGuestConnect(net.hostId)`; otherwise `rtcGuestClose()`.
- `onServerMessage` `case 'rtc'`: `simHostActive() ? rtcHostOnSignal(m.from, m.k, m.d) : rtcGuestOnSignal(m.from, m.k, m.d)`.
- `netSendInput`: `if (simHostActive()) simHostSendInput(cmd); else if (!rtcGuestSendInput(cmd)) netSend(cmd);`
- `createNetStats()` gains `transport: 'WS'`; `netStatsLines` adds the line `transport <value>`. `netSyncHostRole` sets `net.stats.transport = 'host'` on the host branch; the guest branch leaves it to `js/rtc.js` (`P2P`/`WS`).
- `netShutdown`: `rtcGuestClose()` (host side already closed by `simHostStop`).

- [ ] **Step 1: Tests**
  - `test-net-stats.mjs`: `createNetStats().transport === 'WS'`; `netStatsLines` output contains `transport P2P` when `stats.transport = 'P2P'`.
  - `test-sim-host.mjs` guards on `net.js` source (extract with `extractTopLevel`, run in `vm` with stubs): `netSendInput` falls back to `netSend` when `rtcGuestSendInput` returns `false` and does not when it returns `true`; `netOnSnapshot` with `lastSnapTick 10` and `tick 9` leaves `net.snap` unchanged; after `onServerMessage({t:'host', id:'p3'})` `net.lastSnapTick === -1` and `rtcGuestConnect` was called with `'p3'`; `onServerMessage({t:'rtc', from:'p2', k:'offer', d:'s'})` reaches `rtcHostOnSignal` when `simHostActive()` is true, `rtcGuestOnSignal` otherwise.
- [ ] **Step 2: Run** `cd server && node test-net-stats.mjs && node test-sim-host.mjs && node test-rtc.mjs` → new checks FAIL.
- [ ] **Step 3: Implement** per Interfaces; write the MULTIPLAYER.md section: path diagram (guest ⇄ host P2P, VPS only signaling/fallback), channels, fallback/retry, `?rtc=off`, `transport` overlay line, accepted close race (Review Focus 5), measuring with `?netstats` P2P vs `?rtc=off`.
- [ ] **Step 4: Run** `cd server && node test-net-stats.mjs && node test-sim-host.mjs && node test-rtc.mjs && node test-host-mode.mjs && node test-sim-worker.mjs` → all OK.
- [ ] **Step 5: Browser check** (agent `browser`): local server (`cd server && node index.js`, static page per README), two contexts on the same room (`#room=CODE&` + `?netstats`): guest overlay shows `transport P2P`, the guest moves and sees traffic; guest with `?rtc=off` shows `transport WS` and still plays; closing the host tab → guest migrates and overlay returns to `P2P` with the new host (or `host` if the guest is elected).
- [ ] **Step 6: Commit** `feat(net): guest snapshots and inputs over WebRTC with WS fallback`.

### Task 5: Integrate and measure (main session)

- [ ] Push branch, open PR to `main`; CI (`npm test` + build) green on the PR head.
- [ ] Merge after green CI; check the deploy job (Archivist `deploy-ssh-flaky`: rerun `--failed` on SSH kex reset).
- [ ] Prod measurement via agent `browser`, two contexts in one room, 60 s each: guest with `?netstats` (P2P) vs guest with `?netstats&rtc=off` (WS); record `max gap 5 s` and `input RTT` samples every 5 s. Exit criterion (LIBRE-28): P2P max gap < ~250 ms, input RTT stable.
- [ ] LIBRE-33 → `in-review` with evidence (commits, tests, browserCheck, files); Archivist `netcode-diagnostics` fragment with the numbers.
