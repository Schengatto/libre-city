import vm from 'node:vm';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import runtime from './sim-runtime.js';
import stubs from '../js/sim-stubs.js';
const { BUNDLE, JS_DIR } = runtime;
const require = createRequire(import.meta.url);
const { snapshotEncode, snapshotDecode } = require(JS_DIR + '/snapshot-codec.js');
const {
  SNAPSHOT_DELTA_HISTORY_SIZE, SNAPSHOT_DELTA_MAX_ENTITIES, SNAPSHOT_DELTA_KEYED_LISTS,
  snapshotDeltaSameValue, snapshotDeltaSplitEvents, snapshotDeltaWithEvents,
  snapshotDeltaEncode, snapshotDeltaApply, snapshotDeltaRemember,
} = require(JS_DIR + '/snapshot-delta.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

function loadSim(code) {
  const context = vm.createContext(stubs.makeSimStubs(code, 900, { setTimeout, clearTimeout, setInterval, clearInterval }));
  vm.runInContext(BUNDLE, context, { timeout: 5000 });
  return { context, run: expr => vm.runInContext(expr, context) };
}

const wire = value => snapshotDecode(snapshotEncode(value));
const sortById = list => [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const canonical = state => ({ ...state, cars: sortById(state.cars), peds: sortById(state.peds), coins: sortById(state.coins), fires: sortById(state.fires) });
const applies = (base, current) => {
  const delta = snapshotDeltaEncode(base, current);
  if (!delta) return false;
  const applied = snapshotDeltaApply(wire(base), wire(delta));
  return applied !== null && isDeepStrictEqual(canonical(applied), canonical(wire(current)));
};
const sum = values => values.reduce((total, value) => total + value, 0);

console.log('1) constants');
ok(SNAPSHOT_DELTA_HISTORY_SIZE === 32, 'history size 32');
ok(SNAPSHOT_DELTA_MAX_ENTITIES === 4096, 'max entities 4096');
ok(isDeepStrictEqual(SNAPSHOT_DELTA_KEYED_LISTS, ['cars', 'peds', 'coins', 'fires']), 'keyed lists');

console.log('2) sameValue');
ok(snapshotDeltaSameValue(NaN, null), 'NaN equals null');
ok(snapshotDeltaSameValue(-0, 0), '-0 equals 0');
ok(snapshotDeltaSameValue({ a: undefined, b: 1 }, { b: 1 }), 'undefined member is not a wire key');
ok(snapshotDeltaSameValue([undefined], [null]), 'undefined array item equals null');
ok(snapshotDeltaSameValue({ x: [1, { y: 2 }] }, { x: [1, { y: 2 }] }), 'nested equal');
ok(snapshotDeltaSameValue({ k: null }, { k: null }), 'null member equal');
ok(!snapshotDeltaSameValue(1, '1'), 'number differs from string');
ok(!snapshotDeltaSameValue([1], [1, 2]), 'array length differs');
ok(!snapshotDeltaSameValue({ a: 1 }, { a: 1, b: 2 }), 'extra key differs');
ok(!snapshotDeltaSameValue(null, {}), 'null differs from object');
ok(!snapshotDeltaSameValue({ k: null }, { k: undefined, z: 1 }), 'null member does not match a missing member');
ok(!snapshotDeltaSameValue([], {}), 'array differs from object');

console.log('3) splitEvents / withEvents');
const eventFrame = { t: 'w', tick: 4, me: { x: 1, ev: ['k'] }, fx: [{ k: 1 }] };
const split = snapshotDeltaSplitEvents(eventFrame);
ok(isDeepStrictEqual(split.ev, ['k']) && isDeepStrictEqual(split.fx, [{ k: 1 }]), 'events extracted');
ok(isDeepStrictEqual(split.state.fx, []) && split.state.me.ev === null && split.state.me.x === 1, 'state carries no events');
ok(isDeepStrictEqual(eventFrame.me.ev, ['k']) && isDeepStrictEqual(eventFrame.fx, [{ k: 1 }]), 'frame not mutated');
ok(isDeepStrictEqual(snapshotDeltaWithEvents(split.state, split.fx, split.ev), eventFrame), 'withEvents restores the frame');
const bareSplit = snapshotDeltaSplitEvents({ t: 'w', tick: 1 });
ok(isDeepStrictEqual(bareSplit.state.me, { ev: null }) && bareSplit.ev === null && isDeepStrictEqual(bareSplit.fx, []), 'frame without me');

console.log('4) remember');
const history = new Map();
for (let tick = 2; tick <= 80; tick += 2) snapshotDeltaRemember(history, { tick });
ok(history.size === 32 && history.keys().next().value === 18 && history.has(80), 'bounded at 32, oldest key 18');

console.log('5) real sim sequence');
const host = loadSim('PDELTA1');
host.run(`['pA', 'pB', 'pC', 'pD'].forEach((id, index) => __sim.addPlayer('P' + id, index, id))`);
const advance = ticks => host.run(`for (let i = 0; i < ${ticks}; i++) __sim.tick()`);
const capture = () => snapshotDeltaSplitEvents(host.run(`(() => {
  const snapshot = __sim.snapshotFor('pB');
  snapshot.sc = __sim.scores();
  __sim.clearFx();
  return snapshot;
})()`)).state;
const states = [];
for (let tick = 1; tick <= 240; tick++) {
  advance(1);
  if (tick % 2 === 0) states.push(capture());
}
let sequenceApplies = 0, sequenceTotal = 0, sequenceBaseOk = true, sequenceMeClean = true, sequenceEncodable = true;
for (let index = 0; index < states.length; index++) {
  for (const offset of [1, 2, 5, 16]) {
    if (index - offset < 0) continue;
    const base = states[index - offset];
    const delta = snapshotDeltaEncode(base, states[index]);
    sequenceTotal++;
    if (delta === null) { sequenceEncodable = false; continue; }
    if (delta.base !== base.tick) sequenceBaseOk = false;
    if ('base' in delta.me || 'rm' in delta.me) sequenceMeClean = false;
    if (applies(base, states[index])) sequenceApplies++;
  }
}
ok(sequenceTotal > 400, `${sequenceTotal} base/current pairs checked`);
ok(sequenceEncodable, 'every pair encodes as a delta');
ok(sequenceApplies === sequenceTotal, 'every delta applies back to the wire form of the current state');
ok(sequenceBaseOk, 'delta.base is the baseline tick');
ok(sequenceMeClean, 'no base or rm key inside me');
const meanBytesAt = offset => {
  const sizes = [];
  for (let index = offset; index < states.length; index++) {
    sizes.push({ full: snapshotEncode(states[index]).length, delta: snapshotEncode(snapshotDeltaEncode(states[index - offset], states[index])).length });
  }
  return { full: sum(sizes.map(size => size.full)) / sizes.length, delta: sum(sizes.map(size => size.delta)) / sizes.length };
};
const offsetOne = meanBytesAt(1);
const offsetTwo = meanBytesAt(2);
console.log(`  mean bytes  full ${offsetTwo.full.toFixed(0)}  delta(k=1) ${offsetOne.delta.toFixed(0)} (${(offsetOne.delta / offsetOne.full).toFixed(3)})  delta(k=2) ${offsetTwo.delta.toFixed(0)} (${(offsetTwo.delta / offsetTwo.full).toFixed(3)})`);
ok(offsetTwo.delta < 0.8 * offsetTwo.full, 'delta bytes < 0.8 x full bytes');

console.log('6) AOI teleport');
const beforeTeleport = capture();
const homePosition = host.run(`(() => { const player = __sim._player('pB'); const home = { x: player.x, y: player.y }; player.x = 200; player.y = 200; return home; })()`);
advance(2);
const afterTeleport = capture();
host.run(`(() => { const player = __sim._player('pB'); player.x = ${homePosition.x}; player.y = ${homePosition.y}; })()`);
advance(4);
const teleportDelta = snapshotDeltaEncode(beforeTeleport, afterTeleport);
ok(teleportDelta.rm && ((teleportDelta.rm.cars || []).length > 0 || (teleportDelta.rm.peds || []).length > 0), 'leaving the AOI removes entities');
ok(applies(beforeTeleport, afterTeleport), 'teleport delta applies');

console.log('7) key-set change');
const dentCarId = host.run(`(() => {
  const player = __sim._player('pB');
  const distance = candidate => Math.hypot(candidate.x - player.x, candidate.y - player.y);
  const car = __sim._cars().filter(candidate => candidate.driver !== 'player').sort((a, b) => distance(a) - distance(b))[0];
  car.dents = 0;
  return car.id;
})()`);
const setDents = value => host.run(`__sim._cars().find(candidate => candidate.id === ${dentCarId}).dents = ${value}`);
advance(2);
const withoutDents = capture();
setDents(5);
advance(2);
const withDents = capture();
setDents(0);
advance(2);
const dentsGone = capture();
const dentAppears = snapshotDeltaEncode(withoutDents, withDents);
const dentVanishes = snapshotDeltaEncode(withDents, dentsGone);
const fullEntry = (delta, carId) => delta.cars.find(entry => entry.id === carId);
ok(dentAppears.rm.cars.includes(dentCarId) && fullEntry(dentAppears, dentCarId).dn === 5 && 'x' in fullEntry(dentAppears, dentCarId), 'dn appearing removes and re-adds the full car');
ok(dentVanishes.rm.cars.includes(dentCarId) && 'x' in fullEntry(dentVanishes, dentCarId) && fullEntry(dentVanishes, dentCarId).dn === undefined, 'dn vanishing removes and re-adds the full car');
ok(applies(withoutDents, withDents) && applies(withDents, dentsGone), 'key-set changes apply');

console.log('8) coins and fires');
host.run(`(() => {
  const player = __sim._player('pB');
  coins.push({ x: player.x + 100, y: player.y, val: 50 });
  fires.push({ x: player.x - 100, y: player.y, r: 20, hp: 100 });
})()`);
advance(2);
const withPickups = capture();
advance(2);
const withPickupsLater = capture();
const bigCoin = state => state.coins.find(coin => coin.v === 50);
ok(bigCoin(withPickups) && Number.isFinite(bigCoin(withPickups).id), 'coin carries a numeric id');
ok(withPickups.fires.length === 1 && Number.isFinite(withPickups.fires[0].id), 'fire carries a numeric id');
ok(bigCoin(withPickupsLater).id === bigCoin(withPickups).id && withPickupsLater.fires[0].id === withPickups.fires[0].id, 'ids stay the same across states');
host.run(`coins.splice(coins.findIndex(coin => coin.val === 50), 1); fires.length = 0;`);
advance(2);
const withoutPickups = capture();
const pickupsDelta = snapshotDeltaEncode(withPickupsLater, withoutPickups);
ok(pickupsDelta.rm.coins.includes(bigCoin(withPickups).id) && pickupsDelta.rm.fires.includes(withPickups.fires[0].id), 'removed coin and fire are listed in rm');
ok(applies(withPickups, withPickupsLater) && applies(withPickupsLater, withoutPickups), 'coin and fire deltas apply');

console.log('9) owned copy');
const ownedIndex = host.run(`__sim._player('pB').owned.indexOf(false)`);
ok(ownedIndex >= 0, 'some weapon is not owned yet');
ok(states[0].me.own !== host.run(`__sim._player('pB').owned`), 'me.own is a copy of owned');
const beforeOwning = capture();
host.run(`__sim._player('pB').owned[${ownedIndex}] = true`);
advance(2);
const afterOwning = capture();
const owningDelta = snapshotDeltaEncode(beforeOwning, afterOwning);
ok(beforeOwning.me.own[ownedIndex] === false && owningDelta.me.own[ownedIndex] === true, 'a changed owned list is sent whole in the me patch');
ok(applies(beforeOwning, afterOwning), 'owned delta applies');

console.log('10) encoder fallback');
const baseState = states[10];
const currentState = states[12];
ok(baseState.cars.length > 0 && baseState.peds.length > 0, 'sample states have cars and peds');
ok(snapshotDeltaEncode(baseState, currentState) !== null, 'control: plain pair encodes');
ok(snapshotDeltaEncode(baseState, { ...currentState, extra: 1 }) === null, 'extra top-level key');
ok(snapshotDeltaEncode(baseState, { ...currentState, me: { ...currentState.me, zz: 1 } }) === null, 'extra me key');
ok(snapshotDeltaEncode(baseState, { ...currentState, cars: [currentState.cars[0], currentState.cars[0]] }) === null, 'duplicate id');
ok(snapshotDeltaEncode(baseState, { ...currentState, cars: [{ ...currentState.cars[0], id: {} }] }) === null, 'object id');
ok(snapshotDeltaEncode(baseState, { ...currentState, cars: [{ ...currentState.cars[0], id: '' }] }) === null, 'empty string id');
ok(snapshotDeltaEncode(baseState, { ...currentState, peds: {} }) === null, 'list not an array');
ok(snapshotDeltaEncode({ ...baseState, peds: {} }, currentState) === null, 'base list not an array');
ok(snapshotDeltaEncode(baseState, { ...currentState, cars: Array.from({ length: 4097 }, (_, index) => ({ id: index })) }) === null, 'list over 4096');
ok(snapshotDeltaEncode(baseState, { ...currentState, tick: baseState.tick }) === null, 'tick not advancing');
ok(snapshotDeltaEncode(baseState, { ...currentState, t: 'x' }) === null, 'frame type not w');
ok(snapshotDeltaEncode(null, currentState) === null && snapshotDeltaEncode(baseState, 7) === null, 'non-object states');
const reservedBase = { ...baseState, rm: 1 };
ok(snapshotDeltaEncode(reservedBase, { ...currentState, rm: 2 }) === null, 'changed reserved key rm');

console.log('11) whole-field omission');
const unchangedSc = { ...baseState, tick: baseState.tick + 2 };
const scDelta = snapshotDeltaEncode(baseState, unchangedSc);
ok(!('sc' in scDelta) && !('players' in scDelta) && !('fx' in scDelta), 'unchanged fields are omitted');
ok(isDeepStrictEqual(snapshotDeltaApply(wire(baseState), wire(scDelta)).sc, wire(baseState).sc), 'apply keeps base.sc');
const bulletsState = { ...baseState, tick: baseState.tick + 2, bul: [{ x: 1, y: 2, a: 0.5 }] };
const bulletsDelta = snapshotDeltaEncode(baseState, bulletsState);
ok(isDeepStrictEqual(bulletsDelta.bul, bulletsState.bul), 'changed bul goes whole');
ok(applies(baseState, bulletsState), 'bul delta applies');
const unchangedDelta = snapshotDeltaEncode(baseState, unchangedSc);
ok(unchangedDelta.cars.length === 0 && unchangedDelta.peds.length === 0 && !('rm' in unchangedDelta) && Object.keys(unchangedDelta.me).length === 0, 'identical state gives an empty patch');

console.log('12) apply rejects');
const baseWire = wire(baseState);
const validDelta = wire(snapshotDeltaEncode(baseState, currentState));
const existingCarId = baseWire.cars[0].id;
ok(snapshotDeltaApply(baseWire, validDelta) !== null, 'control: valid delta applies');
const rejects = [
  ['base mismatch', { ...validDelta, base: validDelta.base + 1 }],
  ['tick equal to base tick', { ...validDelta, tick: baseWire.tick }],
  ['non-finite tick', { ...validDelta, tick: NaN }],
  ['type we', { ...validDelta, t: 'we' }],
  ['cars object', { ...validDelta, cars: {} }],
  ['missing peds', Object.fromEntries(Object.entries(validDelta).filter(([key]) => key !== 'peds'))],
  ['4097 car entries', { ...validDelta, cars: Array.from({ length: 4097 }, (_, index) => ({ id: 1e6 + index, x: 1 })) }],
  ['patch key on existing id', { ...validDelta, cars: [{ id: existingCarId, zz: 1 }] }],
  ['__proto__ entry', { ...validDelta, cars: [JSON.parse(`{"__proto__":{"polluted":1},"id":${JSON.stringify(existingCarId)}}`)] }],
  ['__proto__ insert', { ...validDelta, cars: [JSON.parse('{"__proto__":{"polluted":1},"id":987654321}')] }],
  ['me patch key', { ...validDelta, me: { zz: 1 } }],
  ['unknown top-level key', { ...validDelta, zz: 1 }],
  ['rm array', { ...validDelta, rm: [] }],
  ['rm list not array', { ...validDelta, rm: { cars: 'x' } }],
  ['rm unknown list', { ...validDelta, rm: { boats: [1] } }],
  ['rm object id', { ...validDelta, rm: { cars: [{}] } }],
  ['entry id object', { ...validDelta, cars: [{ id: {} }] }],
  ['entry not an object', { ...validDelta, cars: [7] }],
];
for (const [name, delta] of rejects) ok(snapshotDeltaApply(baseWire, delta) === null, `rejects ${name}`);
ok(snapshotDeltaApply(null, validDelta) === null, 'rejects base null');
ok(snapshotDeltaApply(baseWire, 7) === null, 'rejects delta 7');
ok(snapshotDeltaApply({ ...baseWire, cars: 'x' }, validDelta) === null, 'rejects a corrupt base list');
ok(({}).polluted === undefined, 'Object.prototype not polluted');

console.log('13) apply ignores unknown rm ids');
const withUnknownRm = { ...validDelta, rm: { ...validDelta.rm, cars: [...(validDelta.rm ? validDelta.rm.cars || [] : []), 987654321] } };
ok(isDeepStrictEqual(canonical(snapshotDeltaApply(baseWire, withUnknownRm)), canonical(snapshotDeltaApply(baseWire, validDelta))), 'unknown rm id changes nothing');

console.log('14) no mutation');
const invalidDelta = { ...validDelta, zz: 1 };
const baseBefore = structuredClone(baseWire), validBefore = structuredClone(validDelta), invalidBefore = structuredClone(invalidDelta);
snapshotDeltaApply(baseWire, validDelta);
snapshotDeltaApply(baseWire, invalidDelta);
ok(isDeepStrictEqual(baseWire, baseBefore) && isDeepStrictEqual(validDelta, validBefore) && isDeepStrictEqual(invalidDelta, invalidBefore), 'base and delta untouched');
const encodeBase = JSON.stringify(baseState), encodeCurrent = JSON.stringify(currentState);
snapshotDeltaEncode(baseState, currentState);
ok(JSON.stringify(baseState) === encodeBase && JSON.stringify(currentState) === encodeCurrent, 'encode leaves its states untouched');

console.log('15) fuzz');
let seed = 0x1234ABCD;
const nextRandom = () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
};
const pickFrom = list => list[Math.floor(nextRandom() * list.length)];
let fuzzThrows = 0, fuzzApplied = 0;
for (let round = 0; round < 2000; round++) {
  const mutated = structuredClone(validDelta);
  let node = mutated;
  for (;;) {
    const key = pickFrom(Object.keys(node));
    const child = node[key];
    if (child !== null && typeof child === 'object' && Object.keys(child).length > 0 && nextRandom() < 0.6) { node = child; continue; }
    node[key] = pickFrom([null, -1, 1e9, 'x', {}, [], [{}], { id: 1 }, NaN]);
    break;
  }
  try { if (snapshotDeltaApply(baseWire, mutated) !== null) fuzzApplied++; } catch (error) { fuzzThrows++; }
}
ok(fuzzThrows === 0, `apply never throws on 2000 mutated deltas (${fuzzApplied} still valid)`);
ok(({}).polluted === undefined, 'Object.prototype still clean');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
