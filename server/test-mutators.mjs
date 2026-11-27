import vm from 'node:vm';
import { readSource } from './render-test-kit.mjs';
import runtime from './sim-runtime.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const mutatorsSource = readSource('mutators.js');
const gameplay = readSource('gameplay.js');
const missions = readSource('missions.js');
const serverSimGlue = readSource('server-sim-glue.js');
const indexHtml = readSource('../index.html');

const context = vm.createContext({});
vm.runInContext(mutatorsSource, context, { filename: 'mutators.js' });
const evaluate = expression => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context));

const EXPECTED_DEFAULTS = {
  civilianCap: 26, civilianSpawnEvery: 8, trafficCap: 14, trafficSpawnEvery: 12,
  copRange: 330, copFireCdMin: 42, copFireCdMax: 66, copsPerStar: 1, crimeHeatScale: 1,
  heatDecay: 0.0016, carDamageScale: 1, jobTimerScale: 1, forceNight: false,
};

ok(JSON.stringify(evaluate('TUNING_DEFAULTS')) === JSON.stringify(EXPECTED_DEFAULTS), 'TUNING_DEFAULTS equals the spec table');
ok(JSON.stringify(evaluate('TUNING')) === JSON.stringify(EXPECTED_DEFAULTS), 'TUNING starts equal to the defaults');
ok(vm.runInContext('Object.isFrozen(TUNING_DEFAULTS)', context), 'TUNING_DEFAULTS is frozen');
ok(!vm.runInContext('Object.isFrozen(TUNING)', context), 'TUNING is mutable');
ok(vm.runInContext('TUNING !== TUNING_DEFAULTS', context), 'TUNING is a separate copy of the defaults');

ok(!/COP_RANGE/.test(gameplay), 'gameplay.js no longer defines or reads COP_RANGE');
ok(!gameplay.includes('0.0016'), 'gameplay.js no longer hardcodes the heat decay');
ok(!gameplay.includes('rndi(42, 66)'), 'gameplay.js no longer hardcodes the cop fire cooldown');
ok(!gameplay.includes('26 * nP'), 'gameplay.js no longer hardcodes the civilian cap');
ok(!gameplay.includes('14 * nP && frame % 12'), 'gameplay.js no longer hardcodes the traffic cap');
ok(gameplay.includes('nCiv < TUNING.civilianCap * nP && frame % TUNING.civilianSpawnEvery === 0'), 'civilian spawning reads TUNING');
ok(gameplay.includes('nTraf < TUNING.trafficCap * nP && frame % TUNING.trafficSpawnEvery === 0'), 'traffic spawning reads TUNING');
ok(gameplay.includes('d < TUNING.copRange'), 'cop range reads TUNING.copRange');
ok(gameplay.includes('rndi(TUNING.copFireCdMin, TUNING.copFireCdMax)'), 'cop fire cooldown reads TUNING');
ok(gameplay.includes('Math.ceil(wanted * nP * TUNING.copsPerStar)'), 'foot cop count reads TUNING.copsPerStar');
ok(gameplay.includes('Math.ceil(Math.max(0, wanted - 1) * nP * TUNING.copsPerStar)'), 'patrol car count reads TUNING.copsPerStar');
ok(gameplay.includes('wantedHeat + amount * TUNING.crimeHeatScale'), 'crime heat reads TUNING.crimeHeatScale');
ok(gameplay.includes('wantedHeat - TUNING.heatDecay'), 'heat decay reads TUNING.heatDecay');
ok(/function damageCar\(c, dmg, angle, chain = 0\) \{\n  dmg \*= TUNING\.carDamageScale;\n  addDent/.test(gameplay), 'damageCar scales damage before addDent');

ok(serverSimGlue.includes('wantedHeat - TUNING.heatDecay'), 'server-sim-glue.js reads TUNING.heatDecay');
ok(!serverSimGlue.includes('0.0016'), 'server-sim-glue.js no longer hardcodes the heat decay');

const timerLines = missions.split('\n').filter(line => /\b(taxi|pizza|rescue)\.timer = |\b(patrol|firejob)\.timer0 = /.test(line));
ok(timerLines.length === 5, 'missions.js has five job timer assignments');
ok(timerLines.every(line => line.includes('TUNING.jobTimerScale')), 'every job timer in missions.js reads TUNING.jobTimerScale');

const scriptOrder = file => indexHtml.indexOf(`<script src="js/${file}">`);
ok(scriptOrder('mutators.js') > scriptOrder('core.js') && scriptOrder('mutators.js') < scriptOrder('i18n.js'), 'index.html loads mutators.js right after core.js');
ok(runtime.SIM_FILES.indexOf('mutators.js') === runtime.SIM_FILES.indexOf('core.js') + 1, 'SIM_FILES lists mutators.js right after core.js');
ok(/SIM_SCRIPT_FILES = \['core\.js', 'mutators\.js'/.test(readSource('sim-worker.js')), 'sim-worker.js imports mutators.js right after core.js');

const mutatorIds = evaluate('MUTATOR_IDS');
ok(JSON.stringify(mutatorIds) === JSON.stringify(['night', 'traffic2x', 'copsAggro', 'glassCars', 'tightClock', 'crowds']), 'MUTATOR_IDS lists the six mutators');
ok(JSON.stringify(Object.keys(evaluate('MUTATORS'))) === JSON.stringify(mutatorIds), 'MUTATORS has one entry per id');
ok(evaluate('MUTATOR_CONFLICTS').length === 0, 'MUTATOR_CONFLICTS is empty');

const tuningOf = id => evaluate(`MUTATORS.${id}.tuning`);
const expectedTuning = {
  night: { forceNight: true },
  traffic2x: { trafficCap: 28, trafficSpawnEvery: 6 },
  copsAggro: { copRange: 450, copFireCdMin: 28, copFireCdMax: 44, copsPerStar: 1.5, crimeHeatScale: 1.5, heatDecay: 0.0008 },
  glassCars: { carDamageScale: 2 },
  tightClock: { jobTimerScale: 0.7 },
  crowds: { civilianCap: 52, civilianSpawnEvery: 4 },
};
for (const id of mutatorIds) {
  ok(JSON.stringify(tuningOf(id)) === JSON.stringify(expectedTuning[id]), `${id} sets only its own fields`);
  ok(Object.keys(tuningOf(id)).every(field => field in EXPECTED_DEFAULTS), `${id} only touches known TUNING fields`);
}
const allFields = mutatorIds.flatMap(id => Object.keys(tuningOf(id)));
ok(new Set(allFields).size === allFields.length, 'mutator field sets are disjoint');
ok(evaluate('MUTATORS.glassCars.icon') === '💥', 'mutators carry their icon');

ok(JSON.stringify(evaluate("sanitizeMutatorIds(['crowds', 'x', 'night', 'crowds'])")) === JSON.stringify(['night', 'crowds']), 'sanitize drops unknown ids and duplicates and keeps registry order');
ok(['sanitizeMutatorIds(null)', 'sanitizeMutatorIds(undefined)', "sanitizeMutatorIds('night')", 'sanitizeMutatorIds({})'].every(call => evaluate(call).length === 0), 'sanitize turns non-arrays into []');
ok(evaluate("sanitizeMutatorIds([1, null, {}, 'night'])").length === 1, 'sanitize drops non-string entries');
ok(evaluate("isMutatorId('night')") === true && evaluate("isMutatorId('x')") === false && evaluate('isMutatorId(7)') === false, 'isMutatorId accepts only known string ids');

const applied = evaluate("applyMutators(['copsAggro', 'night', 'bogus'])");
ok(JSON.stringify(applied) === JSON.stringify(['night', 'copsAggro']), 'applyMutators returns the sanitized applied ids');
ok(evaluate('TUNING.forceNight') === true && evaluate('TUNING.copRange') === 450 && evaluate('TUNING.trafficCap') === 14, 'applyMutators assigns the chosen tunings and leaves the rest');
ok(JSON.stringify(evaluate('activeMutatorIds')) === JSON.stringify(['night', 'copsAggro']), 'applyMutators records activeMutatorIds');
evaluate("applyMutators(['glassCars'])");
ok(evaluate('TUNING.forceNight') === false && evaluate('TUNING.carDamageScale') === 2, 'applyMutators resets the previous selection first');
const execute = source => { vm.runInContext(source, context); };
execute('resetMutators()');
ok(JSON.stringify(evaluate('TUNING')) === JSON.stringify(EXPECTED_DEFAULTS), 'resetMutators restores every field');
ok(evaluate('activeMutatorIds').length === 0, 'resetMutators empties activeMutatorIds');

execute("var multiplayerOn = false; function netActive() { return multiplayerOn; } applyMutators(['glassCars']); multiplayerOn = true;");
ok(evaluate("applyMutators(['night', 'crowds'])").length === 0, 'applyMutators returns [] during multiplayer');
ok(evaluate('TUNING.carDamageScale') === 2 && evaluate('TUNING.forceNight') === false && JSON.stringify(evaluate('activeMutatorIds')) === JSON.stringify(['glassCars']), 'applyMutators changes nothing during multiplayer, not even a reset');
execute('multiplayerOn = false');
ok(evaluate("applyMutators(['night'])").length === 1, 'applyMutators applies again once multiplayer ends');
execute('resetMutators()');

execute("MUTATOR_CONFLICTS.push(['night', 'crowds'], ['traffic2x', 'glassCars'])");
ok(JSON.stringify(evaluate("sanitizeMutatorIds(['crowds', 'night', 'glassCars', 'traffic2x', 'tightClock'])")) === JSON.stringify(['night', 'traffic2x', 'tightClock']), 'sanitize drops the later id of each conflicting pair');
ok(JSON.stringify(evaluate("sanitizeMutatorIds(['crowds'])")) === JSON.stringify(['crowds']), 'a conflicting id alone is kept');
execute('MUTATOR_CONFLICTS.length = 0');
ok(evaluate('MUTATOR_CONFLICTS').length === 0, 'the temporary conflict pairs are removed');

const MONDAY = Date.UTC(2026, 10, 30);
const SUNDAY_END = Date.UTC(2026, 10, 29, 23, 59, 59);
const WEEK_MS = 7 * 86400000;
ok(evaluate(`utcWeekIndex(${MONDAY})`) === evaluate(`utcWeekIndex(${SUNDAY_END})`) + 1, 'the week index advances at Monday 00:00 UTC');
ok(evaluate(`mutatorOfWeek(${MONDAY})`) !== evaluate(`mutatorOfWeek(${SUNDAY_END})`), 'the weekly mutator changes at the Monday boundary');
ok(evaluate(`mutatorOfWeek(${MONDAY})`) === evaluate(`mutatorOfWeek(${MONDAY + WEEK_MS - 1})`), 'the weekly mutator is stable through the week');
const sixMondays = [0, 1, 2, 3, 4, 5].map(week => evaluate(`mutatorOfWeek(${MONDAY + week * WEEK_MS})`));
ok(new Set(sixMondays).size === mutatorIds.length, 'six consecutive Mondays cover every mutator');

const daynightSource = readSource('daynight.js');
ok(/const NIGHT_FULL_FRAME = DAY_NIGHT_KEYFRAMES\.find\(keyframe => keyframe\.light === 1\)\.frame;/.test(daynightSource), 'NIGHT_FULL_FRAME is derived from the keyframes');
ok(daynightSource.includes('TUNING.forceNight'), 'drawDayNight reads TUNING.forceNight');

const ui = readSource('ui.js');
const i18nSource = readSource('i18n.js');
const occurrences = (text, needle) => text.split(needle).length - 1;
ok(/function showMenu\(\) \{[\s\S]*?resetMutators\(\);[\s\S]*?\n\}/.test(ui), 'showMenu resets the mutators');
ok(/if \(netActive\(\)\) resetMutators\(\);/.test(ui), 'startMatch resets the mutators when multiplayer starts');
ok(ui.indexOf('applyMutators(runConfig ? (runConfig.mutators || []) : (_spIntent.mutators || []));') > 0
  && ui.indexOf('applyMutators(runConfig') < ui.indexOf('startMatch(false);\n}\nelse if (_loadIntent'), 'the boot path applies the intent mutators before startMatch(false)');
ok(ui.includes("store.set('mutatorsPick', mutators);") && ui.includes('name: playerName, mutators }'), 'spGo stores the pick and the intent mutators');
ok(ui.includes("onClick('playBtn', () => openSpPanel(store.get('mutatorsPick', [])));") && ui.includes('fillSpMutatorPick(mutatorIds);'), 'the SP panel restores the last pick');
ok(/activeMutatorIds\.length > 0 && !netActive\(\)/.test(ui), 'badges are hidden when empty or in multiplayer');
ok(ui.includes("badges.title = t('hud.mutators');"), 'the badge row is labelled with hud.mutators');
ok(daynightSource.includes('TUNING.forceNight && !netActive()'), 'forced night is ignored in multiplayer');
const endGameBody = ui.slice(ui.indexOf('function endGame('), ui.indexOf('// ---- Starting a match'));
ok(endGameBody.includes("$('#goMutators')") && endGameBody.includes("MUTATORS[id].icon + ' ' + t('mut.' + id)") && endGameBody.includes('netActive() ? [] : activeMutatorIds'), 'endGame lists the active mutators on the free-play results screen, none in multiplayer');
ok(endGameBody.indexOf('finishRun(reason); return;') < endGameBody.indexOf("$('#goMutators')"), 'the mutator line is filled only on the non-run path');
const gameOverBlock = indexHtml.slice(indexHtml.indexOf('<div id="gameOver"'));
ok(gameOverBlock.indexOf('id="goMutators"') > 0 && gameOverBlock.indexOf('id="goMutators"') < gameOverBlock.indexOf('id="goLadderWrap"'), 'index.html has #goMutators inside #gameOver');
ok(ui.indexOf('function updateMutatorBadges()') > ui.indexOf('function startMatch(') && ui.indexOf('function updateMutatorBadges()') < ui.indexOf('// ---- Single-player: creation panel'), 'mutator UI helpers sit next to startMatch, above the single-player banner');
const i18nKeys = ['hud.mutators', 'mut.title', 'menu.mutatorWeek', 'menu.mutatorWeekPlay', ...mutatorIds.flatMap(id => ['mut.' + id, 'mut.' + id + 'Desc'])];
ok(i18nKeys.every(key => occurrences(i18nSource, `'${key}':`) === 2), 'every mutator i18n key exists in both catalogs');
ok(/function showMenu\(\) \{[\s\S]*?renderMutatorOfWeek\(Date\.now\(\)\);[\s\S]*?\n\}/.test(ui), 'showMenu recomputes the mutator of the week');
ok(indexHtml.indexOf('id="playBtn"') < indexHtml.indexOf('id="mutatorWeek"') && indexHtml.indexOf('id="mutatorWeek"') < indexHtml.indexOf('id="shiftBtn"'), 'the mutator of the week strip sits between #playBtn and #shiftBtn');
const weekPlayHandler = ui.slice(ui.indexOf("onClick('mutatorWeekPlay'"), ui.indexOf("onClick('spBack'"));
ok(weekPlayHandler.includes('mutatorOfWeek(Date.now())') && !weekPlayHandler.includes("store.set('mutatorsPick'"), 'Play with it ticks the weekly mutator without storing the pick');
ok(!/function openSpPanel\([\s\S]*?\n\}/.exec(ui)[0].includes('store.set'), 'openSpPanel never stores the pick');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
