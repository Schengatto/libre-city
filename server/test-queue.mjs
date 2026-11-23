// server/test-queue.mjs — the simultaneous-room cap and the WAITING ROOM.
// Starts the server with a fake cap (MAX_ROOMS=2, MAX_QUEUE=3) and checks: the cap,
// queueing with position/estimate, automatic entry when a slot frees up, giving up,
// reclaiming a place with the qtoken, and a full queue. It also checks that JOINING an
// existing room never goes through the queue.
// Takes ~45s: it genuinely waits out the grace window and the end of a lightning match.
import { spawn } from 'node:child_process';

const PORT = Number(process.env.TEST_PORT) || 8794;
const PORT2 = PORT + 1;                    // a second server, cap 1, for the final-whistle test
const CONNECT_TIMEOUT_MS = 60_000;
const MESSAGE_TIMEOUT_MS = 5_000;
const GRACE_TIMEOUT_MS = 45_000;
const MATCH_END_TIMEOUT_MS = 15_000;

function startServer(port, extraEnv, label) {
  const child = spawn('node', ['index.js'], {
    cwd: import.meta.dirname,
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', d => process.stdout.write(`  [${label}:err] ` + d));
  return child;
}

let srv2 = null;
const srv = startServer(PORT, { MAX_ROOMS: '2', MAX_QUEUE: '3' }, 'srv');

const wait = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (cond, msg) => { console.log('  ' + (cond ? 'OK ' : '❌ ') + msg); if (!cond) failures++; };

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

function openOnce(port) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.inbox = [];
    ws.addEventListener('message', e => ws.inbox.push(JSON.parse(e.data)));
    ws.addEventListener('open', () => res(ws));
    ws.addEventListener('error', rej);
  });
}
const open = (port = PORT) => withConnectRetry(() => openOnce(port));
const send = (ws, m) => ws.send(JSON.stringify(m));
const findT = (ws, t) => ws.inbox.find(m => m.t === t);
const lastT = (ws, t) => [...ws.inbox].reverse().find(m => m.t === t);
const health = (port = PORT) => withConnectRetry(() => fetch(`http://127.0.0.1:${port}/health`).then(r => r.json()));
// A "normal" create: a 10-minute match, like the real ones from the host panel.
const create = (ws, code, minutes = 10) => send(ws, { t: 'create', code, name: 'H-' + code, max: 4, minutes });

try {
  await health();

  console.log('\n1) il tetto di stanze vive');
  const a = await open(); create(a, 'ROOMAA');
  const b = await open(); create(b, 'ROOMBB');
  ok(await waitFor(() => findT(a, 'ok') && findT(b, 'ok')), 'le prime 2 stanze si creano');
  let h = await health();
  ok(h.live === 2 && h.max === 2, `health dice 2/2 stanze vive (live=${h.live})`);

  console.log('\n2) a tetto pieno si finisce in fila, non si viene respinti');
  const c = await open(); create(c, 'ROOMCC');
  await waitFor(() => findT(c, 'queued') || findT(c, 'no'));
  const cq = findT(c, 'queued');
  ok(!findT(c, 'no'), 'nessun errore: la create non è stata respinta');
  ok(cq && cq.pos === 1, 'C è il 1° in fila (pos=' + (cq && cq.pos) + ')');
  ok(cq && cq.eta > 0, 'la stima di attesa è > 0 (eta=' + (cq && Math.round(cq.eta / 1000)) + 's)');
  ok(cq && cq.qtoken, 'C riceve un qtoken per riprendere il posto');
  ok(cq && cq.rooms === 2 && cq.max === 2, 'C sa quante partite sono in corso');

  const d = await open(); create(d, 'ROOMDD');
  ok((await waitFor(() => findT(d, 'queued')))?.pos === 2, 'D è il 2° in fila');
  h = await health();
  ok(h.queue === 2, `health dice 2 in fila (queue=${h.queue})`);

  console.log('\n3) entrare in una stanza esistente NON passa dalla fila');
  const guest = await open();
  send(guest, { t: 'join', code: 'ROOMAA', name: 'Ospite' });
  await waitFor(() => findT(guest, 'ok') || findT(guest, 'queued') || findT(guest, 'no'));
  ok(findT(guest, 'ok') && !findT(guest, 'queued'), 'l\'ospite entra subito in ROOMAA');
  guest.close();

  console.log('\n4) chi rinuncia esce dalla fila e gli altri avanzano');
  send(c, { t: 'unqueue' });
  ok(await waitFor(() => lastT(d, 'queued')?.pos === 1), 'D avanza al 1° posto');
  h = await health();
  ok(h.queue === 1, `resta 1 solo in fila (queue=${h.queue})`);

  console.log('\n5) il posto si libera → la stanza si apre da sola');
  a.close();                                   // ROOMAA empties: after the grace period it disappears
  console.log('   (attesa della finestra di grazia, ~31s)');
  const dok = await waitFor(() => findT(d, 'ok'), GRACE_TIMEOUT_MS);
  ok(!!dok, 'D riceve "ok": la sua stanza è stata creata senza rifare nulla');
  ok(dok && dok.id === 'p1', 'D è il creatore della sua stanza (id ' + (dok && dok.id) + ')');
  h = await health();
  ok(h.live === 2 && h.queue === 0, `di nuovo 2 stanze vive e fila vuota (live=${h.live}, queue=${h.queue})`);

  console.log('\n6) riaggancio in fila: col qtoken si riprende il PROPRIO posto');
  const e = await open(); create(e, 'ROOMEE');
  const eq = await waitFor(() => findT(e, 'queued'));
  ok(eq?.pos === 1, 'E è il 1° in fila');
  const f = await open(); create(f, 'ROOMFF');
  ok((await waitFor(() => findT(f, 'queued')))?.pos === 2, 'F è il 2° in fila');
  e.close();                                   // network drop for the first in line
  await wait(500);
  const e2 = await open();
  send(e2, { t: 'create', code: 'ROOMEE', name: 'E', max: 4, minutes: 10, qtoken: eq.qtoken });
  ok((await waitFor(() => findT(e2, 'queued')))?.pos === 1, 'E torna e riprende il 1° posto (non finisce in fondo)');
  ok(lastT(f, 'queued')?.pos === 2, 'F resta 2°');

  console.log('\n7) anche la fila ha un tetto');
  const g = await open(); create(g, 'ROOMGG');
  ok((await waitFor(() => findT(g, 'queued')))?.pos === 3, 'G è il 3° in fila (fila piena)');
  const i = await open(); create(i, 'ROOMII');
  await waitFor(() => findT(i, 'no') || findT(i, 'queued'));
  ok(findT(i, 'no')?.r === 'qfull', 'il 4° riceve no/qfull invece di una promessa d\'attesa');

  for (const ws of [b, c, d, e2, f, g, i]) { try { ws.close(); } catch {} }
  await wait(200);
  srv.kill('SIGTERM');
  await wait(300);

  // ---- The heart of the mechanism: the slot frees up at the FINAL WHISTLE ----
  // Sessions are time-limited, so we do not wait for the last player to close their tab: as
  // soon as the match ends (here: 3 seconds) the slot passes to whoever is in line, even if
  // the players are still connected to the summary.
  console.log('\n8) il posto si libera alla fine della partita, non quando la stanza si svuota');
  srv2 = startServer(PORT2, { MAX_ROOMS: '1' }, 'srv2');
  await health(PORT2);

  const x = await open(PORT2);
  send(x, { t: 'create', code: 'SHORT1', name: 'X', max: 4, minutes: 0.05 });   // a 3-second match
  ok(!!(await waitFor(() => findT(x, 'ok'))), 'la partita lampo parte');
  const y = await open(PORT2);
  send(y, { t: 'create', code: 'SHORT2', name: 'Y', max: 4, minutes: 10 });
  ok((await waitFor(() => findT(y, 'queued')))?.pos === 1, 'Y finisce in fila (tetto = 1)');

  ok(!!(await waitFor(() => findT(x, 'end'), MATCH_END_TIMEOUT_MS)), 'X riceve il fischio finale');
  ok(!!(await waitFor(() => findT(y, 'ok'))), 'Y ottiene la stanza subito dopo, con X ancora collegato al riepilogo');
  const h2 = await health(PORT2);
  ok(h2.live === 1 && h2.rooms === 2, `la stanza finita non occupa più un posto (live=${h2.live}, rooms=${h2.rooms})`);
  // And anyone arriving later cannot join a match that has already ended.
  const z = await open(PORT2);
  send(z, { t: 'join', code: 'SHORT1', name: 'Z' });
  await waitFor(() => findT(z, 'no') || findT(z, 'ok'));
  ok(findT(z, 'no')?.r === 'notfound', 'non si entra in una partita già finita');
  const resumedAfterEnd = await open(PORT2);
  send(resumedAfterEnd, { t: 'join', code: 'SHORT1', name: 'X', token: findT(x, 'ok').token });
  ok(!!(await waitFor(() => findT(resumedAfterEnd, 'end'))), 'a player resuming with its token after the final whistle still receives end');
  ok(!findT(resumedAfterEnd, 'ok'), 'the resumed player is not readmitted into the ended match');

  for (const ws of [x, y, z, resumedAfterEnd]) { try { ws.close(); } catch {} }
  await wait(200);
  console.log(failures ? `\n❌  ${failures} test FALLITI` : '\n✅  tutti i test della sala d\'attesa superati');
} catch (err) {
  console.error('errore nel test:', err); failures++;
} finally {
  srv.kill('SIGTERM');
  if (srv2) srv2.kill('SIGTERM');
  await wait(200);
  process.exit(failures ? 1 : 0);
}
