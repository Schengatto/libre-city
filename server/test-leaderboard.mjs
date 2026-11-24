// LIBRE CITY · server/test-leaderboard.mjs — tests for the SHARED leaderboard
// (points per minute, persistence, wiring into the match lifecycle).
//   Usage:  node server/test-leaderboard.mjs   (included in `npm test`)
//
// Two levels:
//   1. the module on its own — ranking, qualification threshold, name aggregation;
//   2. the real server — a (very short) match ends and the players end up in
//      GET /leaderboard, on disk, and their totals add up across a restart.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };
const wait = ms => new Promise(r => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-lb-'));
const UNIT_FILE = path.join(TMP, 'unit.json');
const SRV_FILE = path.join(TMP, 'server.json');

// The thresholds are env-driven precisely so the tests need not run for minutes.
process.env.LEADERBOARD_FILE = UNIT_FILE;
process.env.LEADERBOARD_QUALIFY_MS = String(3 * 60_000);
process.env.LEADERBOARD_MIN_SESSION_MS = '1000';
const lb = (await import('./leaderboard.js')).default;

const MIN = 60_000;

console.log('1) la classifica ordina per PUNTI AL MINUTO, non per punteggio grezzo');
{
  lb._reset();
  lb.record({ name: 'Maratoneta', ms: 20 * MIN, score: 2000, kills: 20, deaths: 4 });  // 100 pt/min
  lb.record({ name: 'Sprinter',   ms: 5 * MIN,  score: 900,  kills: 9,  deaths: 1 });  // 180 pt/min
  const top = lb.top(10);
  console.log('   ', top.map(r => `${r.rank}. ${r.name} ${r.ppm}pt/min`).join(' · '));
  ok(top.length === 2, 'entrambi i giocatori sono in classifica');
  ok(top[0].name === 'Sprinter' && top[0].ppm === 180, 'primo chi ha il rapporto migliore, non il totale più alto');
  ok(top[1].name === 'Maratoneta' && top[1].ppm === 100, 'il punteggio grezzo più alto non basta a vincere');
  ok(top[0].kills === 9 && top[0].deaths === 1, 'uccisioni e morti viaggiano con la riga');
}

console.log('2) partite dello stesso giocatore si SOMMANO (stessa media, non due righe)');
{
  lb._reset();
  lb.record({ name: 'Fede', ms: 4 * MIN, score: 800 });          // 200 pt/min
  lb.record({ name: ' FEDE ', ms: 4 * MIN, score: 0 });          // stessa persona, partita a secco
  const top = lb.top(10);
  console.log('   ', JSON.stringify(top));
  ok(top.length === 1, 'nome normalizzato (spazi/maiuscole): una sola riga');
  ok(top[0].name === 'FEDE', 'il nome mostrato è l\'ultimo scritto, ripulito dagli spazi');
  ok(top[0].matches === 2 && top[0].ms === 8 * MIN, 'partite e tempo giocato si accumulano');
  ok(top[0].ppm === 100, 'la media scende: 800 punti in 8 minuti = 100 pt/min');
  ok(top[0].best && top[0].best.ppm === 200, 'resta traccia della MIGLIOR partita (200 pt/min)');
}

console.log('3) soglie: chi ha giocato troppo poco non falsa la classifica');
{
  lb._reset();
  ok(lb.record({ name: 'Lampo', ms: 900, score: 500 }) === null,
     'una permanenza sotto il minimo non viene registrata affatto');
  lb.record({ name: 'Novellino', ms: 2 * MIN, score: 600 });     // 300 pt/min ma solo 2 minuti
  lb.record({ name: 'Veterano', ms: 10 * MIN, score: 500 });     // 50 pt/min in 10 minuti
  const top = lb.top(10);
  console.log('   ', JSON.stringify(top.map(r => r.name)), '· tracciati:', lb.snapshot().tracked);
  ok(top.length === 1 && top[0].name === 'Veterano', 'sotto i 3 minuti totali non si entra in classifica');
  ok(lb.snapshot().tracked === 2, 'il non qualificato è comunque tracciato (il tempo continua a sommarsi)');
  lb.record({ name: 'Novellino', ms: 2 * MIN, score: 600 });     // ora ha 4 minuti totali
  const top2 = lb.top(10);
  ok(top2.length === 2 && top2[0].name === 'Novellino' && top2[0].ppm === 300,
     'superata la soglia entra in classifica e scavalca il veterano');
  ok(lb.rankOf('novellino')?.rank === 1, 'rankOf() trova la posizione per nome, senza badare a maiuscole');
  ok(lb.rankOf('Nessuno') === null, 'chi non è in classifica non ha posizione');
}

console.log('3b) implausible totals are clamped to the time played');
{
  const cappedScore = lb.MAX_PPM * 4;
  const cappedKills = lb.MAX_KILLS_PER_MINUTE * 4;
  lb.record({ name: 'Cheater', ms: 4 * MIN, score: 2 ** 40, kills: 1e9, deaths: Infinity });
  const cheater = lb.top(10).find(r => r.name === 'Cheater');
  ok(cheater && cheater.score === cappedScore && cheater.kills === cappedKills && cheater.deaths === 0,
     'score and kills are capped per minute played, non-finite deaths count as 0');
  ok(cheater && cheater.ppm === lb.MAX_PPM && cheater.best.ppm === lb.MAX_PPM && cheater.best.score === cappedScore,
     'ppm and the personal best use the clamped score');
  const sanitized = lb.plausibleTotals({ score: 12.9, kills: -3, deaths: '7' }, MIN);
  ok(sanitized.score === 12 && sanitized.kills === 0 && sanitized.deaths === 0,
     'totals are non-negative integers and non-numbers count as 0');
}

console.log('4) persistenza: il file è scritto e rileggibile');
{
  lb.flush();
  const raw = JSON.parse(fs.readFileSync(UNIT_FILE, 'utf8'));
  console.log('   file:', UNIT_FILE, '·', raw.entries.length, 'voci');
  ok(raw.v === 1 && Array.isArray(raw.entries), 'JSON versionato con l\'elenco delle voci');
  ok(raw.entries.some(e => e.name === 'Veterano'), 'i giocatori sono nel file');
  ok(!fs.existsSync(UNIT_FILE + '.tmp'), 'nessun file temporaneo lasciato in giro (rename atomico)');
}

// ---------------------------------------------------------------------------
// 5-6. The real server.
// ---------------------------------------------------------------------------
const PORT = Number(process.env.TEST_PORT) || 8793;
const WSURL = `ws://127.0.0.1:${PORT}`;
const HTTPURL = `http://127.0.0.1:${PORT}`;
const SRV_ENV = {
  ...process.env, PORT: String(PORT), LEADERBOARD_FILE: SRV_FILE, SIM_MODE: 'server',
  LEADERBOARD_QUALIFY_MS: '200', LEADERBOARD_MIN_SESSION_MS: '50',
};

function startServer() {
  const srv = spawn('node', ['index.js'], { cwd: import.meta.dirname, env: SRV_ENV,
                                            stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  srv.stderr.on('data', d => process.stdout.write('  [srv:err] ' + d));
  return srv;
}
async function stopServer(srv) {
  if (srv.exitCode !== null || srv.signalCode !== null) return;
  const exited = new Promise(resolve => srv.once('exit', resolve));
  srv.send('shutdown');
  await exited;
}
function open() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(WSURL);
    ws.inbox = [];
    ws.addEventListener('message', e => ws.inbox.push(JSON.parse(e.data)));
    ws.addEventListener('open', () => res(ws));
    ws.addEventListener('error', rej);
  });
}
const send = (ws, m) => ws.send(JSON.stringify(m));
// A whole match in a second and a half: `minutes` is a number, so a fraction gives us the
// final whistle — and with it the recording — without waiting a real minute.
async function playShortMatch(code) {
  const a = await open(), b = await open();
  send(a, { t: 'create', code, name: 'Alfa', pass: '', max: 4, minutes: 0.025 });
  await wait(500);                                  // room + authoritative city (~90ms)
  send(b, { t: 'join', code, name: 'Bravo' });
  await wait(1500);                                 // …until the final whistle
  const ended = b.inbox.some(m => m.t === 'end');
  a.close(); b.close();
  return ended;
}
const fetchBoard = async () => (await fetch(`${HTTPURL}/leaderboard?limit=10`)).json();
const SERVER_READY_TIMEOUT_MS = 15000;
async function waitForServerReady() {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  for (;;) {
    try { await fetchBoard(); return; } catch (error) { if (Date.now() > deadline) throw error; }
    await wait(100);
  }
}

let srv = startServer();
try {
  await waitForServerReady();

  console.log('5) fine partita → i giocatori finiscono nella classifica condivisa');
  {
    const board0 = await fetchBoard();
    ok(board0.ok && Array.isArray(board0.top) && board0.top.length === 0,
       'GET /leaderboard risponde anche a classifica vuota');
    ok(board0.metric === 'ppm' && board0.qualifyMs === 200, 'il payload dichiara metrica e soglia');

    const ended = await playShortMatch('LBTEST');
    ok(ended, 'la partita breve è arrivata al fischio finale');
    await wait(300);
    const board = await fetchBoard();
    console.log('   ', JSON.stringify(board.top));
    const alfa = board.top.find(r => r.name === 'Alfa'), bravo = board.top.find(r => r.name === 'Bravo');
    ok(!!alfa && !!bravo, 'entrambi i giocatori sono in classifica a fine partita');
    ok(alfa && alfa.matches === 1 && alfa.ms > 0, 'una partita giocata, con tempo maggiore di zero');
    ok(alfa && alfa.ms > bravo.ms, 'chi ha creato la stanza ha giocato più a lungo di chi è entrato dopo');
    ok(board.top.every(r => r.rank >= 1), 'ogni riga porta la propria posizione');
  }

  console.log('6) la classifica sopravvive al riavvio del server e continua a sommare');
  {
    await stopServer(srv);
    ok(fs.existsSync(SRV_FILE), 'allo spegnimento la classifica è scritta su disco');
    srv = startServer();
    await waitForServerReady();
    const board = await fetchBoard();
    ok(board.top.some(r => r.name === 'Alfa'), 'al riavvio i giocatori sono ancora lì');
    const before = board.top.find(r => r.name === 'Alfa');

    ok(await playShortMatch('LBTEST2'), 'seconda partita conclusa');
    await wait(300);
    const after = (await fetchBoard()).top.find(r => r.name === 'Alfa');
    console.log('   Alfa prima:', JSON.stringify(before), '· dopo:', JSON.stringify(after));
    ok(after.matches === before.matches + 1, 'la seconda partita si somma alla prima');
    ok(after.ms > before.ms, 'il tempo giocato totale è cresciuto');
  }
} catch (e) {
  console.error('errore nel test:', e); fail++;
} finally {
  await stopServer(srv);
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
