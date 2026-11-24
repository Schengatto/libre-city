import vm from 'node:vm';
import runtime from './sim-runtime.js';
import stubs from '../js/sim-stubs.js';
const { BUNDLE } = runtime;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const CODES = ['P', 'M', 'G'].flatMap(size => Array.from({ length: 8 }, (_, k) => `${size}ARM${k}`));
const TRIES = 120;
const SPOT_KINDS = ['mpSpawn', 'respawn', 'fare', 'ride', 'pizza', 'rescue', 'crime', 'fire', 'parked', 'coin', 'civilian'];

function loadCity(code) {
  const context = vm.createContext(stubs.makeSimStubs(code, 900, { setTimeout, clearTimeout, setInterval, clearInterval }));
  vm.runInContext(BUNDLE, context, { timeout: 5000 });
  return expr => vm.runInContext(expr, context);
}

const COLLECT_ISLAND_HITS = `(() => {
  const island = armyZone.island;
  const onIsland = spot => {
    if (!spot) return false;
    const tx = Math.floor(spot.x / T), ty = Math.floor(spot.y / T);
    return tx >= island.x0 && tx <= island.x1 && ty >= island.y0 && ty <= island.y1;
  };
  const centre = { x: (island.x0 + island.x1 + 1) / 2 * T, y: (island.y0 + island.y1 + 1) / 2 * T };
  const hits = Object.fromEntries(${JSON.stringify(SPOT_KINDS)}.map(kind => [kind, 0]));
  const count = (kind, spot) => { if (onIsland(spot)) hits[kind]++; };
  const hospitals = landmarks.filter(l => l.type === 'hospital');
  const withoutHospitals = landmarks.filter(l => l.type !== 'hospital');
  let armyRoadReachable = false;
  const armyBase = landmarks.find(l => l.type === 'army');
  for (let i = 0; i < ${TRIES}; i++) {
    const angle = rnd(0, TAU), distance = rnd(0, 1200);
    player.x = centre.x + Math.cos(angle) * distance; player.y = centre.y + Math.sin(angle) * distance;
    peds.length = 0; fires.length = 0; coins.length = 0;

    count('mpSpawn', makeSimPlayer('guest', 0));

    landmarks.splice(0, landmarks.length, ...withoutHospitals);
    const before = { x: player.x, y: player.y };
    downKind = 'dead'; respawnPlayer();
    count('respawn', player);
    landmarks.push(...hospitals);
    player.x = before.x; player.y = before.y;

    taxi.phase = 'idle'; taxi.fare = null; taxi.dest = null;
    spawnFare(); count('fare', taxi.fare);
    if (taxi.fare) { startRide(); count('ride', taxi.dest); }
    pizza.phase = 'idle'; pizza.client = null;
    spawnOrder(); count('pizza', pizza.client);
    rescue.phase = 'idle'; rescue.patient = null;
    spawnEmergency(); count('rescue', rescue.patient);
    patrol.phase = 'idle'; patrol.robber = null;
    spawnCrime(); count('crime', patrol.robber);
    firejob.phase = 'idle'; firejob.site = null;
    spawnFire(); count('fire', firejob.site);

    count('parked', randomParkingNear(player.x, player.y, 0, 900));
    spawnCoinNear(player.x, player.y, 0, 900); count('coin', coins[0]);
    count('civilian', randomWalkNear(player.x, player.y, 0, 900));

    if (armyBase && onIsland(randomRoadNear(armyBase.door.x, armyBase.door.y, 80, 520))) armyRoadReachable = true;
  }
  return { hits, armyRoadReachable };
})()`;

console.log('1) army island stays reserved to the army');
const failingCodes = Object.fromEntries(SPOT_KINDS.map(kind => [kind, []]));
const codesWithoutBase = [], codesWithoutArmyRoad = [];
for (const code of CODES) {
  const run = loadCity(code);
  if (!run('!!armyZone')) { codesWithoutBase.push(code); continue; }
  const { hits, armyRoadReachable } = run(COLLECT_ISLAND_HITS);
  for (const kind of SPOT_KINDS) if (hits[kind]) failingCodes[kind].push(`${code}:${hits[kind]}`);
  if (!armyRoadReachable) codesWithoutArmyRoad.push(code);
}
ok(codesWithoutBase.length === 0, `every test city has an army base (missing: ${codesWithoutBase.join(', ') || 'none'})`);
for (const kind of SPOT_KINDS)
  ok(failingCodes[kind].length === 0, `${kind} never lands on the army island (hits: ${failingCodes[kind].join(', ') || 'none'})`);
ok(codesWithoutArmyRoad.length === 0, `army reinforcements still find the island road by the gate (missing: ${codesWithoutArmyRoad.join(', ') || 'none'})`);

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
