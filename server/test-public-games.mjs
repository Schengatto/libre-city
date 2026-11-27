import fs from 'node:fs';
import path from 'node:path';
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

const uiSource = readSource('ui.js');
const indexHtml = fs.readFileSync(path.join(import.meta.dirname, '..', 'index.html'), 'utf8');
const functionSource = name => {
  const start = uiSource.indexOf(`function ${name}(`);
  const end = uiSource.indexOf('\n}\n', start);
  return start === -1 || end === -1 ? '' : uiSource.slice(start, end);
};

console.log('6) public games screen guards');
const rowBuilderSource = functionSource('buildPublicGameRow');
ok(rowBuilderSource.includes('.textContent = room.title'), 'row builder writes the game name with textContent');
ok(rowBuilderSource.length > 0 && !/innerHTML|insertAdjacentHTML/.test(rowBuilderSource), 'row builder never uses innerHTML');
ok(!/innerHTML|insertAdjacentHTML/.test(functionSource('renderPublicGames')), 'table render never uses innerHTML');
ok(/const PANELS = \[[^\]]*'publicPanel'/.test(uiSource), "PANELS contains 'publicPanel'");
ok(indexHtml.indexOf('id="mpPublicBtn"') !== -1 && indexHtml.indexOf('id="mpPublicBtn"') < indexHtml.indexOf('id="mpHostBtn"'), '#mpPublicBtn comes before #mpHostBtn');
ok(/if \(id === 'publicPanel'\) startPublicGamesPolling\(\); else stopPublicGamesPolling\(\);/.test(functionSource('showPanel')), 'showPanel starts polling only for publicPanel and stops it for any other panel');
ok(/if \(started\) return;\n\s*stopPublicGamesPolling\(\);/.test(functionSource('startMatch')), 'startMatch stops the polling');
ok(/epoch !== publicGamesEpoch\) return;\n\s*publicGamesList =/.test(functionSource('fetchPublicGames')), 'a fetch resolving after leaving does not render');
ok(/rooms\.length === 1 \? 'pub\.countOne' : 'pub\.count'/.test(functionSource('renderPublicGames')), 'the count line uses the singular key for exactly one game');
ok(/signal: typeof AbortSignal\.timeout === 'function' \? AbortSignal\.timeout\(PUBLIC_GAMES_POLL_MS\) : undefined/.test(functionSource('fetchPublicGames')), 'the rooms fetch times out where supported so polling and Refresh never stay blocked');
ok(/if \(!playerName\) \{[^}]*joinName[^}]*focus\(\);\s*return;/.test(functionSource('joinPublicGame')), 'same-city join without a name asks for it instead of joining');
ok(/Number\.isInteger\(room\.leftSec\)/.test(functionSource('isRenderablePublicRoom')), 'only integer leftSec reaches formatTimeLeft');
ok(/_joinIntent\.auto && ROOM_FROM_URL === _joinIntent\.code && playerName/.test(uiSource), 'auto-join boot branch is guarded by code and player name');
ok(/store\.set\('joinIntent', \{ code, pass: '', auto: true \}\)/.test(functionSource('joinPublicGame')), 'joining another city stores an auto joinIntent');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
