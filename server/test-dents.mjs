import vm from 'node:vm';
import runtime from './sim-runtime.js';
import stubs from '../js/sim-stubs.js';
import { readSource } from './render-test-kit.mjs';
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
  addDent(bike, 50, Math.PI); addDent(tank, 50, Math.PI); addDent(plain, 50, undefined);
  addDent(noDirection, 50, undefined); addDent(notANumber, 50, NaN);
  return [bike, tank, plain, noDirection, notANumber].map(c => !c.dents);
})()`);
ok(ignored.every(Boolean), 'no dents on bikes, tanks or without a finite direction');

const struck = run(`(() => {
  const c = makeCar(0, 0, 'traffic');
  c.angle = 0;
  damageCar(c, 30, 0);
  return { rear: dentLevel(c.dents, DENT_ZONE.rear), front: dentLevel(c.dents, DENT_ZONE.front), health: c.health };
})()`);
ok(struck.rear === 2 && struck.front === 0 && struck.health === 70, `damageCar dents the struck side (${JSON.stringify(struck)})`);

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
const callFiles = ['gameplay.js', 'army.js', 'train.js', 'server-sim-glue.js', 'missions.js', 'input.js', 'net.js'];
let callCount = 0;
const undirectedCalls = [];
for (const file of callFiles) {
  for (const args of findDamageCarCalls(readSource(file))) {
    callCount++;
    if (args.length < 3 || args[2] === 'undefined') undirectedCalls.push(`${file}: damageCar(${args.join(', ')})`);
  }
}
ok(callCount >= 9 && undirectedCalls.length === 0, `every damageCar call passes a direction (${callCount} calls) ${undirectedCalls.join(' | ')}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
