import vm from 'node:vm';
import { createRequire } from 'node:module';
import runtime from './sim-runtime.js';
const { createRoomSim, BUNDLE, JS_DIR } = runtime;
const { makeSimStubs } = createRequire(import.meta.url)(JS_DIR + '/sim-stubs.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const bundleContext = code => {
  const context = makeSimStubs(code, 900, { setTimeout, clearTimeout, setInterval, clearInterval });
  vm.createContext(context);
  vm.runInContext(BUNDLE, context, { timeout: 5000 });
  return context;
};
const graphShape = graph => JSON.stringify({ worldW: graph.worldW, worldH: graph.worldH, nodes: graph.nodes, edges: graph.edges });
const nodeIndexAt = (view, point) => view.nodes.findIndex(node => node.live !== false && node.x === point.x && node.y === point.y);

console.log('1) catalogue');
const firstContext = bundleContext('RACEFN');
const { raceTrack, raceShortestPaths } = firstContext;
const catalogueCities = vm.runInContext('RACE_CITIES', firstContext);
const racesPerCity = vm.runInContext('RACES_PER_CITY', firstContext);
ok(JSON.stringify(catalogueCities) === JSON.stringify(['PRACE1', 'MRACE1', 'GRACE1']) && racesPerCity === 4, 'RACE_CITIES = PRACE1, MRACE1, GRACE1 with 4 races each');

for (const code of catalogueCities) {
  console.log(`2) city ${code}`);
  const view = createRoomSim(code).cityView();
  ok(['worldW', 'worldH', 'nodes', 'edges', 'tileAt', 'inArmyIsland'].every(key => key in view), `${code}: cityView exposes worldW, worldH, nodes, edges, tileAt, inArmyIsland`);
  ok(typeof view.tileAt === 'function' && typeof view.inArmyIsland === 'function', `${code}: tileAt and inArmyIsland are functions`);
  ok(view.nodes.some(node => node.live === false), `${code}: the army island exists (violence on)`);
  const clientContext = bundleContext(code);
  ok(graphShape(clientContext.raceGraphFromCity()) === graphShape(view), `${code}: raceGraphFromCity matches cityView`);
  const freshView = createRoomSim(code).cityView();

  for (let index = 0; index < racesPerCity; index++) {
    const label = `${code}#${index}`;
    const track = raceTrack(view, code, index);
    ok(track !== null, `${label}: track generated`);
    if (!track) continue;
    console.log(`   ${label}: ${track.checkpoints.length} checkpoints, length ${Math.round(track.length)} px`);
    ok(track.code === code && track.index === index, `${label}: code and index echoed`);
    ok(track.checkpoints.length >= 8 && track.checkpoints.length <= 12, `${label}: 8-12 checkpoints`);
    ok(track.length >= 12000 && track.length <= 30000, `${label}: length within 12000-30000`);
    const points = [track.start, ...track.checkpoints];
    ok(points.every(point => point.x >= 0 && point.x <= view.worldW && point.y >= 0 && point.y <= view.worldH), `${label}: all points inside the world`);
    ok(points.every(point => !view.inArmyIsland(point.x, point.y)), `${label}: no point inside the army island`);
    ok(track.checkpoints.every((point, i) => track.checkpoints.slice(0, i).every(earlier => Math.hypot(earlier.x - point.x, earlier.y - point.y) >= 600)), `${label}: checkpoints at least 600 px apart`);
    const nodeIndices = points.map(point => nodeIndexAt(view, point));
    ok(nodeIndices.every(nodeIndex => nodeIndex >= 0), `${label}: every point is a live node`);
    let legSum = 0, legsInRange = true;
    for (let leg = 1; leg < nodeIndices.length; leg++) {
      const legLength = raceShortestPaths(view, nodeIndices[leg - 1]).distance[nodeIndices[leg]];
      if (legLength < 900 || legLength > 3500) legsInRange = false;
      legSum += legLength;
    }
    ok(legsInRange, `${label}: every leg is 900-3500 px by road`);
    ok(Math.abs(legSum - track.length) < 1e-6, `${label}: length is the sum of the legs`);
    ok(Number.isFinite(track.start.angle) && Math.abs(track.start.angle) <= Math.PI, `${label}: start angle is a finite heading`);
    ok(track.parMs.gold < track.parMs.silver && track.parMs.silver < track.parMs.bronze, `${label}: gold < silver < bronze`);
    ok(track.parMs.gold === Math.round(track.length / 5 * 1000 / 60), `${label}: gold par from length / 5 at 60 fps`);
    ok(JSON.stringify(raceTrack(view, code, index)) === JSON.stringify(track), `${label}: same build twice`);
    ok(JSON.stringify(raceTrack(freshView, code, index)) === JSON.stringify(track), `${label}: same build from a fresh city`);
  }
}

console.log('3) tiny graph');
const tinyNodes = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }].map(point => ({ ...point, edges: [], live: true }));
const tinyEdges = [[0, 1], [1, 2], [2, 3], [3, 0]].map(([a, b], edgeIndex) => {
  tinyNodes[a].edges.push(edgeIndex); tinyNodes[b].edges.push(edgeIndex);
  return { a, b, len: Math.hypot(tinyNodes[b].x - tinyNodes[a].x, tinyNodes[b].y - tinyNodes[a].y) };
});
ok(raceTrack({ nodes: tinyNodes, edges: tinyEdges, worldW: 200, worldH: 200, inArmyIsland: () => false }, 'TINY', 0) === null, 'a tiny graph yields no track');

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
