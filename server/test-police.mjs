import runtime from './sim-runtime.js';
const { createRoomSim } = runtime;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const PISTOL_INDEX = 1;
const SHOOT_EVERY_TICKS = 25;
const SHOOTING_TICKS = 300;
const TOTAL_TICKS = 500;

function runPoliceScenario(roomCode, playerCount, criminalIndex) {
  const sim = createRoomSim(roomCode);
  const playerIds = [];
  for (let k = 0; k < playerCount; k++) playerIds.push(sim.addPlayer('P' + k, k));
  const criminalId = playerIds[criminalIndex];
  const criminal = sim._player(criminalId);
  playerIds.forEach((id, k) => { if (k !== criminalIndex) sim._player(id).x += 3000 * (k + 1); });
  criminal.owned[PISTOL_INDEX] = true; criminal.weaponIdx = PISTOL_INDEX;
  for (let i = 0; i < 30; i++) sim.tick();
  const result = { maxWanted: 0, maxSnapshotCops: 0, maxSnapshotPoliceCars: 0, innocentMaxWanted: 0 };
  for (let i = 0; i < TOTAL_TICKS; i++) {
    const shooting = i % SHOOT_EVERY_TICKS === 0 && i < SHOOTING_TICKS;
    if (shooting) sim._spawnPed(criminal.x + 40, criminal.y, 'civ');
    sim.applyInput(criminalId, { aim: 0, b: shooting ? 3 : 0, px: criminal.x, py: criminal.y });
    sim.tick();
    const snapshot = sim.snapshotFor(criminalId);
    result.maxWanted = Math.max(result.maxWanted, snapshot.me.wanted);
    result.maxSnapshotCops = Math.max(result.maxSnapshotCops, snapshot.peds.filter(p => p.role === 'cop').length);
    result.maxSnapshotPoliceCars = Math.max(result.maxSnapshotPoliceCars, snapshot.cars.filter(c => c.role === 'police').length);
    for (const id of playerIds) if (id !== criminalId) result.innocentMaxWanted = Math.max(result.innocentMaxWanted, sim._player(id).wanted | 0);
  }
  return result;
}

const scenarios = [
  { label: 'solo player in the room', roomCode: 'POLICE1', playerCount: 1, criminalIndex: 0 },
  { label: 'host is the criminal, guest far away', roomCode: 'POLICE2', playerCount: 2, criminalIndex: 0 },
  { label: 'guest is the criminal, host far away', roomCode: 'POLICE3', playerCount: 2, criminalIndex: 1 },
  { label: 'third player is the criminal, others far away', roomCode: 'POLICE4', playerCount: 3, criminalIndex: 2 },
];

for (const scenario of scenarios) {
  console.log(scenario.label);
  const result = runPoliceScenario(scenario.roomCode, scenario.playerCount, scenario.criminalIndex);
  console.log('  ', JSON.stringify(result));
  ok(result.maxWanted >= 2, 'crimes raise the criminal wanted level to 2+ stars');
  ok(result.maxSnapshotCops > 0, 'cops on foot appear in the criminal snapshot');
  ok(result.maxSnapshotPoliceCars > 0, 'police cars appear in the criminal snapshot');
  if (scenario.playerCount > 1) ok(result.innocentMaxWanted === 0, 'innocent players stay unwanted');
}

console.log(`\n${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
