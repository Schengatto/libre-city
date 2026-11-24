# Districts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seeded, contiguous districts (residential, industrial, Chinatown, port/beach) per room. Each district restyles buildings, courts and props. The port district turns one map edge into quay, beach and sea.

**Architecture:** All generation stays in `js/city.js` at script load, on its own RNG stream, so server, host worker and clients build the same map.

- `pickDistricts()` runs inside `genCity()` right after `buildGraph()`, because it needs `colX`/`rowY`, `armyZone` and `railLoop`. It fills a per-`PERIOD`-cell `Uint8Array`.
- `blockKind` and `blockCat` read that array.
- `bakePortEdge()` rewrites the port strip after `bakeArmyIsland()`.
- Rendering in `js/render.js` adds tile drawers, building styles and static props, all baked into chunks. The only per-frame addition is the paifang crossbeam.
- Tests use the `server/test-save.mjs` pattern: a `vm` context plus `BUNDLE`. The bundle can be patched by string replace to switch districts off or force fallbacks. Tests read globals with `vm.runInContext`.

**Tech Stack:** Plain browser JS (classic scripts, one global scope), Node test scripts in `server/*.mjs` (`sim-runtime.js`, `render-test-kit.mjs`, `js/sim-stubs.js`).

**Spec:** `docs/superpowers/specs/2026-11-24-districts-design.md`

## Global Constraints

- All `js/*.js` share ONE global scope. Grep every new top-level name across `js/` first. The `test-buildings.mjs` uniqueness guard must stay green.
- No code comments, English identifiers, descriptive names, minimum code. Existing comments stay unless they become false.
- District count: P = 2, M = 3, G = 4, always (hard rule).
- Map sizes: P 184x184, M 184x368, G 368x368 tiles, `T = 32`, `MARGIN = 8`.
- District RNG: `hashStr(ROOM_CODE + ':DISTRICTS')`. Never draw from `random`/`rnd`/`rndi`.
- District ids: `MIXED`, `RESIDENTIAL`, `INDUSTRIAL`, `CHINATOWN`, `PORT`.
- Inland centres: at least `R * 1.5` from each other and from the port side. Fallback chain:
  1. spacing `R * 1.0`;
  2. shrink R by 25%;
  3. swap for an unchosen district;
  4. `PORT`.
  No unbounded loops.
- Port side: any of the 4 sides. On M (taller than wide) only the long sides.
- A cell is port when its centre lies between the map edge and `colX[1]` / `colX[NX-2]` / `rowY[1]` / `rowY[NY-2]`.
- Port strip, from the ring road outward:
  - sidewalk (kept);
  - `QUAY`;
  - `SAND`;
  - `WATER`, at least 3 tiles deep, up to the map edge.
- Harbour: the first ~40% of the side (seeded end), with no sand.
- Only `WATER` and `PROP` are solid. `SAND` and `QUAY` are not solid for anyone.
- Residential parks ≈ 1/3 (was 2/9).
- Residential court `TREE` share ≈ 1/4 (was 1/7).
- Industrial and port cells never get plazas. Industrial gets no trees.
- Districts never change `ROAD`, rail corridor `GRASS`, crossings, army island, moat or bridge. Those tiles are identical with and without districts.
- `SAVE_VERSION` must not change. `worldInfo().sig` is expected to change for every room.
- Everything new is static (baked chunks). The only exception is the paifang crossbeam overlay, drawn after the entities and skipped when off screen.

## Review Focus

1. **Shared-RNG drift.** District code that touches `random`/`rnd` moves the army island and landmarks of every room.
   - Covered by Task 1 test `rail corridor and army island identical without districts`.
   - It compares `armyZone` and the island/rail tiles against a bundle patched to `DISTRICT_COUNTS = { P: 0, M: 0, G: 0 }`.
2. **District bias leaking into protected tiles.** `blockCat` could turn plazas or parks into other tiles inside the rail corridor.
   - Covered by the same Task 1 identity test.
   - Decision: no district bias in cells where `cellTouchesRail` is true.
3. **Exact count breaks or loops.** The fallback chain fails to place a district, or never ends.
   - Covered by Task 1 test `count holds when every centre fails`.
   - It patches `DISTRICT_RADIUS_SHARE` to `0.9` and runs under the 5000 ms vm timeout.
4. **A solid reader misses `PROP`.** Peds walk into cranes, or bullets pass through containers.
   - Task 2 test `every inline solid check includes PROP` reads the source.
   - A sim test checks that no ped or car stands on `WATER`/`PROP`.
5. **A new style is missing from a style-keyed table** (`STYLE_ROOF`, `FACADE_MATERIALS`, `WALL_LAYOUT`, lift map). This crashes the browser only.
   - Task 4 adds `pagoda: 10, chinashop: 9` to `STYLE_LIFTS` in `test-buildings.mjs`.
   - Every existing per-style planner, draw and facade check then runs on them.

---

### Task 1: District map, selection, fallback, blockKind/blockCat wiring

**Files**
- Modify: `js/city.js:29-35` (ids, `DISTRICT_KINDS`, cell grid, `districtAt`, `blockKind`), `js/city.js:54-59` (`blockCat`), `js/city.js:280-281` (district selection before `genCity`, call inside it)
- Modify: `server/package.json` (append `&& node test-districts.mjs` to `scripts.test`)
- Create: `server/test-districts.mjs`
- Test: `node server/test-districts.mjs`

**Interfaces**
- Consumes: `hashStr`, `mulberry32` (core.js), `colX`, `rowY`, `NX`, `NY`, `MARGIN`, `PERIOD`, `armyZone.island`, `railCentrelineDistance(x, y)`, `hash2`.
- Produces:
  - `const MIXED = 0, RESIDENTIAL = 1, INDUSTRIAL = 2, CHINATOWN = 3, PORT = 4;` (one line, extractable)
  - `const DISTRICT_KINDS = [-1, RES_KIND, IND_KIND, OFF_KIND, IND_KIND];` (index 3 becomes `CHINA_KIND` in Task 4)
  - `const DISTRICT_COUNTS = { P: 2, M: 3, G: 4 };` (exact text; tests patch it)
  - `const DISTRICT_RADIUS_SHARE = 0.22;` (exact text; tests patch it)
  - `const DISTRICT_COLS = Math.ceil(MAP_W / PERIOD), DISTRICT_ROWS = Math.ceil(MAP_H / PERIOD);`
  - `const districtGrid = new Uint8Array(DISTRICT_COLS * DISTRICT_ROWS);`
  - `const districtAt = (bx, by) => …`, which returns `MIXED` out of range
  - `const districtCentres = [];`, with entries `{ id, bx, by, r }` (`r` in tiles)
  - `let portSide = -1, portHarbourFirst = false;` (0 top, 1 right, 2 bottom, 3 left)
  - `const districtRandom = mulberry32(hashStr(ROOM_CODE + ':DISTRICTS'));`
  - `function cellTouchesRail(bx, by)`, which returns `railCentrelineDistance(cell centre px) <= 1.5 * T + PERIOD * T * Math.SQRT1_2`
  - `function inPortBand(bx, by)`, which applies the spec rule against `colX[1]`, `colX[NX-2]`, `rowY[1]`, `rowY[NY-2]` for `portSide`
  - `function pickDistricts()`
  - `genCity()` becomes `buildGraph(); pickDistricts(); bakeRoads(); …`

- [ ] **Step 1: Write the failing test** `server/test-districts.mjs`. Use the `ok`/`pass`/`fail` harness, `process.exit(fail ? 1 : 0)`, and this loader:

```js
import vm from 'node:vm';
import runtime from './sim-runtime.js';
import stubs from '../js/sim-stubs.js';
const { BUNDLE } = runtime;
const NO_DISTRICTS = s => s.replace('const DISTRICT_COUNTS = { P: 2, M: 3, G: 4 };', 'const DISTRICT_COUNTS = { P: 0, M: 0, G: 0 };');
const HUGE_RADIUS = s => s.replace('const DISTRICT_RADIUS_SHARE = 0.22;', 'const DISTRICT_RADIUS_SHARE = 0.9;');
function loadCity(code, patch = s => s) {
  const source = patch(BUNDLE);
  const context = vm.createContext(stubs.makeSimStubs(code, 900, { setTimeout, clearTimeout, setInterval, clearInterval }));
  vm.runInContext(source, context, { timeout: 5000 });
  return { run: expr => vm.runInContext(expr, context), patched: source !== BUNDLE };
}
const EXPECTED = { P: 2, M: 3, G: 4 };
const CODES = Object.fromEntries(Object.keys(EXPECTED).map(size => [size, Array.from({ length: 12 }, (_, k) => `${size}DST${String(k).padStart(2, '0')}`)]));
const readDistricts = run => run(`({ cols: DISTRICT_COLS, rows: DISTRICT_ROWS, grid: Array.from(districtGrid), centres: districtCentres.map(c => ({ ...c })), portSide, island: armyZone && { ...armyZone.island } })`);
```

Assertions go in section `1) distretti`:
- `district count per size`: for every code, `new Set(grid.filter(d => d !== 0)).size === EXPECTED[size]`.
- `count holds when every centre fails`: the same assertion on 4 codes per size with `HUGE_RADIUS`, plus `patched === true`.
- `determinism`:
  - `loadCity(code)` twice gives identical `grid` and `portSide`;
  - the 12 P codes give 12 distinct `grid.join()`.
- `M port only on long sides`: every M code with `portSide >= 0` has `portSide === 1 || portSide === 3`.
- `inland blob contiguous and sized`:
  - For each id in `{1, 2, 3}`, a 4-connected flood from its centre cell covers every cell with that id.
  - `share = cells / innerCells`. Inner cells have centre `(b + 0.5) * 14` strictly inside `(8, MAP_W - 8)` and `(8, MAP_H - 8)`.
  - On P, the mean share over all inland districts of the 12 codes is in `[0.12, 0.20]`.
  - Every single share is in `[0.04, 0.25]`, on P and G alike.
- `no district cell overlaps the army island`: for every non-MIXED cell, the tile rect `[bx*14, bx*14+13] x [by*14, by*14+13]` does not intersect `island`.
- `rail corridor and army island identical without districts`. On 2 codes per size, compare the normal bundle with `NO_DISTRICTS` (`patched === true`). These must be equal:
  - `JSON.stringify(armyZone)`;
  - `run('Array.from(grid).map((t, i) => railCentrelineDistance((i % MAP_W + 0.5) * T, (Math.floor(i / MAP_W) + 0.5) * T) <= 1.5 * T ? t : -1).join()')`;
  - the tiles inside `armyZone.island`.
- `blockKind follows districts`: `run('bldgs.every(b => { const d = districtAt(Math.floor(((b.x0 + b.x1) >> 1) / PERIOD), Math.floor(((b.y0 + b.y1) >> 1) / PERIOD)); return d === MIXED || b.kind === DISTRICT_KINDS[d]; })') === true`.
- `no plazas in industrial or port cells`: for every cell with district `INDUSTRIAL` or `PORT` and `!cellTouchesRail(bx, by)`, `blockCat(bx, by) !== PLAZA_CAT`.
- `residential parks about 1/3`: across all codes, the `PARK_CAT` share over residential cells with `!cellTouchesRail` is `>= 0.27`.

- [ ] **Step 2: Run it.** `node server/test-districts.mjs`. Expected: FAIL with `ReferenceError: DISTRICT_COLS is not defined`, and the `patched === true` checks fail.

- [ ] **Step 3: Implement** in `js/city.js`.
  - `blockKind = (bx, by) => { const d = districtAt(bx, by); return d === MIXED ? hash2(bx + 13, by + 29) % 3 : DISTRICT_KINDS[d]; }`.
  - `blockCat`: compute `h = hash2(bx + 7, by + 3) % 9` and `d = cellTouchesRail(bx, by) ? MIXED : districtAt(bx, by)`.
    - Return `PARK_CAT` if `h === 0 || h === 6 || (h === 8 && d === RESIDENTIAL)`.
    - Return `PLAZA_CAT` if `h === 3 && d !== INDUSTRIAL && d !== PORT`.
    - Otherwise return `BUILD_CAT`.
    - Rail tile identity wins over "never plazas": cells where `cellTouchesRail` is true keep the mixed park/plaza rule.
  - `pickDistricts()`. All randomness comes from `districtRandom`, in this order:
    1. `count = DISTRICT_COUNTS[String(ROOM_CODE).charAt(0)] ?? 2`.
    2. Fisher-Yates shuffle `[RESIDENTIAL, INDUSTRIAL, CHINATOWN, PORT]`. `chosen` is the first `count` ids; `spare` is the rest.
    3. If `PORT` is chosen, set it up first:
       - `portSide = MAP_H > MAP_W ? (districtRandom() < 0.5 ? 1 : 3) : Math.floor(districtRandom() * 4)`;
       - `portHarbourFirst = districtRandom() < 0.5`;
       - push `{ id: PORT, bx: -1, by: -1, r: 0 }`.
    4. `R = Math.round(Math.min(MAP_W, MAP_H) * DISTRICT_RADIUS_SHARE)` (tiles).
    5. Candidate cells must meet all of these:
       - the cell centre `(b + 0.5) * PERIOD` is strictly inside the ring road;
       - the tile distance to `armyZone.island` is `>= PERIOD` (skip this check when `armyZone` is null);
       - the cell is not in `inPortBand`.
    6. `tryPlace(r, factor)` makes 200 attempts at a random candidate index. It accepts a cell when both hold:
       - the cell-centre distance to every placed inland centre is `>= factor * r`;
       - if `portSide >= 0`, the distance to the port map edge is also `>= factor * r`.
    7. For each inland id, try `tryPlace(R, 1.5)`, then `tryPlace(R, 1.0)`, then `tryPlace(0.75 * R, 1.0)`.
    8. If all three fail, take the next `spare` id. If it is `PORT`, set it up as in step 3. Otherwise repeat step 7 for it.
    9. If no spare is left, place at the candidate that maximises the minimum distance, with `r = 0.75 * R`. This step always succeeds.
  - Assignment, in this order:
    1. If `portSide >= 0`, every cell in `inPortBand` is `PORT`.
    2. Every other cell takes the nearest inland centre whose cell-centre distance is `<= c.r`.
    3. Cells whose tile rect intersects `armyZone.island` become `MIXED`.
    4. For each inland id, keep only the 4-connected component of its centre cell. The rest becomes `MIXED`.
    5. Finally, write each centre cell with its own id.
  - Append `&& node test-districts.mjs` to `scripts.test` in `server/package.json`.

- [ ] **Step 4: Run it.** `node server/test-districts.mjs && node server/test-rail.mjs && node server/test-buildings.mjs`. Expected: PASS, with the uniqueness guard OK. If only the P mean share misses `[0.12, 0.20]`, tune `DISTRICT_RADIUS_SHARE` and change nothing else.

- [ ] **Step 5: Commit.**
  `git add js/city.js server/test-districts.mjs server/package.json`
  `git commit -m "feat(city): seeded district map drives block kind and category"`

### Task 2: Port edge tiles, solid readers, ped spawn

**Files**
- Modify: `js/city.js:21` (tile constants), `js/city.js:281` (`bakePortEdge` before `carveAlleys`), `js/city.js:285` (`solidTile`), `js/city.js:592-593` (`randomWalkNear`)
- Modify: `js/entities.js:7` (`pedFriendly`), `js/entities.js:14` (`pickWalkDir`)
- Modify: `js/gameplay.js:318`, `js/gameplay.js:333`
- Modify: `js/server-sim-glue.js:335` (`_tileKinds` adds `SAND, QUAY, PROP`)
- Test: `server/test-districts.mjs` (append section `2) porto`)

**Interfaces**
- Consumes: `portSide`, `portHarbourFirst`, `districtCentres`.
- Produces:
  - `const ROAD = 0, …, COURT = 7, SAND = 8, QUAY = 9, PROP = 10;` (same line 21)
  - `const PORT_STRIP = 5;`
  - `const portProps = [];`, with entries `{ kind: 'crane' | 'containers', x0, y0, x1, y1, sea: [dx, dy] }` (tile rect plus seaward unit vector)
  - `function bakePortEdge()`
  - `solidTile` returns true for `PROP`
  - inline solid checks become `t === BUILDING || t === TREE || t === WATER || t === PROP`
  - `pedFriendly` and `randomWalkNear` accept `SAND` and `QUAY`

- [ ] **Step 1: Write the failing test.**

Side mapping for tile `(s, d)`, where `s` runs along the side and `d` is the depth from the map edge:
- side 0: `(s, d)`;
- side 1: `(MAP_W-1-d, s)`;
- side 2: `(s, MAP_H-1-d)`;
- side 3: `(d, s)`.

`len = MAP_W` for sides 0 and 2, `MAP_H` otherwise.

Tests:
- `port band structure`: assert that at least 3 P codes have a port. Then, for every port code across sizes and every `s` in `[6, len - 7]`:
  - `d` 0..2 is `WATER`;
  - `d = 3` is in `{SAND, QUAY, PROP}`;
  - `d = 4` is in `{QUAY, PROP}`;
  - `d = 5` is `SIDEWALK`.
- `harbour about 40%`:
  - the share of `s` in `[0, len)` with no `SAND` at `d = 3` is in `[0.35, 0.45]`;
  - the harbour is at the start when `portHarbourFirst`, otherwise at the end;
  - `SAND` never appears in the harbour range.
- `no ROAD touching WATER on the port side`: no `WATER` tile with `d <= PORT_STRIP` has a 4-neighbour `ROAD`.
- `props solid and on the quay`:
  - `portProps.length >= 2`;
  - every tile of every prop rect is `PROP`, has `d` in `{3, 4}` and lies inside the harbour;
  - `run('solidTile')` gives true for `PROP` and false for `SAND` and `QUAY`.
- `all landmarks placed`: on every code of every size, `landmarks.filter(l => l.type !== 'army').length === 14`.
- `every inline solid check includes PROP`:
  - read `js/*.js` with `fs`;
  - every line matching `/t === BUILDING \|\| t === TREE \|\| t === WATER/` also contains `t === PROP`;
  - the `solidTile` line contains `t === PROP`.
- `peds accept sand and quay, never sea or props`, on one port code per size:
  - 300 calls to `sim._randomWalkNear(qx, qy, 0, 400)` around a quay tile centre never land on `WATER` or `PROP`;
  - at least one of them lands on `SAND` or `QUAY`;
  - then `addPlayer`, move `sim._player(id)` to the quay point and tick 600 times;
  - no ped and no car has its centre tile on `WATER` or `PROP`;
  - no car with `role === 'traffic'` stands on `SAND` or `QUAY`.

- [ ] **Step 2: Run it.** `node server/test-districts.mjs`. Expected: FAIL, with `PORT_STRIP is not defined` and the source guard failing on `entities.js:14`, `gameplay.js:318` and `gameplay.js:333`.

- [ ] **Step 3: Implement.** `bakePortEdge()` returns at once when `portSide < 0`. It uses the side mapping above and `harbourLen = Math.round(0.4 * len)`.
  - For every `s` in `[0, len)` and `d` in `[0, PORT_STRIP)`, write:
    - `WATER` when `d <= 2`;
    - `QUAY` when `d === 4`, or when `d === 3` inside the harbour;
    - `SAND` otherwise.
  - The whole side is converted, corner squares included (straight cut).
  - Harbour props use the local index `i = s - harbourStart` and only apply for `6 <= s <= len - 8`:
    - crane: when `i % 14 === 4`, tiles `s..s+1` x `d = 3..4` become `PROP`;
    - containers: when `i % 14 === 9`, tiles `s..s+2` x `d = 3..4` become `PROP`;
    - push each rect into `portProps`, with `sea` set to the unit vector toward `d = 0`.
  - Call order: `bakeArmyIsland(); bakePortEdge(); carveAlleys();`.

- [ ] **Step 4: Run it.** `node server/test-districts.mjs && node server/test-terrain.mjs && node server/test-buildings.mjs`. Expected: PASS. The terrain `clipOutTiles` section stays green.

- [ ] **Step 5: Commit.**
  `git add js/city.js js/entities.js js/gameplay.js js/server-sim-glue.js server/test-districts.mjs`
  `git commit -m "feat(city): port edge with quay, beach, sea and solid harbour props"`

### Task 3: Residential and industrial looks

**Files**
- Modify: `js/city.js:461-462` (court trees), `js/city.js:466-476` (`b.district`, house threshold, apartment storeys)
- Modify: `js/render.js:173-190` (call the court detail); add `drawDistrictCourtDetail` after `drawTile`
- Modify: `js/render.js:696` (`case 'smokestack':` falls through to `case 'stack':`)
- Modify: `js/render.js:1025-1030` (smokestack placement in `planBuilding`)
- Modify: `server/test-terrain.mjs`:
  - add the loader parameter `districtAt`;
  - `createRenderer(tileTypes, cat = 1, district = 0)` passes `() => district`;
  - DECLARATIONS add `['city', 'MIXED']`, `['city', 'walkableTile']`, `['render', 'CONTAINER_COLS']`, `['render', 'drawDistrictCourtDetail']`.
- Modify: `server/test-buildings.mjs` (DECLARATIONS add `['city', 'MIXED']`)
- Test: `server/test-districts.mjs`, `server/test-terrain.mjs`, `server/test-buildings.mjs`

**Interfaces**
- Consumes: `districtAt`, `RESIDENTIAL`, `INDUSTRIAL`, `PORT`, `edgeBand`, `WATER_SIDES`, `walkableTile`.
- Produces:
  - `b.district` on every building
  - `const CONTAINER_COLS = ['#b5452f', '#2f6fa8', '#3f8a4a', '#c99a2e', '#7a4a8a'];` (render.js)
  - `function drawDistrictCourtDetail(px, py, x, y, h)`
  - roof prop `{ type: 'smokestack', w: [14, 16], h: [14, 16], height: 24, max: 1 }`

- [ ] **Step 1: Write the failing tests.**
  - test-districts `residential looks`, over all codes that have `RESIDENTIAL`:
    - the `house` share of buildings in residential cells is `>= 0.6`;
    - every residential `apartment` has `lift === 11`;
    - in residential cells with `blockCat === BUILD_CAT`, `TREE / (TREE + COURT)` is in `[0.18, 0.32]`.
  - test-districts `industrial looks`:
    - every building in `INDUSTRIAL` or `PORT` cells has style `warehouse` or `workshop`;
    - there is no `TREE` tile in `INDUSTRIAL` cells with `blockCat === BUILD_CAT`.
  - test-buildings `smokestack only in the industrial district`:
    - every `warehouse`/`workshop` sample with `district: 2` and a roof `>= 64x64` has exactly 1 prop of type `smokestack`;
    - samples without `district` have 0;
    - drawing a smokestack prop records `createRadialGradient` and only finite numbers.
  - test-terrain `court details per district`: call `drawDistrictCourtDetail(0, 0, x, 3, h)` for `h` in `0..40`, on a grid of `COURT` with a `SIDEWALK` row.
    - district `RESIDENTIAL` records fillStyle `'#3f6b35'` (hedge);
    - district `INDUSTRIAL` records a `CONTAINER_COLS` colour and `'rgba(10,10,12,.35)'` (oil stain);
    - district `MIXED` records 0 calls.

- [ ] **Step 2: Run them.** `node server/test-districts.mjs; node server/test-terrain.mjs; node server/test-buildings.mjs`. Expected: FAIL, with `declaration not found: drawDistrictCourtDetail` and no smokestack.

- [ ] **Step 3: Implement.**
  - city.js, second pass:
    - set `b.district` from the mid cell, before `b.kind`;
    - the RES style threshold becomes `area <= (b.district === RESIDENTIAL ? 30 : 18)` for `house`;
    - `storeyVariation` is 0 when `b.district === RESIDENTIAL`;
    - the court tree rule becomes `k === RES_KIND && hh % (districtAt(cell) === RESIDENTIAL ? 4 : 7) === 0`.
  - render.js: the COURT branch ends with `drawDistrictCourtDetail(px, py, x, y, h)`. Its rules:
    - `RESIDENTIAL`: when `h % 3 === 0`, draw a hedge with `edgeBand(px, py, dx, dy, 5)` in `'#3f6b35'` on each side whose neighbour is walkable.
    - `INDUSTRIAL` or `PORT`: when `h % 13 === 0`, draw a 24x12 container in `CONTAINER_COLS[h % 5]` with ribs.
    - `INDUSTRIAL` or `PORT`: when `h % 7 === 3`, draw an oil-stain ellipse in `'rgba(10,10,12,.35)'`.
  - planBuilding: right after the helipad block, add `if (b.district === INDUSTRIAL) placeOn(byFreeArea[0], [{ type: 'smokestack', w: [14, 16], h: [14, 16], height: 24, max: 1 }], 1);`.

- [ ] **Step 4: Run them.** Same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit.**
  `git add js/city.js js/render.js server/test-districts.mjs server/test-terrain.mjs server/test-buildings.mjs`
  `git commit -m "feat(render): residential gardens and hedges, industrial yards and smokestacks"`

### Task 4: Chinatown styles, paifang and overlay

**Files**
- Modify in `js/city.js`:
  - `:26-34`: `CHINA_COLORS`, `CHINA_KIND`, `DISTRICT_KINDS[3]`, the `blockColor` palette array;
  - `:471-478`: styles, lifts, `b.col` palette;
  - `:282`: gate pick after `genCity();`.
- Modify in `js/render.js`:
  - `:179`: CHINA court paving;
  - `drawDistrictCourtDetail`: lanterns;
  - `:411-418`: `WALL_LAYOUT`;
  - `:797-800`: `FACADE_MATERIALS`;
  - `:873-933`: `STYLE_ROOF`;
  - `:992-997`: `planRoofShape`;
  - `:1016-1022`: pagoda early return;
  - `:1117-1127`: `drawVolume`;
  - `:1165-1167`: `drawFacade`;
  - `:95`: pillars before `drawLandmarks()`;
  - `:2093`: beam after the entity loop.
- Modify `server/test-buildings.mjs`:
  - `STYLE_LIFTS` adds `pagoda: 10, chinashop: 9`;
  - DECLARATIONS and loader exports add `drawPagodaRoof`, `drawChinaSigns`, `drawChinaGatePillars`, `drawChinaGateBeam`, `drawFacade`.
- Test: `server/test-districts.mjs`, `server/test-buildings.mjs`

**Interfaces**
- Consumes: `CHINATOWN`, `districtAt`, `nodes`, `edges`, `HALF_ROAD`, `hipRoofPlanes`, `drawHouseRoof`, `shade`.
- Produces:
  - `const RES_KIND = 0, OFF_KIND = 1, IND_KIND = 2, CHINA_KIND = 3;`
  - `const CHINA_COLORS = ['#9e2b25', '#b8352c', '#2f7d62', '#3a8f70', '#c9a23a', '#8c2a2a'];`
  - styles `'pagoda'` (area `>= 20`, lift 10) and `'chinashop'` (lift 9)
  - `function pickChinaGate()` and `const chinaGate = pickChinaGate();`, value `{ x, y, angle, left: { x, y }, right: { x, y } } | null`
  - `function drawPagodaRoof(x, y, w, h, color)`
  - `function drawChinaSigns(b, px, py, W, H, L)`
  - `function drawChinaGatePillars(gate)`
  - `function drawChinaGateBeam(gate)`

- [ ] **Step 1: Write the failing tests.**
  - test-districts `chinatown buildings`: every building in `CHINATOWN` cells has `kind === CHINA_KIND` and style `pagoda` or `chinashop`.
  - test-districts `paifang`:
    - `chinaGate !== null` exactly when some cell is `CHINATOWN`;
    - the tile at `(gate.x, gate.y)` is `ROAD`;
    - the tiles at `gate.left` and `gate.right` are `SIDEWALK`, and `solidTile` is false for both;
    - the gate's junction cell is `CHINATOWN`.
  - test-buildings `pagoda roof`:
    - `planBuilding` gives `roofShape === 'pagoda'` and `props.length === 0`;
    - `drawPagodaRoof(10, 10, 96, 64, '#a3322a')` records `quadraticCurveTo` and `set:strokeStyle` `'#d4af37'`;
    - every path coordinate is within `[6, 110] x [6, 78]`.
  - test-buildings `chinashop signs`:
    - for each `face` in `0..3`, `drawFacade` with style `chinashop` records fillStyle `'#b3261e'`;
    - every `fillRect` is within `[px - 2, px + W + 2] x [py - 2, py + H + 2]`;
    - `face: -1` records nothing.
  - test-buildings `paifang beam culled off screen`, with a loader using `vw = 800, vh = 600`:
    - a gate at x 5000 records 0 calls;
    - a gate at x 400 records `'#b3261e'`.

- [ ] **Step 2: Run them.** `node server/test-districts.mjs; node server/test-buildings.mjs`. Expected: FAIL, with `STYLE_ROOF.pagoda` undefined and `declaration not found: drawPagodaRoof`.

- [ ] **Step 3: Implement.**
  - `STYLE_ROOF` entries:
    - `pagoda: { material: 'tilesH', upperMaterial: 'tilesH', propDensity: 0, colors: ['#a3322a', '#b23a2e', '#2f7a5c', '#348a66'], pool: [] }`;
    - `chinashop: { material: 'tar', upperMaterial: 'tar', propDensity: 0.4, colors: ['#7a6a60', '#86705e', '#6e6a66'], pool: [hvac 11-14 x 8-10 h4, vent 5-6 h3] }`.
  - `FACADE_MATERIALS`: both styles get `['brick', 'brickV']`.
  - `WALL_LAYOUT` entries:
    - `pagoda: { floorHeight: 99, bay: 10, windowWidth: 4 }`;
    - `chinashop: { floorHeight: 5, bay: 8, windowWidth: 4 }`.
  - `drawPagodaRoof` draws, in order:
    1. flared eaves: a path with 3 px overhang and upturned corners via `quadraticCurveTo`, filled with `shade(color, -0.3)`;
    2. `drawHouseRoof(x + 2, y + 2, w - 4, h - 4, color, 'hip')`;
    3. the ridge of `hipRoofPlanes(x + 2, y + 2, w - 4, h - 4)`, stroked in `'#d4af37'` with width 3.
  - `drawChinaSigns`: vertical boards in `'#b3261e'` with a `'#e8c04a'` border on the `b.face` side, one every 14 px.
  - CHINA court:
    - paving in `'#8a6a5c'`;
    - lanterns when `h % 5 === 0`: a circle in `'#d8342a'` with a `'#e8c04a'` cap.
  - `pickChinaGate`:
    1. Candidates are live nodes with `edges.length >= 3` in `CHINATOWN` cells, sorted by distance to `(WORLD_W / 2, WORLD_H / 2)`.
    2. For each candidate, take the edge whose other endpoint is nearest the map centre. The gate centre is `4.5 * T` along that edge.
    3. Each pillar is the first point on the perpendicular ray, in steps of `T / 4` up to 24 steps, whose tile is `SIDEWALK`. Move it `T / 4` further if that tile is still `SIDEWALK`.
    4. Return the first candidate where both pillars are found, else `null`.
  - Render wiring:
    - `if (chinaGate) drawChinaGatePillars(chinaGate)` just before `drawLandmarks()`;
    - `if (chinaGate) drawChinaGateBeam(chinaGate)` right after the entity loop;
    - the beam returns early when its bounding box, padded by 40 px, is outside `camX..camX + vw` / `camY..camY + vh`.

- [ ] **Step 4: Run them.** `node server/test-districts.mjs && node server/test-buildings.mjs && node server/test-terrain.mjs`. Expected: PASS, including the uniqueness guard.

- [ ] **Step 5: Commit.**
  `git add js/city.js js/render.js server/test-districts.mjs server/test-buildings.mjs`
  `git commit -m "feat(render): chinatown pagodas, sign-board shops and paifang gate"`

### Task 5: Port rendering

**Files**
- Modify in `js/render.js`:
  - `:148-202`: `drawTile` branches for `SAND`, and for `QUAY`/`PROP`;
  - `:210`: `SOFT_SHORES`;
  - `:300-301`: `drawWaterTile` skips off-map sides;
  - `:95`: `drawPortProps(portProps)` before the pillars;
  - `:2120-2122`: minimap colours.
- Modify `server/test-terrain.mjs`:
  - DECLARATIONS add `['city', 'AWNING_COLS']`, `['render', 'drawSandTile']`, `['render', 'drawQuayTile']`, `['render', 'drawPortProps']`;
  - EXPORTS add `SAND`, `QUAY`, `PROP` and the three functions.
- Test: `server/test-terrain.mjs`

**Interfaces**
- Consumes: `portProps` entries `{ kind, x0, y0, x1, y1, sea }`, `CONTAINER_COLS`, `AWNING_COLS`, `edgeBand`.
- Produces:
  - `function drawSandTile(px, py, x, y)`, base colour `'#d9c48e'`
  - `function drawQuayTile(px, py, x, y)`, base colour `'#a39d90'`, kerb `'#6d6a63'` toward `WATER`
  - `function drawPortProps(props)`, which draws:
    - cranes in yellow `'#d8a21c'`, with the boom along `sea`;
    - container stacks;
    - bollards on `QUAY` next to `WATER`, when `hash2(x, y) % 3 === 0`;
    - umbrellas from `AWNING_COLS` on `SAND`, when `hash2(x, y) % 4 === 0`;
    - towels when `hash2(x, y) % 4 === 1`;
    - everything culled to the viewport padded by `3 * T`.
  - `const SOFT_SHORES = [GRASS, TREE, COURT, SAND, QUAY];`
  - minimap colours: `SAND '#d8c48a'`, `QUAY '#9a958a'`, `PROP '#b8642e'`

- [ ] **Step 1: Write the failing tests** in test-terrain, section `8) porto`:
  - `sand and quay tiles`: `drawSandTile` and `drawQuayTile` record `'#d9c48e'` and `'#a39d90'`, with no bad numbers.
  - `foam next to sand and quay`: `WATER` at `(3,3)` with `SAND`, then `QUAY`, at `(4,3)` records `'rgba(230,245,250,.45)'` and no `'#b4b9c0'`.
  - `no shore at the map edge`: on an all-`WATER` 8x8 grid, `drawWaterTile(0, 0, 0, 0)` records 0 `createLinearGradient`.
  - `port props culled`:
    - `drawPortProps([{ kind: 'crane', x0: 2, y0: 2, x1: 3, y1: 3, sea: [-1, 0] }, { kind: 'containers', x0: 5, y0: 2, x1: 7, y1: 3, sea: [-1, 0] }])` records `'#d8a21c'` and a `CONTAINER_COLS` colour;
    - a prop at `x0: 500` adds no calls;
    - a `SAND` grid records an `AWNING_COLS` colour.
  - `minimap knows the port tiles` (source guard): `readSource('render.js')` contains `t === SAND ? '#d8c48a'`, `t === QUAY ? '#9a958a'` and `t === PROP ? '#b8642e'`.

- [ ] **Step 2: Run it.** `node server/test-terrain.mjs`. Expected: FAIL with `declaration not found: drawSandTile`.

- [ ] **Step 3: Implement** to the interfaces above.
  - `drawTile`: `SAND` calls `drawSandTile`; `QUAY` and `PROP` call `drawQuayTile`.
  - `drawWaterTile`: add `if (neighbour === WATER || x + dx < 0 || y + dy < 0 || x + dx >= MAP_W || y + dy >= MAP_H) continue;`.

- [ ] **Step 4: Run it.** `node server/test-terrain.mjs && node server/test-buildings.mjs`. Expected: PASS.

- [ ] **Step 5: Commit.**
  `git add js/render.js server/test-terrain.mjs`
  `git commit -m "feat(render): beach, quay, foam, cranes, containers and umbrellas"`

### Task 6: Visual headless check and full verification

**Files**
- Create, not committed (gitignored): `.tmp/districts-preview.mjs`, modelled on `.tmp/army-preview.mjs` (Chrome CDP, `file:///index.html`, `libreCity.spIntent` with `violence: true`)
- Test: full suite via a gate-runner agent

**Interfaces**
- Consumes: `districtCentres`, `portSide`, `portProps`, `chinaGate`, `worldChunkAt`, `WORLD_CHUNKS_X`/`WORLD_CHUNKS_Y`, `bakeWorldChunk`.
- Produces: PNGs `.tmp/districts-<code>-map.png` and `.tmp/districts-<code>-<district>.png`, plus a printed timing line.

- [ ] **Step 1: Write the check.**
  - Codes: one G code with all 4 districts, plus P codes that together cover all 4 districts. Find them with the `test-districts` `loadCity` helper.
  - Full map: draw every chunk at scale 1/8 into one canvas.
  - In-game: move the player to each district centre, the harbour, the beach and `chinaGate`. Wait 2 frames, then save the canvas.
  - Timing: run `bakeWorldChunk` for every chunk. Print the median for chunks that overlap the port strip and the median for all chunks. Assert `portMedian <= 1.5 * allMedian`.
  - Assert zero page errors.
- [ ] **Step 2: Run it.** `node .tmp/districts-preview.mjs`. Expected: no errors, the timing assert holds, and the PNGs are written. Inspect each PNG for:
  - contiguous blobs;
  - sea on the map edge;
  - cranes over the water;
  - the gate over the road, with the beam above cars;
  - no dark-yard tiles on sand or quay.
- [ ] **Step 3: Full suite via a gate-runner agent.**
  - Run `cd server && npm test && node test-buildings.mjs && node test-terrain.mjs && node test-army.mjs && node test-sim.mjs && node test-scoring.mjs && node test-server-sim.mjs`. Expected: PASS.
  - For any failure, the gate-runner re-runs that file on base `f2506bc` to tell pre-existing failures from regressions.
  - Confirm with `git diff f2506bc -- js/save.js` that `SAVE_VERSION` is unchanged.
- [ ] **Step 4: Commit.** Nothing from `.tmp` is committed. If Step 2 forced visual fixes:
  `git add js/render.js`
  `git commit -m "fix(render): district visual polish from headless check"`
