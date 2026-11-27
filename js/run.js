let runConfig = null;
let runState = null;
const runModes = {};

const RUN_LOG_TYPES = ['run:start', 'job:pickup', 'job:start', 'job:complete', 'job:fail', 'wanted:change', 'player:down', 'vehicle:enter', 'vehicle:damage', 'run:end'];
const RUN_LOG_MAX = 600;
const RUN_LOG_DAMAGE_MIN = 4;

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

function showRunFallbackResult(result) {
  const title = $('#goTitle'); if (title) title.textContent = t(result.complete ? 'go.time' : 'go.quit');
  const score = $('#goScore'); if (score) score.textContent = '🏆 ' + result.score;
  const rank = $('#goRank'); if (rank) rank.textContent = '';
  const ladder = $('#goLadderWrap'); if (ladder) ladder.classList.add('hidden');
  const panel = $('#gameOver'); if (panel) panel.classList.remove('hidden');
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
  if (typeof showRunResult === 'function') showRunResult(result);
  else showRunFallbackResult(result);
}
