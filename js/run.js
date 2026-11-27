let runConfig = null;
let runState = null;
const runModes = {};

const RUN_LOG_TYPES = ['run:start', 'job:pickup', 'job:start', 'job:complete', 'job:fail', 'wanted:change', 'player:down', 'vehicle:enter', 'vehicle:damage', 'run:end'];
const RUN_LOG_MAX = 600;
const RUN_LOG_DAMAGE_MIN = 4;
const RUN_MEDAL_GLYPHS = { gold: '🥇', silver: '🥈', bronze: '🥉' };
const RUN_NO_MEDAL_GLYPH = '—';
const RUN_TARGET_KEYS = { beaten: 'ch.targetBeaten', missed: 'ch.targetMissed' };

let runScoreMultiplier = () => 1;
let runShareHandler = null;

function launchRun(config) {
  store.set('spIntent', { code: config.roomCode, mins: config.minutes || 0, violence: true, name: playerName, runConfig: config });
  location.hash = 'room=' + config.roomCode;
  location.reload();
}

function startRun() {
  if (!runConfig) return;
  runState = {
    mode: runConfig.mode, job: runConfig.job || null, score: 0, jobsDone: 0, jobsFailed: 0,
    startFrame: matchElapsedFrames, log: [], logTruncated: false, ended: false,
  };
  if (typeof resetJobRandom === 'function') resetJobRandom();
  gameEvents.emit('run:start', {
    mode: runState.mode, job: runState.job, rules: SHIFT_RULES_VERSION, mutators: (runConfig.mutators || []).slice(),
  });
  const mode = runModes[runConfig.mode];
  if (mode && mode.start) mode.start(runConfig);
}

function recordRunEvent(type, payload) {
  if (!runState || runState.ended) return;
  if (type === 'vehicle:damage' && !(payload.amount >= RUN_LOG_DAMAGE_MIN)) return;
  if (runState.log.length >= RUN_LOG_MAX) { runState.logTruncated = true; return; }
  runState.log.push(Object.assign({ type, frame: payload.frame }, payload));
}

for (const type of RUN_LOG_TYPES) gameEvents.on(type, payload => recordRunEvent(type, payload));

function buildRunResult(state, outcome) {
  const mode = runModes[state.mode];
  if (mode && mode.result) return mode.result(state, outcome);
  return { mode: state.mode, job: state.job, titleKey: null, score: state.score, medal: null, bestBefore: null, newBest: false, complete: outcome === 'time', stats: [] };
}

const formatRunScore = value => Number(value).toLocaleString('en-US');

const formatRunDelta = delta => (delta < 0 ? '−' : '+') + formatRunScore(Math.abs(delta));

const hasRunMutators = () => !!runConfig.mutators && runConfig.mutators.length > 0;

function runBestLine(result) {
  if (!result.complete) return '';
  if (result.bestBefore === null) return t('shift.firstRun');
  const delta = formatRunDelta(result.score - result.bestBefore);
  return result.newBest ? t('shift.newBest') + ' (' + delta + ')' : t('shift.bestDelta', { best: formatRunScore(result.bestBefore), delta });
}

function runTargetLine(target) {
  if (!target) return '';
  const key = target.beaten ? RUN_TARGET_KEYS.beaten : RUN_TARGET_KEYS.missed;
  const text = t(key, { score: formatRunScore(target.score), from: target.from });
  return text === key ? '' : text;
}

function renderRunStats(container, stats) {
  container.textContent = '';
  for (const stat of stats) {
    const row = document.createElement('div'); row.className = 'runStat';
    const label = document.createElement('span'); label.textContent = t(stat.key);
    const value = document.createElement('b'); value.textContent = stat.value;
    row.append(label, value);
    container.appendChild(row);
  }
}

function showRunResult(result) {
  const panel = $('#runResultPanel'); if (!panel) return;
  const hud = $('#shiftHud'); if (hud) hud.classList.add('hidden');
  const jobName = result.job ? t('shift.job.' + result.job).toUpperCase() : '';
  $('#runResultTitle').textContent = t(result.titleKey || (result.complete ? 'go.time' : 'go.quit'), { job: jobName });
  $('#runResultScore').textContent = '🏆 ' + formatRunScore(result.score);
  $('#runResultMedal').textContent = RUN_MEDAL_GLYPHS[result.medal] ? t('shift.medal.' + result.medal) : RUN_NO_MEDAL_GLYPH;
  const bestLine = runBestLine(result);
  $('#runResultBest').textContent = bestLine;
  $('#runResultBest').classList.toggle('hidden', !bestLine);
  const targetLine = runTargetLine(result.target);
  $('#runResultTarget').textContent = targetLine;
  $('#runResultTarget').classList.toggle('hidden', !targetLine);
  renderRunStats($('#runResultStats'), result.stats);
  $('#runRetry').onclick = () => launchRun(runConfig);
  $('#runShare').classList.toggle('hidden', typeof runShareHandler !== 'function');
  $('#runShare').onclick = () => runShareHandler(result);
  $('#runMenu').onclick = () => location.reload();
  panel.classList.remove('hidden');
}

function finishRun(outcome) {
  if (!runState || runState.ended) return;
  const result = buildRunResult(runState, outcome);
  const target = runConfig && runConfig.target;
  result.target = target ? { score: target.score, from: target.from, beaten: result.score > target.score } : null;
  gameEvents.emit('run:end', {
    mode: result.mode, job: result.job, score: result.score, medal: result.medal, complete: result.complete,
    newBest: result.newBest, bestBefore: result.bestBefore, jobsDone: runState.jobsDone, jobsFailed: runState.jobsFailed,
  });
  runState.ended = true;
  gameEvents.enabled = false;
  showRunResult(result);
}
