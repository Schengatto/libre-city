const TUNING_DEFAULTS = Object.freeze({
  civilianCap: 26,
  civilianSpawnEvery: 8,
  trafficCap: 14,
  trafficSpawnEvery: 12,
  copRange: 330,
  copFireCdMin: 42,
  copFireCdMax: 66,
  copsPerStar: 1,
  crimeHeatScale: 1,
  heatDecay: 0.0016,
  carDamageScale: 1,
  jobTimerScale: 1,
  forceNight: false,
});
const TUNING = { ...TUNING_DEFAULTS };

const MUTATOR_IDS = ['night', 'traffic2x', 'copsAggro', 'glassCars', 'tightClock', 'crowds'];
const MUTATORS = {
  night: { icon: '🌙', tuning: { forceNight: true } },
  traffic2x: { icon: '🚗', tuning: { trafficCap: 28, trafficSpawnEvery: 6 } },
  copsAggro: { icon: '🚨', tuning: { copRange: 450, copFireCdMin: 28, copFireCdMax: 44, copsPerStar: 1.5, crimeHeatScale: 1.5, heatDecay: 0.0008 } },
  glassCars: { icon: '💥', tuning: { carDamageScale: 2 } },
  tightClock: { icon: '⏱️', tuning: { jobTimerScale: 0.7 } },
  crowds: { icon: '👥', tuning: { civilianCap: 52, civilianSpawnEvery: 4 } },
};
const MUTATOR_CONFLICTS = [];
const MS_PER_WEEK = 7 * 86400000;
const MS_MONDAY_OFFSET = 3 * 86400000;
let activeMutatorIds = [];

function isMutatorId(id) {
  return typeof id === 'string' && MUTATOR_IDS.includes(id);
}

function sanitizeMutatorIds(list) {
  if (!Array.isArray(list)) return [];
  const requested = new Set(list.filter(isMutatorId));
  const kept = [];
  for (const id of MUTATOR_IDS) {
    if (!requested.has(id)) continue;
    const conflictsWithKept = MUTATOR_CONFLICTS.some(([first, second]) => (id === first && kept.includes(second)) || (id === second && kept.includes(first)));
    if (!conflictsWithKept) kept.push(id);
  }
  return kept;
}

function resetMutators() {
  Object.assign(TUNING, TUNING_DEFAULTS);
  activeMutatorIds = [];
}

function applyMutators(ids) {
  if (typeof netActive === 'function' && netActive()) return [];
  resetMutators();
  const sanitized = sanitizeMutatorIds(ids);
  for (const id of sanitized) Object.assign(TUNING, MUTATORS[id].tuning);
  activeMutatorIds = sanitized;
  return sanitized;
}

function utcWeekIndex(ms) {
  return Math.floor((ms + MS_MONDAY_OFFSET) / MS_PER_WEEK);
}

function mutatorOfWeek(ms) {
  return MUTATOR_IDS[utcWeekIndex(ms) % MUTATOR_IDS.length];
}
