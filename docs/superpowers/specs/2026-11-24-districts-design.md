# Districts: residential, industrial, Chinatown, port/beach (LIBRE-19)

## Intent

Today every city looks the same everywhere. The building kind (residential, office, industrial) is chosen per 14-tile cell by hash noise (`blockKind` in `js/city.js:31`), so the kinds are scattered like confetti and no area has an identity. The user wants recognisable districts, like the named neighbourhoods of a GTA city: you should know where you are by looking at the street.

Requested districts: **residential**, **industrial**, **Chinatown**, **port/beach**. Not every map gets all of them. Small maps get fewer (1-2), large maps more. The choice is seeded per room, so every room has its own city.

## Goals

- Contiguous, recognisable districts. Each changes buildings (height, roofs, palette), street props and ground.
- District set and placement depend on the room code. The same code always gives the same city on server, host worker and every client.
- Small map (P): 2 districts. Medium (M): 3. Large (G): all 4. The rest of the city stays "mixed" (today's look).
- Port/beach brings the first sea in the game: one map edge becomes beach, quays and water.

## Non-goals

- No gameplay tied to districts: no district missions, no district-specific pedestrians, vehicles or gangs, no HUD district name. These are possible follow-ups.
- No new road layout. The street grid, ring road, ring railway and army island from LIBRE-17 stay as they are.
- No animated props. Everything new is baked into the static chunks (`drawWorldStatic`), like the rest of the city.

## Anti-goals (failure even if it "works")

- Host and client see different cities, or the server sim and the client disagree on solid tiles.
- Traffic, pedestrians, police, army base, train or missions break or stall. For example: peds spawning in the sea, cars driving onto sand, a mission target in the water.
- A district eats the army island, a landmark or the ring railway corridor.
- Visible frame drops from chunk baking.
- Old saves lose progress. `SAVE_VERSION` must not change. LIBRE-17 already makes `applySave` fall back to spawn when the saved position is invalid.

## Constraints

- Plain JS files sharing one global scope (`js/*.js`). New top-level names must not collide (see memory "render global-scope pitfalls").
- `js/city.js` runs both in the browser and in the server vm (`server/sim-runtime.js`). Generation must be pure and deterministic.
- District randomness uses its own stream, `hashStr(ROOM_CODE + ':DISTRICTS')`, like `ROAD_SEED`. Drawing from the shared `random` would shift the army island and landmark placement of every existing room.
- `blockKind(bx, by)` is the single seam today. It is read by `js/city.js` (court/tree fill at 461, building kind/style at 469-474) and `js/render.js` (court drawing at 174, plaza detail at 325). Districts plug in there.
- Map sizes: P 184x184, M 184x368, G 368x368 tiles, `T = 32` px. Outside the ring road there is an 8-tile strip (`MARGIN = 8`) of buildings. The ring railway is inside the ring road.

## Approaches considered

1. **Seeded district centres + nearest-centre assignment (chosen).** Place one centre per chosen district with the district RNG, away from the army island and from each other. Each 14-tile `PERIOD` cell within radius R of a centre belongs to the nearest one. All other cells stay "mixed". Gives blob-shaped, contiguous areas in any position. Cheap: a lookup per cell, computed once.
2. **Fixed bands/quadrants.** Split the map into quadrants or horizontal bands and give each one a district. Simplest, but every city looks the same up to rotation. It also fights the variable army island position.
3. **Smoothed noise.** Low-frequency value noise over cells, thresholded into districts. Organic edges, but hard to guarantee "exactly 2 districts on P" or a minimum size. Districts can split into fragments.

Port/beach is different from the others: it needs a map edge. It uses one whole map side, picked by the district RNG, plus the first row of cells inside the ring road on that side.

Approach 1 was chosen autonomously (user mandate: full autonomy, no questions). It is the only one that meets both "variable per room" and "exact district count per map size".

## Design

### District selection and placement (`js/city.js`)

- District ids: `MIXED`, `RESIDENTIAL`, `INDUSTRIAL`, `CHINATOWN`, `PORT`.
- Count per size: P = 2, M = 3, G = 4. Pick the set by a seeded shuffle of the four ids. Any subset is valid, port included.
- Port: pick one of the 4 map sides with the district RNG. On M (taller than wide) only the long sides count, so the beach is long enough.
- Other districts: centres are placed by rejection sampling on cells inside the ring road. Constraints: not within the army island bounds (plus a margin), at least `R * 1.5` from each other and from the port side. Radius R scales with the map's short side. Target: each inland district covers roughly 12-20% of the inner city on P, and stays one compact blob on G.
- `districtAt(cx, cy)` is precomputed into a `Uint8Array` per `PERIOD` cell.
- `blockKind(bx, by)` becomes district-aware:
  - residential gives `RES_KIND`;
  - industrial gives `IND_KIND`;
  - Chinatown gives the new `CHINA_KIND`;
  - port inland cells give `IND_KIND` (dock warehouses);
  - mixed keeps the current hash noise.
- Park/plaza ratio (`blockCat`): unchanged, except residential gets parks more often (≈ 1/3 instead of 2/9). Industrial and port cells never get plazas.

### Port/beach edge (`js/city.js`)

- On the port side, the 8-tile strip outside the ring road stops being building lots. From the ring road outward:
  - the existing sidewalk ring stays;
  - a **promenade/quay** band (new tile `QUAY`, walkable, not drivable);
  - a **beach** band (new tile `SAND`, walkable, not drivable);
  - **sea** (`WATER`, solid) up to the map edge, at least 3 tiles deep.
- Along the side, about the first 40% (seeded which end) is **harbour**: no sand, the quay runs straight into water, with static cranes, bollards and container stacks drawn on the quay. These are decorations drawn on walkable tiles. Crane bases and container stacks are solid: they are marked `BUILDING`-equivalent tiles through a new `PROP` tile that `solidTile` treats as solid. The rest is **beach** with umbrellas and towels (not solid).
- Pedestrian spawn (`entities.js:422`) accepts `SAND` and `QUAY` like `GRASS`. Traffic only spawns on `ROAD`, so no change is needed there. Mission targets stay `SIDEWALK`.
- Corners: where the port side meets the adjacent sides, the strip transition is clean. The builder picks the exact shape (cut straight, or a rounded corner of sand).

### Per-district looks

| District | Buildings | Ground and props |
|---|---|---|
| Residential | `RES_KIND`: mostly `house` (bias lots to small areas), some low `apartment`. Warm `RES_COLORS`. | Gardens in courts (existing RES court), more trees (`TREE` share in courts up from 1/7 to about 1/4), hedges. |
| Industrial | `IND_KIND`: `warehouse` / `workshop`, sawtooth and metal roofs. New roof prop: chimney/smokestack (static). | Yards with pallets (existing IND court), plus containers and oil stains on courts. No trees. |
| Chinatown | New `CHINA_KIND` with styles `pagoda` (curved eaves, red/green glazed roof, gold ridge) and `chinashop` (flat roof with vertical sign boards facing the street). Red, jade and gold palette. | Courts become paved with red lanterns. One ceremonial gate (paifang) drawn across the road at the district's entry junction nearest the city centre. It is purely decorative and drawn over the road; cars pass under it. |
| Port/beach | Inland cells: dock warehouses (`IND_KIND`). | Quay, beach, sea, cranes, containers, bollards, umbrellas (see above). |
| Mixed | Unchanged. | Unchanged. |

### Rendering (`js/render.js`)

- New tile drawers for `SAND`, `QUAY` and `PROP`. Sea uses the existing `drawWaterTile`, with a foam line on the tile next to sand or quay.
- New building styles go through the existing `planBuilding` / `STYLE_ROOF` pipeline. `pagoda` gets its own roof shape, `chinashop` reuses a flat roof plus signs on the street face (`b.face`).
- Port props and the paifang are drawn in `drawWorldStatic`, after the buildings and before the landmarks.
- Minimap colours for `SAND`, `QUAY` and `PROP` in `cityMini`.

### Shared code effects

- `worldInfo().sig` changes for every room. This is expected: the city changes. `server/test-sim.mjs` only compares a code with itself.
- `placeLandmarks` gets fewer lots on the port side. Landmarks must still all place. A test asserts this on P/M/G.

## Tests

- New `server/test-districts.mjs` (via `createRoomSim`):
  - district count per size (P 2, M 3, G 4);
  - determinism (same code, same district map; different codes, different maps);
  - each inland district is one contiguous blob of the expected size;
  - no district cell overlaps the army island or rail corridor;
  - when present, the port side has sea at the map edge, sand/quay between sidewalk and sea, no `ROAD` touching `WATER`;
  - all landmarks placed on every size.
- Peds: spawn on many codes and assert no ped and no car on `WATER`/`PROP`.
- Render-level: extend `server/test-buildings.mjs` for `pagoda` / `chinashop`, and `server/test-terrain.mjs` for `SAND` / `QUAY` / foam.
- Existing suites stay green: test-roads, test-army, test-rail, test-traffic, test-police, test-sim, test-save.
- Visual check headless on a P and a G map: full-map PNG plus in-game screenshots of each district.

## Decisions from the builder check (agent's calls, user may override)

1. **"Walkable, not drivable" means AI only.** `SAND` and `QUAY` are not solid for anyone. Player-driven vehicles can drive on them, as they already do on sidewalks and grass. AI traffic never goes there because it spawns and routes only on `ROAD`. No vehicle-only collision rule. Only `WATER` and `PROP` are solid.
2. **Exact count is a hard rule.** P = 2, M = 3, G = 4 always. If an inland centre cannot be placed, apply a fixed fallback chain:
   - relax the spacing to `R * 1.0`;
   - shrink R by 25% and retry;
   - swap that district for one not yet chosen;
   - as a last resort, choose `PORT`, which can always be placed.
   No unbounded loops. The test stays strict.
3. **The port inland band follows the streets, not the cells.** A `PERIOD` cell is port when its centre lies between the map edge and the second grid line on the port side (`colX[1]`, `colX[NX-2]`, `rowY[1]` or `rowY[NY-2]`). This avoids half-restyled blocks in most cases.
   - Districts only restyle building lots and courts, through `blockKind` and `blockCat`. They never change `ROAD`, the rail corridor `GRASS`, crossings, the army island, the moat or the bridge.
   - "No overlap with rail or army" means exactly that: those tiles are identical with and without districts.
   - Inland centres must still keep clear of the army island, so a blob is not cut in half.
4. **The paifang is visibly above cars.**
   - The pillars stand on the sidewalks and are baked into the static chunk. They are not solid.
   - The crossbeam is drawn in a small, non-animated overlay pass after the entities, skipped when off screen.
   - This is the only exception to "static only". It covers one object per map.

## Left to the builder

- Exact radius formula, rejection-sampling attempt limits and fallback (if a centre cannot be placed, drop that district, never loop forever).
- Exact band widths of quay/sand/sea within the 8-tile strip (sea ≥ 3 tiles).
- Pixel art of the pagoda roof, signs, cranes, containers and umbrellas, within the existing render style.
- Every reader of solid tiles must treat `PROP` as solid: `solidTile`, `lineClear`, bullets, ped and car steering. The builder finds them all.
