import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { readSource } from './render-test-kit.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };
const same = (actual, expected) => { try { assert.deepStrictEqual(actual, expected); return true; } catch { return false; } };

const daynight = vm.runInNewContext(`${readSource('daynight.js')}
({ DAY_CYCLE_FRAMES, dayCycleFrame, dayNightAmbient })`);
const { DAY_CYCLE_FRAMES, dayCycleFrame, dayNightAmbient } = daynight;

const FRAMES_PER_MINUTE = 3600;
const SAMPLE_STEP = 60;
const DAY = { r: 255, g: 255, b: 255, light: 0 };
const NIGHT = { r: 70, g: 85, b: 140, light: 1 };

ok(DAY_CYCLE_FRAMES === 39600, 'cycle is 11 minutes');
ok(dayCycleFrame(0) === 0, 'cycle frame at start is 0');
ok(dayCycleFrame(DAY_CYCLE_FRAMES + 5) === 5, 'cycle frame wraps');
ok(dayCycleFrame(-5) === 39595, 'cycle frame wraps negative elapsed');

ok(same({ ...dayNightAmbient(0) }, DAY), 'start of cycle is full day');
ok(same({ ...dayNightAmbient(3 * FRAMES_PER_MINUTE) }, DAY), 'midday is full day');
const sunset = dayNightAmbient(6.5 * FRAMES_PER_MINUTE);
ok(sunset.r === 255 && sunset.g === 170, 'sunset is orange');
for (const minute of [7, 9, 10.5]) ok(same({ ...dayNightAmbient(minute * FRAMES_PER_MINUTE) }, NIGHT), `minute ${minute} is full night`);
ok(same({ ...dayNightAmbient(10.75 * FRAMES_PER_MINUTE) }, { r: 230, g: 190, b: 200, light: 0.4 }), 'dawn keyframe');

const samples = [];
for (let frame = 0; frame < DAY_CYCLE_FRAMES; frame += SAMPLE_STEP) samples.push(dayNightAmbient(frame));
const minutesWhere = predicate => samples.filter(predicate).length * SAMPLE_STEP / FRAMES_PER_MINUTE;
ok(Math.abs(minutesWhere(s => s.light < 0.5) - 7) <= 0.5, 'about 7 minutes of low light');
ok(Math.abs(minutesWhere(s => s.light >= 0.5) - 4) <= 0.5, 'about 4 minutes of high light');

const MAX_CHANNEL_STEP = 12;
const steps = samples.map((sample, i) => [sample, samples[(i + 1) % samples.length]]);
ok(steps.every(([a, b]) => Math.abs(a.r - b.r) <= MAX_CHANNEL_STEP && Math.abs(a.g - b.g) <= MAX_CHANNEL_STEP && Math.abs(a.b - b.b) <= MAX_CHANNEL_STEP), 'ambient is continuous including the wrap');
ok(samples.every(s => s.r >= 70 && s.g >= 85 && s.b >= 120), 'ambient never goes darker than night');

const gameplay = readSource('gameplay.js');
const updateBody = gameplay.slice(gameplay.search(/^function update\(\) \{/m));
ok(updateBody.indexOf('matchElapsedFrames++') > 0 && updateBody.indexOf('matchElapsedFrames++') < updateBody.indexOf('gameMinutes > 0'), 'update increments matchElapsedFrames before the timed branch');

const ui = readSource('ui.js');
const startMatchBody = ui.slice(ui.search(/^function startMatch\(/m));
const freshMatchBranch = startMatchBody.slice(startMatchBody.indexOf('if (!resume) {'), startMatchBody.indexOf('\n  }\n'));
ok(startMatchBody.indexOf('if (!resume) {') > 0 && /matchElapsedFrames = 0;/.test(freshMatchBranch), 'startMatch resets matchElapsedFrames only in the fresh-match branch');
ok(/netActive\(\) && net\.clockLeft != null && gameMinutes > 0\) matchElapsedFrames = gameMinutes \* 60 \* 60 - net\.clockLeft;/.test(freshMatchBranch), 'startMatch derives matchElapsedFrames from the server clock only in the fresh-match branch');
ok((startMatchBody.match(/matchElapsedFrames/g) || []).length === (freshMatchBranch.match(/matchElapsedFrames/g) || []).length, 'startMatch touches matchElapsedFrames nowhere outside the fresh-match branch');

const save = readSource('save.js');
ok(/matchElapsed: matchElapsedFrames/.test(save) && /matchElapsedFrames = s\.matchElapsed \| 0/.test(save), 'save writes and reads matchElapsed');

import { createRecordingContext } from './render-test-kit.mjs';

const GRASS = 3, SIDEWALK = 1, ROAD = 0, BUILDING = 2;
const NIGHT_ELAPSED = 9 * FRAMES_PER_MINUTE;
const DAY_ELAPSED = 3 * FRAMES_PER_MINUTE;

function createNightWorld(rows, buildingList = []) {
  const mainRecording = createRecordingContext();
  const canvases = [];
  const sandbox = {
    document: {
      createElement: () => {
        const recording = createRecordingContext();
        const canvas = { width: 0, height: 0, recording, getContext: () => recording.context };
        canvases.push(canvas);
        return canvas;
      },
    },
    ctx: mainRecording.context,
    rows,
    buildingList,
    Math,
    Set,
    Int32Array,
  };
  const world = vm.createContext(sandbox);
  vm.runInContext(`
    const T = 32, ROAD = 0, SIDEWALK = 1;
    const MAP_H = rows.length, MAP_W = rows[0].length;
    const tileAt = (tx, ty) => (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) ? 2 : rows[ty][tx];
    const bldgs = buildingList;
    const cars = [], fires = [], rockets = [], parts = [];
    const train = { segs: [] };
    const net = { players: new Map(), remoteCops: new Map(), authoritative: false };
    let netIsActive = false;
    const netActive = () => netIsActive;
    let vw = 800, vh = 600, camX = 0, camY = 0, frame = 0;
    let matchElapsedFrames = 0, dayNightOn = true;
  `, world);
  vm.runInContext(readSource('daynight.js'), world);
  return {
    world,
    canvases,
    main: mainRecording,
    run: code => vm.runInContext(code, world),
    lightmap: () => canvases[0].recording,
  };
}

const gridOf = (rowSpec) => rowSpec.map(row => [...row].map(ch => ({ r: ROAD, s: SIDEWALK, g: GRASS, b: BUILDING })[ch]));
const emptyGrid = () => gridOf(['gggggg', 'gggggg', 'gggggg', 'gggggg', 'gggggg', 'gggggg']);
const countCalls = (recording, name) => recording.calls.filter(([call]) => call === name).length;
const compositeAtDrawImage = (recording, drawImageNumber) => {
  let seen = 0, composite = null;
  for (const [call, args] of recording.calls) {
    if (call === 'set:globalCompositeOperation') composite = args[0];
    if (call === 'drawImage' && ++seen === drawImageNumber) return composite;
  }
  return null;
};
const hasRotatedBlit = recording => {
  let rotated = false;
  for (const [call, args] of recording.calls) {
    if (call === 'setTransform') rotated = !(args[0] === 1 && args[1] === 0 && args[2] === 0 && args[3] === 1);
    if (call === 'drawImage' && rotated) return true;
  }
  return false;
};

{
  const day = createNightWorld(emptyGrid());
  day.run(`matchElapsedFrames = ${DAY_ELAPSED}; drawDayNight();`);
  ok(day.main.calls.length === 0 && day.canvases.length === 0, 'full daylight makes no draw call and builds nothing');

  const off = createNightWorld(emptyGrid());
  off.run(`matchElapsedFrames = ${NIGHT_ELAPSED}; dayNightOn = false; drawDayNight();`);
  ok(off.main.calls.length === 0 && off.canvases.length === 0, 'toggle off at night makes no draw call');

  const night = createNightWorld(emptyGrid());
  night.run(`matchElapsedFrames = ${NIGHT_ELAPSED}; drawDayNight();`);
  ok(countCalls(night.main, 'drawImage') === 1, 'night blits the lightmap once on the main context');
  ok(compositeAtDrawImage(night.main, 1) === 'multiply', 'lightmap is blitted with multiply');
  ok(night.main.context.globalCompositeOperation === 'source-over', 'main composite is restored to source-over');
  ok(night.lightmap().context.globalCompositeOperation === 'source-over' && night.lightmap().context.globalAlpha === 1, 'lightmap state is reset after drawing');
  ok(night.lightmap().calls.some(([call, args]) => call === 'set:fillStyle' && args[0] === 'rgb(70,85,140)'), 'lightmap is filled with the ambient colour');
  const canvasesAfterFirstFrame = night.canvases.length;
  night.run('drawDayNight();');
  ok(night.canvases.length === canvasesAfterFirstFrame, 'second frame allocates no canvas');

  const noSources = countCalls(night.lightmap(), 'drawImage');
  ok(noSources === 0, 'empty night world blits no light sprite');
}

{
  const onScreen = createNightWorld(emptyGrid());
  onScreen.run(`matchElapsedFrames = ${NIGHT_ELAPSED}; cars.push({ x: 400, y: 300, angle: 0.7, w: 46, role: 'traffic' }); drawDayNight();`);
  ok(countCalls(onScreen.lightmap(), 'drawImage') === 1 && hasRotatedBlit(onScreen.lightmap()), 'car on screen blits one rotated headlight sprite');

  const offScreen = createNightWorld(emptyGrid());
  offScreen.run(`matchElapsedFrames = ${NIGHT_ELAPSED}; cars.push({ x: 5000, y: 300, angle: 0.7, w: 46, role: 'traffic' }); drawDayNight();`);
  ok(countCalls(offScreen.lightmap(), 'drawImage') === 0, 'car off screen blits nothing');

  const parked = createNightWorld(emptyGrid());
  parked.run(`matchElapsedFrames = ${NIGHT_ELAPSED}; cars.push({ x: 400, y: 300, angle: 0, w: 46, role: 'parked', driver: null }); drawDayNight();`);
  ok(countCalls(parked.lightmap(), 'drawImage') === 0, 'empty parked car has no headlight');

  const ghost = createNightWorld(emptyGrid());
  ghost.run(`matchElapsedFrames = ${NIGHT_ELAPSED}; netIsActive = true; net.players.set(1, { car: { x: 300, y: 300, angle: 1, w: 46, role: 'player' }, down: false, seen: true }); drawDayNight();`);
  ok(countCalls(ghost.lightmap(), 'drawImage') === 1 && hasRotatedBlit(ghost.lightmap()), 'multiplayer ghost car has a headlight');

  const ghostOnFoot = createNightWorld(emptyGrid());
  ghostOnFoot.run(`matchElapsedFrames = ${NIGHT_ELAPSED}; netIsActive = true; net.players.set(1, { car: null, x: 300, y: 300, down: false, seen: true }); drawDayNight();`);
  ok(countCalls(ghostOnFoot.lightmap(), 'drawImage') === 0, 'ghost on foot emits no light');

  const train = createNightWorld(emptyGrid());
  train.run(`matchElapsedFrames = ${NIGHT_ELAPSED}; train.segs.push({ loco: true, cx: 300, cy: 300, angle: 0.3, w: 66 }, { loco: false, cx: 240, cy: 300, angle: 0.3, w: 52 }); drawDayNight();`);
  ok(countCalls(train.lightmap(), 'drawImage') === 1 && hasRotatedBlit(train.lightmap()), 'only the locomotive front emits light');

  const fire = createNightWorld(emptyGrid());
  fire.run(`matchElapsedFrames = ${NIGHT_ELAPSED}; fires.push({ x: 300, y: 300 }, { x: 9000, y: 300 }); drawDayNight();`);
  ok(countCalls(fire.lightmap(), 'drawImage') === 1 && !hasRotatedBlit(fire.lightmap()), 'only the on-screen fire is blitted');

  const blast = createNightWorld(emptyGrid());
  blast.run(`matchElapsedFrames = ${NIGHT_ELAPSED}; parts.push({ x: 300, y: 300, life: 20, color: '#ff5a2a' }, { x: 320, y: 300, life: 20, color: '#555' }); drawDayNight();`);
  ok(countCalls(blast.lightmap(), 'drawImage') === 1, 'only fiery explosion particles emit light');
}

{
  const street = createNightWorld(gridOf(['gggggggggggg', 'ssssssssssss', 'rrrrrrrrrrrr', 'ssssssssssss', 'gggggggggggg', 'gggggggggggg']));
  const lamps = street.run('buildStreetLamps()');
  ok(lamps.length === 2, 'lamps follow the (tx + ty) % 8 spacing rule');
  const nextToRoad = lamp => {
    const tx = Math.floor(lamp.x / 32), ty = Math.floor(lamp.y / 32);
    return street.run(`tileAt(${tx}, ${ty}) === SIDEWALK && [[1,0],[-1,0],[0,1],[0,-1]].some(([dx, dy]) => tileAt(${tx} + dx, ${ty} + dy) === ROAD)`);
  };
  ok(lamps.every(nextToRoad), 'every lamp sits on a sidewalk next to a road');
  ok(lamps.every(lamp => lamp.x % 32 === 16 && lamp.y % 32 === 16), 'lamps sit at the tile centre');
  ok(street.run('buildStreetLamps() === buildStreetLamps()'), 'lamps are built once and cached');

  street.run(`matchElapsedFrames = ${NIGHT_ELAPSED}; drawDayNight();`);
  ok(countCalls(street.lightmap(), 'drawImage') === 2, 'visible lamps are blitted to the lightmap');

  street.run('camX = 100000; camY = 100000; drawDayNight();');
  ok(countCalls(street.lightmap(), 'drawImage') === 2, 'lamps outside the viewport are culled');
}

{
  const shops = [
    { x0: 0, y0: 0, x1: 2, y1: 2, lift: 9 },
    { x0: 3, y0: 0, x1: 5, y1: 1, lift: 11 },
    { x0: 0, y0: 3, x1: 1, y1: 5, lift: 7 },
    { x0: 2, y0: 3, x1: 5, y1: 5, lift: 16 },
  ];
  const city = createNightWorld(emptyGrid(), shops);
  const windows = city.run('buildWindowLights()');
  ok(windows.length > 0 && windows.length <= shops.length * 3, 'at most three windows per building');
  ok(windows.every(w => shops.some(b => w.x >= b.x0 * 32 && w.x <= (b.x1 + 1) * 32 && w.y >= (b.y1 + 1) * 32 - b.lift && w.y <= (b.y1 + 1) * 32)), 'windows sit on the south facade of a building');
  const again = createNightWorld(emptyGrid(), shops).run('buildWindowLights()');
  ok(same(JSON.parse(JSON.stringify(windows)), JSON.parse(JSON.stringify(again))), 'windows are deterministic across cities');
  ok(city.run('buildWindowLights() === buildWindowLights()'), 'windows are built once and cached');
  const sortedByRow = windows.every((w, i) => i === 0 || windows[i - 1].y <= w.y);
  ok(sortedByRow, 'windows are bucketed in row order');
  city.run(`matchElapsedFrames = ${NIGHT_ELAPSED}; drawDayNight();`);
  ok(countCalls(city.lightmap(), 'drawImage') === windows.length, 'every visible window is blitted');
}

{
  const resizing = createNightWorld(emptyGrid());
  resizing.run(`matchElapsedFrames = ${NIGHT_ELAPSED}; drawDayNight();`);
  ok(resizing.canvases[0].width === 400 && resizing.canvases[0].height === 300, 'lightmap is half the viewport');
  resizing.run('vw = 801; drawDayNight();');
  ok(resizing.canvases[0].width === Math.ceil(801 / 2), 'lightmap width follows the viewport');
}

{
  const render = readSource('render.js');
  const body = render.slice(render.indexOf('function render()'));
  const dayNight = body.indexOf('drawDayNight();');
  const afterOverlay = ['drawPops();', 'drawGunshopMenu();', 'flashT > 0', 'drawMinimap();', 'drawAim();'];
  ok(dayNight > body.indexOf('drawParts();') && afterOverlay.every(marker => dayNight < body.indexOf(marker)), 'night overlay sits after the particles and before pops, gunshop menu, flash, minimap and aim');

  const net = readSource('net.js');
  const resumeBlock = net.slice(net.indexOf('if (resumed && started && gameMinutes > 0) {'));
  ok(/^if \(resumed && started && gameMinutes > 0\) \{\n\s+timeLeft = net\.clockLeft;\n\s+matchElapsedFrames = gameMinutes \* 60 \* 60 - net\.clockLeft;\n\s+\}/.test(resumeBlock), 'reconnect resyncs matchElapsedFrames with the server clock');
}

{
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const field = html.match(/<select id="setDayNight">[\s\S]*?<\/select>/);
  ok(field && /<label for="setDayNight" data-i18n="set\.dayNight">/.test(html), 'settings has a labelled setDayNight select');
  ok(field && /value="on"[^>]*data-i18n="set\.dayNightOn"/.test(field[0]) && /value="off"[^>]*data-i18n="set\.dayNightOff"/.test(field[0]), 'setDayNight has on and off options with i18n keys');
  ok(/id="setAudio">[\s\S]*?<\/select>\s*<\/div>\s*<div class="field">\s*<label for="setDayNight"/.test(html), 'setDayNight sits right after the audio field');

  const i18n = readSource('i18n.js');
  const expected = { 'set.dayNight': ['Giorno/notte', 'Day/night'], 'set.dayNightOn': ['🌗 Attivo', '🌗 On'], 'set.dayNightOff': ['☀️ Sempre giorno', '☀️ Always day'] };
  const countOf = line => i18n.split(line).length - 1;
  ok(Object.entries(expected).every(([key, [it, en]]) => countOf(`'${key}': '${it}',`) === 1 && countOf(`'${key}': '${en}',`) === 1), 'IT and EN define the day/night keys');

  const settingsUi = readSource('ui.js');
  const openBody = settingsUi.slice(settingsUi.indexOf("onClick('settingsBtn'"), settingsUi.indexOf("onClick('settingsSave'"));
  const saveBody = settingsUi.slice(settingsUi.indexOf("onClick('settingsSave'"), settingsUi.indexOf("onClick('settingsBack'"));
  ok(/\$\('#setDayNight'\)/.test(openBody) && /d\.value = dayNightOn \? 'on' : 'off'/.test(openBody), 'settings open fills setDayNight from dayNightOn');
  ok(/dayNightOn = d \? d\.value === 'on' : true; store\.set\('dayNight', dayNightOn\)/.test(saveBody), 'settings save sets dayNightOn and persists it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
