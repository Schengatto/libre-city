// LIBRE CITY · server/test-sim.mjs — smoke test dell'harness headless (Fase 2, Stage 1).
// Verifica: la sim gira in Node senza browser, la città è deterministica dal codice
// stanza (map identica host↔server), i tick non lanciano, le entità restano limitate
// ed evolvono, e un giocatore con input si muove davvero.
//   Uso:  node server/test-sim.mjs
import runtime from './sim-runtime.js';
const { createRoomSim } = runtime;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

console.log('1) città deterministica dal codice stanza');
const a1 = createRoomSim('ABCDEF').worldInfo();
const a2 = createRoomSim('ABCDEF').worldInfo();
const b1 = createRoomSim('ZZ9WQ7').worldInfo();
console.log('   ABCDEF:', JSON.stringify(a1));
console.log('   ZZ9WQ7:', JSON.stringify(b1));
ok(JSON.stringify(a1) === JSON.stringify(a2), 'stesso codice ⇒ stessa città (firma identica)');
ok(a1.nodes > 10 && a1.edges > 10 && a1.landmarks > 0, 'la città ha grafo stradale e landmark');
ok(a1.sig !== b1.sig, 'codice diverso ⇒ città diversa (firma del contenuto seedato)');

console.log('2) 1000 tick con giocatore fermo: nessun crash, entità limitate');
const sim = createRoomSim('ABCDEF');
const c0 = sim.counts();
let snap10 = null, snap200 = null;
let threw = null;
try {
  for (let i = 0; i < 1000; i++) {
    sim.tick();
    if (i === 10) snap10 = sim.carSnapshot();
    if (i === 200) snap200 = sim.carSnapshot();
  }
} catch (e) { threw = e; }
ok(!threw, 'i 1000 tick non lanciano eccezioni' + (threw ? ' — ' + threw.message + '\n' + (threw.stack || '') : ''));
const cN = sim.counts();
console.log('   counts iniziali:', JSON.stringify(c0), '→ dopo 1000:', JSON.stringify(cN));
ok(cN.frame === 1000, 'frame avanzato di esattamente 1000');
ok(cN.cars > 0 && cN.cars < 80, 'numero di auto entro un tetto ragionevole (' + cN.cars + ')');
ok(cN.peds > 0 && cN.peds < 120, 'numero di pedoni entro un tetto ragionevole (' + cN.peds + ')');

console.log('3) il traffico evolve (le auto si spostano tra i tick)');
if (snap10 && snap200) {
  const by = new Map(snap200.map(c => [c.id, c]));
  let moved = 0;
  for (const c of snap10) { const d = by.get(c.id); if (d && (Math.abs(d.x - c.x) + Math.abs(d.y - c.y)) > 4) moved++; }
  console.log('   auto ancora presenti e spostate:', moved);
  ok(moved > 0, 'almeno un veicolo del traffico si è mosso tra il tick 10 e il 200');
} else ok(false, 'snapshot del traffico non catturati');

console.log('4) un giocatore con input si muove');
const sim2 = createRoomSim('MOVE42');
for (let i = 0; i < 5; i++) sim2.tick();          // assesta lo spawn
const p0 = sim2.playerPos();
for (let i = 0; i < 120; i++) sim2.tick({ ax: 1, ay: 0, aim: 0 });   // 2 s verso destra
const p1 = sim2.playerPos();
const disp = Math.abs(p1.x - p0.x) + Math.abs(p1.y - p0.y);
console.log('   player', JSON.stringify(p0), '→', JSON.stringify(p1), '· spostamento', disp);
ok(disp > 15, 'il player a piedi si è spostato con input di movimento (' + disp.toFixed(0) + 'px)');

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
