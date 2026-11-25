# LIBRE-34 Phase 2: binary snapshot codec Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send host→guest `w` snapshots as compact binary instead of JSON text, on the WS relay and on the P2P `fast` channel, with the decoded object identical to what `JSON.parse` gives today.

**Architecture:** A schema-less tagged codec (`js/snapshot-codec.js`) with a per-frame string table and a per-frame object-shape table encodes the snapshot object the sim already builds; the decoder returns the same plain object, so `netOnSnapshot` and every payload builder stay untouched (phase 3's delta objects will reuse the same codec). The host worker sends binary frames; the server relays binary `W` frames from the hostlink as binary; the guest decodes binary on the game socket and on `fast`, and drops any binary frame that does not decode to `t === 'w'` (the binary twin of `netForgedSnapshotFrame`). Text frames keep working in both directions (server-sim mode, an old host still connected during a deploy).

**Tech Stack:** Plain browser JS in global scope (page + Web Worker), `TextEncoder`/`TextDecoder`, Node `ws` server, Node test scripts loading sources into `vm`.

**Spec:** task LIBRE-34 (board), DoD line "Phase 2: binary encoder/decoder with round-trip tests; hostlink and relay accept binary snapshots; forged-frame guard kept", plus the LIBRE-33 constraints: snapshots reach P2P guests on `fast` (unordered, maxRetransmits 0, no deflate), `rtcFreshSnapshot` drops old ticks, world events for P2P guests travel as JSON `we` frames on `rel` (unchanged).

## Global Constraints

- Worktree `.tmp/wt-libre34`, branch `feat/libre-34-binary` (from origin/main 73efc03). Never touch the main checkout `C:/workspace/Schengatto/libre-city`.
- No code comments (user rule; the codec is internal, no API doc needed). English identifiers.
- Global scope is shared by every script: new top-level names must not collide (`grep -rn "<name>" js/` before adding). Prefix codec internals with `SNAPSHOT_CODEC_` / `snapshotCodec`.
- CI Node 22, local Node 24. `TextEncoder`/`TextDecoder` exist in browsers, workers and Node 22.
- Never run `npm test` (hook blocks it). Run single files: `node server/<file>.mjs`.
- Any test that extracts functions from `net.js` into a vm (`grep -ln "readSource('net.js')\|'net.js'" server/*.mjs`) must stay green; run them all after touching net.js.
- Scratch files only in `.tmp/`. `MULTIPLAYER.md` stays in Italian.

## Codec format v1 (binding, used by Tasks 1-3)

Frame = `0xB5 0x01` (magic, version) followed by exactly one value. Varint = unsigned LEB128, values up to 2^53 (use arithmetic, not 32-bit bit ops, above 2^31). Zigzag for signed: `n >= 0 ? 2n : -2n - 1`.

| tag | meaning | payload |
|---|---|---|
| 0x00 | null | — |
| 0x01 | false | — |
| 0x02 | true | — |
| 0x03 | integer | zigzag varint |
| 0x04 | centi number | zigzag varint of `Math.round(v * 100)` |
| 0x05 | float64 | 8 bytes little-endian |
| 0x06 | new string | varint byte length + UTF-8; appended to the frame's string table |
| 0x07 | string ref | varint index into the string table |
| 0x08 | array | varint count + values |
| 0x09 | object, new shape | varint key count + keys (each a string value: 0x06 or 0x07) + values; the key list is appended to the shape table |
| 0x0A | object, shape ref | varint shape index + values in shape key order |
| 0x40-0xFF | small integer | value = tag - 0x40 (0..191) |

Encoder rules (match `JSON.stringify` semantics): object keys whose value is `undefined` or a function are skipped; in arrays they become null. `NaN`, `±Infinity` → null. `-0` → integer 0. Integer with `Number.isSafeInteger` → small int tag if 0..191, else 0x03. Non-integer with `Math.abs(v) < 1e13` and `Math.abs(v * 100 - Math.round(v * 100)) < 1e-6` → 0x04, else 0x05. Shape identity = exact ordered key list after skipping.
Decoder rules: returns `null` (never throws) on wrong magic/version, truncated input, unknown tag, out-of-range string/shape index, a count larger than the bytes left, nesting deeper than 32, or trailing bytes after the value. Key `__proto__` is decoded and its value discarded (no prototype pollution). Objects are plain `{}`; decoded centi = `zigzag / 100`.

## Review Focus

1. Hostile host: a P2P host (or anyone holding the hostlink) can send arbitrary bytes to a guest. The decoder must never throw, hang, allocate unbounded memory, or pollute prototypes. Covered by Task 1 fuzz/truncation/`__proto__`/depth tests.
2. A binary frame decoding to `{t:'ok'}`, `{t:'end'}` etc. must never reach the non-snapshot handlers on the guest. Covered by Task 3 test.
3. Mid-deploy: an old host still sends text `W|id|{json}`; server must keep relaying text, guests must keep accepting text. Covered by Task 2 (existing text relay tests stay) and Task 3.
4. Numeric fidelity: `wk`, `sp`, `an`, `aim` (0.01 grid), `cash`, `tick` (large ints), `dt` (fractional downT) must round-trip to the same value `JSON.parse` would give. Covered by Task 1 real-snapshot deep-equal test.
5. Worker → page transfer: `guestFrame.snapshot` becomes a `Uint8Array`; `rtcHostSendFrame` must send it as binary and `bufferedAmount` logic stays. Covered by Task 2 test-sim-worker / test-rtc updates.

---

### Task 1: Codec module with round-trip and hostile-input tests

**Files:**
- Create: `js/snapshot-codec.js`
- Create: `server/test-snapshot-codec.mjs`
- Modify: `server/package.json` (`"test"` chain: append `&& node test-snapshot-codec.mjs`)

**Interfaces:**
- Produces (top-level globals in `js/snapshot-codec.js`): `snapshotEncode(value) -> Uint8Array` (fresh array, safe to transfer/send), `snapshotDecode(bytes: Uint8Array) -> any | null`, `SNAPSHOT_CODEC_MAGIC = 0xB5`, `SNAPSHOT_CODEC_VERSION = 0x01`. The file must also work when `require`d / `vm`-run in Node: end it with `if (typeof module !== 'undefined') module.exports = { snapshotEncode, snapshotDecode, SNAPSHOT_CODEC_MAGIC, SNAPSHOT_CODEC_VERSION };` (same pattern as `js/sim-stubs.js` — check how that file exports).

- [ ] **Step 1: Write `server/test-snapshot-codec.mjs`** (ok/pass/fail/exit-code pattern of `server/test-vehicles.mjs:1-14`; load the codec with `createRequire` or `vm` like `sim-stubs.js` is loaded):
  - Real snapshots: `loadSim('PCODEC1')` (pattern from `server/test-vehicles.mjs:8-12`), add 4 players with `__sim.addPlayer`, tick 120 times, then for each player `const snap = __sim.snapshotFor(id)`; assert `JSON.stringify(snapshotDecode(snapshotEncode(snap))) === JSON.stringify(JSON.parse(JSON.stringify(snap)))` and `snapshotEncode(snap).length < Buffer.byteLength(JSON.stringify(snap)) / 2`.
  - Values table, each round-trips to `JSON.parse(JSON.stringify(v))`: `0, 191, 192, -1, -0, 2**31, 2**53 - 1, -(2**40), 0.01, -1.99, 7.12, 1/3, 1e300, NaN → null, Infinity → null, '', 'é漢😀', null, true, false, [], {}, [undefined, () => 1], { a: undefined, b: 1 }, [{ x: 1, y: 2 }, { x: 3, y: 4 }, { y: 5, x: 6 }]` (last one: two shapes, one reused).
  - `snapshotDecode` returns null for: empty array, `[0xB5]`, `[0xB4, 0x01, 0x00]`, `[0xB5, 0x02, 0x00]`, `[0xB5, 0x01, 0x0B]` (unknown tag), `[0xB5, 0x01, 0x07, 0x00]` (string ref with empty table), `[0xB5, 0x01, 0x0A, 0x00]` (shape ref, empty table), `[0xB5, 0x01, 0x08, 0xFF, 0xFF, 0xFF, 0x7F]` (count far beyond bytes), `[0xB5, 0x01, 0x00, 0x00]` (trailing byte), 33 nested arrays (`[0xB5, 0x01, ...Array(33).fill(0x08 /* then count 1 */)]` built as `0x08 0x01` repeated 33 times then `0x00`), while 32 nested arrays decode fine.
  - Truncation: for a real encoded snapshot, `snapshotDecode(bytes.subarray(0, k))` is null for every `k` from 0 to `length - 1`, and never throws.
  - Fuzz: 2000 random mutations (seeded PRNG, flip 1-4 random bytes of a real encoded snapshot) never throw (wrap in try/catch, count throws, assert 0).
  - Pollution: encode `JSON.parse('{"__proto__":{"polluted":1},"t":"w"}')`; decoded value has `t === 'w'`, `({}).polluted === undefined`, `Object.getPrototypeOf(decoded) === Object.prototype`.

- [ ] **Step 2: Run, expect failure** — `node server/test-snapshot-codec.mjs` fails (module missing).

- [ ] **Step 3: Implement `js/snapshot-codec.js`** per "Codec format v1". Encoder: one module-level growable `Uint8Array` + `DataView` (double when full) reused across calls, string table `Map<string, index>` and shape table `Map<joinedKeys, index>` cleared per call (`joinedKeys` = keys joined by `'\u0000'`), returns `buffer.slice(0, length)`. UTF-8 via one shared `TextEncoder` / `TextDecoder`. Decoder: cursor over the input with bounds checks on every read; recursion with a depth argument.

- [ ] **Step 4: Run** `node server/test-snapshot-codec.mjs` → all OK, exit 0.

- [ ] **Step 5: Commit** — `git add js/snapshot-codec.js server/test-snapshot-codec.mjs server/package.json && git commit -m "feat(net): binary snapshot codec"`

### Task 2: Host and server send binary snapshots

**Files:**
- Modify: `js/sim-worker.js:3` (`SIM_SCRIPT_FILES`: add `'snapshot-codec.js'` before `'server-sim-glue.js'`), `:68-85` (`postGuestFrame`, `sendSnapshots`)
- Modify: `server/sim-runtime.js:28` (`SIM_FILES`: same insertion; this feeds the worker bundle via `build-sim-worker.js` and every vm test)
- Modify: `js/server-sim-glue.js` payload angles: `tur` (`carPayload`), bullet `a`, rocket `a`, muzzle fx `a` → `round2(...)`
- Modify: `server/index.js:931-933` (hostlink message handler), `:529-536` (`relaySnapshot`), constants near `:71-72`
- Modify tests: `server/test-sim-worker.mjs:94-131`, `server/test-host-mode.mjs` (add binary relay cases), `server/test-snapshot-payload.mjs` (angle assertions for `tur`/bullet `a` only if cheap), `.tmp/host-bandwidth.mjs` is scratch (Task 3)

**Interfaces:**
- Consumes: `snapshotEncode` (Task 1).
- Produces: hostlink binary frame = `0x57` (`'W'`), one byte `idLength` (1..255), the guest id in UTF-8, then the codec bytes (starting `0xB5 0x01`). `guestFrame.snapshot` posted by the worker is that codec `Uint8Array` (no `W`/id prefix; posted with `[snapshot.buffer]` as transfer list). The server relays the codec bytes to the guest's game socket with `{ binary: true }`.

- [ ] **Step 1: Tests first**
  - `server/test-sim-worker.mjs`: guest frames to `p2`/`p3` are now binary (`frame instanceof Uint8Array || Buffer.isBuffer(frame)`), `frame[0] === 0x57`, id decodes to `'p2'`, `snapshotDecode(frame.subarray(2 + frame[1]))` has `t === 'w'` and a `me` object; the host still never gets a frame for `p1`; P2P guest `guestFrame.snapshot` is a `Uint8Array` that decodes to `t === 'w'` with `fx` empty and `me.ev === null` (events still go in the JSON `events` string). Load the codec into the test the same way Task 1's test does.
  - `server/test-host-mode.mjs`, next to the existing text relay cases (`:211-214`, `:322-324`): a binary hostlink frame `W`+id+codec bytes reaches playerB as a binary message equal to the codec bytes; a binary frame for an unknown id is not relayed; a binary frame whose payload does not start with `0xB5 0x01` is not relayed and does not terminate the link; a binary frame not starting with `0x57` terminates the hostlink; a binary message before the hostlink hello terminates it (existing behaviour kept); the existing text `W|` cases still pass unchanged.
- [ ] **Step 2: Run both, expect failures.**
- [ ] **Step 3: Implement**
  - Worker: `const frame = snapshotEncode(snapshot)`; WS path builds the `0x57 | idLength | id | frame` buffer (`TextEncoder` for the id) and `socket.send(buffer)`; P2P path posts `frame` with transfer. `sendToServer` keeps handling strings/objects for `hst` and other JSON.
  - Server: in the hostlink `message` handler, binary is allowed only when `ws._hostRoom` is set and `data[0] === 0x57`; otherwise keep `ws.terminate()`. Rate limit applies to both. Binary goes to a new `relayBinarySnapshot(room, data)`: `idLength = data[1]`, require `data.length > 2 + idLength + 2`, target id = `data.toString('utf8', 2, 2 + idLength)`, payload = `data.subarray(2 + idLength)`, require `payload[0] === 0xB5 && payload[1] === 0x01`, then the same target/gone/readyState/bufferedAmount checks as `relaySnapshot` (extract them into one shared helper instead of duplicating) and `target.ws.send(payload, { binary: true })`. Update `room.hostLastFrameAt` for binary frames too. New constants `BINARY_SNAPSHOT_FRAME_BYTE = 0x57`, `SNAPSHOT_CODEC_HEADER = [0xB5, 0x01]` (server does not load the codec file).
  - Glue: `round2` on `tur`, bullet `a`, rocket `a`, `spawnMuzzle` `a`.
- [ ] **Step 4: Run** `node server/test-sim-worker.mjs`, `node server/test-host-mode.mjs`, `node server/test-sim-host.mjs`, `node server/test-snapshot-payload.mjs`, `node server/test-fire-prediction.mjs`, `node server/test-sim.mjs` → all exit 0.
- [ ] **Step 5: Commit** — `git commit -m "feat(net): host sends binary snapshots, server relays them"`

### Task 3: Guests decode binary on the socket and on `fast`; measure

**Files:**
- Modify: `index.html` (add `<script src="js/snapshot-codec.js"></script>` right before `js/net.js`; `build.js` copies every script index.html references — verify with `grep -n "localScripts" build.js`)
- Modify: `js/net.js:137-139` (`ws.onmessage`; set `ws.binaryType = 'arraybuffer'` where the socket is created at `:125`)
- Modify: `js/rtc.js:81-84` (`rtcParseMessage`) and the `fast`/`rel` channel setup (`binaryType = 'arraybuffer'` in `rtcCreatePeer` `:42-50`)
- Modify tests: `server/test-rtc.mjs` (stub/load codec; binary fast message path), `server/test-sim-host.mjs:103-113` (guard regex still matches; add binary guard test)
- Modify: `MULTIPLAYER.md` bandwidth section; `.tmp/host-bandwidth.mjs` (scratch: count binary `W` frames too)

**Interfaces:**
- Consumes: `snapshotDecode` (Task 1), binary frame layout (Task 2).
- Produces: `netDecodeBinarySnapshot(data: ArrayBuffer) -> object | null` in `js/net.js` = `snapshotDecode(new Uint8Array(data))`, returning null unless the result is a non-null object with `t === 'w'`. `rtcParseMessage(data)` returns the same for `ArrayBuffer` input, JSON parse for strings (unchanged).

- [ ] **Step 1: Tests first**
  - `server/test-sim-host.mjs` (vm-extract like `:103-108`, plus the codec): `netDecodeBinarySnapshot(encode({t:'w',cars:[]}).buffer)` is the object; for `{t:'ok'}`, `{t:'end'}`, `{x:1}`, a number, garbage bytes → null; regex check that `ws.onmessage` routes `ArrayBuffer` data through `netDecodeBinarySnapshot` before any other handling and that `netForgedSnapshotFrame(ev.data, m)` is still there for text.
  - `server/test-rtc.mjs`: `rtcGuestOnFastMessage(encodedSnapshot.buffer)` reaches `netOnSnapshot` with the decoded object and updates `lastTick`; an older tick is still dropped (`rtcFreshSnapshot`); a binary frame decoding to `{t:'we'}` on fast is dropped; `rtcHostSendFrame('p2', uint8Array, null)` passes the array to `fast.send` unchanged.
- [ ] **Step 2: Run, expect failures.**
- [ ] **Step 3: Implement** — net.js: in `ws.onmessage`, `if (ev.data instanceof ArrayBuffer) { const m = netDecodeBinarySnapshot(ev.data); if (m) netOnSnapshot(m) ...` — follow whatever the text path does for a `w` message after `settled` (read `:137-160` and route the binary snapshot into the exact same branch the text `w` takes, so ack/stats/tick handling is identical); never let a binary frame reach other handlers. rtc.js: `rtcParseMessage` accepts `ArrayBuffer` via `netDecodeBinarySnapshot` (guard `typeof netDecodeBinarySnapshot === 'function'`), `binaryType = 'arraybuffer'` on both channels. Do not change `netOnSnapshot`.
- [ ] **Step 4: Run** `node server/test-sim-host.mjs`, `node server/test-rtc.mjs`, and every vm test of net.js: `node server/test-rail.mjs`, `test-dents`, `test-vehicles`, `test-traffic-lead`, `test-fire-prediction`, `test-net-stats`, `test-snapshot-payload`, plus `test-server-sim` (text path, server-sim mode) → all exit 0. Run `node build.js` into a temp dir only if build.js supports it; otherwise check `grep -n "snapshot-codec" build.js index.html` shows the script is picked up by the index.html scan.
- [ ] **Step 5: Measure** — edit `.tmp/host-bandwidth.mjs` so frames are the binary `W` buffers (`frame[0] === 0x57`), byte length = `frame.length`; deflate the same way. Run seeds 1-5 at `LEVEL=6`, save to `.tmp/bw-phase2.txt`. Add a "LIBRE-34 fase 2" table to `MULTIPLAYER.md` (columns: fase 1 / fase 2, mean / max for raw KB/s, bytes per frame, no context takeover, context takeover; phase 1 numbers are in `.tmp/bw-after.txt`).
- [ ] **Step 6: Commit** — `git commit -m "feat(net): guests decode binary snapshots on socket and fast channel"`
