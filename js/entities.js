// LIBRE CITY · js/entities.js — stato di gioco, profilo salvato, player e armi, semafori,
// fabbriche di entità (auto, pedoni, mezzi di servizio, monete) e spawn iniziale del mondo.

// ---------- Stato ----------
const DIRS = [ {x:1,y:0}, {x:-1,y:0}, {x:0,y:1}, {x:0,y:-1} ];
// tile "da pedone": dove i passanti stanno volentieri (marciapiede, prato/piazza, vicolo)
const pedFriendly = t => t === SIDEWALK || t === GRASS || t === ALLEY;
const tileTypeAt = (wx, wy) => tileAt(Math.floor(wx / T), Math.floor(wy / T));
// scelta direzione da fermo: preferisce restare sui marciapiedi, evita la carreggiata
function pickWalkDir(p) {
  const soft = [], road = [];
  for (const d of DIRS) {
    const t = tileTypeAt(p.x + d.x * 22, p.y + d.y * 22);
    if (t === BUILDING || t === TREE || t === WATER) continue;   // ostacoli: scartati
    (t === ROAD ? road : soft).push(d);
  }
  if (soft.length && (road.length === 0 || Math.random() < 0.9)) return pick(soft);
  if (road.length) return pick(road);
  return pick(DIRS);
}
// direzione (cardinale) verso il marciapiede più vicino, se il pedone è finito in strada
function toNearestSidewalk(wx, wy) {
  const cx = Math.floor(wx / T), cy = Math.floor(wy / T);
  for (let r = 1; r <= 5; r++) for (const d of DIRS)
    if (pedFriendly(tileAt(cx + d.x * r, cy + d.y * r))) return d;
  return null;
}
const cars = [];       // tutti i veicoli (traffico, polizia, guidato)
const peds = [];       // pedoni (civili + poliziotti a piedi)
const bullets = [];    // proiettili
const parts = [];      // particelle (sangue, scintille, fumo)
const decals = [];     // macchie a terra
const pickups = [];    // soldi da raccogliere (dai passanti investiti)
const coins = [];      // monetine sparse per la città
const fires = [];      // incendi da spegnere con l'autopompa
const water = [];      // gocce d'acqua sparate dall'idrante
const rockets = [];    // razzi sparati dal carro armato

// ---------- Semafori ----------
const LIGHT_G = 60 * 7, LIGHT_Y = 46;                  // durata verde / giallo (frame)
const LIGHT_CYCLE = (LIGHT_G + LIGHT_Y) * 2;
let lightClock = 0;
let hState = 'green', vState = 'red';                   // stato lampada asse orizzontale / verticale
let greenH = true, greenV = false;                     // via libera per asse orizzontale / verticale
function updateLights() {
  lightClock++;
  const t = lightClock % LIGHT_CYCLE;
  if (t < LIGHT_G)                     { hState = 'green';  vState = 'red';    }
  else if (t < LIGHT_G + LIGHT_Y)      { hState = 'yellow'; vState = 'red';    }
  else if (t < 2 * LIGHT_G + LIGHT_Y)  { hState = 'red';    vState = 'green';  }
  else                                 { hState = 'red';    vState = 'yellow'; }
  greenH = hState !== 'red';                            // in giallo si prosegue (svuota l'incrocio)
  greenV = vState !== 'red';
}

let cash = 0;
let wantedHeat = 0;    // livello ricercato continuo (0..5.99)
let wanted = 0;        // stelle intere
let crimeCd = 0;       // tempo prima che il livello ricercato inizi a scendere
let started = false, frame = 0;
let paused = false;

// ---------- Profilo e impostazioni (salvati nel browser) ----------
// localStorage può mancare (test headless) o essere bloccato: mai dare per scontato che ci sia
const store = {
  get(k, d) { try { const v = localStorage.getItem('libreCity.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('libreCity.' + k, JSON.stringify(v)); } catch {} },
};
let playerName  = store.get('name', '');       // vuoto = primo avvio: chiedi il nome
let gameMinutes = store.get('minutes', 0);     // durata partita in minuti · 0 = senza limiti
let timeLeft = 0;                              // frame rimanenti (solo con durata impostata)
let camX = 0, camY = 0;
let shakeT = 0, shakeMag = 0;
let flashT = 0;        // lampo rosso quando il player è colpito
let downT = 0;         // frame rimanenti di "fuori gioco" (morto o arrestato)
let downKind = null;   // 'dead' → riparte in ospedale · 'busted' → riparte in centrale

// ---------- Player ----------
const CIV_SHIRTS = ['#4a90d9','#d94a90','#50b84a','#c9a227','#9b59b6','#e67e22','#1abc9c','#e74c3c'];
const CIV_SKINS  = ['#f6c79a','#e0ac7a','#f3d0b0','#c98d5a','#a86a3c'];
const CIV_HAIR   = ['#3a2410','#5a3a1a','#7a5a2a','#2a2a2a','#8a8a8a','#c98a4a'];
const CAR_COLORS = ['#d23a3a','#3a72d2','#e0a92a','#37a05a','#8a3ad2','#e06a2a','#2ab0b0','#c0c0cc','#e0e0e8','#3a3a44'];

// ---------- Armi: si parte a mani nude, tutte le armi si comprano all'ARMERIA ----------
// auto=true → fuoco continuo tenendo premuto; altrimenti un colpo per click
// melee=true → attacco ravvicinato (pugni): niente proiettili, colpisce chi è a portata
// pvp = danno per colpo a un ALTRO GIOCATORE in multigiocatore (vedi js/net.js)
const WEAPONS = [
  { name: 'Pugni',          icon: '👊', price: 0,   cd: 22, auto: false, melee: true, range: 34, knock: 5, dmgCar: 2, sfx: 'punch' },
  { name: 'Pistola',        icon: '🔫', price: 50,  cd: 20, auto: false, spd: 13, life: 52, spread: 0.03,  knock: 4, dmgCar: 10, pvp: 10, sfx: 'shoot' },
  { name: 'Mitra',          icon: '⚡', price: 300, cd: 8,  auto: true,  spd: 13, life: 44, spread: 0.09,  knock: 3, dmgCar: 6,  pvp: 6,  sfx: 'smg' },
  { name: 'Fucile a pompa', icon: '💥', price: 500, cd: 46, auto: false, spd: 11, life: 26, spread: 0.22,  knock: 7, dmgCar: 8,  pvp: 8,  pellets: 6, shake: 4, sfx: 'shotgun' },
  { name: 'Magnum',         icon: '🎯', price: 900, cd: 34, auto: false, spd: 18, life: 60, spread: 0.012, knock: 9, dmgCar: 34, pvp: 24, shake: 3, sfx: 'magnum' },
];

const player = {
  x: 0, y: 0, r: 8, health: 100, aim: 0, walk: 0, moving: false,
  car: null, shootCd: 0, hurtCd: 0, punchT: 0,
  weaponIdx: 0, owned: WEAPONS.map(w => !w.price),
  shirt: '#e0533a', skin: '#f6c79a', hair: '#5a3a1a',
};
(function spawnPlayer() {
  const p = randomRoadNear(WORLD_W / 2, WORLD_H / 2, 0, 300) || nodes[Math.floor(nodes.length / 2)];
  player.x = p.x; player.y = p.y;
})();

// ---------- Fabbriche di entità ----------
let carSeq = 0;                                   // id progressivo (priorità agli incroci)
function makeCar(x, y, role, dir) {
  const isPolice = role === 'police';
  // ogni auto ha il suo carattere: massa, spunto e velocità massima diversi
  const mass = isPolice ? 1.2 : rnd(0.85, 1.35);
  return {
    id: carSeq++,
    x, y, angle: dir ? Math.atan2(dir.y, dir.x) : 0, speed: 0,
    w: 46, h: 24, colH: 13, role,                 // role: traffic | police | parked
    color: isPolice ? '#f2f4f8' : pick(CAR_COLORS),
    dir: dir || pick(DIRS), turnCd: rndi(20, 60),
    maxSpeed: isPolice ? 4.6 : rnd(2.1, 3.0),
    mass,                                         // le pesanti spingono di più negli urti
    accel: (isPolice ? 0.17 : rnd(0.12, 0.18)) / mass,   // ...ma partono più piano
    top: isPolice ? 5.8 : rnd(5.6, 6.6) - mass * 1.1,    // velocità massima ~4.1–5.7
    gears: isPolice ? 5 : 4, gear: 1, shiftT: 0,  // cambio: la volante ha una marcia in più
    health: 100, driver: null, hitX: false, hitY: false, lightPhase: 0,
    kvx: 0, kvy: 0, kox: 0, koy: 0,               // spinta residua dagli urti (rimbalzo)
    hue: rndi(0, 3),
    // ogni auto ha la sua voce: il clacson resta lo stesso per tutta la vita dell'auto
    hornF: pick([285, 310, 335, 360, 385]) + rndi(-8, 8), hornKind: 'car',
  };
}
function makePed(x, y, role) {
  const cop = role === 'cop';
  return {
    x, y, r: 7, role, ko: false, koT: 0, dead: false,
    dir: pick(DIRS), speed: rnd(0.8, 1.4), thinkCd: rndi(30, 120),
    walk: 0, facing: 0, shootCd: rndi(20, 60),
    shirt: cop ? '#20407a' : pick(CIV_SHIRTS),
    skin: pick(CIV_SKINS), hair: cop ? '#1a1a2a' : pick(CIV_HAIR),
    hitX: false, hitY: false, panic: 0,
    say: null, sayCol: '#20242e', sayT: 0, sayCd: rndi(0, 120),
    angryT: 0, getsUp: false,                     // guidatore scippato: si rialza e insegue furioso
  };
}

// trasforma un'auto in taxi 🚕 (giallo, scacchi e insegna sul tetto)
function makeTaxi(c) { c.isTaxi = true; c.color = pick(['#ffce2e','#ffc31f','#f5b81f']); c.hornF = 400 + rndi(-12, 12); return c; }
// trasforma un veicolo in moto 🏍️ (telaio stretto, agile fra il traffico)
function makeMoto(c) {
  c.isBike = true; c.w = 34; c.h = 12; c.colH = 8;
  c.maxSpeed = rnd(2.6, 3.4);
  c.mass = 0.55; c.accel = rnd(0.16, 0.19); c.top = rnd(5.8, 6.4);   // leggera e scattante
  c.gears = 5;                                                       // cambio corto da moto
  c.hornKind = 'bike'; c.hornF = 520 + rndi(0, 90);                  // bip-bip acuto da motorino
  c.riderShirt = pick(CIV_SHIRTS);
  c.helmet = pick(['#e0e0e8','#d23a3a','#2a2a2e','#3a72d2']);
  return c;
}
// moto delle consegne 🍕: bauletto rosso e livrea della pizzeria
function makeDeliveryMoto(c) {
  makeMoto(c);
  c.isTaxi = false; c.isDelivery = true;
  c.color = '#d23a3a'; c.helmet = '#ffd23a';
  return c;
}
// mezzo di servizio parcheggiato davanti a una struttura: ogni edificio
// speciale ha i suoi veicoli — volante, ambulanza, autopompa, portavalori,
// furgone del mercato, moto delle consegne, furgone dell'armeria
function makeServiceCar(type, p) {
  const c = type === 'pizzeria' ? makeDeliveryMoto(makeParked(p.x, p.y, p.angle))
                                : makeParked(p.x, p.y, p.angle);
  c.serviceType = type;
  if (type === 'police')        { c.wasPolice = true; c.color = '#f2f4f8'; c.mass = 1.2; c.accel = 0.15; c.top = 5.8; c.gears = 5; }
  else if (type === 'hospital') { c.livery = 'ambulance'; c.color = '#f0f2f6'; c.mass = 1.4; c.accel = 0.13; c.top = 5.5; }
  else if (type === 'fire')     { c.livery = 'fire'; c.color = '#c22822'; c.w = 54; c.h = 26; c.colH = 14;
                                  c.mass = 2.4; c.accel = 0.07; c.top = 4.2; c.gears = 3;   // un bestione
                                  c.hornKind = 'truck'; c.hornF = 165; }         // tromba profonda
  else if (type === 'bank')     { c.livery = 'armored'; c.color = '#8a8f9a'; c.w = 50; c.h = 25;
                                  c.mass = 2.0; c.accel = 0.08; c.top = 4.4; c.gears = 3;
                                  c.hornKind = 'truck'; c.hornF = 200; }
  else if (type === 'market')   { c.livery = 'market'; c.color = '#e8e9ee'; c.w = 50; c.h = 25;
                                  c.mass = 1.6; c.accel = 0.09; c.top = 4.6; c.gears = 3;
                                  c.hornKind = 'truck'; c.hornF = 225; }
  else if (type === 'gunshop')  { c.livery = 'gunshop'; c.color = '#3a3f4c'; c.mass = 1.5; c.accel = 0.10; c.top = 4.8;
                                  c.hornKind = 'truck'; c.hornF = 240; }
  else if (type === 'army')     { c.isTank = true; c.livery = 'tank'; c.color = '#556b3d';
                                  c.w = 56; c.h = 30; c.colH = 16; c.health = 600;   // corazzato!
                                  c.mass = 4.0; c.accel = 0.05; c.top = 3.0; c.gears = 2;   // lento ma inarrestabile
                                  c.turretA = c.angle; c.gunCd = 0;
                                  c.hornKind = 'truck'; c.hornF = 130; }
  return c;
}
// quanti mezzi parcheggiare davanti a ogni struttura (almeno 1)
const SERVICE_COUNT = { police: 2, hospital: 2, pizzeria: 2, fire: 2, bank: 1, market: 1, gunshop: 1, army: 1 };
// un punto libero nel piazzale della caserma (per mezzi parcheggiati e guardie)
function armyInteriorSpot(lm, clear) {
  for (let i = 0; i < 40; i++) {
    const tx = rndi(lm.x0 + 2, lm.x1 - 2), ty = rndi(lm.y0 + 2, lm.y1 - 2);
    const wx = (tx + 0.5) * T, wy = (ty + 0.5) * T;
    if (cars.some(c => dist(c.x, c.y, wx, wy) < clear)) continue;
    return { x: wx, y: wy, angle: pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]) };
  }
  return null;
}
// soldato dell'esercito (l'IA è in js/army.js)
function makeSoldier(x, y) {
  const p = makePed(x, y, 'soldier');
  p.shirt = '#3d5226'; p.hair = '#2a2a1e';
  p.shootCd = rndi(25, 50);
  return p;
}
// jeep militare: insegue come una volante, ma il mitragliere spara dal mezzo
function makeArmyCar(x, y) {
  const c = makeCar(x, y, 'armycar');
  c.livery = 'army'; c.color = '#4a5d33'; c.w = 48; c.h = 25; c.colH = 13;
  c.mass = 1.8; c.accel = 0.11; c.top = 5.2; c.maxSpeed = 4.4; c.gears = 4;
  c.hornKind = 'truck'; c.hornF = 185; c.shootCd = rndi(40, 70);
  return c;
}
// jeep militare parcheggiata nel cortile della base (rubabile… a tuo rischio)
function parkArmyJeep(lm) {
  const sp = armyInteriorSpot(lm, 70);
  if (!sp) return;
  const c = makeArmyCar(sp.x, sp.y);
  c.role = 'parked'; c.speed = 0; c.angle = sp.angle; c.serviceType = 'armyjeep';
  cars.push(c);
}
// guardia della caserma: presidia il cortile e spara a vista agli intrusi
function makeGuard(lm) {
  const sp = armyInteriorSpot(lm, 40);
  if (!sp) return null;
  const p = makeSoldier(sp.x, sp.y);
  p.guard = true; p.baseLm = landmarks.indexOf(lm);
  return p;
}
// parcheggia un mezzo di servizio sulla strada più vicina all'ingresso della
// struttura; se lì non c'è posto, allarga verso la via più vicina (isolati grandi)
// (i mezzi dell'esercito invece stanno DENTRO il recinto della caserma)
function parkServiceCar(lm) {
  if (lm.type === 'army') {
    const sp = armyInteriorSpot(lm, 70);
    if (sp) cars.push(makeServiceCar('army', sp));
    return;
  }
  const sp = randomParkingNear(lm.door.x, lm.door.y, 30, 320) || randomParkingNear(lm.door.x, lm.door.y, 30, 560);
  if (sp) cars.push(makeServiceCar(lm.type, sp));
}

// ---------- Traffico che nasce su un arco della rete (segue la strada curva) ----------
function makeTrafficCar(edge, ed, t) {
  const c = makeCar(0, 0, 'traffic');
  c.edge = edge; c.ed = ed; c.t = t; c.turnCd = rndi(20, 60);
  railPlace(c);
  return c;
}
function spawnTrafficNear(cx, cy, rmin, rmax) {
  for (let i = 0; i < 40; i++) {
    const ei = rndi(0, edges.length - 1), mp = edgePos(edges[ei], 0.5);
    if (edges[ei].dead) continue;                     // strada soppressa dalla base militare
    const d = dist(mp.x, mp.y, cx, cy);
    if (d < rmin || d > rmax) continue;
    const ed = Math.random() < 0.5 ? 1 : -1;
    const c = makeTrafficCar(ei, ed, ed > 0 ? rnd(0.05, 0.5) : rnd(0.5, 0.95));
    if (Math.random() < 0.18) makeTaxi(c);            // un po' di taxi nel traffico
    else if (Math.random() < 0.14) makeMoto(c);       // e qualche moto
    return c;
  }
  return null;
}

// ---------- Auto parcheggiate al ciglio di un arco ----------
function makeParked(x, y, angle) {
  const c = makeCar(x, y, 'parked');
  c.angle = angle; c.speed = 0; c.parkedDecor = true;
  return c;
}
function randomParkingNear(cx, cy, rmin, rmax) {
  // considera solo gli archi che passano davvero entro il raggio richiesto
  // (così anche vicino a una struttura sperduta si trova posto)
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
    const off = HALF_ROAD - 12;                                    // vicino al bordo della carreggiata
    const wx = p.x - tan.y * off * side, wy = p.y + tan.x * off * side;
    const tx = Math.floor(wx / T), ty = Math.floor(wy / T);
    if (tx < 2 || ty < 2 || tx >= MAP_W - 2 || ty >= MAP_H - 2) continue;
    if (tileAt(tx, ty) !== ROAD) continue;
    return { x: wx, y: wy, angle: Math.atan2(tan.y, tan.x) };      // parcheggio parallelo
  }
  return null;
}
// monetina su un punto calpestabile (marciapiede, strada, prato, piazza o vicolo)
function spawnCoinNear(cx, cy, rmin, rmax) {
  const p = randomTileNear(cx, cy, rmin, rmax,
    (tx, ty) => { const t = tileAt(tx, ty); return t === SIDEWALK || t === ROAD || t === GRASS; });
  if (p) coins.push({ x: p.x + rnd(-9, 9), y: p.y + rnd(-9, 9), spin: rnd(0, TAU), bob: rnd(0, TAU), val: 10 });
}
// monetina (di più valore) nascosta in un vicolo
function spawnAlleyCoin(cx, cy, rmax) {
  const p = randomTileNear(cx, cy, 0, rmax || Math.max(vw, vh),
    (tx, ty) => tileAt(tx, ty) === ALLEY);
  if (p) coins.push({ x: p.x + rnd(-7, 7), y: p.y + rnd(-7, 7), spin: rnd(0, TAU), bob: rnd(0, TAU), val: 25 });
}

// popolamento iniziale + veicolo di partenza accanto al player
(function seedWorld() {
  for (let i = 0; i < 16; i++) { const c = spawnTrafficNear(player.x, player.y, 200, 2200); if (c) cars.push(c); }
  for (let i = 0; i < 14; i++) { const p = randomParkingNear(player.x, player.y, 150, 1800); if (p) cars.push(makeParked(p.x, p.y, p.angle)); }
  for (let i = 0; i < 26; i++) { const p = randomWalkNear(player.x, player.y, 120, 1500); if (p) peds.push(makePed(p.x, p.y, 'civ')); }
  for (let i = 0; i < 18; i++) spawnCoinNear(player.x, player.y, 120, 1800);
  for (let i = 0; i < 16; i++) spawnAlleyCoin(player.x, player.y, 1800);
  const near = spawnTrafficNear(player.x, player.y, 50, 300);
  if (near) cars.push(near);
  // un taxi parcheggiato vicino allo spawn, per provare subito le missioni
  const tp = randomParkingNear(player.x, player.y, 120, 600);
  if (tp) cars.push(makeTaxi(makeParked(tp.x, tp.y, tp.angle)));
  // ...e anche una moto delle consegne, per provare il pizza delivery
  const mp = randomParkingNear(player.x, player.y, 120, 700);
  if (mp) cars.push(makeDeliveryMoto(makeParked(mp.x, mp.y, mp.angle)));
  // i mezzi di servizio parcheggiati davanti a ogni struttura speciale
  for (const lm of landmarks)
    for (let k = 0; k < (SERVICE_COUNT[lm.type] || 1); k++) parkServiceCar(lm);
  // la base è presidiata: jeep sparse nel piazzale e guarnigione di guardie
  for (const lm of landmarks) if (lm.type === 'army') {
    for (let k = 0; k < 3; k++) parkArmyJeep(lm);
    for (let k = 0; k < 8; k++) { const g = makeGuard(lm); if (g) peds.push(g); }
  }
})();

