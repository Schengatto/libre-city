import vm from 'node:vm';
import { createRequire } from 'node:module';
import runtime from './sim-runtime.js';
import { readSource, extractTopLevel } from './render-test-kit.mjs';
const { createRoomSim, JS_DIR } = runtime;
const require = createRequire(import.meta.url);
const { snapshotEncode, snapshotDecode } = require(JS_DIR + '/snapshot-codec.js');
const { snapshotDeltaEncode, snapshotDeltaSplitEvents } = require(JS_DIR + '/snapshot-delta.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const wire = value => snapshotDecode(snapshotEncode(value));
const withEvents = (frame, ev) => ({ ...frame, fx: [], me: { ...frame.me, ev } });
const fullFrame = (state, ev) => wire(withEvents(state, ev));
const deltaFrame = (base, state, ev, overrides = {}) => wire(withEvents({ ...snapshotDeltaEncode(base, state), ...overrides }, ev));

const sim = createRoomSim('PNETD1');
sim.addPlayer('Pp1', 0, 'p1');
const capturedStates = new Map();
for (let step = 0; step < 6; step++) {
  for (let i = 0; i < 2; i++) sim.tick();
  const state = snapshotDeltaSplitEvents(sim.snapshotFor('p1')).state;
  sim.clearFx();
  capturedStates.set(state.tick, state);
}
const [tickA, tickB, tickC, tickD, tickE, tickF] = [...capturedStates.keys()];
const stateAt = tick => capturedStates.get(tick);

const recordedEvents = [];
const net = {
  myId: 'p1', lastSnapTick: -1, snapshotRing: new Map(), snapshotAckTick: null, snap: null,
  wcars: new Map(), wpeds: new Map(), players: new Map(), stats: {},
};
const context = vm.createContext({
  net, performance, coins: [], fires: [], TAU: Math.PI * 2, rnd: () => 0, NET_SHIRTS: ['shirt'],
  netNoteTrainTick: () => {}, netStatsOnSnapshot: () => {}, netMakeWorldCar: () => ({}), netApplyCar: () => {},
  interpFeed: () => {}, netWorldBulletsFrom: () => [], makeGhost: () => ({}),
  netApplyWorldEvents: (fx, ev) => recordedEvents.push({ fx, ev }),
});
const netSource = readSource('net.js');
vm.runInContext(readSource('snapshot-delta.js'), context);
const names = ['netResetSnapshotBaseline', 'netResolveSnapshot', 'netOnSnapshot'];
vm.runInContext([extractTopLevel(readSource('rtc.js'), 'rtcFreshSnapshot'), ...names.map(name => extractTopLevel(netSource, name))].join('\n')
  + '\n;globalThis.api = { ' + ['rtcFreshSnapshot', ...names].join(', ') + ' };', context);
const { netOnSnapshot, netResetSnapshotBaseline } = context.api;

console.log('1) full snapshot');
netOnSnapshot(fullFrame(stateAt(tickA), ['a']));
ok(net.snap.tick === tickA && net.snapshotAckTick === tickA && net.snapshotRing.size === 1, 'full frame applied, acked and remembered');

console.log('2) resolvable delta');
netOnSnapshot(deltaFrame(stateAt(tickA), stateAt(tickB), ['b']));
const expectedCarIds = wire(stateAt(tickB)).cars.map(car => car.id).sort().join();
ok(net.snap.tick === tickB && net.snapshotAckTick === tickB, 'delta applied and acked');
ok([...net.wcars.keys()].sort().join() === expectedCarIds, 'delta world cars equal the full state cars');
ok(net.snap.me.ev[0] === 'b' && net.snap.fx.length === 0, 'resolved delta carries its inline events');

console.log('3) unknown base');
netOnSnapshot(deltaFrame(stateAt(tickB), stateAt(tickC), ['c'], { base: 99 }));
ok(net.snap.tick === tickB && net.snapshotAckTick === null && net.snapshotRing.size === 0, 'unknown base keeps the state, drops the ack and the ring');

console.log('4) stale duplicate');
netOnSnapshot(deltaFrame(stateAt(tickB), stateAt(tickC), ['d']));
ok(net.snap.tick === tickB && net.snapshotAckTick === null, 'stale frame changes no state');

console.log('5) delta with an empty ring');
netOnSnapshot(deltaFrame(stateAt(tickB), stateAt(tickD), ['e']));
ok(net.snap.tick === tickB && net.snapshotRing.size === 0, 'delta without a baseline is dropped');

console.log('6) recovery by full frame');
netOnSnapshot(fullFrame(stateAt(tickE), ['f']));
ok(net.snap.tick === tickE && net.snapshotAckTick === tickE && net.snapshotRing.size === 1, 'next full frame is applied and acked');
ok(JSON.stringify(recordedEvents.map(entry => entry.ev)) === JSON.stringify([['a'], ['b'], ['c'], ['d'], ['e'], ['f']]), 'every event batch is delivered exactly once, in order');

console.log('7) reset');
netResetSnapshotBaseline();
ok(net.snapshotRing.size === 0 && net.snapshotAckTick === null && net.lastSnapTick === -1, 'reset empties the ring, the ack and the last tick');

console.log('8) hostile delta');
netOnSnapshot(fullFrame(stateAt(tickF), null));
const hostileDelta = JSON.parse(`{"t":"w","tick":${tickF + 2},"base":${tickF},"me":{},"cars":[{"__proto__":{"p":1},"id":1}],"peds":[],"coins":[],"fires":[]}`);
let hostileThrew = false;
try { netOnSnapshot(hostileDelta); } catch { hostileThrew = true; }
ok(!hostileThrew && net.snap.tick === tickF && net.snapshotAckTick === null && ({}).p === undefined, 'hostile delta is dropped without throwing or polluting prototypes');

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
