import vm from 'node:vm';
import { readSource, extractTopLevel } from './render-test-kit.mjs';
import runtime from './sim-runtime.js';

const { createRoomSim } = runtime;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const CORE_NAMES = ['clamp'];
const ENTITY_NAMES = ['LAG_COMP_MAX_MS', 'LAG_HISTORY_TICKS', 'SIM_STEP_MS', 'createBodyHistory', 'bodyHistoryRecord', 'bodyHistoryLookup', 'lagMsToTicks'];
const NET_NAMES = ['NET_PREDICTED_SHOT_TTL_MS', 'netLagCompMs', 'netPredictedShotPush', 'netPredictedShotConsume'];
const PREDICTION_NAMES = ['netApplyFx', 'netWorldBulletsFrom', 'netStepPredictedBullets', 'netPredictFire'];

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

function createPredictionContext() {
  const calls = { muzzle: [], copShoot: 0, shoot: 0, smg: 0 };
  const net = { myId: 'me', authoritative: true, predBullets: [], predictedShots: [] };
  const sandbox = {
    net, calls, downT: 0, mDownL: false, mClicked: false, now: 1000,
    player: { x: 500, y: 700, aim: 0, shootCd: 0, car: null, weaponIdx: 1 },
    peaceMode: () => false, T: 32, solidTile: () => false, rnd: () => 0,
    WEAPONS: [
      { k: 'fists', melee: true, cd: 22 },
      { k: 'pistol', cd: 20, auto: false, spd: 13, life: 52, spread: 0.03, sfx: 'shoot' },
      { k: 'smg', cd: 8, auto: true, spd: 13, life: 44, spread: 0.09, sfx: 'smg' },
      { k: 'shotgun', cd: 46, auto: false, spd: 11, life: 26, spread: 0.22, pellets: 6, sfx: 'shotgun' },
      { k: 'rocket', cd: 60, rocket: true },
      { k: 'grenade', cd: 60, grenade: true },
      { k: 'flamer', cd: 3, auto: true, spd: 5.5, life: 8, spread: 0.3, pellets: 3, fire: true, sfx: 'flame' },
    ],
    spawnMuzzle: (x, y, a) => calls.muzzle.push({ x, y, a }),
    hear: () => 1,
    sfx: { copShoot: () => { calls.copShoot++; }, shoot: () => { calls.shoot++; }, smg: () => { calls.smg++; } },
    performance: { now: () => sandbox.now },
  };
  const context = vm.createContext(sandbox);
  const source = readSource('net.js');
  const names = ['NET_PREDICTED_SHOT_TTL_MS', 'netPredictedShotPush', 'netPredictedShotConsume', ...PREDICTION_NAMES];
  const declarations = names.map(name => extractTopLevel(source, name)).join('\n');
  vm.runInContext(declarations + '\n;globalThis.api = { ' + names.join(', ') + ' };', context);
  return { api: context.api, sandbox, net, calls };
}

function testOwnMuzzleSuppression() {
  const fresh = createPredictionContext();
  fresh.api.netPredictedShotPush(fresh.net.predictedShots, 900);
  fresh.api.netApplyFx({ k: 0, x: 1, y: 2, a: 0, o: 'me' });
  ok(fresh.calls.muzzle.length === 0 && fresh.calls.copShoot === 0, 'own muzzle with a fresh predicted shot is not replayed');
  ok(fresh.net.predictedShots.length === 0, 'the predicted shot is consumed');

  const empty = createPredictionContext();
  empty.api.netApplyFx({ k: 0, x: 1, y: 2, a: 0, o: 'me' });
  ok(empty.calls.muzzle.length === 1 && empty.calls.copShoot === 1, 'own muzzle with an empty queue plays late');

  const expired = createPredictionContext();
  expired.api.netPredictedShotPush(expired.net.predictedShots, 0);
  expired.sandbox.now = 5000;
  expired.api.netApplyFx({ k: 0, x: 1, y: 2, a: 0, o: 'me' });
  ok(expired.calls.muzzle.length === 1 && expired.calls.copShoot === 1, 'own muzzle with only an expired entry plays');
  ok(expired.net.predictedShots.length === 0, 'the expired entry is dropped');

  for (const owner of ['rival', undefined]) {
    const foreign = createPredictionContext();
    foreign.api.netPredictedShotPush(foreign.net.predictedShots, 900);
    foreign.api.netApplyFx(owner === undefined ? { k: 0, x: 1, y: 2, a: 0 } : { k: 0, x: 1, y: 2, a: 0, o: owner });
    ok(foreign.calls.muzzle.length === 1 && foreign.calls.copShoot === 1, 'foreign muzzle (' + owner + ') always plays');
    ok(foreign.net.predictedShots.length === 1, 'foreign muzzle (' + owner + ') leaves the queue untouched');
  }
}

function testWorldBulletsFilter() {
  const { api } = createPredictionContext();
  const incoming = [
    { x: 1, y: 2, a: 0, hostile: false, fl: 0, o: 'me' },
    { x: 3, y: 4, a: 0, hostile: false, fl: 1, o: 'rival' },
    { x: 5, y: 6, a: Math.PI, hostile: true, fl: 0 },
  ];
  const mapped = api.netWorldBulletsFrom(incoming, 'me');
  ok(mapped.length === 2, 'own bullets are dropped from the snapshot mapping');
  ok(mapped[0].x === 3 && mapped[0].vx === 12 && mapped[0].flame === true && mapped[0].fromPlayer === true, 'rival bullet kept with speed 12 and player tint');
  ok(mapped[1].hostile === true && !mapped[1].fromPlayer && Math.abs(mapped[1].vx + 12) < 1e-9, 'hostile bullet kept without player tint');
  ok(api.netWorldBulletsFrom(incoming, null).length === 3, 'no own id filters nothing');
}

function testPredictedBulletStep() {
  const { api, sandbox, net, calls } = createPredictionContext();
  net.predBullets.push({ x: 10, y: 20, vx: 13, vy: 0, life: 2 }, { x: 0, y: 0, vx: 1, vy: 1, life: 10 });
  api.netStepPredictedBullets();
  ok(net.predBullets[0].x === 23 && net.predBullets[0].life === 1 && net.predBullets[1].y === 1, 'predicted bullets advance and age');
  api.netStepPredictedBullets();
  ok(net.predBullets.length === 1 && net.predBullets[0].life === 8, 'bullet is removed at life 0');
  sandbox.solidTile = () => true;
  api.netStepPredictedBullets();
  ok(net.predBullets.length === 0, 'bullet is removed on a solid tile');
  ok(calls.muzzle.length === 0, 'removal spawns no fx');
}

function testPredictFire() {
  const pistol = createPredictionContext();
  pistol.sandbox.mClicked = true;
  pistol.api.netPredictFire();
  ok(pistol.net.predBullets.length === 1 && pistol.net.predictedShots.length === 1, 'pistol click predicts one bullet and one shot entry');
  ok(pistol.sandbox.player.shootCd === 20, 'prediction starts the weapon cooldown');
  const bullet = pistol.net.predBullets[0];
  ok(bullet.x === 514 && bullet.y === 700 && bullet.vx === 13 && bullet.life === 52 && bullet.fromPlayer === true, 'bullet starts 14 px ahead with weapon speed and life');
  ok(pistol.calls.muzzle.length === 1 && pistol.calls.shoot === 1, 'prediction plays the local muzzle flash and sound');
  pistol.api.netPredictFire();
  ok(pistol.net.predBullets.length === 1, 'cooldown blocks a second prediction');

  const shotgun = createPredictionContext();
  shotgun.sandbox.player.weaponIdx = 3;
  shotgun.sandbox.mClicked = true;
  shotgun.api.netPredictFire();
  ok(shotgun.net.predBullets.length === 6 && shotgun.net.predictedShots.length === 1 && shotgun.calls.muzzle.length === 1, 'shotgun predicts 6 pellets, one shot entry, one flash');

  const flamer = createPredictionContext();
  flamer.sandbox.player.weaponIdx = 6;
  flamer.sandbox.mDownL = true;
  flamer.api.netPredictFire();
  ok(flamer.net.predBullets.length === 3 && flamer.net.predBullets[0].flame === true, 'flamer fires on held button with 3 flamelets');

  const smg = createPredictionContext();
  smg.sandbox.player.weaponIdx = 2;
  smg.sandbox.mDownL = true;
  smg.api.netPredictFire();
  ok(smg.net.predBullets.length === 1 && smg.calls.smg === 1, 'automatic weapon fires while held');

  const blockers = {
    'melee weapon': context => { context.player.weaponIdx = 0; },
    'rocket launcher': context => { context.player.weaponIdx = 4; },
    'grenade': context => { context.player.weaponIdx = 5; },
    'down': context => { context.downT = 30; },
    'in a car': context => { context.player.car = {}; },
    'peace mode': context => { context.peaceMode = () => true; },
    'not authoritative': (context, net) => { net.authoritative = false; },
    'cooldown running': context => { context.player.shootCd = 3; },
    'no click': context => { context.mClicked = false; },
  };
  for (const [name, block] of Object.entries(blockers)) {
    const blocked = createPredictionContext();
    blocked.sandbox.mClicked = true;
    block(blocked.sandbox, blocked.net);
    blocked.api.netPredictFire();
    ok(blocked.net.predBullets.length === 0 && blocked.net.predictedShots.length === 0 && blocked.calls.muzzle.length === 0, 'no prediction: ' + name);
  }
}

function testNetShutdownResetsPrediction() {
  const shutdown = extractTopLevel(readSource('net.js'), 'netShutdown');
  ok(/predBullets\.length = 0/.test(shutdown) && /predictedShots\.length = 0/.test(shutdown), 'netShutdown clears predicted bullets and shots');
}

testBodyHistory();
testLagMsToTicks();
testNetLagCompMs();
testPredictedShotQueue();
testHostRewind();
testShooterTags();
testOwnMuzzleSuppression();
testWorldBulletsFilter();
testPredictedBulletStep();
testPredictFire();
testNetShutdownResetsPrediction();

console.log(`\nfire prediction: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
