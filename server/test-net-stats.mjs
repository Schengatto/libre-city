import { spawn } from 'node:child_process';
import vm from 'node:vm';
import { readSource, extractTopLevel } from './render-test-kit.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };
const near = (actual, expected, tolerance = 1e-6) => actual !== null && Math.abs(actual - expected) <= tolerance;

const NET_STATS_NAMES = [
  'INTERP_MS', 'NET_STATS_SMOOTHING', 'NET_STATS_WINDOW_MS', 'NET_STATS_PENDING_INPUTS',
  'createNetStats', 'netStatsSmooth', 'netStatsOnPong', 'netStatsOnInputSent', 'netStatsOnAck',
  'netStatsOnTick', 'netStatsSnapshotWindow', 'netStatsOnSnapshot', 'netStatsLines',
];

function loadNetStats() {
  const netSource = readSource('net.js');
  const declarations = NET_STATS_NAMES.map(name => extractTopLevel(netSource, name)).join('\n');
  const context = vm.createContext({});
  vm.runInContext(declarations + '\n;globalThis.api = { ' + NET_STATS_NAMES.join(', ') + ' };', context);
  return context.api;
}

const api = loadNetStats();

function testRttSmoothing() {
  const stats = api.createNetStats();
  api.netStatsOnPong(stats, 1000, 1100);
  ok(stats.rtt === 100 && stats.rttLast === 100, 'first RTT sample seeds the smoothed value');
  api.netStatsOnPong(stats, 2000, 2200);
  ok(stats.rttLast === 200, 'last RTT sample is kept raw');
  ok(near(stats.rtt, 100 + (200 - 100) * api.NET_STATS_SMOOTHING), 'smoothed RTT moves toward the new sample by the smoothing factor');
  api.netStatsOnPong(stats, undefined, 3000);
  api.netStatsOnPong(stats, 'x', 3000);
  api.netStatsOnPong(stats, 5000, 3000);
  ok(stats.rttLast === 200, 'pong without a finite past timestamp is ignored');
}

function testInputRoundTrip() {
  const stats = api.createNetStats();
  for (let seq = 1; seq <= 5; seq++) api.netStatsOnInputSent(stats, seq, seq * 33);
  api.netStatsOnAck(stats, 3, 200);
  ok(stats.inputRttLast === 200 - 99, 'ack samples the round trip of the highest acked pending input');
  ok(stats.pendingInputs.map(entry => entry.seq).join() === '4,5', 'acked inputs are dropped');
  api.netStatsOnAck(stats, 3, 400);
  api.netStatsOnAck(stats, 2, 400);
  ok(stats.inputRttLast === 101 && stats.pendingInputs.length === 2, 'duplicate or older acks add no sample');
  api.netStatsOnAck(stats, 5, 300);
  ok(stats.inputRttLast === 300 - 165 && stats.pendingInputs.length === 0, 'ack jumping ahead samples the latest acked input');
  ok(near(stats.inputRtt, 101 + (135 - 101) * api.NET_STATS_SMOOTHING), 'input round trip is smoothed');
  api.netStatsOnAck(stats, undefined, 500);
  ok(stats.inputRttLast === 135, 'snapshot without ack is ignored');

  const bounded = api.createNetStats();
  for (let seq = 1; seq <= api.NET_STATS_PENDING_INPUTS + 10; seq++) api.netStatsOnInputSent(bounded, seq, seq);
  ok(bounded.pendingInputs.length === api.NET_STATS_PENDING_INPUTS && bounded.pendingInputs[0].seq === 11, 'pending inputs ring is bounded');
}

function testSnapshotWindow() {
  const empty = api.netStatsSnapshotWindow([], 1000);
  ok(empty.rate === 0 && empty.meanInterval === null && empty.jitter === null && empty.intervalCount === 0, 'no snapshots: empty window');

  const steady = [];
  for (let k = 0; k <= 30; k++) steady.push(1000 + k * 33);
  const steadyWindow = api.netStatsSnapshotWindow(steady, steady[steady.length - 1]);
  ok(near(steadyWindow.rate, 1000 / 33), 'steady stream rate = 1000 / interval');
  ok(near(steadyWindow.meanInterval, 33) && near(steadyWindow.jitter, 0) && steadyWindow.maxGap === 33, 'steady stream: mean 33, no jitter, max gap 33');

  const jittery = [0, 20, 60, 80, 120];
  const jitteryWindow = api.netStatsSnapshotWindow(jittery, 120);
  ok(near(jitteryWindow.meanInterval, 30), 'jittery stream mean interval');
  ok(near(jitteryWindow.jitter, 10), 'jitter = mean absolute deviation of intervals');
  ok(jitteryWindow.maxGap === 40, 'max gap is the longest interval');

  const stalled = api.netStatsSnapshotWindow(jittery, 420);
  ok(stalled.maxGap === 300, 'max gap includes the current silence');
  ok(stalled.rate < jitteryWindow.rate, 'rate drops while snapshots stall');

  const old = [0, 33, 66, 6000, 6033];
  const slid = api.netStatsSnapshotWindow(old, 6033);
  ok(slid.intervalCount === 1 && slid.maxGap === 33, 'samples older than the window are ignored');

  const stats = api.createNetStats();
  for (let k = 0; k < 400; k++) api.netStatsOnSnapshot(stats, { tick: k * 2, ack: 0 }, k * 33);
  ok(stats.snapshotTimes[0] >= 399 * 33 - api.NET_STATS_WINDOW_MS, 'stored snapshot times are pruned to the window');
  ok(stats.snapshotWindow && near(stats.snapshotWindow.meanInterval, 33), 'snapshot window is refreshed on arrival');
}

function testHostRate() {
  const stats = api.createNetStats();
  api.netStatsOnTick(stats, 100, 1000);
  ok(stats.hostHz === null, 'first tick only sets the base');
  api.netStatsOnTick(stats, 160, 2000);
  ok(near(stats.hostHz, 60), 'host Hz = delta tick / delta wall seconds');
  api.netStatsOnTick(stats, 160, 2500);
  ok(near(stats.hostHz, 60) && stats.lastTickAt === 2000, 'repeated tick keeps the base');
  api.netStatsOnTick(stats, 10, 3000);
  ok(near(stats.hostHz, 60) && stats.lastTick === 10 && stats.lastTickAt === 3000, 'tick going backwards (host migration) rebases without a sample');
  api.netStatsOnTick(stats, 40, 4000);
  ok(near(stats.hostHz, 60 + (30 - 60) * api.NET_STATS_SMOOTHING), 'host Hz is smoothed after a rebase');
  api.netStatsOnTick(stats, 50, 4000);
  ok(stats.lastTick === 40, 'tick advance with no elapsed wall time waits for the next snapshot');
  api.netStatsOnTick(stats, undefined, 5000);
  ok(stats.lastTick === 40, 'snapshot without tick is ignored');
}

function testOverlayLines() {
  const stats = api.createNetStats();
  const lines = api.netStatsLines(stats, api.INTERP_MS, 0).split('\n');
  const labels = ['RTT', 'input RTT', 'snap/s', 'interval', 'jitter', 'max gap 5s', 'host Hz', 'interp delay'];
  ok(lines.length === labels.length && labels.every((label, k) => lines[k].startsWith(label + ' ')), 'overlay lists every stat label in order');
  ok(lines[7].includes(api.INTERP_MS.toFixed(1)), 'overlay shows the interpolation delay');
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function testServerPongEcho() {
  const PORT = Number(process.env.TEST_PORT) || 8798;
  const server = spawn('node', ['index.js'], {
    cwd: import.meta.dirname,
    env: { ...process.env, PORT: String(PORT), SIM_MODE: 'server' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', data => process.stdout.write('  [srv:err] ' + data));
  try {
    let ws = null;
    for (let attempt = 0; attempt < 50 && !ws; attempt++) {
      ws = await new Promise(resolve => {
        const socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
        socket.addEventListener('open', () => resolve(socket));
        socket.addEventListener('error', () => resolve(null));
      });
      if (!ws) await wait(100);
    }
    ok(!!ws, 'server accepts the socket');
    if (!ws) return;
    const inbox = [];
    ws.addEventListener('message', event => inbox.push(JSON.parse(event.data)));
    const send = message => ws.send(JSON.stringify(message));
    send({ t: 'ping', c: 1234.5 });
    send({ t: 'ping', c: 'evil' });
    send({ t: 'ping', c: { x: 1 } });
    send({ t: 'ping' });
    for (let k = 0; k < 40 && inbox.length < 4; k++) await wait(50);
    const pongs = inbox.filter(message => message.t === 'pong');
    ok(pongs.length === 4, 'every ping gets a pong');
    ok(pongs[0] && pongs[0].c === 1234.5, 'finite client timestamp is echoed');
    ok(pongs.slice(1).every(pong => !('c' in pong) && Object.keys(pong).length === 1), 'non-number timestamps are dropped');
    ws.close();
  } finally {
    server.kill('SIGTERM');
    await wait(150);
  }
}

testRttSmoothing();
testInputRoundTrip();
testSnapshotWindow();
testHostRate();
testOverlayLines();
await testServerPongEcho();

console.log(`\nnet stats: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
