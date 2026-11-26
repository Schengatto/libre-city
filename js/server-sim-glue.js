// LIBRE CITY · js/server-sim-glue.js — HEADLESS glue for the authoritative simulation
// (Phase 2).
//
// This is NOT included in index.html: it is appended to the END of the sim bundle by
// server/sim-runtime.js alone (Node + vm), so it shares the global scope of the game's
// classic <script> tags and can read/write player/cars/peds and call the sim's functions.
// It holds:
//   1) the INPUT SHIMS that live in input.js in the browser (absent on the server);
//   2) the MULTIPLAYER state (players[]) and the tick orchestration;
//   3) vehicle enter/exit and the horn (condensed, from input.js);
//   4) the `__sim` control API the Node harness calls across the vm boundary.
//
// Model: ONE authoritative city per room. The AI and damage are made multiplayer-aware by
// the helpers in entities.js (nearestPlayer/eachActivePlayer/asPlayer), switched on by
// setting MP = players. The wanted level is per-ROOM (shared heat) in this first version;
// cash/death/respawn are per player.

started = true;                          // enables weaponKey etc. (no rendering on the server)

// ---- Input shims: they read the command of the player currently being simulated ----
var __curInput = { ax: 0, ay: 0, aim: 0, fireHeld: false, fireEdge: false };
var keys = {};
var touchDrive = { active: false, angle: 0 };
var usingTouch = false;
var missionsOn = false;                  // no missions in authoritative mode
var mDownL = false, mClicked = false;

function held(...codes) {
  const i = __curInput;
  for (const c of codes) {
    if ((c === 'KeyD' || c === 'ArrowRight') && i.ax > 0) return true;
    if ((c === 'KeyA' || c === 'ArrowLeft')  && i.ax < 0) return true;
    if ((c === 'KeyS' || c === 'ArrowDown')  && i.ay > 0) return true;
    if ((c === 'KeyW' || c === 'ArrowUp')    && i.ay < 0) return true;
  }
  return false;
}
// There is no mouse on the server: we rebuild a point in front of the player from the
// transmitted aim angle, so that atan2(mouseWY-y, mouseWX-x) returns that angle
// (weapons/turret/hydrant).
function mouseWX() { return player.x + Math.cos(__curInput.aim) * 130; }
function mouseWY() { return player.y + Math.sin(__curInput.aim) * 130; }
function applyTouchInput() {}            // the glue drives the tick

// ===== Multiplayer state =====
var players = [];
MP = players;                            // switches the sim helpers onto the multiplayer path
var __playerSeq = 0;

function makeSimPlayer(name, shirtIdx) {
  const sp = randomPublicRoadNear(WORLD_W / 2, WORLD_H / 2, 0, 500) || nodes[Math.floor(nodes.length / 2)];
  return {
    id: 'p' + (++__playerSeq), name: String(name || 'Ospite').slice(0, 14), shirtIdx: shirtIdx | 0,
    x: sp.x, y: sp.y, r: 8, health: 100, aim: 0, walk: 0, moving: false,
    car: null, shootCd: 0, hurtCd: 0, punchT: 0,
    weaponIdx: 0, owned: WEAPONS.map(w => !w.price),
    shirt: '#e0533a', skin: '#f6c79a', hair: '#5a3a1a',
    wanted: 0, wantedHeat: 0, crimeCd: 0,         // PER-PLAYER wanted level
    cash: 0, downT: 0, downKind: null, kills: 0, deaths: 0,
    score: 0, streak: 0, bounty: 0, events: [],   // score/streak/bounty + the player's queued toast messages
    input: { ax: 0, ay: 0, aim: 0, fireHeld: false, fireEdge: false, enterExit: false, horn: false, weapon: null, lagMs: 0 },
    hist: createBodyHistory(),
  };
}
function playerById(id) { for (const p of players) if (p.id === id) return p; return null; }
// Marshals the per-player globals (downT/downKind/cash) around that player's phase.
function loadP(pl) { player = pl; downT = pl.downT | 0; downKind = pl.downKind; cash = pl.cash | 0;
  wantedHeat = pl.wantedHeat || 0; wanted = pl.wanted | 0; crimeCd = pl.crimeCd | 0; playerOwningGlobals = pl; }
function saveP(pl) { pl.downT = downT; pl.downKind = downKind; pl.cash = cash;
  pl.wantedHeat = wantedHeat; pl.wanted = wanted; pl.crimeCd = crimeCd; playerOwningGlobals = null; }

// ---- Carjacking: throws the driver out (from input.js:tossDriver) ----
// input.js is NOT in the server bundle, but the glue calls this when a player gets into a
// traffic/police/army car: without this copy the sim threw "tossDriver is not defined" on
// EVERY tick (the enterExit flag was never cleared) and the authoritative world froze for
// everyone. `hear`/`sfx` are already no-op stubs on the server.
function tossDriver(c) {
  const nx = Math.cos(c.angle + Math.PI / 2), ny = Math.sin(c.angle + Math.PI / 2);
  const side = (player.x - c.x) * nx + (player.y - c.y) * ny > 0 ? -1 : 1;
  let ex = c.x + nx * side * (c.h / 2 + 20), ey = c.y + ny * side * (c.h / 2 + 20);
  if (boxHits(ex, ey, 7, 7)) { ex = c.x - nx * side * (c.h / 2 + 20); ey = c.y - ny * side * (c.h / 2 + 20); }
  if (boxHits(ex, ey, 7, 7)) { ex = c.x + Math.cos(c.angle) * (c.w / 2 + 18); ey = c.y + Math.sin(c.angle) * (c.w / 2 + 18); }
  const p = makePed(ex, ey, 'civ');
  if (c.riderShirt) p.shirt = c.riderShirt;
  if (c.role === 'police' || c.wasPolice) { p.shirt = '#20407a'; p.hair = '#1a1a2a'; p.copDress = true; }
  if (c.role === 'armycar' || c.livery === 'army') { p.shirt = '#3d5226'; p.hair = '#2a2a1e'; p.soldierDress = true; }
  p.stolenBike = !!c.isBike;
  const a = Math.atan2(ey - c.y, ex - c.x);
  p.ko = true; p.getsUp = true; p.koT = rndi(55, 85);
  p.kx = Math.cos(a) * 3.4; p.ky = Math.sin(a) * 3.4;
  p.spin = rnd(-0.5, 0.5);
  peds.push(p);
  sfx.thud(); sfx.yell(hear(ex, ey, 700));
}

// ---- Enter / exit (condensed, from input.js:toggleCar, without toasts/missions/net) ----
function simEnterExit(pl) {
  if (pl.downT > 0) return;
  if (pl.car) {                          // step out beside the car, onto a free spot
    const c = pl.car;
    const nx = Math.cos(c.angle + Math.PI / 2), ny = Math.sin(c.angle + Math.PI / 2);
    let ex = c.x + nx * 34, ey = c.y + ny * 34;
    if (boxHits(ex, ey, pl.r, pl.r)) { ex = c.x - nx * 34; ey = c.y - ny * 34; }
    if (boxHits(ex, ey, pl.r, pl.r)) { ex = c.x; ey = c.y; }
    pl.x = ex; pl.y = ey;
    c.driver = null; c.speed = 0; c.role = 'parked'; c.edge = null;   // it stays put: everyone sees it
    pl.car = null;
    return;
  }
  let best = null, bd = 52;
  for (const c of cars) { if (c.driver) continue; const d = dist(c.x, c.y, pl.x, pl.y); if (d < bd) { bd = d; best = c; } }
  if (!best) return;
  if (best.role === 'traffic' || best.role === 'police' || best.role === 'armycar') { player = pl; tossDriver(best); }
  pl.car = best; best.driver = 'player'; best.owner = pl.id;
  if (best.role === 'traffic' || best.role === 'parked') best.role = 'player';
  if (best.isTank) {                     // stealing a tank sets the army off
    let lm = null, bdl = Infinity;
    for (const l of landmarks) if (l.type === 'army') { const d = dist(l.cx, l.cy, pl.x, pl.y); if (d < bdl) { bdl = d; lm = l; } }
    if (lm) { player = pl; triggerArmyAlert(lm); }
  }
}
function simHorn(pl) {
  const c = pl.car; if (!c) return;
  if (c.wasPolice || c.livery === 'ambulance' || c.livery === 'fire') c.sirenOn = !c.sirenOn;
}

// ===== The authoritative world's tick (replaces gameplay.js's update()) =====
function tickWorld() {
  __shooterId = null;
  updateLights();
  // --- PER-PLAYER PHASE: each acts with their own globals marshalled in ---
  for (const pl of players) {
    __shooterId = pl.id;
    loadP(pl);
    __curInput = pl.input;
    mDownL = pl.input.fireHeld; mClicked = pl.input.fireEdge;
    if (pl.hurtCd > 0) pl.hurtCd--;
    if (downT > 0) {
      const wasDown = downT;
      updateDown();                              // on expiry respawns at hospital/station (moves player.x/y)
      // Just respawned: the SERVER commands the position until the client realigns to the
      // respawn point. Without this, on the next tick pl.rx/pl.ry (still the DEATH point
      // reported by the client) would overwrite the respawn → you restart where you died.
      if (wasDown > 0 && downT === 0) pl.teleHold = true;
    } else {
      // One-shot flags must be cleared BEFORE acting: if the action throws, the flag does
      // not stay "stuck" and throw again on every tick.
      if (pl.input.weapon != null) { const w = pl.input.weapon; pl.input.weapon = null; weaponKey(w); }
      if (pl.input.enterExit) { pl.input.enterExit = false; simEnterExit(pl); }
      if (pl.input.horn)      { pl.input.horn = false;      simHorn(pl); }
      if (pl.car) updateDrive(pl.car); else updatePlayerFoot();
      // CLIENT-AUTHORITATIVE: the client decides the position. We overwrite the one the
      // server simulated (the server's movement is discarded; the firing/interactions above
      // already happened from the reported position). Only while alive.
      if (pl.hasReport && pl.teleHold) {
        // After a respawn the client still reports the death point: ignore it until it
        // matches the respawn point (on receiving the snapshot the client teleports there
        // and starts reporting that position). The threshold is ABOVE the client's teleport
        // threshold (300, net.js): so once the client is close enough NOT to teleport, we
        // unblock here anyway (no stall).
        if (dist(pl.rx, pl.ry, pl.x, pl.y) < 320) pl.teleHold = false;
      } else if (pl.hasReport) {
        pl.x = pl.rx; pl.y = pl.ry;
        if (pl.car && pl.rcx != null) { pl.car.x = pl.rcx; pl.car.y = pl.rcy;
          if (pl.rca != null) pl.car.angle = pl.rca; if (pl.rcsp != null) pl.car.speed = pl.rcsp; }
      }
      updateHealPads();
    }
    // PER-PLAYER wanted-level decay (individual heat).
    if (crimeCd > 0) crimeCd--;
    else if (wantedHeat > 0) { wantedHeat = Math.max(0, wantedHeat - 0.0016); wanted = Math.floor(wantedHeat); }
    pl.input.fireEdge = false;
    saveP(pl);
    if (pl.downT === 0) bodyHistoryRecord(pl.hist, frame, (pl.car || pl).x, (pl.car || pl).y);
  }
  __shooterId = null;
  // The SHARED world (police density, pedestrian reactions) responds to the MOST wanted
  // player present: set the room globals to the maximum across the players.
  { let mh = 0, mw = 0; for (const pl of players) { if (pl.wantedHeat > mh) mh = pl.wantedHeat; if ((pl.wanted | 0) > mw) mw = pl.wanted | 0; }
    wantedHeat = mh; wanted = mw; }
  // --- SHARED WORLD PHASE (sim functions unchanged) ---
  updateTrainKinematics();                       // train position (needed by trainBlocking inside updateCar)
  for (const c of cars) updateCar(c);
  resolveCarCollisions();
  for (const pl of players) if (pl.car) { pl.x = pl.car.x; pl.y = pl.car.y; }   // resync whoever is driving
  trainCollide();                                // train = solid wall: after movement
  for (const p of peds) updatePed(p);
  updateBullets();
  updateRockets();
  updateParts();
  updateCoins();
  updateArmy();
  updateFires();
  updateBurningCars();
  updateWater();
  managePopulation();
  frame++;
}

// ===== Network payloads (the same shapes the client already knows how to decode) =====
const R2 = v => Math.round(v);
const round2 = v => Math.round(v * 100) / 100;
function carPayload(c) {
  return { id: c.id, x: R2(c.x), y: R2(c.y), an: round2(c.angle), sp: round2(c.speed),
           w: c.w, h: c.h, col: c.color, role: c.role,
           bike: !!c.isBike, tank: !!c.isTank, taxi: !!c.isTaxi, del: !!c.isDelivery,
           liv: c.livery || null, pol: !!c.wasPolice, hel: c.helmet || null,
           tur: c.isTank ? round2(c.turretA) : null, siren: !!c.sirenOn, lp: c.lightPhase || 0,
           burn: !!c.burning, smk: !!c.smoking, dn: c.dents || undefined };
}
function drivenCarPayload(c) {
  return { ...carPayload(c), top: c.top, acc: c.accel, mass: c.mass, gears: c.gears };
}
function pedPayload(p) {
  return { id: p.id, x: R2(p.x), y: R2(p.y), f: p.facing || 0, wk: round2(p.walk || 0),
           role: p.role, ko: !!p.ko, sh: p.shirt, sk: p.skin, ha: p.hair, dr: p.copDress ? 1 : p.soldierDress ? 2 : 0 };
}
function playerView(p) {
  return { id: p.id, name: p.name, sh: p.shirtIdx, x: R2(p.x), y: R2(p.y), aim: round2(p.aim),
           wk: round2(p.walk || 0), mov: !!p.moving,
           gun: !WEAPONS[p.weaponIdx].melee, hp: R2(p.health), down: p.downT > 0,
           punch: p.punchT > 0, car: p.car ? carPayload(p.car) : null };
}
const SNAPSHOT_PAYLOAD_IDS = new WeakMap();
let snapshotPayloadIdSeq = 1;
function snapshotPayloadId(entity) {
  let id = SNAPSHOT_PAYLOAD_IDS.get(entity);
  if (id === undefined) {
    id = snapshotPayloadIdSeq++;
    SNAPSHOT_PAYLOAD_IDS.set(entity, id);
  }
  return id;
}
// ---- Cosmetic effects → 'fx' events for the client ----
// Particles are of no use on the server: we intercept gameplay.js's spawn* calls and turn
// them into lightweight events (position + type), sent inside the snapshots. The client
// recreates them (particles + audio via hear). Muzzle flashes/blood/sparks/explosions are
// therefore seen and heard in multiplayer too, without growing `parts` on the server.
var __fx = [];
var __shooterId = null;
spawnMuzzle = (x, y, a) => { const effect = { k: 0, x: R2(x), y: R2(y), a: round2(a) }; if (__shooterId !== null) effect.o = __shooterId; __fx.push(effect); };
spawnBlood = (x, y) => { __fx.push({ k: 1, x: R2(x), y: R2(y) }); };
spawnSparks = (x, y, n) => { __fx.push({ k: 2, x: R2(x), y: R2(y), n: n | 0 }); };
spawnExplosion = (x, y) => { __fx.push({ k: 3, x: R2(x), y: R2(y) }); };

const AOI_R = 1200;                       // area-of-interest radius around each player

// World snapshot for player `id`: only entities within AOI_R of them.
function snapshotFor(id) {
  const me = playerById(id); if (!me) return null;
  const mx = me.x, my = me.y, R = me.aoi || AOI_R, R2q = R * R;
  const near = (x, y) => { const dx = x - mx, dy = y - my; return dx * dx + dy * dy <= R2q; };
  const out = {
    t: 'w', tick: frame, ack: me.input.seq || 0,
    me: { x: R2(me.x), y: R2(me.y), aim: round2(me.aim), hp: R2(me.health), cash: me.cash,
          wanted: me.wanted | 0, down: me.downT > 0, dt: me.downT, dk: me.downKind, wp: me.weaponIdx, own: me.owned.slice(),
          k: me.kills, d: me.deaths, sco: me.score | 0, stk: me.streak | 0, bty: me.bounty | 0,
          ev: (me.events && me.events.length) ? me.events.splice(0) : null,   // queued toasts → consumed here
          car: me.car ? drivenCarPayload(me.car) : null },
    players: [], cars: [], peds: [], bul: [], rkt: [], coins: [], fires: [], fx: [],
  };
  for (const e of __fx) if (near(e.x, e.y)) out.fx.push(e);
  // PLAYERS are ALWAYS propagated, at any distance (NO AOI filter): there are very few of
  // them (<=8) and everyone needs their position for the minimap/indicators and to avoid
  // "freezing" a rival's ghost as you move away. Only the shared world
  // (traffic/pedestrians/bullets) stays AOI-filtered, which is where the real cost is.
  for (const p of players) if (p !== me) out.players.push(playerView(p));
  for (const c of cars) if (c.driver !== 'player' && near(c.x, c.y)) out.cars.push(carPayload(c));
  for (const p of peds) if (near(p.x, p.y)) out.peds.push(pedPayload(p));
  for (const b of bullets) if (near(b.x, b.y)) {
    const entry = { x: R2(b.x), y: R2(b.y), a: round2(Math.atan2(b.vy, b.vx)), hostile: !b.fromPlayer, fl: b.flame ? 1 : 0 };
    if (b.fromPlayer && b.owner && b.owner.id) entry.o = b.owner.id;
    out.bul.push(entry);
  }
  for (const r of rockets) if (near(r.x, r.y)) out.rkt.push({ x: R2(r.x), y: R2(r.y), a: round2(Math.atan2(r.vy, r.vx)), gr: r.grenade ? 1 : 0 });
  for (const k of coins) if (near(k.x, k.y)) out.coins.push({ id: snapshotPayloadId(k), x: R2(k.x), y: R2(k.y), v: k.val });
  for (const f of fires) if (near(f.x, f.y)) out.fires.push({ id: snapshotPayloadId(f), x: R2(f.x), y: R2(f.y) });
  return out;
}

const RESTORABLE_NUMBER_FIELDS = {
  x: () => ['x', 0, WORLD_W, false], y: () => ['y', 0, WORLD_H, false],
  hp: () => ['health', 0, 100, false], cash: () => ['cash', 0, 1e9, true],
  k: () => ['kills', 0, 1e9, true], d: () => ['deaths', 0, 1e9, true], s: () => ['score', 0, 1e9, true],
  stk: () => ['streak', 0, 1e9, true], b: () => ['bounty', 0, 1e9, true],
  wanted: () => ['wanted', 0, 5, true], wantedHeat: () => ['wantedHeat', 0, 5.99, false],
};

// ===== Control API exposed to the Node harness (top-level var ⇒ property of the global) =====
const STALE_INPUT_WINDOW = 64;
var __sim = {
  addPlayer(name, shirtIdx, id) { const pl = makeSimPlayer(name, shirtIdx); if (id) pl.id = id; players.push(pl); return pl.id; },
  removePlayer(id) {
    const pl = playerById(id); if (!pl) return;
    if (pl.car) { pl.car.driver = null; pl.car.role = 'parked'; pl.car.edge = null; pl.car = null; }
    players.splice(players.indexOf(pl), 1);
  },
  applyInput(id, cmd) {
    const pl = playerById(id); if (!pl || !cmd) return;
    const i = pl.input;
    const stale = cmd.seq != null && i.seq != null && cmd.seq <= i.seq && i.seq - cmd.seq < STALE_INPUT_WINDOW;
    if (cmd.b != null) {
      if (!stale) i.fireHeld = !!(cmd.b & 1);
      if (cmd.b & 2) i.fireEdge = true; if (cmd.b & 4) i.enterExit = true; if (cmd.b & 8) i.horn = true;
    }
    if (cmd.w != null) i.weapon = cmd.w;
    if (!stale) {
      if (cmd.ax != null) i.ax = cmd.ax; if (cmd.ay != null) i.ay = cmd.ay;
      if (cmd.aim != null) i.aim = cmd.aim; if (cmd.seq != null) i.seq = cmd.seq;
      if (cmd.drive) { touchDrive.active = !!cmd.drive.active; touchDrive.angle = cmd.drive.angle || 0; }
      if (cmd.lg != null) i.lagMs = Number.isFinite(cmd.lg) ? Math.min(LAG_COMP_MAX_MS, Math.max(0, cmd.lg)) : 0;
      // CLIENT-AUTHORITATIVE POSITION: the player owns their own movement. We store it here
      // and tickWorld applies it after the player's sim (firing/interactions stay server-side,
      // from the position the client reported).
      if (cmd.px != null) {
        pl.rx = cmd.px; pl.ry = cmd.py; pl.hasReport = true;
        if (cmd.cx != null) { pl.rcx = cmd.cx; pl.rcy = cmd.cy; pl.rca = cmd.ca; pl.rcsp = cmd.csp; }
        else pl.rcx = null;
      }
    }
    // Adaptive area-of-interest radius requested by the client (clamped: never so small
    // that entities pop in on screen, never above the default cap).
    if (cmd.vr != null) pl.aoi = Math.max(650, Math.min(AOI_R, cmd.vr));
  },
  tick() { tickWorld(); },
  setPolice(enabled) { policeOn = enabled === true; },
  snapshotFor,
  clearFx() { __fx.length = 0; },        // the server clears the fx after each snapshot round
  playerState(id) { const p = playerById(id); return p ? { id: p.id, x: R2(p.x), y: R2(p.y), hp: R2(p.health), cash: p.cash, down: p.downT > 0, inCar: !!p.car, wanted: p.wanted | 0 } : null; },
  scores() { return players.map(p => ({ id: p.id, name: p.name, k: p.kills, d: p.deaths, c: p.cash, s: p.score | 0, b: p.bounty | 0 })); },
  playerCount() { return players.length; },
  exportPlayers() {
    return players.map(p => ({
      id: p.id, name: p.name, shirtIdx: p.shirtIdx, x: p.x, y: p.y, hp: p.health, cash: p.cash,
      k: p.kills, d: p.deaths, s: p.score, stk: p.streak, b: p.bounty,
      own: p.owned.slice(), wp: p.weaponIdx, wanted: p.wanted, wantedHeat: p.wantedHeat,
    }));
  },
  restorePlayer(id, name, shirtIdx, state) {
    if (typeof id !== 'string' || !id) return;
    __sim.removePlayer(id);
    __sim.addPlayer(name, shirtIdx, id);
    const pl = playerById(id);
    if (!state || typeof state !== 'object') return;
    for (const key in RESTORABLE_NUMBER_FIELDS) {
      const [field, min, max, integer] = RESTORABLE_NUMBER_FIELDS[key](), value = state[key];
      if (typeof value === 'number' && Number.isFinite(value)) pl[field] = clamp(integer ? Math.trunc(value) : value, min, max);
    }
    if (!policeOn) { pl.wanted = 0; pl.wantedHeat = 0; }
    if (Number.isInteger(state.wp) && state.wp >= 0 && state.wp < WEAPONS.length) pl.weaponIdx = state.wp;
    if (Array.isArray(state.own)) pl.owned = WEAPONS.map((w, i) => state.own[i] === true || !w.price);
  },
  _player(id) { return playerById(id); },   // tests only: direct reference to the player object
  _spawnPed(x, y, role) { const p = makePed(x, y, role); peds.push(p); return p; },   // tests only
  _cars() { return cars; },                 // tests only: traffic/collisions
  _nearestThreatCar(x, y, range) { return nearestThreatCar(x, y, range); },
  _gapAhead(c, maxLook, push) { return gapAhead(c, maxLook, push); },
  _tileSize() { return T; },
  _peds() { return peds; },
  _landmarks() { return landmarks; },
  _tileAt(tx, ty) { return tileAt(tx, ty); },
  _randomWalkNear(x, y, rmin, rmax) { return randomWalkNear(x, y, rmin, rmax); },
  _roadGraph() { return { nodes, edges }; },
  _cityWidth() { return MAP_W; },
  _tileKinds() { return { ROAD, SIDEWALK, BUILDING, GRASS, TREE, WATER, ALLEY, COURT, SAND, QUAY, PROP }; },
  _rail() { return { loopLen: RAIL_LOOP_LEN, crossings: railCrossings, pointAt: railPointAt }; },
  _train() { return train; },
  _setFrame(f) { frame = f; updateTrainKinematics(); },
  _trainBlocking(c) { return trainBlocking(c); },
  _trainCollide() { trainCollide(); },
  // --- Diagnostics for the tests ---
  worldInfo() {
    let sig = 0;
    for (let i = 0; i < grid.length; i++) sig = (sig * 31 + grid[i]) | 0;
    for (const l of landmarks) sig = (sig * 31 + l.x0 * 7 + l.y0 * 13 + l.type.charCodeAt(0)) | 0;
    return { room: ROOM_CODE, worldW: WORLD_W, worldH: WORLD_H, nodes: nodes.length, edges: edges.length, landmarks: landmarks.length, sig };
  },
  counts() { return { frame, cars: cars.length, peds: peds.length, coins: coins.length, bullets: bullets.length, players: players.length }; },
};
