// LIBRE CITY · server/test-scoring.mjs — test del punteggio, delle taglie e del
// lanciarazzi nella simulazione autoritativa (Fase 2).
//   Uso:  node server/test-scoring.mjs
import runtime from './sim-runtime.js';
const { createRoomSim } = runtime;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

// stende `vic` con la pistola di `att` (li tiene adiacenti e spara finché cade)
function pistolKill(sim, att, vic) {
  const pa = sim._player(att), pv = sim._player(vic);
  pa.owned[1] = true; pa.weaponIdx = 1;
  pv.health = 6; pv.downT = 0;                 // pronto a cadere
  for (let i = 0; i < 40; i++) {
    pv.x = pa.x + 22; pv.y = pa.y;             // resta a tiro
    sim.applyInput(att, { aim: 0, b: 2 });
    sim.tick();
    if (pv.downT > 0) return true;
  }
  return false;
}

console.log('1) il lanciarazzi stende un giocatore a piedi e accredita l\'uccisione');
{
  const sim = createRoomSim('ROCKET1');
  const X = sim.addPlayer('Rocketman', 0), Y = sim.addPlayer('Bersaglio', 1);
  const px = sim._player(X), py = sim._player(Y);
  px.owned[4] = true; px.weaponIdx = 4;         // 4 = Lanciarazzi (vedi WEAPONS)
  py.x = px.x + 40; py.y = px.y; py.health = 100;
  let killed = false;
  for (let i = 0; i < 30 && !killed; i++) {
    py.x = px.x + 40; py.y = px.y;              // tienilo davanti alla bocca da fuoco
    sim.applyInput(X, { aim: 0, b: 2 });        // fuoco (semi-auto)
    sim.tick();
    if (py.downT > 0) killed = true;
  }
  const sc = sim.scores();
  const sx = sc.find(s => s.id === X), sy = sc.find(s => s.id === Y);
  console.log('   scores:', JSON.stringify(sc));
  ok(killed, 'il razzo ha steso il bersaglio a piedi');
  ok(sx && sx.k >= 1, 'l\'uccisione col razzo è accreditata al tiratore');
  ok(sx && sx.s >= 100, 'il tiratore ha guadagnato punteggio');
  ok(sy && sy.d >= 1, 'al bersaglio è contata la morte');
}

console.log('2) serie di uccisioni → cresce la TAGLIA sulla testa del killer');
{
  const sim = createRoomSim('BOUNTY1');
  const X = sim.addPlayer('Killer', 0), Y = sim.addPlayer('Vittima', 1);
  const px = sim._player(X);
  for (let n = 1; n <= 3; n++) {
    const done = pistolKill(sim, X, Y);
    ok(done, `uccisione #${n} riuscita`);
  }
  console.log('   dopo 3 uccisioni:', JSON.stringify(sim.scores().find(s => s.id === X)));
  ok(px.streak === 3, 'serie = 3 uccisioni senza morire');
  ok(px.bounty === 150, 'taglia salita a $150 alla terza uccisione');
}

console.log('3) chi stende un giocatore con la taglia la INCASSA (punti + soldi)');
{
  const sim = createRoomSim('BOUNTY2');
  const X = sim.addPlayer('Preda', 0), Y = sim.addPlayer('Cacciatore', 1);
  const px = sim._player(X), py = sim._player(Y);
  // X si costruisce una taglia stendendo Y tre volte
  for (let n = 0; n < 3; n++) pistolKill(sim, X, Y);
  const xBounty = px.bounty;
  py.downT = 0;                                    // riporta in gioco il cacciatore
  const yScoreBefore = sim.scores().find(s => s.id === Y).s;
  const yCashBefore = py.cash;
  const cashed = pistolKill(sim, Y, X);            // ora Y stende X (con taglia)
  const sy = sim.scores().find(s => s.id === Y);
  console.log('   taglia incassata:', xBounty, '· scores:', JSON.stringify(sim.scores()));
  ok(xBounty === 150, 'la preda aveva una taglia di $150');
  ok(cashed, 'il cacciatore ha steso la preda');
  ok(sy.s >= yScoreBefore + 100 + xBounty, 'punteggio del cacciatore = base + taglia');
  ok(py.cash >= yCashBefore + xBounty, 'la taglia è finita nel portafoglio del cacciatore');
  ok(px.bounty === 0 && px.streak === 0, 'morendo, la preda azzera serie e taglia');
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
