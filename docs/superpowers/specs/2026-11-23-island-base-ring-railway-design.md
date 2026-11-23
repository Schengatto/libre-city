# Island army base, ring railway, orthogonal streets (LIBRE-17)

## Intent

The owner reported three problems with the generated map:

1. The army base always sits on the right edge, beyond a river, inside a wide strip of lawn and trees. The base must sit **inside the city**, on an **island**: a water moat around the fence and **one bridge**. The rest of the map is city, with no lawn strip.
2. The railway is a single horizontal line that runs over buildings and streets. It must work like a **real railway that circles the city**.
3. The streets look bad and can be better.

## Goals

- `MAP_W` equals the city width. The river strip and the outskirts strip (`RIVER_W`, `OUTSKIRTS_W`, `bakeArmyOutskirts`) are removed.
- The base is placed in the interior of the city. Its position depends on the seed, so it is not always on the same side.
- A moat of water surrounds the fence on all four sides. One straight road (the bridge) crosses the moat and reaches the gate. No other walkable path crosses the moat.
- Around the moat the superblock is ordinary city (buildings, courts, alleys).
- The railway is a closed loop (a rectangle with rounded corners) inside the outer ring road. It never crosses a building. Where it crosses a street it is a level crossing.
- One train runs around the loop without stopping. Its position depends on `frame` only (same on clients, host and server).
- Traffic stops at a level crossing while the train is near it. The locomotive crushes cars and kills people on foot. The carriages are solid walls. This is the current behaviour, made to work on a loop.
- Streets form an orthogonal grid: straight roads, right-angle junctions, no dead ends, no isolated junctions. Block size stays the same on every map size.

## Non-goals

- Road hierarchy (wide avenues, medians). Lane logic depends on one `HALF_ROAD`.
- Animated crossing barriers or lights. The rail layer is baked into static chunks.
- More than one train.
- Changes to the base interior layout, guards or vehicles (LIBRE-7).

## Anti-goals

- A base that touches the map edge or the railway.
- A railway corridor that cuts through a landmark or a building.
- Generation that differs between client, host worker and server (everything stays seeded: `rnd`/`rndi`/`hash2`).

## Approaches considered

**Railway**

- A. Loop inside the outer ring road, between the ring road and the first interior street line. Every street that leaves the ring road crosses it at a right angle: real level crossings, the train still interacts with traffic. **Chosen.**
- B. Loop outside the ring road, in the strip along the map edge. No crossings, so the train never meets traffic. Rejected: the train loses its gameplay role.
- C. Keep a straight line but reserve a corridor for it. Rejected: it does not circle the city.

**Base placement**

- A. Remove one interior junction and its four street segments. The four blocks around it merge into a superblock. The island sits in the middle of the superblock, the bridge follows the removed street line from one neighbour junction. **Chosen.**
- B. Carve the island over existing streets. Rejected: it breaks the road graph and the traffic.

**Streets**

- A. Shared column and row lines (each column has one x, each row has one y), jitter per line, straight segments only. Pruning removes an interior segment only when both ends keep at least three segments. **Chosen.**
- B. Keep the jittered nodes and the curves, smooth them in rendering. Rejected: jittered nodes on a 32 px tile grid give slanted, uneven blocks and odd junction angles, which is what looks bad today.

## Design

### Street grid (`js/city.js`, `buildGraph`)

- Target block pitch about 24 tiles. `NX = round((MAP_W - 2*MARGIN) / 24) + 1`, `NY` the same on `MAP_H`. Small map: 8 x 8 (unchanged). Medium: 8 x 16. Large: 15 x 15.
- Column `i` has one x for every row. Row `j` has one y for every column. Interior lines get a deterministic jitter (`hash2`), at most about ±15 % of the pitch. Border lines have no jitter.
- The first and the last interior line on each axis are pushed inward only, never outward, so that the rail corridor has room (see Railway).
- All edges are straight. `addRoadEdge` loses the curve logic.
- Pruning: an interior edge is a candidate for removal when its `hash2` roll says so (about 1 in 5). It is removed only when both ends have at least 4 live edges at that moment. Result: no dead ends, no degree-2 bends inside the city, only T and X junctions.
- Edges are not created and then marked dead. A removed edge is never added. A junction with no edges has `live: false`.

### Island base (`js/city.js`, replaces `reserveArmyZone` / `bakeArmyOutskirts`)

- Not in peace cities (`PEACE_CITY`): no base, no moat.
- Candidates: interior junctions `(i, j)` with `2 <= i <= NX-3` and `2 <= j <= NY-3`, whose superblock (between lines `i-1` and `i+1`, `j-1` and `j+1`, minus road and pavement) fits the island footprint plus at least 3 tiles of buildings on each side. Pick one with the seeded `rndi`. If none fits, pick the largest.
- The chosen junction gets no edges (`live: false`). Its four neighbours keep at least 3 edges each, because pruning never takes them below 3.
- Footprint, from inside out: fence rect `ARMY_W x ARMY_H` (26 x 20, unchanged), 1 tile of grass bank, 3 tiles of water (moat), 1 tile of pavement (outer bank). Centred on the superblock centre.
- Bridge: one neighbour junction, chosen with `rndi` among the four. A straight edge runs from it along the removed line to a gate-approach node just outside the fence. `bakeRoads` stamps it like any road, so the bridge is ROAD tiles over the moat. The moat carve skips every tile within road plus pavement width of the bridge axis.
- `armyZone` keeps `{x0,y0,x1,y1,gateApproach}` for the fence rect, plus the island rect. `placeArmyBase`, `carveArmyBase`, `lm.door`, gate and guard duties keep working as they do now.
- Render: low parapets along both sides of the bridge span over water, in the static layer.

### Railway geometry (`js/city.js`)

City generation needs the corridor before alleys, landmarks and buildings, and `train.js` loads after `city.js`. So the geometry lives in `city.js`:

- `RAIL_INSET` (tiles from the map edge to the track centreline): halfway between the ring road and the first interior line, about `MARGIN + 11`.
- `RAIL_CORNER_R`: corner radius, about 6 tiles. Each arc stays inside a corner block.
- `railPointAt(s)`: arc length `s` (wrapped into `[0, RAIL_LOOP_LEN)`) to `{ x, y, angle }`. Clockwise.
- `RAIL_LOOP_LEN`: total length in px.
- Corridor carve (in `genCity`, after `bakeSidewalksAndBlocks`, before `carveAlleys`): every tile within about 1.5 tiles of the centreline that is not ROAD or pavement becomes GRASS (an embankment). Roads stay roads.
- `railCrossings`: the list of level crossings, `{ s, x, y }`, found by sampling the loop where the centreline runs over ROAD tiles (one entry per contiguous run).

### Train (`js/train.js`)

- Speed about 6.5 px/frame (a lap of about 50 s on the small map). Always active.
- `updateTrainKinematics()`: head arc length `s = (frame * TRAIN_SPEED) mod RAIL_LOOP_LEN`. Each carriage `{ cx, cy, angle, w, loco }` is placed at its arc-length offset behind the head. `train.x/y` = head position (for Y-sorting and sound).
- `trainBlocking(c)`: true when the car is within the stop band of a crossing and the train (head to tail, with the `TRAIN_WARN` margin, measured along the loop and wrapped) is near that crossing's `s`.
- `trainCollide()`: each carriage is an oriented box. Move the entity into the carriage frame, test, push out along the shallow axis, rotate back. Same damage rules as today.
- Horn: when the head is a few hundred px before a crossing.
- `drawRailway()` (static chunk): ballast as a thick stroke along the loop, sleepers sampled along it, two rails as offset strokes. On ROAD tiles no ballast and no sleepers, only the rails over the asphalt, plus stop lines on both sides.
- `drawTrain()`: carriages drawn rotated by their angle.
- Minimap (`js/render.js`): the loop instead of the `RAIL_TY` row.
- `RAIL_TY` and `RAIL_Y` go away.

### Tests

- `server/test-army.mjs`, section 5, rewritten: base inside the map with a city margin; every tile of the moat ring is WATER except the bridge; exactly one road crosses the moat; across 6 seeds the base is not always in the same place.
- New `server/test-rail.mjs`: the loop closes; no corridor tile is BUILDING; every crossing is on ROAD; no crossing inside the island; train position is deterministic and moves at most `TRAIN_SPEED` + epsilon per frame; a car on a crossing is blocked when the train is near and not blocked when far; a car overlapping a carriage is pushed out.
- New `server/test-roads.mjs`: every edge is horizontal or vertical; every live interior junction has degree 3 or 4 (except the gate approach); all live junctions are connected; node counts per map size.
- Add the new test files to `npm test` in `server/package.json`.

## Left to the builder

- Exact jitter amount, inset, corner radius, speed, if the numbers above do not fit.
- How the stop lines and the parapets look, within the existing style of `render.js`.
