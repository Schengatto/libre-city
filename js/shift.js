const SHIFT_ROOM_CODE = 'PSHIFT';
const SHIFT_JOBS = ['taxi', 'pizza', 'ambulance', 'patrol', 'fire'];
const SHIFT_RECOVERY_FRAMES = 180;
const SHIFT_RECOVERY_RADIUS = 400;
const SHIFT_SPAWN_RADII = [320, 600, 1200];
const SHIFT_GO_MESSAGE_MS = 2000;
const SHIFT_MEDAL_ICONS = { gold: '🥇', silver: '🥈', bronze: '🥉' };
const SHIFT_MEDAL_ORDER = ['bronze', 'silver', 'gold'];
const SHIFT_VEHICLE_KINDS = { taxi: 'taxi', pizza: 'delivery', ambulance: 'ambulance', patrol: 'police', fire: 'fire' };
const SHIFT_SERVICE_TYPES = { pizza: 'pizzeria', ambulance: 'hospital', patrol: 'police', fire: 'fire' };

let shiftOnFootFrames = 0;

const isShiftRun = () => !!runConfig && runConfig.mode === 'shift';

const formatShiftScore = value => Number(value).toLocaleString('en-US');

function shiftBestEntry(job) {
  const entry = store.get('shiftBests', {})[job];
  if (!entry || !Number.isFinite(entry.score)) return null;
  return { score: entry.score, medal: entry.medal || null, current: entry.rules === SHIFT_RULES_VERSION };
}

function nextShiftMedal(job, score) {
  const thresholds = MEDAL_THRESHOLDS[job];
  const medal = SHIFT_MEDAL_ORDER.find(name => score < thresholds[name]);
  return medal ? { medal, threshold: thresholds[medal] } : null;
}

function shiftVehicleFor(job, point) {
  if (job === 'taxi') return makeTaxi(makeParked(point.x, point.y, point.angle));
  return makeServiceCar(SHIFT_SERVICE_TYPES[job], point);
}

function shiftSpawnSpot() {
  for (const radius of SHIFT_SPAWN_RADII) {
    const spot = randomParkingNear(player.x, player.y, 40, radius);
    if (spot) return spot;
  }
  return null;
}

function seatPlayerIn(car) {
  player.car = car; car.driver = 'player';
  player.x = car.x; player.y = car.y;
  gameEvents.emit('vehicle:enter', { vehicleKind: vehicleKindOf(car) });
  car.role = 'player';
  netAssignCarId(car);
  armMissionForCar();
}

function showShiftGoMessage(job) {
  const panel = $('#bigMsg'); if (!panel) return;
  panel.classList.remove('hidden', 'busted');
  $('#bigTitle').textContent = t('shift.go', { job: t('shift.job.' + job).toUpperCase() });
  $('#bigCount').textContent = '';
  setTimeout(() => { if (downT <= 0) panel.classList.add('hidden'); }, SHIFT_GO_MESSAGE_MS);
}

function updateShiftHud() {
  const el = $('#shiftHud'); if (!el) return;
  const active = !!runState && runState.mode === 'shift';
  el.classList.toggle('hidden', !active);
  if (active) el.textContent = runModes.shift.hud(runState);
}

function isFreeShiftVehicle(car, job) {
  return !car.driver && vehicleKindOf(car) === SHIFT_VEHICLE_KINDS[job];
}

function updateShiftRecovery() {
  const job = runConfig.job;
  if (player.car || cars.some(car => isFreeShiftVehicle(car, job) && dist(car.x, car.y, player.x, player.y) <= SHIFT_RECOVERY_RADIUS)) {
    shiftOnFootFrames = 0;
    return;
  }
  if (++shiftOnFootFrames < SHIFT_RECOVERY_FRAMES) return;
  const spot = shiftSpawnSpot();
  if (!spot) return;
  shiftOnFootFrames = 0;
  cars.push(shiftVehicleFor(job, spot));
  toast(t('shift.newVehicle'));
}

function renderShiftPanel() {
  const list = $('#shiftList'); if (!list) return;
  list.textContent = '';
  let closest = null;
  for (const job of SHIFT_JOBS) {
    const best = shiftBestEntry(job);
    const row = document.createElement('div'); row.className = 'shiftRow';
    const name = document.createElement('span'); name.className = 'shiftJob'; name.textContent = t('shift.job.' + job);
    const bestLabel = document.createElement('span'); bestLabel.className = 'shiftBest';
    if (!best) bestLabel.textContent = t('shift.noBest');
    else {
      bestLabel.textContent = t('shift.best', { score: formatShiftScore(best.score) }) + (best.medal ? ' ' + SHIFT_MEDAL_ICONS[best.medal] : '');
      if (!best.current) { bestLabel.classList.add('old'); bestLabel.title = t('shift.oldRules'); }
    }
    const start = document.createElement('button'); start.className = 'mbtn shiftStart'; start.textContent = t('shift.start');
    start.onclick = () => launchRun({ mode: 'shift', job, minutes: SHIFT_MINUTES, roomCode: SHIFT_ROOM_CODE, mutators: [] });
    row.append(name, bestLabel, start);
    list.appendChild(row);
    const currentBest = best && best.current ? best.score : 0;
    const next = nextShiftMedal(job, currentBest);
    if (next && (!closest || next.threshold - currentBest < closest.gap)) closest = { job, gap: next.threshold - currentBest, next };
  }
  const nextLabel = $('#shiftNext'); if (!nextLabel) return;
  nextLabel.textContent = closest
    ? t('shift.nextMedal', { medal: SHIFT_MEDAL_ICONS[closest.next.medal], score: formatShiftScore(closest.next.threshold), job: t('shift.job.' + closest.job) })
    : '';
}

runModes.shift = {
  start(config) {
    gameMinutes = config.minutes;
    missionsOn = true;
    shiftOnFootFrames = 0;
    const car = shiftVehicleFor(config.job, shiftSpawnSpot() || { x: player.x, y: player.y, angle: 0 });
    cars.push(car);
    seatPlayerIn(car);
    updateScore();
    updateShiftHud();
    showShiftGoMessage(config.job);
  },
  result(state, outcome) {
    const complete = outcome === 'time';
    const best = shiftBestEntry(state.job);
    const bestBefore = best && best.current ? best.score : null;
    return {
      mode: 'shift', job: state.job, titleKey: complete ? 'shift.done' : 'shift.abandoned', score: state.score,
      medal: complete ? shiftMedal(state.job, state.score) : null, bestBefore,
      newBest: complete && state.score > (bestBefore === null ? 0 : bestBefore), complete,
      stats: [{ key: 'shift.jobsDone', value: state.jobsDone }, { key: 'shift.jobsFailed', value: state.jobsFailed }],
    };
  },
  hud(state) {
    const head = t('shift.hud', {
      job: t('shift.job.' + state.job).toUpperCase(), score: formatShiftScore(state.score), done: state.jobsDone, failed: state.jobsFailed,
    });
    const next = nextShiftMedal(state.job, state.score);
    return next ? head + '   ' + t('shift.hudNext', { medal: SHIFT_MEDAL_ICONS[next.medal], score: formatShiftScore(next.threshold) }) : head;
  },
};

gameEvents.on('job:complete', payload => {
  if (!isShiftRun() || !runState || runState.ended || payload.job !== runState.job) return;
  const points = jobScore(payload) * runScoreMultiplier(payload);
  runState.score += points;
  runState.jobsDone++;
  scorePop(points, player.x, player.y);
  updateShiftHud();
});

gameEvents.on('job:fail', payload => {
  if (!isShiftRun() || !runState || runState.ended || payload.job !== runState.job) return;
  runState.jobsFailed++;
  updateShiftHud();
});
