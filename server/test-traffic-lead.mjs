import vm from 'node:vm';
import { readSource, extractTopLevel } from './render-test-kit.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };
const near = (actual, expected, tolerance = 1e-6) => Math.abs(actual - expected) <= tolerance;

const NAMES = [
  'NET_SIM_FRAME_MS', 'NET_TRAFFIC_LEAD_MAX_MS', 'NET_TRAFFIC_LEAD_EASE', 'NET_TRAFFIC_STILL_SPEED',
  'netTrafficLeadFrames', 'netTrafficCollider', 'netSolidCars',
];
const netSource = readSource('net.js');
const context = vm.createContext({});
vm.runInContext('var net;\n' + NAMES.map(name => extractTopLevel(netSource, name)).join('\n') +
  '\n;globalThis.api = { ' + NAMES.join(', ') + ', setNet: value => { net = value; } };', context);
const api = context.api;

const makeCar = (x, y, angle, speed) => ({ x, y, angle, speed, kvx: 0, kvy: 0, w: 46, h: 24, mass: 1 });
const settle = (car, leadFrames, frames = 60) => { let collider; for (let i = 0; i < frames; i++) collider = api.netTrafficCollider(car, leadFrames); return collider; };

console.log('1) lead time covers the render delay plus one-way latency, bounded');
ok(near(api.netTrafficLeadFrames({ rtt: null, interpDelay: 50 }), 50 / api.NET_SIM_FRAME_MS), 'without RTT the lead is the render delay alone');
ok(near(api.netTrafficLeadFrames({ rtt: 100, interpDelay: 50 }), 100 / api.NET_SIM_FRAME_MS), 'lead adds half the RTT');
ok(near(api.netTrafficLeadFrames({ rtt: 2000, interpDelay: 150 }), api.NET_TRAFFIC_LEAD_MAX_MS / api.NET_SIM_FRAME_MS), 'lead is capped on a laggy link');

console.log('2) a moving car collides where it is now, the drawn car is untouched');
const eastbound = makeCar(100, 200, 0, 5);
const collider = settle(eastbound, 6);
ok(near(collider.x, 130, 1e-3) && near(collider.y, 200, 1e-3), `collider settles 5 px/frame x 6 frames ahead (at ${collider.x.toFixed(2)}, ${collider.y.toFixed(2)})`);
ok(eastbound.x === 100 && eastbound.y === 200, 'interpolated car position used for drawing is not moved');
ok(collider !== eastbound && api.netTrafficCollider(eastbound, 6) === collider, 'one collider object per car, reused every frame');
ok(collider.angle === 0 && collider.speed === 5 && collider.w === 46 && collider.h === 24 && collider.mass === 1, 'collider carries the box and velocity the hit response reads');

const northbound = settle(makeCar(0, 0, -Math.PI / 2, 4), 5);
ok(near(northbound.x, 0, 1e-3) && near(northbound.y, -20, 1e-3), 'lead follows the heading');

const parked = settle(makeCar(50, 60, 1.2, 0), 8);
ok(parked.x === 50 && parked.y === 60, 'a still car collides where it is drawn');

console.log('3) no pop when the lead target jumps');
const steady = makeCar(0, 0, 0, 6);
settle(steady, 3);
const before = steady.collider.x;
const after = api.netTrafficCollider(steady, 12).x;
const jump = 6 * (12 - 3);
ok(after - before <= jump * api.NET_TRAFFIC_LEAD_EASE + 1e-3,`collider moves ${(after - before).toFixed(2)} px of a ${jump} px lead jump in one frame`);
let maxStep = 0, previous = after;
for (let i = 0; i < 60; i++) { const x = api.netTrafficCollider(steady, 12).x; maxStep = Math.max(maxStep, x - previous); previous = x; }
ok(near(previous, 72, 1e-3) && maxStep <= jump * api.NET_TRAFFIC_LEAD_EASE + 1e-3,'it eases into the new lead without overshoot');

console.log('4) netSolidCars hands collision the extrapolated traffic');
const traffic = makeCar(300, 300, 0, 3);
api.setNet({
  players: new Map(), looseCars: new Map(), remoteCops: new Map(), authoritative: true,
  wcars: new Map([[1, traffic]]), stats: { rtt: 60, interpDelay: 70 },
});
let solid;
for (let i = 0; i < 60; i++) solid = api.netSolidCars([]);
const expectedLead = 3 * (70 + 30) / api.NET_SIM_FRAME_MS;
ok(solid.length === 1 && solid[0] === traffic.collider, 'traffic enters collision through its collider');
ok(near(solid[0].x, 300 + expectedLead, 1e-3), `collider sits ${expectedLead.toFixed(1)} px ahead of the drawn car`);

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
