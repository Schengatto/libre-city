// server/test.mjs — smoke test del server (avvialo con:  node test.mjs).
// Fa partire il server su una porta di prova e verifica il protocollo:
// create / join / roster / relay dello stato / kill credit / riaggancio col token.
import { spawn } from 'node:child_process';

const PORT = Number(process.env.TEST_PORT) || 8791;
const URL = `ws://127.0.0.1:${PORT}`;
const srv = spawn('node', ['index.js'], {
  cwd: import.meta.dirname,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stderr.on('data', d => process.stdout.write('  [srv:err] ' + d));

const wait = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '✅' : '❌') + ' ' + msg); if (!cond) failures++; };

function open() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL);
    ws.inbox = [];
    ws.addEventListener('message', e => ws.inbox.push(JSON.parse(e.data)));
    ws.addEventListener('open', () => res(ws));
    ws.addEventListener('error', rej);
  });
}
const send = (ws, m) => ws.send(JSON.stringify(m));
const findT = (ws, t) => ws.inbox.find(m => m.t === t);

try {
  await wait(600);

  // create
  const a = await open();
  send(a, { t: 'create', code: 'TEST01', name: 'Alice', pass: '', max: 4, minutes: 2 });
  await wait(200);
  const aok = findT(a, 'ok');
  ok(aok && aok.id === 'p1', 'A: create → ok, id ' + (aok && aok.id));
  ok(aok && aok.shirtIdx === 0, 'A: maglia 0 (creatore)');
  ok(aok && aok.token, 'A: token per il riaggancio');
  ok(aok && aok.left > 6000 && aok.left <= 7200, 'A: left ~2min in frame = ' + (aok && aok.left));
  const aId = aok.id;

  // join
  const b = await open();
  send(b, { t: 'join', code: 'TEST01', name: 'Bob' });
  await wait(200);
  const bok = findT(b, 'ok');
  ok(bok && bok.id === 'p2', 'B: join → ok, id ' + (bok && bok.id));
  ok(bok && bok.players.some(p => p.id === aId), 'B: roster contiene A');
  const bId = bok.id, bToken = bok.token;
  ok(!!findT(a, 'join'), 'A: notificato dell\'ingresso di B');

  // relay dello stato
  a.inbox = []; b.inbox = [];
  send(a, { t: 's', x: 100, y: 200, a: 1.5 });
  await wait(150);
  const bs = findT(b, 's');
  ok(bs && bs.id === aId && bs.x === 100, 'B: riceve lo stato di A firmato con id di A');
  ok(!findT(a, 's'), 'A: NON riceve l\'eco del proprio stato');

  // kill credit
  a.inbox = [];
  send(b, { t: 'kill', to: aId });
  await wait(150);
  const ak = findT(a, 'kill');
  ok(ak && ak.id === bId, 'A: accreditato del kill sulla vittima B');

  // codice occupato / stanza inesistente
  const c = await open();
  send(c, { t: 'create', code: 'TEST01', name: 'Eve' });
  await wait(150);
  ok(findT(c, 'no')?.r === 'exists', 'C: create su codice occupato → no/exists');
  c.close();
  const d = await open();
  send(d, { t: 'join', code: 'NOPE99', name: 'Dan' });
  await wait(150);
  ok(findT(d, 'no')?.r === 'notfound', 'D: join a stanza inesistente → no/notfound');
  d.close();

  // riaggancio col token
  b.close();
  await wait(300);
  ok(!findT(a, 'leave'), 'A: nessun "leave" durante la grazia');
  const b2 = await open();
  send(b2, { t: 'join', code: 'TEST01', name: 'Bob', token: bToken });
  await wait(200);
  const b2ok = findT(b2, 'ok');
  ok(b2ok && b2ok.id === bId && b2ok.resumed, 'B: riaggancio col token → stesso id, resumed');

  a.close(); b2.close();
  await wait(150);
  console.log(failures ? `\n${failures} test FALLITI` : '\nTutti i test superati 🎉');
} catch (e) {
  console.error('errore nel test:', e); failures++;
} finally {
  srv.kill('SIGTERM');
  await wait(150);
  process.exit(failures ? 1 : 0);
}
