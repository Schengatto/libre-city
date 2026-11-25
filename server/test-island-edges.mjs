import vm from 'node:vm';
import runtime from './sim-runtime.js';
import stubs from '../js/sim-stubs.js';
const { BUNDLE } = runtime;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const SEEDS_PER_SIZE = 30;
const CODES = ['P', 'M', 'G'].flatMap(size => Array.from({ length: SEEDS_PER_SIZE }, (_, k) => `${size}EDG${k}`));
const PEACE_CODES = ['P', 'M', 'G'].flatMap(size => Array.from({ length: 4 }, (_, k) => `${size}PCE${k}`));

const STREET_JITTER = '* pitch * 0.30;';
const WIDE_STREET_JITTER = source => source.replace(STREET_JITTER, '* pitch * 0.70;');
const FORCED_CODES = ['P', 'M', 'G'].flatMap(size => Array.from({ length: 10 }, (_, k) => `${size}JIT${k}`));

function loadCity(code, { peace = false, patch = source => source } = {}) {
  const sandbox = stubs.makeSimStubs(code, 900, { setTimeout, clearTimeout, setInterval, clearInterval });
  if (peace) sandbox.localStorage = { ...sandbox.localStorage, getItem: key => key === 'libreCity.spIntent' ? JSON.stringify({ code, violence: false }) : null };
  const context = vm.createContext(sandbox);
  vm.runInContext(patch(BUNDLE), context, { timeout: 10000 });
  return expr => vm.runInContext(expr, context);
}

const CHECK_ISLAND = `(() => {
  const failures = [];
  const army = landmarks.find(l => l.type === 'army');
  const { x0, y0, x1, y1, island, superblock, bridge, gateApproach } = armyZone;
  const gateTileX = Math.floor(army.gate.x / T), gateTileY = Math.floor(army.gate.y / T);
  const horizontalFence = gateTileY === y0 || gateTileY === y1;
  const outward = horizontalFence ? { x: 0, y: gateTileY === y0 ? -1 : 1 } : { x: gateTileX === x0 ? -1 : 1, y: 0 };
  const opening = [];
  if (horizontalFence) { for (let x = x0; x <= x1; x++) if (tileAt(x, gateTileY) !== BUILDING) opening.push([x, gateTileY]); }
  else for (let y = y0; y <= y1; y++) if (tileAt(gateTileX, y) !== BUILDING) opening.push([gateTileX, y]);
  const openingKeys = new Set(opening.map(([x, y]) => gi(x, y)));
  const contiguous = opening.every(([x, y], k) => k === 0 || x - opening[k - 1][0] + y - opening[k - 1][1] === 1);
  if (!contiguous) failures.push('gate opening is not one run of tiles');
  if (opening.length * T < 2 * HALF_ROAD) failures.push('gate opening ' + opening.length * T + 'px < ' + 2 * HALF_ROAD + 'px');
  if (!openingKeys.has(gi(gateTileX, gateTileY))) failures.push('lm.gate is not on the opening');
  if (Math.floor(army.door.x / T) !== gateTileX || Math.floor(army.door.y / T) !== gateTileY) failures.push('lm.door is not on the gate centre tile');
  const opensWide = opening.length > 0 && Math.abs((opening[0][0] + opening[opening.length - 1][0] + 1) / 2 * T - army.gate.x) < 1
    && Math.abs((opening[0][1] + opening[opening.length - 1][1] + 1) / 2 * T - army.gate.y) < 1;
  if (!opensWide) failures.push('lm.gate is not the centre of the opening');
  const approachIndex = nodes.indexOf(gateApproach), gateAxis = horizontalFence ? army.gate.x : army.gate.y;
  const gateEdges = edges.filter(e => e.a === approachIndex || e.b === approachIndex);
  const edgeAxes = gateEdges.flatMap(e => [nodes[e.a], nodes[e.b]]).map(n => horizontalFence ? n.x : n.y);
  if (gateEdges.length !== 1 || edgeAxes.some(axis => axis !== gateAxis)) failures.push('road edge to the gate runs at ' + edgeAxes.join('/') + ', gate axis ' + gateAxis);
  const jogIndex = nodes.findIndex((n, index) => index >= NX * NY && index !== approachIndex);
  const jog = jogIndex < 0 ? null : edges[nodes[jogIndex].edges.find(index => edges[index].a !== approachIndex && edges[index].b !== approachIndex)];
  if (jogIndex >= 0 && (nodes[jogIndex].edges.length !== 2 || !jog || (nodes[jog.a].x !== nodes[jog.b].x && nodes[jog.a].y !== nodes[jog.b].y))) failures.push('the jog onto the gate axis is not one axis-aligned street');
  if ((horizontalFence ? bridge.x : bridge.y) !== gateAxis) failures.push('bridge axis ' + (horizontalFence ? bridge.x : bridge.y) + ' is not the gate axis ' + gateAxis);
  for (const [x, y] of opening) for (let ring = 1; ring <= ISLAND_BANKS; ring++) {
    const tile = tileAt(x + outward.x * ring, y + outward.y * ring);
    if (tile !== ROAD && tile !== SIDEWALK) { failures.push('gate tile ' + x + ',' + y + ' is not fully on the deck (ring ' + ring + ')'); break; }
  }
  const openingLane = opening.map(([x, y]) => horizontalFence ? x : y).join();
  for (let ring = 1; ring < ISLAND_BANKS; ring++) {
    const roadLane = [];
    if (horizontalFence) { for (let x = x0; x <= x1; x++) if (tileAt(x, gateTileY + outward.y * ring) === ROAD) roadLane.push(x); }
    else for (let y = y0; y <= y1; y++) if (tileAt(gateTileX + outward.x * ring, y) === ROAD) roadLane.push(y);
    if (roadLane.join() !== openingLane) failures.push('deck road band at ring ' + ring + ' (' + roadLane.join() + ') is not the gate opening (' + openingLane + ')');
  }
  let deckTiles = 0;
  for (let ring = 2; ring < ISLAND_BANKS; ring++) {
    if (horizontalFence) {
      const y = gateTileY + outward.y * ring;
      for (let x = island.x0 + 1; x < island.x1; x++) if (tileAt(x, y) !== WATER) { deckTiles++; if (x < x0 || x > x1) failures.push('deck overhangs the fence corner at ' + x + ',' + y); }
    } else {
      const x = gateTileX + outward.x * ring;
      for (let y = island.y0 + 1; y < island.y1; y++) if (tileAt(x, y) !== WATER) { deckTiles++; if (y < y0 || y > y1) failures.push('deck overhangs the fence corner at ' + x + ',' + y); }
    }
  }
  if (!deckTiles) failures.push('no deck across the moat');
  const start = gi(gateTileX + outward.x, gateTileY + outward.y), seen = new Uint8Array(MAP_W * MAP_H), stack = [start];
  let reachesStreet = false;
  if (grid[start] !== ROAD) failures.push('the deck in front of the gate is not road');
  seen[start] = 1;
  while (stack.length && !reachesStreet) {
    const index = stack.pop(), x = index % MAP_W, y = (index - x) / MAP_W;
    if (x < superblock.x0 || x > superblock.x1 || y < superblock.y0 || y > superblock.y1) reachesStreet = true;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
      const next = gi(nx, ny);
      if (!seen[next] && grid[next] === ROAD) { seen[next] = 1; stack.push(next); }
    }
  }
  if (!reachesStreet) failures.push('the deck road does not reach the street around the superblock');
  const leftovers = {};
  const besideRoad = (x, y) => [-1, 0, 1].some(dy => [-1, 0, 1].some(dx => tileAt(x + dx, y + dy) === ROAD));
  for (let y = superblock.y0; y <= superblock.y1; y++) for (let x = superblock.x0; x <= superblock.x1; x++) {
    const bankDistance = Math.max(island.x0 - x, x - island.x1, island.y0 - y, y - island.y1);
    if (bankDistance < 1) continue;
    const tile = grid[gi(x, y)];
    if (tile === BUILDING || tile === TREE || tile === COURT || tile === ALLEY || tile === PROP || tile === WATER) leftovers[tile] = (leftovers[tile] || 0) + 1;
    const strayPavement = tile === SIDEWALK && bankDistance > 1 && !besideRoad(x, y) && railCentrelineDistance((x + 0.5) * T, (y + 0.5) * T) > 1.5 * T;
    if (strayPavement) leftovers['stray sidewalk'] = (leftovers['stray sidewalk'] || 0) + 1;
  }
  if (Object.keys(leftovers).length) failures.push('city tiles between the moat and the street: ' + JSON.stringify(leftovers));
  const post = army.guardDuties.find(duty => duty.post).post;
  for (const [name, spot] of [['sentry', post], ['booth', post.booth]]) {
    const tx = Math.floor(spot.x / T), ty = Math.floor(spot.y / T);
    if (!walkableTile(tileAt(tx, ty))) failures.push(name + ' tile is not walkable');
    if (openingKeys.has(gi(tx, ty))) failures.push(name + ' stands on the gate opening');
    if (opening.some(([x, y]) => horizontalFence ? x === tx : y === ty)) failures.push(name + ' stands in the lane of the gate opening');
    if (tx < x0 + 1 || tx > x1 - 1 || ty < y0 + 1 || ty > y1 - 1) failures.push(name + ' is not inside the yard');
  }
  return JSON.stringify({ failures, clamped: !!jog && jog.len > T / 2 });
})()`;

const CHECK_PONDS = `(() => {
  const failures = [];
  let pondTiles = 0;
  const inIsland = (x, y) => !!armyZone && x >= armyZone.island.x0 && x <= armyZone.island.x1 && y >= armyZone.island.y0 && y <= armyZone.island.y1;
  const inPortStrip = (x, y) => Math.min(x, y, MAP_W - 1 - x, MAP_H - 1 - y) < PORT_STRIP;
  const centreOffset = PERIOD / 2;
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    if (grid[gi(x, y)] !== WATER || inIsland(x, y) || inPortStrip(x, y)) continue;
    const bx = Math.floor(x / PERIOD), by = Math.floor(y / PERIOD);
    if (blockCat(bx, by) !== PARK_CAT) continue;
    pondTiles++;
    if (railCentrelineDistance((x + 0.5) * T, (y + 0.5) * T) <= 1.5 * T) failures.push('pond water in the rail corridor at ' + x + ',' + y);
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      const tile = tileAt(nx, ny);
      const parkPath = Math.floor(nx / PERIOD) === bx && Math.floor(ny / PERIOD) === by && (nx % PERIOD === centreOffset || ny % PERIOD === centreOffset);
      if (tile === ROAD || (tile === SIDEWALK && !parkPath)) failures.push('pond water at ' + x + ',' + y + ' touches ' + (tile === ROAD ? 'road' : 'sidewalk'));
    }
  }
  return JSON.stringify({ failures: failures.slice(0, 5), pondTiles });
})()`;

console.log(`1) army island edges over ${CODES.length} cities (${SEEDS_PER_SIZE} per size P/M/G)`);
const islandFailures = [], pondFailures = [], codesWithoutBase = [];
let clampedBridges = 0, pondTiles = 0;
for (const code of CODES) {
  const run = loadCity(code);
  if (!run('!!armyZone')) { codesWithoutBase.push(code); continue; }
  const island = JSON.parse(run(CHECK_ISLAND));
  if (island.clamped) clampedBridges++;
  for (const failure of island.failures) islandFailures.push(`${code}: ${failure}`);
  const ponds = JSON.parse(run(CHECK_PONDS));
  pondTiles += ponds.pondTiles;
  for (const failure of ponds.failures) pondFailures.push(`${code}: ${failure}`);
}
ok(codesWithoutBase.length === 0, `every test city has an army base (missing: ${codesWithoutBase.join(', ') || 'none'})`);
ok(islandFailures.length === 0, `gate, deck, approach, moat strip and guard posts are sound${islandFailures.length ? ':\n    ' + islandFailures.slice(0, 20).join('\n    ') : ''}`);
console.log(`  .. ${clampedBridges} of them clamp the bridge axis`);

console.log(`1b) wider street jitter forces the bridge axis clamp (${FORCED_CODES.length} cities)`);
ok(WIDE_STREET_JITTER(BUNDLE) !== BUNDLE, `the street jitter patch applies (${STREET_JITTER})`);
const forcedFailures = [];
let forcedClamps = 0;
for (const code of FORCED_CODES) {
  const run = loadCity(code, { patch: WIDE_STREET_JITTER });
  const island = JSON.parse(run(CHECK_ISLAND));
  if (island.clamped) forcedClamps++;
  for (const failure of island.failures) forcedFailures.push(`${code}: ${failure}`);
}
ok(forcedClamps > 0, `some cities clamp the bridge axis (${forcedClamps})`);
ok(forcedFailures.length === 0, `clamped bridges keep the gate on the deck, no overhang and a road to the street${forcedFailures.length ? ':\n    ' + forcedFailures.slice(0, 20).join('\n    ') : ''}`);

console.log(`2) park ponds keep a building-free shore`);
ok(pondFailures.length === 0, `no pond touches a street or the rail corridor${pondFailures.length ? ':\n    ' + pondFailures.slice(0, 20).join('\n    ') : ''}`);
ok(pondTiles > 0, `some park ponds survive (${pondTiles} water tiles)`);

console.log(`3) peace cities (${PEACE_CODES.length})`);
const peaceFailures = [];
let peaceWithArmy = 0;
for (const code of PEACE_CODES) {
  const run = loadCity(code, { peace: true });
  if (run('!!armyZone')) { peaceWithArmy++; continue; }
  for (const failure of JSON.parse(run(CHECK_PONDS)).failures) peaceFailures.push(`${code}: ${failure}`);
}
ok(peaceWithArmy === 0, `peace cities have no army island (${peaceWithArmy} with one)`);
ok(peaceFailures.length === 0, `peace city ponds keep a building-free shore${peaceFailures.length ? ':\n    ' + peaceFailures.slice(0, 20).join('\n    ') : ''}`);

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
