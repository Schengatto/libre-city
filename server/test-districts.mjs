import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import runtime from './sim-runtime.js';
import stubs from '../js/sim-stubs.js';
const { BUNDLE } = runtime;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const NO_DISTRICTS = s => s.replace('const DISTRICT_COUNTS = { P: 2, M: 3, G: 4 };', 'const DISTRICT_COUNTS = { P: 0, M: 0, G: 0 };');
const HUGE_RADIUS = s => s.replace('const DISTRICT_RADIUS_SHARE = 0.22;', 'const DISTRICT_RADIUS_SHARE = 0.9;');
function loadCity(code, patch = s => s) {
  const source = patch(BUNDLE);
  const context = vm.createContext(stubs.makeSimStubs(code, 900, { setTimeout, clearTimeout, setInterval, clearInterval }));
  vm.runInContext(source, context, { timeout: 5000 });
  return { run: expr => vm.runInContext(expr, context), patched: source !== BUNDLE };
}
const EXPECTED = { P: 2, M: 3, G: 4 };
const CODES = Object.fromEntries(Object.keys(EXPECTED).map(size => [size, Array.from({ length: 12 }, (_, k) => `${size}DST${String(k).padStart(2, '0')}`)]));
const readDistricts = run => run(`({ cols: DISTRICT_COLS, rows: DISTRICT_ROWS, grid: Array.from(districtGrid), centres: districtCentres.map(c => ({ ...c })), portSide, island: armyZone && { ...armyZone.island } })`);

const MIXED = 0, RESIDENTIAL = 1, INDUSTRIAL = 2, PORT = 4, PERIOD = 14, MARGIN = 8;
const MAP_SIZES = { P: [184, 184], M: [184, 368], G: [368, 368] };
const distinctDistricts = grid => new Set(grid.filter(d => d !== MIXED)).size;

function floodCovers(districts, id, centre) {
  const { cols, rows, grid } = districts, reached = new Set(), stack = [centre.by * cols + centre.bx];
  while (stack.length) {
    const cell = stack.pop(), bx = cell % cols, by = Math.floor(cell / cols);
    if (reached.has(cell) || grid[cell] !== id) continue;
    reached.add(cell);
    if (bx > 0) stack.push(cell - 1);
    if (bx < cols - 1) stack.push(cell + 1);
    if (by > 0) stack.push(cell - cols);
    if (by < rows - 1) stack.push(cell + cols);
  }
  return grid.every((d, cell) => d !== id || reached.has(cell));
}

console.log('1) distretti');
const loaded = {};
for (const [size, codes] of Object.entries(CODES)) for (const code of codes) {
  const city = loadCity(code);
  loaded[code] = {
    size, run: city.run, districts: readDistricts(city.run),
    cats: city.run('Array.from({ length: DISTRICT_COLS * DISTRICT_ROWS }, (_, i) => { const bx = i % DISTRICT_COLS, by = Math.floor(i / DISTRICT_COLS); return { cat: blockCat(bx, by), rail: cellTouchesRail(bx, by) }; })'),
  };
}

const wrongCounts = Object.entries(loaded).filter(([, c]) => distinctDistricts(c.districts.grid) !== EXPECTED[c.size]).map(([code]) => code);
ok(wrongCounts.length === 0, `district count per size (${Object.keys(loaded).length} codes)` + (wrongCounts.length ? ': ' + wrongCounts.join(', ') : ''));

let hugePatched = true;
const hugeWrong = [];
for (const [size, codes] of Object.entries(CODES)) for (const code of codes.slice(0, 4)) {
  const city = loadCity(code, HUGE_RADIUS);
  hugePatched &&= city.patched;
  if (distinctDistricts(readDistricts(city.run).grid) !== EXPECTED[size]) hugeWrong.push(code);
}
ok(hugePatched && hugeWrong.length === 0, 'count holds when every centre fails' + (hugePatched ? '' : ' (patch not applied)') + (hugeWrong.length ? ': ' + hugeWrong.join(', ') : ''));

const unstable = [];
for (const codes of Object.values(CODES)) for (const code of codes.slice(0, 2)) {
  const again = readDistricts(loadCity(code).run), first = loaded[code].districts;
  if (again.grid.join() !== first.grid.join() || again.portSide !== first.portSide) unstable.push(code);
}
const distinctP = new Set(CODES.P.map(code => loaded[code].districts.grid.join())).size;
ok(unstable.length === 0 && distinctP === CODES.P.length, `determinism (${distinctP}/${CODES.P.length} distinct P maps)` + (unstable.length ? ': unstable ' + unstable.join(', ') : ''));

const shortSidePorts = CODES.M.filter(code => { const side = loaded[code].districts.portSide; return side >= 0 && side !== 1 && side !== 3; });
ok(shortSidePorts.length === 0, 'M port only on long sides' + (shortSidePorts.length ? ': ' + shortSidePorts.join(', ') : ''));

const sharesBySize = { P: [], M: [], G: [] }, broken = [];
for (const [code, { size, districts }] of Object.entries(loaded)) {
  const [mapW, mapH] = MAP_SIZES[size];
  const inner = (bx, by) => (bx + 0.5) * PERIOD > MARGIN && (bx + 0.5) * PERIOD < mapW - MARGIN && (by + 0.5) * PERIOD > MARGIN && (by + 0.5) * PERIOD < mapH - MARGIN;
  let innerCells = 0;
  for (let by = 0; by < districts.rows; by++) for (let bx = 0; bx < districts.cols; bx++) if (inner(bx, by)) innerCells++;
  for (const centre of districts.centres) {
    if (centre.id === PORT) continue;
    if (!floodCovers(districts, centre.id, centre)) broken.push(`${code}#${centre.id}`);
    let cells = 0;
    districts.grid.forEach((d, cell) => { if (d === centre.id && inner(cell % districts.cols, Math.floor(cell / districts.cols))) cells++; });
    sharesBySize[size].push(cells / innerCells);
  }
}
const meanP = sharesBySize.P.reduce((sum, s) => sum + s, 0) / sharesBySize.P.length;
const outOfRange = [...sharesBySize.P, ...sharesBySize.G].filter(s => s < 0.04 || s > 0.25);
const describe = shares => shares.length ? `${Math.min(...shares).toFixed(3)}-${Math.max(...shares).toFixed(3)}` : 'none';
ok(broken.length === 0 && meanP >= 0.12 && meanP <= 0.20 && outOfRange.length === 0,
  `inland blob contiguous and sized (P mean ${meanP.toFixed(3)}, P ${describe(sharesBySize.P)}, M ${describe(sharesBySize.M)}, G ${describe(sharesBySize.G)})` + (broken.length ? ': split ' + broken.join(', ') : ''));

const islandOverlaps = [];
for (const [code, { districts }] of Object.entries(loaded)) {
  const { island } = districts;
  if (!island) continue;
  districts.grid.forEach((d, cell) => {
    const bx = cell % districts.cols, by = Math.floor(cell / districts.cols);
    if (d !== MIXED && bx * PERIOD <= island.x1 && bx * PERIOD + PERIOD - 1 >= island.x0 && by * PERIOD <= island.y1 && by * PERIOD + PERIOD - 1 >= island.y0) islandOverlaps.push(`${code}@${bx},${by}`);
  });
}
ok(islandOverlaps.length === 0, 'no district cell overlaps the army island' + (islandOverlaps.length ? ': ' + islandOverlaps.slice(0, 5).join(', ') : ''));

const RAIL_TILES = 'Array.from(grid).map((t, i) => railCentrelineDistance((i % MAP_W + 0.5) * T, (Math.floor(i / MAP_W) + 0.5) * T) <= 1.5 * T ? t : -1).join()';
const ISLAND_TILES = '(() => { if (!armyZone) return ""; const { x0, y0, x1, y1 } = armyZone.island, out = []; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(grid[gi(x, y)]); return out.join(); })()';
let plainPatched = true;
const railDiffers = [];
for (const codes of Object.values(CODES)) for (const code of codes.slice(0, 2)) {
  const plain = loadCity(code, NO_DISTRICTS), city = loaded[code];
  plainPatched &&= plain.patched;
  if (plain.run('JSON.stringify(armyZone)') !== city.run('JSON.stringify(armyZone)')
    || plain.run(RAIL_TILES) !== city.run(RAIL_TILES)
    || plain.run(ISLAND_TILES) !== city.run(ISLAND_TILES)) railDiffers.push(code);
}
ok(plainPatched && railDiffers.length === 0, 'rail corridor and army island identical without districts' + (plainPatched ? '' : ' (patch not applied)') + (railDiffers.length ? ': ' + railDiffers.join(', ') : ''));

const kindMismatch = Object.entries(loaded).filter(([, { run }]) => run('bldgs.every(b => { const d = districtAt(Math.floor(((b.x0 + b.x1) >> 1) / PERIOD), Math.floor(((b.y0 + b.y1) >> 1) / PERIOD)); return d === MIXED || b.kind === DISTRICT_KINDS[d]; })') !== true).map(([code]) => code);
ok(kindMismatch.length === 0, 'blockKind follows districts' + (kindMismatch.length ? ': ' + kindMismatch.join(', ') : ''));

const PLAZA_CAT = 2, PARK_CAT = 1;
const plazas = [];
let residentialCells = 0, residentialParks = 0;
for (const [code, { districts, cats }] of Object.entries(loaded)) districts.grid.forEach((d, cell) => {
  const { cat, rail } = cats[cell];
  if (rail) return;
  if ((d === INDUSTRIAL || d === PORT) && cat === PLAZA_CAT) plazas.push(`${code}@${cell}`);
  if (d === RESIDENTIAL) { residentialCells++; if (cat === PARK_CAT) residentialParks++; }
});
ok(plazas.length === 0, 'no plazas in industrial or port cells' + (plazas.length ? ': ' + plazas.slice(0, 5).join(', ') : ''));
const parkShare = residentialParks / residentialCells;
ok(parkShare >= 0.27, `residential parks about 1/3 (${residentialParks}/${residentialCells} = ${parkShare.toFixed(3)})`);

const LATE_PORT = s => s.replace('const id = pending.shift(), candidates = listCandidates();', 'const id = pending.shift(), candidates = districtCentres.length && portSide < 0 ? [] : listCandidates();');
let latePatched = true, latePorts = 0;
const lateWrong = [];
for (const size of ['P', 'M']) for (const code of CODES[size]) {
  const city = loadCity(code, LATE_PORT);
  latePatched &&= city.patched;
  const districts = readDistricts(city.run);
  if (districts.portSide >= 0 && loaded[code].districts.portSide < 0) latePorts++;
  const inBand = city.run('districtCentres.some(c => c.id !== PORT && inPortBand(c.bx, c.by))');
  if (inBand || distinctDistricts(districts.grid) !== EXPECTED[size]) lateWrong.push(code);
}
ok(latePatched && latePorts >= 3 && lateWrong.length === 0, `late port keeps inland centres out of the band (${latePorts} late ports)` + (latePatched ? '' : ' (patch not applied)') + (lateWrong.length ? ': ' + lateWrong.join(', ') : ''));

console.log('2) porto');
const K = loaded.PDST00.run('({ ROAD, SIDEWALK, WATER, SAND, QUAY, PROP, PORT_STRIP })');
const STRIP = '(() => { const len = portSide % 2 ? MAP_H : MAP_W, rows = []; for (let s = 0; s < len; s++) { const row = []; for (let d = 0; d <= PORT_STRIP + 1; d++) { const [x, y] = [[s, d], [MAP_W - 1 - d, s], [s, MAP_H - 1 - d], [d, s]][portSide]; row.push(grid[gi(x, y)]); } rows.push(row); } return rows; })()';
const toSideDepth = (x, y, side, mapW, mapH) => [[x, y], [y, mapW - 1 - x], [x, mapH - 1 - y], [y, x]][side];
const portCodes = Object.keys(loaded).filter(code => loaded[code].districts.portSide >= 0);
const portP = portCodes.filter(code => code.startsWith('P')).length;
const bandWrong = [], harbourWrong = [], roadWater = [], propWrong = [], harbourShares = [];
for (const code of portCodes) {
  const { run, size } = loaded[code], strip = run(STRIP), len = strip.length, [mapW, mapH] = MAP_SIZES[size];
  const side = run('portSide'), harbourFirst = run('portHarbourFirst');
  for (let s = 6; s <= len - 7; s++) {
    const [d0, d1, d2, d3, d4, d5] = strip[s];
    if (![d0, d1, d2].every(t => t === K.WATER) || ![K.SAND, K.QUAY, K.PROP].includes(d3) || ![K.QUAY, K.PROP].includes(d4) || d5 !== K.SIDEWALK) { bandWrong.push(`${code}@${s}`); break; }
  }
  const harbourLen = strip.filter(row => row[3] !== K.SAND).length, share = harbourLen / len;
  harbourShares.push(share);
  const harbourStart = harbourFirst ? 0 : len - harbourLen;
  const inHarbour = s => s >= harbourStart && s < harbourStart + harbourLen;
  if (share < 0.35 || share > 0.45 || strip.some((row, s) => inHarbour(s) && row[3] === K.SAND)) harbourWrong.push(code);
  strip.forEach((row, s) => row.forEach((t, d) => {
    if (t !== K.WATER || d > K.PORT_STRIP) return;
    const neighbours = [strip[s - 1]?.[d], strip[s + 1]?.[d], row[d - 1], row[d + 1]];
    if (neighbours.includes(K.ROAD)) roadWater.push(`${code}@${s},${d}`);
  }));
  const props = run('portProps.map(p => ({ ...p }))');
  for (const p of props) for (let y = p.y0; y <= p.y1; y++) for (let x = p.x0; x <= p.x1; x++) {
    const [s, d] = toSideDepth(x, y, side, mapW, mapH);
    if (strip[s][d] !== K.PROP || (d !== 3 && d !== 4) || !inHarbour(s)) propWrong.push(`${code}@${x},${y}`);
  }
  if (props.length < 2) propWrong.push(`${code}: ${props.length} props`);
}
ok(portP >= 3 && bandWrong.length === 0, `port band structure (${portCodes.length} port codes, ${portP} on P)` + (bandWrong.length ? ': ' + bandWrong.join(', ') : ''));
ok(harbourWrong.length === 0, `harbour about 40% (${describe(harbourShares)})` + (harbourWrong.length ? ': ' + harbourWrong.join(', ') : ''));
ok(roadWater.length === 0, 'no ROAD touching WATER on the port side' + (roadWater.length ? ': ' + roadWater.slice(0, 5).join(', ') : ''));
const solidKinds = loaded[portCodes[0]].run('(() => { const find = kind => { const i = grid.indexOf(kind); return solidTile(i % MAP_W, Math.floor(i / MAP_W)); }; return { prop: find(PROP), sand: find(SAND), quay: find(QUAY) }; })()');
ok(propWrong.length === 0 && solidKinds.prop === true && solidKinds.sand === false && solidKinds.quay === false,
  'props solid and on the quay' + (propWrong.length ? ': ' + propWrong.slice(0, 5).join(', ') : '') + ` (solidTile ${JSON.stringify(solidKinds)})`);

const missingLandmarks = Object.entries(loaded).filter(([, { run }]) => run("landmarks.filter(l => l.type !== 'army').length") !== 14).map(([code]) => code);
ok(missingLandmarks.length === 0, 'all landmarks placed' + (missingLandmarks.length ? ': ' + missingLandmarks.join(', ') : ''));

const { JS_DIR } = runtime;
const guardMisses = [];
let solidLineHasProp = false;
for (const file of fs.readdirSync(JS_DIR).filter(name => name.endsWith('.js'))) fs.readFileSync(path.join(JS_DIR, file), 'utf8').split('\n').forEach((line, index) => {
  if (/t === BUILDING \|\| t === TREE \|\| t === WATER/.test(line) && !line.includes('t === PROP')) guardMisses.push(`${file}:${index + 1}`);
  if (line.includes('const solidTile') && line.includes('t === PROP')) solidLineHasProp = true;
});
ok(guardMisses.length === 0 && solidLineHasProp, 'every inline solid check includes PROP' + (guardMisses.length ? ': ' + guardMisses.join(', ') : '') + (solidLineHasProp ? '' : ' (solidTile misses PROP)'));

const walkWrong = [];
for (const size of ['P', 'M', 'G']) {
  const code = portCodes.find(c => c.startsWith(size));
  if (!code) { walkWrong.push(`${size}: no port code`); continue; }
  const sim = runtime.createRoomSim(code), kinds = sim._tileKinds(), { run } = loaded[code];
  const quay = run('(() => { const len = portSide % 2 ? MAP_H : MAP_W; for (let s = len >> 1; s < len; s++) for (const k of [s, len - 1 - s]) { const [x, y] = [[k, 4], [MAP_W - 5, k], [k, MAP_H - 5], [4, k]][portSide]; if (grid[gi(x, y)] === QUAY) return { x: (x + 0.5) * T, y: (y + 0.5) * T }; } })()');
  const tileOf = (x, y) => sim._tileAt(Math.floor(x / 32), Math.floor(y / 32));
  let softLanding = false;
  for (let k = 0; k < 300; k++) {
    const spot = sim._randomWalkNear(quay.x, quay.y, 0, 400);
    if (!spot) continue;
    const t = sim._tileAt(spot.tx, spot.ty);
    if (t === kinds.WATER || t === kinds.PROP) walkWrong.push(`${code}: walk spot on ${t}`);
    if (t === kinds.SAND || t === kinds.QUAY) softLanding = true;
  }
  if (!softLanding) walkWrong.push(`${code}: never on sand or quay`);
  const id = sim.addPlayer('Tester', 0, 'p1'), player = sim._player(id);
  player.x = quay.x; player.y = quay.y;
  for (let f = 0; f < 600; f++) sim.tick();
  for (const p of sim._peds()) { const t = tileOf(p.x, p.y); if (t === kinds.WATER || t === kinds.PROP) walkWrong.push(`${code}: ped on ${t}`); }
  for (const c of sim._cars()) {
    const t = tileOf(c.x, c.y);
    if (t === kinds.WATER || t === kinds.PROP || (c.role === 'traffic' && (t === kinds.SAND || t === kinds.QUAY))) walkWrong.push(`${code}: ${c.role} car on ${t}`);
  }
}
ok(walkWrong.length === 0, 'peds accept sand and quay, never sea or props' + (walkWrong.length ? ': ' + [...new Set(walkWrong)].slice(0, 6).join(', ') : ''));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
