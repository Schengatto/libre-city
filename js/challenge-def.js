const CHALLENGE_JOB_IDS = ['taxi', 'pizza', 'ambulance', 'patrol', 'fire'];
const CHALLENGE_MUTATOR_POOL = ['night', 'traffic2x', 'glassCars', 'tightClock', 'crowds'];
const CHALLENGE_KINDS = {
  daily: { minutes: 5, mutatorCount: 1, sizeLetter: '' },
  weekly: { minutes: 10, mutatorCount: 2, sizeLetter: 'M' },
};
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CHALLENGE_EPOCH_MS = Date.UTC(2026, 11, 1);
const CHALLENGE_DAY_MS = 86400000;
const CHALLENGE_WEEK_MS = 7 * CHALLENGE_DAY_MS;
const CHALLENGE_MONDAY_OFFSET_MS = 3 * CHALLENGE_DAY_MS;
const CHALLENGE_RETAINED_PERIODS = { daily: 7, weekly: 4 };
const CHALLENGE_SMALL_CITY_ALPHABET = ROOM_ALPHABET.replace(/[PMG]/g, '');
const CHALLENGE_ROOM_CODE_LENGTH = 6;
const CHALLENGE_ID_PATTERNS = {
  daily: /^daily:(\d{4})-(\d{2})-(\d{2})$/,
  weekly: /^weekly:(\d{4})-W(\d{2})$/,
};

function challengeHash(text) {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

function challengeRandom(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function challengeTwoDigits(value) {
  return String(value).padStart(2, '0');
}

function challengePeriodId(kind, startMs) {
  if (kind === 'daily') return 'daily:' + new Date(startMs).toISOString().slice(0, 10);
  const thursday = new Date(startMs + CHALLENGE_MONDAY_OFFSET_MS);
  const weekYear = thursday.getUTCFullYear();
  const weekNumber = Math.floor((thursday.getTime() - Date.UTC(weekYear, 0, 1)) / CHALLENGE_WEEK_MS) + 1;
  return 'weekly:' + weekYear + '-W' + challengeTwoDigits(weekNumber);
}

function challengePeriod(kind, ms) {
  const index = kind === 'daily'
    ? Math.floor(ms / CHALLENGE_DAY_MS)
    : Math.floor((ms + CHALLENGE_MONDAY_OFFSET_MS) / CHALLENGE_WEEK_MS);
  const startMs = kind === 'daily' ? index * CHALLENGE_DAY_MS : index * CHALLENGE_WEEK_MS - CHALLENGE_MONDAY_OFFSET_MS;
  const endsAt = startMs + (kind === 'daily' ? CHALLENGE_DAY_MS : CHALLENGE_WEEK_MS);
  return { index, startMs, endsAt, id: challengePeriodId(kind, startMs) };
}

function isChallengeKind(kind) {
  return Object.prototype.hasOwnProperty.call(CHALLENGE_KINDS, kind);
}

function challengeDefinition(kind, period) {
  const rules = CHALLENGE_KINDS[kind];
  const random = challengeRandom(challengeHash('libre-challenge:v1:' + period.id));
  let roomCode = rules.sizeLetter || CHALLENGE_SMALL_CITY_ALPHABET[Math.floor(random() * CHALLENGE_SMALL_CITY_ALPHABET.length)];
  while (roomCode.length < CHALLENGE_ROOM_CODE_LENGTH) roomCode += ROOM_ALPHABET[Math.floor(random() * ROOM_ALPHABET.length)];
  const shuffledPool = CHALLENGE_MUTATOR_POOL.slice();
  const mutatorCount = Math.min(rules.mutatorCount, shuffledPool.length);
  for (let i = 0; i < mutatorCount; i++) {
    const swapIndex = i + Math.floor(random() * (shuffledPool.length - i));
    [shuffledPool[i], shuffledPool[swapIndex]] = [shuffledPool[swapIndex], shuffledPool[i]];
  }
  const picked = shuffledPool.slice(0, mutatorCount);
  const jobOffset = kind === 'daily' ? 0 : 2;
  return {
    id: period.id,
    kind,
    roomCode,
    job: CHALLENGE_JOB_IDS[(period.index + jobOffset) % CHALLENGE_JOB_IDS.length],
    minutes: rules.minutes,
    mutators: CHALLENGE_MUTATOR_POOL.filter(mutatorId => picked.includes(mutatorId)),
    violence: true,
    endsAt: period.endsAt,
  };
}

function challengeFor(kind, utcDate) {
  const ms = typeof utcDate === 'number' ? utcDate : (utcDate && typeof utcDate.getTime === 'function' ? utcDate.getTime() : NaN);
  if (!isChallengeKind(kind) || !Number.isFinite(ms) || ms < CHALLENGE_EPOCH_MS) return null;
  return challengeDefinition(kind, challengePeriod(kind, ms));
}

function parseChallengeId(id) {
  if (typeof id !== 'string') return null;
  const dailyMatch = CHALLENGE_ID_PATTERNS.daily.exec(id);
  if (dailyMatch) {
    const startMs = Date.UTC(Number(dailyMatch[1]), Number(dailyMatch[2]) - 1, Number(dailyMatch[3]));
    return challengePeriodId('daily', startMs) === id ? { kind: 'daily', startMs } : null;
  }
  const weeklyMatch = CHALLENGE_ID_PATTERNS.weekly.exec(id);
  if (!weeklyMatch) return null;
  const weekNumber = Number(weeklyMatch[2]);
  if (weekNumber < 1 || weekNumber > 53) return null;
  const januaryFourth = Date.UTC(Number(weeklyMatch[1]), 0, 4);
  const firstMonday = januaryFourth - ((new Date(januaryFourth).getUTCDay() + 6) % 7) * CHALLENGE_DAY_MS;
  const startMs = firstMonday + (weekNumber - 1) * CHALLENGE_WEEK_MS;
  return challengePeriodId('weekly', startMs) === id ? { kind: 'weekly', startMs } : null;
}

function challengeById(id) {
  const parsed = parseChallengeId(id);
  if (!parsed) return null;
  const period = challengePeriod(parsed.kind, parsed.startMs);
  return period.endsAt > CHALLENGE_EPOCH_MS ? challengeDefinition(parsed.kind, period) : null;
}

function currentChallengeIds(ms) {
  return { daily: challengePeriod('daily', ms).id, weekly: challengePeriod('weekly', ms).id };
}

function isChallengeRetained(id, ms) {
  const parsed = parseChallengeId(id);
  if (!parsed) return false;
  const period = challengePeriod(parsed.kind, parsed.startMs);
  const periodsAgo = challengePeriod(parsed.kind, ms).index - period.index;
  return period.endsAt > CHALLENGE_EPOCH_MS && periodsAgo >= 0 && periodsAgo < CHALLENGE_RETAINED_PERIODS[parsed.kind];
}

if (typeof module !== 'undefined') {
  module.exports = {
    CHALLENGE_JOB_IDS, CHALLENGE_MUTATOR_POOL, CHALLENGE_KINDS, ROOM_ALPHABET, CHALLENGE_EPOCH_MS,
    challengeFor, parseChallengeId, challengeById, currentChallengeIds, isChallengeRetained,
  };
}
