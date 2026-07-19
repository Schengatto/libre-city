// LIBRE CITY · server/test-sim.mjs — test dell'harness headless (Fase 2, Stage 2a).
// Verifica: UNA città autoritativa condivisa per stanza; più giocatori nello stesso
// mondo; movimento; snapshot per area d'interesse; combattimento PvP con kill credit.
//   Uso:  node server/test-sim.mjs
import runtime from './sim-runtime.js';
const { createRoomSim } = runtime;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

console.log('1) città deterministica dal codice stanza');
const a1 = createRoomSim('ABCDEF').worldInfo();
const b1 = createRoomSim('ZZ9WQ7').worldInfo();
ok(JSON.stringify(a1) === JSON.stringify(createRoomSim('ABCDEF').worldInfo()), 'stesso codice ⇒ stessa città');
ok(a1.sig !== b1.sig, 'codice diverso ⇒ città diversa');

console.log('2) due giocatori nello STESSO mondo, 1000 tick senza crash');
const sim = createRoomSim('ROOM01');
const A = sim.addPlayer('Alice', 0);
const B = sim.addPlayer('Bob', 1);
let snap10 = null, snap200 = null, threw = null;
try {
  for (let i = 0; i < 1000; i++) {
    sim.tick();
    if (i === 10) snap10 = sim.snapshotFor(A);
    if (i === 200) snap200 = sim.snapshotFor(A);
  }
} catch (e) { threw = e; }
ok(!threw, '1000 tick con 2 giocatori senza eccezioni' + (threw ? ' — ' + threw.message + '\n' + (threw.stack || '') : ''));
const cN = sim.counts();
console.log('   counts:', JSON.stringify(cN));
ok(cN.frame === 1000 && cN.players === 2, 'frame=1000, 2 giocatori attivi');
ok(cN.cars > 0 && cN.cars < 160 && cN.peds > 0 && cN.peds < 220, 'entità limitate (scalate coi giocatori)');

console.log('3) snapshot per area d\'interesse');
const sA = sim.snapshotFor(A), sB = sim.snapshotFor(B);
ok(sA && sA.me && Array.isArray(sA.cars), 'snapshot di A ha me + liste');
console.log('   A: cars', sA.cars.length, 'peds', sA.peds.length, 'players', sA.players.length,
            '· B: cars', sB.cars.length, 'peds', sB.peds.length);
// entità di A tutte entro l'AOI (~1200) dal player A
const far = sA.cars.find(c => Math.hypot(c.x - sA.me.x, c.y - sA.me.y) > 1300);
ok(!far, 'le auto nello snapshot di A sono entro l\'area d\'interesse');
// mondo CONDIVISO: se A e B sono vicini vedono almeno un\'auto in comune (stesso id)
const idsA = new Set(sA.cars.map(c => c.id));
const shared = sB.cars.filter(c => idsA.has(c.id)).length;
console.log('   auto viste da ENTRAMBI (stesso id):', shared);
ok(shared > 0, 'A e B vedono auto in comune ⇒ mondo condiviso (niente più veicoli fantasma)');

console.log('4) un giocatore si muove con l\'input');
const pA0 = sim.playerState(A);
for (let i = 0; i < 120; i++) { sim.applyInput(A, { ax: 1, ay: 0, aim: 0 }); sim.tick(); }
const pA1 = sim.playerState(A);
const disp = Math.abs(pA1.x - pA0.x) + Math.abs(pA1.y - pA0.y);
console.log('   A', JSON.stringify(pA0), '→', JSON.stringify(pA1), '· spostamento', disp);
ok(disp > 15, 'Alice si è spostata (' + disp.toFixed(0) + 'px)');
sim.applyInput(A, { ax: 0, ay: 0 });   // ferma

console.log('5) PvP: un colpo stende un rivale (kill credit)');
const sim2 = createRoomSim('DUEL42');
const X = sim2.addPlayer('X', 0), Y = sim2.addPlayer('Y', 1);
const px = sim2._player(X), py = sim2._player(Y);
px.owned[1] = true; px.weaponIdx = 1;               // X impugna la pistola
py.x = px.x + 24; py.y = px.y; py.health = 8;        // Y adiacente e già malridotto
const aim = 0;                                       // X mira verso destra (verso Y)
let killed = false;
for (let i = 0; i < 20 && !killed; i++) {
  sim2.applyInput(X, { aim, b: 2 });                 // fireEdge (semi-auto)
  py.x = px.x + 24; py.y = px.y;                     // tieni Y a tiro per il test
  sim2.tick();
  if (py.downT > 0) killed = true;
}
const sc = sim2.scores();
console.log('   scores:', JSON.stringify(sc));
ok(killed, 'Y è stato steso da un colpo di X');
ok((sc.find(s => s.id === X) || {}).k >= 1, 'la stesa è accreditata a X (kill)');
ok((sc.find(s => s.id === Y) || {}).d >= 1, 'a Y è contata la morte');

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
