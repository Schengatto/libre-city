import vm from 'node:vm';
import { readSource, extractTopLevel } from './render-test-kit.mjs';
import runtime from './sim-runtime.js';

const { createRoomSim } = runtime;
const ENTER_EXIT_BUTTON = 4;
const HORN_BUTTON = 8;
const HORN_EFFECT = 4;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

function driverInCar(code) {
  const sim = createRoomSim(code);
  const driverId = sim.addPlayer('Driver', 0);
  const driver = sim._player(driverId);
  sim.tick();
  const car = sim._cars().find(c => c.role === 'traffic' || c.role === 'parked');
  driver.x = car.x; driver.y = car.y;
  sim.applyInput(driverId, { b: ENTER_EXIT_BUTTON });
  sim.tick();
  return { sim, driverId, driver };
}

function hornEffects(sim, driverId) {
  sim.clearFx();
  sim.applyInput(driverId, { b: HORN_BUTTON });
  sim.tick();
  return sim.snapshotFor(driverId).fx.filter(effect => effect.k === HORN_EFFECT);
}

function testHornEffectFromSim() {
  const { sim, driverId, driver } = driverInCar('HORN01');
  ok(!!driver.car, 'driver is in a car');
  if (!driver.car) return;
  const effects = hornEffects(sim, driverId);
  ok(effects.length === 1, 'horn press emits one horn effect');
  const [effect] = effects;
  ok(effect && effect.f === (driver.car.hornF | 0) && effect.h === (driver.car.hornKind || 'car'), 'horn effect carries the vehicle voice');
  ok(effect && Math.abs(effect.x - driver.car.x) < 1 && Math.abs(effect.y - driver.car.y) < 1, 'horn effect sits at the car position');
}

function testSirenVehicleTogglesSiren() {
  const { sim, driverId, driver } = driverInCar('HORN02');
  if (!driver.car) { ok(false, 'driver is in a car'); return; }
  driver.car.wasPolice = true;
  const sirenBefore = !!driver.car.sirenOn;
  const effects = hornEffects(sim, driverId);
  ok(effects.length === 0, 'siren vehicle emits no horn effect');
  ok(!!driver.car.sirenOn !== sirenBefore, 'siren vehicle toggles its siren');
}

function testClientPlaysHorn() {
  const calls = [];
  const sandbox = {
    net: { myId: 'me', predictedShots: [] },
    hear: (x, y, range) => ({ v: 0.5, pan: 0, x, y, range }),
    sfx: { horn: (h, voice) => calls.push({ h, voice }) },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(extractTopLevel(readSource('net.js'), 'netApplyFx') + '\n;globalThis.netApplyFx = netApplyFx;', context);
  context.netApplyFx({ k: HORN_EFFECT, x: 10, y: 20, f: 175, h: 'truck' });
  ok(calls.length === 1, 'client plays the horn effect');
  ok(calls[0] && calls[0].h.x === 10 && calls[0].h.y === 20, 'client hears the horn from the effect position');
  ok(calls[0] && calls[0].voice.hornF === 175 && calls[0].voice.hornKind === 'truck', 'client uses the vehicle voice');
}

testHornEffectFromSim();
testSirenVehicleTogglesSiren();
testClientPlaysHorn();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
