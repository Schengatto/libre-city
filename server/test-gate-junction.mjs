import vm from 'node:vm';
import runtime from './sim-runtime.js';
import stubs from '../js/sim-stubs.js';
import { readSource, extractTopLevel } from './render-test-kit.mjs';
const { BUNDLE } = runtime;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const SEEDS_PER_SIZE = 30;
const CODES = ['P', 'M', 'G'].flatMap(size => Array.from({ length: SEEDS_PER_SIZE }, (_, k) => `${size}JOG${k}`));
const LEAVING_CARS_PER_SEED = 200;
const DRAW_TRAFFIC_LIGHTS = extractTopLevel(readSource('render.js'), 'drawTrafficLights');

function loadCity(code) {
  const sandbox = stubs.makeSimStubs(code, 900, { setTimeout, clearTimeout, setInterval, clearInterval });
  const context = vm.createContext(sandbox);
  vm.runInContext(BUNDLE, context, { timeout: 10000 });
  return expr => vm.runInContext(expr, context);
}

const INSPECT_JOG = `(() => {
  const jogIndex = nodes.findIndex(node => node.sharesSignalOf !== undefined);
  if (jogIndex < 0) return null;
  const jog = nodes[jogIndex], streetIndex = jog.sharesSignalOf, street = nodes[streetIndex];
  const stubIndex = jog.edges.find(ei => edges[ei].a === streetIndex || edges[ei].b === streetIndex);
  const approachIndex = jog.edges.find(ei => ei !== stubIndex);
  const stub = edges[stubIndex];
  const stubTowardsStreet = stub.b === streetIndex ? 1 : -1;
  const arrivalDir = { x: (street.x - jog.x) / stub.len, y: (street.y - jog.y) / stub.len };

  let uTurns = 0;
  for (let k = 0; k < ${LEAVING_CARS_PER_SEED}; k++) {
    const car = { edge: stubIndex, ed: stubTowardsStreet, t: stubTowardsStreet > 0 ? 1 : 0, dir: { ...arrivalDir } };
    enterNode(car, streetIndex);
    if (car.dir.x * arrivalDir.x + car.dir.y * arrivalDir.y < -0.99) uTurns++;
  }

  const approach = edges[approachIndex];
  const approachTowardsJog = approach.b === jogIndex ? 1 : -1;
  const leaving = { edge: approachIndex, ed: approachTowardsJog, t: approachTowardsJog > 0 ? 0.2 : 0.8 };
  railPlace(leaving);
  const leavingHorizontally = Math.abs(leaving.dir.x) >= Math.abs(leaving.dir.y);
  const savedH = greenH, savedV = greenV;
  greenH = !leavingHorizontally; greenV = leavingHorizontally;
  const stopOnRed = signalStop(leaving);
  greenH = leavingHorizontally; greenV = !leavingHorizontally;
  const stopOnGreen = signalStop(leaving);
  greenH = savedH; greenV = savedV;

  const headPositions = [];
  (function (camX, camY, vw, vh, signalHead) {
    ${DRAW_TRAFFIC_LIGHTS}
    drawTrafficLights();
  })(0, 0, Infinity, Infinity, (x, y) => headPositions.push({ x, y }));
  const nearJog = headPositions.filter(head => Math.hypot(head.x - jog.x, head.y - jog.y) <= HALF_ROAD).length;
  const nearStreet = headPositions.filter(head => Math.hypot(head.x - street.x, head.y - street.y) <= HALF_ROAD).length;
  const headsAtJunction = nearStreet + nearJog - headPositions.filter(head =>
    Math.hypot(head.x - jog.x, head.y - jog.y) <= HALF_ROAD && Math.hypot(head.x - street.x, head.y - street.y) <= HALF_ROAD).length;
  return { signalled: street.signal, jogSignal: jog.signal, uTurns, stopOnRed, stopOnGreen, headsAtJunction };
})()`;

let jogs = 0, signalledJogs = 0;
const uTurnSeeds = [], mismatchedSignal = [], ranTheLight = [], stoppedOnGreen = [], duplicateHeads = [];
for (const code of CODES) {
  const result = loadCity(code)(INSPECT_JOG);
  if (!result) continue;
  jogs++;
  if (result.uTurns) uTurnSeeds.push(`${code} (${result.uTurns}/${LEAVING_CARS_PER_SEED})`);
  if (result.jogSignal !== result.signalled) mismatchedSignal.push(code);
  if (!result.signalled) continue;
  signalledJogs++;
  if (!Number.isFinite(result.stopOnRed) || result.stopOnRed <= 0) ranTheLight.push(code);
  if (result.stopOnGreen !== Infinity) stoppedOnGreen.push(code);
  if (result.headsAtJunction !== 4) duplicateHeads.push(`${code} (${result.headsAtJunction} heads)`);
}

ok(jogs > 0, `at least one seed has a jog junction on the gate road (${jogs}/${CODES.length})`);
ok(signalledJogs > 0, `at least one jog junction sits at a traffic light (${signalledJogs})`);
ok(uTurnSeeds.length === 0, `cars leaving the island never U-turn at the street junction: ${uTurnSeeds.join(', ') || 'none'}`);
ok(mismatchedSignal.length === 0, `the jog node shares the street junction's traffic light: ${mismatchedSignal.join(', ') || 'all match'}`);
ok(ranTheLight.length === 0, `cars leaving the island stop on red before the gate junction: ${ranTheLight.join(', ') || 'all stop'}`);
ok(duplicateHeads.length === 0, `the gate junction draws one set of four light heads: ${duplicateHeads.join(', ') || 'all four'}`);
ok(stoppedOnGreen.length === 0, `cars leaving the island do not stop on green: ${stoppedOnGreen.join(', ') || 'none'}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
