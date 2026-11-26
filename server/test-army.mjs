// VIBE CITY · server/test-army.mjs — the military base: layout, guard duties, parking.
//   Usage:  node server/test-army.mjs
import runtime from './sim-runtime.js';
const { createRoomSim } = runtime;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const T = 32;
const sim = createRoomSim('ARMY01');
const base = sim._landmarks().find(l => l.type === 'army');
const insideRect = (r, x, y) => x >= r.x0 * T && x < (r.x1 + 1) * T && y >= r.y0 * T && y < (r.y1 + 1) * T;
const guards = () => sim._peds().filter(p => p.guard && !p.dead);

console.log('1) layout della base');
ok(!!base && !!base.layout, 'la città ha una base militare con layout');
const BUILDING = sim._tileAt(base.x0, base.y0);
const solidBuildings = base.layout.buildings.every(r => {
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) if (sim._tileAt(x, y) !== BUILDING) return false;
  return true;
});
ok(solidBuildings, 'camerate, comando, autorimessa e deposito sono solidi');
const ringFree = (() => {
  for (let x = base.x0 + 1; x < base.x1; x++)
    for (const y of [base.y0 + 1, base.y0 + 2, base.y1 - 1, base.y1 - 2]) if (sim._tileAt(x, y) === BUILDING) return false;
  for (let y = base.y0 + 1; y < base.y1; y++)
    for (const x of [base.x0 + 1, base.x0 + 2, base.x1 - 1, base.x1 - 2]) if (sim._tileAt(x, y) === BUILDING) return false;
  return true;
})();
ok(ringFree, 'la strada perimetrale interna è libera');

console.log('2) mezzi nel piazzale');
const parked = sim._cars().filter(c => c.serviceType === 'army' || c.serviceType === 'armyjeep');
ok(parked.length === 3, 'carro armato + 2 jeep parcheggiati (' + parked.length + ')');
ok(parked.every(c => insideRect(base.layout.motorPool, c.x, c.y)), 'tutti i mezzi stanno nel piazzale dell\'autorimessa');

console.log('3) guardie a piedi');
ok(guards().length === 2, 'solo 2 guardie a piedi (' + guards().length + ')');
const sentry = guards().find(p => p.duty.post);
const patrol = guards().find(p => p.duty.route);
ok(!!sentry && !!patrol, 'una sentinella fissa e una pattuglia');
ok(insideRect(base, sentry.duty.post.x, sentry.duty.post.y) && Math.hypot(sentry.duty.post.x - base.gate.x, sentry.duty.post.y - base.gate.y) < 4 * T,
   'la sentinella è dentro la base, accanto al cancello');

const id = sim.addPlayer('Tester', 0);
const player = sim._player(id);
const away = Math.atan2(base.door.y - base.cy, base.door.x - base.cx);
player.x = base.cx + Math.cos(away) * 700; player.y = base.cy + Math.sin(away) * 700;
const visited = new Set();
let maxSentryDrift = 0, maxGuards = 0, patrolLeftBase = false;
for (let f = 0; f < 1500; f++) {
  sim.tick();
  const patrolNow = guards().find(p => p.duty.route);
  const sentryNow = guards().find(p => p.duty.post);
  if (patrolNow) { visited.add(patrolNow.routeIndex); if (!insideRect(base, patrolNow.x, patrolNow.y)) patrolLeftBase = true; }
  if (sentryNow) maxSentryDrift = Math.max(maxSentryDrift, Math.hypot(sentryNow.x - sentryNow.duty.post.x, sentryNow.y - sentryNow.duty.post.y));
  maxGuards = Math.max(maxGuards, guards().length);
}
ok(maxSentryDrift < 6, 'la sentinella resta al suo posto (scarto ' + maxSentryDrift.toFixed(1) + 'px)');
ok(visited.size >= 3, 'la pattuglia percorre il perimetro (' + visited.size + ' tappe)');
ok(!patrolLeftBase, 'la pattuglia non esce dalla base');
ok(maxGuards === 2, 'le guardie non si accumulano (max ' + maxGuards + ')');

console.log('4) nessun civile generato nella base');
let spawnedInside = 0;
for (let i = 0; i < 300; i++) {
  const spot = sim._randomWalkNear(base.cx, base.cy, 0, 500);
  if (spot && insideRect(base, spot.x, spot.y)) spawnedInside++;
}
ok(spawnedInside === 0, 'i punti di spawn a piedi escludono la base (' + spawnedInside + ')');


console.log('5) base on an island inside the city, reachable only over the bridge');
const ISLAND_BANKS = 5;
const armyOf = roomSim => roomSim._landmarks().find(l => l.type === 'army');
function ringTiles(base, distance) {
  const tiles = [], x0 = base.x0 - distance, y0 = base.y0 - distance, x1 = base.x1 + distance, y1 = base.y1 + distance;
  for (let x = x0; x < x1; x++) tiles.push([x, y0]);
  for (let y = y0; y < y1; y++) tiles.push([x1, y]);
  for (let x = x1; x > x0; x--) tiles.push([x, y1]);
  for (let y = y1; y > y0; y--) tiles.push([x0, y]);
  return tiles;
}
function checkIslandBase(roomSim, code) {
  const armyBase = armyOf(roomSim), kinds = roomSim._tileKinds();
  const { worldW, worldH } = roomSim.worldInfo(), mapW = worldW / T, mapH = worldH / T;
  ok(armyBase.x0 >= 8 && armyBase.y0 >= 8 && armyBase.x1 <= mapW - 8 && armyBase.y1 <= mapH - 8, code + ': the base fence lies inside the city');

  const gateX = Math.floor(armyBase.gate.x / T), gateY = Math.floor(armyBase.gate.y / T);
  const onGateSide = gateY === armyBase.y0 ? (x, y) => y < armyBase.y0
    : gateY === armyBase.y1 ? (x, y) => y > armyBase.y1
    : gateX === armyBase.x0 ? x => x < armyBase.x0 : x => x > armyBase.x1;
  const bridgeTiles = [];
  let moatIntact = true;
  for (const distance of [2, 3, 4]) {
    const ring = ringTiles(armyBase, distance), dry = ring.map(([x, y]) => roomSim._tileAt(x, y) !== kinds.WATER);
    const runStarts = dry.filter((isDry, k) => isDry && !dry[(k + ring.length - 1) % ring.length]).length;
    const dryTiles = ring.filter((_, k) => dry[k]);
    const deckOnly = dryTiles.every(([x, y]) => [kinds.ROAD, kinds.SIDEWALK].includes(roomSim._tileAt(x, y)) && onGateSide(x, y));
    if (runStarts !== 1 || !deckOnly) moatIntact = false;
    bridgeTiles.push(...dryTiles);
  }
  ok(moatIntact, code + ': the moat is water all round except one bridge on the gate side (' + bridgeTiles.length + ' tiles)');

  const bridgeKeys = new Set(bridgeTiles.map(([x, y]) => y * mapW + x));
  const walkable = [kinds.ROAD, kinds.SIDEWALK, kinds.ALLEY, kinds.GRASS];
  const outsideIsland = (x, y) => x < armyBase.x0 - ISLAND_BANKS || x > armyBase.x1 + ISLAND_BANKS ||
                                  y < armyBase.y0 - ISLAND_BANKS || y > armyBase.y1 + ISLAND_BANKS;
  const reachesCityRoad = blockBridge => {
    const seen = new Uint8Array(mapW * mapH), queue = [[gateX, gateY]];
    seen[gateY * mapW + gateX] = 1;
    while (queue.length) {
      const [x, y] = queue.pop();
      if (outsideIsland(x, y) && roomSim._tileAt(x, y) === kinds.ROAD) return true;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        const key = ny * mapW + nx;
        if (nx < 0 || ny < 0 || nx >= mapW || ny >= mapH || seen[key]) continue;
        seen[key] = 1;
        if (walkable.includes(roomSim._tileAt(nx, ny)) && !(blockBridge && bridgeKeys.has(key))) queue.push([nx, ny]);
      }
    }
    return false;
  };
  ok(reachesCityRoad(false), code + ': from the gate a city road is reachable on foot');
  ok(!reachesCityRoad(true), code + ': without the bridge the base is cut off');
}
checkIslandBase(sim, 'ARMY01');
for (const code of ['PABC12', 'MABC12', 'GABC12']) checkIslandBase(createRoomSim(code), code);

const seededBases = ['PAAA01', 'PAAA02', 'PAAA03', 'PAAA04', 'PAAA05', 'PAAA06'].map(code => {
  const roomSim = createRoomSim(code), armyBase = armyOf(roomSim);
  return { cx: armyBase.cx, cy: armyBase.cy, worldW: roomSim.worldInfo().worldW };
});
ok(new Set(seededBases.map(b => b.cx + ',' + b.cy)).size > 1, 'the base position changes with the seed');
ok(seededBases.some(b => b.cx < b.worldW / 2), 'some seed puts the base in the left half of the map');
ok(seededBases.some(b => b.cx > b.worldW / 2), 'some seed puts the base in the right half of the map');

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
