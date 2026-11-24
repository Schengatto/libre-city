import vm from 'node:vm';
import runtime from './sim-runtime.js';
import stubs from '../js/sim-stubs.js';
import { readSource, extractTopLevel } from './render-test-kit.mjs';
const { BUNDLE } = runtime;
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };
function loadSim(code = 'PVEH01') {
  const context = vm.createContext(stubs.makeSimStubs(code, 900, { setTimeout, clearTimeout, setInterval, clearInterval }));
  vm.runInContext(BUNDLE, context, { timeout: 5000 });
  return { context, run: expr => vm.runInContext(expr, context) };
}

const { run } = loadSim();

const EXPECTED_PHYSICS = {
  makeBus:    { livery: 'bus',    w: 88, h: 28, colH: 15, mass: 3.0, accel: 0.05, top: 4.2, maxSpeed: 1.9, gears: 5, hornKind: 'truck', hornF: 150 },
  makeLorry:  { livery: 'lorry',  w: 76, h: 28, colH: 15, mass: 2.6, accel: 0.06, top: 4.5, maxSpeed: 2.0, gears: 5, hornKind: 'truck', hornF: 175 },
  makeSpider: { livery: 'spider', w: 42, h: 22, colH: 12, mass: 0.8, accel: 0.22, top: 7.5, maxSpeed: 3.3, gears: 5, hornKind: 'car',   hornF: 420 },
};
for (const [factory, expected] of Object.entries(EXPECTED_PHYSICS)) {
  const car = run(`${factory}(makeCar(0, 0, 'traffic'))`);
  const mismatches = Object.entries(expected).filter(([key, value]) => car[key] !== value);
  ok(mismatches.length === 0, `${factory} sets sizes and physics ${mismatches.map(([key]) => `${key}=${car[key]}`).join(' ')}`);
  ok(!car.isTaxi && !car.isBike, `${factory} is neither taxi nor bike`);
}
const spider = run(`makeSpider(makeCar(0, 0, 'traffic'))`);
ok(typeof spider.helmet === 'string' && typeof spider.riderShirt === 'string', 'spider has a helmet and rider shirt');
const lorry = run(`makeLorry(makeCar(0, 0, 'traffic'))`);
ok(lorry.cargo === '#e6e2d8', 'lorry carries a cargo colour');

const colHCases = [[false, 24, 13], [false, 26, 14], [false, 30, 16], [true, 12, 8], [false, 28, 15], [false, 22, 12], [false, 25, 13]];
ok(colHCases.every(([isBike, h, expected]) => run(`vehicleColH(${isBike}, ${h})`) === expected), 'vehicleColH keeps existing values');

const fleet = run(`(() => {
  const dummy = { x: 0, y: 0, angle: 0 };
  const vehicles = [
    makeCar(0, 0, 'traffic'),
    makeTaxi(makeCar(0, 0, 'traffic')),
    makeMoto(makeCar(0, 0, 'traffic')),
    makeBus(makeCar(0, 0, 'traffic')),
    makeLorry(makeCar(0, 0, 'traffic')),
    makeSpider(makeCar(0, 0, 'traffic')),
    makeArmyCar(0, 0),
  ];
  const serviceTypes = ['police', 'hospital', 'fire', 'bank', 'market', 'gunshop', 'army', 'pizzeria'];
  for (const type of serviceTypes) vehicles.push(makeServiceCar(type, dummy));
  return { sizes: vehicles.map(v => ({ w: v.w, h: v.h, colH: v.colH, expectedColH: vehicleColH(!!v.isBike, v.h) })), serviceTypeCount: serviceTypes.length };
})()`);
const maxW = run('VEHICLE_MAX_W'), maxH = run('VEHICLE_MAX_H');
ok(fleet.sizes.length === 7 + fleet.serviceTypeCount, `fleet built with every service type (${fleet.sizes.length} vehicles)`);
ok(fleet.sizes.every(s => s.w <= maxW && s.h <= maxH), 'every vehicle fits the max box');
ok(fleet.sizes.every(s => s.colH === s.expectedColH), 'every vehicle colH comes from vehicleColH');

const carReach = run('CAR_REACH');
ok(carReach >= Math.hypot(maxW, maxH) && carReach === 93, `CAR_REACH covers the largest pair (${carReach})`);

const mix = run(`(() => {
  const counts = { bus: 0, lorry: 0, spider: 0, taxi: 0, bike: 0, plain: 0 };
  let doubled = 0;
  const runs = 20000;
  for (let i = 0; i < runs; i++) {
    const c = dressTrafficCar(makeCar(0, 0, 'traffic'));
    const kinds = [c.livery === 'bus', c.livery === 'lorry', c.livery === 'spider', !!c.isTaxi, !!c.isBike];
    const matched = kinds.filter(Boolean).length;
    if (matched > 1) doubled++;
    if (c.livery === 'bus') counts.bus++;
    else if (c.livery === 'lorry') counts.lorry++;
    else if (c.livery === 'spider') counts.spider++;
    else if (c.isTaxi) counts.taxi++;
    else if (c.isBike) counts.bike++;
    else counts.plain++;
  }
  return { counts, doubled, runs };
})()`);
const share = kind => mix.counts[kind] / mix.runs;
ok(share('bus') >= 0.03 && share('bus') <= 0.05, `bus share ${share('bus').toFixed(4)} in [0.03, 0.05]`);
ok(share('lorry') >= 0.05 && share('lorry') <= 0.07, `lorry share ${share('lorry').toFixed(4)} in [0.05, 0.07]`);
ok(share('spider') >= 0.012 && share('spider') <= 0.028, `spider share ${share('spider').toFixed(4)} in [0.012, 0.028]`);
ok(mix.counts.taxi > 0 && mix.counts.bike > 0, 'taxis and bikes still appear in the mix');
ok(mix.doubled === 0, 'no car carries two vehicle types');

const spacing = loadSim('PVEH02').run(`(() => {
  cars.length = 0;
  dressTrafficCar = c => makeBus(c);
  const mapCentreX = WORLD_W / 2, mapCentreY = WORLD_H / 2;
  for (let attempt = 0; attempt < 600 && cars.length < 60; attempt++) {
    const c = spawnTrafficNear(mapCentreX, mapCentreY, 0, WORLD_W);
    if (c) cars.push(c);
  }
  const placed = cars.filter(c => c.role !== 'parked');
  let tooClose = 0;
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i], b = placed[j];
      if (dist(a.x, a.y, b.x, b.y) <= (a.w + b.w) / 2 + 24 - 0.001) tooClose++;
    }
  }
  return { count: placed.length, tooClose };
})()`);
ok(spacing.count >= 20, `spacing test spawned buses (${spacing.count})`);
ok(spacing.tooClose === 0, `spawn spacing respects length (${spacing.tooClose} close pairs)`);

const netSource = readSource('net.js');
const clientDecoder = loadSim('PVEH03');
vm.runInContext(['function interpFeed() {}', extractTopLevel(netSource, 'netApplyCar'), extractTopLevel(netSource, 'netMakeWorldCar')].join('\n'), clientDecoder.context);
const decoded = clientDecoder.run(`(() => {
  const roundTrip = car => netMakeWorldCar(JSON.parse(JSON.stringify(carPayload(car))));
  const build = {
    saloon: () => makeCar(0, 0, 'traffic'),
    bike: () => makeMoto(makeCar(0, 0, 'traffic')),
    bus: () => makeBus(makeCar(0, 0, 'traffic')),
    lorry: () => makeLorry(makeCar(0, 0, 'traffic')),
    spider: () => makeSpider(makeCar(0, 0, 'traffic')),
    tank: () => makeServiceCar('army', { x: 0, y: 0, angle: 0 }),
  };
  return Object.fromEntries(Object.entries(build).map(([kind, make]) => {
    const car = make(), worldCar = roundTrip(car);
    return [kind, { colH: car.colH, worldColH: worldCar.colH, w: car.w, worldW: worldCar.w, h: car.h, worldH: worldCar.h, livery: car.livery || null, worldLivery: worldCar.livery }];
  }));
})()`);
for (const [kind, d] of Object.entries(decoded)) {
  ok(d.worldColH === d.colH && d.worldW === d.w && d.worldH === d.h && d.worldLivery === d.livery, `world car colH from h: ${kind} (${d.worldColH})`);
}
ok(decoded.saloon.worldColH === 13 && decoded.bike.worldColH === 8, 'world car colH keeps saloon 13 and bike 8');

const parkDecoder = loadSim('PVEH05');
vm.runInContext(['var net = { looseCars: new Map() };', extractTopLevel(netSource, 'netParkCar')].join('\n'), parkDecoder.context);
const parkedBus = parkDecoder.run(`(() => {
  const payload = car => JSON.parse(JSON.stringify(carPayload(car)));
  const bus = payload(makeBus(makeCar(0, 0, 'traffic')));
  bus.cid = 41;
  netParkCar(3, bus);
  const created = net.looseCars.get(41);
  const createdColH = created.colH, createdLivery = created.livery;
  const saloon = payload(makeCar(0, 0, 'traffic'));
  saloon.cid = 41;
  netParkCar(3, saloon);
  return { createdColH, createdLivery, refreshedColH: net.looseCars.get(41).colH };
})()`);
ok(parkedBus.createdColH === 15 && parkedBus.createdLivery === 'bus', `netParkCar derives bus colH (${parkedBus.createdColH})`);
ok(parkedBus.refreshedColH === 13, `netParkCar refreshes colH when the shape changes (${parkedBus.refreshedColH})`);

const remoteDecoder = loadSim('PVEH04');
vm.runInContext(['var net = { players: new Map([[7, { shirt: "#fff" }]]), looseCars: new Map() };', 'function netApplyCops() {}', extractTopLevel(netSource, 'netApplyRemote')].join('\n'), remoteDecoder.context);
const remoteCarColH = remoteDecoder.run(`(() => {
  const message = car => ({ t: 's', x: 0, y: 0, a: 0, hp: 100, c: JSON.parse(JSON.stringify(carPayload(car))) });
  const colHAfter = car => { netApplyRemote(7, message(car)); return net.players.get(7).car.colH; };
  return {
    saloon: colHAfter(makeCar(0, 0, 'traffic')),
    bus: colHAfter(makeBus(makeCar(0, 0, 'traffic'))),
    bike: colHAfter(makeMoto(makeCar(0, 0, 'traffic'))),
  };
})()`);
ok(remoteCarColH.saloon === 13 && remoteCarColH.bus === 15 && remoteCarColH.bike === 8, `remote player car colH follows vehicle change (${JSON.stringify(remoteCarColH)})`);
ok(!extractTopLevel(netSource, 'netApplyRemote').includes('colH: 13'), 'netApplyRemote has no fixed colH');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
