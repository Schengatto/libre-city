import vm from 'node:vm';
import { readSource, extractTopLevel } from './render-test-kit.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const CORE_NAMES = ['clamp'];
const ENTITY_NAMES = ['LAG_COMP_MAX_MS', 'LAG_HISTORY_TICKS', 'SIM_STEP_MS', 'createBodyHistory', 'bodyHistoryRecord', 'bodyHistoryLookup', 'lagMsToTicks'];
const NET_NAMES = ['NET_PREDICTED_SHOT_TTL_MS', 'netLagCompMs', 'netPredictedShotPush', 'netPredictedShotConsume'];

function loadHelpers() {
  const sources = [['core.js', CORE_NAMES], ['entities.js', ENTITY_NAMES], ['net.js', NET_NAMES]];
  const declarations = sources.map(([file, names]) => {
    const source = readSource(file);
    return names.map(name => extractTopLevel(source, name)).join('\n');
  }).join('\n');
  const exported = [...CORE_NAMES, ...ENTITY_NAMES, ...NET_NAMES];
  const context = vm.createContext({});
  vm.runInContext(declarations + '\n;globalThis.api = { ' + exported.join(', ') + ' };', context);
  return context.api;
}

const api = loadHelpers();

function testBodyHistory() {
  const history = api.createBodyHistory();
  const out = { x: 0, y: 0 };
  ok(history.ticks.length === 32 && history.xs.length === 32 && history.ys.length === 32, 'history holds 32 slots');
  ok(history.ticks.every(tick => tick === -1), 'fresh history slots are empty');
  ok(api.bodyHistoryLookup(history, 5, out) === false, 'fresh history lookup misses');
  for (let k = 0; k < 32; k++) api.bodyHistoryRecord(history, 100 + k, k * 2, k * 3);
  let allHit = true;
  for (let k = 0; k < 32; k++) {
    const hit = api.bodyHistoryLookup(history, 100 + k, out);
    if (!hit || out.x !== k * 2 || out.y !== k * 3) allHit = false;
  }
  ok(allHit, 'ticks 100..131 are all found with stored coordinates');
  ok(api.bodyHistoryLookup(history, 105, out) && api.bodyHistoryLookup(history, 105, out) && out.x === 10 && out.y === 15, 'repeated lookup returns the same coordinates in out');
  api.bodyHistoryRecord(history, 132, 7, 8);
  ok(api.bodyHistoryLookup(history, 100, out) === false, 'overwritten slot misses the old tick');
  ok(api.bodyHistoryLookup(history, 132, out) && out.x === 7 && out.y === 8, 'new tick found after overwrite');
  const untouched = { x: 1, y: 2 };
  api.bodyHistoryLookup(history, 100, untouched);
  ok(untouched.x === 1 && untouched.y === 2, 'miss leaves out untouched');
}

function testLagMsToTicks() {
  const cases = [[0, 0], [150, 9], [250, 15], [5000, 15], [-20, 0], [NaN, 0]];
  for (const [lagMs, expected] of cases) {
    ok(api.lagMsToTicks(lagMs) === expected, `lagMsToTicks(${lagMs}) = ${expected}`);
  }
}

function testNetLagCompMs() {
  const cases = [
    [{ inputRtt: null, interpDelay: 50 }, 0],
    [{ inputRtt: 100, interpDelay: 50 }, 150],
    [{ inputRtt: 101, interpDelay: 51 }, 150],
    [{ inputRtt: 900, interpDelay: 150 }, 250],
  ];
  for (const [stats, expected] of cases) {
    ok(api.netLagCompMs(stats) === expected, `netLagCompMs(${JSON.stringify(stats)}) = ${expected}`);
  }
}

function testPredictedShotQueue() {
  const first = [];
  api.netPredictedShotPush(first, 0);
  ok(api.netPredictedShotConsume(first, 100) === true, 'fresh predicted shot is consumed');
  ok(api.netPredictedShotConsume(first, 100) === false, 'queue is empty after consume');
  const expired = [];
  api.netPredictedShotPush(expired, 0);
  ok(api.netPredictedShotConsume(expired, 1500) === false, 'expired predicted shot is not consumed');
  const mixed = [];
  api.netPredictedShotPush(mixed, 0);
  api.netPredictedShotPush(mixed, 1400);
  ok(api.netPredictedShotConsume(mixed, 1500) === true, 'second shot survives while first expired');
  ok(mixed.length === 0, 'queue drained after consuming the survivor');
}

testBodyHistory();
testLagMsToTicks();
testNetLagCompMs();
testPredictedShotQueue();

console.log(`\nfire prediction: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
