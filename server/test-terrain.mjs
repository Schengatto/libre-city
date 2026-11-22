import { readSource, extractTopLevel, createRecordingContext } from './render-test-kit.mjs';

const SOURCES = { core: readSource('core.js'), city: readSource('city.js'), render: readSource('render.js') };
const DECLARATIONS = [
  ['core', 'TAU'], ['city', 'T'], ['city', 'hash2'], ['city', 'ROAD'], ['city', 'RES_KIND'], ['city', 'BUILD_CAT'],
  ['render', 'shade'], ['render', 'tracePolygon'], ['render', 'fillPolygon'], ['render', 'roundRect'],
  ['render', 'GRASS_DARK'], ['render', 'FLOWER_COLS'], ['render', 'BROADLEAF_PALETTES'], ['render', 'BLOSSOM_PALETTES'],
  ['render', 'CONIFER_PALETTE'], ['render', 'WATER_SIDES'], ['render', 'SOFT_SHORES'],
  ['render', 'tileRandom'], ['render', 'smoothNoise'], ['render', 'grassColor'], ['render', 'drawGrass'],
  ['render', 'drawPavingSlabs'], ['render', 'drawAsphaltGrain'], ['render', 'edgeBand'], ['render', 'fadeFromEdge'],
  ['render', 'drawWaterTile'], ['render', 'treeInPlanter'], ['render', 'drawPlanter'], ['render', 'drawTreeShadow'],
  ['render', 'canopyLobes'], ['render', 'fillLobes'], ['render', 'drawBroadleaf'], ['render', 'drawConifer'],
  ['render', 'drawTreeOnTile'], ['render', 'drawTrees'],
  ['render', 'GLASS_COLOR'], ['render', 'BRAKE_DECELERATION'], ['render', 'drawVehicleShadow'], ['render', 'bodyPaint'],
  ['render', 'drawTyres'], ['render', 'drawGlassGlint'], ['render', 'drawSaloonCabin'], ['render', 'drawVanCabin'],
  ['render', 'drawCarLights'],
];
const moduleSource = DECLARATIONS.map(([file, name]) => extractTopLevel(SOURCES[file], name)).join('\n');
const EXPORTS = ['T', 'GRASS', 'TREE', 'WATER', 'SIDEWALK', 'GRASS_DARK', 'GRASS_LIGHT', 'PARK_CAT', 'PLAZA_CAT',
  'tileRandom', 'smoothNoise', 'grassColor', 'drawGrass', 'drawWaterTile', 'drawTrees', 'drawPavingSlabs', 'drawAsphaltGrain',
  'drawVehicleShadow', 'bodyPaint', 'drawSaloonCabin', 'drawVanCabin', 'drawCarLights'];
const loadRenderer = new Function('ctx', 'camX', 'camY', 'frame', 'MAP_W', 'MAP_H', 'grid', 'PERIOD', 'blockCat', 'blockKind',
  `const gi = (x, y) => y * MAP_W + x;
   const tileAt = (x, y) => x < 0 || y < 0 || x >= MAP_W || y >= MAP_H ? GRASS : grid[gi(x, y)];
   ${moduleSource}
   return { ${EXPORTS.join(', ')} };`);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };
const hasBadNumber = calls => calls.some(([, args]) => args.some(arg => typeof arg === 'number' && !Number.isFinite(arg)));
const fillStyles = calls => calls.filter(([name]) => name === 'set:fillStyle').map(([, [value]]) => value);

const MAP_SIZE = 8;
function createRenderer(tileTypes, cat = 1) {
  const recorder = createRecordingContext();
  const probe = loadRenderer(createRecordingContext().context, 0, 0, 0, MAP_SIZE, MAP_SIZE, [], 16, () => cat, () => 0);
  const grid = Array.from({ length: MAP_SIZE * MAP_SIZE }, (_, i) => tileTypes(i % MAP_SIZE, Math.floor(i / MAP_SIZE), probe));
  return { recorder, renderer: loadRenderer(recorder.context, 0, 0, 0, MAP_SIZE, MAP_SIZE, grid, 16, () => cat, () => 0) };
}

console.log('1) casualità per tile deterministica');
{
  const { renderer } = createRenderer(() => 3);
  const first = renderer.tileRandom(12345), second = renderer.tileRandom(12345), other = renderer.tileRandom(54321);
  const firstValues = Array.from({ length: 50 }, first), secondValues = Array.from({ length: 50 }, second);
  ok(firstValues.every((value, i) => value === secondValues[i]), 'stesso seme, stessa sequenza');
  ok(firstValues.every(value => value >= 0 && value < 1), 'valori in [0, 1)');
  ok(other() !== firstValues[0], 'semi diversi, sequenze diverse');
}

console.log('2) rumore morbido dell\'erba');
{
  const { renderer } = createRenderer(() => 3);
  let inRange = true, maxStep = 0;
  for (let x = 0; x < 40; x += 0.37) for (let y = 0; y < 40; y += 1.3) {
    const value = renderer.smoothNoise(x, y);
    if (value < 0 || value > 1) inRange = false;
    maxStep = Math.max(maxStep, Math.abs(renderer.smoothNoise(x + 0.01, y) - value));
  }
  ok(inRange, 'rumore sempre in [0, 1]');
  ok(maxStep < 0.05, `rumore continuo (salto massimo ${maxStep.toFixed(4)})`);
  const channels = renderer.grassColor(13.5, 7).match(/^rgb\((\d+),(\d+),(\d+)\)$/).slice(1).map(Number);
  ok(channels.every((value, i) => value >= renderer.GRASS_DARK[i] && value <= renderer.GRASS_LIGHT[i]), 'colore erba fra scuro e chiaro');
}

console.log('3) alberi oltre il bordo del chunk');
{
  const atEdge = createRenderer((x, y, r) => x === 1 && y === 1 ? r.TREE : r.GRASS);
  atEdge.renderer.drawTrees(2, 2, 5, 5);
  ok(atEdge.recorder.calls.some(([name]) => name === 'fill'), 'albero a una tile dal bordo disegnato (chioma che sconfina)');
  ok(!hasBadNumber(atEdge.recorder.calls), 'nessuna coordinata NaN/Infinity');
  const farAway = createRenderer((x, y, r) => x === 0 && y === 0 ? r.TREE : r.GRASS);
  farAway.renderer.drawTrees(2, 2, 5, 5);
  ok(!farAway.recorder.calls.some(([name]) => name === 'fill'), 'albero a due tile dal bordo ignorato');
  const park = createRenderer((x, y, r) => (x + y) % 2 ? r.TREE : r.GRASS);
  park.renderer.drawTrees(0, 0, MAP_SIZE - 1, MAP_SIZE - 1);
  const used = new Set(fillStyles(park.recorder.calls));
  ok(used.size >= 6, `chiome con varietà di toni (${used.size} colori)`);
}

console.log('4) acqua: bordo in pietra verso il selciato, schiuma verso il prato');
{
  const pool = createRenderer((x, y, r) => x === 3 && y === 3 ? r.WATER : x === 4 && y === 3 ? r.SIDEWALK : r.GRASS);
  pool.renderer.drawWaterTile(0, 0, 3, 3);
  const styles = fillStyles(pool.recorder.calls);
  ok(styles.includes('#b4b9c0'), 'bordo in pietra lato marciapiede');
  ok(styles.includes('rgba(230,245,250,.45)'), 'schiuma lato prato');
  ok(pool.recorder.calls.filter(([name]) => name === 'createLinearGradient').length === 4 + 2, 'acqua bassa su 4 lati, ombra della riva solo a nord e ovest');
}

console.log('5) lastre, grana dell\'asfalto, erba: niente NaN');
{
  const { recorder, renderer } = createRenderer(() => 3);
  for (let x = 0; x < 6; x++) { renderer.drawGrass(x * 32, 0, x, 2); renderer.drawPavingSlabs(x * 32, 32, x, 3); renderer.drawAsphaltGrain(x * 32, 64, x, 4); }
  ok(!hasBadNumber(recorder.calls), 'nessuna coordinata NaN/Infinity');
}

console.log('6) auto: ombra ruotata, luce da nord-ovest, luci di stop');
{
  const { recorder, renderer } = createRenderer(() => 3);
  renderer.drawVehicleShadow(100, 50, 1.2, 23, 12, 6);
  ok(recorder.calls.some(([name, args]) => name === 'rotate' && args[0] === 1.2), 'ombra ruotata con l\'auto');
  for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7]) {
    recorder.calls.length = 0;
    renderer.bodyPaint('#3a72d2', angle, 23, 12);
    const [startX, startY] = recorder.calls.find(([name]) => name === 'createLinearGradient')[1];
    const worldX = startX * Math.cos(angle) - startY * Math.sin(angle), worldY = startX * Math.sin(angle) + startY * Math.cos(angle);
    ok(worldX < 0 && worldY < 0, `angolo ${angle.toFixed(2)}: lato chiaro verso nord-ovest`);
  }
  const brakeColor = car => {
    recorder.calls.length = 0;
    renderer.drawCarLights(car, 23, 12);
    return fillStyles(recorder.calls).at(-1);
  };
  ok(brakeColor({ role: 'parked', speed: 0 }) === '#9a1a1e', 'auto parcheggiata vuota: stop spenti');
  ok(brakeColor({ role: 'traffic', speed: 2.5, lastDrawnSpeed: 3 }) === '#ff4a3a', 'auto che frena: stop accesi');
  ok(brakeColor({ role: 'traffic', speed: 3, lastDrawnSpeed: 2.98 }) === '#9a1a1e', 'auto che accelera: stop spenti');
  ok(brakeColor({ role: 'traffic', speed: 0 }) === '#ff4a3a', 'auto ferma con conducente: stop accesi');
  const car = { role: 'traffic', speed: 2 };
  brakeColor(car);
  ok(car.lastDrawnSpeed === 2, 'velocità memorizzata per il fotogramma dopo');
  recorder.calls.length = 0;
  renderer.drawSaloonCabin({ w: 46, h: 24, color: '#d23a3a' }, 23, 12, '#20407a');
  renderer.drawVanCabin({ w: 54, h: 26, color: '#c22822' }, 27, 13);
  ok(!hasBadNumber(recorder.calls), 'abitacoli senza NaN');
}

console.log(`\n${pass} ok, ${fail} falliti`);
process.exit(fail ? 1 : 0);
