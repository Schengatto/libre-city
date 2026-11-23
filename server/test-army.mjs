// LIBRE CITY · server/test-army.mjs — the military base: layout, guard duties, parking.
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

console.log('5) base fuori città, oltre il fiume, raggiungibile solo dal ponte');
function checkOutskirtsBase(roomSim, code) {
  const armyBase = roomSim._landmarks().find(l => l.type === 'army');
  const kinds = roomSim._tileKinds(), cityW = roomSim._cityWidth(), { nodes, edges } = roomSim._roadGraph();
  const { worldW, worldH } = roomSim.worldInfo(), mapW = worldW / T, mapH = worldH / T;
  ok(armyBase.x0 > cityW && armyBase.x1 < mapW, code + ': la base sta interamente oltre il bordo della città');

  const riverRows = [];
  for (let y = 0; y < mapH; y++) if (roomSim._tileAt(cityW, y) !== kinds.WATER) riverRows.push(y);
  const contiguous = riverRows.every((row, i) => i === 0 || row === riverRows[i - 1] + 1);
  ok(riverRows.length >= 3 && riverRows.length <= 7 && contiguous,
     code + ': il fiume è acqua da bordo a bordo tranne il ponte (' + riverRows.length + ' righe)');

  const isCity = node => node.x < cityW * T;
  const crossings = edges.filter(e => !e.dead && isCity(nodes[e.a]) !== isCity(nodes[e.b]));
  ok(crossings.length === 1, code + ': una sola strada attraversa il fiume (' + crossings.length + ')');
  const bridge = crossings[0];
  const bridgeRow = Math.floor(nodes[bridge.a].y / T);
  ok(riverRows.includes(bridgeRow) && roomSim._tileAt(cityW, bridgeRow) === kinds.ROAD, code + ': il varco nel fiume è la carreggiata del ponte');

  const islandEnd = isCity(nodes[bridge.a]) ? nodes[bridge.b] : nodes[bridge.a];
  ok(Math.hypot(islandEnd.x - armyBase.gate.x, islandEnd.y - armyBase.gate.y) < 5 * T, code + ': il ponte arriva davanti al cancello');
  const reachedByRoad = new Set([nodes.indexOf(islandEnd)]);
  const roadQueue = [...reachedByRoad];
  while (roadQueue.length) {
    const n = roadQueue.pop();
    for (const ei of nodes[n].edges) {
      if (edges[ei].dead) continue;
      const next = edges[ei].a === n ? edges[ei].b : edges[ei].a;
      if (!reachedByRoad.has(next)) { reachedByRoad.add(next); roadQueue.push(next); }
    }
  }
  ok([...reachedByRoad].some(n => isCity(nodes[n]) && nodes[n].x < (cityW - 20) * T), code + ': dalla città si arriva al cancello in auto, passando dal ponte');

  const passable = (x, y) => { const t = roomSim._tileAt(x, y); return t !== kinds.BUILDING && t !== kinds.TREE && t !== kinds.WATER; };
  const reachesCityOnFoot = blocked => {
    const start = [Math.floor(armyBase.gate.x / T), Math.floor(armyBase.gate.y / T)];
    const seen = new Uint8Array(mapW * mapH), queue = [start];
    seen[start[1] * mapW + start[0]] = 1;
    while (queue.length) {
      const [x, y] = queue.pop();
      if (x < cityW) return true;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= mapW || ny >= mapH || seen[ny * mapW + nx]) continue;
        seen[ny * mapW + nx] = 1;
        if (passable(nx, ny) && !blocked(nx, ny)) queue.push([nx, ny]);
      }
    }
    return false;
  };
  ok(reachesCityOnFoot(() => false), code + ': dal cancello si raggiunge la città a piedi');
  ok(!reachesCityOnFoot((x, y) => x === cityW && riverRows.includes(y)), code + ': senza il ponte la base è isolata');
}
checkOutskirtsBase(sim, 'ARMY01');
for (const code of ['MARMY2', 'GARMY3']) checkOutskirtsBase(createRoomSim(code), code);

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
