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
ok(/matchElapsedFrames = 0;/.test(startMatchBody), 'startMatch resets matchElapsedFrames');
ok(/netActive\(\) && net\.clockLeft != null && gameMinutes > 0\) matchElapsedFrames = gameMinutes \* 60 \* 60 - net\.clockLeft;/.test(startMatchBody), 'startMatch derives matchElapsedFrames from the server clock');

const save = readSource('save.js');
ok(/matchElapsed: matchElapsedFrames/.test(save) && /matchElapsedFrames = s\.matchElapsed \| 0/.test(save), 'save writes and reads matchElapsed');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
