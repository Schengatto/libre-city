# New Vehicles and Dents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bus, lorry and racing spider in AI traffic, drivable and drawn with their own bodies (LIBRE-20); per-side dents that grow with damage and reach every client (LIBRE-21).

**Architecture:**
- Vehicle types are `makeMoto`-style modifiers in `js/entities.js`; the type travels in the existing `livery` / `liv` field.
- Dents live in the sim (`js/gameplay.js`, next to `damageCar`): per-zone damage stays server-side, packed levels travel as one optional `dn` field.
- Clients (`js/net.js`, `js/render.js`) only decode and draw.

**Tech Stack:** Plain global-scope browser JS (classic scripts, no modules), Canvas 2D, Node test scripts (`server/test-*.mjs`, `vm` + `BUNDLE`).

**Spec:** `docs/superpowers/specs/2026-11-24-vehicles-dents-design.md`

## Global Constraints

- Every new top-level name is unique across `js/*.js`: `VEHICLE_MAX_W`, `VEHICLE_MAX_H`, `vehicleColH`, `makeBus`, `makeLorry`, `makeSpider`, `dressTrafficCar`, `DENT_THRESHOLDS`, `DENT_ZONE`, `dentZone`, `dentLevel`, `addDent`, `drawBusCabin`, `drawLorryCabin`, `drawSpiderCockpit`, `drawCarDents`.
- No code comments (user rule), except where an existing comment line you edit must stay accurate (e.g. the `CAR_REACH` comment): update it, do not add new ones.
- English identifiers only.
- Traffic spawn randomness stays on `Math.random`.
- Undamaged cars add zero bytes to the snapshot: `dn` is `undefined` when `c.dents` is 0.
- Read code with Read offset/limit or Grep, never `cat`/`sed`/`head`; one Edit per file region group; no `git diff` after each edit; run your task's tests once, at the end. No full suite, lint or build inside a task: CI on the PR is the gate.
- Every new test file is appended to the `"test"` script chain in `server/package.json`.

### Test harness (copy into each new test file)

```js
import vm from 'node:vm';
import runtime from './sim-runtime.js';
import stubs from '../js/sim-stubs.js';
import { readSource, extractTopLevel, createRecordingContext } from './render-test-kit.mjs';
const { BUNDLE } = runtime;
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };
function loadSim(code = 'PVEH01') {
  const context = vm.createContext(stubs.makeSimStubs(code, 900, { setTimeout, clearTimeout, setInterval, clearInterval }));
  vm.runInContext(BUNDLE, context, { timeout: 5000 });
  return { context, run: expr => vm.runInContext(expr, context) };
}
// ... tests ...
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

Client-only functions (`net.js`, `render.js`) are loaded into the same context with `vm.runInContext(extractTopLevel(readSource('net.js'), 'netApplyCar') + '\n' + ..., context)`, plus stubs for the globals they touch (`interpFeed`, `ctx`, `camX`, `camY`, `player`, `frame`, …).

## Review Focus

1. **Spawn mix moved before the spacing check changes the RNG order.** A bus re-rolled on every failed spacing attempt must not bias the mix. Task 1's test `traffic mix rates` measures the rates through `dressTrafficCar` directly, not through spawns.
2. **A long bus spawned next to a saloon overlaps it.** Task 1's test `spawn spacing respects length` forces a bus and checks every non-parked pair.
3. **Remote client decodes a bus with the saloon `colH` 13.** Task 2's test `world car colH from h` covers `netMakeWorldCar`; the guard `colH derived in netParkCar and remote car` covers the other two sites.
4. **The client's own car keeps a stale or local dent.** Task 5's guard `netReconcileMe copies me.car.dn` pins the overwrite.
5. **A future `damageCar(` call without direction silently never dents.** Task 4's guard `every damageCar call passes a direction` reads all of `js/`.

---

## LIBRE-20 — vehicles

### Task 1: Vehicle factories, traffic mix, spacing, broad-phase

**Files:**
- Modify: `js/entities.js:215-235` (`makeCar`, use `vehicleColH`), after `makeMoto` `:256-265` (new factories), `:369-384` (`spawnTrafficNear`)
- Modify: `js/gameplay.js:755-757` (`CAR_REACH`)
- Create: `server/test-vehicles.mjs`
- Modify: `server/package.json` (test chain)

**Interfaces:**
- Produces:
  - `const VEHICLE_MAX_W = 88, VEHICLE_MAX_H = 30;` (entities.js, top of the factories section)
  - `vehicleColH(isBike: boolean, h: number): number` — `8` for bikes, else `Math.floor(h / 2) + 1`
  - `makeBus(c) → c`, `makeLorry(c) → c`, `makeSpider(c) → c` — mutate and return the car
  - `dressTrafficCar(c) → c` — applies at most one of bus/lorry/spider/taxi/bike
  - `CAR_REACH = Math.ceil(Math.hypot(VEHICLE_MAX_W, VEHICLE_MAX_H))` (= 93)

- [ ] **Step 1: Write the failing tests in `server/test-vehicles.mjs`**

Use `loadSim()`. Tests (each an `ok(...)`):

- `factory sizes and physics`: for each of `makeBus`, `makeLorry`, `makeSpider` applied to `makeCar(0,0,'traffic')`, assert exactly:

| | livery | w | h | colH | mass | accel | top | maxSpeed | gears | hornKind | hornF |
|---|---|---|---|---|---|---|---|---|---|---|---|
| bus | `'bus'` | 88 | 28 | 15 | 3.0 | 0.05 | 4.2 | 1.9 | 5 | `'truck'` | 150 |
| lorry | `'lorry'` | 76 | 28 | 15 | 2.6 | 0.06 | 4.5 | 2.0 | 5 | `'truck'` | 175 |
| spider | `'spider'` | 42 | 22 | 12 | 0.8 | 0.22 | 7.5 | 3.3 | 5 | `'car'` | 420 |

  Also: spider has a string `helmet` and `riderShirt`; none of the three has `isTaxi`/`isBike` truthy.
- `vehicleColH keeps existing values`: `vehicleColH(false,24)===13`, `(false,26)===14`, `(false,30)===16`, `(true,12)===8`, `(false,28)===15`, `(false,22)===12`.
- `every vehicle fits the max box`: build a saloon, taxi, bike, the three new types, and every `makeServiceCar` type (`'police'`, `'hospital'`, `'fire'`, `'bank'`, `'market'`, `'gunshop'`, `'army'`, `'pizzeria'` with a dummy `{x:0,y:0,angle:0}`; skip a type the function rejects) plus `makeArmyCar` if callable with a dummy; assert `w <= VEHICLE_MAX_W && h <= VEHICLE_MAX_H` for all.
- `CAR_REACH covers the largest pair`: `CAR_REACH >= Math.hypot(VEHICLE_MAX_W, VEHICLE_MAX_H)` and `CAR_REACH === 93`.
- `traffic mix rates`: call `dressTrafficCar(makeCar(0,0,'traffic'))` 20000 times; bus share in [0.03, 0.05], lorry in [0.05, 0.07], spider in [0.012, 0.028]; no car with two of {bus, lorry, spider, isTaxi, isBike}.
- `spawn spacing respects length`: with `Math.random` patched in the context so `dressTrafficCar` always returns a bus for the first call (e.g. temporarily replace `dressTrafficCar` with `c => makeBus(c)` via `run`), spawn 60 cars with `spawnTrafficNear` around the map centre (push each into `cars`), then assert for every pair of non-parked cars `dist > (a.w + b.w) / 2 + 24 - 0.001`.

- [ ] **Step 2: Run** `node server/test-vehicles.mjs` — expected FAIL (`makeBus is not defined`).

- [ ] **Step 3: Implement in `js/entities.js`**

- `makeCar`: `colH: vehicleColH(false, 24)` instead of the literal 13. Other factories that set `colH` explicitly (`makeMoto`, fire, tank, `makeArmyCar`) switch to `vehicleColH(isBike, h)` with their own `h`; values stay identical.
- `makeBus`/`makeLorry`/`makeSpider`: set the table values. Colours: bus `pick(['#2f7bd6','#d6452f','#2fa36b','#e0a21f'])`; lorry cab `pick(CAR_COLORS)` and `c.cargo = '#e6e2d8'`; spider `pick(['#e0201f','#ffcf1f','#1fa0e0','#f2f4f8'])`, `c.helmet = pick(['#e0e0e8','#d23a3a','#2a2a2e','#ffd23a'])`, `c.riderShirt = pick(CIV_SHIRTS)`. `hornF` exact as in the table (no jitter, so the test can pin it).
- `dressTrafficCar`: one `Math.random()` roll `< 0.04` bus, `< 0.10` lorry, `< 0.12` spider; otherwise the existing `Math.random() < 0.18` taxi, else `Math.random() < 0.14` bike.
- `spawnTrafficNear`: call `dressTrafficCar(c)` right after `makeTrafficCar`, before the spacing test; spacing becomes `dist(o.x, o.y, c.x, c.y) < (o.w + c.w) / 2 + 24`; the old taxi/moto lines go.

- [ ] **Step 4: Implement in `js/gameplay.js`**: `CAR_REACH` as in Interfaces; update its comment line to say it is the diagonal of the largest box (`VEHICLE_MAX_W`×`VEHICLE_MAX_H`).

- [ ] **Step 5: Add `node test-vehicles.mjs` to the `server/package.json` test chain; run** `node server/test-vehicles.mjs` and `node server/test-traffic.mjs` — expected all OK.

- [ ] **Step 6: Commit** `feat(vehicles): bus, lorry and spider factories in traffic (LIBRE-20)`.

### Task 2: Client decode derives `colH` from size

**Files:**
- Modify: `js/net.js:386` (remote player car), `:412` (`netParkCar`), `:627` (`netMakeWorldCar`)
- Modify: `server/test-vehicles.mjs`

**Interfaces:**
- Consumes: `vehicleColH(isBike, h)` (Task 1), `carPayload(c)` (server-sim-glue.js, unchanged).

- [ ] **Step 1: Add failing tests**
  - `world car colH from h`: in the `loadSim()` context, run `function interpFeed(){}` plus `extractTopLevel(net, 'netApplyCar')` and `extractTopLevel(net, 'netMakeWorldCar')`. For a bus, lorry and spider: `netMakeWorldCar(JSON.parse(JSON.stringify(carPayload(car))))` gives the same `livery`, `w`, `h` and `colH === car.colH`. Same for a saloon (13) and a bike (8).
  - `colH derived in netParkCar and remote car`: code-reading guard on `readSource('net.js')`: the bodies of `netParkCar` and `netApplyRemote` (via `extractTopLevel`) contain `vehicleColH(` and no `colH: 13`.

- [ ] **Step 2: Run** `node server/test-vehicles.mjs` — expected FAIL on both new tests.

- [ ] **Step 3: Implement**: `netMakeWorldCar` `colH: vehicleColH(cp.bike, cp.h)`; `netParkCar` `colH: vehicleColH(p.bike, p.h)`; remote player car `colH: vehicleColH(m.c.bike, m.c.h)`. The remote cop object (`:430`) stays at 13.

- [ ] **Step 4: Run** `node server/test-vehicles.mjs` — expected all OK.

- [ ] **Step 5: Commit** `feat(net): derive vehicle collision size from its height (LIBRE-20)`.

### Task 3: Bodies for bus, lorry and spider

**Files:**
- Modify: `js/render.js:1956-1959` (`drawTyres` only if you add an axle parameter), `:1996-2010` (`drawCar` cabin dispatch), new functions next to `drawVanCabin` (`:1972`)
- Modify: `server/test-vehicles.mjs`

**Interfaces:**
- Consumes: `c.livery` values `'bus' | 'lorry' | 'spider'`, `c.cargo`, `c.helmet`, `c.riderShirt` (Task 1).
- Produces: `drawBusCabin(c, hw, hh)`, `drawLorryCabin(c, hw, hh)`, `drawSpiderCockpit(c, hw, hh)` — draw in the car's local frame (already translated and rotated, +x forward).

- [ ] **Step 1: Add failing tests** (render smoke)
  - Load into a fresh `vm` context (no sim needed) the render declarations `drawCar` depends on, via `extractTopLevel` on `render.js` (at least `shade`, `roundRect`, `bodyPaint`, `drawTyres`, `drawGlassGlint`, `GLASS_COLOR`, `drawSaloonCabin`, `drawVanCabin`, `drawCarLights`, `BRAKE_DECELERATION`, the three new functions, `drawCar`; add any other the loader reports missing) and `TAU` from `core.js`. Stubs: `ctx` from `createRecordingContext()`, `camX = camY = 0`, `frame = 0`, `player = { shirt: '#123456' }`, `t = k => k`, `playerSirenOn = () => false`, `drawVehicleShadow = () => {}`, `drawCarFlames = () => {}`, `drawBike`, `drawTank` no-ops.
  - `each new body draws through its own cabin`: wrap the four cabin functions to record which ran; `drawCar` on a bus runs only `drawBusCabin`, lorry only `drawLorryCabin`, spider only `drawSpiderCockpit`, an ambulance only `drawVanCabin`, a saloon only `drawSaloonCabin`.
  - `spider shows its driver when occupied`: `drawCar` on a traffic spider sets `fillStyle` to `c.riderShirt` and to `c.helmet`; a parked spider with `driver: null` sets neither; with `driver: 'player'` the torso uses `player.shirt`.

- [ ] **Step 2: Run** `node server/test-vehicles.mjs` — expected FAIL (`declaration not found: drawBusCabin`).

- [ ] **Step 3: Implement**
  - `drawCar`: before the existing `if (c.livery && c.livery !== 'army')`, dispatch `'bus'` → `drawBusCabin`, `'lorry'` → `drawLorryCabin`, `'spider'` → `drawSpiderCockpit`.
  - Shapes (art details are the implementer's, per spec "Left to the builder"):
    - bus: roof panel almost full length, window band along both long sides, windscreen strip at `+x`, two roof hatches;
    - lorry: short cab at `+x` with windscreen, dark gap line, cargo box in `c.cargo` over the rest with ribs;
    - spider: low windscreen, two seats, roll bar, two racing stripes; driver torso (`player.shirt` when `c.driver === 'player'`, else `c.riderShirt || '#3a72d2'`) and helmet (`c.helmet`) when `c.driver || c.role === 'traffic' || c.role === 'police'`.
  - Bus and lorry get a rear double axle (an extra tyre pair just ahead of the rear one).

- [ ] **Step 4: Run** `node server/test-vehicles.mjs` and `node server/test-buildings.mjs` (shares the render kit) — expected all OK.

- [ ] **Step 5: Commit** `feat(render): bus, lorry and spider bodies (LIBRE-20)`.

## LIBRE-21 — dents

### Task 4: Dent model and impact directions

**Files:**
- Modify: `js/gameplay.js:940-947` (`damageCar`; new dent helpers just above it), call sites `:827`, `:862`, `:927-928`, `:1001`
- Modify: `js/army.js:78`, `js/train.js:82`
- Create: `server/test-dents.mjs`; Modify: `server/package.json`

**Interfaces:**
- Produces:
  - `const DENT_ZONE = { front: 0, rear: 1, left: 2, right: 3 };`
  - `const DENT_THRESHOLDS = [8, 24, 48];`
  - `dentZone(c, impactAngle: number) → 0..3` — `rel = angDiff(c.angle, impactAngle + Math.PI)`; `|rel| <= PI/4` front, `>= 3PI/4` rear, `rel > 0` right, else left
  - `dentLevel(dents: number, zone: number) → 0..3` — `(dents >> (2 * zone)) & 3`
  - `addDent(c, dmg, impactAngle)` — no-op for `c.isBike`, `c.isTank`, or non-finite `impactAngle`; lazily creates `c.dentDamage = [0,0,0,0]`; adds `dmg`; sets the zone bits of `c.dents` (init `0`) to the count of thresholds reached
  - `damageCar(c, dmg, angle, chain)` calls `addDent(c, dmg, angle)` first. `angle` = direction the impact travels.

- [ ] **Step 1: Write failing tests in `server/test-dents.mjs`** (harness from Global Constraints, `loadSim()`)
  - `zone from angle`: car `{ angle: 0 }`: impact angle `Math.PI` → front, `0` → rear, `Math.PI / 2` → left, `-Math.PI / 2` → right. Car `{ angle: Math.PI / 2 }`: impact `-Math.PI / 2` → front. Boundaries (car angle 0, so `rel` = impact − π): impact `Math.PI + (Math.PI / 4 - 0.01)` → front, `Math.PI + (Math.PI / 4 + 0.01)` → right, `Math.PI - (Math.PI / 4 + 0.01)` → left, `Math.PI + (3 * Math.PI / 4 + 0.01)` → rear.
  - `levels grow and cap`: fresh saloon, `addDent(c, 7, Math.PI)` → front level 0; `+1` (total 8) → 1; total 24 → 2; total 48 → 3; total 500 → 3; other zones still 0.
  - `bit packing`: after front 3, rear 1, left 2, right 0: `c.dents === (3 | 1 << 2 | 2 << 4)` and `dentLevel` returns each.
  - `no dents on bikes, tanks or without direction`: `makeMoto` car, a tank (`isTank: true`), and `addDent(c, 50, undefined)` / `NaN` leave `c.dents` falsy.
  - `damageCar dents the struck side`: `damageCar(c, 30, 0)` on a saloon facing 0 → rear level 2, health 70.
  - `every damageCar call passes a direction` (code-reading guard): scan `gameplay.js`, `army.js`, `train.js`, `server-sim-glue.js`, `missions.js`, `input.js`, `net.js` via `readSource`; for every `damageCar(` call that is not the declaration, split top-level arguments (track parentheses depth) and assert ≥ 3 arguments and that the third is not `undefined`.

- [ ] **Step 2: Run** `node server/test-dents.mjs` — expected FAIL (`addDent is not defined`).

- [ ] **Step 3: Implement** the helpers and the `damageCar` hook, then pass directions:

| Site | Third argument |
|---|---|
| `gameplay.js:827` | `other === b ? Math.atan2(ny, nx) : Math.atan2(-ny, -nx)` |
| `gameplay.js:862` | `Math.atan2(-ny, -nx)` |
| `gameplay.js:927` and `:928` | `Math.atan2(b.vy, b.vx)` (`:927` keeps `damageCar(c, 1, …)` for the tank; `addDent` ignores tanks) |
| `gameplay.js:1001` | `Math.atan2(o.y - c.y, o.x - c.x)` (keep `chain + 1` as 4th) |
| `army.js:78` | `Math.atan2(o.y - r.y, o.x - r.x)` |
| `train.js:82` | `Math.atan2(pushX * s.sin + pushY * s.cos, pushX * s.cos - pushY * s.sin)` (the world push from `:80`) |

- [ ] **Step 4: Add `node test-dents.mjs` to the test chain; run** `node server/test-dents.mjs`, `node server/test-rail.mjs`, `node server/test-army.mjs` — expected all OK.

- [ ] **Step 5: Commit** `feat(dents): per-side dent levels from impact direction (LIBRE-21)`.

### Task 5: Dents over the network

**Files:**
- Modify: `js/server-sim-glue.js:197-206` (`carPayload`)
- Modify: `js/net.js:328-335` (`carNetPayload`), `:393` (`netApplyRemote` car), `:417` (`netParkCar`), `:618-625` (`netApplyCar`), `:759` (`netReconcileMe`)
- Modify: `server/test-dents.mjs`

**Interfaces:**
- Consumes: `c.dents` (Task 4).
- Produces: payload key `dn` (packed dents, `undefined` when 0); decoders set `c.dents = <payload>.dn || 0`.

- [ ] **Step 1: Add failing tests**
  - `dn omitted when undamaged`: `JSON.stringify(carPayload(saloon))` does not contain `"dn"`.
  - `dn round trip`: dent a bus (front 2, left 1); `netMakeWorldCar(JSON.parse(JSON.stringify(carPayload(bus))))` (loaded as in Task 2) has `dents === bus.dents`; a later `netApplyCar` with an undamaged payload resets `dents` to 0.
  - `carNetPayload carries dn`: extract `carNetPayload`; `dn` equals `c.dents` when set, absent from JSON when 0.
  - `netReconcileMe copies me.car.dn` and `remote and parked cars decode dn` (code-reading guards): `extractTopLevel(net, 'netReconcileMe')` contains `me.car.dn`; `netApplyRemote` contains `m.c.dn`; `netParkCar` contains `p.dn`.

- [ ] **Step 2: Run** `node server/test-dents.mjs` — expected FAIL on the new tests.

- [ ] **Step 3: Implement**: `dn: c.dents || undefined` in both payload builders; `c.dents = … .dn || 0` in `netApplyCar`, `netApplyRemote` (next to `c.livery = m.c.liv`), `netParkCar`; in `netReconcileMe`'s `me.car && player.car` branch add `player.car.dents = me.car.dn || 0`.

- [ ] **Step 4: Run** `node server/test-dents.mjs`, `node server/test-vehicles.mjs`, `node server/test-server-sim.mjs` — expected all OK.

- [ ] **Step 5: Commit** `feat(net): send dents only for damaged cars (LIBRE-21)`.

### Task 6: Drawing dents

**Files:**
- Modify: `js/render.js` — new `drawCarDents` next to `drawCarLights`; call in `drawCar` between the livery branches (ends `:2051`) and the siren block (`:2054`)
- Modify: `server/test-dents.mjs`

**Interfaces:**
- Consumes: `c.dents`, `dentLevel` is sim-side (gameplay.js is not loaded in the render test): read levels inline as `(c.dents >> (2 * zone)) & 3`, or extract `dentLevel` from `gameplay.js` into the render test context — pick one and keep `render.js` free of a second definition.
- Produces: `drawCarDents(c, hw, hh)` — local frame, draws nothing when `!c.dents`.

- [ ] **Step 1: Add failing tests** (render loader as in Task 3, plus `drawCarDents`)
  - `no dent artwork when undamaged`: recorder calls for `drawCarDents(saloon, 23, 12)` with `dents: 0` are empty.
  - `one notch per dented zone`: `dents` with only front at level 1 → at least one `fill` call, all path points with `x >= hw - 3 * 2.5`; only right at level 3 → path points with `y >= hh - 3 * 2.5`.
  - `deeper with level`: the innermost point of the front notch at level 3 is deeper (smaller x) than at level 1.
  - `stable shape per car`: two calls on the same car record identical call lists; two cars with different `id` record different side-notch positions.
  - `drawCar draws dents on every body`: `drawCar` on a dented bus, lorry, spider and ambulance records `drawCarDents`-produced calls (wrap `drawCarDents` and count).

- [ ] **Step 2: Run** `node server/test-dents.mjs` — expected FAIL (`declaration not found: drawCarDents`).

- [ ] **Step 3: Implement** per spec "Rendering" (LIBRE-21): jagged notch polygon cut into the edge, depth ≈ level × 2 px, filled with `shade(c.color, -0.35)`; darker crease stroke; front/rear span most of the width, sides about a third of the length at an offset from `c.id`. No `Math.random` in the drawing.

- [ ] **Step 4: Run** `node server/test-dents.mjs`, `node server/test-vehicles.mjs` — expected all OK.

- [ ] **Step 5: Commit** `feat(render): crumpled dents on the struck side (LIBRE-21)`.

### Task 7: Headless check, PR

- [ ] **Step 1:** Start the game locally (see `README` / `server/index.js` port) and dispatch the `browser` agent: single player and a 2-tab multiplayer room. Check: bus, lorry and spider in traffic and drivable (enter one of each); spider driver visible; ram a car front, rear and side and see dents appear and deepen; in MP the other tab sees the same bodies and dents. Fix what the check finds, in the task that owns the code.
- [ ] **Step 2:** Push the branch, open one PR covering LIBRE-20 and LIBRE-21; CI (`npm test` + `node build.js`) is the gate.
