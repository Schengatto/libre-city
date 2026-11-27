import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const jsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');
const read = file => fs.readFileSync(path.join(jsDir, file), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

function makeContext() {
  const context = vm.createContext({ console });
  vm.runInContext(`
    var matchElapsedFrames = 0;
    var playerName = 'Ada';
    var location = { hash: '', reloads: 0, reload() { this.reloads++; } };
    var store = { data: {}, set(key, value) { this.data[key] = value; } };
    var elements = {};
    var $ = selector => elements[selector] || null;
    var t = key => key;
  `, context);
  for (const file of ['game-events.js', 'job-score.js', 'run.js']) vm.runInContext(read(file), context, { filename: file });
  return context;
}
const evaluate = (context, source) => JSON.parse(vm.runInContext(`JSON.stringify(${source})`, context));

console.log('1) defaults');
let context = makeContext();
ok(evaluate(context, 'runConfig') === null && evaluate(context, 'runState') === null, 'runConfig and runState start as null');
ok(evaluate(context, 'runScoreMultiplier({ job: "taxi" })') === 1, 'runScoreMultiplier() defaults to 1');
ok(evaluate(context, 'runShareHandler') === null, 'runShareHandler defaults to null');
ok(evaluate(context, 'RUN_LOG_MAX') === 600 && evaluate(context, 'RUN_LOG_DAMAGE_MIN') === 4, 'log constants');
vm.runInContext('startRun()', context);
ok(evaluate(context, 'runState') === null, 'startRun without a runConfig does nothing');

console.log('2) launchRun');
context = makeContext();
const launch = evaluate(context, `(() => {
  launchRun({ mode: 'shift', job: 'taxi', minutes: 5, roomCode: 'PSHIFT' });
  return { intent: store.data.spIntent, hash: location.hash, reloads: location.reloads };
})()`);
ok(launch.intent.code === 'PSHIFT' && launch.intent.mins === 5 && launch.intent.violence === true && launch.intent.name === 'Ada', 'spIntent carries code, mins, violence and name');
ok(launch.intent.runConfig.job === 'taxi' && launch.hash === 'room=PSHIFT' && launch.reloads === 1, 'runConfig travels in the intent, hash set, page reloaded');

console.log('3) startRun and the run log');
context = makeContext();
const started = evaluate(context, `(() => {
  const order = [];
  const modeCalls = [];
  runModes.shift = { start(config) { modeCalls.push(config.job); order.push('mode.start'); }, result() {}, hud() {} };
  globalThis.resetJobRandom = () => order.push('reset');
  gameEvents.on('run:start', () => order.push('run:start'));
  gameEvents.enabled = true;
  matchElapsedFrames = 90;
  runConfig = { mode: 'shift', job: 'taxi', minutes: 5, roomCode: 'PSHIFT', mutators: ['m1'] };
  startRun();
  return { order, modeCalls, state: { ...runState, log: undefined }, first: runState.log[0] };
})()`);
ok(started.order.join(',') === 'reset,run:start,mode.start', `resetJobRandom, then run:start, then the mode start (${started.order.join(',')})`);
ok(started.state.mode === 'shift' && started.state.job === 'taxi' && started.state.score === 0 && started.state.jobsDone === 0
  && started.state.jobsFailed === 0 && started.state.startFrame === 90 && started.state.logTruncated === false && started.state.ended === false, 'runState shape');
ok(started.first.type === 'run:start' && started.first.rules === 1 && started.first.frame === 90 && started.first.mutators.join() === 'm1', 'run:start is logged with rules, frame and mutators');

const filtered = evaluate(context, `(() => {
  gameEvents.emit('job:start', { job: 'taxi', x: 1, y: 2, pay: 45, timerTotal: 800 });
  gameEvents.emit('kill', { victimKind: 'civ' });
  gameEvents.emit('vehicle:damage', { amount: 3.9, vehicleKind: 'car' });
  gameEvents.emit('vehicle:damage', { amount: 4, vehicleKind: 'car' });
  gameEvents.emit('wanted:change', { from: 0, to: 1 });
  return runState.log.map(entry => entry.type);
})()`);
ok(filtered.join(',') === 'run:start,job:start,vehicle:damage,wanted:change', `logged types only, damage under 4 and kill dropped (${filtered.join(',')})`);
ok(evaluate(context, 'runState.log[1]') .pay === 45, 'log entries are flat {type, frame, ...payload}');

const capped = evaluate(context, `(() => {
  for (let i = 0; i < 700; i++) gameEvents.emit('wanted:change', { from: 0, to: 1 });
  return { length: runState.log.length, truncated: runState.logTruncated };
})()`);
ok(capped.length === 600 && capped.truncated === true, `log stops at 600 and sets logTruncated (${capped.length}, ${capped.truncated})`);

context = makeContext();
const noRun = evaluate(context, `(() => {
  gameEvents.enabled = true;
  gameEvents.emit('job:start', {});
  return runState;
})()`);
ok(noRun === null, 'events outside a run create no log');

console.log('4) finishRun');
context = makeContext();
const finished = evaluate(context, `(() => {
  const resultCalls = [], shown = [], ended = [];
  runModes.shift = {
    start() {},
    result(state, outcome) { resultCalls.push(outcome); return { mode: state.mode, job: state.job, titleKey: 'shift.done', score: 100, medal: null, bestBefore: null, newBest: false, complete: outcome === 'time', stats: [] }; },
  };
  globalThis.showRunResult = result => shown.push(result);
  gameEvents.on('run:end', event => ended.push(event));
  gameEvents.enabled = true;
  runConfig = { mode: 'shift', job: 'taxi', roomCode: 'PSHIFT', target: { score: 100, from: 'friend' } };
  startRun();
  runState.jobsDone = 3; runState.jobsFailed = 1;
  finishRun('time');
  finishRun('quit');
  gameEvents.enabled = true;
  return { resultCalls, shown, ended, enabledAfter: false, lastLogType: runState.log[runState.log.length - 1].type, stateEnded: runState.ended };
})()`);
ok(finished.resultCalls.join() === 'time' && finished.shown.length === 1, 'result is built and shown once, a second finishRun is ignored');
ok(finished.ended.length === 1 && finished.ended[0].jobsDone === 3 && finished.ended[0].jobsFailed === 1 && finished.ended[0].complete === true
  && finished.ended[0].mode === 'shift' && finished.ended[0].score === 100 && 'newBest' in finished.ended[0] && 'bestBefore' in finished.ended[0], 'run:end emitted once with the run summary');
ok(finished.lastLogType === 'run:end' && finished.stateEnded === true, 'run:end is the last log entry and the run is marked ended');
ok(finished.shown[0].target.score === 100 && finished.shown[0].target.from === 'friend' && finished.shown[0].target.beaten === false, 'a tie does not beat the target');

const busAfter = evaluate(context, `(() => { gameEvents.enabled = true; finishRun('quit'); return gameEvents.enabled; })()`);
ok(busAfter === true, 'a finished run is not finished twice');

const disabledAfter = evaluate(makeContext(), `(() => {
  runModes.shift = { start() {}, result: state => ({ mode: state.mode, job: state.job, score: 5, complete: false }) };
  gameEvents.enabled = true;
  runConfig = { mode: 'shift', job: 'taxi', roomCode: 'PSHIFT' };
  startRun();
  finishRun('quit');
  return gameEvents.enabled;
})()`);
ok(disabledAfter === false, 'finishRun disables the bus');

const targets = evaluate(makeContext(), `(() => {
  runModes.shift = { start() {}, result: () => ({ mode: 'shift', job: 'taxi', score: 101, complete: true }) };
  const shown = [];
  globalThis.showRunResult = result => shown.push(result);
  gameEvents.enabled = true;
  runConfig = { mode: 'shift', job: 'taxi', roomCode: 'PSHIFT', target: { score: 100, from: 'daily' } };
  startRun();
  finishRun('time');
  gameEvents.enabled = true;
  runConfig = { mode: 'shift', job: 'taxi', roomCode: 'PSHIFT' };
  startRun();
  finishRun('time');
  return shown.map(result => result.target);
})()`);
ok(targets[0].beaten === true && targets[1] === null, 'beaten when the score is higher; target is null without a target');

console.log('5) fallback result screen and unregistered modes');
context = makeContext();
const fallback = evaluate(context, `(() => {
  const classes = { add: [], remove: [] };
  const fakeClass = { add: name => classes.add.push(name), remove: name => classes.remove.push(name) };
  elements['#goTitle'] = { textContent: '' };
  elements['#goScore'] = { textContent: '' };
  elements['#goRank'] = { textContent: 'x' };
  elements['#goLadderWrap'] = { classList: fakeClass };
  elements['#gameOver'] = { classList: fakeClass };
  gameEvents.enabled = true;
  runConfig = { mode: 'unknown', roomCode: 'PSHIFT' };
  startRun();
  runState.score = 42;
  finishRun('quit');
  return { title: elements['#goTitle'].textContent, score: elements['#goScore'].textContent, rank: elements['#goRank'].textContent, classes };
})()`);
ok(fallback.title === 'go.quit' && fallback.score.includes('42') && fallback.rank === '', 'without showRunResult the existing game over panel is filled');
ok(fallback.classes.remove.includes('hidden') && fallback.classes.add.includes('hidden'), 'game over panel shown, ladder hidden');

console.log('6) wiring guards');
const ui = read('ui.js');
const endGameBody = ui.slice(ui.indexOf('function endGame('), ui.indexOf('function startMatch('));
ok(endGameBody.indexOf('if (runConfig) { finishRun(reason); return; }') > 0
  && endGameBody.indexOf('if (runConfig) { finishRun(reason); return; }') < endGameBody.indexOf('saveScore()'), 'endGame leaves through finishRun before saveScore when runConfig is set');
ok(/saveScore\(\)/.test(endGameBody), 'endGame still calls saveScore for free play');
ok(ui.includes('runConfig = _spIntent.runConfig || null;') && ui.indexOf('runConfig = _spIntent.runConfig || null;') < ui.indexOf('startMatch(false);', ui.indexOf('runConfig = _spIntent.runConfig')), 'startup branch sets runConfig before startMatch(false)');
ok(/if \(runConfig\) startRun\(\);/.test(ui), 'startMatch starts the run');
ok(ui.includes("ps.classList.toggle('hidden', netActive() || !!runConfig)") && ui.includes("t(runConfig ? 'shift.quit' : 'pause.quit')"), 'pause hides Save and relabels Quit in a run');
ok(read('save.js').includes('function canSave() { return started && !netActive() && !runConfig; }'), 'canSave is false in a run');
const html = read('../index.html');
ok(html.indexOf('js/job-score.js') < html.indexOf('js/run.js') && html.indexOf('js/run.js') < html.indexOf('js/ui.js'), 'index.html loads run.js after job-score.js and before ui.js');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
