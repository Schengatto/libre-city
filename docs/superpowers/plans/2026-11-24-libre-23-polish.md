# LIBRE-23 — LIBRE-17 polish: implementation plan

Spec: board task LIBRE-23 (description = binding item list 1-11 with anchors on main `0458fe5`).
Branch `fix/libre-23-rail-bridge-polish`, worktree `.tmp/wt-libre23`, PR to `main`.

## Global Constraints

- Plain browser JS in `js/*.js` sharing ONE global scope (no modules). A new top-level name that collides with an existing one silently overrides it: grep the whole `js/` folder before adding any top-level function/const.
- No code comments (project rule), English identifiers, minimal surgical diffs.
- City generation is seeded and deterministic; server sim (`server/sim-runtime.js`, `build-sim-worker.js`) runs the same `js/` code. Do not break determinism (no `Math.random` in city gen; use the existing seeded `rnd`/`rndi`).
- Static world (roads, landmarks, rail) is baked once into chunks (`drawWorldStatic` / `bakeWorldChunk`, `js/render.js:20-30`): no frame-based animation inside baked drawing.
- Tests: node scripts in `server/test-*.mjs`, wired in `server/package.json` `scripts.test` (a chain of `node test-x.mjs`). New test files must be appended to that chain. Reuse loaders: `server/render-test-kit.mjs` (`readSource`, `extractTopLevel`), VM pattern in `server/test-army-spawns.mjs:13-16` (`vm.createContext(stubs.makeSimStubs(...))`, `runInContext(BUNDLE)`, `ev(expr)`). Glue exposes `_rail()`, `_train()`, `_setFrame()` (`js/server-sim-glue.js:336-338`).
- Run only the test files you wrote or changed (`cd server && node test-x.mjs`), once, at the end of your task. `server/node_modules` may be missing: run `npm ci` in `server/` once if a test needs `ws`.
- Commit locally on the branch, Conventional Commits, no Claude/Anthropic attribution or Co-Authored-By trailer.

## Task 1 — City generation fixes (items 1-logic, 2, 3, 6, 8)

Files: `js/city.js`, new `server/test-island-edges.mjs` (add to `npm test`).

1. **Gate width (item 1, logic half).** In the army gate setup (`js/city.js:493-499`, `g=[[gx,gy],[gx+1,gy],[gx+2,gy]]`, `clamp(dtx, lm.x0+1, lm.x1-3)`) make the gate 5 tiles wide, centred on the bridge axis tile, clamped so it stays inside the fence span (`x0+1 .. x1-5`, same for the vertical case). Keep `lm.door`/`lm.gate` pointing at the gate centre. Check `armyGuardDuties` (`js/city.js:511`): booth and sentry post must not land on a gate tile or the deck; shift them beside the wider opening if needed.
2. **Bridge axis clamp (item 2).** In `reserveArmyIsland` / the approach computation (`js/city.js:219-238`), clamp the bridge axis coordinate to fence centre ± (`ARMY_H`/2 − 4)·T for side bridges and ± (`ARMY_W`/2 − 4)·T for top/bottom bridges, before carving the deck (`offAxis(...) <= deckHalf`). The gate (point 1) must follow the clamped axis. If the clamped axis no longer meets the street line, the carved approach must still connect the deck to the street road (no gap, no diagonal hole): verify by test.
3. **No city strip around the moat (item 3).** `pickArmyIsland` (`js/city.js:206-213`) picks a superblock; `bakeArmyIsland` (`js/city.js:229-241`) rewrites only the island rect. Store the chosen superblock bounds on `armyZone`, and in `bakeArmyIsland` convert every tile between the island rect and the street sidewalk ring that is not ROAD/SIDEWALK/WATER-of-the-moat into outer bank (same tile type as the outer bank ring, ring 5 = SIDEWALK; GRASS acceptable for wide leftovers). Runs after `bakeRailCorridor` (`js/city.js:407`): do not overwrite rail corridor tiles.
4. **Pond (item 6).** Pond ellipse at `js/city.js:154-165`. Keep the pond only if every tile of the disc of radius (pond radius + 1 shore tile) around its centre is BUILDING before carving, and the cell does not touch the rail (`cellTouchesRail(bx,by)`, `js/city.js:296`). Otherwise the cell stays a plain lawn/park without water.
5. **Dead fallback (item 8).** `js/city.js:212`: remove the unreachable `superblocks.reduce(...)` fallback (return the random fitting superblock; if none fits, `throw new Error('no superblock fits the army island')`).

Tests (`server/test-island-edges.mjs`), over at least 30 seeds for each city size used by the game (find the size list in `js/city.js`/`js/core.js`), plus peace city if it changes the layout:
- gate opening width in px ≥ 2·`HALF_ROAD` and gate lies fully on the deck;
- bridge deck tiles lie within the fence span on the perpendicular axis (no overhang past the fence corner);
- deck connects to the street road (flood fill from gate along ROAD reaches a city road outside the zone);
- no BUILDING/TREE/lot tile inside the superblock bounds outside the island rect;
- no WATER tile of a pond 4-adjacent to SIDEWALK/ROAD or within the rail corridor;
- booth/sentry post tiles are walkable and not on the gate opening.
Also run `server/test-army-spawns.mjs`, `server/test-districts.mjs`, `server/test-rail.mjs` (existing guards of the area).

## Task 2 — Render fixes (items 1-draw, 4, 5)

Files: `js/render.js`, `js/train.js`, new `server/test-train-render.mjs` (add to `npm test`).

1. **Gate drawing (item 1).** In the fence drawing (`js/render.js:1489-1504`) / `drawArmyCompound` (`js/render.js:1524`), draw two gate posts at the ends of the opening plus open gate leaves (or a raised boom) on the gate tiles. Static only (baked).
2. **Per-segment train sort (item 4).** Replace `ents.push(train)` (`js/render.js:2280`) and the single `drawTrain()` call (`js/render.js:2285`) with one sort entry per segment, `y` = segment centre; drawing an entry draws only that segment's body. Draw all segment shadows in one pre-pass before the sorted entity loop. Split `drawTrain` (`js/train.js:162-192`) into a shadows function and a single-segment body function; names must not collide with existing globals.
3. **drawRailway cost (item 5).** `drawRailway` (`js/train.js:108-135`) loops the whole ring twice per chunk. Compute the `along` intervals of the loop whose geometry (straights and arcs, `railLoop.{x0,y0,x1,y1,sideStarts,straights,arcLen}`, `js/city.js:244-254`) intersects the chunk rect expanded by the ballast margin, and iterate only those, stepping on the same global grid (`along` multiples of 9 and 16 from 0) so the hash-based pattern and output pixels are unchanged.

Tests (`server/test-train-render.mjs`):
- for 3+ seeds and every chunk touching the rail: set of `along` values visited by the new loops equals the set the old full-ring loop would draw (compare against a reference implementation in the test), and `railPointAt` call count per chunk drops by ≥ 5×;
- sort entries: one per segment, each `y` equals its segment centre;
- gate drawing: code-level check is enough if a canvas stub is not available (use the `render-test-kit.mjs` stub ctx if present).

## Task 3 — Gameplay fixes (items 7, 11)

Files: `js/entities.js`, `js/gameplay.js`, `js/train.js`, new `server/test-crossing-peds.mjs` (add to `npm test`).

1. **Civilians off the island (item 7).** `pickWalkDir` (`js/entities.js:10-20`, used by `updatePed` at `js/gameplay.js:390`): civilians (not soldiers/guards, not police chasing) reject directions whose next tile is `inArmyIsland`. A civilian already inside walks out (prefer directions that leave the island).
2. **Crossing safety (item 11).** `trainBlocking` (`js/train.js:50-58`, applied at `js/gameplay.js:632`) holds every car within `TRAIN_STOP_BAND`+colH of the crossing. Change it to hold only cars that are before the stop line (stop line offset as drawn at `js/train.js:147`) and heading toward the rail (signed distance along heading > stop offset). Cars on or past the track are never held (they clear). Reach: extend the hold distance by braking distance speed²/(2·0.6) so fast cars stop before the line.

Tests (`server/test-crossing-peds.mjs`) using the VM bundle pattern:
- car approaching, before the stop line, train within warn range: held;
- car straddling the rails or past the stop line: not held;
- car moving away from the rail: not held;
- fast car: stops before the stop line (simulate frames with the game braking);
- civilian next to the island bank never enters an `inArmyIsland` tile over N steps; soldier can.
Also run `server/test-police.mjs`, `server/test-traffic.mjs` (area guards).

## Task 4 — Net smoothing and test-rail rewrite (items 9, 10)

Files: `js/net.js`, `server/test-rail.mjs`.

1. **Train clock smoothing (item 10).** `netNoteTrainTick` (`js/net.js:641-647`) hard re-bases `trainTick`/`trainTickFrame` on every snapshot. Keep a smoothed offset (`tick − frame`): first snapshot or |error| > 30 frames → snap; |error| ≤ 2 → ignore; otherwise slew the offset by at most 1 frame per frame toward the target. `netTrainClock()` stays the single consumer API (`js/net.js:815`).
2. **test-rail rewrite (item 9).** In `server/test-rail.mjs`: replace duplicated constants (line 10) with values read from the VM context; replace source regexes (lines 104, 137-138) with behavioural checks (evaluate `netOnSnapshot`/`netNoteTrainTick` via `extractTopLevel` with a stub `net`, assert clock behaviour: snap on first, ignore small jitter, slew on medium, snap on large); add a peace-city run (override stub `localStorage.getItem` before running BUNDLE so `PEACE_CITY` is set, `js/sim-stubs.js:16`, `js/core.js:68-77`) covering the loop and crossings asserts. Adjust the exact re-align asserts at lines 123, 130.

Run `server/test-rail.mjs` and `server/test-host-mode.mjs` at the end.
