import fs from 'node:fs';
import path from 'node:path';

const JS_DIR = path.join(import.meta.dirname, '..', 'js');
const readSource = file => fs.readFileSync(path.join(JS_DIR, file), 'utf8').replace(/\r\n/g, '\n');
const SOURCES = { core: readSource('core.js'), city: readSource('city.js'), render: readSource('render.js') };

function extractTopLevel(source, name) {
  const start = source.search(new RegExp(`^(function ${name}\\(|const ${name}\\b)`, 'm'));
  if (start < 0) throw new Error(`declaration not found: ${name}`);
  const firstLineEnd = source.indexOf('\n', start);
  if (/;\s*(\/\/.*)?$/.test(source.slice(start, firstLineEnd)) && !source.slice(start, firstLineEnd).startsWith('function')) {
    return source.slice(start, firstLineEnd);
  }
  const close = source.slice(start).search(/^};?\s*$/m);
  return source.slice(start, start + close + 2);
}

const DECLARATIONS = [
  ['core', 'TAU'], ['city', 'T'], ['city', 'hash2'], ['city', 'ROOF_COLS'], ['city', 'AWNING_COLS'],
  ['render', 'shade'], ['render', 'SHADOW_LENGTH_PER_LIFT'], ['render', 'WINDOW_TONES'], ['render', 'WALL_LAYOUT'],
  ['render', 'tracePolygon'], ['render', 'fillPolygon'], ['render', 'buildingShadowPolygon'], ['render', 'hipRoofPlanes'],
  ['render', 'drawBuildingShadows'], ['render', 'windowTone'], ['render', 'drawBuildingWalls'], ['render', 'drawParapet'],
  ['render', 'drawRoofWeathering'], ['render', 'drawRoofBox'], ['render', 'drawHipRoof'], ['render', 'drawBuildings'],
  ['render', 'drawFacade'],
];
const moduleSource = DECLARATIONS.map(([file, name]) => extractTopLevel(SOURCES[file], name)).join('\n');

function createRecordingContext() {
  const calls = [];
  const state = {};
  const gradient = { addColorStop: (...args) => calls.push(['addColorStop', args]) };
  const context = new Proxy(state, {
    get: (target, property) => property in target ? target[property]
      : (...args) => { calls.push([property, args]); return gradient; },
    set: (target, property, value) => { target[property] = value; calls.push(['set:' + String(property), [value]]); return true; },
  });
  return { context, calls };
}

const loadRenderer = new Function('ctx', 'bldgs', 'camX', 'camY', 'vw', 'vh', 'frame',
  `${moduleSource}\nreturn { buildingShadowPolygon, hipRoofPlanes, drawBuildings, drawBuildingShadows };`);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };
const polygonArea = points => Math.abs(points.reduce((sum, [x, y], i) => {
  const [nx, ny] = points[(i + 1) % points.length];
  return sum + x * ny - nx * y;
}, 0)) / 2;

const STYLE_LIFTS = { house: 7, apartment: 15, shop: 9, tower: 24, warehouse: 9, workshop: 8 };
const SIZES = [[0, 0], [1, 0], [0, 2], [3, 2], [5, 4], [2, 6]];
const buildings = [];
let seed = 1;
for (const [style, lift] of Object.entries(STYLE_LIFTS)) for (const [extraX, extraY] of SIZES) {
  const x0 = 2 + buildings.length * 8, y0 = 3;
  for (const face of [-1, 0, 1, 2, 3]) {
    buildings.push({ x0, y0, x1: x0 + extraX, y1: y0 + extraY, style, lift, face, col: '#7d5b46', h: seed++ * 2654435761 >>> 0 });
  }
}

const recorder = createRecordingContext();
const renderer = loadRenderer(recorder.context, buildings, 0, 0, 100000, 100000, 0);

console.log('1) ombra proiettata');
const shadow = renderer.buildingShadowPolygon(10, 20, 64, 32, 12);
ok(shadow.length === 6, 'poligono a 6 vertici');
ok(shadow.some(([x, y]) => x === 10 + 64 + 12 && y === 20 + 32 + 12), 'angolo sud-est spostato di length verso sud-est');
ok(polygonArea(shadow) === 64 * 32 + 12 * (64 + 32), 'area = impronta + scia della lunghezza dell\'ombra');

console.log('2) tetto a padiglione');
for (const [w, h] of [[64, 32], [32, 80], [40, 40], [25, 57]]) {
  const planes = renderer.hipRoofPlanes(5, 7, w, h);
  const area = Object.values(planes).reduce((sum, plane) => sum + polygonArea(plane), 0);
  const inside = Object.values(planes).flat().every(([x, y]) => x >= 5 && x <= 5 + w && y >= 7 && y <= 7 + h);
  ok(Math.abs(area - w * h) < 1e-9 && inside, `${w}x${h}: le 4 falde coprono esattamente il tetto`);
}

console.log('3) disegno di tutti gli stili e lati, ctx registratore');
let threw = null;
try { renderer.drawBuildingShadows(); renderer.drawBuildings(); } catch (error) { threw = error; }
ok(!threw, 'nessuna eccezione' + (threw ? ': ' + threw.message : ''));
const badCall = recorder.calls.find(([, args]) => args.some(arg => typeof arg === 'number' && !Number.isFinite(arg)));
ok(!badCall, 'nessuna coordinata NaN/Infinity' + (badCall ? ': ' + badCall[0] : ''));
ok(recorder.calls.some(([name, args]) => name === 'clip' && args[0] === 'evenodd'), 'ombre ritagliate fuori dalle impronte (evenodd)');
const saves = recorder.calls.filter(([name]) => name === 'save').length;
ok(saves > 0 && saves === recorder.calls.filter(([name]) => name === 'restore').length, 'save/restore bilanciati');
ok(recorder.calls.filter(([name]) => name === 'fill').length >= buildings.length * 2, 'ogni edificio riempie almeno le due facciate');

console.log(`\n${pass} ok, ${fail} falliti`);
process.exit(fail ? 1 : 0);
