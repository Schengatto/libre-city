// LIBRE CITY · js/city.js — generazione della città: grafo stradale a curve, tile e vicoli,
// landmark (ospedale, polizia, armeria…), base militare, palazzi e dettagli stradali.

// ---------- Città: rete stradale a grafo (strade che curvano) ----------
const T = 32;                 // pixel per tile
const PERIOD = 14;            // dimensione media delle regioni (varietà: parchi, piazze, colori)
// La TAGLIA della città è codificata nella 1ª lettera del CODICE STANZA
// (P=piccola, M=media, G=grande): così ogni client — da link o digitando il codice —
// e il server rigenerano una mappa della stessa dimensione già al load, dal solo
// seme, senza trasmettere nulla. La media raddoppia l'area crescendo in verticale;
// la grande raddoppia ancora crescendo in orizzontale. Iniziale non P/M/G → piccola
// (single-player e stanze anonime, vedi core.js).
const MAP_DIMS = { P: [184, 184], M: [184, 368], G: [368, 368] };
const _mapDims = MAP_DIMS[String(ROOM_CODE).charAt(0)] || MAP_DIMS.P;
const MAP_W = _mapDims[0], MAP_H = _mapDims[1];
const WORLD_W = MAP_W * T, WORLD_H = MAP_H * T;
const HALF_ROAD = 2.1 * T;    // semilarghezza carreggiata (px)
const LANE = 18;              // scostamento della corsia di destra dal centro strada

const ROAD = 0, SIDEWALK = 1, BUILDING = 2, GRASS = 3, TREE = 4, WATER = 5, ALLEY = 6, COURT = 7;
const grid = new Uint8Array(MAP_W * MAP_H);
const gi = (x, y) => y * MAP_W + x;

// palette dei tetti per tipologia di quartiere: residenziale, uffici, industriale
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
// lotti edificabili: dividono gli isolati in una trama regolare di rettangoli;
// da ogni lotto bakeBuildings() ricava un palazzo rettangolare vero e proprio
const LOTX = new Uint8Array(MAP_W), LOTY = new Uint8Array(MAP_H);     // indice del lotto per asse
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
// palette per erba e chiome (varietà), tetti a falde delle case, tende dei negozi
const GRASS_COLS = ['#4f9e46', '#489347', '#57a74b'];
const TREE_COLS = [['#2c6e30', '#38853c', '#4d9c4a'], ['#2f7d34', '#3c9142', '#55a852'], ['#33703a', '#428a48', '#5aa15e']];
const ROOF_COLS = ['#8a4a3a', '#96604a', '#7a5a48', '#6d5242', '#5f6066', '#585c64'];
const AWNING_COLS = ['#c0392b', '#2e86c0', '#27ae60', '#d68910'];
// categoria dell'isolato: parco, piazza o edificio (per una città più varia)
const BUILD_CAT = 0, PARK_CAT = 1, PLAZA_CAT = 2;
function blockCat(bx, by) {
  const h = hash2(bx + 7, by + 3) % 9;
  if (h === 0 || h === 6) return PARK_CAT;      // ~2/9 parchi
  if (h === 3) return PLAZA_CAT;                // ~1/9 piazze
  return BUILD_CAT;
}
const blockHasPond  = (bx, by) => hash2(bx + 1, by + 8) % 3 === 0;   // parco con laghetto

// ---------- geometria delle curve (Bézier quadratica) ----------
function bez(A, B, cx, cy, t) {
  const mt = 1 - t;
  return { x: mt * mt * A.x + 2 * mt * t * cx + t * t * B.x,
           y: mt * mt * A.y + 2 * mt * t * cy + t * t * B.y };
}

// ---------- grafo stradale: nodi (incroci) e archi (strade curve) ----------
const nodes = [];   // { x, y, edges:[idx...], signal }
const edges = [];   // { a, b, cx, cy, len }
const NX = 8, NY = 8, MARGIN = 8;
function buildGraph() {
  const spanX = (MAP_W - 2 * MARGIN) * T, spanY = (MAP_H - 2 * MARGIN) * T;
  const gx = spanX / (NX - 1), gy = spanY / (NY - 1);
  const idOf = (i, j) => j * NX + i;
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const border = i === 0 || j === 0 || i === NX - 1 || j === NY - 1;
    // jitter deterministico e contenuto sui nodi interni → griglia ordinata ma non rigida
    const jx = border ? 0 : (hash2(i + 11, j + 3) % 1000 / 1000 - 0.5) * gx * 0.26;
    const jy = border ? 0 : (hash2(i + 5, j + 17) % 1000 / 1000 - 0.5) * gy * 0.26;
    nodes.push({ x: MARGIN * T + i * gx + jx, y: MARGIN * T + j * gy + jy, edges: [], signal: false });
  }
  const addEdge = (a, b, straight) => {
    const A = nodes[a], B = nodes[b];
    const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
    const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
    // la maggior parte delle vie è dritta; solo ~1 su 4 fa una curva dolce
    const curved = !straight && hash2(a + 7, b + 13) % 100 < 26;
    const bow = curved ? ((hash2(a + 23, b + 5) % 1000 / 1000) - 0.5) * 0.30 : 0;
    const cx = mx + (-dy / L) * L * bow, cy = my + (dx / L) * L * bow;
    const e = { a, b, cx, cy, len: 0 };
    let px = A.x, py = A.y;
    for (let s = 1; s <= 16; s++) { const p = bez(A, B, cx, cy, s / 16); e.len += Math.hypot(p.x - px, p.y - py); px = p.x; py = p.y; }
    const idx = edges.length; edges.push(e); A.edges.push(idx); B.edges.push(idx);
  };
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    if (i < NX - 1) {                                 // strada orizzontale verso destra
      const onBorder = j === 0 || j === NY - 1;
      if (onBorder || hash2(i * 3 + 1, j * 7 + 2) % 5 !== 0) addEdge(idOf(i, j), idOf(i + 1, j), onBorder);
    }
    if (j < NY - 1) {                                 // strada verticale verso il basso
      const onBorder = i === 0 || i === NX - 1;
      if (onBorder || hash2(i * 9 + 4, j * 5 + 6) % 5 !== 0) addEdge(idOf(i, j), idOf(i, j + 1), onBorder);
    }
  }
  // semafori solo in alcuni incroci trafficati (NON a ogni incrocio)
  for (let n = 0; n < nodes.length; n++)
    if (nodes[n].edges.length >= 3 && hash2(n * 3 + 2, n + 5) % 3 === 0) nodes[n].signal = true;
}

// ---------- rasterizzazione delle strade curve sui tile ----------
function stampDisc(wx, wy, r, val) {
  const x0 = Math.max(0, Math.floor((wx - r) / T)), x1 = Math.min(MAP_W - 1, Math.floor((wx + r) / T));
  const y0 = Math.max(0, Math.floor((wy - r) / T)), y1 = Math.min(MAP_H - 1, Math.floor((wy + r) / T));
  const r2 = r * r;
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    const ex = (tx + 0.5) * T - wx, ey = (ty + 0.5) * T - wy;
    if (ex * ex + ey * ey <= r2) grid[gi(tx, ty)] = val;
  }
}
function bakeRoads() {
  grid.fill(BUILDING);
  for (const e of edges) {
    if (e.dead) continue;                              // strada soppressa dalla zona militare
    const A = nodes[e.a], B = nodes[e.b], steps = Math.max(8, Math.ceil(e.len / (T * 0.5)));
    for (let s = 0; s <= steps; s++) { const p = bez(A, B, e.cx, e.cy, s / steps); stampDisc(p.x, p.y, HALF_ROAD, ROAD); }
  }
  for (const n of nodes) if (n.live !== false) stampDisc(n.x, n.y, HALF_ROAD * 1.05, ROAD);   // piazzale d'incrocio
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
    if (adj) grid[gi(x, y)] = SIDEWALK;                // marciapiede attorno alle strade
  }
  // riempimento degli isolati: edifici, parchi, piazze secondo la regione
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    if (grid[gi(x, y)] !== BUILDING) continue;
    const bx = Math.floor(x / PERIOD), by = Math.floor(y / PERIOD), cat = blockCat(bx, by);
    const cxr = (bx + 0.5) * PERIOD, cyr = (by + 0.5) * PERIOD;
    const dxr = x - cxr, dyr = y - cyr, dc = Math.hypot(dxr, dyr);
    if (cat === PARK_CAT) {
      // parco "disegnato": laghetto ovale, vialetti a croce che portano alle uscite,
      // alberi fitti a riva e boschetti a gruppetti sul prato
      const pond = blockHasPond(bx, by);
      const pr = 2.0 + (hash2(bx + 4, by + 6) % 100) / 100;            // raggio del laghetto 2.0–3.0
      if (pond && (dxr * dxr) / (pr * pr) + (dyr * dyr) / (pr * pr * 0.56) < 1) grid[gi(x, y)] = WATER;
      else if (Math.abs(dxr) < 0.8 || Math.abs(dyr) < 0.8) grid[gi(x, y)] = SIDEWALK;  // vialetti
      else if (pond && dc < pr + 1.7) grid[gi(x, y)] = hash2(x + 3, y + 11) % 3 === 0 ? TREE : GRASS;
      else if (hash2(x >> 1, y >> 1) % 5 === 0 && hash2(x * 3, y * 5) % 3 !== 0) grid[gi(x, y)] = TREE;  // boschetti
      else grid[gi(x, y)] = GRASS;
    } else if (cat === PLAZA_CAT) {
      // piazza: fontana al centro e filari regolari di alberi in vasca
      if (dc < 1.6) grid[gi(x, y)] = WATER;             // fontana
      else if (dc > 2.6 && x % PERIOD % 4 === 2 && y % PERIOD % 4 === 2) grid[gi(x, y)] = TREE;
      else grid[gi(x, y)] = SIDEWALK;
    }
  }
}
// vicoli stretti (1 tile) fra i palazzi, con almeno un'uscita sulla strada
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
// ---------- Zona militare: riservata PRIMA di asfaltare ----------
// la base dell'esercito è enorme (26x20 tile ≈ 6 isolati): nessun isolato può
// contenerla, quindi il generatore le riserva un'area e SOPPRIME le strade che
// la attraverserebbero (e.dead: mai asfaltate né disegnate, il traffico le
// ignora e gira attorno alla base)
const ARMY_W = 26, ARMY_H = 20;
let armyZone = null;
const inArmyZone = (tx, ty) => !!armyZone && tx >= armyZone.x0 && tx <= armyZone.x1 && ty >= armyZone.y0 && ty <= armyZone.y1;
function reserveArmyZone() {
  // mai sul centro mappa (lì nasce il player) né sulle strade di bordo
  let x0, y0, tries = 0;
  do { x0 = rndi(14, MAP_W - ARMY_W - 14); y0 = rndi(14, MAP_H - ARMY_H - 14); }
  while (++tries < 30 && x0 - 12 < MAP_W / 2 && MAP_W / 2 < x0 + ARMY_W + 12 &&
                         y0 - 12 < MAP_H / 2 && MAP_H / 2 < y0 + ARMY_H + 12);
  armyZone = { x0, y0, x1: x0 + ARMY_W - 1, y1: y0 + ARMY_H - 1 };
  // sopprime ogni strada che passerebbe nella zona (fascia = asfalto+marciapiede)
  const PADPX = HALF_ROAD + 2 * T;
  const rx0 = x0 * T - PADPX, ry0 = y0 * T - PADPX;
  const rx1 = (armyZone.x1 + 1) * T + PADPX, ry1 = (armyZone.y1 + 1) * T + PADPX;
  for (const e of edges) {
    const A = nodes[e.a], B = nodes[e.b];
    for (let s = 0; s <= 32; s++) {
      const p = bez(A, B, e.cx, e.cy, s / 32);
      if (p.x > rx0 && p.x < rx1 && p.y > ry0 && p.y < ry1) { e.dead = true; break; }
    }
  }
  // grafo superstite: niente piazzole per i nodi rimasti senza strade,
  // semafori ricalcolati sul numero di vie ancora vive
  for (let n = 0; n < nodes.length; n++) {
    const live = nodes[n].edges.filter(ei => !edges[ei].dead).length;
    nodes[n].live = live > 0;
    nodes[n].signal = live >= 3 && hash2(n * 3 + 2, n + 5) % 3 === 0;
  }
}
function genCity() { buildGraph(); reserveArmyZone(); bakeRoads(); bakeSidewalksAndBlocks(); carveAlleys(); }
genCity();

const tileAt = (tx, ty) => (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) ? BUILDING : grid[gi(tx, ty)];
const solidTile = (tx, ty) => { const t = tileAt(tx, ty); return t === BUILDING || t === TREE || t === WATER; };

// ---------- Edifici speciali: polizia, ospedale, pompieri, banca, mercato ----------
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
// punto calpestabile più vicino al perimetro (ingresso della struttura)
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
// la CASERMA non è un palazzo ma un'area recintata: il cortile interno è
// calpestabile (ci parcheggiano jeep e carri armati), il perimetro diventa
// recinzione solida con un cancello di 3 tile aperto verso la via più vicina
function carveArmyBase(lm) {
  // la zona riservata può contenere prati/vicoli: il recinto va murato esplicitamente
  for (let x = lm.x0; x <= lm.x1; x++) { grid[gi(x, lm.y0)] = BUILDING; grid[gi(x, lm.y1)] = BUILDING; }
  for (let y = lm.y0; y <= lm.y1; y++) { grid[gi(lm.x0, y)] = BUILDING; grid[gi(lm.x1, y)] = BUILDING; }
  for (let y = lm.y0 + 1; y < lm.y1; y++) for (let x = lm.x0 + 1; x < lm.x1; x++)
    grid[gi(x, y)] = SIDEWALK;                        // piazzale interno
  // cancello sul lato del recinto che guarda l'ingresso (lm.door)
  const dtx = Math.floor(lm.door.x / T), dty = Math.floor(lm.door.y / T);
  const dl = Math.abs(dtx - lm.x0), dr = Math.abs(dtx - lm.x1);
  const dt = Math.abs(dty - lm.y0), db = Math.abs(dty - lm.y1);
  const m = Math.min(dl, dr, dt, db);
  let g, out;                                         // tile del cancello + direzione esterna
  if (m === dt || m === db) {
    const gy = m === dt ? lm.y0 : lm.y1, gx = clamp(dtx, lm.x0 + 1, lm.x1 - 3);
    g = [[gx, gy], [gx + 1, gy], [gx + 2, gy]]; out = { x: 0, y: m === dt ? -1 : 1 };
  } else {
    const gx = m === dl ? lm.x0 : lm.x1, gy = clamp(dty, lm.y0 + 1, lm.y1 - 3);
    g = [[gx, gy], [gx, gy + 1], [gx, gy + 2]]; out = { x: m === dl ? -1 : 1, y: 0 };
  }
  for (const [x, y] of g) {
    grid[gi(x, y)] = SIDEWALK;
    // vialetto: dal cancello fino alla prima superficie calpestabile esterna
    let cx = x + out.x, cy = y + out.y, steps = 0;
    while (steps++ < 24 && cx > 1 && cy > 1 && cx < MAP_W - 2 && cy < MAP_H - 2 &&
           lmGrid[gi(cx, cy)] === 255 && !walkableTile(tileAt(cx, cy))) {
      grid[gi(cx, cy)] = SIDEWALK;
      cx += out.x; cy += out.y;
    }
  }
  lm.gate = { x: (g[0][0] + g[2][0] + 1) / 2 * T, y: (g[0][1] + g[2][1] + 1) / 2 * T };
}
function placeLandmarks() {
  for (const def of LM_DEFS) for (let k = 0; k < def.count; k++) {
    for (let att = 0; att < 500; att++) {
      const x0 = rndi(6, MAP_W - def.w - 6), y0 = rndi(6, MAP_H - def.h - 6);
      if (!rectAllBuilding(x0 - 1, y0 - 1, def.w + 2, def.h + 2)) continue;   // serve un margine libero
      const cx = (x0 + def.w / 2) * T, cy = (y0 + def.h / 2) * T;
      let far = true;                                   // strutture uguali sparse per la città
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
// la zona riservata dal generatore diventa la caserma: recinto, cancello, cortile
function placeArmyBase() {
  if (!armyZone) return;
  const { x0, y0, x1, y1 } = armyZone;
  const lm = { type: 'army', x0, y0, x1, y1,
               cx: (x0 + (x1 - x0 + 1) / 2) * T, cy: (y0 + (y1 - y0 + 1) / 2) * T };
  lm.door = landmarkDoor(lm);
  const id = landmarks.length; landmarks.push(lm);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) lmGrid[gi(x, y)] = id;
  carveArmyBase(lm);
}
placeLandmarks();
placeArmyBase();

// ---------- Palazzi veri: da ogni lotto un edificio rettangolare ----------
// Il riempimento "a blob" attorno alle strade viene rifinito: dentro ogni lotto
// sopravvive solo il rettangolo pieno più grande (il palazzo); i ritagli di
// risulta diventano cortili (COURT): giardini nel residenziale, piazzali
// lastricati negli uffici, spiazzi con cataste nelle zone industriali.
const bldgs = [];                                      // { x0,y0,x1,y1, kind, style, face, lift, col, h }
const bldgIdx = new Uint16Array(MAP_W * MAP_H).fill(65535);
function bakeBuildings() {
  const isB = (x, y) => tileAt(x, y) === BUILDING && lmGrid[gi(x, y)] === 255;
  const segs = arr => {                                // [inizio, fine] di ogni lotto sull'asse
    const out = []; let s = 0;
    for (let v = 1; v <= arr.length; v++) if (v === arr.length || arr[v] !== arr[s]) { out.push([s, v - 1]); s = v; }
    return out;
  };
  for (const [ya, yb] of segs(LOTY)) for (const [xa, xb] of segs(LOTX)) {
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++)
      if (isB(x, y)) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (!n) continue;
    // rifila il bounding box dal lato più "bucato" finché il rettangolo è pieno
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
    // i tile edificabili rimasti fuori dal palazzo diventano cortile (o verde privato)
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
      if (!isB(x, y) || bldgIdx[gi(x, y)] !== 65535) continue;
      const k = blockKind(Math.floor(x / PERIOD), Math.floor(y / PERIOD)), hh = hash2(x + 21, y + 33);
      grid[gi(x, y)] = (k === RES_KIND && hh % 7 === 0) || (k === OFF_KIND && hh % 23 === 0) ? TREE : COURT;
    }
  }
  // seconda passata (a cortili fatti): stile, altezza e lato che guarda la strada
  for (const b of bldgs) {
    const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1, area = w * h;
    const midx = (b.x0 + b.x1) >> 1, midy = (b.y0 + b.y1) >> 1;
    b.kind = blockKind(Math.floor(midx / PERIOD), Math.floor(midy / PERIOD));
    b.face = walkableTile(tileAt(midx, b.y1 + 1)) ? 0 : walkableTile(tileAt(b.x1 + 1, midy)) ? 1
           : walkableTile(tileAt(b.x0 - 1, midy)) ? 2 : walkableTile(tileAt(midx, b.y0 - 1)) ? 3 : -1;
    if (b.kind === RES_KIND) b.style = area <= 18 ? 'casa' : 'palazzo';
    else if (b.kind === OFF_KIND) b.style = area >= 20 ? 'torre' : 'negozio';
    else b.style = area >= 20 ? 'capannone' : 'officina';
    b.lift = { casa: 6, palazzo: 8, negozio: 7, torre: 11, capannone: 7, officina: 6 }[b.style];
    const pal = [RES_COLORS, OFF_COLORS, IND_COLORS][b.kind];
    b.col = pal[b.h % pal.length];
  }
}
bakeBuildings();

// ---------- posizione/tangente lungo un arco; collocamento sulla corsia destra ----------
function edgePos(e, t) { return bez(nodes[e.a], nodes[e.b], e.cx, e.cy, t); }
function edgeTangent(e, t) {
  const A = nodes[e.a], B = nodes[e.b];
  let x = 2 * (1 - t) * (e.cx - A.x) + 2 * t * (B.x - e.cx);
  let y = 2 * (1 - t) * (e.cy - A.y) + 2 * t * (B.y - e.cy);
  const m = Math.hypot(x, y) || 1; return { x: x / m, y: y / m };
}

// ---------- dettagli stradali precalcolati: strisce pedonali, tombini, rappezzi ----------
const crosswalks = [];   // { x, y, a } — davanti a ogni incrocio vero (3+ strade)
const roadDeco = [];     // { x, y, a, kind } — 0 tombino · 1 rappezzo · 2 macchia d'olio
(function bakeRoadDetails() {
  for (const n of nodes) {
    if (n.live === false) continue;                    // incrocio soppresso dalla zona militare
    const liveEdges = n.edges.filter(ei => !edges[ei].dead);
    if (liveEdges.length < 3) continue;                // niente zebre nelle semplici curve
    for (const ei of liveEdges) {
      const e = edges[ei], fromA = nodes[e.a] === n;
      // cammina lungo l'arco dal nodo fin fuori dal piazzale d'incrocio
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
    if (e.dead) continue;                              // strada soppressa: niente tombini
    for (let k = 1; k <= count; k++) {
      const t = k / (count + 1), p = edgePos(e, t), tan = edgeTangent(e, t);
      const h = hash2(i * 31 + k, k * 7 + 3);
      const off = h % 3 === 0 ? 0 : ((h & 1) ? LANE : -LANE);   // in mezzeria o in corsia
      roadDeco.push({ x: p.x - tan.y * off, y: p.y + tan.x * off, a: Math.atan2(tan.y, tan.x), kind: h % 3 });
    }
  }
})();

function railPlace(c) {
  const e = edges[c.edge], p = edgePos(e, c.t), tan = edgeTangent(e, c.t);
  const dx = tan.x * c.ed, dy = tan.y * c.ed;      // direzione di marcia
  c.x = p.x - dy * LANE; c.y = p.y + dx * LANE;    // tiene la corsia di destra
  c.dir = { x: dx, y: dy };
  c.angle = Math.atan2(dy, dx);
}

// collisione box (AABB) contro i tile solidi
function boxHits(cx, cy, hw, hh) {
  const x0 = Math.floor((cx - hw) / T), x1 = Math.floor((cx + hw) / T);
  const y0 = Math.floor((cy - hh) / T), y1 = Math.floor((cy + hh) / T);
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++)
    if (solidTile(tx, ty)) return true;
  return false;
}
// muove un'entità asse per asse, fermandola contro i muri (imposta hitX/hitY);
// l'aderenza al muro vale solo se il punto è davvero libero: uno spostamento
// ampio può scavalcare il tile urtato, e in quel caso è meglio restare fermi
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
// se un'entità è comunque finita dentro un tile solido, la fa riemergere
// sul centro del tile libero più vicino (cerca per anelli crescenti)
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

// punti casuali su strada / marciapiede vicino a un centro
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
  (tx, ty) => { const t = tileAt(tx, ty); return t === SIDEWALK || t === GRASS || t === ROAD || t === ALLEY; });

