import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const JS_DIR = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

class FakeWorker {
  static instances = [];
  static failNext = false;
  constructor(url) {
    if (FakeWorker.failNext) { FakeWorker.failNext = false; throw new Error('blocked'); }
    this.url = url; this.posted = []; this.terminated = false; this.onmessage = null; this.onerror = null;
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
  });
  vm.runInContext(fs.readFileSync(path.join(JS_DIR, 'sim-host.js'), 'utf8'), context);
  return { context, sentToServer, snapshots };
}

const { context: host, sentToServer, snapshots } = createHostHarness();

ok(host.simHostActive() === false, 'inactive before start');
host.simHostStart();
const firstWorker = FakeWorker.instances[0];
ok(host.simHostActive() === true, 'active after start');
ok(firstWorker.url === 'js/sim-worker.js#room=ABCD', 'worker url = meta content + #room=ROOM_CODE');
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

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
