import vm from 'node:vm';
import runtime from './sim-runtime.js';
import stubs from '../js/sim-stubs.js';
import { readSource, extractTopLevel } from './render-test-kit.mjs';
const { BUNDLE } = runtime;
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };
function loadSim(code = 'PSNAP01') {
  const context = vm.createContext(stubs.makeSimStubs(code, 900, { setTimeout, clearTimeout, setInterval, clearInterval }));
  vm.runInContext(BUNDLE, context, { timeout: 5000 });
  return { context, run: expr => vm.runInContext(expr, context) };
}

const host = loadSim('PSNAP01');
const snap = JSON.parse(host.run(`(() => {
  __sim.addPlayer('Ann', 0, 'pA');
  __sim.addPlayer('Bob', 1, 'pB');
  const playerA = playerById('pA'), playerB = playerById('pB');
  playerB.x = playerA.x; playerB.y = playerA.y;
  const equip = (player, angle, aim) => {
    const car = makeSpider(makeCar(player.x, player.y, 'traffic'));
    car.driver = 'player';
    car.angle = angle;
    player.car = car;
    player.aim = aim;
  };
  equip(playerA, 7.123456, 2.345678);
  equip(playerB, -1.987654, -0.004999);
  return JSON.stringify(__sim.snapshotFor('pA'));
})()`));

const physicsKeys = ['top', 'acc', 'mass', 'gears'];
ok(snap.me.car.top === 7.5 && snap.me.car.acc === 0.22 && snap.me.car.mass === 0.8 && snap.me.car.gears === 5, 'own car carries driving physics');
ok(snap.cars.length > 0, 'the AOI holds world cars');
ok(snap.cars.every(c => physicsKeys.every(k => !(k in c))), 'world cars carry no driving physics');
ok(snap.players.length === 1 && snap.players.every(p => !p.car || physicsKeys.every(k => !(k in p.car))), 'remote player cars carry no driving physics');
ok(snap.me.car.an === 7.12, 'own car angle rounded to 0.01 without wrapping');
ok(snap.players[0].car.an === -1.99, 'remote car angle rounded to 0.01');
ok(snap.me.aim === 2.35 && snap.players[0].aim === 0, 'aim rounded to 0.01');
const quantized = v => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9;
ok(snap.cars.every(c => quantized(c.an)), 'every world car angle is quantized');

const netSource = readSource('net.js');
const client = loadSim('PSNAP02');
vm.runInContext(['function interpFeed() {}', extractTopLevel(netSource, 'netApplyCar'), extractTopLevel(netSource, 'netMakeWorldCar'), extractTopLevel(netSource, 'netMakePlayerCar')].join('\n'), client.context);
client.context.__payload = snap.me.car;
const predicted = client.run(`(() => {
  const car = netMakePlayerCar(__payload);
  return { top: car.top, accel: car.accel, mass: car.mass, gears: car.gears };
})()`);
ok(predicted.top === 7.5 && predicted.accel === 0.22 && predicted.mass === 0.8 && predicted.gears === 5, 'client prediction gets the real physics, not the defaults');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
