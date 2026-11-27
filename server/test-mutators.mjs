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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
