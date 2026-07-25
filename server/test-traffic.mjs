// LIBRE CITY · server/test-traffic.mjs — traffico: collisioni e distanze di sicurezza.
//
// Gira la simulazione headless (la STESSA del client) e verifica che:
//  1) le sagome delle auto non si compenetrano (l'urto è sul bordo, non dentro
//     la grafica);
//  2) le auto guidate dall'IA tengono una distanza di sicurezza dal veicolo che
//     precede (non finiscono attaccate);
//  3) il traffico continua a scorrere (nessuno stallo permanente per via delle
//     precedenze o dello sblocca-stalli).

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRoomSim } = require('./sim-runtime.js');

let ok = 0, fail = 0;
const check = (cond, msg, extra) => {
  if (cond) { ok++; console.log('  OK  ' + msg); }
  else { fail++; console.log('  ✗   ' + msg + (extra ? ' → ' + extra : '')); }
};

// mezza-estensione della scatola orientata di un veicolo lungo l'asse u (unitario)
const proj = (c, ux, uy) => {
  const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
  return c.w / 2 * Math.abs(ux * ca + uy * sa) + c.h / 2 * Math.abs(uy * ca - ux * sa);
};
// compenetrazione fra le due sagome (0 = si sfiorano, <0 = staccate): SAT
function overlap(a, b) {
  const ca = Math.cos(a.angle), sa = Math.sin(a.angle);
  const cb = Math.cos(b.angle), sb = Math.sin(b.angle);
  const dx = b.x - a.x, dy = b.y - a.y;
  const axes = [[ca, sa], [-sa, ca], [cb, sb], [-sb, cb]];
  let pen = Infinity;
  for (const [ux, uy] of axes)
    pen = Math.min(pen, proj(a, ux, uy) + proj(b, ux, uy) - Math.abs(dx * ux + dy * uy));
  return pen;
}
// spazio libero fra il muso di c e la coda di chi lo precede NELLA SUA CORSIA
// (solo veicoli con la stessa direzione di marcia: è la coda del traffico, non
// chi taglia l'incrocio di traverso)
function queueGap(c, cars) {
  const ax = c.dir.x, ay = c.dir.y;
  let gap = Infinity;
  for (const o of cars) {
    if (o === c || o.role === 'parked') continue;
    if (ax * o.dir.x + ay * o.dir.y < 0.85) continue;      // non è incolonnato con me
    const dx = o.x - c.x, dy = o.y - c.y;
    const along = dx * ax + dy * ay;
    if (along <= 0) continue;
    if (Math.abs(-dx * ay + dy * ax) > proj(c, -ay, ax) + proj(o, -ay, ax)) continue;
    gap = Math.min(gap, along - proj(c, ax, ay) - proj(o, ax, ay));
  }
  return gap;
}

const sim = createRoomSim('TRAFFIC');
sim.addPlayer('Tester', 0, 'p1');

const TICKS = 1200;
let worstPen = -Infinity, worstPenPair = '';   // compenetrazione peggiore fra due sagome
let worstGap = Infinity, worstGapAt = 0;       // distanza di sicurezza peggiore in coda
const moved = new Map();                       // id → px percorsi (per lo stallo)
const seenAt = new Map();                      // id → ultimo tick visto
const lastPos = new Map();

for (let f = 0; f < TICKS; f++) {
  sim.tick();
  const cars = sim._cars();
  // 1) compenetrazioni
  for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
    const a = cars[i], b = cars[j];
    if (a.exploded || b.exploded) continue;
    if (a.isTank || b.isTank) continue;                       // i cingoli passano sopra
    const d2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    if (d2 > 64 * 64) continue;
    const pen = overlap(a, b);
    if (pen > worstPen) { worstPen = pen; worstPenPair = `${a.role}#${a.id} vs ${b.role}#${b.id}`; }
  }
  // 2) distanze di sicurezza fra auto AI in coda + 3) scorrimento
  for (const c of cars) {
    if (c.role !== 'traffic' || c.driver) continue;
    const g = queueGap(c, cars);
    if (g < worstGap && g !== Infinity) { worstGap = g; worstGapAt = f; }
    const p = lastPos.get(c.id);
    if (p) moved.set(c.id, (moved.get(c.id) || 0) + Math.hypot(c.x - p[0], c.y - p[1]));
    lastPos.set(c.id, [c.x, c.y]);
    seenAt.set(c.id, f);
  }
}

const cars = sim._cars();
const traffic = cars.filter(c => c.role === 'traffic' && !c.driver);

console.log(`1) ${TICKS} tick, ${cars.length} veicoli (${traffic.length} guidati dall'IA)`);

// le sagome possono sfiorarsi e, nell'istante dell'urto, sovrapporsi di poco (la
// risoluzione le separa nello stesso frame): tolleriamo qualche pixel, non mezza auto.
check(worstPen < 6, `nessuna compenetrazione oltre 6px (peggiore ${worstPen.toFixed(1)}px)`, worstPenPair);

// distanza di sicurezza: mai meno di SAFE_GAP (16) meno un margine di frenata
check(worstGap > 8, `distanza minima dal veicolo che precede > 8px (peggiore ${worstGap.toFixed(1)}px al tick ${worstGapAt})`);

// nessuno stallo permanente: le auto vive da un po' devono aver percorso strada
const stalled = [...moved.entries()].filter(([id, d]) => d < 60 && seenAt.get(id) === TICKS - 1);
check(stalled.length === 0, `nessuna auto in stallo permanente (${stalled.length} ferme su ${traffic.length})`,
      stalled.slice(0, 4).map(([id, d]) => `#${id}: ${d.toFixed(0)}px`).join(', '));

console.log(`\n${fail ? '❌' : '✅'}  ${ok} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
