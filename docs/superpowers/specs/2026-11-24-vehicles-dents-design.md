# New vehicles (bus, lorry, spider) and visible dents — design

Tasks: LIBRE-20 (new vehicles), LIBRE-21 (dents). One spec, two deliveries: LIBRE-20 lands first, LIBRE-21 builds on its bodies.
Anchors: origin/main `0458fe5`.

## Intent

The street traffic is all the same saloon, plus taxis and bikes. Three new bodies give the city variety and give the player new toys:

- a **bus**: long, slow, heavy, rare-ish;
- a **lorry**: long, slow, heavy, shoves cars aside;
- a **racing spider**: short, open-top with the driver visible, very fast, rare.

Crashes today leave no trace on the bodywork, only smoke and fire near death. LIBRE-21 makes each hit readable: the struck side (front, rear, left, right) dents, deeper as the damage on that side grows.

## Goals

1. Bus, lorry and spider spawn in AI traffic at fixed rates and are drivable by the player (carjack, like any traffic car).
2. Each type has its own body in `drawCar`; the spider shows its driver.
3. Broad-phase collisions, following distance and spawn spacing respect the real vehicle length.
4. Every `damageCar` caller passes the impact direction; the car records damage per side and shows dents in 3 levels.
5. Multiplayer: vehicle type and dents reach every client with no new snapshot field for the type and one optional field for the dents.

## Non-goals

- Bus stops, bus routes, trailers, articulated steering.
- Parked buses, lorries or spiders (only traffic spawns them).
- Per-type steering rate or per-type health.
- Repair: dents never shrink.
- New damage sources. Wall crashes and single-player rams on the player's own car deal no damage today, so they do not dent. Changing damage balance is out of scope.
- An oriented (rotated-box) wall test.

## Anti-goals

- A snapshot that grows for every car: undamaged traffic must cost zero extra bytes (LIBRE-16 bandwidth limit).
- Dents that differ between clients: the sim decides them, clients only draw them.
- Long vehicles that jam on junction turns or spawn on top of other cars.

## Constraints

- Plain global-scope scripts. Every new top-level name must be unique across `js/*.js` (see the render global-scope pitfall in memory). New names: `VEHICLE_MAX_W`, `VEHICLE_MAX_H`, `vehicleColH`, `makeBus`, `makeLorry`, `makeSpider`, `dressTrafficCar`, `DENT_THRESHOLDS`, `DENT_ZONE`, `dentZone`, `dentLevel`, `addDent`, `drawBusCabin`, `drawLorryCabin`, `drawSpiderCockpit`, `drawCarDents`. None exists on `0458fe5`.
- The sim bundle (`server/sim-runtime.js` `SIM_FILES`) runs on the server, in the host worker and in single player. `render.js` and `net.js` are client only.
- Traffic spawning uses `Math.random`, not the seeded city RNG. Keep it so.
- Wall collision `moveBox(e, dx, dy, hw, hh)` takes a square half-extent `colH`.

## Approaches

### Where the vehicle type travels

| Option | Trade-off |
|---|---|
| **A. Existing `liv` field** (`'bus'`, `'lorry'`, `'spider'`) — chosen | Zero new bytes. `liv` already reaches every decoder (`carPayload`, `carNetPayload`, `netApplyCar`, `netParkCar`, remote player car). `w`/`h` already travel. |
| B. New `vt` field | Clearer name, but one more key on every car in every snapshot. |
| C. Infer type from `w`/`h` | No field, but fragile: any size tweak breaks the client. |

Note: `drawCar` treats any truthy `livery` except `'army'` as a van (`render.js:2008`). The new types need their own branch before that test.

### Wall collision of long vehicles

| Option | Trade-off |
|---|---|
| **A. Keep the square `colH`** — chosen | `colH` ≈ half the width, as today: the 46-long saloon already has `colH` 13, so its nose overhangs the box by 10 px. Bus and lorry noses overhang more and may clip a corner. No jam risk at turns, no change to `moveBox`. |
| B. Oriented box test in `moveBox` | Exact walls, but a long box rotating at a junction would hit kerbs and stall; touches every vehicle and pedestrian caller. |

### How dents are stored and sent

| Option | Trade-off |
|---|---|
| **A. Sim-side damage per zone, packed levels sent** — chosen | `c.dentDamage` (4 numbers, sim only) feeds `c.dents` (4 zones × 2 bits). Payload sends `dn` only when non-zero: undamaged cars cost nothing. |
| B. Send per-zone damage | Finer levels on the client, but 4 numbers per damaged car. |
| C. Client-side cosmetic dents from local collision events | No network, but clients disagree and remote hits never show. |

## Design — LIBRE-20 vehicles

### Factories (`js/entities.js`)

Type modifiers in the `makeMoto` pattern, applied to a car built by `makeCar`:

| Type | `livery` | `w`×`h` | `colH` | `mass` | `accel` | `top` | `maxSpeed` (AI) | `gears` | horn |
|---|---|---|---|---|---|---|---|---|---|
| bus | `'bus'` | 88×28 | 15 | 3.0 | 0.05 | 4.2 | 1.9 | 5 | `'truck'`, 150 |
| lorry | `'lorry'` | 76×28 | 15 | 2.6 | 0.06 | 4.5 | 2.0 | 5 | `'truck'`, 175 |
| spider | `'spider'` | 42×22 | 12 | 0.8 | 0.22 | 7.5 | 3.3 | 5 | `'car'`, 420 |

- Colours: bus from a short palette of transit colours, lorry cab from `CAR_COLORS` with a light cargo box, spider from a bright racing palette.
- The spider driver wears a racing helmet: `c.helmet` (travels as `hel`). `c.riderShirt` is set for the driver's torso.
- `vehicleColH(isBike, h)` returns `8` for bikes, otherwise `Math.floor(h / 2) + 1`. It reproduces every existing value (saloon 13, fire 14, tank 16, army jeep 13) and gives bus/lorry 15, spider 12. The factories set `colH` from it, and the client uses it instead of hard-coded values.
- `VEHICLE_MAX_W = 88`, `VEHICLE_MAX_H = 30` (bus length, tank width).

### Traffic mix

`dressTrafficCar(c)` replaces the taxi/moto lines in `spawnTrafficNear` and runs BEFORE the spacing check, so the check sees the real length:

- one roll: `< 0.04` bus, `< 0.10` lorry, `< 0.12` spider (4 %, 6 %, 2 %);
- otherwise the existing chain: 18 % taxi, else 14 % bike.

Taxi share drops from 18 % to 15.8 % of traffic. Accepted.

### Spacing and broad-phase (`js/entities.js`, `js/gameplay.js`)

- Spawn spacing: `dist < (o.w + c.w) / 2 + 24` instead of `< 70`. Two saloons: 46 + 24 = 70, unchanged.
- `CAR_REACH = Math.ceil(Math.hypot(VEHICLE_MAX_W, VEHICLE_MAX_H))` = 93. Two boxes touch only if their centres are closer than the sum of their half-diagonals, and that sum is at most the full diagonal of the largest box. Its comment is updated to match. The three users (`gameplay.js:798`, `:847`, `army.js:86`) stay unchanged.
- `gapAhead` already uses `w`/`h`: no change.

### Rendering (`js/render.js`)

`drawCar` picks the cabin by type before the van test:

```
bus    -> drawBusCabin     long roof, window band on both sides, windscreen at the front, two roof hatches
lorry  -> drawLorryCabin   short cab at the front (windscreen), gap line, light cargo box with ribs
spider -> drawSpiderCockpit low windscreen, two seats, roll bar, racing stripes; driver (torso + helmet) when occupied
other livery (not army) -> drawVanCabin
else   -> drawSaloonCabin
```

- Spider driver shown when the spider is driven or in traffic/police (`c.driver || c.role === 'traffic' || c.role === 'police'`), never for a parked spider unless the local player drives it (client world cars always carry `driver: 'net'`, so a parked one must not show a phantom driver). Torso colour: `player.shirt` for the local player, else `c.riderShirt` with a fixed fallback (remote clients do not receive `riderShirt`).
- Bus and lorry get a third tyre pair (rear double axle) for length; the builder may tune positions.

### Network (`js/net.js`)

- No new field: `liv`, `w`, `h` already travel.
- `colH` derives from `vehicleColH(bike, h)` in `netMakeWorldCar` (:627), `netParkCar` (:412) and the remote player car (:386). The remote cop car (:430) is always a patrol car and stays at 13.

## Design — LIBRE-21 dents

### Zones and levels (`js/gameplay.js`)

- `DENT_ZONE = { front: 0, rear: 1, left: 2, right: 3 }`. Car-local frame: +x forward, +y right (canvas y points down).
- `angle` in `damageCar(c, dmg, angle, chain)` means **the direction the impact travels** (bullet heading, punch aim, from the source towards the car). It is already passed that way by bullets, punches and direct rockets.
- `dentZone(c, impactAngle)`: the struck side faces the source, so `rel = angDiff(c.angle, impactAngle + Math.PI)`. `|rel| <= PI/4` front, `>= 3PI/4` rear, `rel > 0` right, else left.
- `DENT_THRESHOLDS = [8, 24, 48]`: zone level = number of thresholds reached by the zone's accumulated damage, max 3.
- `c.dents` packs level `L` of zone `z` at bits `2z..2z+1`. `dentLevel(dents, zone)` unpacks.
- `addDent(c, dmg, impactAngle)`: skips bikes, tanks and a non-finite angle; adds `dmg` to `c.dentDamage[zone]` (array created lazily); rewrites the zone bits. Levels never drop.
- `damageCar` calls `addDent(c, dmg, angle)` before the health logic.

### Callers that must pass the direction

| Caller | Direction passed |
|---|---|
| car-vs-car `gameplay.js:827` | `other === b ? atan2(ny, nx) : atan2(-ny, -nx)` (normal points a→b) |
| player car vs remote car `:862` | `atan2(-ny, -nx)` (b hits a) |
| hostile bullet on player car `:927-928` | `atan2(b.vy, b.vx)` |
| explosion chain `:1001` | `atan2(o.y - c.y, o.x - c.x)` |
| train `train.js:82` | `atan2` of the world push vector (`pushX`/`pushY` rotated by the segment), the push the train gives |
| rocket splash `army.js:78` | `atan2(o.y - r.y, o.x - r.x)` |

A code-reading guard test asserts every `damageCar(` call in `js/` has at least 3 arguments.

### Network

- `carPayload` and `carNetPayload` add `dn: c.dents || undefined`. `JSON.stringify` drops `undefined` keys, so undamaged cars send nothing. Over `postMessage` (host's own snapshot) the key exists with value `undefined`: harmless.
- Every decoder that copies `liv` also copies `c.dents = cp.dn || 0`: `netApplyCar` (:622, covers world and player cars), remote player car (:393), `netParkCar` (:417).
- `dentDamage` stays in the sim: clients only need levels.
- The local player's own car in multiplayer: the client still runs `resolveRemoteCarCollisions` (`net.js:829`) and its `damageCar` on `player.car`, so it would dent locally. The sim stays the authority: `netReconcileMe` (`net.js:759`, the `me.car && player.car` branch) overwrites `player.car.dents = me.car.dn || 0` every frame, and `netMakePlayerCar` gets it through `netApplyCar`. Local dents last at most one frame.

### Calls settled after the builder check

- Traffic-vs-traffic contacts deal no damage today (`:827` damages only when the player is involved), so AI cars dent only from player rams, bullets, explosions and trains. Accepted: no new damage source.
- Dents keep growing on smoking and burning cars until they explode.
- Enter and exit need no change for long bodies: entry range is 52 px from the centre (bus corner at 46 px), exit steps 34 px sideways (bus half-width 14).
- Bus, lorry, spider, taxi and bike are mutually exclusive by construction (one `else if` chain). Police and service spawns never go through `dressTrafficCar`. Every other `livery` check in `js/` is an equality test on a service value, so the new values change nothing there.
- Traffic spawns on the lane centre of a road edge. No wall check is added at spawn: the overhang of long noses is the same accepted clipping as at corners.

### Rendering

`drawCarDents(c, hw, hh)` runs in `drawCar` after the livery branches and before the siren lights, so dents sit on top of stripes and over the headlights (a front dent breaks them). For each zone with level > 0:

- a crumpled notch on that edge: a jagged polygon cut into the body, depth ≈ level × 2 px, filled with a dark shade of the paint;
- a darker crease line along the notch;
- front/rear notches span most of the width; side notches span about a third of the length, placed by a per-car offset derived from `c.id` so the shape is stable frame to frame and differs between cars.

Bikes and tanks never reach it (they return early in `drawCar`). It uses only `hw`/`hh`, so it fits every body: saloon, service liveries, bus, lorry, spider.

## Testing

- `server/test-vehicles.mjs` (new, in the `npm test` chain): factory sizes/physics/livery per type; every factory output fits in `VEHICLE_MAX_W`×`VEHICLE_MAX_H`; `CAR_REACH` ≥ hypot of the largest box; spawn spacing never overlaps (many spawns, every non-parked pair farther than half-length sum); traffic mix within tolerance over many rolls; payload round trip of `liv`/`w`/`h` and derived `colH` through `carPayload` → JSON → `netMakeWorldCar` (extracted from `net.js`); render smoke: `drawCar` on each type draws through its own cabin function (recording context).
- `server/test-dents.mjs` (new, in the chain): zone from angle on the 4 sides and at the 45° boundaries; level growth over thresholds and cap at 3; levels never drop; bit packing; bikes/tank never dent; non-finite angle ignored; payload `dn` omitted when 0 and round-trips when set; code-reading guard on `damageCar(` arity; `drawCarDents` draws nothing at 0 and draws on each zone.
- Existing `test-traffic`, `test-server-sim`, `test-hot-paths` stay green.
- Headless browser check (agent `browser`): the three bodies in single player and multiplayer; dents after front, rear and side hits in both modes.

## Left to the builder

- Exact artwork of the three bodies and of the dent polygon (colours, rib spacing, hatch size), within the shapes above.
- Exact palettes for bus and spider.
- Tyre positions on long bodies.
