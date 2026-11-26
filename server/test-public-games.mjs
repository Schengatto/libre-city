import vm from 'node:vm';
import { readSource } from './render-test-kit.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const helpers = vm.runInNewContext(
  readSource('public-games.js') +
  '\n({ publicGameSizeKey, formatTimeLeft, isTimeLeftLow, visiblePublicRooms, isPublicRoomFull, publicRoomsUrl, serverHttpBase });'
);

console.log('1) size key from the room code');
ok(helpers.publicGameSizeKey('GK3P9A') === 'common.sizeShortL', 'G -> large');
ok(helpers.publicGameSizeKey('MAB123') === 'common.sizeShortM', 'M -> medium');
ok(helpers.publicGameSizeKey('X12345') === 'common.sizeShortS', 'other -> small');
ok(helpers.publicGameSizeKey('') === 'common.sizeShortS', 'empty -> small');

console.log('2) time left formatting');
ok(helpers.formatTimeLeft(761) === '12:41', '761 -> 12:41');
ok(helpers.formatTimeLeft(65) === '01:05', '65 -> 01:05');
ok(helpers.formatTimeLeft(0) === '00:00', '0 -> 00:00');
ok(helpers.formatTimeLeft(null) === '∞', 'null -> infinity');
ok(helpers.isTimeLeftLow(119), '119 is low');
ok(!helpers.isTimeLeftLow(120), '120 is not low');
ok(!helpers.isTimeLeftLow(null), 'null is not low');

console.log('3) visible rooms');
const input = [{ code: 'A', leftSec: 100 }, { code: 'B', leftSec: 64 }, { code: 'C', leftSec: null }];
const snapshot = JSON.stringify(input);
const visible = helpers.visiblePublicRooms(input, 5);
ok(JSON.stringify(visible) === JSON.stringify([{ code: 'A', leftSec: 95 }, { code: 'C', leftSec: null }]), 'reduces leftSec, drops rows under 60s, keeps null');
ok(JSON.stringify(input) === snapshot, 'input not mutated');
ok(visible[0] !== input[0], 'returns copies');
ok(helpers.visiblePublicRooms([{ leftSec: 65 }], 5).length === 1, 'exactly 60s stays');
ok(helpers.visiblePublicRooms([], 5).length === 0, 'empty list');

console.log('4) full rooms');
ok(helpers.isPublicRoomFull({ players: 4, max: 4 }), '4/4 full');
ok(!helpers.isPublicRoomFull({ players: 3, max: 4 }), '3/4 not full');

console.log('5) rooms url');
ok(helpers.publicRoomsUrl('wss://vibecity.example/') === 'https://vibecity.example/rooms', 'wss with trailing slash');
ok(helpers.publicRoomsUrl('ws://localhost:8787') === 'http://localhost:8787/rooms', 'ws with port');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
