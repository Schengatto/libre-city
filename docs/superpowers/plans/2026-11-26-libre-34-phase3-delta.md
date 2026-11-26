# LIBRE-34 Phase 3: delta snapshots against the acked baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task (execution is subagent-driven). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The host worker sends each guest a delta against the last snapshot that guest acknowledged, instead of a full snapshot every frame. Removals travel as id lists. A full snapshot goes out on join, after host migration and whenever the baseline is lost. One-shot `me.ev` and `fx` are never lost because of a delta.

**Architecture:** A new pure module, `js/snapshot-delta.js`, diffs two snapshot states and applies a delta to a baseline. Both sides use it: the host worker and the guest page. The worker keeps a short history of the states it sent to each guest (32 frames). It encodes the next frame against the tick named by the guest's latest `sa` (snapshot ack, a new numeric input field). It falls back to a full frame when that tick is missing.

The guest keeps a ring of the states it resolved (32 frames). It turns each delta back into a full state before `netOnSnapshot` touches it, so the rest of `netOnSnapshot` is unchanged. Each input carries `sa` = the tick of the guest's newest resolved state. Baseline loss (a delta whose base is not in the ring, or which fails validation) clears the ring and drops `sa` from the inputs. The host then sends full frames until a new ack arrives.

A delta is an ordinary object encoded by codec v1: no format change and no version bump. Events are split off before diffing, and they travel exactly as today. On WS they ride inline in the same frame. On P2P they go as JSON `we` on `rel`. So a dropped or rejected delta still delivers its events.

**Tech Stack:** Plain browser JS in global scope (page and Web Worker), codec v1 (`js/snapshot-codec.js`), Node `ws` server, Node test scripts loading sources into `vm` or through `createRequire`.

**Spec:** task LIBRE-34 (board). DoD lines:
- "Phase 3: delta vs acked baseline with removal lists; full snapshot on join, host migration and baseline loss; one-shot `me.ev`/`fx` never lost".
- "Bandwidth measured before and after each phase (raw and deflated, 4 players, seeds 1-5), results in MULTIPLAYER.md".
- "Existing host-mode, sim-worker, sim-host and server-sim tests green".

## Global Constraints

- Worktree `.tmp/wt-libre34`, branch `feat/libre-34-delta` (from origin/main a821314). Never touch the main checkout `C:/workspace/Schengatto/libre-city`.
- No code comments; the module is internal. English identifiers.
- Global scope is shared by every script, page and worker. Prefix new names with `SNAPSHOT_DELTA_` / `snapshotDelta` (module) or `snapshotPayload` (glue). The following names were grep-checked free on a821314:
  - `snapshotDelta*`, `SNAPSHOT_DELTA_*`
  - `SNAPSHOT_PAYLOAD_IDS`, `snapshotPayloadId*`
  - `netResolveSnapshot`, `netResetSnapshotBaseline`, `snapshotRing`, `snapshotAckTick`
  - `guestBaselines`, `guestBaselineFor`, `noteSnapshotAck`, `guestWireSnapshot`

  Grep again before adding any other name. `server/test-buildings.mjs:120-131` enforces uniqueness across the index.html scripts.
- CI runs Node 22; local is Node 24.
- Never run the server test chain from a subagent shell. Run single files: `node server/<file>.mjs`.
- After touching net.js, run every test that vm-extracts net.js (`grep -ln "'net.js'" server/*.mjs`).
- Scratch files only in `.tmp/` (gitignored at `.gitignore:11`). `MULTIPLAYER.md` stays in Italian.
- Scope: host-player paths only (worker → hostlink `W` frames and worker → P2P `fast`). The server-sim path (`server/index.js:405-411`, JSON text to each player) is unchanged. It is a fallback, its cost is server-side deflate rather than host upload, and `test-server-sim` parses its JSON. The guest treats any frame without `base` as full, so server-sim, the host's own worker frames and an old host mid-deploy keep working.

## Delta frame format (binding, used by Tasks 1-4)

**States.** A *state* is a snapshot with its events split off: `fx: []` and `me.ev: null`. The host diffs states. The guest stores states. Ticks come from the snapshot's `tick` (= sim `frame`, strictly increasing within one host epoch).

**Wire normalization.** Equality and key sets follow what the guest will see after codec v1, via `snapshotDeltaSameValue` and the *wire keys* of an object:
- Wire keys are the own keys whose value is neither `undefined` nor a function.
- Non-finite numbers count as `null`, `-0` counts as `0`, and `undefined` array items count as `null`.
- Example: `carPayload` always has the key `dn`, but `dn: undefined` is not a wire key.

**Delta frame.**
```
{ t: 'w', tick, ack, base, me, players?, bul?, rkt?, sc?, <any other top-level key>?, fx,
  cars: [...], peds: [...], coins: [...], fires: [...], rm?: { cars?, peds?, coins?, fires? } }
```

Top-level fields:
- `t`, `tick`, `ack` are always present. `base` is the baseline tick.
- `me` is always present and is a patch: only the wire keys whose value changed. Values are compared and sent whole, so `own` and `car` go whole when they change.
- `cars`, `peds`, `coins` and `fires` (`SNAPSHOT_DELTA_KEYED_LISTS`) are always present, possibly empty.
- Every other top-level key (`players`, `bul`, `rkt`, `sc`, `fx`, or any key added later) is sent whole when it changed and omitted when unchanged. These keys have no ids or are tiny:
  - `bul` and `rkt` have no ids, live briefly and move every frame;
  - `players` has at most 7 entries that move every frame;
  - `sc` is about 7 small rows.

Keyed-list entries:
- An id that is not in the base is sent as the full entity.
- An id that is in both, with the same wire key set, is sent as a patch `{ id, ...changedKeys }`. It is omitted when nothing changed.
- An id whose wire key set changed (e.g. `dn` appears or disappears) goes into `rm.<list>` and is also sent as the full entity. Apply removes before it adds.
- An id that is in the base but not in the current list goes into `rm.<list>`.
- `rm` holds only non-empty lists and is omitted when every list is empty. Entity order is not preserved: every consumer is Map-based or rebuilds the list.

**Encoder full fallback.** `snapshotDeltaEncode` returns `null` (send full) when any of these holds:
- the base and current wire key sets differ, at top level or in `me`;
- a keyed list is not an array in either state;
- an id is not a finite number or a non-empty string;
- an id is duplicated within a list;
- a list is longer than `SNAPSHOT_DELTA_MAX_ENTITIES` (4096).

**Apply validation.** `snapshotDeltaApply(base, delta)` returns `null` (never throws, never mutates either argument) unless all of these hold:
- `base` and `delta` are plain objects, `delta.t === 'w'` and `delta.base === base.tick`;
- `delta.tick` is finite and `> base.tick`;
- `delta.me` is a plain object whose keys are all own keys of `base.me`;
- every delta top-level key is `base`, `rm` or an own key of `base`;
- every keyed list is an array of at most 4096 plain objects, each with a valid id;
- a patch (id already in the base, after removals) only uses keys that the base entity owns;
- `rm`, if present, is a plain object whose own keys are keyed-list names and whose values are arrays of valid ids, each at most 4096 long.

Unknown `rm` ids are ignored. Objects are built with spread or `Object.fromEntries` only: never `target[untrustedKey] = value`. So a `__proto__` key (possible on the JSON text path of `rtcParseMessage`) cannot reach a prototype, and the own-key checks reject it anyway.

The result is a new state:
- `{ ...base, ...wholeDeltaFields, tick: delta.tick, ack: delta.ack, me: { ...base.me, ...delta.me, ev: null }, fx: [], <keyed lists merged> }`;
- no `base` or `rm` key;
- unchanged entity objects are shared with the base (structural sharing; nobody mutates states).

**Ack.** Every guest input may carry `sa`: the tick of the guest's newest resolved state. It is omitted while the guest has no baseline. Old clients never send `sa`, so they always get full frames. The host keeps only the latest `sa` that arrived ("last arrival wins"). A missing or non-finite `sa` sets the ack to `null`, so the next frame is full.

**History size.** Host history and guest ring both hold `SNAPSHOT_DELTA_HISTORY_SIZE = 32` states, about 1.07 s at 30 snapshots/s, evicted oldest-first. With equal caps, any acked tick still in the host history is still in the guest ring: the guest resolves a subset of the frames the host sent, in tick order. So a valid ack never yields a delta the guest cannot apply. Stale, reordered or old-epoch acks cost at most one RTT of dropped frames, and those frames still deliver their events.

## Review Focus

1. Hostile host: a P2P host can send any delta, binary or JSON text on `fast`. `snapshotDeltaApply` must never throw, mutate its inputs, pollute prototypes or accept more than 4096 entities per list. Covered by the Task 1 hostile and fuzz tests.
2. Events exactly once: each guest frame applies its `fx`/`me.ev` once, whether it is stale, rejected (baseline loss) or applied. P2P events stay on `rel` `we` frames. Covered by the Task 3 `test-net-delta` sequence and the Task 2 P2P `we` test.
3. Full frame on join, migration and loss:
   - the guest resets its ring and ack on `ok`/resume, on `host` and on shutdown;
   - the host sends full when `sa` is absent, unknown or older than its history, and after a guest leaves and rejoins.

   Covered by Task 2 (worker) and Task 3 (`onServerMessage` host reset, reconnect sequence).
4. Wire fidelity: the applied delta must equal the decoded current state, including key-set changes (`dn` appears or disappears), AOI teleport (mass removals) and coin/fire ids. The `me.own` copy matters: a weapon purchase must show in the next delta because the host history no longer aliases `me.owned`. Covered by Task 1 real-sim tests through the codec.
5. Host state hygiene: history only records frames that were actually handed to a transport, is bounded at 32 per guest, and is dropped on `leave` and `stopRoom`. The host's own frame stays full. Covered by Task 2 `test-sim-worker` cases.

---

### Task 1: Delta module, payload ids and the `me.own` copy

**Files:**
- Create: `js/snapshot-delta.js`
- Create: `server/test-snapshot-delta.mjs`
- Modify: `js/server-sim-glue.js:229` area (new id helpers before `__fx`), `:266-267` (coins/fires payloads), the `me.own` field in `snapshotFor` (`:239-269`)
- Modify: `server/package.json:12` (append `&& node test-snapshot-delta.mjs` to the test chain)

**Interfaces:**
- Produces (top-level globals in `js/snapshot-delta.js`), ending with the codec's export pattern `if (typeof module !== 'undefined') module.exports = { ... }` (see the end of `js/snapshot-codec.js`):
  - `SNAPSHOT_DELTA_HISTORY_SIZE = 32`, `SNAPSHOT_DELTA_MAX_ENTITIES = 4096`, `SNAPSHOT_DELTA_KEYED_LISTS = ['cars', 'peds', 'coins', 'fires']`
  - `snapshotDeltaSameValue(a, b) -> boolean`: deep equality under wire normalization.
  - `snapshotDeltaSplitEvents(frame) -> { state, fx, ev }`:
    - `state = { ...frame, fx: [], me: { ...frame.me, ev: null } }`;
    - `fx = Array.isArray(frame.fx) ? frame.fx : []`;
    - `ev = frame.me && Array.isArray(frame.me.ev) ? frame.me.ev : null`;
    - does not mutate `frame`; a frame without an object `me` gets `me: { ev: null }`.
  - `snapshotDeltaWithEvents(value, fx, ev) -> object`: returns `{ ...value, fx, me: { ...value.me, ev } }`.
  - `snapshotDeltaEncode(base, current) -> object | null`: the delta frame, or `null` meaning "send full".
  - `snapshotDeltaApply(base, delta) -> state | null`
  - `snapshotDeltaRemember(history: Map<number, state>, state) -> void`: `history.set(state.tick, state)`, then deletes the oldest keys while `history.size > SNAPSHOT_DELTA_HISTORY_SIZE`.
- Produces (glue):
  - `SNAPSHOT_PAYLOAD_IDS = new WeakMap()`, `let snapshotPayloadIdSeq = 1`;
  - `snapshotPayloadId(entity) -> number`: returns the stored id or assigns `snapshotPayloadIdSeq++`;
  - coins become `{ id, x, y, v }` and fires `{ id, x, y }`;
  - `me.own` becomes `me.owned.slice()` (`owned` is always an array: `server-sim-glue.js:56`, `:341`).

  Ids only need to be stable within one host epoch: migration sends a full frame and rebuilds the world.

- [ ] **Step 1: Write `server/test-snapshot-delta.mjs`.** Use the `ok`/pass/fail/exit-code pattern of `server/test-snapshot-codec.mjs:9-13`. Load the module and the codec with `createRequire`. Get a vm context for the real sim with the `loadSim` pattern of `server/test-snapshot-payload.mjs:8-12`. Helpers:
  - `wire = v => snapshotDecode(snapshotEncode(v))`;
  - `canonical = s => ({ ...s, cars: sortById(s.cars), peds: sortById(s.peds), coins: sortById(s.coins), fires: sortById(s.fires) })`;
  - `applies = (base, current) => isDeepStrictEqual(canonical(snapshotDeltaApply(wire(base), wire(snapshotDeltaEncode(base, current)))), canonical(wire(current)))`.

  Cases:
  - **Constants**: `SNAPSHOT_DELTA_HISTORY_SIZE === 32`, `SNAPSHOT_DELTA_MAX_ENTITIES === 4096`, the keyed lists equal `['cars','peds','coins','fires']`.
  - **sameValue**: true for `(NaN, null)`, `(-0, 0)`, `({a: undefined, b: 1}, {b: 1})`, `([undefined], [null])`, `({x: [1, {y: 2}]}, {x: [1, {y: 2}]})`. False for `(1, '1')`, `([1], [1, 2])`, `({a: 1}, {a: 1, b: 2})`, `(null, {})`.
  - **splitEvents**: given `f = { t: 'w', tick: 4, me: { x: 1, ev: ['k'] }, fx: [{ k: 1 }] }`, it returns `ev` deep-equal `['k']` and `fx` deep-equal `[{ k: 1 }]`, with `state.fx` `[]` and `state.me.ev === null`. `f.me.ev` and `f.fx` are unchanged afterwards. `withEvents(state, fx, ev)` deep-equals `f`.
  - **remember**: 40 states with ticks 2..80 step 2 leave `history.size === 32` with the oldest key `18`.
  - **Real-sim sequence**: `loadSim('PDELTA1')`, add 4 players `pA..pD`, run 240 ticks. Every 2 ticks call `snapshotFor('pB')`, set `sc = __sim.scores()`, take `snapshotDeltaSplitEvents(...).state` and call `__sim.clearFx()` (the worker's order, `js/sim-worker.js:94-105`). Then:
    - for every frame index `i` and offset `k` in `[1, 2, 5, 16]` with `i - k >= 0`: `snapshotDeltaEncode(states[i-k], states[i]) !== null` and `applies(states[i-k], states[i])`;
    - the delta always has `base === states[i-k].tick` and never a `base` or `rm` key inside `me`;
    - print the mean wire bytes of full vs offset-2 delta frames, and assert `meanDeltaBytes < 0.8 * meanFullBytes`. If this fails, report the numbers; do not loosen the threshold.
  - **AOI teleport**: take a state, set `_player('pB')` x/y to the far corner of the world, tick 2, take the next state. The delta has non-empty `rm.cars` or `rm.peds`, and `applies` holds.
  - **Key-set change**: set `__sim._cars()[0].dents = 5`, then the next state, then `dents = 0`, then the next. Choose a car in pB's AOI, or move the car next to pB. Across both steps the car id is in `rm.cars` and also among the full `cars` entries, and `applies` holds.
  - **Coins and fires**: push a coin `{ x, y, val: 50 }` and a fire `{ x, y, r: 20, hp: 100 }` next to pB through the vm context (`coins.push` / `fires.push`). The next state's coin and fire entries have numeric `id`s, and the following state keeps the same ids. After splicing both out, the delta's `rm.coins` / `rm.fires` contain those ids and `applies` holds.
  - **Owned copy**: `states[i].me.own !== _player('pB').owned`. After setting `_player('pB').owned[3] = true`, the next delta's `me.own[3] === true`.
  - **Encoder fallback (null)**: when the current state has an extra top-level key; when `me` gains a key; when `cars` has a duplicate id; when a car id is `{}`; when `peds` is not an array; when a list has 4097 entries.
  - **Whole-field omission**: with `sc` unchanged the delta has no `sc` key, and apply keeps `base.sc`. With `bul` changed the delta carries the whole `bul`.
  - **Apply rejects (null)**, built from a valid `delta = snapshotDeltaEncode(a, b)`:
    - `base` mismatch;
    - `tick === base.tick`;
    - non-finite `tick`;
    - `delta.t = 'we'`;
    - `cars: {}`;
    - 4097 car entries;
    - a car patch with key `zz` on an existing id;
    - `JSON.parse('{"__proto__":{"polluted":1},"id":<existing id>}')` as a car entry;
    - a `me` patch key `zz`;
    - an unknown top-level key `zz`;
    - `rm: []`;
    - `rm: { cars: 'x' }`;
    - `rm: { boats: [1] }`;
    - an id that is an object;
    - `base = null`;
    - `delta = 7`.

    After all of them, `({}).polluted === undefined`.
  - **Apply ignores** an unknown `rm` id: the result deep-equals the apply without it.
  - **No mutation**: `structuredClone` of base and delta before apply, `isDeepStrictEqual` after, for a valid and an invalid delta.
  - **Fuzz**: 2000 rounds with a seeded PRNG (the generator of `test-snapshot-codec.mjs:104-110`). Mutate one random path of `wire(delta)` to a random value from `[null, -1, 1e9, 'x', {}, [], [{}], { id: 1 }, NaN]`. `snapshotDeltaApply` never throws (count throws, assert 0).
- [ ] **Step 2: Run, expect failure.** `node server/test-snapshot-delta.mjs` fails (module missing).
- [ ] **Step 3: Implement** `js/snapshot-delta.js` per "Delta frame format", and the glue changes. The per-list diff the signatures leave open:
  ```
  baseById = Map(id -> entity) of base list; seen = Set()
  for entity of current list:
    seen.add(id); old = baseById.get(id)
    if !old: out.push(entity)
    else if wireKeys(old) != wireKeys(entity): rm.push(id); out.push(entity)
    else: patch = { id, ...keys k where !sameValue(old[k], entity[k]) }; if patch has more than id: out.push(patch)
  for id of baseById.keys(): if !seen.has(id): rm.push(id)
  ```
  Apply mirrors it:
  - start from `Map(id -> entity)` of the base list;
  - delete the `rm` ids;
  - for each entry, a known id merges `{ ...old, ...entry }` and an unknown id inserts the entry (the validation of the format section applies first);
  - output the Map values.
- [ ] **Step 4: Run** `node server/test-snapshot-delta.mjs`, `node server/test-snapshot-payload.mjs`, `node server/test-snapshot-codec.mjs`, `node server/test-sim.mjs`, `node server/test-server-sim.mjs`. All must exit 0.
- [ ] **Step 5: Commit.** `git add js/snapshot-delta.js js/server-sim-glue.js server/test-snapshot-delta.mjs server/package.json && git commit -m "feat(net): snapshot delta module and stable payload ids"`

### Task 2: Host worker keeps per-guest history and encodes against the ack

**Files:**
- Modify: `js/sim-worker.js:3` (`SIM_SCRIPT_FILES`: add `'snapshot-delta.js'` right after `'snapshot-codec.js'`), `:24-25` (state), `:71-105` (`postGuestFrame`, `sendBinarySnapshot`, `sendSnapshots`), `:145-154` (`'i'` and `'leave'` cases), `:164-166` (`applyGuestInput`), `:184-191` (`stopRoom`)
- Modify: `server/sim-runtime.js:28` (`SIM_FILES`: same insertion). Check `.github/workflows/deploy.yml:76` and `build-sim-worker.js`: if either lists files rather than reading `SIM_FILES`, add the file there too.
- Modify: `js/rtc.js:10` (`RTC_INPUT_NUMBER_FIELDS`: append `'sa'`), `server/index.js:69` (`FORWARDED_INPUT_NUMBER_FIELDS`: append `'sa'`)
- Modify tests: `server/test-sim-worker.mjs` (harness `:18-75`, frame helpers `:115-118`, P2P routing `:126-154`; import order assertion `:80` follows `SIM_FILES` automatically), `server/test-rtc.mjs:96-99`, `server/test-host-mode.mjs:207-214`

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces (worker IIFE locals, not globals):
  - `const guestBaselines = new Map()` (id → `{ history: Map, ackTick: number | null }`);
  - `guestBaselineFor(id)` creates entries lazily;
  - `noteSnapshotAck(id, sa)`: returns without effect for `hostId`, otherwise sets `guestBaselineFor(id).ackTick = Number.isFinite(sa) ? sa : null`;
  - `guestWireSnapshot(id, state) -> object`:
    - `base = ackTick === null ? undefined : history.get(ackTick)`;
    - `wire = (base && snapshotDeltaEncode(base, state)) || state`;
    - then `snapshotDeltaRemember(history, state)`;
    - returns `wire`.
- Wire behaviour:
  - the WS path sends `snapshotEncode(snapshotDeltaWithEvents(wire, fx, ev))` inside the unchanged `0x57 | idLen | id | codec` frame;
  - the P2P path posts `snapshotEncode(wire)` as `guestFrame.snapshot`, with the unchanged `{t:'we', tick, ev, fx}` JSON as `events` when `ev !== null || fx.length > 0`;
  - the host's own `snapshot` message stays the full snapshot with inline events.

- [ ] **Step 1: Tests first.**
  - `server/test-sim-worker.mjs`. Load `snapshot-delta.js` with `createRequire` next to the codec, and drive guest inputs through the FakeSocket like the existing `'i'` cases. Cases:
    - with no `sa`, every frame to `p2` decodes without a `base` key;
    - after delivering `{ t: 'i', id: 'p2', seq: 1, sa: T }`, where `T` is the tick of a frame already sent to `p2`, the next `p2` frame has `base === T`;
    - `snapshotDeltaApply(decoded frame T state, decoded delta state)` is not null, and its `tick` equals the delta's `tick`;
    - `sa: 999999` (never sent) and `sa: 'x'` each give a full next frame;
    - after 40 more snapshot rounds without a new ack, the frame is full again (the base aged out of the 32-entry history);
    - an input without `sa` after a valid one gives a full next frame;
    - `p1` (host) frames posted as `snapshot` never carry `base`, even after `{ t: 'i', id: 'p1', sa: T }`;
    - after `{ t: 'leave', id: 'p2' }`, a fresh `join` for `p2` and an `sa` equal to an old p2 tick, the next p2 frame is full;
    - with the socket `readyState` set to closed for one round, an `sa` naming that round's tick gives a full frame once the socket is open again (that round was never remembered);
    - P2P: after `setGuestP2P('p2', true)` and an ack via `applyGuestInput`, `guestFrame.snapshot` decodes with `base`, `fx` `[]` and `me.ev === null`;
    - a round with a kill or fx for p2 still posts `events` JSON with the same `ev`/`fx`;
    - WS inline events: a delta frame carrying `me.ev` keeps it when decoded.
  - `server/test-rtc.mjs:96-99`: `rtcSanitizeInput({ t: 'i', seq: 3, sa: 120 })` keeps `sa: 120`, and `sa: NaN` is dropped.
  - `server/test-host-mode.mjs` next to `:207-214`: a guest input with `sa: 42` reaches the hostlink with `sa: 42`. `sa: 'x'` is not forwarded.
- [ ] **Step 2: Run the three files, expect failures.**
- [ ] **Step 3: Implement.**
  - `sendSnapshots` splits once per guest: `const { state, fx, ev } = snapshotDeltaSplitEvents(snapshot)`. It does this only for `id !== hostId`, after `snapshot.sc = scores`.
  - `postGuestFrame(id, state, fx, ev)` replaces the in-place mutation at `:72-75`.
  - `sendBinarySnapshot(id, state, fx, ev)` keeps the socket and id-length checks before calling `guestWireSnapshot`, so history records only frames that were handed to the socket.
  - The `'i'` case calls `noteSnapshotAck(message.id, message.sa)` before `applyInput`. `applyGuestInput` calls `noteSnapshotAck(id, input.sa)` inside its existing guard.
  - `'leave'` calls `guestBaselines.delete(message.id)`. `stopRoom` calls `guestBaselines.clear()`.
  - `sim.applyInput` ignores unknown fields (`server-sim-glue.js:288-314`), so `sa` reaching it is harmless.
- [ ] **Step 4: Run** `node server/test-sim-worker.mjs`, `node server/test-rtc.mjs`, `node server/test-host-mode.mjs`, `node server/test-sim-host.mjs`, `node server/test-snapshot-delta.mjs`, `node server/test-server-sim.mjs`. All must exit 0.
- [ ] **Step 5: Commit.** `git add -A js server && git commit -m "feat(net): host sends per-guest deltas against the acked snapshot"`

### Task 3: Guest resolves deltas, acks, and recovers from baseline loss

**Files:**
- Modify: `index.html:798-801` (add `<script src="js/snapshot-delta.js"></script>` right after `js/snapshot-codec.js`)
- Modify: `js/net.js`:
  - `:43` (net fields);
  - `:223`, `:290`, `:308` (the three `net.lastSnapTick = -1` sites become `netResetSnapshotBaseline()`);
  - `:865-868` (`netOnSnapshot` head);
  - `:1002` (`player.owned = me.own.slice()`);
  - `:1038-1064` (`netSendInput`).
- Create: `server/test-net-delta.mjs`
- Modify tests:
  - `server/test-rail.mjs:192-209`: add the stub `netResolveSnapshot: snapshot => snapshot` to its context;
  - `server/test-sim-host.mjs:133` (net literal: `snapshotRing: new Map(), snapshotAckTick: null`), `:148` (extract `netResetSnapshotBaseline` and `netResolveSnapshot` too), and load `js/snapshot-delta.js` into that context;
  - `server/package.json:12` (append `&& node test-net-delta.mjs`).

**Interfaces:**
- Consumes: Task 1 globals, Task 2 wire behaviour.
- Produces (net.js top-level):
  - `net.snapshotRing = new Map()`, `net.snapshotAckTick = null`.
  - `netResetSnapshotBaseline()` sets `net.lastSnapTick = -1`, clears `net.snapshotRing`, and sets `net.snapshotAckTick = null`.
  - `netResolveSnapshot(m) -> object | null`:
    - When `m.base === undefined`: remember `snapshotDeltaSplitEvents(m).state`, set `snapshotAckTick = m.tick` if finite, and return `m`.
    - Otherwise, split the events of `m` and apply its state to `net.snapshotRing.get(m.base)`.
    - On `null`: clear the ring, set `snapshotAckTick = null`, and return `null`.
    - On success: remember the result, set `snapshotAckTick = result.tick`, and return `snapshotDeltaWithEvents(result, fx, ev)`.
  - In `netOnSnapshot`, right after `:867`: `const resolved = netResolveSnapshot(m); if (!resolved) { netApplyWorldEvents(m.fx, m.me && m.me.ev); return; } m = resolved;`. The rest of the function is unchanged.
  - In `netSendInput`, after `cmd` is built: `if (Number.isFinite(net.snapshotAckTick)) cmd.sa = net.snapshotAckTick;`.

  `lastSnapTick` still advances on a rejected delta. A later frame with the same tick is a duplicate either way, and the next valid full frame has a higher tick.

- [ ] **Step 1: Tests first.**
  - Create `server/test-net-delta.mjs`. Extract `netResolveSnapshot`, `netResetSnapshotBaseline` and `netOnSnapshot` with `extractTopLevel` (see `server/test-sim-host.mjs:148-150`). Load `snapshot-delta.js` and the codec into the context. Stub these, as `server/test-rail.mjs:192-209` does:
    - `rtcFreshSnapshot`: the real one, via `extractTopLevel` from rtc.js;
    - `netNoteTrainTick`, `netStatsOnSnapshot`;
    - `netMakeWorldCar` (returns `{}`), `netApplyCar`, `interpFeed`;
    - `netWorldBulletsFrom` (returns `[]`);
    - `coins`, `fires` (arrays), `rnd`, `TAU`, `net.players` (Map);
    - `netApplyWorldEvents` records `{ fx, ev }`.

    Build host frames with `createRoomSim` and `snapshotDeltaEncode` exactly as Task 2 sends them, through `wire()`. Sequence:
    1. full tick 2 with `ev ['a']`: applied, `net.snapshotAckTick === 2`, ring size 1;
    2. delta tick 4 with base 2 and `ev ['b']`: `net.snap.tick === 4`, `net.wcars` ids equal the full tick-4 state's car ids, and the ack is 4;
    3. delta tick 6 with base 99 and `ev ['c']`: `net.snap.tick` still 4, the ack is `null`, the ring is empty;
    4. the stale tick 6 again with `ev ['d']`: no state change;
    5. delta tick 8 with base 4 and `ev ['e']` (ring empty): dropped;
    6. full tick 10 with `ev ['f']`: applied, ack 10.

    Assert the recorded events equal `[['a'],['b'],['c'],['d'],['e'],['f']]` in order (exactly once each). Further cases:
    - `netResetSnapshotBaseline()` empties the ring, sets the ack to `null` and `lastSnapTick` to -1;
    - a hostile JSON delta `JSON.parse('{"t":"w","tick":12,"base":10,"me":{},"cars":[{"__proto__":{"p":1},"id":1}],"peds":[],"coins":[],"fires":[]}')` is dropped without throwing, and `({}).p === undefined`.
  - `server/test-sim-host.mjs`:
    - `netSendInput` with `net.snapshotAckTick = 30` sends `sa: 30` on every transport (simHost, rtc, netSend);
    - with `null` the `cmd` has no `sa` key;
    - the migration test at `:170-172` also asserts `snapshotRing.size === 0` and `snapshotAckTick === null` after `{ t: 'host', id: 'p3' }`, with the ring pre-filled with one entry;
    - the stale-snapshot test at `:164-168` still passes.
- [ ] **Step 2: Run, expect failures.**
- [ ] **Step 3: Implement** as in Interfaces. `netOnJoined` (`:223`) covers join and reconnect/resume. A guest that reconnects with a stale host-side ack gets one delta it cannot resolve, then sends no `sa`, and the host sends full.
- [ ] **Step 4: Run** `node server/test-net-delta.mjs`, `node server/test-sim-host.mjs`, `node server/test-rtc.mjs`, `node server/test-buildings.mjs`, and every vm test of net.js:
  - `node server/test-rail.mjs`, `test-dents`, `test-vehicles`, `test-traffic-lead`, `test-fire-prediction`, `test-net-stats`, `test-snapshot-payload`;
  - plus anything else `grep -ln "'net.js'" server/*.mjs` lists.

  All must exit 0. Check that `grep -n "snapshot-delta" index.html` shows the script after `snapshot-codec.js` and before `net.js`, and that `build.js` picks it up through its index.html scan (`grep -n "localScripts" build.js`).
- [ ] **Step 5: Commit.** `git add -A js server index.html && git commit -m "feat(net): guests resolve delta snapshots and ack their baseline"`

### Task 4: Measure and document

**Files:**
- Modify: `.tmp/host-bandwidth.mjs` (scratch, untracked)
- Modify: `MULTIPLAYER.md` (new "LIBRE-34 fase 3" block after `:131`; protocol line in the P2P section `:152-153`)

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: `.tmp/bw-phase3.txt` and the Italian table in `MULTIPLAYER.md`.

- [ ] **Step 1: Extend the harness.**
  - Keep the frame count and the raw/deflate/context-takeover accounting of `0x57` frames as they are.
  - Add a guest chain per guest `p2..p4`: decode the codec payload, then resolve it with a ring and `snapshotDeltaApply`, as `netResolveSnapshot` does.
  - After `ACK_MS` of simulated time (env, default 100), deliver `{ t: 'i', id, seq, sa }` through the FakeSocket, where `sa` is the guest's newest resolved tick.
  - Count full, delta and dropped frames per run.
  - `ACK=off` sends no `sa`. This is the control: it must reproduce the phase 2 numbers in `.tmp/bw-phase2.txt` within noise.
- [ ] **Step 2: Run.** Seeds 1-5, `LEVEL=6`, with acks and with `ACK=off`. Save to `.tmp/bw-phase3.txt`. Expected: zero dropped frames with acks at 100 ms, and the delta share above 90 % after the first second.
- [ ] **Step 3: Document.**
  - Add to `MULTIPLAYER.md` after `:131` the block **LIBRE-34 fase 3** (snapshot delta rispetto all'ultimo snapshot confermato dal guest).
  - Table columns: fase 2 / fase 3, mean / max. Rows:
    - raw;
    - byte medi per frame raw;
    - senza context takeover;
    - con context takeover;
    - quota di frame delta.
  - Add a short paragraph on the protocol:
    - `sa` in the inputs;
    - history of 32 snapshots on host and guest;
    - full frame on join, host change and baseline loss;
    - events outside the delta, inline on WS and `we` on `rel`.
  - In the P2P section (`:152-153`), add that a host change also clears the guest's snapshot ring.
- [ ] **Step 4: Commit.** `git add MULTIPLAYER.md && git commit -m "docs(net): LIBRE-34 phase 3 bandwidth"`

---

## Self-review

- DoD "delta vs acked baseline with removal lists": Task 1 (format, `rm`) and Task 2 (ack-driven encoding).
- "Full on join, migration, baseline loss":
  - join and reconnect: the guest reset at `:223` and the host's lazy entry/`leave` drop;
  - migration: the `host` reset at `:290`, and a fresh worker that has no history;
  - loss: `netResolveSnapshot` null → `sa` omitted → full.

  Tests are in Tasks 2 and 3.
- "`me.ev`/`fx` never lost": events are split before diffing and travel outside the delta. Exactly-once is tested in Task 3, P2P `we` in Task 2. The pre-existing loss modes are unchanged and are listed under open risks.
- "Bandwidth measured, results in MULTIPLAYER.md": Task 4, with an `ACK=off` control against phase 2.
- "Existing host-mode, sim-worker, sim-host, server-sim tests green": they are in the Step 4 lists of Tasks 1-3. The test-rail and test-sim-host harness fixes are named.
- Type consistency:
  - `snapshotDeltaSplitEvents` / `snapshotDeltaWithEvents` / `snapshotDeltaEncode` / `snapshotDeltaApply` / `snapshotDeltaRemember` have the same signatures in Tasks 1-4;
  - `sa` is numeric in both whitelists;
  - `base` is a tick number.

## Open risks

- WS relay backpressure (`server/index.js:530-535`) and the P2P channel-close race (`MULTIPLAYER.md:157-159`) can still drop events. Both are pre-existing and not caused by deltas.
- Structural sharing: the resolved state shares entity objects with the ring. Any future code that mutates `net.snap` or its entities would corrupt the baseline. Today `netOnSnapshot` and `netReconcileMe` only read, and `own` is copied at `:1002`.
- The real gain depends on how many cars and peds move per frame. The 0.8 threshold in Task 1 is a floor, not a forecast. Task 4 gives the real number.
- Host memory: up to 32 states × 7 guests, each about 35 KB as JS objects. `snapshotFor` builds fresh objects every call, so nothing is shared between ticks. That is about 8 MB worst case in the worker. Acceptable; revisit if phones host.
