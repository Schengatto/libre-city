# Island base, ring railway, orthogonal streets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the army base on a moated island inside the city, turn the railway into a loop around the city, and make the street grid orthogonal.

**Architecture:** All generation stays in `js/city.js` and runs at script load from the seeded RNG (`rnd`/`rndi`/`hash2`), so clients, host worker and server build the same map. Rail geometry lives in `city.js` (the corridor is carved during generation, before `train.js` loads); train kinematics, collisions and drawing stay in `js/train.js`.

**Tech Stack:** Plain browser JS (classic scripts sharing one global scope), Node test scripts (`server/*.mjs`) that load the sim through `server/sim-runtime.js` (`createRoomSim(code)`).

**Spec:** `docs/superpowers/specs/2026-11-23-island-base-ring-railway-design.md`

## Global Constraints

- All `js/*.js` share ONE global scope. Grep every new top-level name across `js/` before adding it (a duplicate `function` name silently overrides the other).
- No code comments (owner rule). Keep existing comments unless they become false; fix false ones.
- English identifiers.
- No new randomness source: generation uses `rnd`/`rndi` (seeded city RNG, order matters) or `hash2`/`hashStr`.
- `PEACE_CITY`: no base, no moat, no bridge. The railway exists in every city.
- Scratch output only in `.tmp/` (gitignored). Map preview: `node .tmp/map-png.cjs <ROOM> <out.png> <MAP_W> <MAP_H>` renders the tile grid to a PNG (3 px per tile); read the PNG to check the layout.
- Tests: run only the test files you wrote or changed, once at the end of the task (`node server/<file>.mjs` from the repo root). Do not run the full suite.
- Read code with Read offset/limit or Grep, never `cat`/`sed`/`head`. Group edits to a file. No `git diff` after each edit.

## Review Focus

1. Medium map (`M…` room codes, 184 x 368): node counts, island fit and rail inset must work on a non-square map. Tests loop over `PABC12`, `MABC12`, `GABC12`.
2. A car or a player standing ON a level crossing when the train arrives: blocked cars stay, the locomotive crushes them (unchanged rule), no car is pushed inside a building.
3. Wrap-around of the loop: the train straddling `s = 0` must be continuous and still block crossings near `s = 0`.
4. The bridge axis versus the gate: the gate opening must face the bridge, the driveway must connect, guards still reach their posts (test-army sections 1-4 keep passing).
5. Peace city (`PEACE_CITY`): no island, no dead junction, no broken roads.

---

### Task 1: Orthogonal street grid and island base

**Files:**
- Modify: `js/city.js` (constants `:15-17`, `addRoadEdge`/`buildGraph` `:73-111`, `bakeRoads` `:123-131`, army zone `:190-222`, `placeArmyBase` `:346-355`, crosswalk/decal loops `:435-456` only if they need `live`)
- Modify: `js/entities.js:368-369` (drop the `edges[ei].dead` guard only if no edge can be dead any more)
- Modify: `js/render.js` (bridge parapets; `CITY_W` use at `:321` stays valid)
- Modify: `js/server-sim-glue.js` (`_cityWidth` stays, returns `MAP_W`)
- Modify: `server/test-army.mjs` (section 5, `:72-` to its end)
- Create: `server/test-roads.mjs`

**Interfaces:**
- Produces: `MAP_W === CITY_W === _mapDims[0]`. `RIVER_W`, `OUTSKIRTS_W`, `bakeArmyOutskirts` removed.
- Produces: `NX`, `NY` computed from the map size (`round((MAP_W - 2*MARGIN)/24) + 1`, same for `MAP_H`); `colX[i]`, `rowY[j]` (world px, `Float64Array` or arrays) as globals so Task 2 can read the first and last interior line.
- Produces: `armyZone = { x0, y0, x1, y1, island: { x0, y0, x1, y1 }, gateApproach }` (tiles; `island` is the outer edge of the outer bank). `null` in peace cities.
- Produces: nodes `{ x, y, edges, signal, live }`; edges never `dead`.

- [ ] **Step 1: Street grid in `buildGraph()`**

Shared lines: `colX[i] = MARGIN*T + i*pitchX + jitterX(i)`, `rowY[j]` likewise. Border lines (`0`, `NX-1`) jitter 0. Interior jitter `(hash2(i+11, 3) % 1000 / 1000 - 0.5) * pitch * 0.30` (≈ ±15 %). Lines `1` and `NX-2` (and `NY` equivalents): jitter clamped to inward only (`>= 0` for line 1, `<= 0` for line `N-2`). `addRoadEdge(a, b)` without the curve: `cx/cy` = midpoint. Decide the edge set before adding: start from the full grid, choose the army node (Step 2), then prune with the degree rule (an interior edge is removed when `hash2` says so, 1 in 5, and both ends currently have `>= 4` live edges; ring edges never removed). Then call `addRoadEdge` for the survivors. Signals as today.

- [ ] **Step 2: Island reservation (replaces `reserveArmyZone`/`bakeArmyOutskirts`)**

Skip when `PEACE_CITY`. Footprint: fence `ARMY_W x ARMY_H`, then 1 tile grass bank, 3 tiles water, 1 tile pavement outer bank (total 36 x 30). Candidates: `(i, j)` with `2 <= i <= NX-3`, `2 <= j <= NY-3` where the superblock interior (from `colX[i-1] + HALF_ROAD + T` to `colX[i+1] - HALF_ROAD - T`, same in y) is at least footprint + 6 tiles per axis. Pick with `rndi` among candidates; none → the largest superblock. The node gets `live: false` and no edges. Centre the footprint on the superblock centre. Bridge side: `rndi(0, 3)` among the four neighbours; a straight edge from that neighbour along the removed line to a `gateApproach` node placed 1 tile outside the fence on that side. `lm.door` for `placeArmyBase` points at the gate approach (as today).

- [ ] **Step 3: Moat carve in `genCity`**

New `bakeArmyIsland()` in place of `bakeArmyOutskirts()` (same slot: after `bakeSidewalksAndBlocks`, before `carveAlleys`). Rings from the fence outward: bank GRASS, moat WATER, outer bank SIDEWALK. Skip tiles within `HALF_ROAD + T` of the bridge axis (they keep ROAD/SIDEWALK). `genCity` order: `buildGraph(); bakeRoads(); bakeSidewalksAndBlocks(); bakeArmyIsland(); carveAlleys();` (Task 2 inserts the rail corridor after `bakeSidewalksAndBlocks`).

- [ ] **Step 4: Bridge parapets in `render.js`**

In the static world layer, where a ROAD tile has WATER on both sides across the road axis, draw a low parapet (light stone line, 3-4 px, with a dark shadow line) along the road edge. Style consistent with existing `render.js` drawing. Check with a headless screenshot later (Task 3).

- [ ] **Step 5: Rewrite `server/test-army.mjs` section 5 → "base on an island inside the city"**

For `ARMY01` plus `PABC12`, `MABC12`, `GABC12`:
- base fence fully inside `[8, MAP_W-8] x [8, MAP_H-8]`;
- walking the moat ring (tiles at distance 2..4 outside the fence): every tile is WATER except a single contiguous run of ROAD/SIDEWALK (the bridge), and that run is on the gate side;
- BFS over walkable tiles (ROAD/SIDEWALK/ALLEY/GRASS) from the gate reaches a road node outside the island only through the bridge tiles (block the bridge tiles → unreachable);
- across 6 seeds (`PAAA01`…`PAAA06`) the base centres are not all equal and not all in the right third.
Keep sections 1-4 unchanged and passing.

- [ ] **Step 6: Create `server/test-roads.mjs`**

Same style as `test-army.mjs` (`ok(cond, msg)`, exit code 1 on failure). For `PABC12`, `MABC12`, `GABC12` and one peace-city code if the runtime can make one (else skip with a log line):
- `ok(edges.every(e => nodes[e.a].x === nodes[e.b].x || nodes[e.a].y === nodes[e.b].y), 'every street is straight and axis-aligned')`;
- every live node except `gateApproach` has degree 3 or 4 (ring corners: 2);
- BFS over edges from node 0 reaches every live node;
- node counts: P `8 x 8` (+1 gate approach), M `8 x 16` (+1), G `16 x 16` (+1);
- `_cityWidth() * 32 === worldInfo().worldW`.
Add `test-roads.mjs` to the `test` script in `server/package.json`.

- [ ] **Step 7: Run and preview**

Run: `node server/test-roads.mjs && node server/test-army.mjs && node server/test-terrain.mjs && node server/test-buildings.mjs`
Expected: all OK, exit 0.
Preview: `node .tmp/map-png.cjs PABC12 .tmp/t1-p.png 184 184` and `node .tmp/map-png.cjs MABC12 .tmp/t1-m.png 184 368`; read both PNGs: orthogonal grid, island with moat in the interior, one bridge.

- [ ] **Step 8: Commit**

```bash
git add js/city.js js/entities.js js/render.js js/server-sim-glue.js server/test-army.mjs server/test-roads.mjs server/package.json
git commit -m "feat(city): orthogonal street grid and a moated army island inside the city"
```

---

### Task 2: Ring railway and looping train

**Files:**
- Modify: `js/city.js` (rail geometry + corridor carve; `genCity`)
- Modify: `js/train.js` (whole file: kinematics, blocking, collisions, drawing)
- Modify: `js/render.js:92` (static rail draw call stays), `:2081-2086` (Y-sort), `:2127-2129` (minimap loop)
- Modify: `js/server-sim-glue.js` (debug exports)
- Create: `server/test-rail.mjs`
- Modify: `server/package.json` (add `test-rail.mjs`)

**Interfaces:**
- Consumes: `colX`, `rowY`, `NX`, `NY`, `MARGIN`, `armyZone.island` from Task 1.
- Produces (city.js): `RAIL_INSET` (tiles), `RAIL_CORNER_R` (px), `RAIL_LOOP_LEN` (px), `railPointAt(s) -> { x, y, angle }` (clockwise, `s` wrapped), `railCrossings: Array<{ s, x, y }>`.
- Produces (train.js): `train = { active: true, isTrain: true, x, y, s, segs: [{ cx, cy, angle, w, loco }] }`, `updateTrainKinematics()`, `trainBlocking(c) -> boolean`, `trainCollide()`, `drawRailway()`, `drawTrain()`. `RAIL_TY`, `RAIL_Y`, `TRAIN_PERIOD`, `TRAIN_CROSS_F`, `TRAIN_EDGE` removed.
- Produces (glue, tests only): `_rail() -> { loopLen, crossings, pointAt }`, `_train() -> train`, `_setFrame(f)`, `_trainBlocking(c)`, `_trainCollide()`.

- [ ] **Step 1: Rail geometry in `city.js`**

Track centreline: rectangle with corners at `RAIL_INSET*T` from each map edge, rounded with `RAIL_CORNER_R`. `RAIL_INSET` = midpoint (in tiles) between the ring road (`MARGIN`) and the nearest first interior line over both axes (`min(colX[1], rowY[1], MAP_W*T - colX[NX-2], MAP_H*T - rowY[NY-2]) / T`), rounded down. `RAIL_CORNER_R = 6 * T` (smaller if the inset band is narrower). `railPointAt(s)`: straight top (left→right), arc, right side (down), arc, bottom (right→left), arc, left side (up), arc.

- [ ] **Step 2: Corridor carve**

`bakeRailCorridor()` called right after `bakeSidewalksAndBlocks()` in `genCity`: sample the loop every `T/2`; every tile whose centre is within `1.5*T` of the centreline and is not ROAD or SIDEWALK becomes GRASS. Then build `railCrossings`: walk the loop every `T/4`; each contiguous run where `tileAt` under the centreline is ROAD gives one entry at the run's middle `s`.

- [ ] **Step 3: Train on the loop (`train.js`)**

`TRAIN_SPEED = 6.5` px/frame. Head `s = (frame * TRAIN_SPEED) % RAIL_LOOP_LEN`. Segments placed at `s - (off + len/2)` (wrapped) with `railPointAt`; `train.x/y/s` = head. `trainBlocking(c)`: a crossing within `TRAIN_STOP_BAND + c.colH` of the car (euclidean) whose `s` lies in the train's span `[tailS - TRAIN_WARN, headS + TRAIN_WARN]` measured with wrap. `trainCollide()`: per segment, local coords `lx, ly` by rotating `(e.x - cx, e.y - cy)` by `-angle`; overlap when `|lx| < w/2 + r` and `|ly| < TRAIN_BODY_H/2 + r`; locomotive rules unchanged; carriages push out along the axis with the smaller penetration (convert back to world before `moveBox`). Horn: every 10 frames, if a crossing is 300-370 px ahead of the head.

- [ ] **Step 4: Drawing**

`drawRailway()` (static chunk, `camX/camY` = chunk origin): skip when the chunk rect does not intersect the loop band. Ballast: stroke of width `RAIL_BALLAST` along the loop path, clipped out on ROAD tiles. Sleepers every 16 px along `s`, perpendicular, skipped on ROAD tiles and outside the chunk. Rails: two strokes offset `±RAIL_GAUGE/2` (rounded rect with radius `RAIL_CORNER_R ∓ RAIL_GAUGE/2`). At each crossing: white stop lines across the road lanes 1 tile before the track on both sides. `drawTrain()`: each segment drawn with `ctx.translate/rotate` by its angle, same colours as today. Minimap: sample `railPointAt` every `T` and plot 1 tile per sample.

- [ ] **Step 5: Create `server/test-rail.mjs`**

For `PABC12`, `MABC12`, `GABC12`:
- `pointAt(0)` and `pointAt(loopLen)` coincide (< 1 px); consecutive samples every 8 px are ≤ 8.5 px apart (closed, continuous);
- no tile within `T` of the centreline is BUILDING; no centreline sample is inside `armyZone.island` (read via `_landmarks()` army fence ± 5 tiles);
- `crossings.length >= 4 * (NX - 2)` on P (every street leaving the ring is crossed) and every crossing tile is ROAD;
- train: two sims of the same code give the same `train.segs` at frame 1234; for frames `f` and `f+1` the head moves ≤ `TRAIN_SPEED + 0.01` (wrap counted);
- blocking: put a car (`_cars()[0]`, set `x,y` on a crossing, `colH` unchanged); `_setFrame` so the head is 200 px before that crossing → `_trainBlocking(car) === true`; head half a loop away → `false`; repeat for a crossing at `s < 300` to cover the wrap;
- collision: car placed 5 px off the side of a carriage centre → after `_trainCollide()` it is outside the oriented box.
Add `test-rail.mjs` to `npm test`.

- [ ] **Step 6: Run and preview**

Run: `node server/test-rail.mjs && node server/test-roads.mjs && node server/test-army.mjs && node server/test-terrain.mjs && node server/test-traffic.mjs`
Expected: all OK, exit 0.
Preview: extend `.tmp/map-png.cjs` locally if useful (it is scratch) to paint `_rail().pointAt` samples in yellow; read the PNGs for P and M.

- [ ] **Step 7: Commit**

```bash
git add js/city.js js/train.js js/render.js js/server-sim-glue.js server/test-rail.mjs server/package.json
git commit -m "feat(rail): ring railway around the city with level crossings"
```

---

### Task 3: Visual check and CI (controller)

- [ ] Headless in-game screenshots (agent `browser`, `node build.js` + local server or static `index.html`): a level crossing with the train, the bridge over the moat, a junction. Fix visual defects in the owning file.
- [ ] Push the branch, open the PR, CI green on the head commit.
