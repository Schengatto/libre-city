// LIBRE CITY · server/test-traffic.mjs — traffic: collisions and safe distances.
//
// Runs the headless simulation (the SAME one as the client) and checks that:
//  1) the car silhouettes do not interpenetrate (impact is on the edge, not inside the
//     artwork);
//  2) AI-driven cars keep a safe distance from the vehicle in front (they do not end up
//     stuck together);
//  3) traffic keeps flowing (no permanent stall from the right-of-way rules or the
//     stall-breaker).

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRoomSim } = require('./sim-runtime.js');

let ok = 0, fail = 0;
const check = (cond, msg, extra) => {
  if (cond) { ok++; console.log('  OK  ' + msg); }
  else { fail++; console.log('  ✗   ' + msg + (extra ? ' → ' + extra : '')); }
};

// Half-extent of a vehicle's oriented box along the unit axis u.
const proj = (c, ux, uy) => {
  const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
  return c.w / 2 * Math.abs(ux * ca + uy * sa) + c.h / 2 * Math.abs(uy * ca - ux * sa);
};
// Interpenetration between the two silhouettes (0 = just touching, <0 = apart): SAT.
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
const MIN_LATERAL_OVERLAP = 2;
// Free space between c's nose and the tail of whoever is ahead IN ITS OWN LANE (only
// vehicles travelling the same way: this is the traffic queue, not someone cutting across
// the junction).
function queueGap(c, cars) {
  const ax = c.dir.x, ay = c.dir.y;
  let gap = Infinity;
  for (const o of cars) {
    if (o === c || o.role === 'parked') continue;
    if (ax * o.dir.x + ay * o.dir.y < 0.85) continue;      // not queued up behind/ahead of me
    const dx = o.x - c.x, dy = o.y - c.y;
    const along = dx * ax + dy * ay;
    if (along <= 0) continue;
    const lateralOverlap = proj(c, -ay, ax) + proj(o, -ay, ax) - Math.abs(-dx * ay + dy * ax);
    if (lateralOverlap < MIN_LATERAL_OVERLAP) continue;
    if (o.speed >= c.speed) continue;
    gap = Math.min(gap, along - proj(c, ax, ay) - proj(o, ax, ay));
  }
  return gap;
}

const sim = createRoomSim('TRAFFIC');
sim.addPlayer('Tester', 0, 'p1');

const TICKS = 1200;
const WATCHED = 300;
let worstPen = -Infinity, worstPenPair = '';   // worst interpenetration between two silhouettes
let worstGap = Infinity, worstGapAt = 0;       // worst safe distance in a queue
const moved = new Map();                       // id → px travelled (for stall detection)
const seenAt = new Map();                      // id → last tick seen
const bornAt = new Map();
const lastPos = new Map();

for (let f = 0; f < TICKS; f++) {
  sim.tick();
  const cars = sim._cars();
  // 1) Interpenetrations.
  for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
    const a = cars[i], b = cars[j];
    if (a.exploded || b.exploded) continue;
    if (a.isTank || b.isTank) continue;                       // tracks drive straight over
    const d2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    if (d2 > 64 * 64) continue;
    const pen = overlap(a, b);
    if (pen > worstPen) { worstPen = pen; worstPenPair = `${a.role}#${a.id} vs ${b.role}#${b.id}`; }
  }
  // 2) Safe distances between queuing AI cars + 3) flow.
  for (const c of cars) {
    if (c.role !== 'traffic' || c.driver) continue;
    const g = queueGap(c, cars);
    if (g < worstGap && g !== Infinity) { worstGap = g; worstGapAt = f; }
    const p = lastPos.get(c.id);
    if (p) moved.set(c.id, (moved.get(c.id) || 0) + Math.hypot(c.x - p[0], c.y - p[1]));
    lastPos.set(c.id, [c.x, c.y]);
    if (!bornAt.has(c.id)) bornAt.set(c.id, f);
    seenAt.set(c.id, f);
  }
}

const cars = sim._cars();
const traffic = cars.filter(c => c.role === 'traffic' && !c.driver);

console.log(`1) ${TICKS} tick, ${cars.length} veicoli (${traffic.length} guidati dall'IA)`);

// The silhouettes may touch and, at the instant of impact, overlap slightly (resolution
// separates them within the same frame): we tolerate a few pixels, not half a car.
check(worstPen < 6, `nessuna compenetrazione oltre 6px (peggiore ${worstPen.toFixed(1)}px)`, worstPenPair);

// Safe distance: never less than SAFE_GAP (16) minus a braking margin.
check(worstGap > 8, `distanza minima dal veicolo che precede > 8px (peggiore ${worstGap.toFixed(1)}px al tick ${worstGapAt})`);

// No permanent stall: cars alive for a while must have covered some ground.
const stalled = [...moved.entries()].filter(([id, d]) =>
  d < 60 && seenAt.get(id) === TICKS - 1 && TICKS - 1 - bornAt.get(id) >= WATCHED);
check(stalled.length === 0, `nessuna auto in stallo permanente (${stalled.length} ferme su ${traffic.length})`,
      stalled.slice(0, 4).map(([id, d]) => `#${id}: ${d.toFixed(0)}px`).join(', '));

console.log(`\n${fail ? '❌' : '✅'}  ${ok} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
