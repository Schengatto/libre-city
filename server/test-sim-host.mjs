import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { extractTopLevel } from './render-test-kit.mjs';

const JS_DIR = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

class FakeWorker {
  static instances = [];
  static failNext = false;
  constructor(url, options) {
    if (FakeWorker.failNext) { FakeWorker.failNext = false; throw new Error('blocked'); }
    this.url = url; this.options = options; this.posted = []; this.terminated = false; this.onmessage = null; this.onerror = null;
    FakeWorker.instances.push(this);
  }
  postMessage(message) { this.posted.push(message); }
  terminate() { this.terminated = true; }
}

function createHostHarness() {
  const sentToServer = [];
  const snapshots = [];
  const context = vm.createContext({
    URL, Worker: FakeWorker, ROOM_CODE: 'ABCD',
    net: { url: 'ws://localhost:8787', myId: 'p1', token: 'tok-1' },
    document: { querySelector: selector => selector === 'meta[name="lc-sim-worker"]' ? { content: 'js/sim-worker.js' } : null },
    netSend: message => sentToServer.push(message),
    netOnSnapshot: snapshot => snapshots.push(snapshot),
    rtcHostSendFrame: (id, snapshot, events) => rtcFrames.push({ id, snapshot, events }),
    rtcHostCloseAll: () => { rtcCloseAllCalls++; },
  });
  vm.runInContext(fs.readFileSync(path.join(JS_DIR, 'sim-host.js'), 'utf8'), context);
  return { context, sentToServer, snapshots };
}

const rtcFrames = [];
let rtcCloseAllCalls = 0;
const { context: host, sentToServer, snapshots } = createHostHarness();

ok(host.simHostActive() === false, 'inactive before start');
host.simHostStart();
const firstWorker = FakeWorker.instances[0];
ok(host.simHostActive() === true, 'active after start');
ok(firstWorker.url === 'js/sim-worker.js', 'worker url = meta content');
ok(firstWorker.options && firstWorker.options.name === 'ABCD', 'worker name = ROOM_CODE, which survives a service-worker-cached script');
const startMessage = firstWorker.posted[0];
ok(startMessage && startMessage.type === 'start' && startMessage.code === 'ABCD' && startMessage.hostId === 'p1' && startMessage.token === 'tok-1',
  'start message carries code, hostId and token');
ok(startMessage && startMessage.url === 'ws://localhost:8787/hostlink', 'hostlink url = game ws origin + /hostlink');

host.simHostSendInput({ t: 'i', seq: 1 });
ok(firstWorker.posted[1] && firstWorker.posted[1].type === 'input' && firstWorker.posted[1].input.seq === 1, 'input forwarded to the worker');

firstWorker.onmessage({ data: { type: 'snapshot', snapshot: { t: 'w', n: 1 } } });
ok(snapshots.length === 1 && snapshots[0].n === 1, 'worker snapshot goes to netOnSnapshot');

host.simHostStart();
const secondWorker = FakeWorker.instances[1];
ok(firstWorker.terminated && secondWorker && !secondWorker.terminated, 'restart terminates the old worker and creates a new one');
ok(firstWorker.onmessage === null && firstWorker.onerror === null, 'old worker handlers detached');

secondWorker.onmessage({ data: { type: 'error', message: 'hostlink closed' } });
ok(sentToServer.length === 1 && sentToServer[0].t === 'resign', 'worker error sends resign');
ok(secondWorker.terminated && host.simHostActive() === false, 'worker error stops the host');

host.simHostStart();
const thirdWorker = FakeWorker.instances[2];
thirdWorker.onerror({ message: 'script load failed' });
ok(sentToServer.length === 2 && sentToServer[1].t === 'resign', 'worker onerror sends resign');
ok(thirdWorker.terminated && host.simHostActive() === false, 'worker onerror stops the host');

FakeWorker.failNext = true;
host.simHostStart();
ok(sentToServer.length === 3 && sentToServer[2].t === 'resign' && host.simHostActive() === false, 'worker construction failure resigns');

host.simHostStart();
const fourthWorker = FakeWorker.instances[3];
host.simHostStop();
ok(fourthWorker.terminated && host.simHostActive() === false, 'stop terminates the worker');
host.simHostSendInput({ t: 'i', seq: 2 });
ok(fourthWorker.posted.length === 1, 'no input posted after stop');

host.simHostSetP2P('p2', true);
host.simHostForwardGuestInput('p2', { seq: 1 });
ok(fourthWorker.posted.length === 1, 'no p2p or guest input message posted without a worker');
host.simHostStart();
const fifthWorker = FakeWorker.instances[4];
host.simHostSetP2P('p2', true);
ok(JSON.stringify(fifthWorker.posted[1]) === '{"type":"p2p","id":"p2","open":true}', 'simHostSetP2P posts the p2p message');
host.simHostForwardGuestInput('p2', { seq: 3, ax: 1 });
ok(JSON.stringify(fifthWorker.posted[2]) === '{"type":"guestInput","id":"p2","input":{"seq":3,"ax":1}}', 'simHostForwardGuestInput posts the guest input');
fifthWorker.onmessage({ data: { type: 'guestFrame', id: 'p2', snapshot: '{"t":"w"}', events: '{"t":"we"}' } });
ok(rtcFrames.length === 1 && rtcFrames[0].id === 'p2' && rtcFrames[0].snapshot === '{"t":"w"}' && rtcFrames[0].events === '{"t":"we"}',
  'a guestFrame message reaches rtcHostSendFrame');
const closeCallsBeforeStop = rtcCloseAllCalls;
host.simHostStop();
ok(rtcCloseAllCalls === closeCallsBeforeStop + 1, 'simHostStop closes every rtc link');

const netSource = fs.readFileSync(path.join(JS_DIR, 'net.js'), 'utf8');
const prefixLine = netSource.match(/^const NET_SNAPSHOT_FRAME_PREFIX = .*$/m);
const guardSource = netSource.match(/^function netForgedSnapshotFrame\([\s\S]*?^}/m);
ok(!!prefixLine && !!guardSource, 'net.js defines the forged snapshot guard');
const guard = vm.runInNewContext(prefixLine[0] + '\n' + guardSource[0] + '\nnetForgedSnapshotFrame;');
const check = raw => guard(raw, JSON.parse(raw));
ok(check('{"t":"w","t":"end"}') === true, 'duplicate t key behind the w prefix is rejected');
ok(check('{"t":"w","\\u0074":"host","id":"p9"}') === true, 'escaped t key behind the w prefix is rejected');
ok(check('{"t":"w","cars":[]}') === false, 'genuine w snapshot accepted');
ok(check('{"t":"end"}') === false && check('{"t":"host","id":"p2"}') === false, 'other server messages untouched');
ok(/netForgedSnapshotFrame\(ev\.data, m\)\) return;/.test(netSource), 'socket dispatch drops forged frames before handling');

function createNetGuestHarness({ guestSendResult = false, hostActive = false } = {}) {
  const calls = { netSend: [], simHostSendInput: [], rtcGuestSendInput: [], rtcGuestConnect: [], rtcGuestClose: 0, rtcHostSignal: [], rtcGuestSignal: [] };
  const context = vm.createContext({
    net: { hostId: null, myId: 'p1', authoritative: true, lastSnapTick: 10, snap: 'previous', inSeq: 0, firePending: false, enterEdge: false, hornEdge: false, weaponReq: null, lastVR: 0, stats: {} },
    performance, player: { x: 0, y: 0, car: null }, vw: 800, vh: 600, mDownL: false,
    held: () => false, mouseWX: () => 0, mouseWY: () => 0, netLagCompMs: () => 0, netStatsOnInputSent: () => {},
    simHostActive: () => hostActive,
    simHostStart: () => {}, simHostStop: () => {},
    simHostSendInput: cmd => calls.simHostSendInput.push(cmd),
    netSend: cmd => calls.netSend.push(cmd),
    rtcGuestSendInput: cmd => { calls.rtcGuestSendInput.push(cmd); return guestSendResult; },
    rtcGuestConnect: hostId => calls.rtcGuestConnect.push(hostId),
    rtcGuestClose: () => { calls.rtcGuestClose++; },
    rtcHostOnSignal: (from, k, d) => calls.rtcHostSignal.push([from, k, d]),
    rtcGuestOnSignal: (from, k, d) => calls.rtcGuestSignal.push([from, k, d]),
    rtcFreshSnapshot: (lastTick, tick) => !Number.isFinite(tick) || tick > lastTick,
    toast: () => {}, t: key => key,
  });
  const names = ['netSendInput', 'netOnSnapshot', 'netSyncHostRole', 'onServerMessage'];
  const declarations = names.map(name => extractTopLevel(netSource, name)).join('\n');
  vm.runInContext(declarations + '\n;globalThis.api = { ' + names.join(', ') + ' };', context);
  return { api: context.api, net: context.net, calls, context };
}

const guestOverWs = createNetGuestHarness({ guestSendResult: false });
guestOverWs.api.netSendInput();
ok(guestOverWs.calls.rtcGuestSendInput.length === 1 && guestOverWs.calls.netSend.length === 1, 'input falls back to netSend when the data channel refuses it');
const guestOverP2P = createNetGuestHarness({ guestSendResult: true });
guestOverP2P.api.netSendInput();
ok(guestOverP2P.calls.rtcGuestSendInput.length === 1 && guestOverP2P.calls.netSend.length === 0, 'input accepted by the data channel is not sent on the websocket');
const hostInput = createNetGuestHarness({ hostActive: true });
hostInput.api.netSendInput();
ok(hostInput.calls.simHostSendInput.length === 1 && hostInput.calls.rtcGuestSendInput.length === 0 && hostInput.calls.netSend.length === 0, 'host input goes only to the local worker');

const staleEvents = [];
guestOverWs.context.netApplyWorldEvents = (fx, ev) => staleEvents.push({ fx, ev });
guestOverWs.api.netOnSnapshot({ tick: 9, t: 'w', fx: ['spark'], me: { ev: ['kill'] } });
ok(guestOverWs.net.snap === 'previous' && guestOverWs.net.lastSnapTick === 10, 'stale snapshot tick is dropped');
ok(staleEvents.length === 1 && staleEvents[0].fx[0] === 'spark' && staleEvents[0].ev[0] === 'kill', 'a stale snapshot still delivers its inline events');

const migration = createNetGuestHarness();
migration.api.onServerMessage({ t: 'host', id: 'p3', name: 'Zed' });
ok(migration.net.lastSnapTick === -1 && migration.calls.rtcGuestConnect.join() === 'p3', 'host change resets the snapshot tick and connects to the new host');
const electedSelf = createNetGuestHarness();
electedSelf.api.onServerMessage({ t: 'host', id: 'p1' });
ok(electedSelf.calls.rtcGuestConnect.length === 0 && electedSelf.calls.rtcGuestClose === 1 && electedSelf.net.stats.transport === 'host', 'electing myself closes the guest link and shows host');
const serverSimRoom = createNetGuestHarness();
serverSimRoom.api.onServerMessage({ t: 'host', id: null });
ok(serverSimRoom.calls.rtcGuestConnect.length === 0 && serverSimRoom.calls.rtcGuestClose === 1, 'server-sim rooms (no host) never open a guest link');

const signalAsGuest = createNetGuestHarness();
signalAsGuest.api.onServerMessage({ t: 'rtc', from: 'p3', k: 'answer', d: 'sdp' });
ok(signalAsGuest.calls.rtcGuestSignal.length === 1 && signalAsGuest.calls.rtcHostSignal.length === 0, 'rtc signaling goes to the guest side when not hosting');
const signalAsHost = createNetGuestHarness({ hostActive: true });
signalAsHost.api.onServerMessage({ t: 'rtc', from: 'p2', k: 'offer', d: 'sdp' });
ok(signalAsHost.calls.rtcHostSignal.length === 1 && signalAsHost.calls.rtcGuestSignal.length === 0, 'rtc signaling goes to the host side when hosting');

ok(/function netShutdown\(\) \{[\s\S]*?rtcGuestClose\(\);[\s\S]*?\n\}/.test(netSource), 'netShutdown closes the guest link');

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
