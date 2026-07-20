// LIBRE CITY · js/server-sim-glue.js — colla HEADLESS per la simulazione autoritativa (Fase 2).
//
// NON è incluso in index.html: viene concatenato IN CODA al bundle della sim solo
// da server/sim-runtime.js (Node + vm), così condivide lo scope globale dei
// <script> classici del gioco e può leggere/scrivere player/cars/peds e chiamare
// le funzioni della sim. Qui vivono:
//   1) gli SHIM DI INPUT che nel browser stanno in input.js (assente sul server);
//   2) lo stato MULTI-GIOCATORE (players[]) e l'orchestrazione del tick;
//   3) enter/exit auto e clacson (compatti, da input.js);
//   4) l'API di controllo `__sim` che l'harness Node richiama oltre il confine vm.
//
// Modello: UNA sola città autoritativa per stanza. L'IA e i danni sono resi
// multi-player dagli helper in entities.js (nearestPlayer/eachActivePlayer/asPlayer),
// attivati impostando MP = players. Il livello "ricercato" è di STANZA (heat
// condiviso) in questa prima versione; cash/morte/respawn sono per-giocatore.

started = true;                          // abilita weaponKey ecc. (nessun rendering sul server)

// ---- shim di input: leggono il comando del giocatore attualmente in simulazione ----
var __curInput = { ax: 0, ay: 0, aim: 0, fireHeld: false, fireEdge: false };
var keys = {};
var touchDrive = { active: false, angle: 0 };
var usingTouch = false;
var missionsOn = false;                  // niente missioni in autoritativo
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
// niente mouse sul server: ricostruiamo un punto davanti al player dall'angolo di
// mira trasmesso, così atan2(mouseWY-y, mouseWX-x) torna quell'angolo (armi/torretta/idrante)
function mouseWX() { return player.x + Math.cos(__curInput.aim) * 130; }
function mouseWY() { return player.y + Math.sin(__curInput.aim) * 130; }
function applyTouchInput() {}            // il tick lo guida la glue

// ===== stato multi-giocatore =====
var players = [];
MP = players;                            // attiva il percorso multi-player negli helper della sim
var __playerSeq = 0;

function makeSimPlayer(name, shirtIdx) {
  const sp = randomRoadNear(WORLD_W / 2, WORLD_H / 2, 0, 500) || nodes[Math.floor(nodes.length / 2)];
  return {
    id: 'p' + (++__playerSeq), name: String(name || 'Ospite').slice(0, 14), shirtIdx: shirtIdx | 0,
    x: sp.x, y: sp.y, r: 8, health: 100, aim: 0, walk: 0, moving: false,
    car: null, shootCd: 0, hurtCd: 0, punchT: 0,
    weaponIdx: 0, owned: WEAPONS.map(w => !w.price),
    shirt: '#e0533a', skin: '#f6c79a', hair: '#5a3a1a',
    cash: 0, downT: 0, downKind: null, kills: 0, deaths: 0,
    score: 0, streak: 0, bounty: 0, events: [],   // punteggio/serie/taglia + coda messaggi (toast) del player
    input: { ax: 0, ay: 0, aim: 0, fireHeld: false, fireEdge: false, enterExit: false, horn: false, weapon: null },
  };
}
function playerById(id) { for (const p of players) if (p.id === id) return p; return null; }
// marshalling dei globali per-giocatore (downT/downKind/cash) attorno alla sua fase
function loadP(pl) { player = pl; downT = pl.downT | 0; downKind = pl.downKind; cash = pl.cash | 0; }
function saveP(pl) { pl.downT = downT; pl.downKind = downKind; pl.cash = cash; }

// ---- carjacking: sbalza fuori il guidatore (da input.js:tossDriver) ----
// input.js NON è nel bundle del server, ma la glue lo richiama quando un giocatore
// entra in un'auto del traffico/polizia/esercito: senza questa copia la sim lanciava
// "tossDriver is not defined" a OGNI tick (flag enterExit mai azzerato) e il mondo
// autoritativo si congelava per tutti. `hear`/`sfx` sono già stub no-op sul server.
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

// ---- sali / scendi (compatto, da input.js:toggleCar, senza toast/missioni/net) ----
function simEnterExit(pl) {
  if (pl.downT > 0) return;
  if (pl.car) {                          // scendi accanto all'auto, in un punto libero
    const c = pl.car;
    const nx = Math.cos(c.angle + Math.PI / 2), ny = Math.sin(c.angle + Math.PI / 2);
    let ex = c.x + nx * 34, ey = c.y + ny * 34;
    if (boxHits(ex, ey, pl.r, pl.r)) { ex = c.x - nx * 34; ey = c.y - ny * 34; }
    if (boxHits(ex, ey, pl.r, pl.r)) { ex = c.x; ey = c.y; }
    pl.x = ex; pl.y = ey;
    c.driver = null; c.speed = 0; c.role = 'parked'; c.edge = null;   // resta ferma: la vedono tutti
    pl.car = null;
    return;
  }
  let best = null, bd = 52;
  for (const c of cars) { if (c.driver) continue; const d = dist(c.x, c.y, pl.x, pl.y); if (d < bd) { bd = d; best = c; } }
  if (!best) return;
  if (best.role === 'traffic' || best.role === 'police' || best.role === 'armycar') { player = pl; tossDriver(best); }
  pl.car = best; best.driver = 'player'; best.owner = pl.id;
  if (best.role === 'traffic' || best.role === 'parked') best.role = 'player';
  if (best.isTank) {                     // rubare un carro armato scatena l'esercito
    let lm = null, bdl = Infinity;
    for (const l of landmarks) if (l.type === 'army') { const d = dist(l.cx, l.cy, pl.x, pl.y); if (d < bdl) { bdl = d; lm = l; } }
    if (lm) { player = pl; triggerArmyAlert(lm); }
  }
}
function simHorn(pl) {
  const c = pl.car; if (!c) return;
  if (c.wasPolice || c.livery === 'ambulance' || c.livery === 'fire') c.sirenOn = !c.sirenOn;
}

// ===== il tick del mondo autoritativo (rimpiazza update() di gameplay.js) =====
function tickWorld() {
  updateLights();
  // --- FASE PER-GIOCATORE: ognuno agisce con i propri globali marshalati ---
  for (const pl of players) {
    loadP(pl);
    __curInput = pl.input;
    mDownL = pl.input.fireHeld; mClicked = pl.input.fireEdge;
    if (pl.hurtCd > 0) pl.hurtCd--;
    if (downT > 0) updateDown();
    else {
      // i flag one-shot vanno azzerati PRIMA di agire: se l'azione lancia
      // un'eccezione, il flag non resta "incastrato" a rifar throw ogni tick
      if (pl.input.weapon != null) { const w = pl.input.weapon; pl.input.weapon = null; weaponKey(w); }
      if (pl.input.enterExit) { pl.input.enterExit = false; simEnterExit(pl); }
      if (pl.input.horn)      { pl.input.horn = false;      simHorn(pl); }
      if (pl.car) updateDrive(pl.car); else updatePlayerFoot();
      // CLIENT-AUTHORITATIVE: la posizione la decide il client. Sovrascrivo quella
      // simulata dal server (il movimento del server è scartato; lo sparo/le interazioni
      // qui sopra sono già avvenuti dalla posizione riportata). Solo da vivo.
      if (pl.hasReport) {
        pl.x = pl.rx; pl.y = pl.ry;
        if (pl.car && pl.rcx != null) { pl.car.x = pl.rcx; pl.car.y = pl.rcy;
          if (pl.rca != null) pl.car.angle = pl.rca; if (pl.rcsp != null) pl.car.speed = pl.rcsp; }
      }
      updateHealPads();
    }
    pl.input.fireEdge = false;
    saveP(pl);
  }
  // --- FASE MONDO CONDIVISA (funzioni della sim invariate) ---
  for (const c of cars) updateCar(c);
  resolveCarCollisions();
  for (const pl of players) if (pl.car) { pl.x = pl.car.x; pl.y = pl.car.y; }   // ri-sincronizza chi guida
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
  // decadimento del livello ricercato (heat di stanza)
  if (crimeCd > 0) crimeCd--;
  else if (wantedHeat > 0) { wantedHeat = Math.max(0, wantedHeat - 0.0016); wanted = Math.floor(wantedHeat); }
  frame++;
}

// ===== payload di rete (stesse forme che il client sa già decodificare) =====
const R2 = v => Math.round(v);
function carPayload(c) {
  return { id: c.id, x: R2(c.x), y: R2(c.y), an: c.angle, sp: Math.round(c.speed * 100) / 100,
           w: c.w, h: c.h, col: c.color, role: c.role,
           bike: !!c.isBike, tank: !!c.isTank, taxi: !!c.isTaxi, del: !!c.isDelivery,
           liv: c.livery || null, pol: !!c.wasPolice, hel: c.helmet || null,
           tur: c.isTank ? c.turretA : null, siren: !!c.sirenOn, lp: c.lightPhase || 0,
           burn: !!c.burning, smk: !!c.smoking,
           // fisica di guida: serve al client per PREDIRE il moto del proprio mezzo
           top: c.top, acc: c.accel, mass: c.mass, gears: c.gears };
}
function pedPayload(p) {
  return { id: p.id, x: R2(p.x), y: R2(p.y), f: p.facing || 0, wk: Math.round((p.walk || 0) * 100) / 100,
           role: p.role, ko: !!p.ko, sh: p.shirt, sk: p.skin, ha: p.hair, dr: p.copDress ? 1 : p.soldierDress ? 2 : 0 };
}
function playerView(p) {
  return { id: p.id, name: p.name, sh: p.shirtIdx, x: R2(p.x), y: R2(p.y), aim: p.aim,
           wk: Math.round((p.walk || 0) * 100) / 100, mov: !!p.moving,
           gun: !WEAPONS[p.weaponIdx].melee, hp: R2(p.health), down: p.downT > 0,
           punch: p.punchT > 0, car: p.car ? carPayload(p.car) : null };
}
// ---- effetti cosmetici → eventi 'fx' per il client ----
// Sul server le particelle non servono: intercettiamo gli spawn* di gameplay.js e li
// trasformiamo in eventi leggeri (posizione + tipo), inviati negli snapshot. Il client
// li ricrea (particelle + audio via hear). Così muzzle/sangue/scintille/esplosioni si
// vedono e si sentono anche in multigiocatore, senza far crescere `parts` sul server.
var __fx = [];
spawnMuzzle = (x, y, a) => { __fx.push({ k: 0, x: R2(x), y: R2(y), a }); };
spawnBlood = (x, y) => { __fx.push({ k: 1, x: R2(x), y: R2(y) }); };
spawnSparks = (x, y, n) => { __fx.push({ k: 2, x: R2(x), y: R2(y), n: n | 0 }); };
spawnExplosion = (x, y) => { __fx.push({ k: 3, x: R2(x), y: R2(y) }); };

const AOI_R = 1200;                       // raggio di interesse attorno a ciascun giocatore

// snapshot del mondo per il giocatore `id`: solo entità entro AOI_R da lui
function snapshotFor(id) {
  const me = playerById(id); if (!me) return null;
  const mx = me.x, my = me.y, R = AOI_R, R2q = R * R;
  const near = (x, y) => { const dx = x - mx, dy = y - my; return dx * dx + dy * dy <= R2q; };
  const out = {
    t: 'w', tick: frame, ack: me.input.seq || 0,
    me: { x: R2(me.x), y: R2(me.y), aim: me.aim, hp: R2(me.health), cash: me.cash,
          wanted, down: me.downT > 0, dt: me.downT, dk: me.downKind, wp: me.weaponIdx, own: me.owned,
          k: me.kills, d: me.deaths, sco: me.score | 0, stk: me.streak | 0, bty: me.bounty | 0,
          ev: (me.events && me.events.length) ? me.events.splice(0) : null,   // toast in coda → li consumo qui
          car: me.car ? carPayload(me.car) : null },
    players: [], cars: [], peds: [], bul: [], rkt: [], coins: [], fires: [], fx: [],
  };
  for (const e of __fx) if (near(e.x, e.y)) out.fx.push(e);
  for (const p of players) if (p !== me && near(p.x, p.y)) out.players.push(playerView(p));
  for (const c of cars) if (c.driver !== 'player' && near(c.x, c.y)) out.cars.push(carPayload(c));
  for (const p of peds) if (near(p.x, p.y)) out.peds.push(pedPayload(p));
  for (const b of bullets) if (near(b.x, b.y)) out.bul.push({ x: R2(b.x), y: R2(b.y), a: Math.atan2(b.vy, b.vx), hostile: !b.fromPlayer });
  for (const r of rockets) if (near(r.x, r.y)) out.rkt.push({ x: R2(r.x), y: R2(r.y), a: Math.atan2(r.vy, r.vx) });
  for (const k of coins) if (near(k.x, k.y)) out.coins.push({ x: R2(k.x), y: R2(k.y), v: k.val });
  for (const f of fires) if (near(f.x, f.y)) out.fires.push({ x: R2(f.x), y: R2(f.y) });
  return out;
}

// ===== API di controllo esposta all'harness Node (var top-level ⇒ prop del global) =====
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
    if (cmd.ax != null) i.ax = cmd.ax; if (cmd.ay != null) i.ay = cmd.ay;
    if (cmd.aim != null) i.aim = cmd.aim; if (cmd.seq != null) i.seq = cmd.seq;
    if (cmd.b != null) { i.fireHeld = !!(cmd.b & 1); if (cmd.b & 2) i.fireEdge = true; if (cmd.b & 4) i.enterExit = true; if (cmd.b & 8) i.horn = true; }
    if (cmd.drive) { touchDrive.active = !!cmd.drive.active; touchDrive.angle = cmd.drive.angle || 0; }
    if (cmd.w != null) i.weapon = cmd.w;
    // POSIZIONE client-authoritative: il player possiede il proprio movimento. La
    // memorizziamo qui e tickWorld la applica dopo il sim del player (lo sparo/le
    // interazioni restano lato server, dalla posizione riportata dal client).
    if (cmd.px != null) {
      pl.rx = cmd.px; pl.ry = cmd.py; pl.hasReport = true;
      if (cmd.cx != null) { pl.rcx = cmd.cx; pl.rcy = cmd.cy; pl.rca = cmd.ca; pl.rcsp = cmd.csp; }
      else pl.rcx = null;
    }
  },
  tick() { tickWorld(); },
  snapshotFor,
  clearFx() { __fx.length = 0; },        // il server svuota gli fx dopo ogni giro di snapshot
  playerState(id) { const p = playerById(id); return p ? { id: p.id, x: R2(p.x), y: R2(p.y), hp: R2(p.health), cash: p.cash, down: p.downT > 0, inCar: !!p.car, wanted } : null; },
  scores() { return players.map(p => ({ id: p.id, name: p.name, k: p.kills, d: p.deaths, c: p.cash, s: p.score | 0, b: p.bounty | 0 })); },
  playerCount() { return players.length; },
  _player(id) { return playerById(id); },   // solo per i test: riferimento diretto all'oggetto player
  // --- diagnostica per i test ---
  worldInfo() {
    let sig = 0;
    for (let i = 0; i < grid.length; i++) sig = (sig * 31 + grid[i]) | 0;
    for (const l of landmarks) sig = (sig * 31 + l.x0 * 7 + l.y0 * 13 + l.type.charCodeAt(0)) | 0;
    return { room: ROOM_CODE, worldW: WORLD_W, worldH: WORLD_H, nodes: nodes.length, edges: edges.length, landmarks: landmarks.length, sig };
  },
  counts() { return { frame, cars: cars.length, peds: peds.length, coins: coins.length, bullets: bullets.length, players: players.length }; },
};
