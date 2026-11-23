import runtime from './sim-runtime.js';
const { createRoomSim } = runtime;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const T = 32;
const GRID_SIZES = { PABC12: [8, 8], MABC12: [8, 16], GABC12: [16, 16] };

for (const [code, [columns, rows]] of Object.entries(GRID_SIZES)) {
  console.log(code);
  const roomSim = createRoomSim(code), { nodes, edges } = roomSim._roadGraph();
  const gridCount = columns * rows, gateApproach = gridCount;
  const corners = new Set([0, columns - 1, gridCount - columns, gridCount - 1]);

  ok(nodes.length === gridCount + 1, `${code}: ${columns} x ${rows} junctions plus the gate approach (${nodes.length})`);
  ok(edges.every(e => nodes[e.a].x === nodes[e.b].x || nodes[e.a].y === nodes[e.b].y), `${code}: every street is straight and axis-aligned`);
  ok(nodes.every(n => n.live !== false || n.edges.length === 0), `${code}: junctions that are not live have no streets`);

  const badJunctions = nodes.filter((n, idx) => {
    if (n.live === false || idx === gateApproach) return false;
    return corners.has(idx) ? n.edges.length !== 2 : n.edges.length < 3 || n.edges.length > 4;
  });
  ok(badJunctions.length === 0, `${code}: every live junction is a T or an X, ring corners are bends (${badJunctions.length} wrong)`);

  const reached = new Set([0]), queue = [0];
  while (queue.length) {
    const n = queue.pop();
    for (const ei of nodes[n].edges) {
      const next = edges[ei].a === n ? edges[ei].b : edges[ei].a;
      if (!reached.has(next)) { reached.add(next); queue.push(next); }
    }
  }
  const liveCount = nodes.filter(n => n.live !== false).length;
  ok(reached.size === liveCount, `${code}: every live junction is connected to the network (${reached.size}/${liveCount})`);
  ok(roomSim._cityWidth() * T === roomSim.worldInfo().worldW, `${code}: the city spans the whole map width`);
}
console.log('peace city: skipped, the server runtime cannot create one (PEACE_CITY reads localStorage)');

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
