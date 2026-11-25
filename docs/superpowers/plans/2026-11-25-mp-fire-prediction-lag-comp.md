# MP fire prediction and host lag compensation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In Phase 2 multiplayer, show the shooter's muzzle flash, sound and tracer immediately, and let the host resolve rival hits against positions rewound by the shooter's measured latency.

**Architecture:** The client sends `lg` (input RTT + interpolation delay, ms) in every input. The host keeps a 32-tick ring of each player's body position and tests rival hits at `frame - lagTicks`. The client predicts own-weapon bullets locally and drops the host's own muzzle fx and own snapshot bullets to avoid doubles.

**Tech Stack:** Plain browser JS (global scope, no modules), Node `vm`-based tests (`server/render-test-kit.mjs` `extractTopLevel`, `server/sim-runtime.js` `createRoomSim`).

**Spec:** `docs/superpowers/specs/2026-11-25-mp-fire-prediction-lag-comp-design.md`

## Global Constraints

- `LAG_COMP_MAX_MS = 250`; `LAG_HISTORY_TICKS = 32`; `SIM_STEP_MS = 1000 / 60`; client `lg` quantised to 5 ms; predicted-shot TTL `NET_PREDICTED_SHOT_TTL_MS = 1000`.
- No code comments, English identifiers (user rule). Existing comments stay untouched.
- js files share one global scope: before adding any top-level name, grep `js/` and `server/` for it. New names in this plan were grepped free on 2026-11-25.
- Code in `js/` also runs in SP and in the worker/vm: host-only code must tolerate `MP === null`; prediction runs only when `authClient()` is true.
- `extractTopLevel` rules: functions must close with `}` at column 0; multi-line consts end with `};` at column 0.
- Every new test file is appended to the `server/package.json` `test` chain.
- Scratch output only in `.tmp/`. Run only the test files you wrote or changed plus by name `test-net-stats.mjs`, `test-hot-paths.mjs`, `test-sim-stubs.mjs`, `test-sim-worker.mjs` (source-reading guards); never the full suite (CI is the gate).
- Work in worktree `.tmp/wt-libre31`, branch `feat/libre-31-fire-prediction`. Never `npm test` in command text (hook).

## Review Focus

1. `lg` missing, NaN, negative or huge in an input: host clamps to `[0, 250]`, no crash, no rewind when 0. (Task 2)
2. Rival with no history entry (just joined, respawned, ring wrapped): fall back to the current position. (Task 1, 2)
3. Shooter latency spike above 250 ms: rewind stays at 15 ticks. (Task 1, 2)
4. Own muzzle fx arrives with no matching prediction (gate mismatch): flash and sound still play. (Task 4)
5. Predicted shot never confirmed by the host: expires after 1000 ms and does not swallow a later real shot's fx. (Task 1, 4)
6. Cop/army muzzle fx during the shared phase must not carry a player id. (Task 3)

## File Structure

- `js/entities.js`: shared constants and the body-history helpers (used by the host sim and tests).
- `js/gameplay.js`: rival PvP hit test in `updateBullets` (~line 893) uses rewound position.
- `js/server-sim-glue.js`: `applyInput` reads `lg`; per-player history record; fx and bullet `o` tags.
- `server/index.js:64`: add `'lg'` to `FORWARDED_INPUT_NUMBER_FIELDS`.
- `js/net.js`: `netLagCompMs`, predicted-shot queue helpers, prediction, suppression.
- `server/test-fire-prediction.mjs` (new): all tests of this plan.

---

### Task 1: Shared pure helpers

**Files:**
- Modify: `js/entities.js` (new top-level block near other shared constants), `js/net.js` (helpers near `netStatsSmooth`/`netStatsOnAck`, ~line 654-690)
- Create: `server/test-fire-prediction.mjs`; Modify: `server/package.json` (append to chain)

**Interfaces:**
- Produces (js/entities.js):
  - `const LAG_COMP_MAX_MS = 250;` `const LAG_HISTORY_TICKS = 32;` `const SIM_STEP_MS = 1000 / 60;`
  - `function createBodyHistory()` -> `{ ticks: Int32Array(32) filled -1, xs: Float32Array(32), ys: Float32Array(32) }`
  - `function bodyHistoryRecord(history, tick, x, y)` writes slot `tick % LAG_HISTORY_TICKS`.
  - `function bodyHistoryLookup(history, tick, out)` -> boolean; true only when the slot holds exactly `tick`; then sets `out.x`, `out.y`. No allocation.
  - `function lagMsToTicks(lagMs)` -> `Math.round(clamp(lagMs, 0, LAG_COMP_MAX_MS) / SIM_STEP_MS)`; non-finite -> 0.
- Produces (js/net.js):
  - `const NET_PREDICTED_SHOT_TTL_MS = 1000;`
  - `function netLagCompMs(stats)` -> `0` when `stats.inputRtt == null`; else `round((inputRtt + interpDelay) / 5) * 5` clamped to `[0, LAG_COMP_MAX_MS]`.
  - `function netPredictedShotPush(queue, now)` pushes `now`.
  - `function netPredictedShotConsume(queue, now)` -> boolean: drops entries older than `now - TTL` from the front, then shifts one and returns true, or returns false if empty.

- [ ] **Step 1: Write failing tests** in `server/test-fire-prediction.mjs`, loading helpers with `readSource`/`extractTopLevel` into a `vm` context exactly like `server/test-net-stats.mjs` (`ok(cond,msg)` counters, non-zero exit on failure). Assertions:
  - history: record ticks 100..131, `lookup(100+k)` true with the stored xy; record tick 132, then `lookup(100)` false (slot overwritten) and `lookup(132)` true; fresh history `lookup(5)` false; `lookup` writes into the passed `out` object and returns the same coordinates on repeated calls.
  - `lagMsToTicks`: `0 -> 0`, `150 -> 9`, `250 -> 15`, `5000 -> 15`, `-20 -> 0`, `NaN -> 0`.
  - `netLagCompMs`: `{inputRtt:null, interpDelay:50} -> 0`; `{inputRtt:100, interpDelay:50} -> 150`; `{inputRtt:101, interpDelay:51} -> 150`; `{inputRtt:900, interpDelay:150} -> 250`.
  - queue: push at 0, consume at 100 -> true, consume again -> false; push at 0, consume at 1500 -> false (expired); push 0 and 1400, consume at 1500 -> true (second entry survives, first expired).
- [ ] **Step 2: Run** `node server/test-fire-prediction.mjs`. Expected: FAIL (names not defined).
- [ ] **Step 3: Implement** the interfaces above in the listed files; append `&& node test-fire-prediction.mjs` (match the chain's existing form) to `server/package.json`.
- [ ] **Step 4: Run** `node server/test-fire-prediction.mjs`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat(net): lag compensation helpers (LIBRE-31)`.

---

### Task 2: Host lag compensation

**Files:**
- Modify: `js/net.js` `netSendInput` (~line 945-970), `server/index.js:64`, `js/server-sim-glue.js` (`addPlayer` ~line 50-62, `applyInput` ~275, `tickWorld` ~127-172), `js/gameplay.js` `updateBullets` rival loop (~893-909)
- Test: `server/test-fire-prediction.mjs` (sim-level section via `createRoomSim`, see `server/test-sim.mjs:5` and `:59-76` for the PvP duel pattern)

**Interfaces:**
- Consumes: Task 1 helpers and constants.
- Produces: `pl.input.lagMs` (number, 0 default), `pl.hist` (`createBodyHistory()` per player), cmd field `lg`.

- [ ] **Step 1: Write failing sim tests** (same file):
  - Setup: `createRoomSim`, add players A and B, violence on (not `peaceMode()`), both alive. A reports (px,py) = P0; B reports P0 + (100, 0); run ~20 ticks so history fills.
  - Case "no compensation": same tick, B reports P0 + (100, 400) and A fires (`applyInput(A, {aim: 0, b: 2, px, py, seq})`, pistol); run 12 ticks; B health unchanged.
  - Case "compensated": identical but A's input also has `lg: 150`; B health decreased (hit on B's old position).
  - Case "bounded": identical with `lg: 99999` behaves as `lg: 250` (use a setup where B moved 20 ticks before the shot: 250 ms still misses; assert health unchanged).
  - Case "garbage lg": `lg: NaN`, `lg: -50`, `lg: 'x'` -> `_player(A).input.lagMs === 0`, no throw.
  - Case "fallback": B added 1 tick before A fires with `lg: 250` (no history at `frame - 15`): bullet tests against B's current position, no throw.
- [ ] **Step 2: Run** `node server/test-fire-prediction.mjs`. Expected: new cases FAIL.
- [ ] **Step 3: Implement**
  - `netSendInput`: `cmd.lg = netLagCompMs(net.stats)`.
  - `server/index.js:64`: add `'lg'`.
  - `applyInput`: `if (cmd.lg != null) i.lagMs = Number.isFinite(cmd.lg) ? Math.min(LAG_COMP_MAX_MS, Math.max(0, cmd.lg)) : 0;` (non-number strings give 0). Player `input` default has `lagMs: 0`.
  - `addPlayer`: `hist = createBodyHistory()` on the player object.
  - `tickWorld`: after `saveP(pl)` inside the per-player loop, `bodyHistoryRecord(pl.hist, frame, (pl.car || pl).x, (pl.car || pl).y)`. Verify `frame` does not advance between this record and `updateBullets()` of the same tick; if it does, record with the value `updateBullets` will see.
  - `updateBullets` rival loop: before the car/foot test compute `const lagTicks = lagMsToTicks(b.owner.input.lagMs)` once per bullet (guard `b.owner && b.owner.input`); per rival, if `lagTicks > 0 && bodyHistoryLookup(v.hist, frame - lagTicks, REWIND_SPOT)` use `REWIND_SPOT.x/.y` as the centre in place of `c.x,c.y` (car box) or `v.x,v.y` (foot); otherwise current position. `REWIND_SPOT` is one module-level `{x:0,y:0}` reused (grep-check name). Damage/sparks/credit keep real positions. The shared PvP `v === b.owner` and `downT` checks stay.
- [ ] **Step 4: Run** `node server/test-fire-prediction.mjs`. Expected: PASS. Then by name `test-sim-stubs.mjs`, `test-sim-worker.mjs`, `test-hot-paths.mjs`, `test-host-mode.mjs`: PASS.
- [ ] **Step 5: Commit** `feat(sim): rewind rival hit test by shooter latency (LIBRE-31)`.

---

### Task 3: Shooter tags on fx and snapshot bullets

**Files:** Modify `js/server-sim-glue.js` (`spawnMuzzle` intercept ~line 223, bullets in `snapshotFor` ~252, per-player loop in `tickWorld`); Test: `server/test-fire-prediction.mjs`.

**Interfaces:**
- Produces: muzzle fx `{k:0, x, y, a, o}` where `o` is the shooter's player id only when fired in the per-player phase; snapshot bullet `{x,y,a,hostile,fl,o}` where `o = b.owner.id` only when `b.fromPlayer && b.owner`, else absent.

- [ ] **Step 1: Write failing tests** (sim): A fires; `snapshotFor(B)` has a `fx` entry with `k === 0 && o === A` and a `bul` entry with `o === A`; make a cop/army shot happen (or push a hostile bullet and call the muzzle path in the shared phase as `test-police.mjs`/`test-army.mjs` do) and assert its muzzle fx has `o === undefined`; hostile bullets have no `o`.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement** a module-level `__shooterId` (grep-check) set to `pl.id` at the start of each per-player iteration and `null` after the loop; the `spawnMuzzle` intercept adds `o: __shooterId` only when non-null; bullet payload adds `o` as above. Keep payload shape otherwise unchanged.
- [ ] **Step 4: Run** the file plus by name `test-sim-stubs.mjs`, `test-sim-worker.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sim): tag muzzle fx and player bullets with shooter id (LIBRE-31)`.

---

### Task 4: Client prediction and suppression

**Files:** Modify `js/net.js` (`net` state object ~line 47 + reset in `netShutdown`, `updateNetClient` ~973-992, `netOnSnapshot` ~832, `netApplyFx` ~865, bullet copy ~886-897); Test: `server/test-fire-prediction.mjs`.

**Interfaces:**
- Consumes: Task 1 queue helpers, Task 3 `o` tags.
- Produces: `net.predBullets: []`, `net.predictedShots: []` (both reset in `netShutdown`); `function netPredictFire()`; `function netStepPredictedBullets()`.

- [ ] **Step 1: Write failing tests** (vm, extracting `netApplyFx` and the helpers with stubs `spawnMuzzle`, `hear`, `sfx`, `net`, `performance`-style `now` injected by the test):
  - own muzzle (`o === net.myId`) with one fresh predicted shot: flash and sound not called, queue emptied.
  - own muzzle with empty queue: flash and `sfx.copShoot` called (late play).
  - own muzzle with only an expired entry: played; queue emptied of the expired entry.
  - foreign muzzle (`o` other or undefined): always played, queue untouched.
  - snapshot filter: a function-level test (extract the bullet-mapping into a small named pure helper `netWorldBulletsFrom(bul, myId)` and test it) drops bullets with `o === myId`, keeps others, keeps hostile ones.
  - `netStepPredictedBullets` (stub `solidTile`): bullet advances `vx,vy`, `life` decrements, is removed at `life <= 0` and when `solidTile` is true at its position; removal causes no spark/fx call.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement**
  - `netPredictFire()` called in `updateNetClient` after the click latch (line ~975) and **before** local `updatePlayerFoot()` (~986), because that call clears `mClicked`. Gate: weapon `WEAPONS[player.weaponIdx]` not melee, not rocket/grenade (those use `rockets[]`), client mirror of me-down false, not in a car, `!peaceMode()`, `(w.auto ? mDownL : mClicked)`, `player.shootCd === 0`. On pass: `player.shootCd = w.cd`; push `w.pellets || 1` local bullets using the same math as `playerShoot` (`js/gameplay.js:81-94`: spread, 14 px offset, `w.spd`, `w.life`, `fromPlayer: true`, `flame: w.fire`); `spawnMuzzle(bx, by, player.aim)`; `(sfx[w.sfx] || sfx.shoot)()`; `netPredictedShotPush(net.predictedShots, performance.now())` once per shot. No `shake()`, no `netShotFired`.
  - `netStepPredictedBullets()` once per frame next to the existing extrapolation (~886): advance, decrement life, drop on `solidTile(b.x, b.y)` or `life <= 0`.
  - Bullet copy (~897): after copying `net.wbullets`, append `net.predBullets`.
  - `netOnSnapshot` line 832: use `netWorldBulletsFrom(m.bul, net.myId)` (maps as today, adds `fromPlayer: true` when `o != null`, filters own).
  - `netApplyFx` k:0: `if (e.o === net.myId && netPredictedShotConsume(net.predictedShots, performance.now())) return;` before the existing flash and sound.
- [ ] **Step 4: Run** the file plus by name `test-net-stats.mjs`, `test-hot-paths.mjs`, `test-sim-worker.mjs`, `test-sim-host.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(net): client-side fire prediction with duplicate suppression (LIBRE-31)`.

---

## Self-review

- Spec coverage: latency field (T1, T2), history + rewind + bound (T1, T2), fx/bullet tags (T3), prediction + dedupe (T4), unit tests for lookup, suppression, lag field (T1, T4). Non-goals (rockets, melee, peds) deliberately absent.
- Types: `lagMs` (host input), `lg` (wire), `lagMsToTicks`, `netLagCompMs`, `bodyHistoryLookup(history, tick, out)` are used identically in T1/T2.
- Open point for the builder (marked in spec): `frame` timing in `tickWorld`, exact client down-state mirror field.

## Execution

Subagent-driven, one implementer subagent continued through Tasks 1-4 (swap to a fresh one past ~120k tokens), then PR, CI on the PR, merge to main, verify deploy job, then browser-agent check in prod.
