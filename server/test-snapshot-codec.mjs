import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import runtime from './sim-runtime.js';
const { createRoomSim, JS_DIR } = runtime;
const { snapshotEncode, snapshotDecode, SNAPSHOT_CODEC_MAGIC, SNAPSHOT_CODEC_VERSION } = createRequire(import.meta.url)(JS_DIR + '/snapshot-codec.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };
const jsonRoundTrip = value => JSON.parse(JSON.stringify(value));
const roundTrips = value => isDeepStrictEqual(snapshotDecode(snapshotEncode(value)), jsonRoundTrip(value));
const frame = (...bytes) => Uint8Array.from(bytes);

console.log('1) constants');
ok(SNAPSHOT_CODEC_MAGIC === 0xB5 && SNAPSHOT_CODEC_VERSION === 0x01, 'magic 0xB5, version 0x01');
const encodedNull = snapshotEncode(null);
ok(encodedNull instanceof Uint8Array && encodedNull.length === 3 && encodedNull[0] === 0xB5 && encodedNull[1] === 0x01 && encodedNull[2] === 0x00, 'null frame is B5 01 00');
const firstFrame = snapshotEncode([1, 2, 3]);
const secondFrame = snapshotEncode([4, 5, 6]);
ok(firstFrame !== secondFrame && firstFrame.buffer !== secondFrame.buffer && firstFrame[4] === 0x41 && secondFrame[4] === 0x44, 'each encode returns a fresh, independent array');

console.log('2) real snapshots');
const sim = createRoomSim('PCODEC1');
const playerIds = ['pA', 'pB', 'pC', 'pD'];
playerIds.forEach((id, index) => sim.addPlayer('P' + index, index, id));
for (let tick = 0; tick < 120; tick++) sim.tick();
const snapshots = playerIds.map(id => sim.snapshotFor(id));
let jsonBytes = 0, binaryBytes = 0;
for (const snap of snapshots) {
  const encoded = snapshotEncode(snap);
  const jsonLength = Buffer.byteLength(JSON.stringify(snap));
  jsonBytes += jsonLength;
  binaryBytes += encoded.length;
  ok(JSON.stringify(snapshotDecode(encoded)) === JSON.stringify(jsonRoundTrip(snap)), `snapshot decodes to the JSON value (${encoded.length} B vs ${jsonLength} B JSON)`);
  ok(isDeepStrictEqual(snapshotDecode(encoded), jsonRoundTrip(snap)), 'snapshot deep-equals the JSON value');
  ok(encoded.length < jsonLength / 2, 'binary frame is under half the JSON size');
}
console.log(`   total: ${binaryBytes} B binary vs ${jsonBytes} B JSON, ratio ${(binaryBytes / jsonBytes).toFixed(3)}`);

console.log('3) values table');
const valueTable = [
  0, 191, 192, -1, -0, 2 ** 31, 2 ** 52 - 1, 2 ** 52, -(2 ** 52), -(2 ** 52) - 1, 2 ** 53 - 1, -(2 ** 53 - 1), -(2 ** 40),
  0.01, -1.99, 7.12, 1 / 3, 0.1 + 0.2, 1e300, 1e-9, 12345678.91, NaN, Infinity, -Infinity,
  '', 'é漢😀', '﻿x', 'a'.repeat(300), null, true, false, [], {}, [undefined, () => 1], { a: undefined, b: 1 },
  { f: () => 1, s: Symbol('x'), k: 'kept' },
  [{ x: 1, y: 2 }, { x: 3, y: 4 }, { y: 5, x: 6 }],
  { '': 1, 'a\u0000b': 2, c: 3 },
  [{ 'a\u0000b': 1, c: 2 }, { a: 1, 'b\u0000c': 2 }, {}, { '': 1 }, {}],
  { nested: { list: [1, [2, [3, { deep: 'ok' }]]], same: 'ok' }, same: 'ok' },
];
for (const value of valueTable) {
  const label = typeof value === 'function' || typeof value === 'symbol' ? String(value) : (Object.is(value, -0) ? '-0' : JSON.stringify(value) ?? String(value));
  ok(roundTrips(value), `round-trips ${label.length > 60 ? label.slice(0, 57) + '...' : label}`);
}
ok(Object.is(snapshotDecode(snapshotEncode(-0)), 0), '-0 decodes to 0');
ok(snapshotEncode(undefined).length === 3 && snapshotDecode(snapshotEncode(undefined)) === null, 'top-level undefined encodes as null');
const wideObject = {};
for (let index = 0; index < 5000; index++) wideObject['key' + index] = index * 7.01;
ok(roundTrips(wideObject), 'large object forces the shared buffer to grow and round-trips');
ok(roundTrips(Array.from({ length: 20000 }, (_, index) => index % 300)), 'large array round-trips');
ok(snapshotEncode(null).length === 3, 'encoder still correct after buffer growth');

console.log('4) hostile input');
const rejected = [
  ['empty array', frame()],
  ['magic only', frame(0xB5)],
  ['wrong magic', frame(0xB4, 0x01, 0x00)],
  ['wrong version', frame(0xB5, 0x02, 0x00)],
  ['unknown tag', frame(0xB5, 0x01, 0x0B)],
  ['string ref with empty table', frame(0xB5, 0x01, 0x07, 0x00)],
  ['shape ref with empty table', frame(0xB5, 0x01, 0x0A, 0x00)],
  ['count far beyond bytes', frame(0xB5, 0x01, 0x08, 0xFF, 0xFF, 0xFF, 0x7F)],
  ['key count far beyond bytes', frame(0xB5, 0x01, 0x09, 0xFF, 0xFF, 0xFF, 0x7F)],
  ['string length beyond bytes', frame(0xB5, 0x01, 0x06, 0x05, 0x61)],
  ['trailing byte', frame(0xB5, 0x01, 0x00, 0x00)],
  ['non-string object key', frame(0xB5, 0x01, 0x09, 0x01, 0x00, 0x00)],
  ['varint longer than 8 bytes', frame(0xB5, 0x01, 0x03, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00)],
  ['varint above 2^53', frame(0xB5, 0x01, 0x03, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x7F)],
  ['truncated float64', frame(0xB5, 0x01, 0x05, 0, 0, 0, 0)],
  ['NaN float64', frame(0xB5, 0x01, 0x05, 0, 0, 0, 0, 0, 0, 0xF8, 0x7F)],
  ['Infinity float64', frame(0xB5, 0x01, 0x05, 0, 0, 0, 0, 0, 0, 0xF0, 0x7F)],
];
for (const [label, bytes] of rejected) ok(snapshotDecode(bytes) === null, `decode returns null for ${label}`);
const nested = depth => frame(0xB5, 0x01, ...Array.from({ length: depth }, () => [0x08, 0x01]).flat(), 0x00);
ok(snapshotDecode(nested(33)) === null, '33 nested arrays are rejected');
ok(snapshotDecode(nested(32)) !== null, '32 nested arrays decode');
ok(snapshotDecode(frame(0xB5, 0x01, ...Array.from({ length: 33 }, () => [0x0A, 0x00]).flat(), 0x00)) === null, 'deep shape refs are rejected');
ok(snapshotDecode(new Uint16Array([1, 2])) === null && snapshotDecode('text') === null && snapshotDecode(null) === null && snapshotDecode(undefined) === null, 'non-byte inputs return null');
ok(isDeepStrictEqual(snapshotDecode(Buffer.from(snapshotEncode({ a: [1, 2.5, 'x'] }))), { a: [1, 2.5, 'x'] }), 'Node Buffer input decodes');
const padded = new Uint8Array(40);
const encodedForOffset = snapshotEncode({ a: 1, b: 'two' });
padded.set(encodedForOffset, 7);
ok(isDeepStrictEqual(snapshotDecode(padded.subarray(7, 7 + encodedForOffset.length)), { a: 1, b: 'two' }), 'subarray with byteOffset decodes');

console.log('5) truncation and fuzz');
const realBytes = snapshotEncode(snapshots[0]);
let truncationsAccepted = 0, truncationThrows = 0;
for (let cut = 0; cut < realBytes.length; cut++) {
  try { if (snapshotDecode(realBytes.subarray(0, cut)) !== null) truncationsAccepted++; } catch (error) { truncationThrows++; }
}
ok(truncationsAccepted === 0, `every truncation of a ${realBytes.length} B frame decodes to null`);
ok(truncationThrows === 0, 'truncated decode never throws');
let seed = 0x1234ABCD;
const nextRandom = () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
};
let fuzzThrows = 0, fuzzDecoded = 0;
for (let round = 0; round < 2000; round++) {
  const mutated = realBytes.slice();
  const flips = 1 + Math.floor(nextRandom() * 4);
  for (let flip = 0; flip < flips; flip++) mutated[Math.floor(nextRandom() * mutated.length)] = Math.floor(nextRandom() * 256);
  try { if (snapshotDecode(mutated) !== null) fuzzDecoded++; } catch (error) { fuzzThrows++; }
}
console.log(`   fuzz: ${fuzzDecoded} of 2000 mutations still decoded`);
ok(fuzzThrows === 0, '2000 random mutations never throw');
let randomThrows = 0;
for (let round = 0; round < 2000; round++) {
  const noise = new Uint8Array(1 + Math.floor(nextRandom() * 64));
  for (let index = 0; index < noise.length; index++) noise[index] = Math.floor(nextRandom() * 256);
  noise[0] = 0xB5;
  if (noise.length > 1) noise[1] = 0x01;
  try { snapshotDecode(noise); } catch (error) { randomThrows++; }
}
ok(randomThrows === 0, '2000 random frames with a valid header never throw');

console.log('6) prototype pollution');
const hostile = JSON.parse('{"__proto__":{"polluted":1},"t":"w"}');
const decodedHostile = snapshotDecode(snapshotEncode(hostile));
ok(decodedHostile !== null && decodedHostile.t === 'w', '__proto__ frame still decodes the other keys');
ok(({}).polluted === undefined, 'Object.prototype is not polluted');
ok(Object.getPrototypeOf(decodedHostile) === Object.prototype && !Object.prototype.hasOwnProperty.call(decodedHostile, '__proto__'), 'decoded object keeps a plain prototype and drops __proto__');
const nestedHostile = snapshotDecode(snapshotEncode(JSON.parse('{"a":[{"__proto__":{"polluted":2},"b":1}]}')));
ok(nestedHostile.a[0].b === 1 && ({}).polluted === undefined && nestedHostile.a[0].polluted === undefined, 'nested __proto__ is discarded too');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
