import fs from 'node:fs';
import path from 'node:path';
import { readSource, extractTopLevel, createRecordingContext } from './render-test-kit.mjs';

const SOURCES = { core: readSource('core.js'), city: readSource('city.js'), render: readSource('render.js') };

const DECLARATIONS = [
  ['core', 'TAU'], ['city', 'T'], ['city', 'hash2'], ['city', 'ROOF_COLS'], ['city', 'AWNING_COLS'],
  ['render', 'shade'], ['render', 'SHADOW_LENGTH_PER_LIFT'], ['render', 'WINDOW_TONES'], ['render', 'WALL_LAYOUT'],
  ['render', 'tracePolygon'], ['render', 'fillPolygon'], ['render', 'buildingShadowPolygon'], ['render', 'hipRoofPlanes'],
  ['render', 'drawBuildingShadows'], ['render', 'windowTone'], ['render', 'drawBuildingWalls'],
  ['render', 'pitchedRoofPlanes'], ['render', 'drawHouseRoof'], ['render', 'southRoofZone'], ['render', 'buildingRoofColor'], ['render', 'drawBuildings'],
  ['render', 'drawFacade'],
  ['render', 'tileRandom'], ['render', 'buildingRandom'], ['render', 'rectsOverlap'], ['render', 'MATERIAL_TILE'],
  ['render', 'materialPatterns'], ['render', 'MATERIAL_PAINTERS'], ['render', 'materialPattern'], ['render', 'drawRoofSurface'],
  ['render', 'planRoofProps'], ['render', 'drawPropBox'], ['render', 'drawRoundPropShadow'], ['render', 'drawRoofProp'],
  ['render', 'MATERIAL_TONES'], ['render', 'STYLE_ROOF'], ['render', 'volumeRoof'], ['render', 'planVolumes'], ['render', 'planBuilding'],
  ['render', 'drawCornice'], ['render', 'drawVolume'], ['render', 'drawVolumeShadow'], ['render', 'drawPlannedBuilding'],
  ['render', 'WORLD_CHUNK'], ['render', 'transposedPainter'], ['render', 'planRoofShape'], ['render', 'sawtoothTeeth'],
  ['render', 'drawSawtoothRoof'], ['render', 'ROOF_PLANE_TONES'], ['render', 'gableRoofPlanes'], ['render', 'axisFiller'],
  ['render', 'drawRoofEdge'], ['render', 'drawMetalRoof'], ['render', 'FACADE_MATERIALS'],
  ['city', 'MIXED'],
];
const moduleSource = DECLARATIONS.map(([file, name]) => extractTopLevel(SOURCES[file], name)).join('\n');

const loadRenderer = new Function('ctx', 'bldgs', 'camX', 'camY', 'vw', 'vh', 'frame', 'document',
  `${moduleSource}\nreturn { buildingShadowPolygon, hipRoofPlanes, drawBuildings, drawBuildingShadows, buildingRandom, rectsOverlap,
    MATERIAL_TILE, WORLD_CHUNK, materialPattern, planRoofProps, planBuilding, volumeRoof, STYLE_ROOF, sawtoothTeeth, gableRoofPlanes, drawBuildingWalls, FACADE_MATERIALS, drawRoofProp, INDUSTRIAL };`);
const createdCanvases = [];
const documentStub = {
  createElement: tag => {
    const canvas = { tag, width: 0, height: 0, getContext: () => createRecordingContext().context };
    createdCanvases.push(canvas);
    return canvas;
  },
};

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
const renderer = loadRenderer(recorder.context, buildings, 0, 0, 100000, 100000, 0, documentStub);

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

for (const [w, h] of [[64, 32], [32, 80], [40, 40], [25, 57]]) {
  const planes = renderer.gableRoofPlanes(5, 7, w, h);
  const area = polygonArea(planes.a) + polygonArea(planes.b);
  const inside = [...planes.a, ...planes.b, ...planes.ridge].every(([x, y]) => x >= 5 && x <= 5 + w && y >= 7 && y <= 7 + h);
  const [[x1, y1], [x2, y2]] = planes.ridge;
  const ridgeAlongLongSide = w >= h ? y1 === y2 && Math.abs(x2 - x1) === w : x1 === x2 && Math.abs(y2 - y1) === h;
  ok(Math.abs(area - w * h) < 1e-9 && inside && ridgeAlongLongSide, `${w}x${h}: capanna, 2 falde = w*h, colmo sul lato lungo`);
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

console.log('4) primitive');
const firstRun = renderer.buildingRandom(42), secondRun = renderer.buildingRandom(42);
const firstValues = Array.from({ length: 5 }, firstRun), secondValues = Array.from({ length: 5 }, secondRun);
ok(JSON.stringify(firstValues) === JSON.stringify(secondValues) && firstValues.every(value => value >= 0 && value < 1),
  'buildingRandom(42): stessa sequenza in [0,1)');
ok(renderer.rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 }) === false, 'rect a contatto sul bordo: nessun overlap');
ok(renderer.rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 0, w: 5, h: 5 }) === true, 'rect sovrapposti di 1 px: overlap');
const canvasesBefore = createdCanvases.length;
const gravelPattern = renderer.materialPattern('gravel');
ok(gravelPattern === renderer.materialPattern('gravel'), 'pattern in cache: stesso oggetto');
for (const name of ['tar', 'metal', 'tilesH', 'tilesV', 'brick', 'panel']) { renderer.materialPattern(name); renderer.materialPattern(name); }
ok(createdCanvases.length - canvasesBefore <= 7 && createdCanvases.every(canvas => canvas.tag === 'canvas'), 'un solo canvas creato per materiale');
ok(renderer.WORLD_CHUNK % renderer.MATERIAL_TILE === 0, 'WORLD_CHUNK multiplo di MATERIAL_TILE (pattern continui fra chunk)');
const insideWithMargin = (prop, roof) => prop.x >= roof.x + 3 && prop.y >= roof.y + 3
  && prop.x + prop.w <= roof.x + roof.w - 3 && prop.y + prop.h <= roof.y + roof.h - 3 && prop.w > 0 && prop.h > 0;
const anyOverlap = rects => rects.some((a, i) => rects.some((c, j) => j > i && renderer.rectsOverlap(a, c)));
const testPool = [
  { type: 'hvac', w: [8, 14], h: [6, 10], height: 4 }, { type: 'vent', w: [4, 6], h: [4, 6], height: 3 },
  { type: 'tank', w: [10, 14], h: [10, 14], height: 9 }, { type: 'stairHut', w: [12, 16], h: [12, 16], height: 8 },
];
const testRoof = { x: 0, y: 0, w: 120, h: 90 }, testReserved = [{ x: 40, y: 30, w: 30, h: 30 }];
const plannedProps = renderer.planRoofProps(renderer.buildingRandom(7), testRoof, testPool, 8, testReserved);
ok(plannedProps.length > 0 && plannedProps.every(prop => insideWithMargin(prop, testRoof)), `planRoofProps: ${plannedProps.length} oggetti dentro il tetto con margine 3`);
ok(!anyOverlap(plannedProps) && !plannedProps.some(prop => renderer.rectsOverlap(prop, testReserved[0])), 'planRoofProps: nessun overlap fra oggetti né con reserved');
let tinyProps = null;
try { tinyProps = renderer.planRoofProps(renderer.buildingRandom(7), { x: 0, y: 0, w: 10, h: 10 }, testPool, 8, []); } catch {}
ok(Array.isArray(tinyProps) && tinyProps.length === 0, 'planRoofProps su tetto 10x10: [] senza eccezioni');
const declarationPattern = /^(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
const declaredIn = new Map();
const indexHtml = fs.readFileSync(path.join(import.meta.dirname, '..', 'index.html'), 'utf8');
const browserScripts = [...indexHtml.matchAll(/<script src="js\/([\w-]+\.js)">/g)].map(match => match[1]);
for (const file of browserScripts) {
  for (const match of readSource(file).matchAll(declarationPattern)) {
    if (!declaredIn.has(match[1])) declaredIn.set(match[1], []);
    declaredIn.get(match[1]).push(file);
  }
}
const duplicates = [...declaredIn].filter(([, files]) => files.length > 1).map(([name, files]) => `${name} (${files.join(', ')})`);
ok(browserScripts.includes('render.js') && duplicates.length === 0, `nomi top-level unici nei ${browserScripts.length} script js/ caricati da index.html` +(duplicates.length ? ': ' + duplicates.join('; ') : ''));

console.log('5) pianificatore');
const plannerSamples = [];
for (const [style, lift] of Object.entries(STYLE_LIFTS)) for (const [extraX, extraY] of SIZES) for (let sample = 0; sample < 6; sample++) {
  const h = (sample + 1) * 2246822519 + extraX * 3266489917 + extraY * 668265263 + lift >>> 0;
  const storeyVariation = style === 'apartment' || style === 'tower' ? sample % 3 * 4 : 0;
  plannerSamples.push({ x0: 0, y0: 0, x1: extraX, y1: extraY, style, lift: lift - storeyVariation, face: 0, col: '#7d5b46', h });
}
for (const style of Object.keys(STYLE_LIFTS)) plannerSamples.push({ x0: 0, y0: 0, x1: 0, y1: 0, style, lift: 24, face: 0, col: '#7d5b46', h: 99 });
const planProblems = [];
for (const b of plannerSamples) {
  const W = (b.x1 - b.x0 + 1) * 32, H = (b.y1 - b.y0 + 1) * 32;
  const plan = renderer.planBuilding(b, W, H), { volumes, props } = plan;
  const tag = `${b.style} ${W}x${H} lift ${b.lift} h ${b.h}`;
  const base = volumes[0];
  if (base.x !== 0 || base.y !== 0 || base.w !== W || base.h !== H || base.parent !== -1) planProblems.push(`${tag}: volumes[0] non è l'impronta`);
  if (Math.max(...volumes.map(volume => volume.lift)) !== b.lift) planProblems.push(`${tag}: max lift diverso da b.lift`);
  volumes.forEach((volume, index) => {
    const roof = renderer.volumeRoof(volumes, index);
    if (!(volume.w > 0 && volume.h > 0 && roof.w > 0 && roof.h > 0)) planProblems.push(`${tag}: volume ${index} con lato <= 0`);
    if (volume.parent >= 0) {
      const parent = volumes[volume.parent], parentRoof = renderer.volumeRoof(volumes, volume.parent);
      if (volume.parent >= index || volume.lift <= parent.lift) planProblems.push(`${tag}: volume ${index} lift/ordine non crescente`);
      if (volume.x < parentRoof.x || volume.y < parentRoof.y || volume.x + volume.w > parentRoof.x + parentRoof.w || volume.y + volume.h > parentRoof.y + parentRoof.h)
        planProblems.push(`${tag}: volume ${index} fuori dal tetto del padre`);
    }
    const ownProps = props.filter(prop => prop.volume === index);
    if (!ownProps.every(prop => insideWithMargin(prop, roof))) planProblems.push(`${tag}: oggetto fuori dal tetto del volume ${index}`);
    const children = volumes.filter(child => child.parent === index);
    if (anyOverlap(ownProps) || ownProps.some(prop => children.some(child => renderer.rectsOverlap(prop, child)))) planProblems.push(`${tag}: overlap sul volume ${index}`);
  });
  if (JSON.stringify(plan) !== JSON.stringify(renderer.planBuilding(b, W, H))) planProblems.push(`${tag}: non deterministico`);
  const roof = renderer.volumeRoof(volumes, 0);
  if ((b.style === 'apartment' || b.style === 'tower' || b.style === 'shop') && roof.w >= 64 && roof.h >= 64 && props.length < 3) planProblems.push(`${tag}: solo ${props.length} oggetti`);
  if (b.style === 'tower' && roof.w >= 64 && roof.h >= 64 && volumes.length < 2) planProblems.push(`${tag}: torre con un solo volume`);
}
ok(planProblems.length === 0, `${plannerSamples.length} piani validi` + (planProblems.length ? ': ' + planProblems.slice(0, 5).join('; ') : ''));
const capOverruns = plannerSamples.flatMap(b => {
  const { props } = renderer.planBuilding(b, (b.x1 + 1) * 32, (b.y1 + 1) * 32);
  const caps = {};
  for (const kind of renderer.STYLE_ROOF[b.style].pool) if (kind.max) caps[kind.type] = Math.max(caps[kind.type] || 0, kind.max);
  return Object.entries(caps).filter(([type, max]) => props.filter(prop => prop.type === type).length > max).map(([type]) => `${b.style} h ${b.h}: troppi ${type}`);
});
ok(capOverruns.length === 0, "max dei prop rispettato sull'intero edificio" + (capOverruns.length ? ': ' + capOverruns.slice(0, 5).join('; ') : ''));
const apartmentPlans = plannerSamples.filter(b => b.style === 'apartment').map(b => renderer.planBuilding(b, (b.x1 + 1) * 32, (b.y1 + 1) * 32));
const twoVolumeShare = apartmentPlans.filter(plan => plan.volumes.length === 2).length / apartmentPlans.length;
ok(twoVolumeShare >= 0.3, `apartment con due volumi: ${(twoVolumeShare * 100).toFixed(0)}% (>= 30%)`);
const signatures = new Set();
for (let k = 0; k < 20; k++) {
  const b = { x0: 0, y0: 0, x1: 3, y1: 4, style: 'apartment', lift: 15, face: 0, col: '#7d5b46', h: (k + 11) * 2654435761 >>> 0 };
  signatures.add(JSON.stringify(renderer.planBuilding(b, 128, 160).props.map(prop => [prop.type, prop.x, prop.y])));
}
ok(signatures.size >= 15, `20 apartment 4x5: ${signatures.size} firme distinte (>= 15)`);
const shapesOf = style => new Set(Array.from({ length: 20 }, (unused, k) =>
  renderer.planBuilding({ x0: 0, y0: 0, x1: 3, y1: 2, style, lift: STYLE_LIFTS[style], face: 0, col: '#7d5b46', h: (k + 3) * 2246822519 >>> 0 }, 128, 96).roofShape));
ok(['sawtooth', 'flat'].every(shape => shapesOf('workshop').has(shape)), '20 workshop: shed a dente di sega e lamiera piana');
ok(['hip', 'gable'].every(shape => shapesOf('house').has(shape)), '20 house: tetto a padiglione e a capanna');
const housePlans = plannerSamples.filter(b => b.style === 'house' && b.lift === STYLE_LIFTS.house).map(b => renderer.planBuilding(b, (b.x1 + 1) * 32, (b.y1 + 1) * 32));
const chimneyCounts = housePlans.map(plan => plan.props.filter(prop => prop.type === 'chimney').length);
ok(chimneyCounts.every(count => count >= 1 && count <= 2), `${housePlans.length} house: 1-2 camini (${chimneyCounts.join('')})`);
ok(housePlans.some(plan => plan.props.some(prop => prop.type === 'dormer')) && housePlans.some(plan => plan.props.some(prop => prop.type === 'solar')),
  'house: abbaini e pannelli solari sulla falda sud');

console.log('5b) comignolo solo nel distretto industriale');
{
  const smokestacksOf = b => renderer.planBuilding(b, (b.x1 + 1) * 32, (b.y1 + 1) * 32).props.filter(prop => prop.type === 'smokestack').length;
  const bigRoofSamples = plannerSamples.filter(b => (b.style === 'warehouse' || b.style === 'workshop') && (b.x1 + 1) * 32 - b.lift >= 64 && (b.y1 + 1) * 32 - b.lift >= 64);
  const wrongIndustrial = bigRoofSamples.filter(b => smokestacksOf({ ...b, district: renderer.INDUSTRIAL }) !== 1);
  ok(bigRoofSamples.length > 0 && wrongIndustrial.length === 0, `${bigRoofSamples.length} industriali con tetto >= 64x64: un solo smokestack` + (wrongIndustrial.length ? ` (${wrongIndustrial.length} sbagliati)` : ''));
  ok(plannerSamples.every(b => smokestacksOf(b) === 0), 'senza distretto nessuno smokestack');
  const stackRecorder = createRecordingContext();
  const stackRenderer = loadRenderer(stackRecorder.context, [], 0, 0, 100000, 100000, 0, documentStub);
  stackRenderer.drawRoofProp({ type: 'smokestack', x: 4, y: 4, w: 15, h: 15, height: 24 }, 10, 10);
  ok(stackRecorder.calls.some(([name]) => name === 'createRadialGradient') && !stackRecorder.calls.some(([, args]) => args.some(arg => typeof arg === 'number' && !Number.isFinite(arg))),
    'smokestack disegnato con gradiente e soli numeri finiti');
}

console.log('6) dente di sega');
for (const [w, h] of [[100, 40], [40, 100], [26, 26], [57, 25], [120, 33]]) {
  const teeth = renderer.sawtoothTeeth(w, h), across = Math.min(w, h);
  const contiguous = teeth.every((tooth, k) => k === 0 ? tooth.x === 0 && tooth.y === 0
    : w >= h ? tooth.y === teeth[k - 1].y + teeth[k - 1].h : tooth.x === teeth[k - 1].x + teeth[k - 1].w);
  const area = teeth.reduce((sum, tooth) => sum + tooth.w * tooth.h, 0);
  const pitchOk = teeth.every(tooth => Math.min(tooth.w, tooth.h) <= 16 && (w >= h ? tooth.w === w : tooth.h === h));
  ok(teeth.length >= Math.floor(across / 16) && contiguous && area === w * h && pitchOk,
    `${w}x${h}: ${teeth.length} denti paralleli al lato lungo, passo <= 16, copertura esatta`);
}

console.log('7) facciate');
for (const [style, lift] of Object.entries(STYLE_LIFTS)) {
  const start = recorder.calls.length;
  renderer.drawBuildingWalls({ style, lift, face: 0, col: '#7d5b46', h: 12345 }, 10, 10, 96, 64, lift);
  const facadeCalls = recorder.calls.slice(start);
  const patternFills = renderer.FACADE_MATERIALS[style].map(name => renderer.materialPattern(name));
  const usesPatterns = patternFills.every(pattern => facadeCalls.some(([name, args]) => name === 'set:fillStyle' && args[0] === pattern));
  const finite = facadeCalls.every(([, args]) => args.every(arg => typeof arg !== 'number' || Number.isFinite(arg)));
  ok(usesPatterns && finite, `${style}: facciate sud ed est con pattern ${renderer.FACADE_MATERIALS[style].join('/')}, nessun NaN`);
}

console.log(`\n${pass} ok, ${fail} falliti`);
process.exit(fail ? 1 : 0);
