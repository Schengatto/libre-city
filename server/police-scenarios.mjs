const SETTLE_TICKS = 5;
const ENTER_EXIT_BUTTON = 4;
const RUN_OVER_SPEED = 5;
const PED_AHEAD_DISTANCE = 20;
const RUN_OVER_TICKS = 40;
const CHASE_TICKS = 600;

export function runOverPedestrians(sim, driverId) {
  const driver = sim._player(driverId);
  for (let i = 0; i < SETTLE_TICKS; i++) sim.tick();
  const car = sim._cars().find(c => c.role === 'traffic' || c.role === 'parked');
  driver.x = car.x; driver.y = car.y;
  sim.applyInput(driverId, { b: ENTER_EXIT_BUTTON });
  sim.tick();
  const result = { inCar: !!driver.car, knocked: 0, wantedAfterRunOver: 0, maxSnapshotCops: 0, maxSnapshotPoliceCars: 0 };
  if (!driver.car) return result;
  for (let i = 0; i < RUN_OVER_TICKS && driver.car; i++) {
    const drivenCar = driver.car;
    drivenCar.speed = RUN_OVER_SPEED;
    const ped = sim._spawnPed(drivenCar.x + Math.cos(drivenCar.angle) * PED_AHEAD_DISTANCE,
      drivenCar.y + Math.sin(drivenCar.angle) * PED_AHEAD_DISTANCE, 'civ');
    sim.tick();
    if (ped.ko) result.knocked++;
  }
  result.wantedAfterRunOver = driver.wanted | 0;
  for (let i = 0; i < CHASE_TICKS; i++) {
    sim.tick();
    const snapshot = sim.snapshotFor(driverId);
    result.maxSnapshotCops = Math.max(result.maxSnapshotCops, snapshot.peds.filter(p => p.role === 'cop').length);
    result.maxSnapshotPoliceCars = Math.max(result.maxSnapshotPoliceCars, snapshot.cars.filter(c => c.role === 'police').length);
  }
  return result;
}
