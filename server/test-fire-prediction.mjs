import vm from 'node:vm';
import { readSource, extractTopLevel } from './render-test-kit.mjs';
import runtime from './sim-runtime.js';

const { createRoomSim } = runtime;

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

const SHOOTER_SETTLE_TICKS = 20;
const RIVAL_OFFSET_X = 100;
const RIVAL_JUMP_Y = 400;
const SHOT_TICKS = 12;

function findClearRowOrigin(sim) {
  const kinds = sim._tileKinds();
  const tileSize = sim._tileSize();
  const walkable = tile => tile === kinds.ROAD || tile === kinds.SIDEWALK;
  for (const node of sim._roadGraph().nodes) {
    const tileY = Math.floor(node.y / tileSize);
    const firstTileX = Math.floor((node.x - 40) / tileSize);
    const lastTileX = Math.floor((node.x + RIVAL_OFFSET_X + 80) / tileSize);
    let clear = true;
    for (let tileX = firstTileX; tileX <= lastTileX && clear; tileX++) clear = walkable(sim._tileAt(tileX, tileY));
    if (clear) return { x: node.x, y: node.y };
  }
  throw new Error('no clear row found');
}

function createDuel(code, rivalJoinsLate) {
  const sim = createRoomSim(code);
  const shooterId = sim.addPlayer('Shooter', 0);
  const origin = findClearRowOrigin(sim);
  sim._peds().length = 0;
  sim._cars().length = 0;
  const shooter = sim._player(shooterId);
  shooter.owned[1] = true;
  shooter.weaponIdx = 1;
  let rivalId = null;
  const reportBoth = (rivalDx, rivalDy) => {
    sim.applyInput(shooterId, { px: origin.x, py: origin.y });
    if (rivalId) sim.applyInput(rivalId, { px: origin.x + rivalDx, py: origin.y + rivalDy });
  };
  const settle = ticks => { for (let i = 0; i < ticks; i++) { reportBoth(RIVAL_OFFSET_X, 0); sim.tick(); } };
  if (!rivalJoinsLate) { rivalId = sim.addPlayer('Rival', 1); settle(SHOOTER_SETTLE_TICKS); }
  else settle(SHOOTER_SETTLE_TICKS);
  return {
    sim, shooterId, shooter, origin,
    addRival() { rivalId = sim.addPlayer('Rival', 1); return rivalId; },
    rival: () => sim._player(rivalId),
    settle,
    shoot(lagField, rivalDy) {
      reportBoth(RIVAL_OFFSET_X, rivalDy);
      sim.applyInput(shooterId, Object.assign({ aim: 0, b: 2, px: origin.x, py: origin.y, seq: 1 }, lagField));
      sim.tick();
      for (let i = 1; i < SHOT_TICKS; i++) { reportBoth(RIVAL_OFFSET_X, rivalDy); sim.tick(); }
    },
  };
}

function testHostRewind() {
  const baseline = createDuel('LAGC01');
  baseline.rival().health = 100;
  baseline.shoot({}, 0);
  ok(baseline.rival().health < 100, 'baseline shot at a stationary rival lands');

  const uncompensated = createDuel('LAGC02');
  uncompensated.shoot({}, RIVAL_JUMP_Y);
  ok(uncompensated.rival().health === 100, 'no lg: shot misses a rival that just moved away');

  const compensated = createDuel('LAGC03');
  compensated.shoot({ lg: 150 }, RIVAL_JUMP_Y);
  ok(compensated.rival().health < 100, 'lg 150: shot lands on the rewound rival position');
  ok(compensated.sim._player(compensated.shooterId).input.lagMs === 150, 'lg 150 is stored as lagMs');

  const bounded = createDuel('LAGC04');
  for (let i = 0; i < 20; i++) { bounded.sim.applyInput(bounded.shooterId, { px: bounded.origin.x, py: bounded.origin.y }); bounded.sim.applyInput(bounded.rival().id, { px: bounded.origin.x + RIVAL_OFFSET_X, py: bounded.origin.y + RIVAL_JUMP_Y }); bounded.sim.tick(); }
  bounded.shoot({ lg: 99999 }, RIVAL_JUMP_Y);
  ok(bounded.sim._player(bounded.shooterId).input.lagMs === 250, 'huge lg is clamped to 250');
  ok(bounded.rival().health === 100, 'clamped rewind stays inside history and still misses');

  for (const garbage of [NaN, -50, 'x', '150', null, Infinity]) {
    const duel = createDuel('LAGC05');
    let threw = null;
    try { duel.shoot({ lg: garbage }, RIVAL_JUMP_Y); } catch (error) { threw = error; }
    ok(!threw, 'lg ' + String(garbage) + ' does not throw');
    if (garbage !== null) ok(duel.sim._player(duel.shooterId).input.lagMs === 0, 'lg ' + String(garbage) + ' gives lagMs 0');
  }

  const late = createDuel('LAGC06', true);
  late.addRival();
  late.sim.applyInput(late.rival().id, { px: late.origin.x + RIVAL_OFFSET_X, py: late.origin.y });
  let threw = null;
  try { late.shoot({ lg: 250 }, 0); } catch (error) { threw = error; }
  ok(!threw, 'rival with no history does not throw');
  ok(late.rival().health < 100, 'rival with no history is tested at the current position');
}

function testShooterTags() {
  const duel = createDuel('TAG001');
  duel.sim.clearFx();
  duel.sim.applyInput(duel.shooterId, { aim: 0, b: 2, px: duel.origin.x, py: duel.origin.y, seq: 1 });
  duel.sim.tick();
  const snapshot = duel.sim.snapshotFor(duel.rival().id);
  const muzzle = snapshot.fx.find(effect => effect.k === 0);
  ok(muzzle && muzzle.o === duel.shooterId, 'player muzzle fx carries the shooter id');
  const bullet = snapshot.bul.find(entry => !entry.hostile);
  ok(bullet && bullet.o === duel.shooterId, 'player bullet carries the shooter id');

  const hostile = createRoomSim('TAG002');
  const victimId = hostile.addPlayer('Victim', 0);
  const victim = hostile._player(victimId);
  hostile.setPolice(true);
  victim.wanted = 4;
  victim.wantedHeat = 4.5;
  victim.crimeCd = 100000;
  const cop = hostile._spawnPed(victim.x + 90, victim.y, 'cop');
  const seenMuzzles = [], seenHostileBullets = [];
  for (let tick = 0; tick < 600; tick++) {
    victim.health = 100;
    hostile.tick();
    const view = hostile.snapshotFor(victimId);
    for (const effect of view.fx) if (effect.k === 0) seenMuzzles.push(effect);
    for (const entry of view.bul) if (entry.hostile) seenHostileBullets.push(entry);
    hostile.clearFx();
  }
  ok(cop && seenMuzzles.length > 0 && seenHostileBullets.length > 0, 'a cop fires during the scenario');
  ok(seenMuzzles.every(effect => !('o' in effect)), 'cop muzzle fx has no shooter id');
  ok(seenHostileBullets.every(entry => !('o' in entry)), 'hostile bullets have no shooter id');
}

testBodyHistory();
testLagMsToTicks();
testNetLagCompMs();
testPredictedShotQueue();
testHostRewind();
testShooterTags();

console.log(`\nfire prediction: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
