// server/test-queue.mjs — tetto di stanze simultanee e SALA D'ATTESA.
// Fa partire il server con un tetto finto (MAX_ROOMS=2, MAX_QUEUE=3) e verifica:
// il tetto, la messa in fila con posizione/stima, l'ingresso automatico quando un
// posto si libera, la rinuncia, la ripresa del posto col qtoken e la coda piena.
// Verifica anche che ENTRARE in una stanza esistente non passi mai dalla fila.
// Dura ~45s: aspetta davvero la finestra di grazia e la fine di una partita lampo.
import { spawn } from 'node:child_process';

const PORT = Number(process.env.TEST_PORT) || 8794;
const PORT2 = PORT + 1;                    // secondo server, con tetto 1, per il test del fischio finale
let srv2 = null;
const srv = spawn('node', ['index.js'], {
  cwd: import.meta.dirname,
  env: { ...process.env, PORT: String(PORT), MAX_ROOMS: '2', MAX_QUEUE: '3' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stderr.on('data', d => process.stdout.write('  [srv:err] ' + d));

const wait = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (cond, msg) => { console.log('  ' + (cond ? 'OK ' : '❌ ') + msg); if (!cond) failures++; };

function open(port = PORT) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.inbox = [];
    ws.addEventListener('message', e => ws.inbox.push(JSON.parse(e.data)));
    ws.addEventListener('open', () => res(ws));
    ws.addEventListener('error', rej);
  });
}
const send = (ws, m) => ws.send(JSON.stringify(m));
const findT = (ws, t) => ws.inbox.find(m => m.t === t);
const lastT = (ws, t) => [...ws.inbox].reverse().find(m => m.t === t);
const health = () => fetch(`http://127.0.0.1:${PORT}/health`).then(r => r.json());
// una create "normale": partita da 10 minuti, come quelle vere del pannello host
const create = (ws, code, minutes = 10) => send(ws, { t: 'create', code, name: 'H-' + code, max: 4, minutes });

try {
  await wait(1200);   // avvio + warmup della sim

  console.log('\n1) il tetto di stanze vive');
  const a = await open(); create(a, 'ROOMAA');
  await wait(400);
  const b = await open(); create(b, 'ROOMBB');
  await wait(400);
  ok(findT(a, 'ok') && findT(b, 'ok'), 'le prime 2 stanze si creano');
  let h = await health();
  ok(h.live === 2 && h.max === 2, `health dice 2/2 stanze vive (live=${h.live})`);

  console.log('\n2) a tetto pieno si finisce in fila, non si viene respinti');
  const c = await open(); create(c, 'ROOMCC');
  await wait(300);
  const cq = findT(c, 'queued');
  ok(!findT(c, 'no'), 'nessun errore: la create non è stata respinta');
  ok(cq && cq.pos === 1, 'C è il 1° in fila (pos=' + (cq && cq.pos) + ')');
  ok(cq && cq.eta > 0, 'la stima di attesa è > 0 (eta=' + (cq && Math.round(cq.eta / 1000)) + 's)');
  ok(cq && cq.qtoken, 'C riceve un qtoken per riprendere il posto');
  ok(cq && cq.rooms === 2 && cq.max === 2, 'C sa quante partite sono in corso');

  const d = await open(); create(d, 'ROOMDD');
  await wait(300);
  ok(findT(d, 'queued')?.pos === 2, 'D è il 2° in fila');
  h = await health();
  ok(h.queue === 2, `health dice 2 in fila (queue=${h.queue})`);

  console.log('\n3) entrare in una stanza esistente NON passa dalla fila');
  const guest = await open();
  send(guest, { t: 'join', code: 'ROOMAA', name: 'Ospite' });
  await wait(250);
  ok(findT(guest, 'ok') && !findT(guest, 'queued'), 'l\'ospite entra subito in ROOMAA');
  guest.close();

  console.log('\n4) chi rinuncia esce dalla fila e gli altri avanzano');
  send(c, { t: 'unqueue' });
  await wait(300);
  ok(lastT(d, 'queued')?.pos === 1, 'D avanza al 1° posto');
  h = await health();
  ok(h.queue === 1, `resta 1 solo in fila (queue=${h.queue})`);

  console.log('\n5) il posto si libera → la stanza si apre da sola');
  a.close();                                   // ROOMAA si svuota: dopo la grazia sparisce
  console.log('   (attesa della finestra di grazia, ~31s)');
  await wait(32_000);
  const dok = findT(d, 'ok');
  ok(!!dok, 'D riceve "ok": la sua stanza è stata creata senza rifare nulla');
  ok(dok && dok.id === 'p1', 'D è il creatore della sua stanza (id ' + (dok && dok.id) + ')');
  h = await health();
  ok(h.live === 2 && h.queue === 0, `di nuovo 2 stanze vive e fila vuota (live=${h.live}, queue=${h.queue})`);

  console.log('\n6) riaggancio in fila: col qtoken si riprende il PROPRIO posto');
  const e = await open(); create(e, 'ROOMEE');
  await wait(300);
  const eq = findT(e, 'queued');
  ok(eq?.pos === 1, 'E è il 1° in fila');
  const f = await open(); create(f, 'ROOMFF');
  await wait(300);
  ok(findT(f, 'queued')?.pos === 2, 'F è il 2° in fila');
  e.close();                                   // caduta di rete del primo della fila
  await wait(500);
  const e2 = await open();
  send(e2, { t: 'create', code: 'ROOMEE', name: 'E', max: 4, minutes: 10, qtoken: eq.qtoken });
  await wait(300);
  ok(findT(e2, 'queued')?.pos === 1, 'E torna e riprende il 1° posto (non finisce in fondo)');
  ok(lastT(f, 'queued')?.pos === 2, 'F resta 2°');

  console.log('\n7) anche la fila ha un tetto');
  const g = await open(); create(g, 'ROOMGG');
  await wait(250);
  ok(findT(g, 'queued')?.pos === 3, 'G è il 3° in fila (fila piena)');
  const i = await open(); create(i, 'ROOMII');
  await wait(250);
  ok(findT(i, 'no')?.r === 'qfull', 'il 4° riceve no/qfull invece di una promessa d\'attesa');

  for (const ws of [b, c, d, e2, f, g, i]) { try { ws.close(); } catch {} }
  await wait(200);
  srv.kill('SIGTERM');
  await wait(300);

  // ---- Il cuore del meccanismo: il posto si libera al FISCHIO FINALE ----
  // Le sessioni sono a tempo, quindi non si aspetta che l'ultimo giocatore chiuda
  // la scheda: appena la partita finisce (qui: 3 secondi) il posto passa a chi è in
  // fila, anche se i giocatori sono ancora collegati al riepilogo.
  console.log('\n8) il posto si libera alla fine della partita, non quando la stanza si svuota');
  srv2 = spawn('node', ['index.js'], {
    cwd: import.meta.dirname,
    env: { ...process.env, PORT: String(PORT2), MAX_ROOMS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv2.stderr.on('data', d => process.stdout.write('  [srv2:err] ' + d));
  await wait(1200);

  const x = await open(PORT2);
  send(x, { t: 'create', code: 'SHORT1', name: 'X', max: 4, minutes: 0.05 });   // partita di 3 secondi
  await wait(400);
  ok(!!findT(x, 'ok'), 'la partita lampo parte');
  const y = await open(PORT2);
  send(y, { t: 'create', code: 'SHORT2', name: 'Y', max: 4, minutes: 10 });
  await wait(300);
  ok(findT(y, 'queued')?.pos === 1, 'Y finisce in fila (tetto = 1)');

  await wait(3500);                                    // scade il tempo della partita di X
  ok(!!findT(x, 'end'), 'X riceve il fischio finale');
  ok(!!findT(y, 'ok'), 'Y ottiene la stanza subito dopo, con X ancora collegato al riepilogo');
  const h2 = await fetch(`http://127.0.0.1:${PORT2}/health`).then(r => r.json());
  ok(h2.live === 1 && h2.rooms === 2, `la stanza finita non occupa più un posto (live=${h2.live}, rooms=${h2.rooms})`);
  // e chi arriva dopo non entra in una partita già finita
  const z = await open(PORT2);
  send(z, { t: 'join', code: 'SHORT1', name: 'Z' });
  await wait(250);
  ok(findT(z, 'no')?.r === 'notfound', 'non si entra in una partita già finita');

  for (const ws of [x, y, z]) { try { ws.close(); } catch {} }
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
