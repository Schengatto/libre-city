// LIBRE CITY · server/test-server-sim.mjs — test end-to-end del server autoritativo (Fase 2, Stage 2b).
// Avvia il vero server, due client WebSocket creano/entrano nella stanza, mandano
// INPUT ('i') e ricevono gli SNAPSHOT ('w') di UNA città condivisa.
//   Uso:  node server/test-server-sim.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import wsPkg from './node_modules/ws/index.js';
const { WebSocket } = wsPkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8788;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK ', m); } else { fail++; console.log('  XX FAIL:', m); } };

// avvia il server
const srv = spawn(process.execPath, [path.join(__dirname, 'index.js')],
  { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', STATIC_DIR: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
srv.stdout.on('data', d => process.env.DBG && process.stdout.write('[srv] ' + d));
srv.stderr.on('data', d => process.stdout.write('[srv:err] ' + d));

function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.snaps = []; ws.oks = [];
  ws.on('message', d => { const m = JSON.parse(d); if (m.t === 'ok') ws.oks.push(m); else if (m.t === 'w') ws.snaps.push(m); });
  return new Promise((res, rej) => { ws.on('open', () => res(ws)); ws.on('error', rej); });
}
const waitFor = async (pred, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(30); } return false; };

try {
  await sleep(800);   // lascia partire il server

  console.log('1) creazione stanza con simulazione autoritativa');
  const c1 = await connect();
  c1.send(JSON.stringify({ t: 'create', code: 'TEST01', name: 'Alice', max: 4, minutes: 0 }));
  await waitFor(() => c1.oks.length);
  const ok1 = c1.oks[0];
  ok(ok1 && ok1.sim === true, "l'host riceve ok con sim:true (server autoritativo)");
  const id1 = ok1.id;

  console.log('2) secondo client entra');
  const c2 = await connect();
  c2.send(JSON.stringify({ t: 'join', code: 'TEST01', name: 'Bob' }));
  await waitFor(() => c2.oks.length);
  const ok2 = c2.oks[0];
  ok(ok2 && ok2.sim === true, "l'ospite riceve ok con sim:true");
  const id2 = ok2.id;
  ok(id1 !== id2, 'i due giocatori hanno id distinti');

  console.log('3) arrivano gli snapshot del mondo');
  await waitFor(() => c1.snaps.length > 3 && c2.snaps.length > 3);
  ok(c1.snaps.length > 3 && c2.snaps.length > 3, 'entrambi ricevono snapshot periodici (t:w)');
  const s1 = c1.snaps.at(-1), s2 = c2.snaps.at(-1);
  ok(s1.me && Array.isArray(s1.cars) && Array.isArray(s1.peds), 'lo snapshot ha me + cars + peds');
  console.log('   s1: cars', s1.cars.length, 'peds', s1.peds.length, 'players', s1.players.length);

  console.log('4) mondo CONDIVISO: auto in comune per id');
  const ids1 = new Set(s1.cars.map(c => c.id));
  const common = s2.cars.filter(c => ids1.has(c.id)).length;
  console.log('   auto viste da entrambi:', common);
  ok(common > 0, 'i due client vedono le stesse auto (mondo unico)');

  console.log('5) input muove il giocatore; l\'altro lo vede come ghost');
  const x0 = c1.snaps.at(-1).me.x;
  for (let i = 0; i < 40; i++) { c1.send(JSON.stringify({ t: 'i', seq: i, ax: 1, ay: 0, aim: 0 })); await sleep(25); }
  const x1 = c1.snaps.at(-1).me.x;
  console.log('   Alice me.x', x0, '→', x1);
  ok(Math.abs(x1 - x0) > 15, "l'input muove Alice nel mondo autoritativo");
  const sawGhost = c2.snaps.some(s => s.players.some(p => p.id === id1));
  ok(sawGhost, 'Bob vede Alice come giocatore remoto nello snapshot');

  console.log('6) la classifica arriva negli snapshot');
  ok(Array.isArray(c1.snaps.at(-1).sc), 'lo snapshot porta la classifica (sc)');

  c1.close(); c2.close();
} catch (e) {
  fail++; console.log('  XX ERRORE:', e.message, '\n', e.stack);
} finally {
  srv.kill('SIGTERM');
}
await sleep(200);
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
