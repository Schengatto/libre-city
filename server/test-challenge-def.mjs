import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readSource, extractTopLevel } from './render-test-kit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(here, '..', 'js', 'challenge-def.js');
const require = createRequire(import.meta.url);
const challenges = require(modulePath);
const {
  CHALLENGE_JOB_IDS, CHALLENGE_MUTATOR_POOL, CHALLENGE_KINDS, ROOM_ALPHABET, CHALLENGE_EPOCH_MS,
  challengeFor, parseChallengeId, challengeById, currentChallengeIds, isChallengeRetained,
} = challenges;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };
const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;

const GOLDEN_DAILY = [
  ['daily:2026-12-01', 'UVR3NT', 'patrol', ['night'], 1796169600000],
  ['daily:2026-12-02', 'Z89MPK', 'fire', ['crowds'], 1796256000000],
  ['daily:2026-12-03', 'HDBGPA', 'taxi', ['night'], 1796342400000],
  ['daily:2026-12-04', '4WQSVF', 'pizza', ['traffic2x'], 1796428800000],
  ['daily:2026-12-05', '5Q843J', 'ambulance', ['crowds'], 1796515200000],
  ['daily:2026-12-06', 'NGUBQC', 'patrol', ['night'], 1796601600000],
  ['daily:2026-12-07', '4PQB6A', 'fire', ['night'], 1796688000000],
  ['daily:2026-12-08', '3EXRZG', 'taxi', ['night'], 1796774400000],
  ['daily:2026-12-09', 'N3ESZK', 'pizza', ['crowds'], 1796860800000],
  ['daily:2026-12-10', 'B7U3J8', 'ambulance', ['glassCars'], 1796947200000],
  ['daily:2026-12-11', 'E8R8X7', 'patrol', ['tightClock'], 1797033600000],
  ['daily:2026-12-12', '3W5VV7', 'fire', ['tightClock'], 1797120000000],
  ['daily:2026-12-13', '8VNWHE', 'taxi', ['glassCars'], 1797206400000],
  ['daily:2026-12-14', 'DTJ8SN', 'pizza', ['glassCars'], 1797292800000],
];
const GOLDEN_WEEKLY = [
  ['weekly:2026-W49', 'MFD86C', 'ambulance', ['traffic2x', 'tightClock'], 1796601600000],
  ['weekly:2026-W50', 'MH9MRW', 'patrol', ['traffic2x', 'glassCars'], 1797206400000],
  ['weekly:2026-W51', 'MYTGCJ', 'fire', ['tightClock', 'crowds'], 1797811200000],
  ['weekly:2026-W52', 'MDUZTC', 'taxi', ['traffic2x', 'glassCars'], 1798416000000],
];
const asGoldenRow = definition => JSON.stringify([definition.id, definition.roomCode, definition.job, definition.mutators, definition.endsAt]);

console.log('1) constants');
ok(JSON.stringify(CHALLENGE_JOB_IDS) === JSON.stringify(['taxi', 'pizza', 'ambulance', 'patrol', 'fire']), 'CHALLENGE_JOB_IDS matches the spec');
ok(JSON.stringify(CHALLENGE_MUTATOR_POOL) === JSON.stringify(['night', 'traffic2x', 'glassCars', 'tightClock', 'crowds']), 'CHALLENGE_MUTATOR_POOL matches the spec');
ok(JSON.stringify(CHALLENGE_KINDS) === JSON.stringify({ daily: { minutes: 5, mutatorCount: 1, sizeLetter: '' }, weekly: { minutes: 10, mutatorCount: 2, sizeLetter: 'M' } }), 'CHALLENGE_KINDS matches the spec');
ok(CHALLENGE_EPOCH_MS === Date.UTC(2026, 11, 1), 'CHALLENGE_EPOCH_MS is 2026-12-01 UTC');
const coreSource = readSource('core.js');
ok(coreSource.includes(`const A = '${ROOM_ALPHABET}';`), 'ROOM_ALPHABET equals the js/core.js room alphabet');
const mutatorContext = vm.createContext({});
vm.runInContext(readSource('mutators.js'), mutatorContext, { filename: 'mutators.js' });
const mutatorIds = JSON.parse(vm.runInContext('JSON.stringify(MUTATOR_IDS)', mutatorContext));
ok(CHALLENGE_MUTATOR_POOL.every(id => mutatorIds.includes(id)), 'every pool id exists in js/mutators.js MUTATOR_IDS');
ok(!CHALLENGE_MUTATOR_POOL.includes('copsAggro'), 'copsAggro is excluded from the pool');

console.log('2) golden table (must never change)');
GOLDEN_DAILY.forEach((row, dayOffset) => {
  const definition = challengeFor('daily', CHALLENGE_EPOCH_MS + dayOffset * DAY_MS + 12 * 3600000);
  ok(asGoldenRow(definition) === JSON.stringify(row), `daily golden ${row[0]}`);
});
GOLDEN_WEEKLY.forEach((row, weekOffset) => {
  const definition = challengeFor('weekly', CHALLENGE_EPOCH_MS + weekOffset * WEEK_MS);
  ok(asGoldenRow(definition) === JSON.stringify(row), `weekly golden ${row[0]}`);
});

console.log('3) definition shape and rules');
const daily = challengeFor('daily', new Date(Date.UTC(2026, 11, 1, 23, 59, 59)));
ok(daily.kind === 'daily' && daily.minutes === 5 && daily.violence === true, 'daily is a 5-minute violent shift');
ok(JSON.stringify(Object.keys(daily)) === JSON.stringify(['id', 'kind', 'roomCode', 'job', 'minutes', 'mutators', 'violence', 'endsAt']), 'definition has exactly the spec fields');
const weekly = challengeFor('weekly', Date.UTC(2026, 11, 3));
ok(weekly.kind === 'weekly' && weekly.minutes === 10 && weekly.violence === true, 'weekly is a 10-minute violent shift');
ok(weekly.endsAt === Date.UTC(2026, 11, 7), 'weekly ends next Monday 00:00 UTC');
let dailyRulesHold = true, previousJob = null;
for (let dayOffset = 0; dayOffset < 400; dayOffset++) {
  const definition = challengeFor('daily', CHALLENGE_EPOCH_MS + dayOffset * DAY_MS);
  const poolOrder = definition.mutators.map(id => CHALLENGE_MUTATOR_POOL.indexOf(id));
  if (!/^[A-Z0-9]{6}$/.test(definition.roomCode) || 'PMG'.includes(definition.roomCode[0])) dailyRulesHold = false;
  if (definition.mutators.length !== 1 || poolOrder.includes(-1)) dailyRulesHold = false;
  if (definition.job === previousJob) dailyRulesHold = false;
  if ([...definition.roomCode].some(char => !ROOM_ALPHABET.includes(char))) dailyRulesHold = false;
  previousJob = definition.job;
}
ok(dailyRulesHold, '400 dailies: Small-city room code, one pool mutator, job differs from the day before');
let weeklyRulesHold = true;
for (let weekOffset = 0; weekOffset < 120; weekOffset++) {
  const definition = challengeFor('weekly', CHALLENGE_EPOCH_MS + weekOffset * WEEK_MS);
  const poolOrder = definition.mutators.map(id => CHALLENGE_MUTATOR_POOL.indexOf(id));
  if (!/^M[A-Z0-9]{5}$/.test(definition.roomCode)) weeklyRulesHold = false;
  if (definition.mutators.length !== 2 || poolOrder.includes(-1) || !(poolOrder[0] < poolOrder[1])) weeklyRulesHold = false;
  if (!/^weekly:\d{4}-W\d{2}$/.test(definition.id)) weeklyRulesHold = false;
}
ok(weeklyRulesHold, '120 weeklies: Medium room code, two unique mutators in pool order');
ok(asGoldenRow(challengeFor('daily', CHALLENGE_EPOCH_MS)) === asGoldenRow(challengeFor('daily', CHALLENGE_EPOCH_MS + DAY_MS - 1)), 'the whole UTC day maps to one daily');

console.log('4) ISO week-year edges');
ok(challengeFor('weekly', Date.UTC(2026, 11, 31)).id === 'weekly:2026-W53', '2026-12-31 is weekly:2026-W53');
ok(challengeFor('weekly', Date.UTC(2027, 0, 3, 23, 59)).id === 'weekly:2026-W53', '2027-01-03 is still weekly:2026-W53');
ok(challengeFor('weekly', Date.UTC(2027, 0, 4)).id === 'weekly:2027-W01', '2027-01-04 is weekly:2027-W01');
ok(challengeFor('weekly', Date.UTC(2029, 11, 31)).id === 'weekly:2030-W01', '2029-12-31 is weekly:2030-W01');

console.log('5) id parsing');
ok(JSON.stringify(parseChallengeId('daily:2026-12-01')) === JSON.stringify({ kind: 'daily', startMs: Date.UTC(2026, 11, 1) }), 'parses a daily id');
ok(JSON.stringify(parseChallengeId('weekly:2026-W53')) === JSON.stringify({ kind: 'weekly', startMs: Date.UTC(2026, 11, 28) }), 'parses weekly:2026-W53');
ok(JSON.stringify(parseChallengeId('weekly:2027-W01')) === JSON.stringify({ kind: 'weekly', startMs: Date.UTC(2027, 0, 4) }), 'parses weekly:2027-W01');
for (const badId of ['daily:2026-02-30', 'weekly:2027-W53', 'weekly:2026-W00', 'weekly:2026-W54', 'daily:2026-12-01x', 'Daily:2026-12-01', 'daily:2026-13-01', 'daily:0050-01-01', 'monthly:2026-12', '', null, 42]) {
  ok(parseChallengeId(badId) === null, `rejects ${JSON.stringify(badId)}`);
}

console.log('6) lookup by id and current ids');
ok(asGoldenRow(challengeById('daily:2026-12-05')) === JSON.stringify(GOLDEN_DAILY[4]), 'challengeById matches challengeFor for a daily');
ok(asGoldenRow(challengeById('weekly:2026-W49')) === JSON.stringify(GOLDEN_WEEKLY[0]), 'challengeById returns the week holding the epoch');
ok(challengeById('weekly:2026-W48') === null && challengeById('daily:2026-11-30') === null, 'challengeById is null before the epoch');
ok(challengeById('daily:2026-02-30') === null, 'challengeById is null for a bad id');
ok(JSON.stringify(currentChallengeIds(Date.UTC(2026, 11, 31, 18))) === JSON.stringify({ daily: 'daily:2026-12-31', weekly: 'weekly:2026-W53' }), 'currentChallengeIds gives both ids');

console.log('7) epoch and bad input');
ok(challengeFor('daily', CHALLENGE_EPOCH_MS - 1) === null, 'challengeFor before the epoch is null');
ok(challengeFor('weekly', Date.UTC(2026, 10, 30)) === null, 'weekly before the epoch is null');
ok(challengeFor('monthly', CHALLENGE_EPOCH_MS) === null && challengeFor('toString', CHALLENGE_EPOCH_MS) === null, 'unknown kind is null');
ok(challengeFor('daily', 'tomorrow') === null && challengeFor('daily', NaN) === null && challengeFor('daily', undefined) === null, 'non-date input is null');

console.log('8) retention');
const now = Date.UTC(2026, 11, 20, 15);
ok(isChallengeRetained('daily:2026-12-20', now) && isChallengeRetained('daily:2026-12-14', now), 'current and 6 previous dailies retained');
ok(!isChallengeRetained('daily:2026-12-13', now), 'the 7th previous daily is dropped');
ok(!isChallengeRetained('daily:2026-12-21', now), 'a future daily is not retained');
ok(isChallengeRetained('weekly:2026-W51', now) && isChallengeRetained('weekly:2026-W49', now), 'current and previous weeklies retained');
ok(isChallengeRetained('weekly:2026-W50', Date.UTC(2027, 0, 1)) && !isChallengeRetained('weekly:2026-W49', Date.UTC(2027, 0, 1)), 'weekly keeps current + 3 previous across the year end');
ok(!isChallengeRetained('daily:2026-11-30', Date.UTC(2026, 11, 2)), 'pre-epoch ids are never retained');
ok(!isChallengeRetained('nonsense', now), 'a bad id is not retained');

console.log('9) hash and PRNG parity with js/core.js');
const coreContext = vm.createContext({});
vm.runInContext(`${extractTopLevel(coreSource, 'hashStr')}\n${extractTopLevel(coreSource, 'mulberry32')}`, coreContext);
const moduleSource = fs.readFileSync(modulePath, 'utf8');
const challengeContext = vm.createContext({});
vm.runInContext(moduleSource, challengeContext);
let parity = true;
for (const text of ['', 'libre-challenge:v1:daily:2026-12-01', 'ABC123', 'weekly:2027-W01:ünïcode']) {
  const coreHash = vm.runInContext(`hashStr(${JSON.stringify(text)})`, coreContext);
  if (coreHash !== vm.runInContext(`challengeHash(${JSON.stringify(text)})`, challengeContext)) parity = false;
  const draws = `(() => { const next = %(${coreHash}); return [next(), next(), next(), next()]; })()`;
  if (JSON.stringify(vm.runInContext(draws.replace('%', 'mulberry32'), coreContext)) !== JSON.stringify(vm.runInContext(draws.replace('%', 'challengeRandom'), challengeContext))) parity = false;
}
ok(parity, 'challengeHash/challengeRandom equal hashStr/mulberry32');

console.log('10) loads alone in a bare vm context');
ok(vm.runInContext('challengeFor("daily", Date.UTC(2026, 11, 1)).roomCode', challengeContext) === 'UVR3NT', 'challengeFor works in vm.createContext({})');
ok(vm.runInContext('challengeById("weekly:2026-W50").job', challengeContext) === 'patrol', 'challengeById works in vm.createContext({})');
ok(!/\b(window|document|localStorage|location|navigator)\b/.test(moduleSource), 'the module reads no browser globals');
const indexHtml = readSource('../index.html');
const scriptIndex = name => indexHtml.indexOf(`<script src="js/${name}"></script>`);
ok(scriptIndex('challenge-def.js') > scriptIndex('job-score.js') && scriptIndex('challenge-def.js') < scriptIndex('run.js') && scriptIndex('run.js') < scriptIndex('ui.js'), 'index.html loads challenge-def.js after job-score.js and before run.js and ui.js');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
