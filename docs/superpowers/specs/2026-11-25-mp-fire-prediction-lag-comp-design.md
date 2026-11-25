# LIBRE-31: MP fire prediction and host lag compensation

Status: approved by autonomy rule (no questions policy); assumptions listed below.

## Intent

In multiplayer (Phase 2: world simulated by the host player's Worker, or by the server sim) a click travels client -> relay -> host, and the muzzle flash, shot sound and tracer return one full round trip later. Hits on rivals are tested against the rivals' positions at host time, which is later than what the shooter saw. LIBRE-31 hides part of that delay: the shooter sees and hears the shot immediately, and the host judges rival hits against where the rival was on the shooter's screen. It does not fix the root cause (VPS stalls, LIBRE-33).

## Goals

1. Local muzzle flash, weapon sound and tracer on click, for weapons that spawn `bullets[]` (pistol, smg, shotgun, flamer).
2. No double effect when the authoritative muzzle fx and bullets arrive.
3. Host hit test against rival bodies rewound by the shooter's measured latency, bounded.
4. Unit tests: rewind lookup, duplicate suppression, lag field computation.

## Non-goals

- Rockets, grenades, melee: no prediction, no rewind (rockets live in `rockets[]`, melee uses a cone).
- Rewinding peds and traffic (traffic has LIBRE-32).
- Clipping the predicted tracer when the host bullet hits an entity (tracer flies to wall or end of life; hit feedback comes from host fx).
- Matching predicted shotgun/flamer pellet spread to the host's random spread (cosmetic only).
- Phase 1 relay mode (`'shot'` events) is untouched.

## Anti-goals

- A predicted shot that changes gameplay state. Damage, kills and score stay host-only.
- Unbounded rewind: a lying or stalled client must not shoot rivals around corners from seconds ago.

## Approaches

A. Per-shot timestamps and rewind by client render time. Precise, but needs a clock sync between client and host that does not exist.
B. Rewind by measured latency (chosen). Client sends `lg` = input RTT + interpolation delay in each input. Host rewinds rival body positions by `lg` ticks. Uses existing measurements (`net.stats.inputRtt`, `net.stats.interpDelay`), no clock sync. Overestimates by at most one snapshot interval, negligible against the 11 px hit radius.
C. Predict only visuals, no rewind. Does not meet DoD.

B chosen.

## Design

### Client to host: latency field
- `netLagCompMs(stats)` (pure, js/net.js): `null` input RTT -> 0; else `round((inputRtt + interpDelay) / 5) * 5`, clamped to `[0, LAG_COMP_MAX_MS]`.
- `netSendInput` adds `lg` to the command.
- `server/index.js` `FORWARDED_INPUT_NUMBER_FIELDS` gets `'lg'` (otherwise the relay drops it).
- `applyInput` in js/server-sim-glue.js stores `pl.input.lagMs`, clamped again host-side to `[0, LAG_COMP_MAX_MS]`.
- `LAG_COMP_MAX_MS = 250` (15 ticks).

### Host: body position history and rewind
- Per player ring buffer of the body position (vehicle position when driving, else foot position), indexed by `tick % LAG_HISTORY_TICKS` (32), storing the tick for validity. Recorded once per tick after the player's phase, from the position the host actually uses.
- Pure helpers (shared js, testable with `extractTopLevel`): record and lookup. Lookup writes to a caller-provided output object (no allocation) and returns false when the tick is not in the ring.
- `updateBullets` rival PvP loop: when the owner has `lagMs > 0`, test against `lookup(frame - lagTicks)` for the car box centre or the on-foot centre. Fallback: current position when the lookup fails. Effects (damage, sparks) still use real positions.
- `lagTicks = round(lagMs / (1000/60))`.
- The host player's own shots use the same path (their `lg` is mostly the interpolation delay).

### Client: prediction and dedupe
- Fire gate mirrors the host gate: not downed, not driving, not `peaceMode()`, weapon not melee/rocket/grenade, auto ? `mDownL` : click edge, local `player.shootCd === 0`; then `shootCd = w.cd` and decrement per tick. Weapon comes from `player.weaponIdx` (already reconciled from `me.wp`).
- Predicted shot: `spawnMuzzle`, the weapon's own sfx (`sfx[w.sfx] || sfx.shoot`), and local bullets in `net.predBullets` (same math as `playerShoot`: speed, life, spread). They step each frame, die on a solid tile (no sparks, the host sends them) or end of life, and are appended to `bullets[]` where net.js copies `net.wbullets` (line ~897, `bullets.length = 0`) with `fromPlayer: true` (player tracer colour).
- Each predicted shot pushes a timestamp into `net.predictedShots`.
- Host side tags: muzzle fx `{k:0,x,y,a,o}` gets `o` = shooter id when player-fired; player bullets in snapshots get `o`. Snapshot bullets with `o === net.myId` are not drawn.
- `netApplyFx` k:0 with `o === net.myId`: consume one non-expired predicted-shot entry (expiry 1000 ms); if one is consumed, skip flash and sound; if none, play as before (late flash, no loss).
- Pure helpers for the queue: push, consume (drop expired first). Unit tested.

## Constraints and risks

- js files share one global scope: new names must be grepped for collisions across `js/` before use.
- Code in js/ runs in SP, the browser client and the worker/vm: new host-only code must tolerate `MP === null`.
- Gate mismatch (client thinks it fired, host did not) leaves a stale prediction for at most 1000 ms; a later real shot's flash may then be swallowed once. Accepted.
- No code comments (user rule); English names.

## Left to the builder

Exact insertion points in `tickWorld` for history recording, naming, test file names (add new test to the `server/package.json` test chain), whether `lg` is sent every input (assumed yes).

## Assumptions

- `net.stats.interpDelay` is available on the client whenever `inputRtt` is.
- Snapshot `bul` gaining an `o` field is acceptable bandwidth-wise (a few bytes per player bullet).
- Verification in prod goes through the browser agent after deploy.
