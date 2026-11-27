import { spawn } from 'node:child_process';

const PORT = Number(process.env.TEST_PORT) || 8799;
const EMOTE_COOLDOWN_MS = 700;
const EMOTE_COUNT = 8;
const CONNECT_TIMEOUT_MS = 60_000;
const MESSAGE_TIMEOUT_MS = 5_000;
const SILENCE_WINDOW_MS = 300;

const srv = spawn('node', ['index.js'], {
  cwd: import.meta.dirname,
  env: { ...process.env, PORT: String(PORT), SIM_MODE: 'server', EMOTE_COOLDOWN_MS: String(EMOTE_COOLDOWN_MS) },
  stdio: ['ignore', 'ignore', 'pipe'],
});
srv.stderr.on('data', d => process.stdout.write('  [srv:err] ' + d));

const wait = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (cond, msg) => { console.log('  ' + (cond ? 'OK ' : 'FAIL ') + msg); if (!cond) failures++; };

async function withConnectRetry(connectOnce) {
  const deadline = performance.now() + CONNECT_TIMEOUT_MS;
  for (;;) {
    try { return await connectOnce(); }
    catch (err) { if (performance.now() > deadline) throw err; }
    await wait(100);
  }
}

async function waitFor(readValue, timeoutMs = MESSAGE_TIMEOUT_MS) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = readValue();
    if (value || performance.now() > deadline) return value;
    await wait(20);
  }
}

function openOnce() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.inbox = [];
    ws.addEventListener('message', e => ws.inbox.push(JSON.parse(e.data)));
    ws.addEventListener('open', () => res(ws));
    ws.addEventListener('error', rej);
  });
}
const open = () => withConnectRetry(openOnce);
const send = (ws, m) => ws.send(JSON.stringify(m));
const findT = (ws, t) => ws.inbox.find(m => m.t === t);
const emotesOf = ws => ws.inbox.filter(m => m.t === 'emo');
const answered = ws => waitFor(() => findT(ws, 'ok') || findT(ws, 'no'));

async function createRoom(code) {
  const ws = await open();
  send(ws, { t: 'create', name: 'Ann', max: 4, minutes: 5, code });
  await answered(ws);
  return ws;
}

async function joinRoom(code, name) {
  const ws = await open();
  send(ws, { t: 'join', code, name });
  await answered(ws);
  return ws;
}

async function expectSilence(receiver) {
  const before = emotesOf(receiver).length;
  await wait(SILENCE_WINDOW_MS);
  return emotesOf(receiver).length === before;
}

const clients = [];
try {
  console.log('\n1) valid emote is relayed to the others with the sender id, never echoed');
  const sender = await createRoom('EMO001');
  clients.push(sender);
  const receiver = await joinRoom('EMO001', 'Bob');
  clients.push(receiver);
  const senderId = findT(sender, 'ok')?.id;
  ok(senderId !== undefined, `sender id known (${senderId})`);
  send(sender, { t: 'emo', e: 3 });
  const relayed = await waitFor(() => emotesOf(receiver)[0]);
  ok(relayed?.e === 3, `receiver gets index 3 (${relayed?.e})`);
  ok(relayed?.id === senderId, `relay carries the sender id (${relayed?.id})`);
  ok(Object.keys(relayed || {}).sort().join() === 'e,id,t', `payload is index only (${Object.keys(relayed || {})})`);
  ok(await expectSilence(sender) && emotesOf(sender).length === 0, 'sender gets no echo');

  console.log('\n2) second emote inside the cooldown is dropped');
  send(sender, { t: 'emo', e: 4 });
  ok(await expectSilence(receiver) && emotesOf(receiver).length === 1, 'receiver still has only the first emote');

  console.log('\n3) cooldown is per player');
  send(receiver, { t: 'emo', e: 5 });
  const fromReceiver = await waitFor(() => emotesOf(sender)[0]);
  ok(fromReceiver?.e === 5, `the other player can emote during the first cooldown (${fromReceiver?.e})`);

  console.log('\n4) emote is accepted again once the cooldown elapsed');
  await wait(EMOTE_COOLDOWN_MS + 100);
  send(sender, { t: 'emo', e: 7 });
  const afterCooldown = await waitFor(() => emotesOf(receiver)[1]);
  ok(afterCooldown?.e === 7, `index 7 relayed after the cooldown (${afterCooldown?.e})`);

  console.log('\n5) invalid payloads are dropped and do not consume the cooldown');
  await wait(EMOTE_COOLDOWN_MS + 100);
  const receivedBefore = emotesOf(receiver).length;
  const invalidIndexes = [-1, EMOTE_COUNT, 1.5, '2', null, true, [1], {}, undefined, NaN];
  for (const e of invalidIndexes) send(sender, { t: 'emo', e });
  ok(await expectSilence(receiver) && emotesOf(receiver).length === receivedBefore, `${invalidIndexes.length} invalid indexes relay nothing`);
  send(sender, { t: 'emo', e: 0 });
  const validAfterInvalid = await waitFor(() => emotesOf(receiver)[receivedBefore]);
  ok(validAfterInvalid?.e === 0, `valid emote right after invalid ones still passes (${validAfterInvalid?.e})`);

  console.log('\n6) client cannot spoof the sender id');
  await wait(EMOTE_COOLDOWN_MS + 100);
  const spoofIndex = emotesOf(sender).length;
  send(receiver, { t: 'emo', e: 2, id: 'someone-else' });
  const spoofed = await waitFor(() => emotesOf(sender)[spoofIndex]);
  ok(spoofed?.id === findT(receiver, 'ok')?.id, `relay uses the real sender id (${spoofed?.id})`);
} catch (err) {
  console.log('  FAIL unexpected error: ' + (err?.stack || err));
  failures++;
} finally {
  for (const ws of clients) { try { ws.close(); } catch {} }
  srv.kill();
}

console.log(failures ? `\nFAILED: ${failures}` : '\nAll emote server tests passed');
process.exit(failures ? 1 : 0);
