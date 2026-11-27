import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import runtime from './sim-runtime.js';
import stubs from '../js/sim-stubs.js';

const { BUNDLE, JS_DIR } = runtime;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const context = vm.createContext(stubs.makeSimStubs('PSHIFT', 900, { setTimeout, clearTimeout, setInterval, clearInterval }));
vm.runInContext(BUNDLE, context, { timeout: 5000 });
for (const file of ['job-score.js', 'run.js', 'shift.js']) vm.runInContext(fs.readFileSync(path.join(JS_DIR, file), 'utf8'), context, { filename: file });
vm.runInContext(`
  var armCalls = 0;
  function armMissionForCar() { armCalls++; }
  function updateScore() {}
  var toasts = [];
  toast = message => toasts.push(message);
  var launched = [];
  launchRun = config => launched.push(config);
  gameEvents.enabled = true;
`, context);
const exec = source => { vm.runInContext(source, context); };
const run = expr => {
  const serialized = vm.runInContext(`JSON.stringify((() => { const value = (${expr}); return value === undefined ? null : value; })())`, context);
  return JSON.parse(serialized);
};

const resetRun = (job) => run(`(() => {
  runConfig = { mode: 'shift', job: '${job}', minutes: 5, roomCode: 'PSHIFT', mutators: [] };
  runState = { mode: 'shift', job: '${job}', score: 0, jobsDone: 0, jobsFailed: 0, startFrame: 0, log: [], logTruncated: false, ended: false };
  runScoreMultiplier = () => 1;
  return true;
})()`);

console.log('1) PSHIFT city holds the four landmark types');
const landmarkTypes = run('[...new Set(landmarks.map(l => l.type))]');
for (const type of ['police', 'hospital', 'fire', 'pizzeria']) ok(landmarkTypes.includes(type), `landmark ${type} exists`);
ok(run('SHIFT_ROOM_CODE') === 'PSHIFT' && run('SHIFT_JOBS').join() === 'taxi,pizza,ambulance,patrol,fire', 'room code and job list');

console.log('2) scoring from synthetic events');
resetRun('taxi');
const taxiComplete = { job: 'taxi', pay: 50, tip: 10, timerLeft: 400, timerTotal: 800 };
const expectedPoints = run(`jobScore(${JSON.stringify(taxiComplete)})`);
exec(`gameEvents.emit('job:complete', ${JSON.stringify(taxiComplete)})`);
let state = run('runState');
ok(state.score === expectedPoints && state.jobsDone === 1, `taxi completion scores jobScore (${state.score} = ${expectedPoints})`);
exec(`gameEvents.emit('job:complete', ${JSON.stringify({ ...taxiComplete, job: 'pizza' })})`);
exec(`gameEvents.emit('job:complete', ${JSON.stringify({ ...taxiComplete, job: 'fire' })})`);
state = run('runState');
ok(state.score === expectedPoints && state.jobsDone === 1, 'completions of other jobs are ignored');
exec("gameEvents.emit('job:fail', { job: 'taxi', reason: 'late' })");
exec("gameEvents.emit('job:fail', { job: 'pizza', reason: 'late' })");
ok(run('runState.jobsFailed') === 1, 'only the failure of the shift job counts');
exec('runScoreMultiplier = () => 2');
exec(`gameEvents.emit('job:complete', ${JSON.stringify(taxiComplete)})`);
ok(run('runState.score') === expectedPoints * 3 && run('runState.jobsDone') === 2, 'runScoreMultiplier scales the points');
exec('runConfig = null');
exec(`gameEvents.emit('job:complete', ${JSON.stringify(taxiComplete)})`);
ok(run('runState.jobsDone') === 2, 'no scoring outside a shift');
resetRun('taxi');
exec('runScoreMultiplier = () => 1.5');
exec(`gameEvents.emit('job:complete', ${JSON.stringify(taxiComplete)})`);
ok(run('runState.score') === Math.round(expectedPoints * 1.5) && Number.isInteger(run('runState.score')), 'points are rounded before they accumulate');
resetRun('taxi');
exec('var savedMultiplayerState = MP; MP = null; pops.length = 0');
exec(`gameEvents.emit('job:complete', ${JSON.stringify(taxiComplete)}); addScore(150, player.x, player.y)`);
ok(run('pops.length') === 1 && run('pops[0].text') === '+' + expectedPoints, 'a scored shift job leaves exactly one pop, with the shift points');
exec('pops.length = 0; runConfig = null; addScore(150, player.x, player.y)');
ok(run('pops.length') === 1 && run('pops[0].text') === '+150', 'free play still pops the trophy points');
exec('MP = savedMultiplayerState; pops.length = 0');

console.log('3) HUD, medals and result');
resetRun('taxi');
exec('runState.score = 2340; runState.jobsDone = 7; runState.jobsFailed = 1');
const hudText = run('runModes.shift.hud(runState)');
ok(hudText.includes('2,340') && hudText.includes('✓ 7') && hudText.includes('✗ 1') && hudText.includes('🥈') && hudText.includes('3,000'), `HUD shows score, counts and next medal (${hudText})`);
ok(run("nextShiftMedal('taxi', 4500)") === null, 'no next medal once gold is reached');
const completed = run("runModes.shift.result(runState, 'time')");
ok(completed.medal === 'bronze' && completed.complete === true && completed.newBest === true, 'complete shift earns a medal from its score');
ok(run("(() => { runState.score = 3100; return runModes.shift.result(runState, 'time'); })()").medal === 'silver', 'higher score earns the silver medal');
ok(completed.stats[0].value === 7 && completed.stats[1].value === 1, 'result carries jobs done and failed');
const abandoned = run("runModes.shift.result(runState, 'quit')");
ok(abandoned.medal === null && abandoned.complete === false && abandoned.newBest === false && abandoned.titleKey === 'shift.abandoned', 'abandoned shift has no medal and no best');

console.log('4) shift start seats the player in the right vehicle');
const startedVehicles = {};
for (const [job, check] of [['taxi', 'car.isTaxi'], ['pizza', 'car.isDelivery'], ['ambulance', "car.livery === 'ambulance'"], ['patrol', 'car.wasPolice'], ['fire', "car.livery === 'fire'"]]) {
  startedVehicles[job] = run(`(() => {
    runConfig = { mode: 'shift', job: '${job}', minutes: 5, roomCode: 'PSHIFT', mutators: [] };
    runState = { mode: 'shift', job: '${job}', score: 0, jobsDone: 0, jobsFailed: 0, startFrame: 0, log: [], logTruncated: false, ended: false };
    missionsOn = false; armCalls = 0; player.car = null;
    runModes.shift.start(runConfig);
    const car = player.car;
    return !!car && car.driver === 'player' && (${check}) && cars.includes(car) && missionsOn === true && armCalls === 1 && gameMinutes === 5;
  })()`);
  ok(startedVehicles[job] === true, `${job} shift starts seated in its vehicle with jobs on`);
}

console.log('5) vehicle recovery after 180 frames on foot');
resetRun('taxi');
const recovery = run(`(() => {
  cars.length = 0; toasts.length = 0; player.car = null;
  const snapshot = () => cars.filter(c => c.isTaxi).length;
  for (let i = 0; i < SHIFT_RECOVERY_FRAMES - 1; i++) updateShiftRecovery();
  const before = snapshot();
  updateShiftRecovery();
  const spawned = cars.find(c => c.isTaxi);
  return { before, after: snapshot(), toasted: toasts.length, free: !!spawned && !spawned.driver };
})()`);
ok(recovery.before === 0 && recovery.after === 1 && recovery.toasted === 1 && recovery.free, 'a taxi spawns on frame 180, not before, with a toast');
const spawnRuns = run(`(() => {
  const results = [];
  player.car = null;
  for (let trial = 0; trial < 30; trial++) {
    cars.length = 0; shiftOnFootFrames = 0;
    for (let i = 0; i < SHIFT_RECOVERY_FRAMES; i++) updateShiftRecovery();
    const spawned = cars.filter(c => c.isTaxi);
    const distance = spawned.length ? dist(spawned[0].x, spawned[0].y, player.x, player.y) : null;
    for (let i = 0; i < SHIFT_RECOVERY_FRAMES * 3; i++) updateShiftRecovery();
    results.push({ distance, total: cars.length });
  }
  return results;
})()`);
ok(spawnRuns.every(r => r.distance !== null && r.distance <= 400), `recovered vehicle always lies within 400 px (max ${Math.max(...spawnRuns.map(r => r.distance))})`);
ok(spawnRuns.every(r => r.total === 1), 'no second recovery while the recovered vehicle stays there');
const noSpotRetry = run(`(() => {
  const original = randomParkingNear;
  let searches = 0;
  randomParkingNear = () => { searches++; return null; };
  cars.length = 0; shiftOnFootFrames = 0; player.car = null;
  for (let i = 0; i < SHIFT_RECOVERY_FRAMES * 2; i++) updateShiftRecovery();
  randomParkingNear = original;
  return searches;
})()`);
ok(noSpotRetry === 2, `without a free spot the search repeats only every 180 frames (${noSpotRetry} searches in 360 frames)`);
const nearbyKeepsCounter = run(`(() => {
  cars.length = 0; toasts.length = 0; player.car = null; shiftOnFootFrames = 0;
  cars.push(shiftVehicleFor('taxi', { x: player.x + 200, y: player.y, angle: 0 }));
  for (let i = 0; i < SHIFT_RECOVERY_FRAMES * 2; i++) updateShiftRecovery();
  return cars.length;
})()`);
ok(nearbyKeepsCounter === 1, 'a job vehicle within 400 px prevents recovery');
const farTriggers = run(`(() => {
  cars.length = 0; player.car = null; shiftOnFootFrames = 0;
  cars.push(shiftVehicleFor('taxi', { x: player.x + SHIFT_RECOVERY_RADIUS + 100, y: player.y, angle: 0 }));
  for (let i = 0; i < SHIFT_RECOVERY_FRAMES; i++) updateShiftRecovery();
  return cars.length;
})()`);
ok(farTriggers === 2, 'a job vehicle beyond 400 px does not count');
const drivingNoRecovery = run(`(() => {
  cars.length = 0; player.car = { x: player.x, y: player.y }; shiftOnFootFrames = 0;
  for (let i = 0; i < SHIFT_RECOVERY_FRAMES * 2; i++) updateShiftRecovery();
  player.car = null;
  return cars.length;
})()`);
ok(drivingNoRecovery === 0, 'no recovery while driving');
const occupiedIgnored = run(`(() => {
  cars.length = 0; player.car = null; shiftOnFootFrames = 0;
  const taken = shiftVehicleFor('taxi', { x: player.x + 50, y: player.y, angle: 0 });
  taken.driver = 'npc';
  cars.push(taken);
  for (let i = 0; i < SHIFT_RECOVERY_FRAMES; i++) updateShiftRecovery();
  return cars.length;
})()`);
ok(occupiedIgnored === 2, 'an occupied job vehicle does not count');

console.log('6) shift panel rows and launch');
run(`(() => {
  const makeElement = () => {
    const element = { className: '', textContent: '', title: '', children: [],
      append(...nodes) { this.children.push(...nodes); }, appendChild(node) { this.children.push(node); } };
    element.classList = { add(name) { element.className += ' ' + name; } };
    return element;
  };
  const registry = { '#shiftList': makeElement(), '#shiftNext': makeElement() };
  document = { createElement: makeElement };
  globalRegistry = registry;
  $ = selector => registry[selector] || null;
  store.get = (key, fallback) => key === 'shiftBests'
    ? { taxi: { score: 3420, medal: 'silver', jobs: 9, rules: SHIFT_RULES_VERSION, date: 1 }, fire: { score: 900, medal: null, jobs: 3, rules: 0, date: 1 } }
    : fallback;
  renderShiftPanel();
  return true;
})()`);
const panel = run(`({
  rows: globalRegistry['#shiftList'].children.map(row => ({ job: row.children[0].textContent, best: row.children[1].textContent, old: row.children[1].className.includes('old') })),
  next: globalRegistry['#shiftNext'].textContent,
})`);
ok(panel.rows.length === 5, 'five job rows');
ok(panel.rows[0].best.includes('3,420') && panel.rows[0].best.includes('🥈') && !panel.rows[0].old, `taxi row shows best and medal (${panel.rows[0].best})`);
ok(panel.rows[1].best === run("t('shift.noBest')"), 'job without a best shows the placeholder');
ok(panel.rows[4].old === true && panel.rows[4].best.includes('900'), 'best under old rules is flagged');
ok(panel.next.includes('4,500') && panel.next.includes('🥇'), `next medal line (${panel.next})`);
run("globalRegistry['#shiftList'].children[2].children[2].onclick()");
const launched = run('launched');
ok(launched.length === 1 && launched[0].mode === 'shift' && launched[0].job === 'ambulance' && launched[0].minutes === 5 && launched[0].roomCode === 'PSHIFT' && launched[0].mutators.length === 0, 'Start launches the shift run with no mutators');

console.log('6) personal bests');
exec(`
  var savedBests = {};
  store.get = (key, fallback) => key === 'shiftBests' ? savedBests : fallback;
  store.set = (key, value) => { if (key === 'shiftBests') savedBests = value; };
`);
const finishShift = (config, score, outcome = 'time') => run(`(() => {
  gameEvents.enabled = true;
  runConfig = Object.assign({ mode: 'shift', job: 'taxi', minutes: 5, roomCode: 'PSHIFT', mutators: [] }, ${JSON.stringify(config)});
  runState = { mode: 'shift', job: 'taxi', score: ${score}, jobsDone: 6, jobsFailed: 1, startFrame: 0, log: [], logTruncated: false, ended: false };
  shownResults = [];
  showRunResult = result => shownResults.push(result);
  finishRun('${outcome}');
  return { result: shownResults[0], bests: savedBests };
})()`);
exec('var shownResults = []');
let finished = finishShift({}, 3100);
ok(finished.bests.taxi && finished.bests.taxi.score === 3100 && finished.bests.taxi.medal === 'silver' && finished.bests.taxi.jobs === 6 && finished.bests.taxi.rules === run('SHIFT_RULES_VERSION') && Number.isFinite(finished.bests.taxi.date), 'first complete shift writes the best with score, medal, jobs, rules and date');
ok(finished.result.bestBefore === null && finished.result.newBest === true, 'first shift has no previous best');
finished = finishShift({}, 1200);
ok(finished.bests.taxi.score === 3100 && finished.bests.taxi.medal === 'silver' && finished.result.newBest === false && finished.result.bestBefore === 3100, 'a lower score keeps the stored best and medal');
finished = finishShift({}, 4600);
ok(finished.bests.taxi.score === 4600 && finished.bests.taxi.medal === 'gold' && finished.result.newBest === true, 'a higher score overwrites the best and raises the medal');
exec("savedBests.taxi.medal = 'gold'; savedBests.taxi.score = 3000");
finished = finishShift({}, 3200);
ok(finished.bests.taxi.score === 3200 && finished.bests.taxi.medal === 'gold', 'the best medal never downgrades when a higher score earns a lower medal');
finished = finishShift({}, 9000, 'quit');
ok(finished.bests.taxi.score === 3200 && finished.result.medal === null && finished.result.newBest === false, 'an abandoned shift records nothing');
finished = finishShift({ mutators: ['fog'] }, 9000);
ok(finished.bests.taxi.score === 3200 && finished.result.newBest === false, 'a run with mutators writes no best');
exec(`savedBests = { taxi: { score: 9000, medal: 'gold', jobs: 20, rules: ${run('SHIFT_RULES_VERSION')} - 1, date: 1 } }`);
finished = finishShift({}, 500);
ok(finished.result.bestBefore === null && finished.result.newBest === true, 'an old-rules best is ignored for the delta and the new best');
ok(finished.bests.taxi.score === 500 && finished.bests.taxi.medal === null && finished.bests.taxi.rules === run('SHIFT_RULES_VERSION'), 'the first complete run under the current rules overwrites an old-rules best');
exec("savedBests = null");
ok(run("readShiftBests()") !== null && Object.keys(run('readShiftBests()')).length === 0, 'a corrupt stored value reads as no bests');

console.log(fail === 0 ? `\n✅  ${pass} ok, 0 fail` : `\n❌  ${pass} ok, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
