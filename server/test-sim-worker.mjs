import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS_DIR = path.join(ROOT_DIR, 'js');
const { SIM_FILES } = require('./sim-runtime.js');
const { buildSimWorkerBundle } = require('../build-sim-worker.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 1; this.sent = []; this.closed = false; FakeSocket.instances.push(this); }
  send(data) { this.sent.push(data); }
  close() { this.closed = true; }
}

function createWorkerHarness() {
  let now = 0;
  let nextTimerId = 1;
  const timers = [];
  const posted = [];
  const importedFiles = [];
  const scope = {
    location: { hash: '#room=TEST' },
    navigator: { userAgent: 'fake-worker' },
    postMessage: message => posted.push(message),
    WebSocket: FakeSocket,
    performance: { now: () => now },
    console,
    setTimeout, clearTimeout,
    setInterval: (fn, ms) => { const id = nextTimerId++; timers.push({ id, fn, ms, next: now + ms }); return id; },
    clearInterval: id => { const index = timers.findIndex(timer => timer.id === id); if (index >= 0) timers.splice(index, 1); },
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
ok(harness.scope.location.hash === '#room=TEST' && harness.scope.navigator.userAgent === 'fake-worker', 'native location and navigator are not overridden');
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
const guestFrames = socket.sent.filter(frame => typeof frame === 'string' && frame.startsWith('W|p2|'));
ok(guestFrames.length > 0, 'guest snapshots go over the socket as W|p2|');
const guestSnapshot = JSON.parse(guestFrames[0].slice('W|p2|'.length));
ok(guestSnapshot.t === 'w' && guestSnapshot.me && Array.isArray(guestSnapshot.sc), 'guest frame carries a w snapshot with me and sc');
ok(!socket.sent.some(frame => typeof frame === 'string' && frame.startsWith('W|p1|')), 'the host never gets a W frame');
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
ok(socket.sent.some(frame => typeof frame === 'string' && frame.startsWith('W|p3|')), 'the joining player gets snapshots');
deliver(socket, { t: 'leave', id: 'p3' });
harness.advance(520);
ok(!lastHostState(socket).players.some(row => row.id === 'p3'), 'a leaving player disappears from hst');

console.log('catch-up cap');
const lastGuestTick = () => JSON.parse(socket.sent.filter(frame => typeof frame === 'string' && frame.startsWith('W|p2|')).pop().slice('W|p2|'.length)).tick;
const tickBeforeStall = lastGuestTick();
harness.scope.performance.now = () => 1e9;
harness.advance(20);
const ticksAfterStall = lastGuestTick() - tickBeforeStall;
ok(ticksAfterStall >= 14 && ticksAfterStall <= 20, 'a long stall catches up at most 250 ms of ticks (' + ticksAfterStall + ')');

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
