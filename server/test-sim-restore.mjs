import runtime from './sim-runtime.js';
const { createRoomSim } = runtime;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const simA = createRoomSim('RESTO1');
simA.addPlayer('Alice', 2, 'p1');
const original = simA._player('p1');
Object.assign(original, {
  x: original.x + 12, y: original.y + 7, health: 40, cash: 300, kills: 2, deaths: 1, score: 250,
  streak: 2, bounty: 150, weaponIdx: 2, wanted: 3, wantedHeat: 3.4,
});
original.owned[2] = true;

console.log('exportPlayers');
const rows = simA.exportPlayers();
ok(rows.length === 1 && rows[0].id === 'p1' && rows[0].name === 'Alice' && rows[0].shirtIdx === 2, 'row carries identity');
ok(JSON.stringify(rows) === JSON.stringify(JSON.parse(JSON.stringify(rows))), 'rows are JSON-serialisable plain objects');
ok(rows[0].own !== original.owned && rows[0].own[2] === true, 'own is a copy');

console.log('restorePlayer');
const simB = createRoomSim('RESTO1');
const [row] = JSON.parse(JSON.stringify(rows));
simB.restorePlayer(row.id, row.name, row.shirtIdx, row);
ok(JSON.stringify(simB.scores()) === JSON.stringify(simA.scores()), 'scores match');
const stateA = simA.playerState('p1');
const stateB = simB.playerState('p1');
ok(stateB.x === stateA.x && stateB.y === stateA.y && stateB.hp === stateA.hp
  && stateB.cash === stateA.cash && stateB.wanted === stateA.wanted, 'playerState matches');
const restored = simB._player('p1');
ok(restored.car === null, 'restored on foot');
ok(restored.weaponIdx === 2 && restored.owned[2] === true && restored.streak === 2 && restored.wantedHeat === 3.4, 'weapon, owned, streak and heat restored');
ok(restored.shirtIdx === 2 && restored.name === 'Alice', 'name and shirt restored');

simB.restorePlayer('p2', 'Bob', 0, { cash: 5 });
ok(simB._player('p2').cash === 5 && simB._player('p2').health === 100, 'partial state keeps defaults');
let threw = null;
try { for (let i = 0; i < 100; i++) simB.tick(); } catch (e) { threw = e; }
ok(!threw, 'restored sim ticks without crashing' + (threw ? ': ' + threw.message : ''));

ok(restored.owned !== row.own, 'owned is not aliased to the row');

console.log('player in a car');
const simC = createRoomSim('RESTO2');
simC.addPlayer('Carl', 0, 'p1');
const driver = simC._player('p1');
const freeCar = simC._cars().find(c => !c.driver);
freeCar.driver = driver;
driver.car = freeCar;
driver.x = freeCar.x;
driver.y = freeCar.y;
const [carRow] = JSON.parse(JSON.stringify(simC.exportPlayers()));
const simD = createRoomSim('RESTO2');
simD.restorePlayer(carRow.id, carRow.name, carRow.shirtIdx, carRow);
ok(simD._player('p1').car === null, 'driver is restored on foot');
ok(simD._player('p1').x === freeCar.x && simD._player('p1').y === freeCar.y, 'restored at the car position');

console.log('malformed rows');
const simE = createRoomSim('RESTO3');
const hostileRows = [
  { wp: 999 }, { wp: -3 }, { wp: 1.7 }, { wp: 'x' }, { own: 'abc' }, { own: [true] }, { own: { length: 99 } },
  { x: 'oops', y: NaN, hp: '50', cash: null, k: {}, d: [], s: Infinity, stk: -Infinity, b: 'b', wanted: 'many', wantedHeat: NaN },
  { x: 1e12, y: -1e12, hp: 5000, cash: -50, wanted: 99, wantedHeat: 99 },
  null, 'string', 42, [],
];
let hostileThrew = null;
try {
  hostileRows.forEach((hostileRow, index) => simE.restorePlayer('h' + index, 'Hostile', 0, hostileRow));
  for (let i = 0; i < 20; i++) { simE.tick(); simE.exportPlayers().forEach(p => simE.snapshotFor(p.id)); }
} catch (e) { hostileThrew = e; }
ok(!hostileThrew, 'malformed rows never throw, tick and snapshotFor survive' + (hostileThrew ? ': ' + hostileThrew.message : ''));
const sane = simE.exportPlayers();
const worldInfo = simE.worldInfo();
ok(sane.length === hostileRows.length, 'every malformed row still yields a player');
ok(sane.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= worldInfo.worldW && p.y >= 0 && p.y <= worldInfo.worldH), 'positions are finite and inside the world');
ok(sane.every(p => p.hp >= 0 && p.hp <= 100 && p.cash >= 0 && p.wanted >= 0 && p.wanted <= 5 && p.wantedHeat >= 0 && p.wantedHeat < 6), 'hp, cash and wanted stay in range');
ok(sane.every(p => Number.isInteger(p.wp) && p.wp >= 0 && p.wp < p.own.length && p.own.every(v => typeof v === 'boolean')), 'weapon index valid and own is a boolean list');
ok(sane.every(p => p.own.length === sane[0].own.length), 'own always has one entry per weapon');
ok(simE._player('h0').weaponIdx === 0 && simE._player('h1').weaponIdx === 0 && simE._player('h2').weaponIdx === 0, 'out-of-range and fractional wp are ignored');

console.log('duplicate id');
const simF = createRoomSim('RESTO4');
simF.restorePlayer('p1', 'First', 0, { cash: 10 });
simF.restorePlayer('p1', 'Second', 1, { cash: 20 });
ok(simF.playerCount() === 1, 'restoring an existing id does not duplicate the player');
ok(simF._player('p1').cash === 20 && simF._player('p1').name === 'Second', 'the second row wins');
simF.restorePlayer('', 'NoId', 0, {});
simF.restorePlayer(undefined, 'NoId', 0, {});
ok(simF.playerCount() === 1, 'rows without a usable id are ignored');

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
