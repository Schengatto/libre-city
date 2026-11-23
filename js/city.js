// LIBRE CITY · js/city.js — city generation: street grid graph, tiles and alleys,
// landmarks (hospital, police, gun shop…), military base, buildings and street detail.

// ---------- City: road network as a graph (an orthogonal street grid) ----------
const T = 32;                 // pixels per tile
const PERIOD = 14;            // average region size (variety: parks, plazas, colours)
// City SIZE is encoded in the 1st letter of the ROOM CODE (P=small, M=medium,
// G=large): every client — from a link or by typing the code — and the server
// regenerate a map of the same size at load time, from the seed alone, with nothing
// transmitted. Medium doubles the area by growing vertically; large doubles again by
// growing horizontally. A leading letter outside P/M/G means small (single-player and
// anonymous rooms, see core.js).
const MAP_DIMS = { P: [184, 184], M: [184, 368], G: [368, 368] };
const _mapDims = MAP_DIMS[String(ROOM_CODE).charAt(0)] || MAP_DIMS.P;
const MAP_W = _mapDims[0], MAP_H = _mapDims[1];
const CITY_W = MAP_W;
const WORLD_W = MAP_W * T, WORLD_H = MAP_H * T;
const HALF_ROAD = 2.1 * T;    // half carriageway width (px)
const LANE = 18;              // right-lane offset from the road centreline

const ROAD = 0, SIDEWALK = 1, BUILDING = 2, GRASS = 3, TREE = 4, WATER = 5, ALLEY = 6, COURT = 7;
const grid = new Uint8Array(MAP_W * MAP_H);
const gi = (x, y) => y * MAP_W + x;

// Roof palettes per neighbourhood type: residential, offices, industrial.
const RES_COLORS = ['#7d5b46','#8a6d52','#89746a','#9a8466','#8f6f5a','#96826f','#7a5a5a','#847b6a'];
const OFF_COLORS = ['#5d6b78','#6b6f7a','#4f5a68','#556170','#5f7a72','#7a6a86','#665a72','#5a6d6b'];
const IND_COLORS = ['#5f6b5a','#736256','#6d5f6b','#82755a','#6a7d6a','#8a8478'];
const hash2 = (a, b) => (((a | 0) * 73856093) ^ ((b | 0) * 19349663)) >>> 0;
const RES_KIND = 0, OFF_KIND = 1, IND_KIND = 2;
const blockKind = (bx, by) => hash2(bx + 13, by + 29) % 3;
const blockColor = (bx, by) => {
  const pal = [RES_COLORS, OFF_COLORS, IND_COLORS][blockKind(bx, by)];
  return pal[hash2(bx, by) % pal.length];
};
// Building lots: they split blocks into a regular grid of rectangles, and
// bakeBuildings() turns each lot into an actual rectangular building.
const LOTX = new Uint8Array(MAP_W), LOTY = new Uint8Array(MAP_H);     // lot index per axis
(function bakeLots() {
  const bake = (arr, len, salt) => {
    let seg = 0, end = -1;
    for (let v = 0; v < len; v++) {
      if (v > end) { seg++; end = v + 2 + hash2(v * 7 + salt, seg * 13 + salt * 5) % 4; }
      arr[v] = seg;
    }
  };
  bake(LOTX, MAP_W, 1); bake(LOTY, MAP_H, 3);
})();
// Palettes for pitched house roofs and shop awnings.
const ROOF_COLS = ['#8a4a3a', '#96604a', '#7a5a48', '#6d5242', '#5f6066', '#585c64'];
const AWNING_COLS = ['#c0392b', '#2e86c0', '#27ae60', '#d68910'];
// Block category: park, plaza or buildings (for a more varied city).
const BUILD_CAT = 0, PARK_CAT = 1, PLAZA_CAT = 2;
function blockCat(bx, by) {
  const h = hash2(bx + 7, by + 3) % 9;
  if (h === 0 || h === 6) return PARK_CAT;      // ~2/9 parks
  if (h === 3) return PLAZA_CAT;                // ~1/9 plazas
  return BUILD_CAT;
}
const blockHasPond  = (bx, by) => hash2(bx + 1, by + 8) % 3 === 0;   // park with a pond

// ---------- Curve geometry (quadratic Bézier) ----------
function bez(A, B, cx, cy, t) {
  const mt = 1 - t;
  return { x: mt * mt * A.x + 2 * mt * t * cx + t * t * B.x,
           y: mt * mt * A.y + 2 * mt * t * cy + t * t * B.y };
}

// ---------- Road graph: nodes (junctions) and edges (straight roads) ----------
const nodes = [];   // { x, y, edges:[idx...], signal, live }
const edges = [];   // { a, b, cx, cy, len }
const MARGIN = 8, BLOCK_PITCH = 24;
const NX = Math.round((MAP_W - 2 * MARGIN) / BLOCK_PITCH) + 1, NY = Math.round((MAP_H - 2 * MARGIN) / BLOCK_PITCH) + 1;
const ROAD_SEED = hashStr(ROOM_CODE + ':ROADS');
function gridLines(count, span, lineSalt, axisSalt) {
  const pitch = span / (count - 1), lines = [];
  for (let k = 0; k < count; k++) {
    let jitter = k === 0 || k === count - 1 ? 0 : (hash2(k + lineSalt, axisSalt ^ ROAD_SEED) % 1000 / 1000 - 0.5) * pitch * 0.30;
    if (k === 1) jitter = Math.max(0, jitter); else if (k === count - 2) jitter = Math.min(0, jitter);
    lines.push(MARGIN * T + k * pitch + jitter);
  }
  return lines;
}
const colX = gridLines(NX, (MAP_W - 2 * MARGIN) * T, 11, 3), rowY = gridLines(NY, (MAP_H - 2 * MARGIN) * T, 5, 17);
function addRoadEdge(a, b) {
  const A = nodes[a], B = nodes[b];
  const e = { a, b, cx: (A.x + B.x) / 2, cy: (A.y + B.y) / 2, len: Math.hypot(B.x - A.x, B.y - A.y) };
  const idx = edges.length; edges.push(e); A.edges.push(idx); B.edges.push(idx);
}
function buildGraph() {
  const idOf = (i, j) => j * NX + i;
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) nodes.push({ x: colX[i], y: rowY[j], edges: [], signal: false, live: true });
  const island = PEACE_CITY ? null : pickArmyIsland();
  const armyNode = island ? idOf(island.i, island.j) : -1;
  const streets = [];
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    if (i < NX - 1) streets.push({ a: idOf(i, j), b: idOf(i + 1, j), ring: j === 0 || j === NY - 1, roll: hash2(i * 3 + 1, (j * 7 + 2) ^ ROAD_SEED) % 3 === 0 });
    if (j < NY - 1) streets.push({ a: idOf(i, j), b: idOf(i, j + 1), ring: i === 0 || i === NX - 1, roll: hash2(i * 9 + 4, (j * 5 + 6) ^ ROAD_SEED) % 3 === 0 });
  }
  const candidates = streets.filter(s => s.a !== armyNode && s.b !== armyNode);
  const degree = new Uint8Array(nodes.length);
  for (const s of candidates) { degree[s.a]++; degree[s.b]++; }
  for (const s of candidates) {
    if (!s.ring && s.roll && degree[s.a] >= 4 && degree[s.b] >= 4) { degree[s.a]--; degree[s.b]--; continue; }
    addRoadEdge(s.a, s.b);
  }
  if (island) reserveArmyIsland(island, armyNode);
  // Traffic lights only at some busy junctions, NOT at every one.
  for (let n = 0; n < nodes.length; n++)
    if (nodes[n].edges.length >= 3 && hash2(n * 3 + 2, n + 5) % 3 === 0) nodes[n].signal = true;
}

// ---------- Rasterising the roads onto tiles ----------
function stampRoadRect(x0, y0, x1, y1) {
  const tx0 = Math.max(0, Math.ceil(x0 / T - 0.5)), tx1 = Math.min(MAP_W - 1, Math.floor(x1 / T - 0.5));
  const ty0 = Math.max(0, Math.ceil(y0 / T - 0.5)), ty1 = Math.min(MAP_H - 1, Math.floor(y1 / T - 0.5));
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) grid[gi(tx, ty)] = ROAD;
}
function bakeRoads() {
  grid.fill(BUILDING);
  for (const e of edges) {
    const A = nodes[e.a], B = nodes[e.b];
    stampRoadRect(Math.min(A.x, B.x) - HALF_ROAD, Math.min(A.y, B.y) - HALF_ROAD, Math.max(A.x, B.x) + HALF_ROAD, Math.max(A.y, B.y) + HALF_ROAD);
  }
}
const walkableTile = t => t === ROAD || t === SIDEWALK || t === ALLEY;
function bakeSidewalksAndBlocks() {
  const copy = grid.slice();
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    if (copy[gi(x, y)] === ROAD) continue;
    let adj = false;
    for (let dy = -1; dy <= 1 && !adj; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < MAP_W && ny < MAP_H && copy[gi(nx, ny)] === ROAD) { adj = true; break; }
    }
    if (adj) grid[gi(x, y)] = SIDEWALK;                // pavement ringing the roads
  }
  // Fill the blocks: buildings, parks or plazas depending on the region.
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    if (grid[gi(x, y)] !== BUILDING) continue;
    const bx = Math.floor(x / PERIOD), by = Math.floor(y / PERIOD), cat = blockCat(bx, by);
    const cxr = (bx + 0.5) * PERIOD, cyr = (by + 0.5) * PERIOD;
    const dxr = x - cxr, dyr = y - cyr, dc = Math.hypot(dxr, dyr);
    if (cat === PARK_CAT) {
      // A "designed" park: oval pond, cross-shaped paths leading to the exits,
      // dense trees along the shore and scattered copses on the lawn.
      const pond = blockHasPond(bx, by);
      const pr = 2.0 + (hash2(bx + 4, by + 6) % 100) / 100;            // pond radius 2.0–3.0
      if (pond && (dxr * dxr) / (pr * pr) + (dyr * dyr) / (pr * pr * 0.56) < 1) grid[gi(x, y)] = WATER;
      else if (Math.abs(dxr) < 0.8 || Math.abs(dyr) < 0.8) grid[gi(x, y)] = SIDEWALK;  // paths
      else if (pond && dc < pr + 1.7) grid[gi(x, y)] = hash2(x + 3, y + 11) % 3 === 0 ? TREE : GRASS;
      else if (hash2(x >> 1, y >> 1) % 5 === 0 && hash2(x * 3, y * 5) % 3 !== 0) grid[gi(x, y)] = TREE;  // copses
      else grid[gi(x, y)] = GRASS;
    } else if (cat === PLAZA_CAT) {
      // Plaza: fountain at the centre and regular rows of potted trees.
      if (dc < 1.6) grid[gi(x, y)] = WATER;             // fountain
      else if (dc > 2.6 && x % PERIOD % 4 === 2 && y % PERIOD % 4 === 2) grid[gi(x, y)] = TREE;
      else grid[gi(x, y)] = SIDEWALK;
    }
  }
}
// Narrow 1-tile alleys between buildings, with at least one exit onto a street.
function carveAlleys() {
  let made = 0;
  for (let attempt = 0; attempt < 700 && made < 90; attempt++) {
    const sx = 2 + hash2(attempt * 13 + 1, attempt * 7 + 5) % (MAP_W - 4);
    const sy = 2 + hash2(attempt * 17 + 3, attempt * 11 + 2) % (MAP_H - 4);
    if (grid[gi(sx, sy)] !== BUILDING) continue;
    const horiz = (hash2(attempt + 1, attempt + 9) & 1) === 0;
    const dx = horiz ? 1 : 0, dy = horiz ? 0 : 1;
    const run = [];
    let x = sx, y = sy;
    while (x >= 1 && y >= 1 && grid[gi(x, y)] === BUILDING) { run.push([x, y]); x -= dx; y -= dy; }
    const negWalk = x >= 0 && y >= 0 && x < MAP_W && y < MAP_H && walkableTile(grid[gi(x, y)]);
    x = sx + dx; y = sy + dy;
    while (x < MAP_W - 1 && y < MAP_H - 1 && grid[gi(x, y)] === BUILDING) { run.push([x, y]); x += dx; y += dy; }
    const posWalk = x >= 0 && y >= 0 && x < MAP_W && y < MAP_H && walkableTile(grid[gi(x, y)]);
    if (run.length >= 3 && run.length <= 14 && (negWalk || posWalk)) {
      for (const [ax, ay] of run) grid[gi(ax, ay)] = ALLEY;
      made++;
    }
  }
}
// ---------- Military zone: reserved BEFORE the roads are paved ----------
// VIOLENCE FILTER (single-player, PEACE_CITY in core.js): a peaceful city has no army,
// so nothing is reserved (armyZone stays null → placeArmyBase returns immediately, taking the
// barracks, tanks, jeeps, guards and turrets with it).
const ARMY_W = 26, ARMY_H = 20, ISLAND_BANKS = 5;
let armyZone = null;
const inArmyZone = (tx, ty) => !!armyZone && tx >= armyZone.x0 && tx <= armyZone.x1 && ty >= armyZone.y0 && ty <= armyZone.y1;
function pickArmyIsland() {
  const clearance = HALF_ROAD + T;
  const span = (lines, k) => (lines[k + 1] - lines[k - 1] - 2 * clearance) / T;
  const superblocks = [];
  for (let j = 2; j <= NY - 3; j++) for (let i = 2; i <= NX - 3; i++) superblocks.push({ i, j, w: span(colX, i), h: span(rowY, j) });
  const fitting = superblocks.filter(s => s.w >= ARMY_W + 2 * ISLAND_BANKS + 3 && s.h >= ARMY_H + 2 * ISLAND_BANKS + 3);
  return fitting.length ? fitting[rndi(0, fitting.length - 1)] : superblocks.reduce((best, s) => s.w * s.h > best.w * best.h ? s : best);
}
function reserveArmyIsland({ i, j }, armyNode) {
  nodes[armyNode].live = false;
  const x0 = Math.round((colX[i - 1] + colX[i + 1]) / 2 / T - ARMY_W / 2), x1 = x0 + ARMY_W - 1;
  const y0 = Math.round((rowY[j - 1] + rowY[j + 1]) / 2 / T - ARMY_H / 2), y1 = y0 + ARMY_H - 1;
  const [di, dj] = [[0, -1], [1, 0], [0, 1], [-1, 0]][rndi(0, 3)];
  const gateApproach = {
    x: di ? (di < 0 ? x0 - 0.5 : x1 + 1.5) * T : colX[i],
    y: dj ? (dj < 0 ? y0 - 0.5 : y1 + 1.5) * T : rowY[j],
    edges: [], signal: false, live: true,
  };
  nodes.push(gateApproach);
  addRoadEdge(armyNode + dj * NX + di, nodes.length - 1);
  const island = { x0: x0 - ISLAND_BANKS, y0: y0 - ISLAND_BANKS, x1: x1 + ISLAND_BANKS, y1: y1 + ISLAND_BANKS };
  armyZone = { x0, y0, x1, y1, island, gateApproach };
}
function bakeArmyIsland() {
  if (!armyZone) return;
  const { x0, y0, x1, y1, island, gateApproach } = armyZone;
  const gateX = Math.floor(gateApproach.x / T), gateY = Math.floor(gateApproach.y / T), deckHalf = HALF_ROAD + T;
  const verticalBridge = gateY < y0 || gateY > y1;
  const beyondGateSide = (x, y) => gateY < y0 ? y < y0 : gateY > y1 ? y > y1 : gateX < x0 ? x < x0 : x > x1;
  const offAxis = (x, y) => verticalBridge ? Math.abs((x + 0.5) * T - gateApproach.x) : Math.abs((y + 0.5) * T - gateApproach.y);
  for (let y = island.y0; y <= island.y1; y++) for (let x = island.x0; x <= island.x1; x++) {
    const ring = Math.max(x0 - x, x - x1, y0 - y, y - y1);
    if (ring < 1 || (beyondGateSide(x, y) && offAxis(x, y) <= deckHalf)) continue;
    grid[gi(x, y)] = ring === 1 ? GRASS : ring < ISLAND_BANKS ? WATER : SIDEWALK;
  }
}
const RAIL_INSET = Math.floor((MARGIN + Math.min(colX[1], rowY[1], MAP_W * T - colX[NX - 2], MAP_H * T - rowY[NY - 2]) / T) / 2);
const RAIL_CORNER_R = Math.min(6 * T, (RAIL_INSET - MARGIN) * T / 2);
const railLoop = (() => {
  const x0 = RAIL_INSET * T, y0 = RAIL_INSET * T, x1 = WORLD_W - RAIL_INSET * T, y1 = WORLD_H - RAIL_INSET * T, r = RAIL_CORNER_R;
  return {
    x0, y0, x1, y1,
    straights: [x1 - x0 - 2 * r, y1 - y0 - 2 * r],
    arcLen: r * TAU / 4,
    sideStarts: [[x0 + r, y0], [x1, y0 + r], [x1 - r, y1], [x0, y1 - r]],
    arcCentres: [[x1 - r, y0 + r], [x1 - r, y1 - r], [x0 + r, y1 - r], [x0 + r, y0 + r]],
  };
})();
const RAIL_LOOP_LEN = 2 * (railLoop.straights[0] + railLoop.straights[1]) + 4 * railLoop.arcLen;
const railCrossings = [];
function railPointAt(s) {
  let along = ((s % RAIL_LOOP_LEN) + RAIL_LOOP_LEN) % RAIL_LOOP_LEN;
  for (let side = 0; side < 4; side++) {
    const heading = side * TAU / 4, straight = railLoop.straights[side % 2];
    if (along < straight) {
      const [sx, sy] = railLoop.sideStarts[side];
      return { x: sx + Math.cos(heading) * along, y: sy + Math.sin(heading) * along, angle: heading };
    }
    along -= straight;
    if (along < railLoop.arcLen || side === 3) {
      const [cx, cy] = railLoop.arcCentres[side], turn = Math.min(along, railLoop.arcLen) / RAIL_CORNER_R;
      return { x: cx + RAIL_CORNER_R * Math.cos(heading - TAU / 4 + turn), y: cy + RAIL_CORNER_R * Math.sin(heading - TAU / 4 + turn), angle: heading + turn };
    }
    along -= railLoop.arcLen;
  }
}
function railCentrelineDistance(x, y) {
  const { x0, y0, x1, y1 } = railLoop, r = RAIL_CORNER_R;
  const qx = Math.abs(x - (x0 + x1) / 2) - ((x1 - x0) / 2 - r), qy = Math.abs(y - (y0 + y1) / 2) - ((y1 - y0) / 2 - r);
  return Math.abs(Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r);
}
function bakeRailCorridor() {
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    const t = grid[gi(x, y)];
    if (t !== ROAD && t !== SIDEWALK && railCentrelineDistance((x + 0.5) * T, (y + 0.5) * T) <= 1.5 * T) grid[gi(x, y)] = GRASS;
  }
  const step = T / 4, samples = Math.floor(RAIL_LOOP_LEN / step), runs = [];
  let runStart = -1;
  for (let k = 0; k <= samples; k++) {
    const p = k < samples ? railPointAt(k * step) : null;
    const onRoad = !!p && grid[gi(Math.floor(p.x / T), Math.floor(p.y / T))] === ROAD;
    if (onRoad && runStart < 0) runStart = k;
    else if (!onRoad && runStart >= 0) { runs.push([runStart * step, (k - 1) * step]); runStart = -1; }
  }
  if (runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1][1] === (samples - 1) * step) runs[0][0] = runs.pop()[0] - RAIL_LOOP_LEN;
  for (const [startS, endS] of runs) {
    const s = (((startS + endS) / 2) % RAIL_LOOP_LEN + RAIL_LOOP_LEN) % RAIL_LOOP_LEN, p = railPointAt(s);
    railCrossings.push({ s, x: p.x, y: p.y });
  }
}
function genCity() { buildGraph(); bakeRoads(); bakeSidewalksAndBlocks(); bakeRailCorridor(); bakeArmyIsland(); carveAlleys(); }
genCity();

const tileAt = (tx, ty) => (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) ? BUILDING : grid[gi(tx, ty)];
const solidTile = (tx, ty) => { const t = tileAt(tx, ty); return t === BUILDING || t === TREE || t === WATER; };

// ---------- Special buildings: police, hospital, fire station, bank, market ----------
const landmarks = [];                                  // { type, x0, y0, x1, y1, cx, cy, door }
const lmGrid = new Uint8Array(MAP_W * MAP_H).fill(255);
const LM_DEFS = [
  { type: 'police',   w: 7, h: 5, count: 2 },
  { type: 'hospital', w: 8, h: 6, count: 2 },
  { type: 'fire',     w: 6, h: 5, count: 2 },
  { type: 'bank',     w: 6, h: 5, count: 2 },
  { type: 'market',   w: 9, h: 6, count: 2 },
  { type: 'pizzeria', w: 6, h: 5, count: 2 },
  { type: 'gunshop',  w: 6, h: 5, count: 2 },
];
function rectAllBuilding(x0, y0, w, h) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++)
    if (tileAt(x, y) !== BUILDING || lmGrid[gi(x, y)] !== 255 || inArmyZone(x, y)) return false;
  return true;
}
// Nearest walkable point on the perimeter (the building's entrance).
function landmarkDoor(lm) {
  for (let d = 1; d < 10; d++) {
    for (let x = lm.x0 - d; x <= lm.x1 + d; x++) {
      if (walkableTile(tileAt(x, lm.y1 + d))) return { x: (x + 0.5) * T, y: (lm.y1 + d + 0.5) * T };
      if (walkableTile(tileAt(x, lm.y0 - d))) return { x: (x + 0.5) * T, y: (lm.y0 - d + 0.5) * T };
    }
    for (let y = lm.y0 - d; y <= lm.y1 + d; y++) {
      if (walkableTile(tileAt(lm.x1 + d, y))) return { x: (lm.x1 + d + 0.5) * T, y: (y + 0.5) * T };
      if (walkableTile(tileAt(lm.x0 - d, y))) return { x: (lm.x0 - d + 0.5) * T, y: (y + 0.5) * T };
    }
  }
  return { x: lm.cx, y: lm.cy };
}
// The BARRACKS is not a building but a fenced compound: the inner yard is walkable
// (jeeps and tanks park there) while the perimeter becomes a solid fence with a
// 3-tile gate opening towards the nearest street.
function carveArmyBase(lm) {
  // The reserved zone may contain lawns/alleys, so the fence must be walled explicitly.
  for (let x = lm.x0; x <= lm.x1; x++) { grid[gi(x, lm.y0)] = BUILDING; grid[gi(x, lm.y1)] = BUILDING; }
  for (let y = lm.y0; y <= lm.y1; y++) { grid[gi(lm.x0, y)] = BUILDING; grid[gi(lm.x1, y)] = BUILDING; }
  for (let y = lm.y0 + 1; y < lm.y1; y++) for (let x = lm.x0 + 1; x < lm.x1; x++)
    grid[gi(x, y)] = SIDEWALK;                        // inner yard
  lm.layout = armyBaseLayout(lm);
  for (const r of lm.layout.buildings)
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) grid[gi(x, y)] = BUILDING;
  // Gate on whichever fence side faces the entrance (lm.door).
  const dtx = Math.floor(lm.door.x / T), dty = Math.floor(lm.door.y / T);
  const dl = Math.abs(dtx - lm.x0), dr = Math.abs(dtx - lm.x1);
  const dt = Math.abs(dty - lm.y0), db = Math.abs(dty - lm.y1);
  const m = Math.min(dl, dr, dt, db);
  let g, out;                                         // gate tiles + outward direction
  if (m === dt || m === db) {
    const gy = m === dt ? lm.y0 : lm.y1, gx = clamp(dtx, lm.x0 + 1, lm.x1 - 3);
    g = [[gx, gy], [gx + 1, gy], [gx + 2, gy]]; out = { x: 0, y: m === dt ? -1 : 1 };
  } else {
    const gx = m === dl ? lm.x0 : lm.x1, gy = clamp(dty, lm.y0 + 1, lm.y1 - 3);
    g = [[gx, gy], [gx, gy + 1], [gx, gy + 2]]; out = { x: m === dl ? -1 : 1, y: 0 };
  }
  for (const [x, y] of g) {
    grid[gi(x, y)] = SIDEWALK;
    // Driveway: from the gate out to the first walkable surface outside.
    let cx = x + out.x, cy = y + out.y, steps = 0;
    while (steps++ < 24 && cx > 1 && cy > 1 && cx < MAP_W - 2 && cy < MAP_H - 2 &&
           lmGrid[gi(cx, cy)] === 255 && !walkableTile(tileAt(cx, cy))) {
      grid[gi(cx, cy)] = SIDEWALK;
      cx += out.x; cy += out.y;
    }
  }
  lm.gate = { x: (g[0][0] + g[2][0] + 1) / 2 * T, y: (g[0][1] + g[2][1] + 1) / 2 * T };
  lm.guardDuties = armyGuardDuties(lm, out);
}
function armyBaseLayout(lm) {
  const rect = (ix0, iy0, ix1, iy1) => ({ x0: lm.x0 + ix0, y0: lm.y0 + iy0, x1: lm.x0 + ix1, y1: lm.y0 + iy1 });
  const layout = {
    interior: rect(1, 1, ARMY_W - 2, ARMY_H - 2),
    lawns: [rect(3, 3, 11, 8), rect(14, 3, 22, 8), rect(3, 11, 11, 16), rect(14, 11, 22, 16)],
    barracks: [rect(3, 3, 11, 4), rect(3, 7, 11, 8)],
    musterYard: rect(3, 5, 11, 6),
    headquarters: rect(15, 4, 21, 7),
    motorPool: rect(3, 11, 11, 14),
    garage: rect(3, 15, 11, 16),
    helipad: rect(14, 11, 19, 16),
    depot: rect(20, 11, 22, 16),
    flagpole: { x: (lm.x0 + 18.5) * T, y: (lm.y0 + 8.5) * T },
  };
  layout.buildings = [...layout.barracks, layout.headquarters, layout.garage, layout.depot];
  return layout;
}
function armyGuardDuties(lm, gateOutward) {
  const lateral = { x: -gateOutward.y, y: gateOutward.x };
  const towardCentre = Math.sign((lm.cx - lm.gate.x) * lateral.x + (lm.cy - lm.gate.y) * lateral.y) || 1;
  const besideGate = (depth, side) => ({
    x: lm.gate.x - gateOutward.x * depth * T + lateral.x * towardCentre * side * T,
    y: lm.gate.y - gateOutward.y * depth * T + lateral.y * towardCentre * side * T,
  });
  const sentry = { ...besideGate(1.5, 2), facing: Math.atan2(gateOutward.y, gateOutward.x), booth: besideGate(1.1, 3) };
  const near = 2.5 * T;
  const left = lm.x0 * T + near, right = (lm.x1 + 1) * T - near;
  const top = lm.y0 * T + near, bottom = (lm.y1 + 1) * T - near;
  const patrolRoute = [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
  return [{ post: sentry }, { route: patrolRoute }];
}
function placeLandmarks() {
  for (const def of LM_DEFS) for (let k = 0; k < def.count; k++) {
    for (let att = 0; att < 500; att++) {
      const x0 = rndi(6, MAP_W - def.w - 6), y0 = rndi(6, MAP_H - def.h - 6);
      if (!rectAllBuilding(x0 - 1, y0 - 1, def.w + 2, def.h + 2)) continue;   // needs a free margin
      const cx = (x0 + def.w / 2) * T, cy = (y0 + def.h / 2) * T;
      let far = true;                                   // keep same-type buildings spread out
      for (const l of landmarks) if (l.type === def.type && dist(l.cx, l.cy, cx, cy) < 1700) { far = false; break; }
      if (!far) continue;
      const lm = { type: def.type, x0, y0, x1: x0 + def.w - 1, y1: y0 + def.h - 1, cx, cy };
      lm.door = landmarkDoor(lm);
      const id = landmarks.length; landmarks.push(lm);
      for (let y = y0; y <= lm.y1; y++) for (let x = x0; x <= lm.x1; x++) lmGrid[gi(x, y)] = id;
      break;
    }
  }
}
// The zone the generator reserved becomes the barracks: fence, gate, yard.
function placeArmyBase() {
  if (!armyZone) return;
  const { x0, y0, x1, y1 } = armyZone;
  const lm = { type: 'army', x0, y0, x1, y1,
               cx: (x0 + (x1 - x0 + 1) / 2) * T, cy: (y0 + (y1 - y0 + 1) / 2) * T };
  const { gateApproach } = armyZone, gateTileX = Math.floor(gateApproach.x / T), gateTileY = Math.floor(gateApproach.y / T);
  lm.door = gateTileY < y0 || gateTileY > y1
    ? { x: gateApproach.x - T, y: gateApproach.y + (gateTileY < y0 ? T : -T) }
    : { x: gateApproach.x + (gateTileX < x0 ? T : -T), y: gateApproach.y - T };
  const id = landmarks.length; landmarks.push(lm);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) lmGrid[gi(x, y)] = id;
  carveArmyBase(lm);
}
placeLandmarks();
placeArmyBase();

// ---------- Real buildings: one rectangular block per lot ----------
// The blob-shaped fill around the roads gets refined: inside each lot only the largest
// solid rectangle survives (the building), and the offcuts become courtyards (COURT):
// gardens in residential areas, paved forecourts by offices, yards with stacked crates
// in industrial ones.
const bldgs = [];                                      // { x0,y0,x1,y1, kind, style, face, lift, col, h }
const bldgIdx = new Uint16Array(MAP_W * MAP_H).fill(65535);
function bakeBuildings() {
  const isB = (x, y) => tileAt(x, y) === BUILDING && lmGrid[gi(x, y)] === 255;
  const segs = arr => {                                // [start, end] of every lot on the axis
    const out = []; let s = 0;
    for (let v = 1; v <= arr.length; v++) if (v === arr.length || arr[v] !== arr[s]) { out.push([s, v - 1]); s = v; }
    return out;
  };
  for (const [ya, yb] of segs(LOTY)) for (const [xa, xb] of segs(LOTX)) {
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++)
      if (isB(x, y)) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (!n) continue;
    // Trim the bounding box from its most "holey" side until the rectangle is solid.
    const rowCnt = y => { let c = 0; for (let x = x0; x <= x1; x++) if (isB(x, y)) c++; return c; };
    const colCnt = x => { let c = 0; for (let y = y0; y <= y1; y++) if (isB(x, y)) c++; return c; };
    let guard = 0;
    while (x1 - x0 >= 1 && y1 - y0 >= 1 && guard++ < 24) {
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      const ct = rowCnt(y0), cb = rowCnt(y1), cl = colCnt(x0), cr = colCnt(x1);
      if (ct === w && cb === w && cl === h && cr === h) break;
      const m = Math.min(ct, cb, cl, cr);
      if (m === ct) y0++; else if (m === cb) y1--; else if (m === cl) x0++; else x1--;
    }
    let full = x1 - x0 >= 1 && y1 - y0 >= 1;
    for (let y = y0; y <= y1 && full; y++) for (let x = x0; x <= x1; x++) if (!isB(x, y)) { full = false; break; }
    if (full) {
      const id = bldgs.length;
      bldgs.push({ x0, y0, x1, y1, h: hash2(x0 * 7 + y0 * 3 + 1, x1 * 5 + y1 * 11 + 2) });
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) bldgIdx[gi(x, y)] = id;
    }
    // Buildable tiles left outside the building become courtyard (or private greenery).
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
      if (!isB(x, y) || bldgIdx[gi(x, y)] !== 65535) continue;
      const k = blockKind(Math.floor(x / PERIOD), Math.floor(y / PERIOD)), hh = hash2(x + 21, y + 33);
      grid[gi(x, y)] = (k === RES_KIND && hh % 7 === 0) || (k === OFF_KIND && hh % 23 === 0) ? TREE : COURT;
    }
  }
  // Second pass (courtyards now carved): style, height and the side facing the street.
  for (const b of bldgs) {
    const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1, area = w * h;
    const midx = (b.x0 + b.x1) >> 1, midy = (b.y0 + b.y1) >> 1;
    b.kind = blockKind(Math.floor(midx / PERIOD), Math.floor(midy / PERIOD));
    b.face = walkableTile(tileAt(midx, b.y1 + 1)) ? 0 : walkableTile(tileAt(b.x1 + 1, midy)) ? 1
           : walkableTile(tileAt(b.x0 - 1, midy)) ? 2 : walkableTile(tileAt(midx, b.y0 - 1)) ? 3 : -1;
    if (b.kind === RES_KIND) b.style = area <= 18 ? 'house' : 'apartment';
    else if (b.kind === OFF_KIND) b.style = area >= 20 ? 'tower' : 'shop';
    else b.style = area >= 20 ? 'warehouse' : 'workshop';
    const storeyVariation = b.style === 'apartment' || b.style === 'tower' ? (b.h >> 4) % 3 * 4 : 0;
    b.lift = { house: 7, apartment: 11, shop: 9, tower: 16, warehouse: 9, workshop: 8 }[b.style] + storeyVariation;
    const pal = [RES_COLORS, OFF_COLORS, IND_COLORS][b.kind];
    b.col = pal[b.h % pal.length];
  }
}
bakeBuildings();

// ---------- Position/tangent along an edge; placement in the right-hand lane ----------
function edgePos(e, t) { return bez(nodes[e.a], nodes[e.b], e.cx, e.cy, t); }
function edgeTangent(e, t) {
  const A = nodes[e.a], B = nodes[e.b];
  let x = 2 * (1 - t) * (e.cx - A.x) + 2 * t * (B.x - e.cx);
  let y = 2 * (1 - t) * (e.cy - A.y) + 2 * t * (B.y - e.cy);
  const m = Math.hypot(x, y) || 1; return { x: x / m, y: y / m };
}

// ---------- Precomputed street detail: crossings, manholes, patches ----------
const crosswalks = [];   // { x, y, a } — in front of every real junction (3+ roads)
const roadDeco = [];     // { x, y, a, kind } — 0 manhole · 1 patch · 2 oil stain
(function bakeRoadDetails() {
  for (const n of nodes) {
    if (n.live === false) continue;                    // junction suppressed by the military zone
    if (n.edges.length < 3) continue;                  // no crossings at plain bends
    for (const ei of n.edges) {
      const e = edges[ei], fromA = nodes[e.a] === n;
      // Walk along the edge from the node until clear of the junction apron.
      const target = HALF_ROAD * 1.05 + 16, steps = Math.max(10, Math.ceil(e.len / 8));
      for (let s = 1; s <= steps; s++) {
        const t = fromA ? s / steps : 1 - s / steps;
        const p = edgePos(e, t);
        if (dist(p.x, p.y, n.x, n.y) >= target) {
          const tan = edgeTangent(e, t);
          crosswalks.push({ x: p.x, y: p.y, a: Math.atan2(tan.y, tan.x) });
          break;
        }
      }
    }
  }
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i], count = Math.floor(e.len / 240);
    for (let k = 1; k <= count; k++) {
      const t = k / (count + 1), p = edgePos(e, t), tan = edgeTangent(e, t);
      const h = hash2(i * 31 + k, k * 7 + 3);
      const off = h % 3 === 0 ? 0 : ((h & 1) ? LANE : -LANE);   // on the centreline or in a lane
      roadDeco.push({ x: p.x - tan.y * off, y: p.y + tan.x * off, a: Math.atan2(tan.y, tan.x), kind: h % 3 });
    }
  }
})();

function railPlace(c) {
  const e = edges[c.edge], p = edgePos(e, c.t), tan = edgeTangent(e, c.t);
  const dx = tan.x * c.ed, dy = tan.y * c.ed;      // direction of travel
  c.x = p.x - dy * LANE; c.y = p.y + dx * LANE;    // hold the right-hand lane
  c.dir = { x: dx, y: dy };
  c.angle = Math.atan2(dy, dx);
}

// Box (AABB) collision against solid tiles.
function boxHits(cx, cy, hw, hh) {
  const x0 = Math.floor((cx - hw) / T), x1 = Math.floor((cx + hw) / T);
  const y0 = Math.floor((cy - hh) / T), y1 = Math.floor((cy + hh) / T);
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++)
    if (solidTile(tx, ty)) return true;
  return false;
}
// Moves an entity axis by axis, stopping it against walls (sets hitX/hitY). Sliding
// flush to the wall only counts if that spot is genuinely free: a large step can jump
// clean over the tile it hit, and staying put is better in that case.
function moveBox(e, dx, dy, hw, hh) {
  e.hitX = false; e.hitY = false;
  if (dx !== 0) {
    const nx = e.x + dx;
    if (!boxHits(nx, e.y, hw, hh)) e.x = nx;
    else {
      const sx = dx > 0 ? Math.floor((nx + hw) / T) * T - hw - 0.01
                        : (Math.floor((nx - hw) / T) + 1) * T + hw + 0.01;
      if (!boxHits(sx, e.y, hw, hh)) e.x = sx;
      e.hitX = true;
    }
  }
  if (dy !== 0) {
    const ny = e.y + dy;
    if (!boxHits(e.x, ny, hw, hh)) e.y = ny;
    else {
      const sy = dy > 0 ? Math.floor((ny + hh) / T) * T - hh - 0.01
                        : (Math.floor((ny - hh) / T) + 1) * T + hh + 0.01;
      if (!boxHits(e.x, sy, hw, hh)) e.y = sy;
      e.hitY = true;
    }
  }
}
// If an entity ended up inside a solid tile anyway, pop it back out onto the centre of
// the nearest free tile (searching in growing rings).
function unstick(e, hw, hh) {
  if (!boxHits(e.x, e.y, hw, hh)) return;
  const tx = Math.floor(e.x / T), ty = Math.floor(e.y / T);
  for (let r = 1; r <= 6; r++)
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const wx = (tx + dx + 0.5) * T, wy = (ty + dy + 0.5) * T;
      if (!boxHits(wx, wy, hw, hh)) { e.x = wx; e.y = wy; return; }
    }
}

// Random points on road / pavement near a centre.
function randomTileNear(cx, cy, rmin, rmax, ok) {
  for (let i = 0; i < 60; i++) {
    const a = rnd(0, TAU), d = rnd(rmin, rmax);
    const wx = cx + Math.cos(a) * d, wy = cy + Math.sin(a) * d;
    const tx = Math.floor(wx / T), ty = Math.floor(wy / T);
    if (tx < 2 || ty < 2 || tx >= MAP_W - 2 || ty >= MAP_H - 2) continue;
    if (ok(tx, ty)) return { x: (tx + 0.5) * T, y: (ty + 0.5) * T, tx, ty };
  }
  return null;
}
const randomRoadNear = (cx, cy, rmin, rmax) => randomTileNear(cx, cy, rmin, rmax, (tx, ty) => tileAt(tx, ty) === ROAD);
const randomWalkNear = (cx, cy, rmin, rmax) => randomTileNear(cx, cy, rmin, rmax,
  (tx, ty) => { const t = tileAt(tx, ty); return (t === SIDEWALK || t === GRASS || t === ROAD || t === ALLEY) && !inArmyZone(tx, ty); });
