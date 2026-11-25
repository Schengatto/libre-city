import vm from 'node:vm';
import runtime from './sim-runtime.js';
import stubs from '../js/sim-stubs.js';
const { BUNDLE } = runtime;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const CODES = ['PARM0', 'MARM3', 'GARM5'];
const CIVILIAN_STEPS = 3000;
const SOLDIER_STEPS = 300;

function loadCity(code) {
  const context = vm.createContext(stubs.makeSimStubs(code, 900, { setTimeout, clearTimeout, setInterval, clearInterval }));
  vm.runInContext(BUNDLE, context, { timeout: 5000 });
  return expr => vm.runInContext(expr, context, { timeout: 20000 });
}

const CROSSING_HELPERS = `
var crossingFrameWithTrainAt = along => Math.round(railWrap(along) / TRAIN_SPEED);
var crossingNormal = crossing => { const angle = railPointAt(crossing.s).angle; return { x: -Math.sin(angle), y: Math.cos(angle) }; };
var crossingGap = (crossing, entity) => { const normal = crossingNormal(crossing); return (entity.x - crossing.x) * normal.x + (entity.y - crossing.y) * normal.y; };
`;

const HOLD_CASES = `(() => {
  const crossing = railCrossings[Math.floor(railCrossings.length / 2)], normal = crossingNormal(crossing);
  const carAt = (gap, towardRail) => {
    const side = Math.sign(gap) || 1, heading = towardRail ? -side : side;
    const car = makeCar(crossing.x + normal.x * gap, crossing.y + normal.y * gap, 'traffic');
    car.angle = Math.atan2(normal.y * heading, normal.x * heading);
    return car;
  };
  const holdGap = RAIL_STOP_OFFSET + 20;
  __sim._setFrame(crossingFrameWithTrainAt(crossing.s - 200));
  const nearTrain = {
    approaching: trainBlocking(carAt(holdGap, true)),
    approachingOtherSide: trainBlocking(carAt(-holdGap, true)),
    onRails: trainBlocking(carAt(0, true)),
    onRailEdge: trainBlocking(carAt(RAIL_TIE_H / 2, true)),
    pastStopLine: trainBlocking(carAt(RAIL_STOP_OFFSET - 4, true)),
    movingAway: trainBlocking(carAt(holdGap, false)),
    clearedTrack: trainBlocking(carAt(-holdGap, false)),
  };
  __sim._setFrame(crossingFrameWithTrainAt(crossing.s + RAIL_LOOP_LEN / 2));
  return { ...nearTrain, farTrainApproaching: trainBlocking(carAt(holdGap, true)) };
})()`;

const FIND_CROSSING_ROAD = `(() => {
  for (const crossing of railCrossings) for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex++) {
    const edge = edges[edgeIndex], samples = Math.max(8, Math.ceil(edge.len / 2));
    let crossingT = -1, nearest = Infinity;
    for (let k = 0; k <= samples; k++) {
      const point = edgePos(edge, k / samples), distance = Math.hypot(point.x - crossing.x, point.y - crossing.y);
      if (distance < nearest) { nearest = distance; crossingT = k / samples; }
    }
    if (nearest > HALF_ROAD) continue;
    for (const ed of [1, -1]) for (let k = 1; ; k++) {
      const t = crossingT - ed * k / samples;
      if (t < 0 || t > 1) break;
      const point = edgePos(edge, t);
      if (Math.hypot(point.x - crossing.x, point.y - crossing.y) >= __crossingRoadStart) return { crossingIndex: railCrossings.indexOf(crossing), edgeIndex, ed, t, crossingT };
    }
  }
  return null;
})()`;

const FAST_CAR_RUN = setup => `(() => {
  const crossing = railCrossings[${setup.crossingIndex}], fastSpeed = 9;
  cars.length = 0; peds.length = 0;
  const car = makeTrafficCar(${setup.edgeIndex}, ${setup.ed}, ${setup.t});
  car.maxSpeed = fastSpeed; car.speed = fastSpeed;
  cars.push(car);
  __sim._setFrame(crossingFrameWithTrainAt(crossing.s - 200));
  const side = Math.sign(crossingGap(crossing, car)), startGap = side * crossingGap(crossing, car);
  let closestGap = Infinity;
  for (let step = 0; step < 400; step++) { updateCar(car); closestGap = Math.min(closestGap, side * crossingGap(crossing, car)); }
  return { startGap, reach: TRAIN_STOP_BAND + car.colH + fastSpeed * fastSpeed / (2 * TRAFFIC_BRAKE), closestGap, finalSpeed: car.speed, stopOffset: RAIL_STOP_OFFSET };
})()`;

const CAR_ON_RAILS_RUN = setup => `(() => {
  const crossing = railCrossings[${setup.crossingIndex}];
  cars.length = 0; peds.length = 0;
  const car = makeTrafficCar(${setup.edgeIndex}, ${setup.ed}, ${setup.crossingT});
  cars.push(car);
  __sim._setFrame(crossingFrameWithTrainAt(crossing.s - 200));
  const side = Math.sign(crossingGap(crossing, makeTrafficCar(${setup.edgeIndex}, ${setup.ed}, ${setup.t})));
  let farthestPast = Infinity;
  for (let step = 0; step < 240 && cars.includes(car); step++) { updateCar(car); farthestPast = Math.min(farthestPast, side * crossingGap(crossing, car)); }
  return { farthestPast, clearance: RAIL_STOP_OFFSET };
})()`;

const ISLAND_WALKERS = `(() => {
  const { x0, y0, x1, y1, island, bridge } = armyZone;
  const gateX = Math.floor(bridge.x / T), gateY = Math.floor(bridge.y / T);
  const inward = gateY < y0 ? { x: 0, y: 1 } : gateY > y1 ? { x: 0, y: -1 } : gateX < x0 ? { x: 1, y: 0 } : { x: -1, y: 0 };
  const midX = Math.floor((island.x0 + island.x1) / 2), midY = Math.floor((island.y0 + island.y1) / 2);
  const gateStart = inward.y
    ? { tx: gateX, ty: inward.y > 0 ? island.y0 - 1 : island.y1 + 1, toward: inward }
    : { tx: inward.x > 0 ? island.x0 - 1 : island.x1 + 1, ty: gateY, toward: inward };
  const starts = [
    gateStart,
    { tx: island.x0 - 1, ty: midY, toward: { x: 1, y: 0 } },
    { tx: island.x1 + 1, ty: midY, toward: { x: -1, y: 0 } },
    { tx: midX, ty: island.y0 - 1, toward: { x: 0, y: 1 } },
    { tx: midX, ty: island.y1 + 1, toward: { x: 0, y: -1 } },
  ].filter(start => !solidTile(start.tx, start.ty));
  const centreOf = (tx, ty) => ({ x: (tx + 0.5) * T, y: (ty + 0.5) * T });
  const onIsland = p => inArmyIsland(Math.floor(p.x / T), Math.floor(p.y / T));
  cars.length = 0; peds.length = 0;
  let calmIslandFrames = 0, panicIslandFrames = 0;
  for (const start of starts) {
    const spot = centreOf(start.tx, start.ty);
    const calm = makePed(spot.x, spot.y, 'civ');
    calm.dir = { x: start.toward.x, y: start.toward.y }; calm.speed = 1.2; calm.thinkCd = 400;
    const panicking = makePed(spot.x, spot.y, 'civ');
    const slant = { x: start.toward.x || 0.6, y: start.toward.y || 0.6 }, slantLength = Math.hypot(slant.x, slant.y);
    panicking.dir = { x: slant.x / slantLength, y: slant.y / slantLength }; panicking.panic = ${CIVILIAN_STEPS};
    for (let step = 0; step < ${CIVILIAN_STEPS}; step++) {
      updatePed(calm); updatePed(panicking);
      if (onIsland(calm)) calmIslandFrames++;
      if (onIsland(panicking)) panicIslandFrames++;
    }
  }
  const insideStart = [
    { tx: island.x0, ty: midY, out: { x: -1, y: 0 } }, { tx: island.x1, ty: midY, out: { x: 1, y: 0 } },
    { tx: midX, ty: island.y0, out: { x: 0, y: -1 } }, { tx: midX, ty: island.y1, out: { x: 0, y: 1 } },
  ].find(spot => !solidTile(spot.tx, spot.ty) && !solidTile(spot.tx + spot.out.x, spot.ty + spot.out.y));
  let insideLeftAt = -1, insideReentered = false;
  if (insideStart) {
    const spot = centreOf(insideStart.tx, insideStart.ty), stray = makePed(spot.x, spot.y, 'civ');
    stray.dir = { x: 0, y: 0 }; stray.speed = 0; stray.thinkCd = 0;
    for (let step = 0; step < ${CIVILIAN_STEPS}; step++) {
      updatePed(stray);
      if (insideLeftAt < 0 && !onIsland(stray)) insideLeftAt = step;
      else if (insideLeftAt >= 0 && onIsland(stray)) insideReentered = true;
    }
  }
  const soldierSpot = centreOf(gateStart.tx, gateStart.ty), soldier = makeSoldier(soldierSpot.x, soldierSpot.y);
  armyAlertT = 100000;
  player.x = soldierSpot.x + inward.x * 4 * T; player.y = soldierSpot.y + inward.y * 4 * T;
  let soldierReachedIsland = false;
  for (let step = 0; step < ${SOLDIER_STEPS} && !soldierReachedIsland; step++) { updatePed(soldier); soldierReachedIsland = onIsland(soldier); }
  armyAlertT = 0;
  return { starts: starts.length, calmIslandFrames, panicIslandFrames, insideTested: !!insideStart, insideLeftAt, insideReentered, soldierReachedIsland };
})()`;

for (const code of CODES) {
  console.log(code);
  const run = loadCity(code);
  run(CROSSING_HELPERS);
  if (!run('railCrossings.length')) { ok(false, `${code}: the rail has level crossings`); continue; }

  const hold = run(HOLD_CASES);
  ok(hold.approaching && hold.approachingOtherSide, `${code}: a car before the stop line heading for the rail is held while the train is near (both sides)`);
  ok(!hold.onRails && !hold.onRailEdge, `${code}: a car straddling the rails is never held`);
  ok(!hold.pastStopLine, `${code}: a car already past the stop line is not held`);
  ok(!hold.movingAway && !hold.clearedTrack, `${code}: a car moving away from the rail is not held`);
  ok(!hold.farTrainApproaching, `${code}: with the train far away the approaching car is not held`);

  run('var __crossingRoadStart = 200;');
  const setup = run(FIND_CROSSING_ROAD);
  ok(!!setup, `${code}: found a road edge running into a level crossing`);
  if (setup) {
    const fast = run(FAST_CAR_RUN(setup));
    ok(fast.startGap > fast.reach, `${code}: the fast car starts outside the hold reach (${fast.startGap.toFixed(0)} > ${fast.reach.toFixed(0)} px)`);
    ok(fast.closestGap > fast.stopOffset && fast.finalSpeed < 0.01,
      `${code}: a fast car (9 px/frame) brakes to a halt before the stop line (closest ${fast.closestGap.toFixed(1)} > ${fast.stopOffset} px, speed ${fast.finalSpeed.toFixed(2)})`);
    const onRails = run(CAR_ON_RAILS_RUN(setup));
    ok(onRails.farthestPast < -onRails.clearance, `${code}: a car caught on the rails drives on and clears the track (reached ${onRails.farthestPast.toFixed(0)} px)`);
  }

  if (!run('!!armyZone')) { ok(false, `${code}: the city has an army island`); continue; }
  const walkers = run(ISLAND_WALKERS);
  ok(walkers.starts >= 3, `${code}: civilians start beside the island bank on ${walkers.starts} sides`);
  ok(walkers.calmIslandFrames === 0, `${code}: strolling civilians beside the bank never step onto the island (${walkers.calmIslandFrames} frames)`);
  ok(walkers.panicIslandFrames === 0, `${code}: panicking civilians running at the bank never step onto the island (${walkers.panicIslandFrames} frames)`);
  ok(walkers.insideTested && walkers.insideLeftAt >= 0 && !walkers.insideReentered,
    `${code}: a civilian stranded on the island bank walks off it and stays off (left at frame ${walkers.insideLeftAt})`);
  ok(walkers.soldierReachedIsland, `${code}: a soldier still walks onto the island`);
}

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
