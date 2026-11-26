import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { runOverPedestrians } from './police-scenarios.mjs';

const require = createRequire(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS_DIR = path.join(ROOT_DIR, 'js');
const { SIM_FILES, createRoomSim } = require('./sim-runtime.js');
const { buildSimWorkerBundle } = require('../build-sim-worker.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 1; this.sent = []; this.closed = false; FakeSocket.instances.push(this); }
  send(data) { this.sent.push(data); }
  close() { this.closed = true; }
}

function createWorkerHarness(workerGlobals = {}) {
  let now = 0;
  let nextTimerId = 1;
  const timers = [];
  const posted = [];
  const importedFiles = [];
  const scope = {
    location: { hash: '#room=TEST' },
    name: 'TEST',
    navigator: { userAgent: 'fake-worker' },
    postMessage: message => posted.push(message),
    WebSocket: FakeSocket,
    TextEncoder, TextDecoder,
    performance: { now: () => now },
    console,
    setTimeout, clearTimeout,
    setInterval: (fn, ms) => { const id = nextTimerId++; timers.push({ id, fn, ms, next: now + ms }); return id; },
    clearInterval: id => { const index = timers.findIndex(timer => timer.id === id); if (index >= 0) timers.splice(index, 1); },
    ...workerGlobals,
  };
  scope.self = scope;
  vm.createContext(scope);
  scope.importScripts = (...files) => {
    for (const file of files) {
      importedFiles.push(file);
      vm.runInContext(fs.readFileSync(path.join(JS_DIR, file), 'utf8'), scope, { filename: file });
    }
  };
  const run = file => vm.runInContext(fs.readFileSync(path.join(JS_DIR, file), 'utf8'), scope, { filename: file });
  const advance = ms => {
    for (let elapsed = 0; elapsed < ms; elapsed++) {
      now += 1;
      for (const timer of [...timers]) if (now >= timer.next) { timer.next += timer.ms; timer.fn(); }
    }
  };
  const send = data => scope.onmessage({ data });
  return { scope, posted, importedFiles, run, advance, send };
}

const { snapshotDecode } = require('../js/snapshot-codec.js');
const binaryFramesTo = (fakeSocket, guestId) => fakeSocket.sent.filter(frame => ArrayBuffer.isView(frame) && frame[0] === 0x57
  && Buffer.from(frame.buffer, frame.byteOffset + 2, frame[1]).toString('utf8') === guestId);
const decodeGuestFrame = frame => snapshotDecode(frame.subarray(2 + frame[1]));
function deliver(socket, message) { socket.onmessage({ data: JSON.stringify(message) }); }
function lastHostState(socket) {
  const frames = socket.sent.filter(frame => typeof frame === 'string' && frame.startsWith('{')).map(frame => JSON.parse(frame));
  return frames.filter(frame => frame.t === 'hst').pop();
}

console.log('dev load');
const harness = createWorkerHarness();
harness.run('sim-worker.js');
ok(harness.importedFiles.length === 0, 'no sim script loaded before start');
harness.send({ type: 'start', url: 'ws://fake/host', code: 'test', token: 'tok-1', hostId: 'p1' });
ok(harness.importedFiles[0] === 'sim-stubs.js', 'stubs are imported first');
ok(JSON.stringify(harness.importedFiles.slice(1)) === JSON.stringify(SIM_FILES), 'sim files are imported in the server order');
ok(harness.scope.location.hash === '#room=TEST', 'location is the stub carrying the room code');
ok(harness.scope.navigator.userAgent === 'fake-worker', 'native navigator is not overridden');
ok(typeof harness.scope.sfx === 'object' && typeof harness.scope.netActive === 'function', 'missing stubs are copied onto self');
const socket = FakeSocket.instances[0];
ok(socket && socket.url === 'ws://fake/host', 'hostlink socket opens on the given url');
socket.onopen();
const hostlink = JSON.parse(socket.sent[0]);
ok(hostlink.t === 'hostlink' && hostlink.code === 'TEST' && hostlink.token === 'tok-1', 'first send is hostlink with code and token');

deliver(socket, {
  t: 'hoststart',
  roster: [{ id: 'p1', name: 'Host', shirtIdx: 0 }, { id: 'p2', name: 'Guest', shirtIdx: 1 }],
  state: [{ id: 'p2', s: 250 }],
});
ok(harness.posted.some(m => m.type === 'ready'), 'worker posts ready after hoststart');
harness.advance(200);
const hostSnapshots = harness.posted.filter(m => m.type === 'snapshot');
ok(hostSnapshots.length > 0 && hostSnapshots[0].snapshot.t === 'w' && Array.isArray(hostSnapshots[0].snapshot.sc), 'host snapshot goes to the main thread with sc');
const guestFrames = binaryFramesTo(socket, 'p2');
ok(guestFrames.length > 0, 'guest snapshots go over the socket as binary W frames for p2');
ok(guestFrames.every(frame => frame[0] === 0x57 && frame[1] === 2 && frame[2 + frame[1]] === 0xB5 && frame[3 + frame[1]] === 0x01), 'binary frames are 0x57, id length, id, then the codec header');
const guestSnapshot = decodeGuestFrame(guestFrames[0]);
ok(guestSnapshot && guestSnapshot.t === 'w' && guestSnapshot.me && Array.isArray(guestSnapshot.sc), 'guest frame carries a w snapshot with me and sc');
ok(binaryFramesTo(socket, 'p1').length === 0 && !socket.sent.some(frame => typeof frame === 'string' && frame.startsWith('W|')), 'the host never gets a W frame and no text W frame is sent');
ok(guestFrames.length >= 5 && guestFrames.length <= 8, 'about one snapshot every 2 ticks (' + guestFrames.length + ' in 200 ms)');

harness.advance(320);
const firstHostState = lastHostState(socket);
ok(!!firstHostState, 'hst is sent every 500 ms');
const restoredScore = firstHostState.scores.find(s => s.id === 'p2');
ok(restoredScore && restoredScore.s === 250, 'restored score survives into hst');
ok(firstHostState.players.length === 2 && firstHostState.players.every(row => typeof row.x === 'number'), 'hst carries exported player rows');

console.log('input and membership');
const startX = firstHostState.players.find(row => row.id === 'p2').x;
deliver(socket, { t: 'i', id: 'p2', ax: 1, px: startX + 40, py: firstHostState.players.find(row => row.id === 'p2').y, b: 0 });
harness.advance(520);
const movedX = lastHostState(socket).players.find(row => row.id === 'p2').x;
ok(movedX > startX, 'p2 moved after its input');
harness.send({ type: 'input', input: { ax: 0, ay: 0 } });
deliver(socket, { t: 'join', id: 'p3', name: 'Late', shirtIdx: 2 });
harness.advance(520);
ok(lastHostState(socket).players.some(row => row.id === 'p3'), 'a joining player appears in hst');
ok(binaryFramesTo(socket, 'p3').length > 0, 'the joining player gets snapshots');
deliver(socket, { t: 'leave', id: 'p3' });
harness.advance(520);
ok(!lastHostState(socket).players.some(row => row.id === 'p3'), 'a leaving player disappears from hst');

console.log('p2p routing');
const p2pGuestFrames = () => harness.posted.filter(m => m.type === 'guestFrame' && m.id === 'p2');
const socketFramesToP2 = () => binaryFramesTo(socket, 'p2').length;
harness.send({ type: 'p2p', id: 'p2', open: true });
const socketFramesBeforeP2p = socketFramesToP2();
vm.runInContext('playerById("p2").events = [{ k: "toast", m: "hello" }]', harness.scope);
harness.advance(150);
ok(socketFramesToP2() === socketFramesBeforeP2p, 'a p2p guest gets no W frame over the socket');
ok(p2pGuestFrames().length >= 1, 'a p2p guest gets guestFrame messages');
const eventFrame = p2pGuestFrames().find(m => m.events !== null);
ok(eventFrame && JSON.parse(eventFrame.events).t === 'we' && JSON.parse(eventFrame.events).ev.length === 1, 'queued me.ev lands in the events string');
ok(eventFrame && ArrayBuffer.isView(eventFrame.snapshot) && eventFrame.snapshot[0] === 0xB5 && eventFrame.snapshot[1] === 0x01, 'the guestFrame snapshot is a codec byte array');
const eventSnapshot = eventFrame && snapshotDecode(eventFrame.snapshot);
ok(eventSnapshot && typeof JSON.parse(eventFrame.events).tick === 'number' && JSON.parse(eventFrame.events).tick === eventSnapshot.tick, 'events carry the snapshot tick');
ok(eventSnapshot && eventSnapshot.t === 'w' && eventSnapshot.me.ev === null && eventSnapshot.fx.length === 0,
  'the guestFrame snapshot is a w snapshot without me.ev and fx');
ok(p2pGuestFrames().some(m => m.events === null), 'a frame without events carries null events');
const appliedInputs = [];
const realApplyInput = harness.scope.__sim.applyInput;
harness.scope.__sim.applyInput = (id, input) => { appliedInputs.push(id); return realApplyInput(id, input); };
harness.send({ type: 'guestInput', id: 'p2', input: { seq: 7, ax: 1 } });
harness.send({ type: 'guestInput', id: 'p9', input: { seq: 8 } });
harness.send({ type: 'guestInput', id: 'p1', input: { seq: 9 } });
ok(appliedInputs.length === 1 && appliedInputs[0] === 'p2', 'guestInput reaches applyInput only for a known non-host guest');
harness.advance(40);
ok(snapshotDecode(p2pGuestFrames().pop().snapshot).ack === 7, 'the guest input is applied to the sim');
harness.scope.__sim.applyInput = realApplyInput;
harness.send({ type: 'p2p', id: 'p2', open: false });
const socketFramesAfterClose = socketFramesToP2();
harness.advance(60);
ok(socketFramesToP2() > socketFramesAfterClose, 'closing p2p brings the W frames back');

console.log('catch-up cap');
const lastGuestTick = () => decodeGuestFrame(binaryFramesTo(socket, 'p2').pop()).tick;
const tickBeforeStall = lastGuestTick();
harness.scope.performance.now = () => 1e9;
harness.advance(20);
const ticksAfterStall = lastGuestTick() - tickBeforeStall;
ok(ticksAfterStall >= 14 && ticksAfterStall <= 20, 'a long stall catches up at most 250 ms of ticks (' + ticksAfterStall + ')');

console.log('delta frames');
const { snapshotDeltaApply } = require('../js/snapshot-delta.js');
const SNAPSHOT_ROUND_MS = 40;
function startGuestRoom() {
  const room = createWorkerHarness();
  room.run('sim-worker.js');
  room.send({ type: 'start', url: 'ws://fake/host', code: 'test', token: 'tok-d', hostId: 'p1' });
  const roomSocket = FakeSocket.instances[FakeSocket.instances.length - 1];
  roomSocket.onopen();
  deliver(roomSocket, { t: 'hoststart', roster: [{ id: 'p1', name: 'Host', shirtIdx: 0 }, { id: 'p2', name: 'Guest', shirtIdx: 1 }], state: [] });
  let seq = 0;
  return {
    room,
    socket: roomSocket,
    frames: () => binaryFramesTo(roomSocket, 'p2').map(decodeGuestFrame),
    p2pFrames: () => room.posted.filter(m => m.type === 'guestFrame' && m.id === 'p2'),
    ackOverSocket: sa => deliver(roomSocket, { t: 'i', id: 'p2', seq: ++seq, sa }),
    ackOverP2p: sa => room.send({ type: 'guestInput', id: 'p2', input: { seq: ++seq, sa } }),
    round: (rounds = 1) => room.advance(rounds * SNAPSHOT_ROUND_MS),
    queueEvent: () => vm.runInContext('playerById("p2").events = [{ k: "toast", m: "hello" }]', room.scope),
  };
}
const lastTick = frames => frames[frames.length - 1].tick;

const noAck = startGuestRoom();
noAck.round(10);
ok(noAck.frames().length >= 5 && noAck.frames().every(frame => !('base' in frame)), 'without sa every frame to p2 is full');

const acked = startGuestRoom();
acked.round(5);
const ackedFullFrame = acked.frames().pop();
const framesBeforeAck = acked.frames().length;
acked.ackOverSocket(ackedFullFrame.tick);
acked.round(2);
const firstDelta = acked.frames()[framesBeforeAck];
ok(firstDelta && firstDelta.base === ackedFullFrame.tick, 'the first frame after a valid sa is a delta against that tick');
const appliedDelta = firstDelta && snapshotDeltaApply(ackedFullFrame, firstDelta);
ok(appliedDelta !== null && appliedDelta && appliedDelta.tick === firstDelta.tick, 'the delta applies on the decoded acked frame');
ok(acked.frames().slice(framesBeforeAck).every(frame => frame.base === ackedFullFrame.tick), 'frames keep using the acked base until a newer ack arrives');
acked.round(40);
ok(!('base' in acked.frames().pop()), 'after 40 rounds without a new ack the base left the history and the frame is full');

for (const [label, invalidAck] of [['an unknown tick', 999999], ['a non-numeric value', 'x'], ['an infinite value', Infinity]]) {
  const invalid = startGuestRoom();
  invalid.round(5);
  invalid.ackOverSocket(lastTick(invalid.frames()));
  invalid.round(2);
  ok('base' in invalid.frames().pop(), 'precondition: a valid ack gives deltas (' + label + ')');
  invalid.ackOverSocket(invalidAck);
  const framesBeforeInvalid = invalid.frames().length;
  invalid.round(2);
  ok(invalid.frames().slice(framesBeforeInvalid).every(frame => !('base' in frame)), 'sa as ' + label + ' gives full frames');
}

const dropped = startGuestRoom();
dropped.round(5);
dropped.ackOverSocket(lastTick(dropped.frames()));
dropped.round(2);
dropped.socket.onmessage({ data: JSON.stringify({ t: 'i', id: 'p2', seq: 99 }) });
const framesBeforeDrop = dropped.frames().length;
dropped.round(2);
ok(dropped.frames().slice(framesBeforeDrop).every(frame => !('base' in frame)), 'an input without sa after a valid one gives full frames');

const hostAck = startGuestRoom();
hostAck.round(5);
const hostSnapshotTick = hostAck.room.posted.filter(m => m.type === 'snapshot').pop().snapshot.tick;
deliver(hostAck.socket, { t: 'i', id: 'p1', seq: 1, sa: hostSnapshotTick });
hostAck.room.send({ type: 'input', input: { ax: 0, ay: 0, sa: hostSnapshotTick } });
hostAck.round(3);
const hostAckSnapshots = hostAck.room.posted.filter(m => m.type === 'snapshot');
ok(hostAckSnapshots.length > 5 && hostAckSnapshots.every(m => !('base' in m.snapshot) && m.snapshot.fx !== undefined && m.snapshot.me.ev !== undefined), 'the host frame stays full even after an sa for its own tick');

const rejoin = startGuestRoom();
rejoin.round(5);
const oldP2Tick = lastTick(rejoin.frames());
rejoin.ackOverSocket(oldP2Tick);
rejoin.round(2);
ok('base' in rejoin.frames().pop(), 'precondition: p2 gets deltas before leaving');
deliver(rejoin.socket, { t: 'leave', id: 'p2' });
deliver(rejoin.socket, { t: 'join', id: 'p2', name: 'Guest', shirtIdx: 1 });
rejoin.ackOverSocket(oldP2Tick);
const framesBeforeRejoin = rejoin.frames().length;
rejoin.round(2);
ok(rejoin.frames().length > framesBeforeRejoin && rejoin.frames().slice(framesBeforeRejoin).every(frame => !('base' in frame)), 'after leave and rejoin an old sa gives full frames');

const ackBeforeJoin = startGuestRoom();
ackBeforeJoin.round(5);
deliver(ackBeforeJoin.socket, { t: 'leave', id: 'p2' });
deliver(ackBeforeJoin.socket, { t: 'i', id: 'p2', seq: 50, sa: 1 });
deliver(ackBeforeJoin.socket, { t: 'join', id: 'p2', name: 'Guest', shirtIdx: 1 });
const framesBeforeLateJoin = ackBeforeJoin.frames().length;
ackBeforeJoin.round(2);
ok(ackBeforeJoin.frames().slice(framesBeforeLateJoin).every(frame => !('base' in frame)), 'an input from a non-member does not leave a baseline behind');

const closedRound = startGuestRoom();
closedRound.round(5);
closedRound.socket.readyState = 3;
const hostSnapshotsBeforeClosedRound = closedRound.room.posted.filter(m => m.type === 'snapshot').length;
closedRound.round(1);
const hostSnapshotsDuringClosedRound = closedRound.room.posted.filter(m => m.type === 'snapshot');
ok(hostSnapshotsDuringClosedRound.length > hostSnapshotsBeforeClosedRound, 'precondition: a snapshot round ran while the socket was closed');
const unsentTick = hostSnapshotsDuringClosedRound.pop().snapshot.tick;
closedRound.socket.readyState = 1;
closedRound.ackOverSocket(unsentTick);
const framesBeforeReopen = closedRound.frames().length;
closedRound.round(2);
ok(closedRound.frames().length > framesBeforeReopen && closedRound.frames().slice(framesBeforeReopen).every(frame => !('base' in frame)), 'a round never handed to the socket is not a baseline');

const p2pDelta = startGuestRoom();
p2pDelta.room.send({ type: 'p2p', id: 'p2', open: true });
p2pDelta.round(5);
const p2pFullFrames = p2pDelta.p2pFrames().map(m => snapshotDecode(m.snapshot));
ok(p2pFullFrames.length >= 3 && p2pFullFrames.every(frame => !('base' in frame)), 'p2p frames are full without an ack');
const p2pAckedTick = lastTick(p2pFullFrames);
p2pDelta.ackOverP2p(p2pAckedTick);
const p2pFramesBeforeAck = p2pDelta.p2pFrames().length;
p2pDelta.queueEvent();
p2pDelta.round(5);
const p2pAfterAck = p2pDelta.p2pFrames().slice(p2pFramesBeforeAck);
const p2pDecodedAfterAck = p2pAfterAck.map(m => snapshotDecode(m.snapshot));
const p2pAckedState = p2pFullFrames[p2pFullFrames.length - 1];
ok(p2pDecodedAfterAck.length >= 3 && p2pDecodedAfterAck.every(frame => frame.base === p2pAckedTick), 'p2p frames after the ack are deltas');
ok(p2pDecodedAfterAck.every(frame => (frame.fx === undefined || frame.fx.length === 0) && (frame.me.ev === undefined || frame.me.ev === null)), 'p2p delta frames carry no events');
ok(p2pDecodedAfterAck.every(frame => { const applied = snapshotDeltaApply(p2pAckedState, frame); return applied && applied.fx.length === 0 && applied.me.ev === null; }), 'applying a p2p delta gives an event-free state');
const p2pEventMessages = p2pAfterAck.filter(m => m.events !== null).map(m => JSON.parse(m.events));
ok(p2pEventMessages.filter(message => message.ev && message.ev.length === 1 && message.ev[0].m === 'hello').length === 1, 'a queued event reaches the events JSON exactly once while frames are deltas');
ok(p2pEventMessages.every(message => message.t === 'we' && typeof message.tick === 'number'), 'events JSON keeps the we shape');
ok(p2pAfterAck.every((m, index) => m.events === null || JSON.parse(m.events).tick === p2pDecodedAfterAck[index].tick), 'events carry the tick of their own frame');

const inlineEvents = startGuestRoom();
inlineEvents.round(5);
const inlineAckedTick = lastTick(inlineEvents.frames());
inlineEvents.ackOverSocket(inlineAckedTick);
const inlineFramesBeforeEvent = inlineEvents.frames().length;
inlineEvents.queueEvent();
inlineEvents.round(5);
const inlineAfterEvent = inlineEvents.frames().slice(inlineFramesBeforeEvent);
const inlineWithEvents = inlineAfterEvent.filter(frame => Array.isArray(frame.me.ev) && frame.me.ev.length > 0);
ok(inlineAfterEvent.length >= 3 && inlineAfterEvent.every(frame => frame.base === inlineAckedTick), 'ws frames after the ack are deltas');
ok(inlineWithEvents.length === 1 && inlineWithEvents[0].base === inlineAckedTick && inlineWithEvents[0].me.ev[0].m === 'hello', 'a ws delta carries the one-shot me.ev exactly once');

console.log('stop and errors');
harness.send({ type: 'stop' });
ok(socket.closed, 'stop closes the hostlink socket');
const sentAfterStop = socket.sent.length;
harness.advance(1000);
ok(socket.sent.length === sentAfterStop, 'nothing is sent after stop');

const failing = createWorkerHarness();
failing.run('sim-worker.js');
failing.scope.importScripts = () => { throw new Error('boom'); };
failing.send({ type: 'start', url: 'ws://fake/host', code: 'TEST', token: 't', hostId: 'p1' });
ok(failing.posted.some(m => m.type === 'error' && m.message === 'boom'), 'a sim load failure is posted as an error message');

function runOverInWorker(roomCode, hostStartExtra) {
  const policeHarness = createWorkerHarness();
  policeHarness.run('sim-worker.js');
  FakeSocket.instances.length = 0;
  policeHarness.send({ type: 'start', url: 'ws://fake/host', code: roomCode, token: 't', hostId: 'p1' });
  const policeSocket = FakeSocket.instances[0];
  policeSocket.onopen();
  deliver(policeSocket, { t: 'hoststart', roster: [{ id: 'p1', name: 'Host', shirtIdx: 0 }, { id: 'p2', name: 'Guest', shirtIdx: 1 }], state: [], ...hostStartExtra });
  const sim = policeHarness.scope.__sim;
  sim._player('p1').x += 3000;
  const result = runOverPedestrians(sim, 'p2');
  policeHarness.send({ type: 'stop' });
  return result;
}

console.log('police in the host worker');
const workerPoliceOn = runOverInWorker('WPOL1', {});
console.log('  ', JSON.stringify(workerPoliceOn));
ok(workerPoliceOn.inCar && workerPoliceOn.knocked > 0, 'the guest runs pedestrians over in the worker sim');
ok(workerPoliceOn.wantedAfterRunOver >= 2, 'the guest gets 2+ wanted stars in the worker sim');
ok(workerPoliceOn.maxSnapshotCops > 0 && workerPoliceOn.maxSnapshotPoliceCars > 0, 'cops and police cars chase the guest in the worker sim');
const workerPoliceOff = runOverInWorker('WPOL2', { police: false });
console.log('  ', JSON.stringify(workerPoliceOff));
ok(workerPoliceOff.inCar && workerPoliceOff.knocked > 0, 'the guest runs pedestrians over with the police off');
ok(workerPoliceOff.wantedAfterRunOver === 0, 'hoststart police:false keeps the guest unwanted');
ok(workerPoliceOff.maxSnapshotCops === 0 && workerPoliceOff.maxSnapshotPoliceCars === 0, 'hoststart police:false spawns no police');

console.log('bundle served by the service worker');
const cachedWorker = createWorkerHarness({ location: { hash: '', href: 'http://localhost/js/sim-worker.0123456789.js' }, name: 'PSSUHG' });
vm.runInContext(buildSimWorkerBundle(ROOT_DIR), cachedWorker.scope, { filename: 'sim-worker-bundle.js' });
ok(vm.runInContext('ROOM_CODE', cachedWorker.scope) === 'PSSUHG', 'the room code comes from the worker name when the url lost its #room fragment');
ok(cachedWorker.scope.__sim.worldInfo().sig === createRoomSim('PSSUHG').worldInfo().sig, 'the worker simulates the same city as the room');

console.log('built load');
const TEST_DIST_DIR = path.join(ROOT_DIR, '.tmp', 'test-sim-worker-dist');
const buildRun = spawnSync(process.execPath, ['build.js'], { cwd: ROOT_DIR, env: { ...process.env, LC_DIST_DIR: TEST_DIST_DIR }, encoding: 'utf8' });
ok(buildRun.status === 0, 'build.js succeeds' + (buildRun.status === 0 ? '' : ': ' + buildRun.stderr));
const builtFileName = fs.readdirSync(path.join(TEST_DIST_DIR, 'js')).find(name => /^sim-worker\.[0-9a-f]{10}\.js$/.test(name));
ok(!!builtFileName, 'dist contains a hashed sim-worker bundle');
const builtSource = fs.readFileSync(path.join(TEST_DIST_DIR, 'js', builtFileName), 'utf8');
ok(builtSource === buildSimWorkerBundle(ROOT_DIR), 'dist bundle is what buildSimWorkerBundle returns');
ok(!builtSource.includes('importScripts(') && !builtSource.includes('dev-only') && !builtSource.includes('loadSimScripts'), 'bundle has no dev loading path');
ok(builtSource.indexOf('function makeSimStubs') < builtSource.indexOf('var __sim ='), 'stubs come before the sim files');
const builtHtml = fs.readFileSync(path.join(TEST_DIST_DIR, 'index.html'), 'utf8');
ok(builtHtml.includes('<meta name="lc-sim-worker" content="js/' + builtFileName + '">'), 'index.html meta points at the bundle');
ok(fs.readFileSync(path.join(TEST_DIST_DIR, 'sw.js'), 'utf8').includes('js/' + builtFileName), 'sw.js precaches the bundle');

const built = createWorkerHarness();
vm.runInContext(builtSource, built.scope, { filename: builtFileName });
FakeSocket.instances.length = 0;
built.send({ type: 'start', url: 'ws://fake/host', code: 'TEST', token: 't', hostId: 'p1' });
ok(built.importedFiles.length === 0, 'built bundle never calls importScripts');
const builtSocket = FakeSocket.instances[0];
builtSocket.onopen();
deliver(builtSocket, { t: 'hoststart', roster: [{ id: 'p1', name: 'Host', shirtIdx: 0 }], state: [] });
built.advance(100);
ok(built.posted.some(m => m.type === 'snapshot'), 'built bundle runs the sim');
fs.rmSync(TEST_DIST_DIR, { recursive: true, force: true });

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
