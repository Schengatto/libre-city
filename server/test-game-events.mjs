import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import runtime from './sim-runtime.js';
import stubs from '../js/sim-stubs.js';

const { BUNDLE, JS_DIR } = runtime;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const loggedErrors = [];
const busContext = vm.createContext({ console: { error: (...args) => loggedErrors.push(args) } });
vm.runInContext('var matchElapsedFrames = 0;', busContext);
vm.runInContext(fs.readFileSync(path.join(JS_DIR, 'game-events.js'), 'utf8'), busContext);
const bus = expr => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, busContext));

console.log('1) bus: on, off, order, frame, enabled guard');
const busResult = bus(`(() => {
  const log = [];
  const first = e => log.push('first:' + e.value + ':' + e.frame);
  const second = e => log.push('second:' + e.value);
  gameEvents.on('t', first); gameEvents.on('t', second);
  gameEvents.emit('t', { value: 1 });
  gameEvents.enabled = true;
  matchElapsedFrames = 77;
  const payload = { value: 2 };
  gameEvents.emit('t', payload);
  gameEvents.off('t', first);
  gameEvents.emit('t', { value: 3 });
  gameEvents.emit('unknown', {});
  gameEvents.emit('t');
  return { log, payloadUntouched: !('frame' in payload) };
})()`);
ok(busResult.log.join('|') === 'first:2:77|second:2|second:3|second:undefined', `disabled no-op, registration order, frame injected, off removes (${busResult.log.join('|')})`);
ok(busResult.payloadUntouched, 'emit does not mutate the caller payload');

console.log('2) bus: throwing handler isolated, clear');
const isolation = bus(`(() => {
  const log = [];
  gameEvents.clear();
  gameEvents.on('x', () => { throw new Error('boom'); });
  gameEvents.on('x', e => log.push('after:' + e.frame));
  gameEvents.emit('x', {});
  gameEvents.clear();
  gameEvents.emit('x', {});
  return log;
})()`);
ok(isolation.join('|') === 'after:77', `later handler still runs after a throwing one, clear drops all (${isolation.join('|')})`);
ok(loggedErrors.length === 1, 'the throwing handler is reported once');

console.log('3) vehicleKindOf and victimKindOf');
const kindCases = [
  [{ isTank: true, livery: 'army' }, 'tank'], [{ livery: 'army' }, 'jeep'], [{ isDelivery: true, isBike: true }, 'delivery'],
  [{ isBike: true }, 'bike'], [{ isTaxi: true }, 'taxi'], [{ livery: 'ambulance' }, 'ambulance'], [{ livery: 'fire' }, 'fire'],
  [{ livery: 'armored' }, 'armored'], [{ livery: 'market' }, 'market'], [{ wasPolice: true }, 'police'],
  [{ role: 'police' }, 'police'], [{ role: 'traffic' }, 'car'], [{}, 'car'],
];
for (const [car, expected] of kindCases) ok(bus(`vehicleKindOf(${JSON.stringify(car)})`) === expected, `${JSON.stringify(car)} -> ${expected}`);
for (const [role, expected] of [['cop', 'cop'], ['soldier', 'soldier'], ['civ', 'civ'], ['robber', 'civ']])
  ok(bus(`victimKindOf({ role: '${role}' })`) === expected, `ped ${role} -> ${expected}`);

console.log('4) sim bundle: taxi ride, fail reasons, wanted:change');
const context = vm.createContext(stubs.makeSimStubs('GEVT0', 900, { setTimeout, clearTimeout, setInterval, clearInterval }));
vm.runInContext(BUNDLE, context, { timeout: 5000 });
const run = expr => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, context));

ok(run('gameEvents.enabled') === false, 'bus is disabled by default in the sim bundle');

const ride = run(`(() => {
  const log = [];
  for (const type of ['job:pickup', 'job:start', 'job:complete', 'job:fail'])
    gameEvents.on(type, e => log.push({ type, ...e }));
  gameEvents.enabled = true;
  matchElapsedFrames = 500;
  const fare = makePed(player.x + 30, player.y, 'fare');
  peds.push(fare);
  taxi.phase = 'pickup'; taxi.fare = fare;
  player.car = { x: player.x, y: player.y, angle: 0, isTaxi: true };
  startRide();
  const started = { pay: taxi.pay, timer0: taxi.timer0, legDistance: taxi.legDistance, dest: { x: taxi.dest.x, y: taxi.dest.y } };
  taxi.timer = 100;
  completeRide();
  return { log, started };
})()`);
const [pickup, start, complete] = ride.log;
ok(ride.log.length === 3 && pickup.type === 'job:pickup' && start.type === 'job:start' && complete.type === 'job:complete', 'startRide + completeRide emit pickup, start, complete in order');
ok(pickup.job === 'taxi' && pickup.x === ride.started.dest.x && pickup.y === ride.started.dest.y && pickup.frame === 500, 'job:pickup carries job, destination and frame');
ok(start.pay === ride.started.pay && start.timerTotal === ride.started.timer0 && start.timerTotal > 240, 'job:start carries pay and timerTotal = timer0');
ok(complete.pay === ride.started.pay && complete.tip === Math.ceil(ride.started.pay * 0.5 / 5) * 5 && complete.timerLeft === 100
  && complete.timerTotal === ride.started.timer0 && complete.distance === ride.started.legDistance && complete.x === ride.started.dest.x,
  'job:complete carries pay, tip, timerLeft, timerTotal, distance and destination');

const fails = run(`(() => {
  const log = [];
  gameEvents.clear();
  gameEvents.on('job:fail', e => log.push({ job: e.job, reason: e.reason }));
  taxi.phase = 'ride'; taxi.dest = { x: 0, y: 0 };
  cancelTaxi('taxi.abandon', 'abandon');
  taxi.phase = 'pickup';
  cancelTaxi();
  cancelTaxi(null, 'toggle');
  pizza.phase = 'pickup'; pizza.client = null;
  cancelPizza('pizza.lost', 'lost');
  patrol.phase = 'chase';
  cancelPatrol('patrol.escaped', 'escaped');
  firejob.phase = 'extinguish';
  cancelFirejob('fire.late', 'late');
  rescue.phase = 'deliver';
  cancelRescue(null, 'down');
  return log;
})()`);
ok(JSON.stringify(fails) === JSON.stringify([
  { job: 'taxi', reason: 'abandon' }, { job: 'pizza', reason: 'lost' }, { job: 'patrol', reason: 'escaped' },
  { job: 'fire', reason: 'late' }, { job: 'ambulance', reason: 'down' },
]), `cancel with a reason emits job:fail, a system cancel or an idle job emits nothing (${JSON.stringify(fails)})`);

const wanted = run(`(() => {
  const log = [];
  gameEvents.clear();
  gameEvents.on('wanted:change', e => log.push({ from: e.from, to: e.to }));
  policeOn = true; wanted = 0; wantedHeat = 0;
  commitCrime(1.2);
  commitCrime(0.1);
  return log;
})()`);
ok(JSON.stringify(wanted) === '[{"from":0,"to":1}]', `commitCrime(1.2) emits wanted:change 0 -> 1 once (${JSON.stringify(wanted)})`);

const disabled = run(`(() => {
  const log = [];
  gameEvents.clear();
  gameEvents.on('wanted:change', e => log.push(e));
  gameEvents.enabled = false;
  wanted = 0; wantedHeat = 0;
  commitCrime(1.2);
  return log.length;
})()`);
ok(disabled === 0, 'no events while the bus is disabled (multiplayer and sim)');

console.log('5) wiring guards');
const read = relative => fs.readFileSync(path.join(rootDir, relative), 'utf8');
const html = read('index.html');
ok(html.indexOf('js/game-events.js') > 0 && html.indexOf('js/game-events.js') < html.indexOf('js/missions.js'), 'index.html loads game-events.js before missions.js');
ok(read('js/sim-worker.js').includes("'game-events.js', 'missions.js'"), 'sim-worker script list includes game-events.js before missions.js');
ok(runtime.SIM_FILES.indexOf('game-events.js') > 0 && runtime.SIM_FILES.indexOf('game-events.js') < runtime.SIM_FILES.indexOf('missions.js'), 'SIM_FILES includes game-events.js before missions.js');
ok(read('js/ui.js').includes('gameEvents.enabled = !netActive();'), 'startMatch enables the bus for single player only');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
