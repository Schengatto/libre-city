import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRoomSim } = require('./sim-runtime.js');

let ok = 0, fail = 0;
const check = (cond, msg, extra) => {
  if (cond) { ok++; console.log('  OK  ' + msg); }
  else { fail++; console.log('  ✗   ' + msg + (extra ? ' → ' + extra : '')); }
};

function referenceNearestThreatCar(cars, x, y, range) {
  let best = null, bestDistance = range;
  for (const c of cars) {
    if (Math.abs(c.speed) < 3) continue;
    const distance = Math.hypot(c.x - x, c.y - y);
    if (distance < bestDistance) { bestDistance = distance; best = c; }
  }
  return best;
}

function referenceCarProj(c, ux, uy) {
  const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
  return (c.w || 46) / 2 * Math.abs(ux * ca + uy * sa) + (c.h || 24) / 2 * Math.abs(uy * ca - ux * sa);
}

function referenceGapAhead(cars, c, maxLook, push) {
  let gap = maxLook;
  const ax = c.dir.x, ay = c.dir.y;
  const myFront = referenceCarProj(c, ax, ay);
  const myHalfW = referenceCarProj(c, -ay, ax);
  for (const o of cars) {
    if (o === c || o.role === 'parked') continue;
    if (push && Math.abs(o.speed) < 0.2 && c.dir.x * o.dir.x + c.dir.y * o.dir.y < 0.3) continue;
    const dx = o.x - c.x, dy = o.y - c.y;
    const along = dx * ax + dy * ay;
    if (along <= 0) continue;
    const side = -dx * ay + dy * ax;
    if (Math.abs(side) > myHalfW + referenceCarProj(o, -ay, ax) + 4) continue;
    const g = along - myFront - referenceCarProj(o, ax, ay);
    if (g < gap) gap = g;
  }
  return Math.max(0, gap);
}

const sim = createRoomSim('HOTPATH');
sim.addPlayer('Tester', 0);
const tileSize = sim._tileSize();
let threatMismatches = 0, threatsFound = 0, threatQueries = 0;
let gapMismatches = 0, blockedGaps = 0, gapQueries = 0;

for (let round = 0; round < 40; round++) {
  for (let k = 0; k < 15; k++) sim.tick();
  const cars = sim._cars();
  const probes = sim._peds().map(p => ({ x: p.x, y: p.y }));
  for (const c of cars) probes.push({ x: c.x + 60, y: c.y - 40 }, { x: c.x - 149, y: c.y });
  const originalSpeeds = cars.map(c => c.speed);
  cars.forEach((c, index) => { if (index % 2 === 0) c.speed = index % 4 === 0 ? 4 : -4; });
  for (const probe of probes) {
    threatQueries++;
    const expected = referenceNearestThreatCar(cars, probe.x, probe.y, 150);
    if (expected) threatsFound++;
    if (sim._nearestThreatCar(probe.x, probe.y, 150) !== expected) threatMismatches++;
  }
  cars.forEach((c, index) => { c.speed = originalSpeeds[index]; });
  for (const c of cars) {
    if (!c.dir) continue;
    for (const push of [false, true]) {
      gapQueries++;
      const expected = referenceGapAhead(cars, c, tileSize * 5, push);
      if (expected < tileSize * 5) blockedGaps++;
      if (sim._gapAhead(c, tileSize * 5, push) !== expected) gapMismatches++;
    }
  }
}

check(threatQueries > 1000 && threatsFound > 50, `threat queries exercise real threats (${threatsFound}/${threatQueries})`);
check(threatMismatches === 0, 'nearestThreatCar matches the plain scan', `${threatMismatches} mismatches`);
check(gapQueries > 1000 && blockedGaps > 50, `gap queries exercise real obstacles (${blockedGaps}/${gapQueries})`);
check(gapMismatches === 0, 'gapAhead matches the plain scan', `${gapMismatches} mismatches`);

console.log(`\n${ok} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
