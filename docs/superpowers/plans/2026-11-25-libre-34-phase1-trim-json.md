# LIBRE-34 Phase 1: trimmed JSON snapshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink every multiplayer `W` snapshot without changing its shape for the client: static driving physics only on the local player's own car, car angles and aim angles quantized.

**Architecture:** Only the host-side payload builders in `js/server-sim-glue.js` change. The client decoder in `js/net.js` already reads physics only from `me.car` (`netMakePlayerCar`) and never reads it from world or remote-player cars, so no client change is needed. Phases 2 (binary codec) and 3 (ack-based delta) get their own plans after this one ships.

**Tech Stack:** Plain browser JS (global scope, no modules), Node test scripts under `server/` that load the sim bundle into a `vm` context (`server/sim-runtime.js`, `js/sim-stubs.js`).

**Spec:** task LIBRE-34 on the LIBRE board (description + DoD), phase 1 criterion: "top/acc/mass/gears sent only where needed, an and aim quantized, host-mode, sim-worker, sim-host and server-sim tests green, bandwidth reduction measured and documented".

## Global Constraints

- Work in the worktree `.tmp/wt-libre34` (branch `feat/libre-34-snapshots`). Never touch the main checkout (`feat/libre-20-21-vehicles-dents`, another session).
- No code comments (user rule); English identifiers.
- CI runs Node 22; local is Node 24. Use only APIs available in Node 22.
- Do not run `npm test` (a hook blocks it). Run single test files with `node server/<file>.mjs`.
- Scratch output only in `.tmp/` (already in `.gitignore`).
- `MULTIPLAYER.md` is written in Italian: keep that language there.

## Review Focus

1. Guest gets into a car mid-match: its first snapshot with `me.car` must carry `top/acc/mass/gears`, otherwise prediction falls back to the defaults 4/0.08/1/4 and the car drives wrong. Covered by Task 1 test (client round trip through `netMakePlayerCar`).
2. Remote player in a car: `players[].car` loses physics; the client must not need it (it uses `netApplyCar` + interpolation only). Covered by Task 1 test (no physics keys in `players[].car`).
3. Angles beyond ±π (car `angle` accumulates while turning): quantization must not wrap or clamp, only round. Covered by Task 1 test with an angle of `7.123456`.
4. Tank turret `tur`, bullet/rocket `a`, fx `a` stay unrounded in this phase (out of scope; phase 2 codec quantizes them). No test.
5. Peer-mode (non-host) protocol messages are built in `js/net.js`, not by `carPayload`: unaffected. No test.

---

### Task 1: Trim car physics and quantize angles in snapshot payloads

**Files:**
- Modify: `js/server-sim-glue.js:200-221` (`R2`, `carPayload`, `pedPayload`, `playerView`) and `:243,247` (`me.aim`, `me.car` inside `snapshotFor`)
- Create: `server/test-snapshot-payload.mjs`
- Modify: `server/package.json` (`"test"` script: append `&& node test-snapshot-payload.mjs`)

**Interfaces:**
- Produces: `round2(value: number) -> number` (rounds to 0.01) and `drivenCarPayload(car) -> object` (= `carPayload(car)` plus `top`, `acc`, `mass`, `gears`), both top-level in `js/server-sim-glue.js`. `carPayload(car)` no longer contains `top/acc/mass/gears`.

- [ ] **Step 1: Write the failing test `server/test-snapshot-payload.mjs`**

Harness: copy the `loadSim` / `ok` / pass-fail exit pattern from `server/test-vehicles.mjs:1-14` (exit code 1 when `fail > 0`, same as that file). Scenario inside one `loadSim('PSNAP01').run(...)` IIFE:
- `__sim.addPlayer('Ann', 0, 'pA')` and `__sim.addPlayer('Bob', 1, 'pB')`; put both next to each other (`x`, `y` equal to the first player's spawn).
- Give each a spider: `const car = makeSpider(makeCar(x, y, 'traffic')); car.driver = 'player'; pl.car = car;` then set `carA.angle = 7.123456`, `carB.angle = -1.987654`, `playerA.aim = 2.345678`, `playerB.aim = -0.004999`.
- `const snap = JSON.parse(JSON.stringify(__sim.snapshotFor('pA')))`.

Client half: in a second context, load `interpFeed` stub + `extractTopLevel(netSource, 'netApplyCar' | 'netMakeWorldCar' | 'netMakePlayerCar')` exactly as `server/test-vehicles.mjs:104-106` does, then `netMakePlayerCar(snap.me.car)`.

Assertions:
```js
ok(snap.me.car.top === 7.5 && snap.me.car.acc === 0.22 && snap.me.car.mass === 0.8 && snap.me.car.gears === 5, 'own car carries driving physics');
ok(snap.cars.length > 0, 'the AOI holds world cars');
const physicsKeys = ['top', 'acc', 'mass', 'gears'];
ok(snap.cars.every(c => physicsKeys.every(k => !(k in c))), 'world cars carry no driving physics');
ok(snap.players.every(p => !p.car || physicsKeys.every(k => !(k in p.car))), 'remote player cars carry no driving physics');
ok(snap.me.car.an === 7.12, 'own car angle rounded to 0.01 without wrapping');
ok(snap.players[0].car.an === -1.99, 'remote car angle rounded to 0.01');
ok(snap.me.aim === 2.35 && snap.players[0].aim === 0, 'aim rounded to 0.01');
const quantized = v => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9;
ok(snap.cars.every(c => quantized(c.an)), 'every world car angle is quantized');
ok(predicted.top === 7.5 && predicted.accel === 0.22 && predicted.mass === 0.8 && predicted.gears === 5, 'client prediction gets the real physics, not the defaults');
```
(`players[0].aim === 0`: `Math.round(-0.4999) / 100` is `-0`; JSON turns `-0` into `0`.)

- [ ] **Step 2: Run it, expect failures**

Run: `node server/test-snapshot-payload.mjs` (from the worktree root). Expected: FAIL on the "no driving physics" and "rounded" lines; the own-car physics line already passes.

- [ ] **Step 3: Implement in `js/server-sim-glue.js`**

- Add `const round2 = v => Math.round(v * 100) / 100;` next to `R2`; use it for `sp` and `wk` (replacing the inline `Math.round(x * 100) / 100`), for `an` in `carPayload`, and for `aim` in `playerView` and in `snapshotFor`'s `me`.
- Remove `top/acc/mass/gears` (and the comment above them) from `carPayload`.
- Add `function drivenCarPayload(c)` returning `{ ...carPayload(c), top: c.top, acc: c.accel, mass: c.mass, gears: c.gears }`; `snapshotFor` uses it for `me.car`. `playerView` keeps `carPayload`.
- Do not touch `js/net.js`.

- [ ] **Step 4: Run the new test and the regression set**

Run each, expect `0 failed` / exit 0:
```
node server/test-snapshot-payload.mjs
node server/test-vehicles.mjs
node server/test-dents.mjs
node server/test-host-mode.mjs
node server/test-sim-worker.mjs
node server/test-sim-host.mjs
node server/test-server-sim.mjs
node server/test-sim.mjs
```
(`test-server-sim` starts the real server on port 8788; it needs `npm ci` in `server/` once in a fresh worktree.)

- [ ] **Step 5: Commit**

```bash
git add js/server-sim-glue.js server/test-snapshot-payload.mjs server/package.json
git commit -m "perf(net): send car physics only for the driven car, quantize angles"
```

### Task 2: Measure and document the bandwidth change

**Files:**
- Modify: `MULTIPLAYER.md:84-101` (section "**Banda**")

**Interfaces:**
- Consumes: Task 1 commit. Baseline numbers (main `adc6bb8`, level 6) are in `.tmp/bw-before.txt`.

- [ ] **Step 1: Measure after**

Run from the worktree root: `for s in 1 2 3 4 5; do SEED=$s LEVEL=6 node .tmp/host-bandwidth.mjs; done | tee .tmp/bw-after.txt`. The script (`.tmp/host-bandwidth.mjs`) drives the real worker in the `server/test-sim-worker.mjs` harness, 4 players, 10 s.

- [ ] **Step 2: Document**

Add to the "**Banda**" section of `MULTIPLAYER.md` a table "LIBRE-34 fase 1" with rows raw KB/s, average raw frame bytes, no-context-takeover KB/s, context-takeover KB/s, columns "prima (adc6bb8)" and "dopo" as seed 1-5 mean / max, plus one sentence: raw matters now because the P2P `fast` channel (LIBRE-33) sends without deflate.

- [ ] **Step 3: Commit**

```bash
git add MULTIPLAYER.md
git commit -m "docs(net): LIBRE-34 phase 1 bandwidth before and after"
```
