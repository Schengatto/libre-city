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

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
