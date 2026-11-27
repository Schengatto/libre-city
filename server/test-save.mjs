import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import runtime from './sim-runtime.js';
import stubs from '../js/sim-stubs.js';
const { BUNDLE, JS_DIR } = runtime;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const context = vm.createContext(stubs.makeSimStubs('SAVE12', 900, { setTimeout, clearTimeout, setInterval, clearInterval }));
vm.runInContext(BUNDLE, context, { timeout: 5000 });
vm.runInContext(fs.readFileSync(path.join(JS_DIR, 'save.js'), 'utf8'), context, { filename: 'save.js' });
const run = source => vm.runInContext(source, context);

const spawn = run('({ x: player.x, y: player.y })');
const road = run(`(() => { const n = nodes.find(n => !boxHits(n.x, n.y, player.r, player.r) && Math.hypot(n.x - ${spawn.x}, n.y - ${spawn.y}) > 100); return { x: n.x, y: n.y }; })()`);
const wall = run(`(() => { for (let ty = 1; ty < MAP_H; ty++) for (let tx = 1; tx < MAP_W; tx++) if (solidTile(tx, ty)) return { x: tx * T + T / 2, y: ty * T + T / 2 }; })()`);
const world = run('({ w: WORLD_W, h: WORLD_H })');

function applyAt(x, y) {
  run(`player.x = ${spawn.x}; player.y = ${spawn.y};`);
  const applied = run(`applySave({ v: SAVE_VERSION, code: ROOM_CODE, player: { x: ${x}, y: ${y} } })`);
  return { applied, ...run('({ x: player.x, y: player.y })') };
}

console.log('applySave position');
ok(run('boxHits(' + wall.x + ',' + wall.y + ', player.r, player.r)'), 'fixture: the wall point is solid');
let result = applyAt(world.w + 200, spawn.y);
ok(result.applied && result.x === spawn.x && result.y === spawn.y, 'saved point east of the map keeps the spawn point');
result = applyAt(spawn.x, world.h + 50);
ok(result.x === spawn.x && result.y === spawn.y, 'saved point south of the map keeps the spawn point');
result = applyAt(-10, -10);
ok(result.x === spawn.x && result.y === spawn.y, 'negative saved point keeps the spawn point');
result = applyAt(wall.x, wall.y);
ok(result.x === spawn.x && result.y === spawn.y, 'saved point inside a building keeps the spawn point');
result = applyAt(road.x, road.y);
ok(result.x === road.x && result.y === road.y, 'valid saved point on a road is restored');
run('player.x = ' + spawn.x + '; player.y = ' + spawn.y + ';');
ok(run('applySave({ v: SAVE_VERSION, code: ROOM_CODE, player: {} })') && run('player.x') === spawn.x, 'save without a position keeps the spawn point');

console.log('day/night save round trip');
ok(run('dayNightOn = false; captureSave().dayNight') === false, 'captureSave stores dayNight');
ok(run('dayNightOn = false; applySave({ v: SAVE_VERSION, code: ROOM_CODE, player: {}, dayNight: false }); dayNightOn') === false, 'applySave restores day/night off');
ok(run('dayNightOn = false; applySave({ v: SAVE_VERSION, code: ROOM_CODE, player: {} }); dayNightOn') === true, 'an old save without dayNight resumes with the cycle on');

console.log('mutators save round trip');
const savedMutators = run("applyMutators(['glassCars', 'night']); captureSave().mutators");
ok(JSON.stringify(savedMutators) === JSON.stringify(['night', 'glassCars']), 'captureSave stores the active mutators');
const resumedMutators = run("const savedState = captureSave(); resetMutators(); applySave(savedState); ({ ids: activeMutatorIds.slice(), night: TUNING.forceNight, damage: TUNING.carDamageScale })");
ok(JSON.stringify(resumedMutators.ids) === JSON.stringify(['night', 'glassCars']) && resumedMutators.night === true && resumedMutators.damage === 2, 'applySave resumes the saved mutators');
ok(run("applyMutators(['night']); applySave({ v: SAVE_VERSION, code: ROOM_CODE, player: {} }); activeMutatorIds.length") === 0 && run('TUNING.forceNight') === false, 'a save without mutators applies none');
ok(JSON.stringify(run("applySave({ v: SAVE_VERSION, code: ROOM_CODE, player: {}, mutators: ['night', 'bogus', 'night'] }); activeMutatorIds.slice()")) === JSON.stringify(['night']), 'unknown and duplicate saved mutator ids are dropped');
ok(run("applySave({ v: SAVE_VERSION, code: ROOM_CODE, player: {}, mutators: 'night' }); activeMutatorIds.length") === 0, 'a non-array saved mutators field applies none');
run('resetMutators()');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
