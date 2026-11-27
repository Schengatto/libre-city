const SHIFT_MINUTES = 5;
const SHIFT_RULES_VERSION = 1;
const JOB_BASE_POINTS = 100;

const MEDAL_THRESHOLDS = {
  taxi: { bronze: 1500, silver: 3000, gold: 4500 },
  pizza: { bronze: 1500, silver: 3000, gold: 4500 },
  ambulance: { bronze: 1500, silver: 3000, gold: 4500 },
  patrol: { bronze: 1200, silver: 2400, gold: 3600 },
  fire: { bronze: 1200, silver: 2400, gold: 3600 },
};

function jobScore({ job, pay, tip, timerLeft, timerTotal } = {}) {
  if (!Object.prototype.hasOwnProperty.call(MEDAL_THRESHOLDS, job)) return 0;
  if (![pay, tip, timerLeft, timerTotal].every(Number.isFinite)) return 0;
  const efficiency = timerTotal > 0 ? Math.min(Math.max(timerLeft / timerTotal, 0), 1) : 0;
  return Math.max(0, Math.round((JOB_BASE_POINTS + 2 * pay + tip) * (0.5 + efficiency)));
}

function shiftMedal(job, shiftScore) {
  if (!Object.prototype.hasOwnProperty.call(MEDAL_THRESHOLDS, job)) return null;
  const { bronze, silver, gold } = MEDAL_THRESHOLDS[job];
  if (shiftScore >= gold) return 'gold';
  if (shiftScore >= silver) return 'silver';
  if (shiftScore >= bronze) return 'bronze';
  return null;
}

if (typeof module !== 'undefined') module.exports = { SHIFT_MINUTES, SHIFT_RULES_VERSION, JOB_BASE_POINTS, MEDAL_THRESHOLDS, jobScore, shiftMedal };
