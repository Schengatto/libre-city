import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import runtime from './sim-runtime.js';
import stubs from '../js/sim-stubs.js';
import { readSource, extractTopLevel, createRecordingContext } from './render-test-kit.mjs';
const { BUNDLE } = runtime;
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };
function loadSim(code = 'PVEH01') {
  const context = vm.createContext(stubs.makeSimStubs(code, 900, { setTimeout, clearTimeout, setInterval, clearInterval }));
  vm.runInContext(BUNDLE, context, { timeout: 5000 });
  return { context, run: expr => vm.runInContext(expr, context) };
}

const { run } = loadSim();
const PI = Math.PI;

const zoneOf = (carAngle, impactAngle) => run(`dentZone({ angle: ${carAngle} }, ${impactAngle})`);
const FRONT = run('DENT_ZONE.front'), REAR = run('DENT_ZONE.rear'), LEFT = run('DENT_ZONE.left'), RIGHT = run('DENT_ZONE.right');
ok(zoneOf(0, PI) === FRONT && zoneOf(0, 0) === REAR && zoneOf(0, PI / 2) === LEFT && zoneOf(0, -PI / 2) === RIGHT, 'zone from impact angle, car facing 0');
ok(zoneOf(PI / 2, -PI / 2) === FRONT, 'zone follows the car heading');
ok(zoneOf(0, PI + (PI / 4 - 0.01)) === FRONT, 'just inside the front arc');
ok(zoneOf(0, PI + (PI / 4 + 0.01)) === RIGHT, 'just past the front arc towards the right');
ok(zoneOf(0, PI - (PI / 4 + 0.01)) === LEFT, 'just past the front arc towards the left');
ok(zoneOf(0, PI + (3 * PI / 4 + 0.01)) === REAR, 'just inside the rear arc');

const levels = run(`(() => {
  const c = makeCar(0, 0, 'traffic');
  const frontLevel = () => dentLevel(c.dents || 0, DENT_ZONE.front);
  const steps = [];
  addDent(c, 7, Math.PI); steps.push(frontLevel());
  addDent(c, 1, Math.PI); steps.push(frontLevel());
  addDent(c, 16, Math.PI); steps.push(frontLevel());
  addDent(c, 24, Math.PI); steps.push(frontLevel());
  addDent(c, 452, Math.PI); steps.push(frontLevel());
  return { steps, others: [DENT_ZONE.rear, DENT_ZONE.left, DENT_ZONE.right].map(zone => dentLevel(c.dents, zone)) };
})()`);
ok(JSON.stringify(levels.steps) === '[0,1,2,3,3]', `levels grow at 8, 24, 48 and cap at 3 (${levels.steps})`);
ok(levels.others.every(level => level === 0), 'other zones stay clean');

const packed = run(`(() => {
  const c = makeCar(0, 0, 'traffic');
  addDent(c, 60, Math.PI); addDent(c, 9, 0); addDent(c, 30, Math.PI / 2); addDent(c, 3, -Math.PI / 2);
  return { dents: c.dents, levels: [0, 1, 2, 3].map(zone => dentLevel(c.dents, zone)) };
})()`);
ok(packed.dents === (3 | 1 << 2 | 2 << 4), `dent bits pack as front 3, rear 1, left 2, right 0 (${packed.dents})`);
ok(JSON.stringify(packed.levels) === '[3,1,2,0]', `dentLevel reads each zone (${packed.levels})`);

const ignored = run(`(() => {
  const bike = makeMoto(makeCar(0, 0, 'traffic'));
  const tank = makeCar(0, 0, 'traffic'); tank.isTank = true;
  const plain = makeCar(0, 0, 'traffic');
  const noDirection = makeCar(0, 0, 'traffic');
  const notANumber = makeCar(0, 0, 'traffic');
  const nonFiniteDamage = makeCar(0, 0, 'traffic');
  addDent(bike, 50, Math.PI); addDent(tank, 50, Math.PI); addDent(plain, 50, undefined);
  addDent(noDirection, 50, undefined); addDent(notANumber, 50, NaN);
  addDent(nonFiniteDamage, NaN, Math.PI);
  return [bike, tank, plain, noDirection, notANumber, nonFiniteDamage].map(c => !c.dents);
})()`);
ok(ignored.every(Boolean), 'no dents on bikes, tanks or without a finite direction');

const struck = run(`(() => {
  const c = makeCar(0, 0, 'traffic');
  c.angle = 0;
  damageCar(c, 30, 0);
  return { rear: dentLevel(c.dents, DENT_ZONE.rear), front: dentLevel(c.dents, DENT_ZONE.front), health: c.health };
})()`);
ok(struck.rear === 2 && struck.front === 0 && struck.health === 70, `damageCar dents the struck side (${JSON.stringify(struck)})`);

const netSource = readSource('net.js');
const networkDecoder = loadSim('PVEH06');
vm.runInContext([
  'function interpFeed() {}',
  'var net = { looseCars: new Map() };',
  ...['netApplyCar', 'netMakeWorldCar', 'carNetPayload', 'netParkCar'].map(name => extractTopLevel(netSource, name)),
].join('\n'), networkDecoder.context);
const networked = networkDecoder.run(`(() => {
  const wire = value => JSON.parse(JSON.stringify(value));
  const saloon = makeCar(0, 0, 'traffic');
  const bus = makeBus(makeCar(0, 0, 'traffic'));
  addDent(bus, 30, Math.PI); addDent(bus, 10, Math.PI / 2);
  const worldBus = netMakeWorldCar(wire(carPayload(bus)));
  const decodedDents = worldBus.dents;
  netApplyCar(worldBus, wire(carPayload(saloon)));
  bus.netId = 5; saloon.netId = 6;
  const parkedBus = { ...wire(carNetPayload(bus)), cid: 9 };
  netParkCar(1, parkedBus);
  const localPayload = carNetPayload(saloon);
  return {
    saloonJson: JSON.stringify(carPayload(saloon)),
    localSaloonJson: JSON.stringify(localPayload),
    busDents: bus.dents, decodedDents, resetDents: worldBus.dents,
    localBusDents: carNetPayload(bus).dn, parkedDents: net.looseCars.get(9).dents,
  };
})()`);
ok(!networked.saloonJson.includes('"dn"') && !networked.localSaloonJson.includes('"dn"'), 'dn omitted when undamaged');
ok(networked.busDents === (2 | 1 << 4) && networked.decodedDents === networked.busDents, `dn round trip (${networked.decodedDents})`);
ok(networked.resetDents === 0, 'an undamaged payload resets decoded dents to 0');
ok(networked.localBusDents === networked.busDents, 'carNetPayload carries dn');
ok(networked.parkedDents === networked.busDents, 'netParkCar decodes dn');
ok(extractTopLevel(netSource, 'netReconcileMe').includes('me.car.dn'), 'netReconcileMe copies me.car.dn');
ok(extractTopLevel(netSource, 'netApplyRemote').includes('m.c.dn'), 'netApplyRemote decodes m.c.dn');

function splitTopLevelArguments(text) {
  const parts = [];
  let depth = 0, current = '';
  for (const character of text) {
    if ('([{'.includes(character)) depth++;
    if (')]}'.includes(character)) depth--;
    if (character === ',' && depth === 0) { parts.push(current.trim()); current = ''; } else current += character;
  }
  parts.push(current.trim());
  return parts;
}
function findDamageCarCalls(source) {
  const calls = [];
  const pattern = /(?<!function )\bdamageCar\(/g;
  let match;
  while ((match = pattern.exec(source))) {
    let depth = 1, index = match.index + match[0].length;
    const start = index;
    while (depth > 0 && index < source.length) {
      if (source[index] === '(') depth++;
      if (source[index] === ')') depth--;
      index++;
    }
    calls.push(splitTopLevelArguments(source.slice(start, index - 1)));
  }
  return calls;
}
const callFiles = fs.readdirSync(path.join(import.meta.dirname, '..', 'js')).filter(file => file.endsWith('.js'));
let callCount = 0;
const undirectedCalls = [];
for (const file of callFiles) {
  for (const args of findDamageCarCalls(readSource(file))) {
    callCount++;
    if (args.length < 3 || args[2] === 'undefined') undirectedCalls.push(`${file}: damageCar(${args.join(', ')})`);
  }
}
ok(callCount >= 9 && undirectedCalls.length === 0, `every damageCar call passes a direction (${callCount} calls) ${undirectedCalls.join(' | ')}`);

const renderSource = readSource('render.js');
const gameplaySource = readSource('gameplay.js');
function loadDentRenderer() {
  const recorder = createRecordingContext();
  const context = vm.createContext({
    ctx: recorder.context, camX: 0, camY: 0, frame: 0, player: { shirt: '#123456' }, Math,
    t: key => key, playerSirenOn: () => false, drawVehicleShadow: () => {}, drawCarFlames: () => {}, drawBike: () => {}, drawTank: () => {},
  });
  const renderNames = ['shade', 'roundRect', 'bodyPaint', 'drawTyres', 'drawGlassGlint', 'GLASS_COLOR', 'fillPolygon', 'tracePolygon',
    'drawSaloonCabin', 'drawVanCabin', 'drawBusCabin', 'drawLorryCabin', 'drawSpiderCockpit', 'drawCarLights', 'BRAKE_DECELERATION', 'DENT_NOTCH_POINTS', 'DENT_DEPTH_PER_LEVEL', 'DENT_CORNER_RADIUS', 'drawCarDents', 'drawCar'];
  const declarations = [
    ...['TAU', 'hashStr'].map(name => extractTopLevel(readSource('core.js'), name)),
    ...['DENT_ZONE', 'dentLevel'].map(name => extractTopLevel(gameplaySource, name)),
    ...renderNames.map(name => extractTopLevel(renderSource, name)),
  ];
  const wrapper = '{ const original = drawCarDents; drawCarDents = function (...args) { dentRuns++; return original(...args); }; }';
  vm.runInContext(['var dentRuns = 0;', ...declarations, wrapper].join('\n'), context);
  const record = expression => {
    recorder.calls.length = 0;
    vm.runInContext('dentRuns = 0', context);
    vm.runInContext(expression, context);
    return { calls: recorder.calls.map(([name, args]) => [name, args]), dentRuns: vm.runInContext('dentRuns', context) };
  };
  return {
    dents: (car, hw = 23, hh = 12) => { context.car = car; return record(`drawCarDents(car, ${hw}, ${hh})`); },
    drawCar: car => { context.car = car; return record('drawCar(car)'); },
  };
}
const dentRenderer = loadDentRenderer();
const HALF_WIDTH = 23, HALF_HEIGHT = 12, DEPTH_BOUND = 3 * 2.5;
const dentSaloon = (zoneLevels, extra = {}) => ({
  id: 3, x: 0, y: 0, angle: 0, speed: 0, role: 'parked', driver: null, color: '#2f7bd6', livery: null, w: 46, h: 24,
  dents: zoneLevels.reduce((packed, [zone, level]) => packed | (level << (2 * zone)), 0), ...extra,
});
const pathPoints = calls => calls.filter(([name]) => name === 'moveTo' || name === 'lineTo').map(([, args]) => args);
const countCalls = (calls, wanted) => calls.filter(([name]) => name === wanted).length;

const undamaged = dentRenderer.dents(dentSaloon([]));
ok(undamaged.calls.length === 0, 'no dent artwork when undamaged');
const frontOne = dentRenderer.dents(dentSaloon([[FRONT, 1]]));
const frontOnePoints = pathPoints(frontOne.calls);
ok(countCalls(frontOne.calls, 'fill') >= 1 && frontOnePoints.length > 0 && frontOnePoints.every(([x]) => x >= HALF_WIDTH - DEPTH_BOUND),
  'front level 1 fills one notch on the front edge');
const rightThree = dentRenderer.dents(dentSaloon([[RIGHT, 3]]));
const rightThreePoints = pathPoints(rightThree.calls);
ok(countCalls(rightThree.calls, 'fill') >= 1 && rightThreePoints.every(([, y]) => y >= HALF_HEIGHT - DEPTH_BOUND), 'right level 3 fills one notch on the right edge');
const everyZone = dentRenderer.dents(dentSaloon([[FRONT, 1], [REAR, 2], [LEFT, 3], [RIGHT, 1]]));
ok(countCalls(everyZone.calls, 'fill') === 4, 'one notch per dented zone');
const innermostFront = calls => Math.min(...pathPoints(calls).map(([x]) => x));
ok(innermostFront(dentRenderer.dents(dentSaloon([[FRONT, 3]])).calls) < innermostFront(frontOne.calls), 'a higher level cuts deeper');
ok(JSON.stringify(dentRenderer.dents(dentSaloon([[LEFT, 2]])).calls) === JSON.stringify(dentRenderer.dents(dentSaloon([[LEFT, 2]])).calls), 'the same car records the same dent shape');
const sideNotchX = id => pathPoints(dentRenderer.dents(dentSaloon([[LEFT, 2]], { id })).calls).map(([x]) => x);
ok(JSON.stringify(sideNotchX(1)) !== JSON.stringify(sideNotchX(2)), 'side notches sit at a different offset on different cars');

const networkedSideNotchX = netId => pathPoints(dentRenderer.dents(dentSaloon([[LEFT, 2]], { id: undefined, netId })).calls).map(([x]) => x);
ok(JSON.stringify(networkedSideNotchX('me#4')) !== JSON.stringify(networkedSideNotchX('rival#9')), 'cars without a numeric id differ by netId');
ok(JSON.stringify(networkedSideNotchX('me#4')) === JSON.stringify(networkedSideNotchX('me#4')), 'a netId gives a stable notch');
const numericNetIdSideNotchX = netId => pathPoints(dentRenderer.dents(dentSaloon([[LEFT, 2]], { id: undefined, netId })).calls).map(([x]) => x);
ok(JSON.stringify(numericNetIdSideNotchX(5)) !== JSON.stringify(numericNetIdSideNotchX(6)), 'cars with a numeric netId differ by netId');
const sharedNotchX = (idOwner, netIdRival) => JSON.stringify(pathPoints(dentRenderer.dents(dentSaloon([[LEFT, 2]], { id: idOwner, netId: netIdRival })).calls));
ok(sharedNotchX(77, 5) === sharedNotchX(1, 5), 'netId wins over id so owner and rivals draw the same shape');
const flatHalfHeight = HALF_HEIGHT - 6;
const endNotchPoints = pathPoints(dentRenderer.dents(dentSaloon([[FRONT, 3], [REAR, 3]])).calls);
ok(endNotchPoints.length > 0 && endNotchPoints.every(([, y]) => Math.abs(y) <= flatHalfHeight + 1e-9), 'front and rear notches stay inside the rounded corners');

const bodies = {
  bus: { livery: 'bus', w: 88, h: 28 }, lorry: { livery: 'lorry', w: 76, h: 28, cargo: '#e6e2d8' },
  spider: { livery: 'spider', w: 42, h: 22 }, ambulance: { livery: 'ambulance', w: 50, h: 25 },
};
for (const [name, body] of Object.entries(bodies)) {
  const dented = dentRenderer.drawCar(dentSaloon([[FRONT, 2], [LEFT, 1]], body));
  const clean = dentRenderer.drawCar(dentSaloon([], body));
  ok(dented.dentRuns === 1 && countCalls(dented.calls, 'fill') > countCalls(clean.calls, 'fill'), `drawCar draws dents on a ${name}`);
}

const netCopContext = vm.createContext({ cars: [], dist: (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by), net: { myId: 'me', copSeq: 0, remoteCops: new Map() } });
vm.runInContext(['netCopPayloads', 'netApplyCops'].map(name => extractTopLevel(netSource, name)).join('\n'), netCopContext);
const copPayloadJson = patrol => {
  netCopContext.cars = [patrol];
  return vm.runInContext('JSON.stringify(netCopPayloads())', netCopContext);
};
const patrolCar = extra => ({ role: 'police', x: 10, y: 20, angle: 0, speed: 1, w: 46, h: 24, color: '#f2f4f8', ...extra });
ok(!JSON.parse(copPayloadJson(patrolCar({ dents: 0 })))[0].hasOwnProperty('dn'), 'an undamaged patrol car adds no dn');
ok(JSON.parse(copPayloadJson(patrolCar({ dents: 13 })))[0].dn === 13, 'a dented patrol car sends dn equal to its dents');
const applyCops = list => {
  netCopContext.list = list;
  vm.runInContext("netApplyCops('rival', list)", netCopContext);
  return netCopContext.net.remoteCops.get('r#c0');
};
const copWire = extra => [{ cid: 'r#c0', x: 10, y: 20, an: 0, sp: 1, w: 46, h: 24, col: '#f2f4f8', lp: 0, ...extra }];
ok(applyCops(copWire({ dn: 13 })).dents === 13, 'netApplyCops decodes dn onto the remote patrol car');
ok(applyCops(copWire({})).dents === 0, 'a later undamaged payload resets the remote patrol car dents');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
