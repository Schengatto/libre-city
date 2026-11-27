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
  return { resultCalls, shown, ended, lastLogType: runState.log[runState.log.length - 1].type, stateEnded: runState.ended };
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

console.log('5) results screen and unregistered modes');
const resultScreenSetup = `
  const makeElement = () => {
    const classes = new Set();
    const element = { textContent: '', onclick: null, children: [], className: '', append(...nodes) { this.children.push(...nodes); }, appendChild(node) { this.children.push(node); } };
    element.classList = { add: name => classes.add(name), remove: name => classes.delete(name), toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)), contains: name => classes.has(name) };
    return element;
  };
  document = { createElement: makeElement };
  for (const id of ['#runResultPanel', '#runResultTitle', '#runResultScore', '#runResultMedal', '#runResultBest', '#runResultTarget', '#runResultStats', '#runRetry', '#runShare', '#runMenu', '#shiftHud']) elements[id] = makeElement();
  elements['#runResultPanel'].classList.add('hidden');
  const panelState = () => ({
    title: elements['#runResultTitle'].textContent, score: elements['#runResultScore'].textContent, medal: elements['#runResultMedal'].textContent,
    best: elements['#runResultBest'].textContent, bestHidden: elements['#runResultBest'].classList.contains('hidden'),
    target: elements['#runResultTarget'].textContent, targetHidden: elements['#runResultTarget'].classList.contains('hidden'),
    stats: elements['#runResultStats'].children.map(row => row.children.map(cell => cell.textContent)),
    shareHidden: elements['#runShare'].classList.contains('hidden'), panelHidden: elements['#runResultPanel'].classList.contains('hidden'),
    hudHidden: elements['#shiftHud'].classList.contains('hidden'),
  });
`;
const shownResult = evaluate(makeContext(), `(() => {
  ${resultScreenSetup}
  const calls = [];
  t = (key, params) => (params && !key.startsWith('ch.') ? key + '|' + Object.values(params).join('|') : key);
  launchRun = config => calls.push(['launch', config.job]);
  gameEvents.enabled = true;
  runConfig = { mode: 'shift', job: 'taxi', roomCode: 'PSHIFT' };
  const complete = { mode: 'shift', job: 'taxi', titleKey: 'shift.done', score: 4210, medal: 'silver', bestBefore: 3590, newBest: true, complete: true, stats: [{ key: 'shift.jobsDone', value: 14 }, { key: 'shift.jobsFailed', value: 2 }], target: null };
  showRunResult(complete);
  const newBest = panelState();
  elements['#runRetry'].onclick(); elements['#runMenu'].onclick();
  showRunResult({ ...complete, score: 3000, medal: 'bronze', newBest: false, target: { score: 2500, from: 'Marco', beaten: true } });
  const behind = panelState();
  showRunResult({ ...complete, bestBefore: null });
  const first = panelState();
  showRunResult({ ...complete, titleKey: 'shift.abandoned', medal: null, complete: false, newBest: false });
  const quit = panelState();
  runShareHandler = result => calls.push(['share', result.score]);
  showRunResult(complete);
  elements['#runShare'].onclick();
  return { newBest, behind, first, quit, withShare: panelState(), calls, reloads: location.reloads };
})()`);
ok(shownResult.newBest.title === 'shift.done|SHIFT.JOB.TAXI' && shownResult.newBest.score === '🏆 4,210' && shownResult.newBest.medal === 'shift.medal.silver', 'result shows the job-named title, formatted score and medal label');
ok(shownResult.newBest.best === 'shift.newBest (+620)' && !shownResult.newBest.bestHidden, 'new best line carries the positive delta');
ok(JSON.stringify(shownResult.newBest.stats) === '[["shift.jobsDone",14],["shift.jobsFailed",2]]', 'stats rows render in order');
ok(shownResult.newBest.targetHidden && shownResult.newBest.shareHidden && !shownResult.newBest.panelHidden && shownResult.newBest.hudHidden, 'no target slot or Share without data, panel shown, shift HUD hidden');
ok(shownResult.behind.best === 'shift.bestDelta|3,590|−590' && !shownResult.behind.bestHidden, 'a worse run shows the best value and the signed delta');
ok(shownResult.behind.targetHidden === true, 'target slot stays hidden while the challenge keys are not in the catalogue');
ok(shownResult.first.best === 'shift.firstRun', 'first run line when there is no previous best');
ok(shownResult.quit.medal === '—' && shownResult.quit.bestHidden === true && shownResult.quit.title === 'shift.abandoned|SHIFT.JOB.TAXI', 'abandoned run: no medal glyph, no best line');
ok(shownResult.calls[0][0] === 'launch' && shownResult.calls[0][1] === 'taxi' && shownResult.reloads === 1, 'Retry relaunches the run config and Menu reloads');
ok(shownResult.withShare.shareHidden === false && shownResult.calls[1][0] === 'share' && shownResult.calls[1][1] === 4210, 'Share appears only with a handler and receives the result');

const targetShown = evaluate(makeContext(), `(() => {
  ${resultScreenSetup}
  t = (key, params) => key.startsWith('ch.') ? key + '|' + params.score + '|' + params.from : key;
  runConfig = { mode: 'shift', job: 'taxi', roomCode: 'PSHIFT' };
  const base = { mode: 'shift', job: 'taxi', titleKey: 'shift.done', score: 4820, medal: 'silver', bestBefore: 1, newBest: true, complete: true, stats: [] };
  showRunResult({ ...base, target: { score: 4500, from: 'Marco', beaten: true } });
  const beaten = panelState();
  showRunResult({ ...base, target: { score: 5000, from: 'Marco', beaten: false } });
  return { beaten, missed: panelState() };
})()`);
ok(targetShown.beaten.target === 'ch.targetBeaten|4,500|Marco' && !targetShown.beaten.targetHidden, 'target slot renders t(key, {score, from})');
ok(targetShown.missed.target === 'ch.targetMissed|5,000|Marco', 'target slot picks the missed key when not beaten');

context = makeContext();
const unregistered = evaluate(context, `(() => {
  ${resultScreenSetup}
  gameEvents.enabled = true;
  runConfig = { mode: 'unknown', roomCode: 'PSHIFT' };
  startRun();
  runState.score = 42;
  finishRun('quit');
  return panelState();
})()`);
ok(unregistered.title === 'go.quit' && unregistered.score === '🏆 42' && unregistered.bestHidden === true && !unregistered.panelHidden, 'unregistered mode still gets the results screen');
ok(!read('run.js').includes('showRunFallbackResult') && !read('run.js').includes('#gameOver'), 'the game over fallback is gone');

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
