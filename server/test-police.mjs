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

console.log('population reaches a far second player');
{
  const sim = createRoomSim('CROWD1');
  const hostId = sim.addPlayer('Host', 0), guestId = sim.addPlayer('Guest', 1);
  const host = sim._player(hostId), guest = sim._player(guestId);
  const tileSize = 32, cityEdgeX = sim._cityWidth() * tileSize;
  let farSpot;
  do farSpot = sim._randomWalkNear(host.x, host.y, 3500, 4500); while (farSpot.x >= cityEdgeX);
  guest.x = farSpot.x; guest.y = farSpot.y;
  const nearGuest = e => Math.hypot(e.x - guest.x, e.y - guest.y) < 900;
  let civiliansNearGuest = 0, trafficNearGuest = 0;
  for (let i = 0; i < 1200; i++) {
    sim.tick();
    if (i % 100 === 99) {
      civiliansNearGuest += sim._peds().filter(p => p.role === 'civ' && nearGuest(p)).length;
      trafficNearGuest += sim._cars().filter(c => c.role === 'traffic' && nearGuest(c)).length;
    }
  }
  console.log('  ', JSON.stringify({ civiliansNearGuest, trafficNearGuest }));
  ok(civiliansNearGuest > 0, 'civilians spawn around the far guest');
  ok(trafficNearGuest > 0, 'traffic spawns around the far guest');
}

console.log('a cop chases the wanted player, not a closer innocent');
{
  const sim = createRoomSim('CHASE1');
  const innocentId = sim.addPlayer('Innocent', 0), criminalId = sim.addPlayer('Criminal', 1);
  const innocent = sim._player(innocentId), criminal = sim._player(criminalId);
  criminal.wanted = 3; criminal.wantedHeat = 3.5; criminal.crimeCd = 600;
  const cop = sim._spawnPed(criminal.x - 300, criminal.y, 'cop');
  innocent.x = cop.x; innocent.y = cop.y + 50;
  sim.tick();
  const towardCriminal = Math.atan2(criminal.y - cop.y, criminal.x - cop.x);
  const towardInnocent = Math.atan2(innocent.y - cop.y, innocent.x - cop.x);
  const angleGap = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  console.log('   facing', cop.facing.toFixed(2), 'criminal', towardCriminal.toFixed(2), 'innocent', towardInnocent.toFixed(2));
  ok(angleGap(cop.facing, towardCriminal) < 0.3, 'the cop heads for the wanted player');
  ok(angleGap(cop.facing, towardInnocent) > 0.6, 'the cop ignores the closer innocent');
}

console.log(`\n${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
