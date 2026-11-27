import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(here, '..', 'js', 'job-score.js');
const require = createRequire(import.meta.url);
const scoring = require(modulePath);
const { jobScore, shiftMedal, MEDAL_THRESHOLDS, JOB_BASE_POINTS, SHIFT_MINUTES, SHIFT_RULES_VERSION } = scoring;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

console.log('1) constants');
ok(JOB_BASE_POINTS === 100 && SHIFT_MINUTES === 5 && SHIFT_RULES_VERSION === 1, 'base points, shift minutes and rules version');

console.log('2) jobScore');
const taxi = { job: 'taxi', pay: 50, tip: 25, timerLeft: 40, timerTotal: 100 };
ok(jobScore(taxi) === 203, `taxi pay 50 tip 25 at 40% -> 203 (${jobScore(taxi)})`);
ok(jobScore({ ...taxi, timerLeft: 400 }) === Math.round(225 * 1.5), 'efficiency above 1 clamps to 1.5x');
ok(jobScore({ ...taxi, timerLeft: -30 }) === Math.round(225 * 0.5), 'negative timerLeft clamps to 0.5x');
ok(jobScore({ ...taxi, timerTotal: 0 }) === Math.round(225 * 0.5), 'timerTotal 0 gives 0.5x');
ok(jobScore({ ...taxi, timerTotal: -5 }) === Math.round(225 * 0.5), 'negative timerTotal gives 0.5x');
ok(jobScore({ ...taxi, job: 'bus' }) === 0, 'unknown job -> 0');
ok(jobScore({ ...taxi, job: 'constructor' }) === 0, 'inherited property name is not a job');
ok(jobScore({ ...taxi, pay: NaN }) === 0, 'NaN pay -> 0');
ok(jobScore({ ...taxi, tip: Infinity }) === 0, 'infinite tip -> 0');
ok(jobScore({ ...taxi, timerLeft: undefined }) === 0, 'missing timerLeft -> 0');
ok(jobScore({ ...taxi, pay: -500, tip: 0 }) === 0, 'never negative');
ok(jobScore() === 0 && jobScore({}) === 0, 'missing input -> 0');
ok(Number.isInteger(jobScore({ ...taxi, pay: 33, tip: 7, timerLeft: 13, timerTotal: 29 })), 'result is an integer');
for (const job of Object.keys(MEDAL_THRESHOLDS)) ok(jobScore({ ...taxi, job }) === 203, `${job} is scored with the same formula`);

console.log('3) scaled timer keeps the same score');
const scaledScores = [1, 2, 3.5, 10].map(scale => jobScore({ ...taxi, timerLeft: 40 * scale, timerTotal: 100 * scale }));
ok(scaledScores.every(score => score === 203), `same timerLeft/timerTotal ratio -> same score (${scaledScores.join(',')})`);

console.log('4) shiftMedal');
const medalCases = [
  ['taxi', 0, null], ['taxi', 1499, null], ['taxi', 1500, 'bronze'], ['taxi', 2999, 'bronze'], ['taxi', 3000, 'silver'],
  ['taxi', 4499, 'silver'], ['taxi', 4500, 'gold'], ['taxi', 99999, 'gold'],
  ['pizza', 1500, 'bronze'], ['ambulance', 4500, 'gold'],
  ['patrol', 1199, null], ['patrol', 1200, 'bronze'], ['patrol', 2400, 'silver'], ['patrol', 3599, 'silver'], ['patrol', 3600, 'gold'],
  ['fire', 1200, 'bronze'], ['fire', 3600, 'gold'], ['bus', 99999, null],
];
for (const [job, score, expected] of medalCases) ok(shiftMedal(job, score) === expected, `${job} ${score} -> ${expected}`);

console.log('5) thresholds');
for (const [job, levels] of Object.entries(MEDAL_THRESHOLDS))
  ok(levels.bronze < levels.silver && levels.silver < levels.gold, `${job} thresholds strictly increasing`);
ok(Object.keys(MEDAL_THRESHOLDS).join(',') === 'taxi,pizza,ambulance,patrol,fire', 'the five jobs are covered');

console.log('6) loads in a bare vm context');
const bareContext = vm.createContext({});
vm.runInContext(fs.readFileSync(modulePath, 'utf8'), bareContext);
ok(vm.runInContext('jobScore({ job: "taxi", pay: 50, tip: 25, timerLeft: 40, timerTotal: 100 })', bareContext) === 203, 'jobScore works in vm.createContext({})');
ok(vm.runInContext('shiftMedal("patrol", 2400)', bareContext) === 'silver', 'shiftMedal works in vm.createContext({})');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
