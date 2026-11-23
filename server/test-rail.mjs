import runtime from './sim-runtime.js';
const { createRoomSim } = runtime;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const T = 32, TRAIN_SPEED = 6.5, TRAIN_BODY_H = 30, TRAIN_LEN = 66 + 3 * (52 + 8), ISLAND_BANKS = 5;
const GRID_SIZES = { PABC12: [8, 8], MABC12: [8, 16], GABC12: [16, 16] };

function simWithCars(code) {
  const sim = createRoomSim(code);
  sim.addPlayer('Tester', 0, 'p1');
  for (let f = 0; f < 600 && sim._cars().length === 0; f++) sim.tick();
  return sim;
}

for (const code of Object.keys(GRID_SIZES)) {
  console.log(code);
  const sim = simWithCars(code), K = sim._tileKinds();
  const { loopLen, crossings, pointAt } = sim._rail();
  const wrap = along => ((along % loopLen) + loopLen) % loopLen;

  const start = pointAt(0), end = pointAt(loopLen);
  ok(Math.hypot(start.x - end.x, start.y - end.y) < 1, `${code}: the loop closes (${loopLen.toFixed(0)} px)`);
  const samples = [];
  for (let along = 0; along < loopLen; along += 8) samples.push(pointAt(along));
  samples.push(end);
  let widestStep = 0;
  for (let i = 1; i < samples.length; i++) widestStep = Math.max(widestStep, Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y));
  ok(widestStep <= 8.5, `${code}: the loop is continuous (widest 8 px step ${widestStep.toFixed(2)} px)`);

  let buildingsNearTrack = 0;
  const army = sim._landmarks().find(l => l.type === 'army');
  let samplesOnIsland = 0;
  for (const p of samples) {
    for (let ty = Math.floor(p.y / T) - 2; ty <= Math.floor(p.y / T) + 2; ty++) for (let tx = Math.floor(p.x / T) - 2; tx <= Math.floor(p.x / T) + 2; tx++)
      if (Math.hypot((tx + 0.5) * T - p.x, (ty + 0.5) * T - p.y) <= T && sim._tileAt(tx, ty) === K.BUILDING) buildingsNearTrack++;
    const tx = Math.floor(p.x / T), ty = Math.floor(p.y / T);
    if (army && tx >= army.x0 - ISLAND_BANKS && tx <= army.x1 + ISLAND_BANKS && ty >= army.y0 - ISLAND_BANKS && ty <= army.y1 + ISLAND_BANKS) samplesOnIsland++;
  }
  ok(buildingsNearTrack === 0, `${code}: no building within one tile of the track (${buildingsNearTrack})`);
  ok(!!army && samplesOnIsland === 0, `${code}: the track stays off the army island (${samplesOnIsland} samples on it)`);

  const [columns, rows] = GRID_SIZES[code];
  ok(crossings.length >= 2 * (columns - 2) + 2 * (rows - 2), `${code}: every street leaving the ring road is crossed (${crossings.length} crossings)`);
  ok(crossings.every(cr => sim._tileAt(Math.floor(cr.x / T), Math.floor(cr.y / T)) === K.ROAD), `${code}: every crossing sits on a road tile`);

  const twin = createRoomSim(code);
  sim._setFrame(1234); twin._setFrame(1234);
  ok(JSON.stringify(sim._train().segs) === JSON.stringify(twin._train().segs), `${code}: the train position depends on the frame only`);

  let fastestStep = 0;
  sim._setFrame(0);
  let previous = { x: sim._train().x, y: sim._train().y };
  for (let f = 1; f <= Math.ceil(loopLen / TRAIN_SPEED) + 2; f++) {
    sim._setFrame(f);
    const head = sim._train();
    fastestStep = Math.max(fastestStep, Math.hypot(head.x - previous.x, head.y - previous.y));
    previous = { x: head.x, y: head.y };
  }
  ok(fastestStep <= TRAIN_SPEED + 0.01, `${code}: the head moves at most TRAIN_SPEED per frame over a whole lap (${fastestStep.toFixed(3)} px)`);

  let worstCoupling = 0;
  for (const headS of [0, 60, 120, 180, 240, loopLen - 30]) {
    sim._setFrame(Math.round(headS / TRAIN_SPEED));
    const segs = sim._train().segs;
    for (let i = 1; i < segs.length; i++) {
      const expected = segs[i - 1].w / 2 + 8 + segs[i].w / 2;
      worstCoupling = Math.max(worstCoupling, Math.abs(Math.hypot(segs[i].cx - segs[i - 1].cx, segs[i].cy - segs[i - 1].cy) - expected));
    }
  }
  ok(worstCoupling < 2, `${code}: the train stays coupled while straddling s = 0 (worst ${worstCoupling.toFixed(2)} px)`);

  const car = sim._cars()[0];
  const frameWithHeadAt = headS => Math.round(wrap(headS) / TRAIN_SPEED);
  const blockedNear = cr => { car.x = cr.x; car.y = cr.y; sim._setFrame(frameWithHeadAt(cr.s - 200)); return sim._trainBlocking(car); };
  const blockedFar = cr => { car.x = cr.x; car.y = cr.y; sim._setFrame(frameWithHeadAt(cr.s + loopLen / 2)); return sim._trainBlocking(car); };
  const bySpan = crossings.slice().sort((a, b) => a.s - b.s);
  const middle = bySpan[Math.floor(bySpan.length / 2)], first = bySpan[0], last = bySpan[bySpan.length - 1];
  ok(!!car && blockedNear(middle) && !blockedFar(middle), `${code}: a car on a crossing stops when the train is near, not when it is far`);
  ok(blockedNear(first) && !blockedFar(first), `${code}: the same holds for the first crossing after s = 0 (s = ${first.s.toFixed(0)})`);
  sim._setFrame(frameWithHeadAt(20));
  const headS = sim._train().s, straddles = wrap(headS - TRAIN_LEN) > headS;
  const heldAt = cr => { car.x = cr.x; car.y = cr.y; return sim._trainBlocking(car); };
  ok(straddles && heldAt(first) && heldAt(last),`${code}: a train straddling s = 0 holds the crossings on both sides of it (s = ${first.s.toFixed(0)} and ${last.s.toFixed(0)})`);

  const trackFrame = frameWithHeadAt((first.s + bySpan[1].s) / 2 + 150);
  sim._setFrame(trackFrame);
  const carriage = sim._train().segs[2];
  car.x = carriage.cx - carriage.sin * 5; car.y = carriage.cy + carriage.cos * 5;
  car.speed = 0;
  sim._trainCollide();
  const dx = car.x - carriage.cx, dy = car.y - carriage.cy;
  const lx = dx * carriage.cos + dy * carriage.sin, ly = dy * carriage.cos - dx * carriage.sin;
  const outside = Math.abs(lx) >= carriage.w / 2 + car.colH || Math.abs(ly) >= TRAIN_BODY_H / 2 + car.colH;
  ok(sim._cars().includes(car) && outside, `${code}: a car overlapping a carriage is pushed out of it (local ${lx.toFixed(1)}, ${ly.toFixed(1)})`);
}
console.log('peace city: skipped, the server runtime cannot create one (PEACE_CITY reads localStorage); the railway does not depend on PEACE_CITY');

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
