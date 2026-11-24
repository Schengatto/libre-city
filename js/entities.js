// LIBRE CITY · js/entities.js — game state, saved profile, player and weapons, traffic
// lights, entity factories (cars, pedestrians, service vehicles, coins) and initial spawn.

// ---------- State ----------
const DIRS = [ {x:1,y:0}, {x:-1,y:0}, {x:0,y:1}, {x:0,y:-1} ];
// "Pedestrian-friendly" tiles: where passers-by are happy to be.
const pedFriendly = t => t === SIDEWALK || t === GRASS || t === ALLEY || t === SAND || t === QUAY;
const tileTypeAt = (wx, wy) => tileAt(Math.floor(wx / T), Math.floor(wy / T));
// Direction choice from standstill: prefers pavements, avoids the carriageway.
function pickWalkDir(p) {
  const soft = [], road = [];
  for (const d of DIRS) {
    const t = tileTypeAt(p.x + d.x * 22, p.y + d.y * 22);
    if (t === BUILDING || t === TREE || t === WATER || t === PROP) continue;   // obstacles: discarded
    (t === ROAD ? road : soft).push(d);
  }
  if (soft.length && (road.length === 0 || Math.random() < 0.9)) return pick(soft);
  if (road.length) return pick(road);
  return pick(DIRS);
}
// Cardinal direction towards the nearest pavement, for a pedestrian stuck on the road.
function toNearestSidewalk(wx, wy) {
  const cx = Math.floor(wx / T), cy = Math.floor(wy / T);
  for (let r = 1; r <= 5; r++) for (const d of DIRS)
    if (pedFriendly(tileAt(cx + d.x * r, cy + d.y * r))) return d;
  return null;
}
const cars = [];       // every vehicle (traffic, police, driven)
const peds = [];       // pedestrians (civilians + cops on foot)
const bullets = [];
const parts = [];      // particles (blood, sparks, smoke)
const decals = [];     // ground stains
const pickups = [];    // cash to collect (from run-over passers-by)
const coins = [];      // coins scattered around the city
const fires = [];      // fires to put out with the fire engine
const water = [];      // water droplets from the hydrant
const rockets = [];    // rockets fired by the tank
const pops = [];       // floating score numbers ("+50") at the spot of the action

// ---------- Traffic lights ----------
const LIGHT_G = 60 * 7, LIGHT_Y = 46;                  // green / amber duration (frames)
const LIGHT_CYCLE = (LIGHT_G + LIGHT_Y) * 2;
let lightClock = 0;
let hState = 'green', vState = 'red';                  // lamp state on the horizontal / vertical axis
let greenH = true, greenV = false;                     // right of way on the horizontal / vertical axis
function updateLights() {
  lightClock++;
  const t = lightClock % LIGHT_CYCLE;
  if (t < LIGHT_G)                     { hState = 'green';  vState = 'red';    }
  else if (t < LIGHT_G + LIGHT_Y)      { hState = 'yellow'; vState = 'red';    }
  else if (t < 2 * LIGHT_G + LIGHT_Y)  { hState = 'red';    vState = 'green';  }
  else                                 { hState = 'red';    vState = 'yellow'; }
  greenH = hState !== 'red';                           // on amber you carry on (clears the junction)
  greenV = vState !== 'red';
}

let cash = 0;
let wantedHeat = 0;    // continuous wanted level (0..5.99)
let wanted = 0;        // whole stars
let crimeCd = 0;       // delay before the wanted level starts to decay
let started = false, frame = 0;
let paused = false;

// ---------- Profile and settings (saved in the browser) ----------
// localStorage may be absent (headless tests) or blocked: never assume it is there.
const store = {
  get(k, d) { try { const v = localStorage.getItem('libreCity.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('libreCity.' + k, JSON.stringify(v)); } catch {} },
};
let playerName  = store.get('name', '');       // empty = first run: ask for the name
let gameMinutes = store.get('minutes', 0);     // game length in minutes · 0 = untimed
let audioOn     = store.get('audio', true);    // audio toggle from settings (js/audio.js)
let timeLeft = 0;                              // frames left (only when a length is set)
// Violence filter (SINGLE-PLAYER only): false = no weapons, nobody shoots or kills
// (neither player nor NPCs), and police missions end simply by reaching the thief.
// In MULTIPLAYER violence is ALWAYS on, hence peaceMode() also requires !net.
let violenceOn = true;
let policeOn = true;
function peaceMode() { return !violenceOn && !(typeof net !== 'undefined' && net && net.mode !== null); }
let camX = 0, camY = 0;
// True only on the client that renders (never on the headless server): enables
// spawning around the centre of the viewport.
let cameraActive = false;
let shakeT = 0, shakeMag = 0;
let flashT = 0;        // red flash when the player is hit
let downT = 0;         // frames left "out of play" (dead or busted)
let downKind = null;   // 'dead' → respawn at the hospital · 'busted' → respawn at the station

// ---------- Player ----------
const CIV_SHIRTS = ['#4a90d9','#d94a90','#50b84a','#c9a227','#9b59b6','#e67e22','#1abc9c','#e74c3c'];
const CIV_SKINS  = ['#f6c79a','#e0ac7a','#f3d0b0','#c98d5a','#a86a3c'];
const CIV_HAIR   = ['#3a2410','#5a3a1a','#7a5a2a','#2a2a2a','#8a8a8a','#c98a4a'];
const CAR_COLORS = ['#d23a3a','#3a72d2','#e0a92a','#37a05a','#8a3ad2','#e06a2a','#2ab0b0','#c0c0cc','#e0e0e8','#3a3a44'];

// ---------- Weapons: you start bare-handed, everything is bought at the GUN SHOP ----------
// auto=true → continuous fire while held; otherwise one shot per click
// melee=true → close-quarters attack (fists): no bullets, hits whatever is in range
// pvp = damage per hit against ANOTHER PLAYER in multiplayer (see js/net.js)
const WEAPONS = [
  { k: 'fists',    icon: '👊', price: 0,   cd: 22, auto: false, melee: true, range: 34, knock: 5, dmgCar: 2, sfx: 'punch' },
  { k: 'pistol',   icon: '🔫', price: 10,  cd: 20, auto: false, spd: 13, life: 52, spread: 0.03,  knock: 4, dmgCar: 10, pvp: 10, sfx: 'shoot' },
  { k: 'smg',      icon: '⚡', price: 30,  cd: 8,  auto: true,  spd: 13, life: 44, spread: 0.09,  knock: 3, dmgCar: 6,  pvp: 6,  sfx: 'smg' },
  { k: 'shotgun',  icon: '💥', price: 50,  cd: 46, auto: false, spd: 11, life: 26, spread: 0.22,  knock: 7, dmgCar: 8,  pvp: 8,  pellets: 6, shake: 4, sfx: 'shotgun' },
  // Grenades: a THROWN charge that flies a short way (fuse = life) then explodes over an
  // area — a weaker blast than the rocket (pw < 1). Reuses the rockets: see
  // playerThrowGrenade/updateRockets/explodeRocket.
  { k: 'grenade',  icon: '💣', price: 80,  cd: 55, auto: false, grenade: true, spd: 7.5, life: 26, pw: 0.72, knock: 8, dmgCar: 60, pvp: 30, shake: 5, sfx: 'whoosh' },
  // Flamethrower: a continuous, very short-range jet (a burst of very short-lived
  // "flamelets") — little damage per hit but a very high rate, and it sets vehicles
  // alight. See playerShoot (`fire` flag) and updateBullets (`flame`).
  { k: 'flamer',   icon: '🔥', price: 100, cd: 3,  auto: true,  spd: 5.5, life: 8,  spread: 0.30, knock: 1, dmgCar: 4, pvp: 5, pellets: 3, fire: true, shake: 1, sfx: 'flame' },
  // Rocket launcher: fires a ROCKET that explodes on impact with an area blast (see
  // playerShoot/updateRockets). Slow to reload, but devastating in PvP.
  { k: 'rocket',   icon: '🚀', price: 500, cd: 85, auto: false, rocket: true, spd: 7, life: 120, knock: 12, dmgCar: 95, pvp: 40, shake: 8, sfx: 'rocket' },
];
// Weapon name in the current language (weapons are identified by `k`, see js/i18n.js).
function wName(w) { return t('weapon.' + w.k); }

// `let` (not `const`): on the authoritative server the glue rebinds `player` to the
// player currently being simulated, so the sim functions (which read the global
// `player`) act on the right one each time. Locally it always stays this object.
let player = {
  x: 0, y: 0, r: 8, health: 100, aim: 0, walk: 0, moving: false,
  car: null, shootCd: 0, hurtCd: 0, punchT: 0,
  weaponIdx: 0, owned: WEAPONS.map(w => !w.price),
  shirt: '#e0533a', skin: '#f6c79a', hair: '#5a3a1a',
  kills: 0, deaths: 0, score: 0, streak: 0, bounty: 0,   // score/streak/bounty (PvP)
};
(function spawnPlayer() {
  const p = randomPublicRoadNear(WORLD_W / 2, WORLD_H / 2, 0, 300) || nodes[Math.floor(nodes.length / 2)];
  player.x = p.x; player.y = p.y;
})();

// ===== Authoritative multiplayer (Phase 2): "multi-player" helpers =====
// LOCALLY `MP` stays null and every helper falls back to the single player ⇒ behaviour
// IDENTICAL to single-player (no cost, no difference). On the SERVER the glue sets
// `MP = players[]` and these make the AI and damage aware of several players without
// touching the game functions themselves.
let MP = null;
// True ONLY on a client rendering an authoritative server (Phase 2): there the player is
// PREDICTED locally and must not create authoritative bullets/effects (the server does).
// `typeof net` is safe headless too, where `net` does not exist.
function authClient() { return typeof net !== 'undefined' && net && !!net.authoritative; }
// The active player nearest to (x,y) — the AI's target (police, army, traffic).
function nearestPlayer(x, y) {
  if (!MP) return player;
  let best = null, bd = Infinity;
  for (const q of MP) { if (q.downT > 0) continue; const dx = q.x - x, dy = q.y - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = q; } }
  return best || MP[0] || player;
}
function nearestWantedPlayer(x, y) {
  if (!MP) return player;
  let best = null, bestDistSq = Infinity;
  for (const q of MP) {
    if (q.downT > 0 || (q.wanted | 0) === 0) continue;
    const dx = q.x - x, dy = q.y - y, distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) { bestDistSq = distSq; best = q; }
  }
  return best || nearestPlayer(x, y);
}
function eachActivePlayer(fn) { if (MP) { for (const q of MP) fn(q); } else fn(player); }
function distToNearestPlayer(x, y) {
  if (!MP) return dist(x, y, player.x, player.y);
  let bd = Infinity;
  for (const q of MP) { const d = dist(x, y, q.x, q.y); if (d < bd) bd = d; }
  return bd === Infinity ? 1e9 : bd;
}
// The player (not down) touching point (x,y) within r, or null.
function playerTouching(x, y, r) {
  if (!MP) return dist(x, y, player.x, player.y) < r ? player : null;
  for (const q of MP) { if (q.downT > 0) continue; if (dist(x, y, q.x, q.y) < r) return q; }
  return null;
}
// A player to centre repopulation spawns on (rotates between players).
let spawnFocusSeq = 0;
function spawnFocus() {
  if (!MP || !MP.length) return player;
  spawnFocusSeq = (spawnFocusSeq + 1) % MP.length;
  return MP[spawnFocusSeq];
}
function policeSpawnFocus() {
  const rotated = spawnFocus();
  if (MP) for (let k = 0; k < MP.length; k++) {
    const candidate = MP[(spawnFocusSeq + k) % MP.length];
    if ((candidate.wanted | 0) > 0) return candidate;
  }
  return rotated;
}
// Runs fn with the player globals (player, downT, downKind, cash, wanted…) REBOUND to
// the victim/author v, then restores them: this lets the existing damage/death/credit/
// crime functions (hurtPlayer, startDown, cash+=…, commitCrime) act on the right player.
// `v` may be the player object or its id (e.g. car.owner).
let playerOwningGlobals = null;
function asPlayer(v, fn) {
  if (!MP) return fn();                            // local: the globals ARE the single player's
  if (typeof v === 'string') { let f = null; for (const q of MP) if (q.id === v) { f = q; break; } v = f; }
  if (!v) return fn();                             // unknown author: no rebinding
  if (v === playerOwningGlobals) return fn();
  const sp = player, sdt = downT, sdk = downKind, sc = cash, swh = wantedHeat, sw = wanted, scc = crimeCd;
  const previousOwner = playerOwningGlobals;
  player = v; downT = v.downT | 0; downKind = v.downKind; cash = v.cash | 0;
  wantedHeat = v.wantedHeat || 0; wanted = v.wanted | 0; crimeCd = v.crimeCd | 0;
  playerOwningGlobals = v;
  try { return fn(); }
  finally {
    v.downT = downT; v.downKind = downKind; v.cash = cash;
    v.wantedHeat = wantedHeat; v.wanted = wanted; v.crimeCd = crimeCd;
    player = sp; downT = sdt; downKind = sdk; cash = sc; wantedHeat = swh; wanted = sw; crimeCd = scc;
    playerOwningGlobals = previousOwner;
  }
}

// ---------- Entity factories ----------
const VEHICLE_MAX_W = 88, VEHICLE_MAX_H = 30;
const vehicleColH = (isBike, h) => isBike ? 8 : Math.floor(h / 2) + 1;
let carSeq = 0;                                   // running id (priority at junctions)
function makeCar(x, y, role, dir) {
  const isPolice = role === 'police';
  // Every car has its own character: different mass, pickup and top speed.
  const mass = isPolice ? 1.2 : rnd(0.85, 1.35);
  return {
    id: carSeq++,
    x, y, angle: dir ? Math.atan2(dir.y, dir.x) : 0, speed: 0,
    w: 46, h: 24, colH: vehicleColH(false, 24), role,               // role: traffic | police | parked
    color: isPolice ? '#f2f4f8' : pick(CAR_COLORS),
    dir: dir || pick(DIRS), turnCd: rndi(20, 60),
    maxSpeed: isPolice ? 4.6 : rnd(2.1, 3.0),
    mass,                                         // heavy ones shove harder in collisions
    accel: (isPolice ? 0.17 : rnd(0.12, 0.18)) / mass,   // ...but pull away more slowly
    top: isPolice ? 5.8 : rnd(5.6, 6.6) - mass * 1.1,    // top speed ~4.1–5.7
    gears: isPolice ? 5 : 4, gear: 1, shiftT: 0,  // gearbox: the patrol car has one gear more
    health: 100, driver: null, hitX: false, hitY: false, lightPhase: 0,
    kvx: 0, kvy: 0, kox: 0, koy: 0,               // residual shove from collisions (bounce)
    hue: rndi(0, 3),
    // Every car has its own voice: the horn stays the same for the car's whole life.
    hornF: pick([285, 310, 335, 360, 385]) + rndi(-8, 8), hornKind: 'car',
  };
}
let pedSeq = 0;                                   // running pedestrian id (for network snapshots)
function makePed(x, y, role) {
  const cop = role === 'cop';
  return {
    id: pedSeq++,
    x, y, r: 7, role, ko: false, koT: 0, dead: false,
    dir: pick(DIRS), speed: rnd(0.8, 1.4), thinkCd: rndi(30, 120),
    walk: 0, facing: 0, shootCd: rndi(20, 60),
    shirt: cop ? '#20407a' : pick(CIV_SHIRTS),
    skin: pick(CIV_SKINS), hair: cop ? '#1a1a2a' : pick(CIV_HAIR),
    hitX: false, hitY: false, panic: 0,
    say: null, sayCol: '#20242e', sayT: 0, sayCd: rndi(0, 120),
    angryT: 0, getsUp: false,                     // carjacked driver: gets up and gives furious chase
  };
}

// Turns a car into a taxi 🚕 (yellow, chequers and a roof sign).
function makeTaxi(c) { c.isTaxi = true; c.color = pick(['#ffce2e','#ffc31f','#f5b81f']); c.hornF = 400 + rndi(-12, 12); return c; }
// Turns a vehicle into a motorbike 🏍️ (narrow frame, nimble through traffic).
function makeMoto(c) {
  c.isBike = true; c.w = 34; c.h = 12; c.colH = vehicleColH(true, 12);
  c.maxSpeed = rnd(2.6, 3.4);
  c.mass = 0.55; c.accel = rnd(0.16, 0.19); c.top = rnd(5.8, 6.4);   // light and quick
  c.gears = 5;                                                       // short bike gearbox
  c.hornKind = 'bike'; c.hornF = 520 + rndi(0, 90);                  // shrill scooter beep
  c.riderShirt = pick(CIV_SHIRTS);
  c.helmet = pick(['#e0e0e8','#d23a3a','#2a2a2e','#3a72d2']);
  return c;
}
function makeBus(c) {
  c.livery = 'bus'; c.w = 88; c.h = 28; c.colH = vehicleColH(false, 28);
  c.color = pick(['#2f7bd6','#d6452f','#2fa36b','#e0a21f']);
  c.mass = 3.0; c.accel = 0.05; c.top = 4.2; c.maxSpeed = 1.9; c.gears = 5;
  c.hornKind = 'truck'; c.hornF = 150;
  return c;
}
function makeLorry(c) {
  c.livery = 'lorry'; c.w = 76; c.h = 28; c.colH = vehicleColH(false, 28);
  c.color = pick(CAR_COLORS); c.cargo = '#e6e2d8';
  c.mass = 2.6; c.accel = 0.06; c.top = 4.5; c.maxSpeed = 2.0; c.gears = 5;
  c.hornKind = 'truck'; c.hornF = 175;
  return c;
}
function makeSpider(c) {
  c.livery = 'spider'; c.w = 42; c.h = 22; c.colH = vehicleColH(false, 22);
  c.color = pick(['#e0201f','#ffcf1f','#1fa0e0','#f2f4f8']);
  c.helmet = pick(['#e0e0e8','#d23a3a','#2a2a2e','#ffd23a']);
  c.riderShirt = pick(CIV_SHIRTS);
  c.mass = 0.8; c.accel = 0.22; c.top = 7.5; c.maxSpeed = 3.3; c.gears = 5;
  c.hornKind = 'car'; c.hornF = 420;
  return c;
}
function dressTrafficCar(c) {
  const roll = Math.random();
  if (roll < 0.04) return makeBus(c);
  if (roll < 0.10) return makeLorry(c);
  if (roll < 0.12) return makeSpider(c);
  if (Math.random() < 0.18) return makeTaxi(c);
  if (Math.random() < 0.14) return makeMoto(c);
  return c;
}
// Delivery bike 🍕: red top box and pizzeria livery.
function makeDeliveryMoto(c) {
  makeMoto(c);
  c.isTaxi = false; c.isDelivery = true;
  c.color = '#d23a3a'; c.helmet = '#ffd23a';
  return c;
}
// Service vehicle parked in front of a building: each special building has its own —
// patrol car, ambulance, fire engine, armoured van, market van, delivery bike, gun-shop van.
function makeServiceCar(type, p) {
  const c = type === 'pizzeria' ? makeDeliveryMoto(makeParked(p.x, p.y, p.angle))
                                : makeParked(p.x, p.y, p.angle);
  c.serviceType = type;
  if (type === 'police')        { c.wasPolice = true; c.color = '#f2f4f8'; c.mass = 1.2; c.accel = 0.15; c.top = 5.8; c.gears = 5; }
  else if (type === 'hospital') { c.livery = 'ambulance'; c.color = '#f0f2f6'; c.mass = 1.4; c.accel = 0.13; c.top = 5.5; }
  else if (type === 'fire')     { c.livery = 'fire'; c.color = '#c22822'; c.w = 54; c.h = 26; c.colH = vehicleColH(false, 26);
                                  c.mass = 2.4; c.accel = 0.07; c.top = 4.2; c.gears = 3;   // a beast
                                  c.hornKind = 'truck'; c.hornF = 165; }         // deep air horn
  else if (type === 'bank')     { c.livery = 'armored'; c.color = '#8a8f9a'; c.w = 50; c.h = 25;
                                  c.mass = 2.0; c.accel = 0.08; c.top = 4.4; c.gears = 3;
                                  c.hornKind = 'truck'; c.hornF = 200; }
  else if (type === 'market')   { c.livery = 'market'; c.color = '#e8e9ee'; c.w = 50; c.h = 25;
                                  c.mass = 1.6; c.accel = 0.09; c.top = 4.6; c.gears = 3;
                                  c.hornKind = 'truck'; c.hornF = 225; }
  else if (type === 'gunshop')  { c.livery = 'gunshop'; c.color = '#3a3f4c'; c.mass = 1.5; c.accel = 0.10; c.top = 4.8;
                                  c.hornKind = 'truck'; c.hornF = 240; }
  else if (type === 'army')     { c.isTank = true; c.livery = 'tank'; c.color = '#556b3d';
                                  c.w = 56; c.h = 30; c.colH = vehicleColH(false, 30); c.health = 600;   // armoured!
                                  c.mass = 4.0; c.accel = 0.05; c.top = 3.0; c.gears = 2;   // slow but unstoppable
                                  c.turretA = c.angle; c.gunCd = 0;
                                  c.hornKind = 'truck'; c.hornF = 130; }
  return c;
}
// How many vehicles to park in front of each building (at least 1).
const SERVICE_COUNT = { police: 2, hospital: 2, pizzeria: 2, fire: 2, bank: 1, market: 1, gunshop: 1, army: 1 };
// A free spot in the barracks yard (for parked vehicles and guards).
function armySpotIn(area, clear) {
  for (let i = 0; i < 40; i++) {
    const tx = rndi(area.x0, area.x1), ty = rndi(area.y0, area.y1);
    const wx = (tx + 0.5) * T, wy = (ty + 0.5) * T;
    if (cars.some(c => dist(c.x, c.y, wx, wy) < clear)) continue;
    return { x: wx, y: wy, angle: -Math.PI / 2 };
  }
  return null;
}
const motorPoolBay = lm => ({ x0: lm.layout.motorPool.x0, y0: lm.layout.motorPool.y0 + 1,
                              x1: lm.layout.motorPool.x1, y1: lm.layout.motorPool.y1 - 1 });
// Army soldier (the AI lives in js/army.js).
function makeSoldier(x, y) {
  const p = makePed(x, y, 'soldier');
  p.shirt = '#3d5226'; p.hair = '#2a2a1e';
  p.shootCd = rndi(25, 50);
  return p;
}
// Military jeep: chases like a patrol car, but the gunner fires from the vehicle.
function makeArmyCar(x, y) {
  const c = makeCar(x, y, 'armycar');
  c.livery = 'army'; c.color = '#4a5d33'; c.w = 48; c.h = 25; c.colH = vehicleColH(false, 25);
  c.mass = 1.8; c.accel = 0.11; c.top = 5.2; c.maxSpeed = 4.4; c.gears = 4;
  c.hornKind = 'truck'; c.hornF = 185; c.shootCd = rndi(40, 70);
  return c;
}
// Military jeep parked in the base yard (stealable… at your own risk).
function parkArmyJeep(lm) {
  const sp = armySpotIn(motorPoolBay(lm), 70);
  if (!sp) return;
  const c = makeArmyCar(sp.x, sp.y);
  c.role = 'parked'; c.speed = 0; c.angle = sp.angle; c.serviceType = 'armyjeep';
  cars.push(c);
}
// Barracks guard: patrols the yard and shoots intruders on sight.
function makeGuard(lm, duty) {
  const start = duty.post || duty.route[0];
  const p = makeSoldier(start.x, start.y);
  p.guard = true; p.baseLm = landmarks.indexOf(lm); p.duty = duty;
  p.routeIndex = 0; p.pauseT = 0;
  p.facing = duty.post ? duty.post.facing : 0;
  return p;
}
function restoreArmyGuards(lm) {
  for (const duty of lm.guardDuties)
    if (!peds.some(p => p.guard && p.duty === duty)) peds.push(makeGuard(lm, duty));
}
// Parks a service vehicle on the street nearest the building's entrance; if there is no
// room there, widens the search towards the nearest road (large blocks).
// Army vehicles instead sit INSIDE the barracks fence.
function parkServiceCar(lm) {
  if (lm.type === 'army') {
    const sp = armySpotIn(motorPoolBay(lm), 70);
    if (sp) cars.push(makeServiceCar('army', sp));
    return;
  }
  const sp = randomParkingNear(lm.door.x, lm.door.y, 30, 320) || randomParkingNear(lm.door.x, lm.door.y, 30, 560);
  if (sp) cars.push(makeServiceCar(lm.type, sp));
}

// ---------- Traffic spawned on a network edge (follows the road) ----------
function makeTrafficCar(edge, ed, t) {
  const c = makeCar(0, 0, 'traffic');
  c.edge = edge; c.ed = ed; c.t = t; c.turnCd = rndi(20, 60);
  railPlace(c);
  return c;
}
function spawnTrafficNear(cx, cy, rmin, rmax) {
  for (let i = 0; i < 40; i++) {
    const ei = rndi(0, edges.length - 1), mp = edgePos(edges[ei], 0.5);
    const d = dist(mp.x, mp.y, cx, cy);
    if (d < rmin || d > rmax) continue;
    const ed = Math.random() < 0.5 ? 1 : -1;
    const c = dressTrafficCar(makeTrafficCar(ei, ed, ed > 0 ? rnd(0.05, 0.5) : rnd(0.5, 0.95)));
    // Never spawn a car on top of another: they would stay glued together until the
    // safe-distance logic managed to prise them apart.
    if (cars.some(o => o.role !== 'parked' && dist(o.x, o.y, c.x, c.y) < (o.w + c.w) / 2 + 24)) continue;
    return c;
  }
  return null;
}

// ---------- Cars parked at the kerb of an edge ----------
function makeParked(x, y, angle) {
  const c = makeCar(x, y, 'parked');
  c.angle = angle; c.speed = 0; c.parkedDecor = true;
  return c;
}
function randomParkingNear(cx, cy, rmin, rmax) {
  // Only consider edges that actually pass within the requested radius, so a spot can be
  // found even next to an out-of-the-way building.
  const near = [];
  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei];
    for (let s = 0; s <= 8; s++) {
      const p = edgePos(e, s / 8);
      if (dist(p.x, p.y, cx, cy) < rmax) { near.push(ei); break; }
    }
  }
  if (!near.length) return null;
  for (let i = 0; i < 80; i++) {
    const ei = pick(near), e = edges[ei], t = rnd(0.15, 0.85);
    const p = edgePos(e, t);
    if (dist(p.x, p.y, cx, cy) < rmin || dist(p.x, p.y, cx, cy) > rmax) continue;
    const tan = edgeTangent(e, t), side = Math.random() < 0.5 ? 1 : -1;
    const off = HALF_ROAD - 12;                                    // close to the kerb
    const wx = p.x - tan.y * off * side, wy = p.y + tan.x * off * side;
    const tx = Math.floor(wx / T), ty = Math.floor(wy / T);
    if (tx < 2 || ty < 2 || tx >= MAP_W - 2 || ty >= MAP_H - 2) continue;
    if (tileAt(tx, ty) !== ROAD || inArmyIsland(tx, ty)) continue;
    if (cars.some(o => dist(o.x, o.y, wx, wy) < ((o.w || 46) + 46) / 2 + 14)) continue;
    return { x: wx, y: wy, angle: Math.atan2(tan.y, tan.x) };      // parallel parking
  }
  return null;
}
// A coin on a walkable tile (pavement, road, grass, plaza or alley).
function spawnCoinNear(cx, cy, rmin, rmax) {
  const p = randomTileNear(cx, cy, rmin, rmax,
    (tx, ty) => { const t = tileAt(tx, ty); return (t === SIDEWALK || t === ROAD || t === GRASS) && !inArmyIsland(tx, ty); });
  if (p) coins.push({ x: p.x + rnd(-9, 9), y: p.y + rnd(-9, 9), spin: rnd(0, TAU), bob: rnd(0, TAU), val: 10 });
}
// A higher-value coin tucked away in an alley.
function spawnAlleyCoin(cx, cy, rmax) {
  const p = randomTileNear(cx, cy, 0, rmax || Math.max(vw, vh),
    (tx, ty) => tileAt(tx, ty) === ALLEY);
  if (p) coins.push({ x: p.x + rnd(-7, 7), y: p.y + rnd(-7, 7), spin: rnd(0, TAU), bob: rnd(0, TAU), val: 25 });
}

// Initial population + a starter vehicle next to the player.
(function seedWorld() {
  for (let i = 0; i < 16; i++) { const c = spawnTrafficNear(player.x, player.y, 200, 2200); if (c) cars.push(c); }
  for (let i = 0; i < 14; i++) { const p = randomParkingNear(player.x, player.y, 150, 1800); if (p) cars.push(makeParked(p.x, p.y, p.angle)); }
  for (let i = 0; i < 26; i++) { const p = randomWalkNear(player.x, player.y, 120, 1500); if (p) peds.push(makePed(p.x, p.y, 'civ')); }
  for (let i = 0; i < 2; i++) spawnCoinNear(player.x, player.y, 120, 1800);
  for (let i = 0; i < 2; i++) spawnAlleyCoin(player.x, player.y, 1800);
  const near = spawnTrafficNear(player.x, player.y, 50, 300);
  if (near) cars.push(near);
  // A taxi parked near the spawn, so the missions can be tried straight away.
  const tp = randomParkingNear(player.x, player.y, 120, 600);
  if (tp) cars.push(makeTaxi(makeParked(tp.x, tp.y, tp.angle)));
  // ...and a delivery bike too, for the pizza runs.
  const mp = randomParkingNear(player.x, player.y, 120, 700);
  if (mp) cars.push(makeDeliveryMoto(makeParked(mp.x, mp.y, mp.angle)));
  // Service vehicles parked in front of each special building.
  for (const lm of landmarks)
    for (let k = 0; k < (SERVICE_COUNT[lm.type] || 1); k++) parkServiceCar(lm);
  // The base is garrisoned: jeeps around the yard plus a guard detail.
  for (const lm of landmarks) if (lm.type === 'army') {
    for (let k = 0; k < 2; k++) parkArmyJeep(lm);
    restoreArmyGuards(lm);
  }
})();
