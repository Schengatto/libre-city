import { spawn } from 'node:child_process';

const PORT = Number(process.env.TEST_PORT) || 8798;
const GRACE_MS = 1500;
const CONNECT_TIMEOUT_MS = 60_000;
const MESSAGE_TIMEOUT_MS = 5_000;
const MAX_TITLE_LENGTH = 24;

const srv = spawn('node', ['index.js'], {
  cwd: import.meta.dirname,
  env: { ...process.env, PORT: String(PORT), SIM_MODE: 'server', GRACE_MS: String(GRACE_MS) },
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
const answered = ws => waitFor(() => findT(ws, 'ok') || findT(ws, 'no'));
const fetchRooms = () => withConnectRetry(() => fetch(`http://127.0.0.1:${PORT}/rooms`));
const listedRooms = async () => (await (await fetchRooms()).json()).rooms;
const listedRoom = async code => (await listedRooms()).find(r => r.code === code);

async function createRoom(fields) {
  const ws = await open();
  send(ws, { t: 'create', name: 'Ann', max: 4, minutes: 5, ...fields });
  await answered(ws);
  return ws;
}

async function joinRoom(code, extra = {}) {
  const ws = await open();
  send(ws, { t: 'join', code, name: 'Bob', ...extra });
  await answered(ws);
  return ws;
}

const clients = [];
try {
  console.log('\n1) public room is listed with trimmed title and time left');
  const host = await createRoom({ code: 'PPUB01', public: true, title: '  Rapina al porto  ', pass: 'x' });
  clients.push(host);
  ok(!!findT(host, 'ok'), 'public room is created');
  const entry = await listedRoom('PPUB01');
  ok(entry?.title === 'Rapina al porto', `title trimmed (${entry?.title})`);
  ok(entry?.players === 1 && entry?.max === 4, `players 1 of max 4 (${entry?.players}/${entry?.max})`);
  ok(entry?.leftSec >= 290 && entry?.leftSec <= 300, `leftSec in 290..300 (${entry?.leftSec})`);

  console.log('\n2) public room ignores the password');
  const guest = await joinRoom('PPUB01');
  clients.push(guest);
  ok(!!findT(guest, 'ok'), 'joining without password succeeds');
  const guestWithWrongPass = await joinRoom('PPUB01', { pass: 'wrong' });
  clients.push(guestWithWrongPass);
  ok(!!findT(guestWithWrongPass, 'ok'), 'joining with any password succeeds');
  ok((await listedRoom('PPUB01'))?.players === 3, 'listing shows 3 players');

  console.log('\n3) private room is never listed');
  const privateHost = await createRoom({ code: 'PPRV01', pass: 'secret' });
  clients.push(privateHost);
  ok(!!findT(privateHost, 'ok'), 'private room is created');
  ok(!(await listedRoom('PPRV01')), 'private room absent from listing');
  const privateWithTitle = await createRoom({ code: 'PPRV02', title: 'Hidden', public: 'true' });
  clients.push(privateWithTitle);
  ok(!(await listedRoom('PPRV02')), 'non-boolean public flag keeps the room private');
  const wrongPass = await joinRoom('PPRV01', { pass: 'nope' });
  clients.push(wrongPass);
  ok(findT(wrongPass, 'no')?.r === 'pass', 'private room still checks the password');

  console.log('\n4) full rooms sort after rooms with a free slot');
  const fullHost = await createRoom({ code: 'GPUB02', public: true, title: 'Full house', max: 2 });
  clients.push(fullHost);
  clients.push(await joinRoom('GPUB02'));
  const fullEntry = await listedRoom('GPUB02');
  ok(fullEntry?.players === 2 && fullEntry?.max === 2, 'full room listed with 2/2');
  const codes = (await listedRooms()).map(r => r.code);
  ok(codes.join() === 'PPUB01,GPUB02', `order is free slot first (${codes.join()})`);

  console.log('\n5) title sanitizing');
  const dirtyTitle = '<b>x</b>\u0000\n' + 'Y'.repeat(28);
  clients.push(await createRoom({ code: 'PTIT01', public: true, title: dirtyTitle }));
  const dirtyEntry = await listedRoom('PTIT01');
  ok(dirtyEntry?.title === '<b>x</b>' + 'Y'.repeat(16), `control chars removed, cut to 24 (${dirtyEntry?.title})`);
  ok(dirtyEntry?.title.length === MAX_TITLE_LENGTH, `length is ${MAX_TITLE_LENGTH}`);
  clients.push(await createRoom({ code: 'PTIT04', public: true, title: 'Ev\u202eil\u0085Name' }));
  ok((await listedRoom('PTIT04'))?.title === 'EvilName', 'bidi override and C1 control removed');
  clients.push(await createRoom({ code: 'PTIT02', public: true, title: '' }));
  ok((await listedRoom('PTIT02'))?.title === 'Ann', 'empty title falls back to the player name');
  clients.push(await createRoom({ code: 'PTIT03', public: true, title: ' \n\t ', name: 'ABCDEFGHIJKLMNOPQRST' }));
  ok((await listedRoom('PTIT03'))?.title === 'ABCDEFGHIJKLMN', 'blank title falls back to the stored 14-char name');

  console.log('\n6) untimed public room');
  clients.push(await createRoom({ code: 'PUNT01', public: true, title: 'Forever', minutes: 0 }));
  const untimedEntry = await listedRoom('PUNT01');
  ok(untimedEntry && untimedEntry.leftSec === null, 'untimed room has leftSec null');
  const orderWithUntimed = (await listedRooms()).filter(r => r.max === 4 && r.players === 1).map(r => r.code);
  ok(orderWithUntimed[0] === 'PUNT01', `untimed sorts first among equal rooms (${orderWithUntimed.join()})`);

  console.log('\n7) response headers');
  const response = await fetchRooms();
  ok(response.headers.get('access-control-allow-origin') === '*', 'access-control-allow-origin is *');
  ok(response.headers.get('cache-control') === 'no-store', 'cache-control is no-store');
  ok(response.headers.get('content-type').startsWith('application/json'), 'content-type is JSON');

  console.log('\n8) emptied public room disappears after the grace window');
  const lonelyHost = await createRoom({ code: 'PGONE1', public: true, title: 'Leaving' });
  ok(!!(await listedRoom('PGONE1')), 'room listed while the host is connected');
  lonelyHost.close();
  const deadline = performance.now() + GRACE_MS + 5_000;
  let vanished = false;
  while (!vanished && performance.now() < deadline) {
    await wait(100);
    vanished = !(await listedRoom('PGONE1'));
  }
  ok(vanished, 'room no longer listed after everyone left');

  for (const ws of clients) { try { ws.close(); } catch {} }
  await wait(200);
  console.log(failures ? `\n${failures} test FAILED` : '\nall public room tests passed');
} catch (err) {
  console.error('test error:', err); failures++;
} finally {
  srv.kill('SIGTERM');
  await wait(200);
  process.exit(failures ? 1 : 0);
}
