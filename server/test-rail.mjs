import vm from 'node:vm';
import runtime from './sim-runtime.js';
import stubs from '../js/sim-stubs.js';
import { readSource, extractTopLevel } from './render-test-kit.mjs';
const { BUNDLE } = runtime;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const GRID_SIZES = { PABC12: [8, 8], MABC12: [8, 16], GABC12: [16, 16] };
const SIM_SCRIPT = new vm.Script(BUNDLE, { filename: 'libre-sim-bundle.js' });

function loadRoom(code, { peace = false } = {}) {
  const context = stubs.makeSimStubs(code, 900, { setTimeout, clearTimeout, setInterval, clearInterval });
  if (peace) context.localStorage.getItem = key => key === 'libreCity.spIntent' ? JSON.stringify({ code, violence: false }) : null;
  vm.createContext(context);
  SIM_SCRIPT.runInContext(context, { timeout: 5000 });
  return { sim: context.__sim, ev: expr => vm.runInContext(expr, context) };
}

function roomWithCars(code, options) {
  const room = loadRoom(code, options);
  room.sim.addPlayer('Tester', 0, 'p1');
  for (let f = 0; f < 600 && room.sim._cars().length === 0; f++) room.sim.tick();
  return room;
}

function checkRailway(label, code, { peace = false } = {}) {
  console.log(label);
  const { sim, ev } = roomWithCars(code, { peace });
  const [T, TRAIN_SPEED, TRAIN_BODY_H, TRAIN_LEN, ISLAND_BANKS] = ev('[T, TRAIN_SPEED, TRAIN_BODY_H, TRAIN_LEN, ISLAND_BANKS]');
  const APPROACH_GAP = 2.25 * T;
  const K = sim._tileKinds();
  const { loopLen, crossings, pointAt } = sim._rail();
  const wrap = along => ((along % loopLen) + loopLen) % loopLen;
  ok(ev('PEACE_CITY') === peace, `${label}: PEACE_CITY is ${peace}`);

  const start = pointAt(0), end = pointAt(loopLen);
  ok(Math.hypot(start.x - end.x, start.y - end.y) < 1, `${label}: the loop closes (${loopLen.toFixed(0)} px)`);
  const samples = [];
  for (let along = 0; along < loopLen; along += 8) samples.push(pointAt(along));
  samples.push(end);
  let widestStep = 0;
  for (let i = 1; i < samples.length; i++) widestStep = Math.max(widestStep, Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y));
  ok(widestStep <= 8.5, `${label}: the loop is continuous (widest 8 px step ${widestStep.toFixed(2)} px)`);

  let buildingsNearTrack = 0;
  const army = sim._landmarks().find(l => l.type === 'army');
  let samplesOnIsland = 0;
  for (const p of samples) {
    for (let ty = Math.floor(p.y / T) - 2; ty <= Math.floor(p.y / T) + 2; ty++) for (let tx = Math.floor(p.x / T) - 2; tx <= Math.floor(p.x / T) + 2; tx++)
      if (Math.hypot((tx + 0.5) * T - p.x, (ty + 0.5) * T - p.y) <= T && sim._tileAt(tx, ty) === K.BUILDING) buildingsNearTrack++;
    const tx = Math.floor(p.x / T), ty = Math.floor(p.y / T);
    if (army && tx >= army.x0 - ISLAND_BANKS && tx <= army.x1 + ISLAND_BANKS && ty >= army.y0 - ISLAND_BANKS && ty <= army.y1 + ISLAND_BANKS) samplesOnIsland++;
  }
  ok(buildingsNearTrack === 0, `${label}: no building within one tile of the track (${buildingsNearTrack})`);
  if (peace) ok(!army, `${label}: a peaceful city has no army base`);
  else ok(!!army && samplesOnIsland === 0, `${label}: the track stays off the army island (${samplesOnIsland} samples on it)`);

  const [columns, rows] = GRID_SIZES[code];
  ok(crossings.length >= 2 * (columns - 2) + 2 * (rows - 2), `${label}: every street leaving the ring road is crossed (${crossings.length} crossings)`);
  ok(crossings.every(cr => sim._tileAt(Math.floor(cr.x / T), Math.floor(cr.y / T)) === K.ROAD), `${label}: every crossing sits on a road tile`);

  const twin = loadRoom(code, { peace }).sim;
  sim._setFrame(1234); twin._setFrame(1234);
  ok(JSON.stringify(sim._train().segs) === JSON.stringify(twin._train().segs), `${label}: the train position depends on the frame only`);

  let fastestStep = 0;
  sim._setFrame(0);
  let previous = { x: sim._train().x, y: sim._train().y };
  for (let f = 1; f <= Math.ceil(loopLen / TRAIN_SPEED) + 2; f++) {
    sim._setFrame(f);
    const head = sim._train();
    fastestStep = Math.max(fastestStep, Math.hypot(head.x - previous.x, head.y - previous.y));
    previous = { x: head.x, y: head.y };
  }
  ok(fastestStep <= TRAIN_SPEED + 0.01, `${label}: the head moves at most TRAIN_SPEED per frame over a whole lap (${fastestStep.toFixed(3)} px)`);

  let worstCoupling = 0;
  for (const headS of [0, 60, 120, 180, 240, loopLen - 30]) {
    sim._setFrame(Math.round(headS / TRAIN_SPEED));
    const segs = sim._train().segs;
    for (let i = 1; i < segs.length; i++) {
      const expected = segs[i - 1].w / 2 + 8 + segs[i].w / 2;
      worstCoupling = Math.max(worstCoupling, Math.abs(Math.hypot(segs[i].cx - segs[i - 1].cx, segs[i].cy - segs[i - 1].cy) - expected));
    }
  }
  ok(worstCoupling < 2, `${label}: the train stays coupled while straddling s = 0 (worst ${worstCoupling.toFixed(2)} px)`);

  const car = sim._cars()[0];
  const frameWithHeadAt = headS => Math.round(wrap(headS) / TRAIN_SPEED);
  const approachCrossing = cr => {
    const railAngle = pointAt(cr.s).angle, normalX = -Math.sin(railAngle), normalY = Math.cos(railAngle);
    car.x = cr.x + normalX * APPROACH_GAP; car.y = cr.y + normalY * APPROACH_GAP;
    car.angle = Math.atan2(-normalY, -normalX); car.speed = 0;
  };
  const blockedNear = cr => { approachCrossing(cr); sim._setFrame(frameWithHeadAt(cr.s - 200)); return sim._trainBlocking(car); };
  const blockedFar = cr => { approachCrossing(cr); sim._setFrame(frameWithHeadAt(cr.s + loopLen / 2)); return sim._trainBlocking(car); };
  const bySpan = crossings.slice().sort((a, b) => a.s - b.s);
  const middle = bySpan[Math.floor(bySpan.length / 2)], first = bySpan[0], last = bySpan[bySpan.length - 1];
  ok(!!car && blockedNear(middle) && !blockedFar(middle), `${label}: a car approaching a crossing stops when the train is near, not when it is far`);
  ok(blockedNear(first) && !blockedFar(first), `${label}: the same holds for the first crossing after s = 0 (s = ${first.s.toFixed(0)})`);
  sim._setFrame(frameWithHeadAt(20));
  const headS = sim._train().s, straddles = wrap(headS - TRAIN_LEN) > headS;
  const heldAt = cr => { approachCrossing(cr); return sim._trainBlocking(car); };
  ok(straddles && heldAt(first) && heldAt(last),`${label}: a train straddling s = 0 holds the crossings on both sides of it (s = ${first.s.toFixed(0)} and ${last.s.toFixed(0)})`);

  const trackFrame = frameWithHeadAt((first.s + bySpan[1].s) / 2 + 150);
  sim._setFrame(trackFrame);
  const carriage = sim._train().segs[2];
  car.x = carriage.cx - carriage.sin * 5; car.y = carriage.cy + carriage.cos * 5;
  car.speed = 0;
  sim._trainCollide();
  const dx = car.x - carriage.cx, dy = car.y - carriage.cy;
  const lx = dx * carriage.cos + dy * carriage.sin, ly = dy * carriage.cos - dx * carriage.sin;
  const outside = Math.abs(lx) >= carriage.w / 2 + car.colH || Math.abs(ly) >= TRAIN_BODY_H / 2 + car.colH;
  ok(sim._cars().includes(car) && outside, `${label}: a car overlapping a carriage is pushed out of it (local ${lx.toFixed(1)}, ${ly.toFixed(1)})`);
}

for (const code of Object.keys(GRID_SIZES)) checkRailway(code, code);
checkRailway('PABC12 peace city', 'PABC12', { peace: true });

console.log('client train clock');
{
  const netSource = readSource('net.js');
  const clockSource = ['TRAIN_CLOCK_SNAP', 'netSlewTrainOffset', 'netNoteTrainTick', 'netTrainClock'].map(name => extractTopLevel(netSource, name)).join('\n');
  const makeClient = localFrame => {
    const context = vm.createContext({ net: { trainOffset: null, trainOffsetTarget: 0, trainSlewFrame: 0 }, frame: localFrame });
    vm.runInContext(clockSource, context);
    return {
      context,
      noteSnapshot: snapshot => vm.runInContext('netNoteTrainTick', context)(snapshot),
      clock: () => vm.runInContext('netTrainClock()', context),
      advance: frames => { context.frame += frames; },
    };
  };
  const [SNAP, DEADBAND] = vm.runInContext('[TRAIN_CLOCK_SNAP, TRAIN_CLOCK_DEADBAND]', makeClient(0).context);
  const trainAt = (room, clock) => { room._setFrame(clock); return JSON.stringify(room._train().segs); };

  const authority = loadRoom('PABC12').sim, client = loadRoom('PABC12').sim;
  authority.addPlayer('Tester', 0, 'p1');
  const snapshotAt = tick => { authority._setFrame(tick); return authority.snapshotFor('p1'); };

  const fresh = makeClient(321);
  ok(fresh.clock() === 321, 'without a snapshot the clock is the local frame (single-player)');
  fresh.noteSnapshot({ t: 'w' });
  ok(fresh.clock() === 321, 'a snapshot without a tick leaves the clock on the local frame');

  const snapshot = snapshotAt(1234);
  ok(snapshot.tick === 1234, 'the snapshot carries the sim tick');
  const synced = makeClient(500);
  synced.noteSnapshot(snapshot);
  ok(synced.clock() === 1234, 'the first snapshot snaps the client clock to the sim tick, not its local frame');
  ok(trainAt(client, synced.clock()) === trainAt(authority, 1234), 'client train equals the sim train at the snapshot tick although the local frame differs');

  synced.advance(17);
  ok(synced.clock() === 1234 + 17, 'between snapshots the clock advances with the local frames from the last tick');
  ok(trainAt(client, synced.clock()) === trainAt(authority, 1234 + 17), 'between snapshots the client train follows the sim train');

  const steadyClock = synced.clock();
  synced.noteSnapshot({ tick: steadyClock + DEADBAND });
  ok(synced.clock() === steadyClock, `a tick ${DEADBAND} frames ahead is jitter: the clock does not move`);
  synced.noteSnapshot({ tick: steadyClock - DEADBAND });
  synced.advance(10);
  ok(synced.clock() === steadyClock + 10, `jitter of ${DEADBAND} frames either way is ignored, the clock keeps the local pace`);

  const slewFrom = synced.clock(), slewError = 10;
  synced.noteSnapshot({ tick: slewFrom + slewError });
  ok(synced.clock() === slewFrom, 'a medium error does not jump the clock on the snapshot frame');
  const steps = [];
  for (let f = 1; f <= slewError + 5; f++) { const before = synced.clock(); synced.advance(1); steps.push(synced.clock() - before); }
  ok(steps.every(step => step >= 1 && step <= 2), `while slewing the clock moves at most 1 extra frame per frame (${steps.join(',')})`);
  ok(synced.clock() === slewFrom + slewError + slewError + 5, 'the slew closes a medium error and then the clock keeps the local pace');

  const behindFrom = synced.clock();
  synced.noteSnapshot({ tick: behindFrom - slewError });
  const backSteps = [];
  for (let f = 1; f <= slewError + 5; f++) { const before = synced.clock(); synced.advance(1); backSteps.push(synced.clock() - before); }
  ok(backSteps.every(step => step >= 0 && step <= 1), `a clock ahead of the sim slows down, never runs backwards (${backSteps.join(',')})`);
  ok(synced.clock() === behindFrom - slewError + slewError + 5, 'the slew closes a clock running ahead too');

  const edgeFrom = synced.clock();
  synced.noteSnapshot({ tick: edgeFrom + SNAP });
  ok(synced.clock() === edgeFrom, `an error of exactly ${SNAP} frames is slewed, not snapped`);
  synced.advance(SNAP);
  ok(synced.clock() === edgeFrom + 2 * SNAP, `the ${SNAP}-frame error is closed in ${SNAP} frames`);

  synced.noteSnapshot(snapshotAt(5000));
  ok(synced.clock() === 5000, `an error above ${SNAP} frames snaps the clock to the sim tick`);
  ok(trainAt(client, synced.clock()) === trainAt(authority, 5000), 'after a snap the client train equals the sim train, no drift');

  const netClient = vm.createContext({
    net: { trainOffset: null, trainOffsetTarget: 0, trainSlewFrame: 0, wcars: new Map(), wpeds: new Map(), players: new Map(), myId: 'p1' },
    frame: 800, trainClocks: [], cars: [], peds: [], coins: [], fires: [], TAU: Math.PI * 2, rnd: () => 0,
    sfx: new Proxy({}, { get: () => () => {} }), player: { car: null }, downT: 1, wanted: 0, mClicked: false, ladderEl: null,
  });
  for (const name of ['applyTouchInput', 'netInterpWorld', 'netRebuildArrays', 'netReconcileMe', 'netSendInput', 'updateParts', 'updateCamera',
                      'netApplyCar', 'interpFeed', 'netApplyFx', 'toast']) netClient[name] = () => {};
  Object.assign(netClient, {
    updateTrainKinematics: clock => netClient.trainClocks.push(clock), playerSirenOn: () => false,
    netMakeWorldCar: () => ({}), makeGhost: () => ({}), evText: () => ' ',
  });
  vm.runInContext([clockSource, ...['NET_SHIRTS', 'netOnSnapshot', 'updateNetClient'].map(name => extractTopLevel(netSource, name))].join('\n'), netClient);
  vm.runInContext('updateNetClient()', netClient);
  ok(netClient.trainClocks[0] === 800, 'before any snapshot updateNetClient runs the train on the local frame');
  vm.runInContext('netOnSnapshot', netClient)(snapshotAt(2400));
  for (let f = 0; f < 5; f++) vm.runInContext('updateNetClient()', netClient);
  ok(netClient.trainClocks.slice(1).join(',') === '2400,2401,2402,2403,2404', `netOnSnapshot feeds the tick and updateNetClient drives the train from it (${netClient.trainClocks.slice(1).join(',')})`);
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
