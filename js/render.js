// LIBRE CITY · js/render.js — all the drawing: world, buildings, vehicles, people,
// effects, mission guides, crosshairs and minimap.

// =============================================================================
//  STATIC WORLD CACHE (baked into offscreen canvases, chunk by chunk)
//  The city is generated once from the ROOM_CODE seed and never changes: roads,
//  buildings, tiles, pavements, landmarks. `drawWorldStatic()` used to redraw all of
//  that EVERY FRAME (by far the largest cost, especially on mobile). Now we draw it
//  once per 1024×1024 "chunk" into an offscreen canvas and merely blit the visible
//  chunks. The drawing reuses the same functions: we redirect `ctx` onto the chunk's
//  canvas and pretend the camera sits at its origin.
//  (Two minor animated details stay "frozen" in the bake: the water reflections and
//  the red blink atop the towers — an acceptable trade.)
// =============================================================================
const WORLD_CHUNK = 1024;
const WORLD_CHUNKS_X = Math.ceil(WORLD_W / WORLD_CHUNK);
const WORLD_CHUNKS_Y = Math.ceil(WORLD_H / WORLD_CHUNK);
const worldChunks = new Map();                   // "cx,cy" → the chunk's canvas

function bakeWorldChunk(cx, cy) {
  const cv = document.createElement('canvas');
  cv.width = WORLD_CHUNK; cv.height = WORLD_CHUNK;
  const cctx = cv.getContext('2d');
  // Redirect world drawing onto this chunk (camera at the chunk's origin).
  const _ctx = ctx, _camX = camX, _camY = camY, _vw = vw, _vh = vh;
  ctx = cctx; camX = cx * WORLD_CHUNK; camY = cy * WORLD_CHUNK; vw = WORLD_CHUNK; vh = WORLD_CHUNK;
  drawWorldStatic();
  ctx = _ctx; camX = _camX; camY = _camY; vw = _vw; vh = _vh;
  return cv;
}
function worldChunkAt(cx, cy) {
  const key = cx + ',' + cy;
  let cv = worldChunks.get(key);
  if (!cv) { cv = bakeWorldChunk(cx, cy); worldChunks.set(key, cv); }
  return cv;
}
function drawWorld() {
  const cx0 = Math.max(0, Math.floor(camX / WORLD_CHUNK));
  const cy0 = Math.max(0, Math.floor(camY / WORLD_CHUNK));
  const cx1 = Math.min(WORLD_CHUNKS_X - 1, Math.floor((camX + vw) / WORLD_CHUNK));
  const cy1 = Math.min(WORLD_CHUNKS_Y - 1, Math.floor((camY + vh) / WORLD_CHUNK));
  // Blit the visible chunks (baking on the fly if missing).
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++)
    ctx.drawImage(worldChunkAt(cx, cy), Math.floor(cx * WORLD_CHUNK - camX), Math.floor(cy * WORLD_CHUNK - camY));
  // Prefetch: prepare ONE not-yet-ready chunk in the ring around the view, so scrolling
  // finds chunks already baked and does not stutter at the edges.
  prefetch: for (let cy = cy0 - 1; cy <= cy1 + 1; cy++)
    for (let cx = cx0 - 1; cx <= cx1 + 1; cx++) {
      if (cx < 0 || cy < 0 || cx >= WORLD_CHUNKS_X || cy >= WORLD_CHUNKS_Y) continue;
      if (!worldChunks.has(cx + ',' + cy)) { worldChunkAt(cx, cy); break prefetch; }
    }
  // Eviction: drop chunks outside the ring to cap memory use (mobile).
  if (worldChunks.size > 24) for (const key of [...worldChunks.keys()]) {
    const i = key.indexOf(','), kx = +key.slice(0, i), ky = +key.slice(i + 1);
    if (kx < cx0 - 1 || kx > cx1 + 1 || ky < cy0 - 1 || ky > cy1 + 1) worldChunks.delete(key);
  }
}
function drawWorldStatic() {
  const x0 = Math.max(0, Math.floor(camX / T)), y0 = Math.max(0, Math.floor(camY / T));
  const x1 = Math.min(MAP_W - 1, Math.ceil((camX + vw) / T)), y1 = Math.min(MAP_H - 1, Math.ceil((camY + vh) / T));
  // 1) Background: everything except the carriageway (asphalt + kerbside pavement),
  //    which we draw as smooth ribbons. "Inner" pavements (plazas) stay tiled.
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const t = grid[gi(x, y)];
    if (t === ROAD || (t === SIDEWALK && roadAdjacent(x, y))) continue;
    const px = Math.floor(x * T - camX), py = Math.floor(y * T - camY);
    drawTile(t, px, py, x, y);
  }
  drawBuildings();
  // 2) Pavements + asphalt as continuous curves along the road graph.
  ctx.save();
  clipOutTiles(solidTile);
  drawRoads();
  drawRoadDecals();
  // 3) Paving joints on the smooth pavement + building shadows on the carriageway.
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const t = grid[gi(x, y)];
    if (t !== ROAD && !(t === SIDEWALK && roadAdjacent(x, y))) continue;
    const px = Math.floor(x * T - camX), py = Math.floor(y * T - camY);
    if (t === SIDEWALK) { ctx.fillStyle = 'rgba(0,0,0,.06)'; ctx.fillRect(px, py, T, 1); ctx.fillRect(px, py, 1, T); }
    else drawAsphaltGrain(px, py, x, y);
    if (tileAt(x, y - 1) === BUILDING) { ctx.fillStyle = 'rgba(0,0,0,.20)'; ctx.fillRect(px, py, T, 5); }
    if (tileAt(x - 1, y) === BUILDING) { ctx.fillStyle = 'rgba(0,0,0,.14)'; ctx.fillRect(px, py, 5, T); }
    drawBridgeParapets(px, py, x, y);
  }
  drawMarkings();
  drawCrosswalks();
  ctx.restore();
  ctx.save();
  clipOutTiles((x, y) => tileAt(x, y) === BUILDING);
  drawTrees(x0, y0, x1, y1);
  ctx.restore();
  drawRailway();                                 // the train track (a loop around the city)
  drawBuildingShadows();
  if (chinaGate) drawChinaGatePillars(chinaGate);
  drawLandmarks();
}
// A pavement counts as "kerbside" (covered by the smooth ribbon) if it touches asphalt.
function roadAdjacent(x, y) {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (dx === 0 && dy === 0) continue;
    if (tileAt(x + dx, y + dy) === ROAD) return true;
  }
  return false;
}
// Traces a road edge in screen coordinates.
function traceEdge(e) {
  const A = nodes[e.a], B = nodes[e.b], steps = Math.max(6, Math.ceil(e.len / (T * 0.7)));
  for (let s = 0; s <= steps; s++) {
    const p = bez(A, B, e.cx, e.cy, s / steps);
    if (s === 0) ctx.moveTo(p.x - camX, p.y - camY); else ctx.lineTo(p.x - camX, p.y - camY);
  }
}
function edgeVisible(e, pad) {
  const A = nodes[e.a], B = nodes[e.b];
  const minx = Math.min(A.x, B.x, e.cx) - pad, maxx = Math.max(A.x, B.x, e.cx) + pad;
  const miny = Math.min(A.y, B.y, e.cy) - pad, maxy = Math.max(A.y, B.y, e.cy) + pad;
  return !(maxx < camX || minx > camX + vw || maxy < camY || miny > camY + vh);
}
const SW_BAND = 1.65 * T;                        // pavement width beyond the asphalt
function clipOutTiles(isClippedOut) {
  const x0 = Math.max(0, Math.floor(camX / T)), y0 = Math.max(0, Math.floor(camY / T));
  const x1 = Math.min(MAP_W - 1, Math.floor((camX + vw) / T)), y1 = Math.min(MAP_H - 1, Math.floor((camY + vh) / T));
  ctx.beginPath();
  ctx.rect(0, 0, vw, vh);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (isClippedOut(x, y)) ctx.rect(x * T - camX, y * T - camY, T, T);
  }
  ctx.clip('evenodd');
}
function drawRoads() {
  const SWHALF = HALF_ROAD + SW_BAND, pad = SWHALF + 6;
  ctx.save();
  ctx.lineJoin = 'miter'; ctx.lineCap = 'square';
  // --- Pavement band ---
  ctx.strokeStyle = '#9aa0a8'; ctx.lineWidth = 2 * SWHALF; ctx.beginPath();
  for (const e of edges) if (edgeVisible(e, pad)) traceEdge(e);
  ctx.stroke();
  // --- Kerb (dark ring between paving and asphalt) ---
  ctx.strokeStyle = '#767d87'; ctx.lineWidth = 2 * HALF_ROAD + 7; ctx.beginPath();
  for (const e of edges) if (edgeVisible(e, pad)) traceEdge(e);
  ctx.stroke();
  // --- Asphalt ---
  ctx.strokeStyle = '#33363d'; ctx.lineWidth = 2 * HALF_ROAD; ctx.beginPath();
  for (const e of edges) if (edgeVisible(e, pad)) traceEdge(e);
  ctx.stroke();
  ctx.restore();
}
function drawTile(t, px, py, x, y) {
  if (t === ROAD) {
    ctx.fillStyle = '#33363d'; ctx.fillRect(px, py, T, T);
    if ((hash2(x, y) & 7) === 0) { ctx.fillStyle = 'rgba(255,255,255,.03)'; ctx.fillRect(px + 6, py + 8, 6, 4); }
  } else if (t === SIDEWALK) {
    ctx.fillStyle = '#9aa0a8'; ctx.fillRect(px, py, T, T);
    drawPavingSlabs(px, py, x, y);
  } else if (t === ALLEY) {                                  // alley: dark cobbles
    ctx.fillStyle = '#2b2d33'; ctx.fillRect(px, py, T, T);
    const h = hash2(x, y);
    ctx.fillStyle = 'rgba(0,0,0,.30)'; ctx.fillRect(px + (h & 15), py + ((h >> 4) & 15), 3, 3);
    ctx.fillStyle = 'rgba(255,255,255,.04)'; ctx.fillRect(px + ((h >> 8) & 15), py + ((h >> 12) & 11), 2, 2);
    if (h % 13 === 0) {                                      // bin bags against the wall
      const wy = tileAt(x, y - 1) === BUILDING ? 6 : (tileAt(x, y + 1) === BUILDING ? T - 8 : 14);
      ctx.fillStyle = '#3a3f4a'; ctx.beginPath();
      ctx.arc(px + 9, py + wy, 4, 0, TAU); ctx.arc(px + 15, py + wy + 1, 3.4, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.10)'; ctx.fillRect(px + 7, py + wy - 3, 3, 2);
    }
  } else if (t === GRASS) {
    drawGrass(px, py, x, y);
  } else if (t === TREE) {
    if (treeInPlanter(x, y)) drawPlanter(px, py, x, y);
    else drawGrass(px, py, x, y);
  } else if (t === WATER) {
    drawWaterTile(px, py, x, y);
  } else if (t === COURT) {                                  // the lot's inner courtyard
    const k = blockKind(Math.floor(x / PERIOD), Math.floor(y / PERIOD));
    const h = hash2(x + 9, y + 27);
    if (k === RES_KIND) {                                    // small private garden
      drawGrass(px, py, x, y);
      if (h % 6 === 0) drawBroadleaf(px + 10 + (h & 7), py + 12 + ((h >> 3) & 7), 6, BROADLEAF_PALETTES[2], tileRandom(h));
    } else if (k === OFF_KIND) {                             // paved forecourt
      ctx.fillStyle = '#7e838c'; ctx.fillRect(px, py, T, T);
      ctx.strokeStyle = 'rgba(0,0,0,.10)'; ctx.lineWidth = 1; ctx.strokeRect(px + 0.5, py + 0.5, T - 1, T - 1);
      if (h % 11 === 0) { ctx.fillStyle = 'rgba(255,255,255,.10)'; ctx.fillRect(px + 5, py + 5, 8, 3); }
    } else if (k === CHINA_KIND) {
      ctx.fillStyle = '#8a6a5c'; ctx.fillRect(px, py, T, T);
      ctx.strokeStyle = 'rgba(0,0,0,.12)'; ctx.lineWidth = 1; ctx.strokeRect(px + 0.5, py + 0.5, T - 1, T - 1);
    } else {                                                 // industrial yard
      ctx.fillStyle = '#4d5058'; ctx.fillRect(px, py, T, T);
      ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fillRect(px + (h & 15), py + ((h >> 4) & 15), 5, 3);
      if (h % 9 === 0) {                                     // pallets and stacks
        ctx.fillStyle = '#7a5c3a'; ctx.fillRect(px + 6, py + 8, 12, 9);
        ctx.fillStyle = 'rgba(0,0,0,.30)'; ctx.fillRect(px + 6, py + 12, 12, 1);
        ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(px + 6, py + 8, 12, 2);
      }
    }
    drawDistrictCourtDetail(px, py, x, y, h);
  } else { // BUILDING — the building bodies are drawn by drawBuildings()
    if (lmGrid[gi(x, y)] !== 255) return;                    // covered by a special building
    if (bldgIdx[gi(x, y)] !== 65535) return;                 // covered by a building
    ctx.fillStyle = '#565049'; ctx.fillRect(px, py, T, T);   // rare orphan tile: dark yard
  }
  // Shadow cast by buildings onto the lower surfaces (road, pavement, alley).
  if (t !== BUILDING) {
    if (tileAt(x, y - 1) === BUILDING) { ctx.fillStyle = 'rgba(0,0,0,.20)'; ctx.fillRect(px, py, T, 5); }
    if (tileAt(x - 1, y) === BUILDING) { ctx.fillStyle = 'rgba(0,0,0,.14)'; ctx.fillRect(px, py, 5, T); }
  }
}

const CONTAINER_COLS = ['#b5452f', '#2f6fa8', '#3f8a4a', '#c99a2e', '#7a4a8a'];
function drawDistrictCourtDetail(px, py, x, y, h) {
  const district = districtAt(Math.floor(x / PERIOD), Math.floor(y / PERIOD));
  if (district === RESIDENTIAL) {
    if (h % 3 !== 0) return;
    ctx.fillStyle = '#3f6b35';
    for (const [dx, dy] of WATER_SIDES) if (walkableTile(tileAt(x + dx, y + dy))) edgeBand(px, py, dx, dy, 5);
    return;
  }
  if (district === CHINATOWN) {
    if (h % 5 !== 0) return;
    const lanternX = px + 8 + (h & 15), lanternY = py + 10 + ((h >> 4) & 11);
    ctx.fillStyle = '#d8342a'; ctx.beginPath(); ctx.arc(lanternX, lanternY, 4, 0, TAU); ctx.fill();
    ctx.fillStyle = '#e8c04a'; ctx.fillRect(lanternX - 2, lanternY - 5, 4, 2);
    return;
  }
  if (district !== INDUSTRIAL && district !== PORT) return;
  if (h % 7 === 3) {
    ctx.fillStyle = 'rgba(10,10,12,.35)'; ctx.beginPath();
    ctx.ellipse(px + 8 + (h & 15), py + 10 + ((h >> 4) & 11), 6, 4, 0, 0, TAU); ctx.fill();
  }
  if (h % 13 !== 0) return;
  ctx.fillStyle = CONTAINER_COLS[h % 5]; ctx.fillRect(px + 4, py + 10, 24, 12);
  ctx.fillStyle = 'rgba(0,0,0,.28)';
  for (let rib = 8; rib < 28; rib += 4) ctx.fillRect(px + rib, py + 10, 1, 12);
  ctx.fillStyle = 'rgba(255,255,255,.16)'; ctx.fillRect(px + 4, py + 10, 24, 2);
}

const GRASS_DARK = [58, 116, 52], GRASS_LIGHT = [102, 160, 72];
const FLOWER_COLS = ['#f2ecf6', '#ffd23a', '#e86a8a', '#b48cf0'];
const BROADLEAF_PALETTES = [['#24562a', '#367a36', '#5c9e48'], ['#2a6130', '#3f893c', '#6dab52'], ['#33592a', '#4f7f34', '#86a84c']];
const BLOSSOM_PALETTES = [['#9c4a68', '#cf7898', '#f2bcd0'], ['#8f8a9c', '#d6d0e0', '#f7f3fb']];
const CONIFER_PALETTE = ['#173f27', '#245e36', '#3f8250'];
const WATER_SIDES = [[0, -1], [0, 1], [-1, 0], [1, 0]];
const SOFT_SHORES = [GRASS, TREE, COURT];

function tileRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
function smoothNoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const corner = (cornerX, cornerY) => ((hash2(cornerX + 7, cornerY + 3) >>> 16) & 255) / 255;
  const top = corner(ix, iy) + (corner(ix + 1, iy) - corner(ix, iy)) * sx;
  const bottom = corner(ix, iy + 1) + (corner(ix + 1, iy + 1) - corner(ix, iy + 1)) * sx;
  return top + (bottom - top) * sy;
}
function grassColor(tileX, tileY) {
  const lushness = 0.7 * smoothNoise(tileX / 7, tileY / 7) + 0.3 * smoothNoise(tileX / 2.3 + 50, tileY / 2.3 + 50);
  const channel = i => Math.round(GRASS_DARK[i] + (GRASS_LIGHT[i] - GRASS_DARK[i]) * lushness);
  return `rgb(${channel(0)},${channel(1)},${channel(2)})`;
}
function drawGrass(px, py, x, y) {
  const half = T / 2;
  for (let quarter = 0; quarter < 4; quarter++) {
    const qx = quarter & 1, qy = quarter >> 1;
    ctx.fillStyle = grassColor(x + qx / 2, y + qy / 2);
    ctx.fillRect(px + qx * half, py + qy * half, half, half);
  }
  const rand = tileRandom(hash2(x * 3 + 1, y * 5 + 2));
  for (let blade = 0; blade < 7; blade++) {
    ctx.fillStyle = blade % 3 ? 'rgba(20,60,20,.16)' : 'rgba(215,240,160,.12)';
    ctx.fillRect(px + rand() * (T - 2), py + rand() * (T - 2), 1 + rand(), 1 + rand());
  }
  if (rand() < 0.06) {
    ctx.fillStyle = FLOWER_COLS[Math.floor(rand() * FLOWER_COLS.length)];
    const fx = px + 6 + rand() * (T - 12), fy = py + 6 + rand() * (T - 12);
    for (let petal = 0; petal < 5; petal++) ctx.fillRect(fx + rand() * 8 - 4, fy + rand() * 8 - 4, 2, 2);
  }
}
function drawPavingSlabs(px, py, x, y) {
  const rand = tileRandom(hash2(x * 11 + 5, y * 17 + 3));
  const half = T / 2;
  for (let slab = 0; slab < 4; slab++) {
    const tint = rand() - 0.5;
    ctx.fillStyle = tint > 0 ? `rgba(255,255,255,${(tint * 0.10).toFixed(3)})` : `rgba(0,0,0,${(-tint * 0.10).toFixed(3)})`;
    ctx.fillRect(px + (slab & 1) * half, py + (slab >> 1) * half, half, half);
  }
  ctx.fillStyle = 'rgba(0,0,0,.12)';
  ctx.fillRect(px, py, T, 1); ctx.fillRect(px, py + half, T, 1); ctx.fillRect(px, py, 1, T); ctx.fillRect(px + half, py, 1, T);
  ctx.fillStyle = 'rgba(255,255,255,.07)';
  ctx.fillRect(px, py + 1, T, 1); ctx.fillRect(px, py + half + 1, T, 1); ctx.fillRect(px + 1, py, 1, T); ctx.fillRect(px + half + 1, py, 1, T);
  if (rand() < 0.08) {
    ctx.fillStyle = 'rgba(30,30,30,.10)'; ctx.beginPath();
    ctx.ellipse(px + 4 + rand() * (T - 8), py + 4 + rand() * (T - 8), 3 + rand() * 3, 2 + rand() * 2, rand() * TAU, 0, TAU);
    ctx.fill();
  }
}
function drawAsphaltGrain(px, py, x, y) {
  const rand = tileRandom(hash2(x * 5 + 3, y * 9 + 1));
  for (let speck = 0; speck < 10; speck++) {
    ctx.fillStyle = speck & 1 ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.16)';
    ctx.fillRect(px + rand() * T, py + rand() * T, 1 + rand() * 1.5, 1);
  }
  if (rand() < 0.04) {
    let cx = px + rand() * T, cy = py + rand() * T;
    ctx.strokeStyle = 'rgba(10,10,12,.35)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, cy);
    for (let segment = 0; segment < 4; segment++) { cx += rand() * 10 - 5; cy += rand() * 10 - 5; ctx.lineTo(cx, cy); }
    ctx.stroke();
  }
}
function edgeBand(px, py, dx, dy, thickness) {
  ctx.fillRect(dx > 0 ? px + T - thickness : px, dy > 0 ? py + T - thickness : py, dx ? thickness : T, dy ? thickness : T);
}
function fadeFromEdge(px, py, dx, dy, depth, color, alpha) {
  const sx = dx > 0 ? px + T : px, sy = dy > 0 ? py + T : py;
  const fade = ctx.createLinearGradient(sx, sy, sx - dx * depth, sy - dy * depth);
  fade.addColorStop(0, `rgba(${color},${alpha})`); fade.addColorStop(1, `rgba(${color},0)`);
  ctx.fillStyle = fade; ctx.fillRect(px, py, T, T);
}
function drawWaterTile(px, py, x, y) {
  ctx.fillStyle = '#245a86'; ctx.fillRect(px, py, T, T);
  const h = hash2(x, y);
  const tw = 0.55 + 0.45 * Math.sin(frame * 0.05 + (h & 15));
  ctx.fillStyle = `rgba(255,255,255,${0.05 + 0.08 * tw})`;
  ctx.fillRect(px + (h & 15), py + 5 + ((h >> 4) & 7), 6, 2);
  ctx.fillRect(px + ((h >> 8) & 15), py + 19 + ((h >> 12) & 5), 5, 2);
  for (const [dx, dy] of WATER_SIDES) {
    const neighbour = tileAt(x + dx, y + dy);
    if (neighbour === WATER) continue;
    fadeFromEdge(px, py, dx, dy, 14, '120,190,200', 0.5);
    if (dx < 0 || dy < 0) fadeFromEdge(px, py, dx, dy, 7, '0,0,0', 0.3);
    if (SOFT_SHORES.includes(neighbour)) {
      ctx.fillStyle = 'rgba(230,245,250,.45)'; edgeBand(px, py, dx, dy, 1.5);
    } else {
      ctx.fillStyle = '#b4b9c0'; edgeBand(px, py, dx, dy, 3);
      ctx.fillStyle = 'rgba(255,255,255,.35)'; edgeBand(px, py, dx, dy, 1);
    }
  }
}
function drawBridgeParapets(px, py, x, y) {
  const island = armyZone && armyZone.island;
  if (!island || x < island.x0 || x > island.x1 || y < island.y0 || y > island.y1) return;
  for (const [dx, dy] of WATER_SIDES) {
    if (tileAt(x + dx, y + dy) !== WATER) continue;
    ctx.fillStyle = 'rgba(0,0,0,.45)'; edgeBand(px, py, dx, dy, 8);
    ctx.fillStyle = '#ddd6c6'; edgeBand(px, py, dx, dy, 5);
    ctx.fillStyle = 'rgba(255,255,255,.55)'; edgeBand(px, py, dx, dy, 1.5);
  }
}
function treeInPlanter(x, y) {
  const bx = Math.floor(x / PERIOD), by = Math.floor(y / PERIOD), cat = blockCat(bx, by);
  return x < CITY_W && (cat === PLAZA_CAT || (cat === BUILD_CAT && blockKind(bx, by) === OFF_KIND));
}
function drawPlanter(px, py, x, y) {
  const inPlaza = blockCat(Math.floor(x / PERIOD), Math.floor(y / PERIOD)) === PLAZA_CAT;
  ctx.fillStyle = inPlaza ? '#9aa0a8' : '#7e838c'; ctx.fillRect(px, py, T, T);
  drawPavingSlabs(px, py, x, y);
  ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(px + 6, py + 6, T - 8, T - 8);
  ctx.fillStyle = '#868b93'; ctx.fillRect(px + 4, py + 4, T - 8, T - 8);
  ctx.fillStyle = '#aeb3ba'; ctx.fillRect(px + 4, py + 4, T - 8, 2); ctx.fillRect(px + 4, py + 4, 2, T - 8);
  ctx.fillStyle = '#4b3a2a'; ctx.fillRect(px + 7, py + 7, T - 14, T - 14);
}
function drawTreeShadow(cx, cy, radius) {
  ctx.fillStyle = 'rgba(12,28,14,.16)';
  ctx.beginPath(); ctx.arc(cx + radius * 0.45, cy + radius * 0.55, radius * 1.08, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + radius * 0.55, cy + radius * 0.65, radius * 0.85, 0, TAU); ctx.fill();
}
function canopyLobes(rand) {
  const count = 6 + Math.floor(rand() * 3), turn = rand() * TAU;
  return Array.from({ length: count }, (_, i) => {
    const angle = turn + i / count * TAU, reach = 0.36 + rand() * 0.12;
    return { dx: Math.cos(angle) * reach, dy: Math.sin(angle) * reach, r: 0.46 + rand() * 0.14 };
  });
}
function fillLobes(cx, cy, radius, lobes, color) {
  ctx.fillStyle = color; ctx.beginPath();
  ctx.moveTo(cx + radius * 0.62, cy); ctx.arc(cx, cy, radius * 0.62, 0, TAU);
  for (const lobe of lobes) {
    const lx = cx + lobe.dx * radius, ly = cy + lobe.dy * radius, lr = lobe.r * radius;
    ctx.moveTo(lx + lr, ly); ctx.arc(lx, ly, lr, 0, TAU);
  }
  ctx.fill();
}
function drawBroadleaf(cx, cy, radius, palette, rand) {
  const lobes = canopyLobes(rand);
  drawTreeShadow(cx, cy, radius);
  fillLobes(cx, cy, radius, lobes, palette[0]);
  fillLobes(cx - radius * 0.12, cy - radius * 0.14, radius * 0.8, lobes, palette[1]);
  ctx.fillStyle = palette[2];
  for (let k = 0; k < 3; k++) {
    const angle = Math.PI * 1.25 + (rand() - 0.5) * 1.6, reach = radius * (0.2 + rand() * 0.3);
    ctx.beginPath(); ctx.arc(cx - radius * 0.1 + Math.cos(angle) * reach, cy - radius * 0.1 + Math.sin(angle) * reach, radius * (0.16 + rand() * 0.1), 0, TAU); ctx.fill();
  }
  ctx.fillStyle = 'rgba(0,0,0,.14)';
  for (let k = 0; k < 4; k++) {
    const angle = rand() * TAU, reach = radius * rand() * 0.6;
    ctx.beginPath(); ctx.arc(cx + Math.cos(angle) * reach + radius * 0.1, cy + Math.sin(angle) * reach + radius * 0.1, 1 + rand() * 0.8, 0, TAU); ctx.fill();
  }
}
function drawConifer(cx, cy, radius, rand) {
  const points = 12, turn = rand() * TAU;
  const star = (scale, shift) => Array.from({ length: points * 2 }, (_, i) => {
    const angle = turn + i / (points * 2) * TAU, reach = radius * scale * (i % 2 ? 0.78 : 1);
    return [cx - shift + Math.cos(angle) * reach, cy - shift + Math.sin(angle) * reach];
  });
  drawTreeShadow(cx, cy, radius * 0.9);
  fillPolygon(star(1, 0), CONIFER_PALETTE[0]);
  fillPolygon(star(0.72, radius * 0.1), CONIFER_PALETTE[1]);
  fillPolygon(star(0.4, radius * 0.16), CONIFER_PALETTE[2]);
}
function drawTreeOnTile(x, y) {
  const rand = tileRandom(hash2(x * 7 + 1, y * 13 + 4));
  const px = Math.floor(x * T - camX), py = Math.floor(y * T - camY);
  if (treeInPlanter(x, y)) { drawBroadleaf(px + T / 2, py + T / 2, 12, BROADLEAF_PALETTES[1], rand); return; }
  const cx = px + T / 2 + (rand() - 0.5) * 6, cy = py + T / 2 + (rand() - 0.5) * 6;
  const species = rand();
  if (species < 0.2) drawConifer(cx, cy, 10 + rand() * 3, rand);
  else if (species < 0.28) drawBroadleaf(cx, cy, 9 + rand() * 3, BLOSSOM_PALETTES[Math.floor(rand() * BLOSSOM_PALETTES.length)], rand);
  else drawBroadleaf(cx, cy, 11 + rand() * 5, BROADLEAF_PALETTES[Math.floor(rand() * BROADLEAF_PALETTES.length)], rand);
}
function drawTrees(x0, y0, x1, y1) {
  for (let y = Math.max(0, y0 - 1); y <= Math.min(MAP_H - 1, y1 + 1); y++)
    for (let x = Math.max(0, x0 - 1); x <= Math.min(MAP_W - 1, x1 + 1); x++)
      if (grid[gi(x, y)] === TREE) drawTreeOnTile(x, y);
}

// Lightens (f>0) or darkens (f<0) a hex colour.
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (f >= 0) { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
  else { r *= 1 + f; g *= 1 + f; b *= 1 + f; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

const SHADOW_LENGTH_PER_LIFT = 1.6;
const WINDOW_TONES = ['rgba(255,226,150,.80)', 'rgba(176,204,228,.55)', 'rgba(150,184,212,.45)', 'rgba(26,36,50,.75)'];
const WALL_LAYOUT = {
  house:     { floorHeight: 99, bay: 11, windowWidth: 4 },
  apartment: { floorHeight: 5, bay: 7, windowWidth: 3 },
  shop:      { floorHeight: 5, bay: 8, windowWidth: 4 },
  tower:     { floorHeight: 4, bay: 4, windowWidth: 3 },
  warehouse: null,
  workshop:  { floorHeight: 99, bay: 12, windowWidth: 8 },
  pagoda:    { floorHeight: 99, bay: 10, windowWidth: 4 },
  chinashop: { floorHeight: 5, bay: 8, windowWidth: 4 },
};
function buildingRandom(seed) {
  return tileRandom(seed);
}
function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
const MATERIAL_TILE = 64;
const materialPatterns = new Map();
function transposedPainter(name) {
  return (tile, random) => {
    tile.setTransform(0, 1, 1, 0, 0, 0);
    MATERIAL_PAINTERS[name](tile, random);
  };
}
const MATERIAL_PAINTERS = {
  gravel(tile, random) {
    const tones = ['rgba(34,28,20,.16)', 'rgba(255,250,236,.12)', 'rgba(150,118,78,.13)'];
    const wrap = value => (value + MATERIAL_TILE) % MATERIAL_TILE;
    for (let k = 0; k < 700; k++) {
      tile.fillStyle = tones[Math.floor(random() * tones.length)];
      tile.fillRect(Math.floor(random() * MATERIAL_TILE), Math.floor(random() * MATERIAL_TILE), 1, 1);
    }
    for (let k = 0; k < 170; k++) {
      const centerX = Math.floor(random() * MATERIAL_TILE), centerY = Math.floor(random() * MATERIAL_TILE);
      tile.fillStyle = tones[Math.floor(random() * tones.length)];
      for (let pebble = 3 + Math.floor(random() * 4); pebble > 0; pebble--) {
        tile.fillRect(wrap(centerX + Math.floor(random() * 3) - 1), wrap(centerY + Math.floor(random() * 3) - 1), 1, 1);
      }
    }
    for (let k = 0; k < 36; k++) {
      const x = Math.floor(random() * (MATERIAL_TILE - 2)), y = Math.floor(random() * (MATERIAL_TILE - 2));
      tile.fillStyle = random() < 0.5 ? 'rgba(255,248,232,.14)' : 'rgba(60,48,32,.14)'; tile.fillRect(x, y, 2, 2);
      tile.fillStyle = 'rgba(255,255,255,.16)'; tile.fillRect(x, y, 1, 1);
      tile.fillStyle = 'rgba(0,0,0,.22)'; tile.fillRect(x + 1, y + 1, 1, 1);
    }
  },
  tar(tile, random) {
    tile.fillStyle = 'rgba(0,0,0,.10)';
    for (let k = 0; k < 600; k++) tile.fillRect(Math.floor(random() * MATERIAL_TILE), Math.floor(random() * MATERIAL_TILE), 1, 1);
    for (let k = 0; k < 3; k++) {
      const w = 6 + Math.floor(random() * 12), h = 4 + Math.floor(random() * 8);
      const x = Math.floor(random() * (MATERIAL_TILE - w)), y = Math.floor(random() * (MATERIAL_TILE - h));
      tile.fillStyle = 'rgba(0,0,0,.08)'; tile.fillRect(x, y, w, h);
      tile.fillStyle = 'rgba(255,255,255,.08)'; tile.fillRect(x, y, w, 1); tile.fillRect(x, y, 1, h);
    }
    for (let row = 0; row < MATERIAL_TILE; row += 16) {
      tile.fillStyle = 'rgba(255,255,255,.14)'; tile.fillRect(0, row, MATERIAL_TILE, 1);
      tile.fillStyle = 'rgba(0,0,0,.34)'; tile.fillRect(0, row + 15, MATERIAL_TILE, 1);
      tile.fillStyle = 'rgba(0,0,0,.24)'; tile.fillRect(Math.floor(random() * MATERIAL_TILE), row + 1, 1, 14);
    }
  },
  metal(tile, random) {
    for (let x = 0; x < MATERIAL_TILE; x += 4) {
      tile.fillStyle = 'rgba(255,255,255,.22)'; tile.fillRect(x, 0, 1, MATERIAL_TILE);
      tile.fillStyle = 'rgba(0,0,0,.30)'; tile.fillRect(x + 2, 0, 1, MATERIAL_TILE);
    }
    tile.fillStyle = 'rgba(0,0,0,.26)'; tile.fillRect(0, MATERIAL_TILE - 1, MATERIAL_TILE, 1);
    tile.fillStyle = 'rgba(0,0,0,.08)';
    for (let k = 0; k < 200; k++) tile.fillRect(Math.floor(random() * MATERIAL_TILE), Math.floor(random() * MATERIAL_TILE), 1, 2);
  },
  tilesH(tile) {
    for (let y = 0; y < MATERIAL_TILE; y += 4) {
      const offset = (y / 4) % 2 * 4;
      for (let x = offset - 8; x < MATERIAL_TILE; x += 8) {
        tile.fillStyle = 'rgba(0,0,0,.34)'; tile.fillRect(x, y, 1, 3);
        tile.fillStyle = 'rgba(255,255,255,.22)'; tile.fillRect(x + 1, y, 2, 3);
        tile.fillStyle = 'rgba(0,0,0,.16)'; tile.fillRect(x + 5, y, 2, 3);
      }
      tile.fillStyle = 'rgba(0,0,0,.36)'; tile.fillRect(0, y + 3, MATERIAL_TILE, 1);
    }
  },
  tilesV: transposedPainter('tilesH'),
  metalH: transposedPainter('metal'),
  brickV: transposedPainter('brick'),
  panelV: transposedPainter('panel'),
  brick(tile, random) {
    for (let y = 0; y < MATERIAL_TILE; y += 4) {
      const offset = (y / 4) % 2 * 4;
      for (let x = offset - 8; x < MATERIAL_TILE; x += 8) {
        tile.fillStyle = `rgba(0,0,0,${(random() * 0.18).toFixed(3)})`; tile.fillRect(x + 1, y, 7, 3);
        tile.fillStyle = 'rgba(255,255,255,.24)'; tile.fillRect(x, y, 1, 3);
      }
      tile.fillStyle = 'rgba(255,255,255,.24)'; tile.fillRect(0, y + 3, MATERIAL_TILE, 1);
    }
  },
  panel(tile, random) {
    for (let y = 0; y < MATERIAL_TILE; y += 8) for (let x = 0; x < MATERIAL_TILE; x += 16) {
      tile.fillStyle = random() < 0.5 ? `rgba(0,0,0,${(random() * 0.09).toFixed(3)})` : `rgba(255,255,255,${(random() * 0.08).toFixed(3)})`;
      tile.fillRect(x, y, 16, 8);
      tile.fillStyle = 'rgba(255,255,255,.16)'; tile.fillRect(x, y, 15, 1); tile.fillRect(x, y, 1, 7);
      tile.fillStyle = 'rgba(0,0,0,.30)'; tile.fillRect(x + 15, y, 1, 8); tile.fillRect(x, y + 7, 16, 1);
    }
    tile.fillStyle = 'rgba(0,0,0,.10)';
    for (let k = 0; k < 300; k++) tile.fillRect(Math.floor(random() * MATERIAL_TILE), Math.floor(random() * MATERIAL_TILE), 1, 1);
  },
};
function materialPattern(name) {
  if (!materialPatterns.has(name)) {
    const tile = document.createElement('canvas');
    tile.width = MATERIAL_TILE; tile.height = MATERIAL_TILE;
    const tileContext = tile.getContext('2d');
    MATERIAL_PAINTERS[name](tileContext, buildingRandom(hash2(name.length * 977, name.charCodeAt(0) * 131 + name.charCodeAt(name.length - 1))));
    materialPatterns.set(name, tileContext.createPattern(tile, 'repeat'));
  }
  return materialPatterns.get(name);
}
function drawRoofSurface(x, y, w, h, color, material) {
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = color; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = materialPattern(material); ctx.fillRect(x, y, w, h);
  const random = buildingRandom(hash2(x + camX, y + camY));
  const stains = 3 + Math.floor(random() * 3);
  for (let k = 0; k < stains; k++) {
    const radius = 4 + random() * Math.min(w, h) * 0.2;
    const sx = x + random() * w, sy = y + random() * h;
    const left = Math.max(x, sx - radius), top = Math.max(y, sy - radius);
    const stain = ctx.createRadialGradient(sx, sy, 0, sx, sy, radius);
    stain.addColorStop(0, 'rgba(24,20,14,.12)'); stain.addColorStop(1, 'rgba(24,20,14,0)');
    ctx.fillStyle = stain; ctx.fillRect(left, top, Math.min(x + w, sx + radius) - left, Math.min(y + h, sy + radius) - top);
  }
  const light = ctx.createLinearGradient(x, y, x + w, y + h);
  light.addColorStop(0, 'rgba(255,255,255,.12)'); light.addColorStop(0.5, 'rgba(255,255,255,0)'); light.addColorStop(1, 'rgba(0,0,0,.12)');
  ctx.fillStyle = light; ctx.fillRect(x, y, w, h);
}
function planRoofProps(random, roof, pool, count, reserved, placedOnBuilding = []) {
  const placed = [];
  const typeCount = type => [...placedOnBuilding, ...placed].filter(prop => prop.type === type).length;
  for (let attempt = 0; attempt < count * 8 && placed.length < count; attempt++) {
    const kind = pool[Math.floor(random() * pool.length)];
    const w = kind.w[0] + Math.floor(random() * (kind.w[1] - kind.w[0] + 1));
    const h = kind.h[0] + Math.floor(random() * (kind.h[1] - kind.h[0] + 1));
    const slackX = roof.w - 8 - w, slackY = roof.h - 8 - h;
    if (slackX < 0 || slackY < 0) continue;
    if (kind.max && typeCount(kind.type) >= kind.max) continue;
    const prop = { type: kind.type, x: roof.x + 4 + Math.floor(random() * (slackX + 1)), y: roof.y + 4 + Math.floor(random() * (slackY + 1)), w, h, height: kind.height };
    const spaced = { x: prop.x - 2, y: prop.y - 2, w: w + 4, h: h + 4 };
    if (reserved.some(rect => rectsOverlap(rect, spaced)) || placed.some(other => rectsOverlap(other, spaced))) continue;
    placed.push(prop);
  }
  return placed;
}
function drawPropBox(x, y, w, h, height, color) {
  fillPolygon(buildingShadowPolygon(x, y, w, h, height * SHADOW_LENGTH_PER_LIFT), 'rgba(10,14,24,.30)');
  const depth = Math.max(1, Math.min(Math.round(height * 0.5), Math.floor(Math.min(w, h) / 3)));
  const topW = w - depth, topH = h - depth;
  fillPolygon([[x, y + topH], [x + topW, y + topH], [x + w, y + h], [x, y + h]], shade(color, -0.34));
  fillPolygon([[x + topW, y], [x + w, y], [x + w, y + h], [x + topW, y + topH]], shade(color, -0.52));
  ctx.fillStyle = color; ctx.fillRect(x, y, topW, topH);
  ctx.fillStyle = shade(color, 0.30); ctx.fillRect(x, y, topW, 1); ctx.fillRect(x, y, 1, topH);
  return { topW, topH, depth };
}
function drawRoundPropShadow(cx, cy, radius, length) {
  const offset = radius * Math.SQRT1_2;
  ctx.fillStyle = 'rgba(10,14,24,.30)'; ctx.beginPath();
  ctx.moveTo(cx - offset, cy + offset); ctx.lineTo(cx + offset, cy - offset);
  ctx.lineTo(cx + offset + length, cy - offset + length); ctx.lineTo(cx - offset + length, cy + offset + length); ctx.closePath();
  ctx.moveTo(cx + length + radius, cy + length); ctx.arc(cx + length, cy + length, radius, 0, TAU);
  ctx.fill();
}
function drawRoofProp(prop, ox, oy, roofColor = '#9a5a44') {
  const x = ox + prop.x, y = oy + prop.y, w = prop.w, h = prop.h, shadowLength = prop.height * SHADOW_LENGTH_PER_LIFT;
  const cx = x + w / 2, cy = y + h / 2, radius = Math.min(w, h) / 2;
  switch (prop.type) {
    case 'hvac': {
      const { topW, topH } = drawPropBox(x, y, w, h, prop.height, '#a9adb1');
      const fan = Math.max(2, Math.min(topW, topH) - 2), fanX = x + topW - fan / 2 - 1, fanY = y + topH / 2;
      ctx.fillStyle = 'rgba(0,0,0,.38)';
      for (let gy = y + 2; gy < y + topH - 1; gy += 2) ctx.fillRect(x + 2, gy, Math.max(0, topW - fan - 4), 1);
      ctx.fillStyle = '#3b4046'; ctx.beginPath(); ctx.arc(fanX, fanY, fan / 2, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#8b9096'; ctx.lineWidth = 1; ctx.beginPath();
      ctx.moveTo(fanX - fan / 2 + 1, fanY); ctx.lineTo(fanX + fan / 2 - 1, fanY); ctx.moveTo(fanX, fanY - fan / 2 + 1); ctx.lineTo(fanX, fanY + fan / 2 - 1); ctx.stroke();
      ctx.fillStyle = '#d4d7da'; ctx.fillRect(Math.round(fanX) - 1, Math.round(fanY) - 1, 2, 2);
      break;
    }
    case 'hvacBank': {
      const horizontal = w >= h, unit = horizontal ? h + 2 : w + 2, length = horizontal ? w : h;
      for (let offset = 0; offset + unit - 2 <= length; offset += unit) {
        drawRoofProp({ type: 'hvac', x: prop.x + (horizontal ? offset : 0), y: prop.y + (horizontal ? 0 : offset), w: horizontal ? unit - 2 : w, h: horizontal ? h : unit - 2, height: prop.height }, ox, oy);
      }
      break;
    }
    case 'stairHut': {
      const { topW, topH, depth } = drawPropBox(x, y, w, h, prop.height, '#948d82');
      ctx.fillStyle = '#5a554f'; ctx.fillRect(x + 2, y + 2, topW - 4, topH - 4);
      ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.fillRect(x + 2, y + 2, topW - 4, 1);
      ctx.fillStyle = '#231f1b'; ctx.fillRect(x + Math.round(topW / 2) - 2, y + topH + 1, 4, depth - 1);
      ctx.fillStyle = '#c9c3b6'; ctx.fillRect(x + Math.round(topW / 2) - 3, y + topH, 6, 1);
      break;
    }
    case 'tank': {
      drawRoundPropShadow(cx, cy, radius, shadowLength);
      const body = ctx.createRadialGradient(cx - radius * 0.4, cy - radius * 0.4, 0, cx, cy, radius);
      body.addColorStop(0, '#b48a5e'); body.addColorStop(1, '#5c3f28');
      ctx.fillStyle = body; ctx.beginPath(); ctx.arc(cx, cy, radius, 0, TAU); ctx.fill();
      ctx.save(); ctx.clip();
      ctx.fillStyle = 'rgba(0,0,0,.28)';
      for (let sx = Math.floor(cx - radius) + 1; sx < cx + radius; sx += 2) ctx.fillRect(sx, cy - radius, 1, radius * 2);
      ctx.restore();
      ctx.strokeStyle = '#3a271a'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, radius - 0.5, 0, TAU); ctx.stroke();
      const cap = ctx.createRadialGradient(cx - radius * 0.3, cy - radius * 0.3, 0, cx, cy, radius * 0.62);
      cap.addColorStop(0, '#e6dccb'); cap.addColorStop(1, '#8c8478');
      ctx.fillStyle = cap; ctx.beginPath(); ctx.arc(cx - 0.5, cy - 0.5, radius * 0.62, 0, TAU); ctx.fill();
      ctx.fillStyle = '#4a443c'; ctx.fillRect(Math.round(cx) - 1, Math.round(cy) - 1, 1, 1);
      break;
    }
    case 'skylight': {
      fillPolygon(buildingShadowPolygon(x, y, w, h, Math.max(1, shadowLength)), 'rgba(10,14,24,.30)');
      ctx.fillStyle = '#c4c8cc'; ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#6f8ea3'; ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
      ctx.fillStyle = 'rgba(28,44,60,.45)';
      for (let sx = x + 4; sx < x + w - 2; sx += 4) ctx.fillRect(sx, y + 1, 1, h - 2);
      ctx.save(); ctx.beginPath(); ctx.rect(x + 1, y + 1, w - 2, h - 2); ctx.clip();
      ctx.strokeStyle = 'rgba(235,245,255,.55)'; ctx.lineWidth = 2; ctx.beginPath();
      ctx.moveTo(x + w * 0.2, y + h); ctx.lineTo(x + w * 0.2 + h, y); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(x, y + h - 1, w, 1); ctx.fillRect(x + w - 1, y, 1, h);
      break;
    }
    case 'vent': {
      drawRoundPropShadow(cx, cy, radius, shadowLength);
      ctx.fillStyle = '#6e7379'; ctx.beginPath(); ctx.arc(cx, cy, radius, 0, TAU); ctx.fill();
      ctx.fillStyle = '#b9bdc1'; ctx.beginPath(); ctx.arc(cx - 0.5, cy - 0.5, radius - 1, 0, TAU); ctx.fill();
      ctx.fillStyle = '#2e3135'; ctx.fillRect(Math.round(cx) - 1, Math.round(cy) - 1, 2, 2);
      break;
    }
    case 'antenna': {
      const baseX = Math.round(x + w - 2) + 0.5, baseY = Math.round(y + h - 2) + 0.5, topX = x + 1.5, topY = y + 1.5;
      const shadowReach = Math.min(shadowLength, Math.hypot(w, h)) * Math.SQRT1_2;
      ctx.fillStyle = 'rgba(10,14,24,.22)'; ctx.fillRect(baseX - 1.5, baseY - 1.5, 4, 4);
      ctx.lineWidth = 2; ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(10,14,24,.20)'; ctx.beginPath(); ctx.moveTo(baseX, baseY); ctx.lineTo(baseX + shadowReach, baseY + shadowReach); ctx.stroke();
      ctx.lineWidth = 1; ctx.lineCap = 'butt';
      ctx.strokeStyle = '#d2d6da'; ctx.beginPath(); ctx.moveTo(baseX, baseY); ctx.lineTo(topX, topY);
      for (const t of [0.35, 0.7]) {
        const mx = baseX + (topX - baseX) * t, my = baseY + (topY - baseY) * t;
        ctx.moveTo(mx - 2, my + 2); ctx.lineTo(mx + 2, my - 2);
      }
      ctx.stroke();
      ctx.fillStyle = '#2e3135'; ctx.fillRect(baseX - 1.5, baseY - 1.5, 3, 3);
      ctx.fillStyle = '#ff4a3a'; ctx.fillRect(Math.round(topX) - 1, Math.round(topY) - 1, 2, 2);
      break;
    }
    case 'dish': {
      const dishShadow = Math.min(shadowLength * 0.5, 3);
      ctx.fillStyle = 'rgba(10,14,24,.30)'; ctx.beginPath(); ctx.ellipse(cx + dishShadow, cy + dishShadow, w / 2, h / 2, -Math.PI / 4, 0, TAU); ctx.fill();
      ctx.fillStyle = '#4a4f56'; ctx.beginPath(); ctx.ellipse(cx, cy, w / 2, h / 2 - 0.5, -Math.PI / 4, 0, TAU); ctx.fill();
      const bowl = ctx.createRadialGradient(cx + radius * 0.35, cy + radius * 0.35, 0, cx, cy, radius);
      bowl.addColorStop(0, '#eef0f2'); bowl.addColorStop(0.6, '#b9bec4'); bowl.addColorStop(1, '#7d838b');
      ctx.fillStyle = bowl; ctx.beginPath(); ctx.ellipse(cx, cy, w / 2 - 1, h / 2 - 1.5, -Math.PI / 4, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#2b2f34'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + w - 2.5, y + h - 2.5); ctx.lineTo(cx - 1, cy - 1); ctx.stroke();
      ctx.fillStyle = '#23272c'; ctx.fillRect(Math.round(cx) - 2, Math.round(cy) - 2, 2, 2);
      break;
    }
    case 'solar': {
      fillPolygon(buildingShadowPolygon(x, y, w, h, Math.max(1, shadowLength)), 'rgba(10,14,24,.30)');
      ctx.fillStyle = '#1f2d44'; ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#3c5a82';
      for (let sx = x + 3; sx < x + w - 1; sx += 3) ctx.fillRect(sx, y + 1, 1, h - 2);
      for (let sy = y + 3; sy < y + h - 1; sy += 3) ctx.fillRect(x + 1, sy, w - 2, 1);
      ctx.fillStyle = '#9fb4d0'; ctx.fillRect(x, y, w, 1);
      ctx.fillStyle = '#0e141e'; ctx.fillRect(x, y + h - 1, w, 1); ctx.fillRect(x + w - 1, y, 1, h);
      break;
    }
    case 'duct': {
      const { topW, topH } = drawPropBox(x, y, w, h, prop.height, '#b0b4b8');
      ctx.fillStyle = 'rgba(0,0,0,.30)';
      if (w >= h) for (let sx = x + 4; sx < x + topW - 1; sx += 5) ctx.fillRect(sx, y, 1, topH);
      else for (let sy = y + 4; sy < y + topH - 1; sy += 5) ctx.fillRect(x, sy, topW, 1);
      break;
    }
    case 'chimney': {
      const { topW, topH } = drawPropBox(x, y, w, h, prop.height, '#8c5240');
      ctx.fillStyle = 'rgba(255,255,255,.18)';
      for (let sy = y + 2; sy < y + topH; sy += 2) ctx.fillRect(x, sy, topW, 1);
      ctx.fillStyle = '#1e1a17'; ctx.fillRect(x + 1, y + 1, Math.max(1, topW - 2), Math.max(1, topH - 2));
      break;
    }
    case 'smokestack':
    case 'stack': {
      drawRoundPropShadow(cx, cy, radius, shadowLength);
      const body = ctx.createRadialGradient(cx - radius * 0.4, cy - radius * 0.4, 0, cx, cy, radius);
      body.addColorStop(0, '#c9c2b6'); body.addColorStop(1, '#5e5850');
      ctx.fillStyle = body; ctx.beginPath(); ctx.arc(cx, cy, radius, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#3a3632'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, radius - 0.5, 0, TAU); ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,.30)'; ctx.beginPath(); ctx.arc(cx, cy, radius * 0.78, 0, TAU); ctx.stroke();
      ctx.fillStyle = '#9c3a2c'; ctx.beginPath(); ctx.arc(cx, cy, radius * 0.62, 0, TAU); ctx.fill();
      ctx.fillStyle = '#141210'; ctx.beginPath(); ctx.arc(cx + 0.5, cy + 0.5, radius * 0.45, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.30)'; ctx.fillRect(Math.round(cx - radius * 0.5), Math.round(cy - radius * 0.62), Math.max(1, Math.round(radius * 0.5)), 1);
      break;
    }
    case 'dormer': {
      const front = Math.max(2, Math.round(h * 0.3)), capH = h - front;
      fillPolygon(buildingShadowPolygon(x, y, w, h, shadowLength), 'rgba(10,14,24,.32)');
      ctx.fillStyle = '#cfc4ae'; ctx.fillRect(x, y + capH, w, front);
      ctx.fillStyle = '#7fb2cc'; ctx.fillRect(x + Math.round(w * 0.3), y + capH, Math.max(2, Math.round(w * 0.4)), front - 1);
      ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(x, y + h - 1, w, 1);
      ctx.fillStyle = shade(roofColor, ROOF_PLANE_TONES.west); ctx.fillRect(x, y, w / 2, capH);
      ctx.fillStyle = shade(roofColor, ROOF_PLANE_TONES.east); ctx.fillRect(x + w / 2, y, w / 2, capH);
      ctx.strokeStyle = shade(roofColor, 0.42); ctx.lineWidth = 1; ctx.beginPath();
      ctx.moveTo(x + w / 2, y + 0.5); ctx.lineTo(x + w / 2, y + capH); ctx.stroke();
      break;
    }
    case 'helipad': {
      ctx.fillStyle = 'rgba(10,14,24,.25)'; ctx.fillRect(x + 1, y + 1, w, h);
      ctx.fillStyle = '#4a4f57'; ctx.fillRect(x, y, w, h);
      ctx.fillStyle = 'rgba(255,255,255,.14)'; ctx.fillRect(x, y, w, 1); ctx.fillRect(x, y, 1, h);
      ctx.strokeStyle = '#e8c547'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, cy, radius - 3, 0, TAU); ctx.stroke();
      ctx.fillStyle = '#eef0f2';
      ctx.fillRect(Math.round(cx) - 5, Math.round(cy) - 6, 2, 12); ctx.fillRect(Math.round(cx) + 3, Math.round(cy) - 6, 2, 12); ctx.fillRect(Math.round(cx) - 3, Math.round(cy) - 1, 6, 2);
      break;
    }
  }
}

function tracePolygon(points) {
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  ctx.closePath();
}
function fillPolygon(points, color) {
  ctx.fillStyle = color; ctx.beginPath(); tracePolygon(points); ctx.fill();
}
function buildingShadowPolygon(px, py, W, H, length) {
  return [[px, py], [px + W, py], [px + W + length, py + length],
          [px + W + length, py + H + length], [px + length, py + H + length], [px, py + H]];
}
function hipRoofPlanes(x, y, w, h) {
  const inset = Math.min(w, h) / 2;
  const ax = x + inset, ay = y + inset, bx = x + w - inset, by = y + h - inset;
  return {
    north: [[x, y], [x + w, y], [bx, ay], [ax, ay]],
    west:  [[x, y + h], [x, y], [ax, ay], [ax, by]],
    south: [[x + w, y + h], [x, y + h], [ax, by], [bx, by]],
    east:  [[x + w, y], [x + w, y + h], [bx, by], [bx, ay]],
  };
}
const ROOF_PLANE_TONES = { north: 0.22, west: 0.08, south: -0.18, east: -0.34 };
function gableRoofPlanes(x, y, w, h) {
  if (w >= h) {
    const ridgeY = y + h / 2;
    return {
      a: [[x, y], [x + w, y], [x + w, ridgeY], [x, ridgeY]],
      b: [[x, ridgeY], [x + w, ridgeY], [x + w, y + h], [x, y + h]],
      ridge: [[x, ridgeY], [x + w, ridgeY]],
    };
  }
  const ridgeX = x + w / 2;
  return {
    a: [[x, y], [ridgeX, y], [ridgeX, y + h], [x, y + h]],
    b: [[ridgeX, y], [x + w, y], [x + w, y + h], [ridgeX, y + h]],
    ridge: [[ridgeX, y], [ridgeX, y + h]],
  };
}
function drawBuildingShadows() {
  const casters = [];
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, vw, vh);
  for (const b of bldgs) {
    const px = b.x0 * T - camX, py = b.y0 * T - camY;
    const W = (b.x1 - b.x0 + 1) * T, H = (b.y1 - b.y0 + 1) * T;
    const length = b.lift * SHADOW_LENGTH_PER_LIFT;
    if (px + W + length < 0 || py + H + length < 0 || px > vw || py > vh) continue;
    ctx.rect(px, py, W, H);
    casters.push({ px, py, W, H, length });
  }
  ctx.clip('evenodd');
  for (const [lengthFactor, alpha] of [[1, 0.22], [0.5, 0.16]]) {
    ctx.fillStyle = `rgba(14,20,34,${alpha})`;
    ctx.beginPath();
    for (const c of casters) tracePolygon(buildingShadowPolygon(c.px, c.py, c.W, c.H, c.length * lengthFactor));
    ctx.fill();
  }
  ctx.restore();
}
function windowTone(b, column, floor) {
  const roll = hash2(b.h + column * 31, floor * 17 + 5) % 10;
  return WINDOW_TONES[roll === 0 ? 0 : roll < 3 ? 1 : roll < 5 ? 2 : 3];
}
const FACADE_MATERIALS = {
  house: ['brick', 'brickV'], apartment: ['brick', 'brickV'], shop: ['brick', 'brickV'],
  tower: ['panel', 'panelV'], warehouse: ['metal', 'metalH'], workshop: ['metal', 'metalH'],
  pagoda: ['brick', 'brickV'], chinashop: ['brick', 'brickV'],
};
function drawBuildingWalls(b, px, py, W, H, L) {
  const rw = W - L, rh = H - L;
  const tint = (buildingRandom(b.h ^ 0x51ed2701)() * 2 - 1) * 0.06;
  const [southMaterial, eastMaterial] = FACADE_MATERIALS[b.style];
  const faces = [
    { polygon: [[px, py + rh], [px + rw, py + rh], [px + W, py + H], [px, py + H]], tone: -0.38, material: southMaterial,
      fill: axisFiller(true, px, py + rh), length: rw, ground: [px, py + rh, px, py + H], columnSeed: 0 },
    { polygon: [[px + rw, py], [px + W, py], [px + W, py + H], [px + rw, py + rh]], tone: -0.58, material: eastMaterial,
      fill: axisFiller(false, px + rw, py), length: rh, ground: [px + rw, py, px + W, py], columnSeed: 97 },
  ];
  const layout = WALL_LAYOUT[b.style];
  const floors = layout ? Math.max(1, Math.floor((L - 3) / layout.floorHeight)) : 0;
  const windowDepth = layout ? Math.max(1, Math.min(layout.floorHeight - 2, L - 5)) : 0;
  for (const face of faces) {
    fillPolygon(face.polygon, shade(b.col, face.tone + tint));
    ctx.fillStyle = materialPattern(face.material); ctx.beginPath(); tracePolygon(face.polygon); ctx.fill();
    const groundShade = ctx.createLinearGradient(...face.ground);
    groundShade.addColorStop(0, 'rgba(0,0,0,0)'); groundShade.addColorStop(1, 'rgba(0,0,0,.18)');
    ctx.fillStyle = groundShade; ctx.beginPath(); tracePolygon(face.polygon); ctx.fill();
    if (!layout) continue;
    const columns = [];
    for (let along = 4; along <= face.length - layout.windowWidth - 3; along += layout.bay) columns.push(along);
    for (let floor = 0; floor < floors; floor++) {
      const offset = 2 + floor * layout.floorHeight;
      if (floor > 0) { ctx.fillStyle = 'rgba(255,255,255,.16)'; face.fill(0, offset - 2, face.length + offset - 2, 1); }
      ctx.fillStyle = 'rgba(0,0,0,.34)';
      for (const along of columns) face.fill(along, offset - 1, layout.windowWidth, 1);
      columns.forEach((along, column) => { ctx.fillStyle = windowTone(b, column + face.columnSeed, floor); face.fill(along, offset, layout.windowWidth, windowDepth); });
      ctx.fillStyle = 'rgba(255,255,255,.32)';
      for (const along of columns) face.fill(along, offset + windowDepth, layout.windowWidth, 1);
    }
  }
  ctx.fillStyle = 'rgba(0,0,0,.28)';
  ctx.fillRect(px, py + H - 2, W, 2); ctx.fillRect(px + W - 2, py, 2, H);
  ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(px + rw + 0.5, py + rh + 0.5); ctx.lineTo(px + W - 0.5, py + H - 0.5); ctx.stroke();
}
function pitchedRoofPlanes(shape, x, y, w, h) {
  if (shape === 'hip') {
    const planes = hipRoofPlanes(x, y, w, h), inset = Math.min(w, h) / 2;
    const ax = x + inset, ay = y + inset, bx = x + w - inset, by = y + h - inset;
    return {
      sides: ['north', 'west', 'south', 'east'].map(side => [side, planes[side]]),
      lines: [[[x, y], [ax, ay]], [[x + w, y], [bx, ay]], [[x, y + h], [ax, by]], [[x + w, y + h], [bx, by]], [[ax, ay], [bx, by]]],
    };
  }
  const planes = gableRoofPlanes(x, y, w, h);
  return { sides: w >= h ? [['north', planes.a], ['south', planes.b]] : [['west', planes.a], ['east', planes.b]], lines: [planes.ridge] };
}
function drawHouseRoof(x, y, w, h, color, shape) {
  const { sides, lines } = pitchedRoofPlanes(shape, x, y, w, h);
  for (const [side, plane] of sides) {
    fillPolygon(plane, shade(color, ROOF_PLANE_TONES[side]));
    ctx.fillStyle = materialPattern(side === 'north' || side === 'south' ? 'tilesH' : 'tilesV'); ctx.beginPath(); tracePolygon(plane); ctx.fill();
  }
  ctx.lineCap = 'round';
  for (const [strokeStyle, lineWidth, offset] of [['rgba(10,14,24,.45)', 1, 1.5], [shade(color, 0.42), 2, 0]]) {
    ctx.strokeStyle = strokeStyle; ctx.lineWidth = lineWidth; ctx.beginPath();
    for (const [[x1, y1], [x2, y2]] of lines) { ctx.moveTo(x1 + offset, y1 + offset); ctx.lineTo(x2 + offset, y2 + offset); }
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
  ctx.strokeStyle = 'rgba(10,8,6,.55)'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}
function drawPagodaRoof(x, y, w, h, color) {
  const left = x - 3, top = y - 3, right = x + w + 3, bottom = y + h + 3, middleX = x + w / 2, middleY = y + h / 2;
  ctx.fillStyle = shade(color, -0.3); ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.quadraticCurveTo(middleX, top + 3, right, top);
  ctx.quadraticCurveTo(right - 3, middleY, right, bottom);
  ctx.quadraticCurveTo(middleX, bottom - 3, left, bottom);
  ctx.quadraticCurveTo(left + 3, middleY, left, top);
  ctx.fill();
  drawHouseRoof(x + 2, y + 2, w - 4, h - 4, color, 'hip');
  const planes = hipRoofPlanes(x + 2, y + 2, w - 4, h - 4);
  ctx.strokeStyle = '#d4af37'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.beginPath();
  ctx.moveTo(...planes.north[3]); ctx.lineTo(...planes.south[3]);
  ctx.stroke(); ctx.lineCap = 'butt';
}
function southRoofZone(shape, roof) {
  if (roof.w < roof.h) return null;
  const ridge = Math.round(roof.h / 2), inset = shape === 'hip' ? Math.max(0, ridge - 3) : 0;
  const zone = { x: roof.x + inset, y: roof.y + ridge + 2, w: roof.w - 2 * inset, h: roof.h - ridge - 2 };
  return zone.w > 8 && zone.h > 8 ? zone : null;
}

const MATERIAL_TONES = { gravel: 0, tar: -0.36, panel: 0.06, metal: 0, tilesH: 0, tilesV: 0, brick: 0 };
const STYLE_ROOF = {
  apartment: {
    material: 'gravel', upperMaterial: 'tar', propDensity: 0.5,
    colors: ['#97928a', '#a29a8c', '#8c8a86', '#a8987e', '#8f9398', '#9c8d7c'],
    pool: [
      { type: 'stairHut', w: [20, 25], h: [17, 21], height: 10, max: 1 },
      { type: 'hvac', w: [14, 19], h: [10, 12], height: 5 },
      { type: 'hvac', w: [14, 19], h: [10, 12], height: 5 },
      { type: 'hvacBank', w: [30, 38], h: [11, 12], height: 5, max: 1 },
      { type: 'tank', w: [15, 19], h: [15, 19], height: 11, max: 1 },
      { type: 'vent', w: [5, 6], h: [5, 6], height: 3 },
      { type: 'vent', w: [5, 6], h: [5, 6], height: 3 },
      { type: 'antenna', w: [8, 10], h: [8, 10], height: 12, max: 2 },
      { type: 'dish', w: [8, 10], h: [8, 10], height: 4, max: 2 },
      { type: 'skylight', w: [8, 14], h: [6, 8], height: 1, max: 2 },
    ],
  },
  tower: {
    material: 'panel', upperMaterial: 'gravel', propDensity: 0.34,
    colors: ['#8a8f96', '#949089', '#7f868d', '#9a9a94', '#868c84'],
    pool: [
      { type: 'hvacBank', w: [32, 46], h: [11, 12], height: 5, max: 2 },
      { type: 'hvacBank', w: [11, 12], h: [32, 46], height: 5, max: 1 },
      { type: 'hvac', w: [14, 19], h: [10, 12], height: 5 },
      { type: 'stairHut', w: [18, 22], h: [16, 19], height: 10, max: 1 },
      { type: 'antenna', w: [9, 11], h: [9, 11], height: 16, max: 2 },
      { type: 'vent', w: [5, 7], h: [5, 7], height: 3 },
      { type: 'duct', w: [20, 34], h: [5, 5], height: 4, max: 2 },
      { type: 'duct', w: [5, 5], h: [20, 34], height: 4, max: 1 },
      { type: 'tank', w: [15, 19], h: [15, 19], height: 11, max: 1 },
    ],
  },
  shop: {
    material: 'tar', upperMaterial: 'tar', propDensity: 0.5, colors: ['#7a7a7c', '#857f76', '#76797f', '#8a8478'],
    pool: [
      { type: 'hvac', w: [11, 14], h: [8, 10], height: 4 },
      { type: 'hvac', w: [11, 14], h: [8, 10], height: 4 },
      { type: 'duct', w: [16, 28], h: [5, 5], height: 3, max: 2 },
      { type: 'duct', w: [5, 5], h: [16, 28], height: 3, max: 1 },
      { type: 'skylight', w: [10, 16], h: [7, 9], height: 1, max: 2 },
      { type: 'vent', w: [5, 6], h: [5, 6], height: 3 },
    ],
  },
  workshop: {
    material: 'metal', upperMaterial: 'metal', propDensity: 0.3, colors: ['#7d8288', '#86807a', '#8b9086', '#7a808c'],
    pool: [
      { type: 'vent', w: [6, 8], h: [6, 8], height: 4 },
      { type: 'stack', w: [10, 12], h: [10, 12], height: 14, max: 1 },
      { type: 'duct', w: [18, 30], h: [6, 6], height: 4, max: 2 },
      { type: 'duct', w: [6, 6], h: [18, 30], height: 4, max: 1 },
    ],
  },
  warehouse: {
    material: 'metal', upperMaterial: 'metal', propDensity: 0.14, colors: ['#6c757e', '#647a70', '#80725f', '#5d6f82', '#8a6a55', '#77797a'],
    pool: [{ type: 'vent', w: [7, 9], h: [7, 9], height: 4 }],
  },
  house: {
    material: 'tilesH', upperMaterial: 'tilesH', propDensity: 0, colors: ROOF_COLS,
    pool: [{ type: 'chimney', w: [5, 7], h: [5, 7], height: 6 }],
  },
  pagoda: {
    material: 'tilesH', upperMaterial: 'tilesH', propDensity: 0, colors: ['#a3322a', '#b23a2e', '#2f7a5c', '#348a66'],
    pool: [],
  },
  chinashop: {
    material: 'tar', upperMaterial: 'tar', propDensity: 0.4, colors: ['#7a6a60', '#86705e', '#6e6a66'],
    pool: [
      { type: 'hvac', w: [11, 14], h: [8, 10], height: 4 },
      { type: 'vent', w: [5, 6], h: [5, 6], height: 3 },
    ],
  },
};
function volumeRoof(volumes, index) {
  const volume = volumes[index], wall = volume.lift - (volume.parent < 0 ? 0 : volumes[volume.parent].lift);
  return { x: volume.x, y: volume.y, w: volume.w - wall, h: volume.h - wall };
}
function planVolumes(b, W, H, random) {
  const single = [{ x: 0, y: 0, w: W, h: H, lift: b.lift, parent: -1 }];
  let volumes = single;
  if (b.style === 'apartment' && random() < 0.6) {
    const step = 3 + Math.floor(random() * 3), baseLift = b.lift - step;
    const roofW = W - baseLift, roofH = H - baseLift;
    const coverage = 0.55 + random() * 0.25, side = Math.floor(random() * 4);
    const wingW = Math.round(roofW * coverage), wingH = Math.round(roofH * coverage);
    const wing = [
      { x: 0, y: 0, w: roofW, h: wingH },
      { x: 0, y: roofH - wingH, w: roofW, h: wingH },
      { x: 0, y: 0, w: wingW, h: roofH },
      { x: roofW - wingW, y: 0, w: wingW, h: roofH },
    ][side];
    volumes = [{ ...single[0], lift: baseLift }, { ...wing, lift: b.lift, parent: 0 }];
  } else if (b.style === 'shop' && random() < 0.3) {
    const baseLift = b.lift - 3, roofW = W - baseLift, roofH = H - baseLift;
    const back = ['north', 'west', 'east', 'south'][b.face] || 'north', alongX = back === 'north' || back === 'south';
    const roomW = Math.round(roofW * (alongX ? 0.35 + random() * 0.2 : 0.3 + random() * 0.15));
    const roomH = Math.round(roofH * (alongX ? 0.3 + random() * 0.15 : 0.35 + random() * 0.2));
    const slide = random();
    const room = {
      x: back === 'west' ? 3 : back === 'east' ? roofW - roomW - 3 : 3 + Math.round((roofW - roomW - 6) * slide),
      y: back === 'north' ? 3 : back === 'south' ? roofH - roomH - 3 : 3 + Math.round((roofH - roomH - 6) * slide),
      w: roomW, h: roomH, lift: b.lift, parent: 0,
    };
    volumes = [{ ...single[0], lift: baseLift }, room];
  } else if (b.style === 'tower') {
    const tiers = Math.min(W, H) - (b.lift - 8) >= 64 ? 3 : 2;
    const baseLift = b.lift - (tiers - 1) * 4, roofW = W - baseLift, roofH = H - baseLift;
    const inset = size => Math.round(size * (0.12 + random() * 0.13));
    const left = inset(roofW), right = inset(roofW), top = inset(roofH), bottom = inset(roofH);
    const terrace = { x: left, y: top, w: roofW - left - right, h: roofH - top - bottom, lift: baseLift + 4, parent: 0 };
    volumes = [{ ...single[0], lift: baseLift }, terrace];
    if (tiers === 3) {
      const terraceRoofW = terrace.w - 4, terraceRoofH = terrace.h - 4;
      const coreW = Math.round(terraceRoofW * (0.30 + random() * 0.15)), coreH = Math.round(terraceRoofH * (0.30 + random() * 0.15));
      const anchorX = Math.floor(random() * 3) / 2, anchorY = Math.floor(random() * 3) / 2;
      volumes.push({
        x: terrace.x + 4 + Math.round((terraceRoofW - coreW - 8) * anchorX), y: terrace.y + 4 + Math.round((terraceRoofH - coreH - 8) * anchorY),
        w: coreW, h: coreH, lift: b.lift, parent: 1,
      });
    }
  }
  const fits = volumes.every((volume, index) => {
    const roof = volumeRoof(volumes, index);
    if (roof.w < 6 || roof.h < 6) return false;
    if (volume.parent < 0) return true;
    const parentRoof = volumeRoof(volumes, volume.parent);
    return volume.x >= parentRoof.x && volume.y >= parentRoof.y
      && volume.x + volume.w <= parentRoof.x + parentRoof.w && volume.y + volume.h <= parentRoof.y + parentRoof.h;
  });
  return fits ? volumes : single;
}
function planRoofShape(b, random) {
  if (b.style === 'workshop') return random() < 0.5 ? 'sawtooth' : 'flat';
  if (b.style === 'warehouse') return 'metalGable';
  if (b.style === 'house') return random() < 0.55 ? 'hip' : 'gable';
  if (b.style === 'pagoda') return 'pagoda';
  return 'flat';
}
function planBuilding(b, W, H) {
  const random = buildingRandom(b.h);
  const volumes = planVolumes(b, W, H, random);
  const roofShape = planRoofShape(b, random);
  if (roofShape === 'pagoda') return { volumes, props: [], roofShape };
  const style = STYLE_ROOF[b.style];
  const roofs = volumes.map((volume, index) => volumeRoof(volumes, index));
  const reserved = volumes.map((volume, index) => volumes.filter(child => child.parent === index));
  if (roofShape === 'metalGable') {
    const roof = roofs[0];
    reserved[0].push(roof.w >= roof.h ? { x: roof.x, y: roof.y + Math.round(roof.h / 2) - 4, w: roof.w, h: 8 } : { x: roof.x + Math.round(roof.w / 2) - 4, y: roof.y, w: 8, h: roof.h });
  }
  const props = [];
  const placeOn = (index, pool, count, area = roofs[index]) => {
    for (const prop of planRoofProps(random, area, pool, count, reserved[index], props)) {
      props.push({ ...prop, volume: index });
      reserved[index].push(prop);
    }
  };
  if (b.style === 'house') {
    const zone = southRoofZone(roofShape, roofs[0]);
    if (zone && random() < 0.2) placeOn(0, [{ type: 'dormer', w: [9, 12], h: [8, 10], height: 3 }], 1, zone);
    if (zone && random() < 0.25) placeOn(0, [{ type: 'solar', w: [12, 18], h: [8, 11], height: 1 }], 1, zone);
    placeOn(0, style.pool, 1 + Math.floor(random() * 2));
    return { volumes, props, roofShape };
  }
  const freeArea = index => roofs[index].w * roofs[index].h - reserved[index].reduce((sum, rect) => sum + rect.w * rect.h, 0);
  const byFreeArea = volumes.map((volume, index) => index).sort((a, c) => freeArea(c) - freeArea(a));
  if (b.style === 'tower' && roofs[0].w >= 120 && roofs[0].h >= 120 && b.h % 3 === 0) {
    for (const index of byFreeArea) {
      placeOn(index, [{ type: 'helipad', w: [30, 30], h: [30, 30], height: 0 }], 1);
      if (props.length) break;
    }
  }
  if (b.district === INDUSTRIAL) placeOn(byFreeArea[0], [{ type: 'smokestack', w: [14, 16], h: [14, 16], height: 24, max: 1 }], 1);
  const minimum = roofs[0].w >= 64 && roofs[0].h >= 64 ? 3 : 0;
  const busyRoofFactor = Math.min(roofs[0].w, roofs[0].h) >= 96 ? 1.7 : 1;
  const count = Math.max(minimum, Math.round(style.propDensity * busyRoofFactor * roofs[0].w * roofs[0].h / 1000));
  const totalFree = volumes.reduce((sum, volume, index) => sum + freeArea(index), 0);
  const shares = volumes.map((volume, index) => Math.round(count * freeArea(index) / totalFree));
  volumes.forEach((volume, index) => placeOn(index, style.pool, shares[index]));
  for (const index of byFreeArea) if (props.length < minimum) placeOn(index, style.pool, minimum - props.length);
  return { volumes, props, roofShape };
}
function drawCornice(x, y, w, h, color) {
  if (w < 8 || h < 8) return;
  ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fillRect(x + 3, y + 3, w - 5, 3); ctx.fillRect(x + 3, y + 6, 3, h - 8);
  ctx.strokeStyle = 'rgba(0,0,0,.42)'; ctx.lineWidth = 1; ctx.strokeRect(x + 2.5, y + 2.5, w - 5, h - 5);
  ctx.fillStyle = shade(color, 0.30); ctx.fillRect(x, y, w, 2); ctx.fillRect(x, y, 2, h);
  ctx.fillStyle = shade(color, -0.35); ctx.fillRect(x, y + h - 2, w, 2); ctx.fillRect(x + w - 2, y + 2, 2, h - 2);
  ctx.fillStyle = 'rgba(0,0,0,.30)';
  for (let k = 6; k < w - 3; k += 6) { ctx.fillRect(x + k, y, 1, 2); ctx.fillRect(x + k, y + h - 2, 1, 2); }
  for (let k = 6; k < h - 3; k += 6) { ctx.fillRect(x, y + k, 2, 1); ctx.fillRect(x + w - 2, y + k, 2, 1); }
}
function sawtoothTeeth(w, h) {
  const alongX = w >= h, across = alongX ? h : w, count = Math.max(1, Math.ceil(across / 16));
  return Array.from({ length: count }, (unused, index) => {
    const start = Math.round(index * across / count), end = Math.round((index + 1) * across / count);
    return alongX ? { x: 0, y: start, w, h: end - start } : { x: start, y: 0, w: end - start, h };
  });
}
function axisFiller(alongX, x, y) {
  return (along, across, length, depth) => alongX ? ctx.fillRect(x + along, y + across, length, depth) : ctx.fillRect(x + across, y + along, depth, length);
}
function drawRoofEdge(x, y, w, h, color) {
  ctx.fillStyle = shade(color, 0.30); ctx.fillRect(x, y, w, 1); ctx.fillRect(x, y, 1, h);
  ctx.fillStyle = shade(color, -0.50); ctx.fillRect(x, y + h - 1, w, 1); ctx.fillRect(x + w - 1, y, 1, h);
}
function drawMetalRoof(b, x, y, w, h, color) {
  const alongX = w >= h, span = alongX ? w : h, depth = alongX ? h : w, band = axisFiller(alongX, x, y);
  const planes = gableRoofPlanes(x, y, w, h), random = buildingRandom(b.h ^ 0x2c1b3c6d);
  const ribs = materialPattern(alongX ? 'metal' : 'metalH');
  for (const [plane, side] of [[planes.a, alongX ? 'north' : 'west'], [planes.b, alongX ? 'south' : 'east']]) {
    fillPolygon(plane, shade(color, ROOF_PLANE_TONES[side]));
    ctx.fillStyle = ribs; ctx.beginPath(); tracePolygon(plane); ctx.fill();
  }
  const ridge = Math.round(depth / 2), period = 4 * (3 + Math.floor(random() * 3));
  for (let along = Math.round(period / 2); along < span - 6; along += period) {
    ctx.fillStyle = 'rgba(176,218,236,.55)'; band(along, 2, 3, ridge - 5); band(along, ridge + 3, 3, depth - ridge - 5);
    ctx.fillStyle = 'rgba(255,255,255,.40)'; band(along, 2, 1, ridge - 5); band(along, ridge + 3, 1, depth - ridge - 5);
    ctx.fillStyle = 'rgba(10,14,24,.30)'; band(along + 3, 2, 1, ridge - 5); band(along + 3, ridge + 3, 1, depth - ridge - 5);
  }
  for (let patch = 2 + Math.floor(random() * 5); patch > 0; patch--) {
    const radius = 3 + random() * Math.min(w, h) * 0.14, spotX = x + random() * w, spotY = y + random() * h;
    const rust = ctx.createRadialGradient(spotX, spotY, 0, spotX, spotY, radius);
    rust.addColorStop(0, 'rgba(150,76,28,.25)'); rust.addColorStop(1, 'rgba(150,76,28,0)');
    const left = Math.max(x, spotX - radius), top = Math.max(y, spotY - radius);
    ctx.fillStyle = rust; ctx.fillRect(left, top, Math.min(x + w, spotX + radius) - left, Math.min(y + h, spotY + radius) - top);
  }
  ctx.fillStyle = 'rgba(10,14,24,.30)'; band(0, ridge + 2, span, 2);
  ctx.fillStyle = shade(color, 0.10); band(0, ridge - 2, span, 4);
  ctx.fillStyle = shade(color, 0.40); band(0, ridge - 2, span, 1);
  ctx.fillStyle = shade(color, -0.45); band(0, ridge + 1, span, 1);
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  for (let slot = 2; slot < span - 2; slot += 3) band(slot, ridge - 1, 2, 2);
  drawRoofEdge(x, y, w, h, color);
}
function drawSawtoothRoof(b, x, y, w, h, color) {
  const alongX = w >= h, span = alongX ? w : h, ribs = materialPattern(alongX ? 'metal' : 'metalH'), band = axisFiller(alongX, x, y);
  sawtoothTeeth(w, h).forEach((tooth, index) => {
    const start = alongX ? tooth.y : tooth.x, depth = alongX ? tooth.h : tooth.w;
    const glass = Math.max(2, Math.round(depth * 0.32)), slope = depth - glass;
    ctx.fillStyle = shade(color, -0.12); band(0, start + glass, span, slope);
    ctx.fillStyle = ribs; band(0, start + glass, span, slope);
    const fade = alongX ? ctx.createLinearGradient(0, y + start + glass, 0, y + start + depth) : ctx.createLinearGradient(x + start + glass, 0, x + start + depth, 0);
    fade.addColorStop(0, 'rgba(255,255,255,.10)'); fade.addColorStop(1, 'rgba(8,12,20,.38)');
    ctx.fillStyle = fade; band(0, start + glass, span, slope);
    ctx.fillStyle = '#8cc2da'; band(0, start, span, glass);
    ctx.fillStyle = '#4a7a92';
    for (let mullion = 3; mullion < span - 1; mullion += 5) band(mullion, start, 1, glass);
    ctx.fillStyle = '#dff3fb'; band(0, start + glass - 1, span, 1);
    if (index > 0) { ctx.fillStyle = 'rgba(8,12,20,.42)'; band(0, start, span, Math.min(2, glass - 1)); }
    ctx.fillStyle = shade(color, 0.38); band(0, start + glass, span, 1);
    ctx.fillStyle = 'rgba(0,0,0,.55)'; band(0, start + depth - 1, span, 1);
  });
  drawRoofEdge(x, y, w, h, color);
}
function buildingRoofColor(b) {
  const palette = STYLE_ROOF[b.style].colors;
  return palette[(b.h >>> 7) % palette.length];
}
function drawVolume(b, volume, wall, ox, oy, roofMaterial, roofShape) {
  const x = ox + volume.x, y = oy + volume.y, roofW = volume.w - wall, roofH = volume.h - wall;
  const roofColor = buildingRoofColor(b);
  drawBuildingWalls(b, x, y, volume.w, volume.h, wall);
  if (roofShape === 'sawtooth') return drawSawtoothRoof(b, x, y, roofW, roofH, roofColor);
  if (roofShape === 'metalGable') return drawMetalRoof(b, x, y, roofW, roofH, roofColor);
  if (roofShape === 'hip' || roofShape === 'gable') return drawHouseRoof(x, y, roofW, roofH, roofColor, roofShape);
  if (roofShape === 'pagoda') return drawPagodaRoof(x, y, roofW, roofH, roofColor);
  const tone = (volume.lift - b.lift) * 0.015 + (MATERIAL_TONES[roofMaterial] || 0);
  drawRoofSurface(x, y, roofW, roofH, shade(roofColor, tone), roofMaterial);
  drawCornice(x, y, roofW, roofH, b.col);
}
function drawVolumeShadow(child, wall, parentRoof, ox, oy) {
  ctx.save();
  ctx.beginPath(); ctx.rect(ox + parentRoof.x, oy + parentRoof.y, parentRoof.w, parentRoof.h); ctx.clip();
  fillPolygon(buildingShadowPolygon(ox + child.x, oy + child.y, child.w, child.h, wall * SHADOW_LENGTH_PER_LIFT), 'rgba(10,14,24,.28)');
  ctx.restore();
}
function drawPlannedBuilding(b, px, py, W, H) {
  const { volumes, props, roofShape } = planBuilding(b, W, H);
  const style = STYLE_ROOF[b.style];
  const wallOf = volume => volume.lift - (volume.parent < 0 ? 0 : volumes[volume.parent].lift);
  const swapped = (b.h >>> 11) % 2 === 1;
  volumes.forEach((volume, index) => {
    const roof = volumeRoof(volumes, index);
    drawVolume(b, volume, wallOf(volume), px, py, (index === 0) !== swapped ? style.material : style.upperMaterial, index === 0 ? roofShape : 'flat');
    for (const child of volumes) if (child.parent === index) drawVolumeShadow(child, wallOf(child), roof, px, py);
    ctx.save();
    ctx.beginPath(); ctx.rect(px + roof.x, py + roof.y, roof.w, roof.h); ctx.clip();
    for (const prop of props) if (prop.volume === index) drawRoofProp(prop, px, py, buildingRoofColor(b));
    ctx.restore();
  });
  drawFacade(b, px, py, W, H, volumes[0].lift);
}

// ---------- Buildings: per-building drawing, pseudo-3D lit from the north-west ----------
// The roof is inset by `lift` px from the footprint: on the south and east sides the
// facade with its windows stays visible — the height effect of the old top-down driving
// games.
function drawBuildings() {
  for (const b of bldgs) {
    const px = b.x0 * T - camX, py = b.y0 * T - camY;
    const W = (b.x1 - b.x0 + 1) * T, H = (b.y1 - b.y0 + 1) * T;
    if (px + W < 0 || py + H < 0 || px > vw || py > vh) continue;
    drawPlannedBuilding(b, px, py, W, H);
  }
}
function drawChinaSigns(b, px, py, W, H, L) {
  if (b.face < 0) return;
  const sideways = b.face === 1 || b.face === 2, span = sideways ? H : W, thickness = b.face < 2 ? L : 5;
  for (let along = 8; along + 5 <= span - 3; along += 14) {
    const x = b.face === 1 ? px + W - L : sideways ? px : px + along;
    const y = b.face === 0 ? py + H - L : sideways ? py + along : py;
    const boardW = sideways ? thickness : 5, boardH = sideways ? 5 : thickness;
    ctx.fillStyle = '#e8c04a'; ctx.fillRect(x, y, boardW, boardH);
    ctx.fillStyle = '#b3261e'; ctx.fillRect(x + 1, y + 1, boardW - 2, boardH - 2);
  }
}
function drawChinaGatePillars(gate) {
  for (const pillar of [gate.left, gate.right]) {
    const x = pillar.x - camX, y = pillar.y - camY;
    ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(x - 4, y - 3, 12, 10);
    ctx.fillStyle = '#7a1914'; ctx.fillRect(x - 6, y - 6, 12, 12);
    ctx.fillStyle = '#b3261e'; ctx.fillRect(x - 4, y - 4, 8, 8);
    ctx.fillStyle = '#d4af37'; ctx.fillRect(x - 6, y - 6, 12, 2);
  }
}
function drawChinaGateBeam(gate) {
  const { left, right } = gate, padding = 40, rise = 22;
  if (Math.max(left.x, right.x) + padding < camX || Math.min(left.x, right.x) - padding > camX + vw
    || Math.max(left.y, right.y) + padding < camY || Math.min(left.y, right.y) - padding > camY + vh) return;
  const leftTop = { x: left.x - camX, y: left.y - camY - rise }, rightTop = { x: right.x - camX, y: right.y - camY - rise };
  ctx.save(); ctx.lineCap = 'round';
  const stroke = (color, width, from, to, dy = 0) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
    ctx.moveTo(from.x, from.y + dy); ctx.lineTo(to.x, to.y + dy); ctx.stroke();
  };
  for (const [top, base] of [[leftTop, left], [rightTop, right]]) stroke('#b3261e', 5, top, { x: base.x - camX, y: base.y - camY - 4 });
  stroke('#b3261e', 8, leftTop, rightTop);
  stroke('#d4af37', 2, leftTop, rightTop, 1);
  stroke('#2f7a5c', 4, leftTop, rightTop, -6);
  stroke('#d4af37', 1.5, leftTop, rightTop, -9);
  ctx.restore();
}
// Awning-shaded shopfront for shops/workshops, a main door for the rest — on the side
// that faces the street.
function drawFacade(b, px, py, W, H, L) {
  if (b.face < 0) return;
  if (b.style === 'chinashop') return drawChinaSigns(b, px, py, W, H, L);
  if (b.style === 'shop' || b.style === 'workshop') {
    const c1 = AWNING_COLS[b.h % AWNING_COLS.length], c2 = '#ece7db';
    if (b.face === 0) for (let sx = px + 2, k = 0; sx < px + W - 4; sx += 6, k++) { ctx.fillStyle = k & 1 ? c2 : c1; ctx.fillRect(sx, py + H - L - 2, 6, 6); }
    else if (b.face === 1) for (let sy = py + 2, k = 0; sy < py + H - L - 4; sy += 6, k++) { ctx.fillStyle = k & 1 ? c2 : c1; ctx.fillRect(px + W - L - 2, sy, 6, 6); }
    else if (b.face === 2) for (let sy = py + 2, k = 0; sy < py + H - 6; sy += 6, k++) { ctx.fillStyle = k & 1 ? c2 : c1; ctx.fillRect(px, sy, 5, 6); }
    else for (let sx = px + 2, k = 0; sx < px + W - 6; sx += 6, k++) { ctx.fillStyle = k & 1 ? c2 : c1; ctx.fillRect(sx, py, 6, 5); }
  } else {
    ctx.fillStyle = '#2b2622';
    if (b.face === 0) ctx.fillRect(px + W / 2 - 4, py + H - L + 1, 8, L - 2);
    else if (b.face === 1) ctx.fillRect(px + W - L + 1, py + H / 2 - 4, L - 2, 8);
    // North/west: the door stays hidden behind the roof.
  }
}
// Dashed centre lines along each road.
function drawMarkings() {
  ctx.save();
  ctx.strokeStyle = '#e8c84a'; ctx.lineWidth = 2; ctx.setLineDash([12, 14]); ctx.lineCap = 'butt';
  for (const e of edges) {
    const A = nodes[e.a], B = nodes[e.b];
    const minx = Math.min(A.x, B.x, e.cx) - 40, maxx = Math.max(A.x, B.x, e.cx) + 40;
    const miny = Math.min(A.y, B.y, e.cy) - 40, maxy = Math.max(A.y, B.y, e.cy) + 40;
    if (maxx < camX || minx > camX + vw || maxy < camY || miny > camY + vh) continue;
    const steps = Math.max(8, Math.ceil(e.len / (T * 0.6)));
    ctx.beginPath();
    for (let s = 0; s <= steps; s++) {
      const p = bez(A, B, e.cx, e.cy, s / steps);
      const sx = p.x - camX, sy = p.y - camY;
      if (s === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  }
  ctx.restore();
}
// Manholes, patches and oil stains scattered along the roads.
function drawRoadDecals() {
  for (const d of roadDeco) {
    const sx = d.x - camX, sy = d.y - camY;
    if (sx < -40 || sy < -40 || sx > vw + 40 || sy > vh + 40) continue;
    if (d.kind === 0) {                                // manhole
      ctx.fillStyle = '#23262b'; ctx.beginPath(); ctx.arc(sx, sy, 5.5, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.15)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sx, sy, 5.5, 0, TAU); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,.10)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sx - 3, sy); ctx.lineTo(sx + 3, sy); ctx.stroke();
    } else if (d.kind === 1) {                         // darker asphalt patch
      ctx.save(); ctx.translate(sx, sy); ctx.rotate(d.a);
      ctx.fillStyle = 'rgba(0,0,0,.16)'; ctx.fillRect(-16, -9, 32, 18);
      ctx.fillStyle = 'rgba(255,255,255,.04)'; ctx.fillRect(-16, -9, 32, 2);
      ctx.restore();
    } else {                                           // oil stain
      ctx.fillStyle = 'rgba(16,14,24,.18)';
      ctx.beginPath(); ctx.ellipse(sx, sy, 9, 6, d.a, 0, TAU); ctx.fill();
    }
  }
}
// Zebra crossings at the mouth of each junction.
function drawCrosswalks() {
  ctx.fillStyle = 'rgba(226,232,238,.75)';
  for (const c of crosswalks) {
    const sx = c.x - camX, sy = c.y - camY;
    if (sx < -90 || sy < -90 || sx > vw + 90 || sy > vh + 90) continue;
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(c.a);
    for (let off = -HALF_ROAD + 9; off <= HALF_ROAD - 9; off += 11) ctx.fillRect(-8, off - 2.5, 16, 5);
    ctx.restore();
  }
}

// ---------- Special buildings (drawing) ----------
function lmLabel(x, y, txt, col) {
  ctx.font = 'bold 12px Trebuchet MS'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillText(txt, x + 1, y + 1);
  ctx.fillStyle = col; ctx.fillText(txt, x, y);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}
function drawLandmarks() {
  for (const lm of landmarks) {
    const px = lm.x0 * T - camX, py = lm.y0 * T - camY;
    const w = (lm.x1 - lm.x0 + 1) * T, h = (lm.y1 - lm.y0 + 1) * T;
    if (px + w < -10 || py + h < -10 || px > vw + 10 || py > vh + 10) continue;
    const cx = px + w / 2, cy = py + h / 2;
    const base = { police: '#3e5a8a', hospital: '#e8e9ee', fire: '#b03a34', bank: '#9a8756', market: '#3f7d78', pizzeria: '#a8522e', gunshop: '#4a4f5c', army: '#4c5a3a' }[lm.type];
    ctx.fillStyle = base; ctx.fillRect(px, py, w, h);
    // Edge relief.
    ctx.fillStyle = 'rgba(255,255,255,.15)'; ctx.fillRect(px, py, w, 4); ctx.fillRect(px, py, 4, h);
    ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(px, py + h - 4, w, 4); ctx.fillRect(px + w - 4, py, 4, h);
    if (lm.type === 'hospital') {                     // helipad with a red cross
      ctx.fillStyle = '#c9ccd6'; ctx.beginPath(); ctx.arc(cx, cy + 4, h * 0.28, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#a2a6b2'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy + 4, h * 0.28, 0, TAU); ctx.stroke();
      const s = h * 0.30;
      ctx.fillStyle = '#d23434';
      ctx.fillRect(cx - s / 6, cy + 4 - s / 2, s / 3, s);
      ctx.fillRect(cx - s / 2, cy + 4 - s / 6, s, s / 3);
      lmLabel(cx, py + 12, t('lm.hospital'), '#d23434');
    } else if (lm.type === 'police') {                // yard and badge
      ctx.fillStyle = 'rgba(255,255,255,.10)'; ctx.fillRect(px + 8, py + 20, w - 16, h - 28);
      ctx.fillStyle = '#ffd23a'; ctx.beginPath(); ctx.arc(cx, cy + 6, 11, 0, TAU); ctx.fill();
      ctx.fillStyle = '#2a3f66'; ctx.beginPath(); ctx.arc(cx, cy + 6, 7, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ffd23a'; ctx.font = 'bold 9px Trebuchet MS'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('★', cx, cy + 6.5); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      lmLabel(cx, py + 12, t('lm.police'), '#fff');
    } else if (lm.type === 'fire') {                  // fire station: yellow stripes
      ctx.fillStyle = '#ffd23a';
      for (let i = 0; i < 3; i++) ctx.fillRect(px + 10, py + h - 14 - i * 9, w - 20, 4);
      lmLabel(cx, py + 12, t('lm.fire'), '#ffe9a0');
    } else if (lm.type === 'bank') {                  // bank: dollar medallion
      ctx.fillStyle = '#ffd23a'; ctx.beginPath(); ctx.arc(cx, cy + 4, 12, 0, TAU); ctx.fill();
      ctx.fillStyle = '#7a6420'; ctx.font = 'bold 15px Trebuchet MS'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('$', cx, cy + 5); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      lmLabel(cx, py + 12, t('lm.bank'), '#ffe9a0');
    } else if (lm.type === 'pizzeria') {              // pizzeria: giant pizza on the roof
      ctx.fillStyle = '#e8b04a'; ctx.beginPath(); ctx.arc(cx, cy + 5, 14, 0, TAU); ctx.fill();     // crust
      ctx.fillStyle = '#e8672a'; ctx.beginPath(); ctx.arc(cx, cy + 5, 10.5, 0, TAU); ctx.fill();   // tomato
      ctx.fillStyle = '#ffd23a';                                                                   // cheese
      for (let i = 0; i < 5; i++) {
        const a = i / 5 * TAU + 0.4;
        ctx.beginPath(); ctx.arc(cx + Math.cos(a) * 5.5, cy + 5 + Math.sin(a) * 5.5, 2.2, 0, TAU); ctx.fill();
      }
      lmLabel(cx, py + 12, t('lm.pizza'), '#ffe9a0');
    } else if (lm.type === 'gunshop') {               // gun shop: target on the roof
      ctx.fillStyle = '#f2f4f8'; ctx.beginPath(); ctx.arc(cx, cy + 5, 12, 0, TAU); ctx.fill();
      ctx.fillStyle = '#d23434'; ctx.beginPath(); ctx.arc(cx, cy + 5, 8, 0, TAU); ctx.fill();
      ctx.fillStyle = '#f2f4f8'; ctx.beginPath(); ctx.arc(cx, cy + 5, 4.5, 0, TAU); ctx.fill();
      ctx.fillStyle = '#d23434'; ctx.beginPath(); ctx.arc(cx, cy + 5, 1.8, 0, TAU); ctx.fill();
      lmLabel(cx, py + 12, t('lm.gunshop'), '#ffd9a0');
    } else if (lm.type === 'army') {                  // barracks: fenced compound
      drawArmyCompound(lm);
      // Fence along the perimeter (the walkable tiles are the gate: left open).
      ctx.strokeStyle = '#9aa0a8'; ctx.lineWidth = 2;
      for (let tx = lm.x0; tx <= lm.x1; tx++) for (const ty of [lm.y0, lm.y1]) {
        if (grid[gi(tx, ty)] !== BUILDING) continue;
        const sx = tx * T - camX, sy = ty * T - camY + T / 2;
        ctx.beginPath(); ctx.moveTo(sx, sy - 3); ctx.lineTo(sx + T, sy - 3);
        ctx.moveTo(sx, sy + 3); ctx.lineTo(sx + T, sy + 3); ctx.stroke();
        ctx.fillStyle = '#5a5f66'; ctx.fillRect(sx + T / 2 - 2, sy - 6, 4, 12);   // post
      }
      for (let ty = lm.y0; ty <= lm.y1; ty++) for (const tx of [lm.x0, lm.x1]) {
        if (grid[gi(tx, ty)] !== BUILDING) continue;
        const sx = tx * T - camX + T / 2, sy = ty * T - camY;
        ctx.beginPath(); ctx.moveTo(sx - 3, sy); ctx.lineTo(sx - 3, sy + T);
        ctx.moveTo(sx + 3, sy); ctx.lineTo(sx + 3, sy + T); ctx.stroke();
        ctx.fillStyle = '#5a5f66'; ctx.fillRect(sx - 6, sy + T / 2 - 2, 12, 4);   // post
      }
      lmLabel(cx, py + 12, t('lm.army'), '#d6e0b8');
    } else {                                          // market: ribbon skylights
      ctx.fillStyle = 'rgba(150,220,235,.28)';
      for (let i = 0; i < 3; i++) ctx.fillRect(px + 12 + i * ((w - 24) / 3), py + 22, (w - 24) / 3 - 6, h - 34);
      lmLabel(cx, py + 12, t('lm.market'), '#dff5ef');
    }
  }
}
function armyScreenRect(r) {
  return { x: r.x0 * T - camX, y: r.y0 * T - camY, w: (r.x1 - r.x0 + 1) * T, h: (r.y1 - r.y0 + 1) * T };
}
function drawArmyRoof(r, color) {
  const s = armyScreenRect(r);
  ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(s.x + 5, s.y + 6, s.w, s.h);
  ctx.fillStyle = color; ctx.fillRect(s.x, s.y, s.w, s.h);
  ctx.fillStyle = 'rgba(255,255,255,.13)'; ctx.fillRect(s.x, s.y, s.w, 3); ctx.fillRect(s.x, s.y, 3, s.h);
  ctx.fillStyle = 'rgba(0,0,0,.24)'; ctx.fillRect(s.x, s.y + s.h - 3, s.w, 3); ctx.fillRect(s.x + s.w - 3, s.y, 3, s.h);
  return s;
}
function drawArmyCompound(lm) {
  const layout = lm.layout;
  const fill = (r, color) => { const s = armyScreenRect(r); ctx.fillStyle = color; ctx.fillRect(s.x, s.y, s.w, s.h); return s; };
  fill(layout.interior, '#55584f');
  for (const lawn of layout.lawns) fill(lawn, '#56663c');

  const muster = fill(layout.musterYard, '#7b7d72');
  ctx.strokeStyle = 'rgba(240,236,210,.35)'; ctx.lineWidth = 1;
  for (let x = muster.x + T; x < muster.x + muster.w; x += T) {
    ctx.beginPath(); ctx.moveTo(x, muster.y + 8); ctx.lineTo(x, muster.y + muster.h - 8); ctx.stroke();
  }

  const lot = fill(layout.motorPool, '#45483f');
  ctx.strokeStyle = 'rgba(240,236,210,.55)'; ctx.lineWidth = 2;
  for (let x = lot.x; x <= lot.x + lot.w; x += T) {
    ctx.beginPath(); ctx.moveTo(x, lot.y + T); ctx.lineTo(x, lot.y + lot.h - T); ctx.stroke();
  }

  const pad = fill(layout.helipad, '#6c6e66');
  const padX = pad.x + pad.w / 2, padY = pad.y + pad.h / 2, padR = Math.min(pad.w, pad.h) * 0.4;
  ctx.fillStyle = '#7f8178'; ctx.beginPath(); ctx.arc(padX, padY, padR, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#e8d24a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(padX, padY, padR - 4, 0, TAU); ctx.stroke();
  ctx.fillStyle = '#f2f0e4'; ctx.font = 'bold 44px Trebuchet MS'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('H', padX, padY + 2);

  for (const block of layout.barracks) {
    const s = drawArmyRoof(block, '#6c7357');
    ctx.fillStyle = 'rgba(0,0,0,.16)'; ctx.fillRect(s.x, s.y + s.h / 2, s.w, s.h / 2);
    ctx.fillStyle = 'rgba(0,0,0,.30)'; ctx.fillRect(s.x, s.y + s.h / 2 - 1, s.w, 2);
    ctx.fillStyle = '#8d9188';
    for (let x = s.x + T; x < s.x + s.w - T / 2; x += 2 * T) ctx.fillRect(x - 5, s.y + 8, 10, 8);
  }

  const hq = drawArmyRoof(layout.headquarters, '#8a8873');
  ctx.strokeStyle = 'rgba(0,0,0,.18)'; ctx.lineWidth = 1; ctx.strokeRect(hq.x + 10.5, hq.y + 10.5, hq.w - 21, hq.h - 21);
  ctx.fillStyle = 'rgba(232,228,200,.85)'; ctx.beginPath(); ctx.arc(hq.x + hq.w / 2, hq.y + hq.h / 2, 16, 0, TAU); ctx.fill();
  ctx.fillStyle = '#4c5a3a'; ctx.font = 'bold 19px Trebuchet MS';
  ctx.fillText('★', hq.x + hq.w / 2, hq.y + hq.h / 2 + 1);
  ctx.strokeStyle = '#3a3d40'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(hq.x + hq.w - 22, hq.y + 14); ctx.lineTo(hq.x + hq.w - 10, hq.y + 14);
  ctx.moveTo(hq.x + hq.w - 16, hq.y + 8); ctx.lineTo(hq.x + hq.w - 16, hq.y + 20); ctx.stroke();

  const garage = drawArmyRoof(layout.garage, '#666c70');
  ctx.strokeStyle = 'rgba(0,0,0,.20)'; ctx.lineWidth = 1;
  for (let x = garage.x + 6; x < garage.x + garage.w; x += 6) {
    ctx.beginPath(); ctx.moveTo(x, garage.y + 3); ctx.lineTo(x, garage.y + garage.h - 3); ctx.stroke();
  }
  ctx.fillStyle = '#2f3234';
  for (let x = garage.x + T / 2; x < garage.x + garage.w - T; x += 2 * T) ctx.fillRect(x, garage.y - 2, T + 8, 5);

  const depot = drawArmyRoof(layout.depot, '#7a6a49');
  ctx.strokeStyle = 'rgba(0,0,0,.22)'; ctx.lineWidth = 1;
  for (let y = depot.y + 7; y < depot.y + depot.h; y += 7) {
    ctx.beginPath(); ctx.moveTo(depot.x + 3, y); ctx.lineTo(depot.x + depot.w - 3, y); ctx.stroke();
  }

  const flagX = layout.flagpole.x - camX, flagY = layout.flagpole.y - camY;
  ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(flagX + 2, flagY - 1, 30, 4);
  ctx.fillStyle = '#c9ccd2'; ctx.beginPath(); ctx.arc(flagX, flagY, 4, 0, TAU); ctx.fill();
  ctx.fillStyle = '#4a5d33';
  ctx.beginPath(); ctx.moveTo(flagX, flagY - 3); ctx.lineTo(flagX + 28, flagY - 11);
  ctx.lineTo(flagX + 28, flagY + 5); ctx.lineTo(flagX, flagY + 3); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#e8d24a'; ctx.font = 'bold 11px Trebuchet MS'; ctx.fillText('★', flagX + 15, flagY - 2);

  const booth = lm.guardDuties.find(duty => duty.post).post.booth;
  const boothX = booth.x - camX, boothY = booth.y - camY;
  ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(boothX - 7, boothY - 6, 18, 18);
  ctx.fillStyle = '#d8d4bf'; ctx.fillRect(boothX - 9, boothY - 9, 18, 18);
  ctx.fillStyle = '#4c5a3a'; ctx.fillRect(boothX - 9, boothY - 9, 18, 4);
  ctx.fillStyle = 'rgba(150,210,235,.55)'; ctx.fillRect(boothX - 6, boothY - 2, 12, 5);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}
// Turrets at the barracks corners: a sandbag nest plus a soldier with a machine gun that
// swings towards the intruder (the angle is cosmetic; authoritative fire comes from the
// sim in army.js).
function drawTurrets() {
  if (typeof turrets === 'undefined') return;
  for (const tr of turrets) {
    const sx = tr.x - camX, sy = tr.y - camY;
    if (sx < -30 || sy < -30 || sx > vw + 30 || sy > vh + 30) continue;
    const tp = turretTarget(tr);                      // target in range (or null)
    if (tp) tr.ang = steerToward(tr.ang, Math.atan2(tp.y - tr.y, tp.x - tr.x), 0.16);
    // Sandbag nest.
    ctx.fillStyle = '#6f6142';
    for (let i = 0; i < 7; i++) { const a = i / 7 * TAU; ctx.beginPath(); ctx.arc(sx + Math.cos(a) * 12, sy + Math.sin(a) * 12, 5, 0, TAU); ctx.fill(); }
    ctx.fillStyle = '#847252'; ctx.beginPath(); ctx.arc(sx, sy, 11, 0, TAU); ctx.fill();
    // Soldier on lookout.
    ctx.fillStyle = '#3d5226'; ctx.beginPath(); ctx.arc(sx, sy, 6, 0, TAU); ctx.fill();
    ctx.fillStyle = '#2a2a1e'; ctx.beginPath(); ctx.arc(sx, sy, 3.4, 0, TAU); ctx.fill();
    // Machine gun.
    const a = tr.ang;
    ctx.strokeStyle = '#3a3f36'; ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + Math.cos(a) * 19, sy + Math.sin(a) * 19); ctx.stroke();
    if (tp) { ctx.fillStyle = '#ffd24a'; ctx.beginPath(); ctx.arc(sx + Math.cos(a) * 20, sy + Math.sin(a) * 20, 2.2, 0, TAU); ctx.fill(); }
  }
}
// Pulsing cross in front of hospitals: step on it to heal.
function drawHealPads() {
  for (const lm of landmarks) {
    if (lm.type !== 'hospital') continue;
    const x = lm.door.x - camX, y = lm.door.y - camY;
    if (x < -40 || y < -40 || x > vw + 40 || y > vh + 40) continue;
    const pr = 14 + Math.sin(frame * 0.1) * 2;
    ctx.fillStyle = 'rgba(240,244,248,.85)'; ctx.beginPath(); ctx.arc(x, y, pr, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(210,52,52,.7)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, pr + 4, 0, TAU); ctx.stroke();
    ctx.fillStyle = '#d23434'; ctx.fillRect(x - 2.5, y - 8, 5, 16); ctx.fillRect(x - 8, y - 2.5, 16, 5);
  }
}
// Pulsing pad in front of gun shops: walk up to see the price list.
function drawGunPads() {
  for (const lm of landmarks) {
    if (lm.type !== 'gunshop') continue;
    const x = lm.door.x - camX, y = lm.door.y - camY;
    if (x < -40 || y < -40 || x > vw + 40 || y > vh + 40) continue;
    const pr = 14 + Math.sin(frame * 0.1) * 2;
    ctx.fillStyle = 'rgba(30,32,40,.85)'; ctx.beginPath(); ctx.arc(x, y, pr, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(255,210,58,.7)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, pr + 4, 0, TAU); ctx.stroke();
    ctx.font = '14px Trebuchet MS'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('🔫', x, y + 1);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }
}
// Gun-shop price list: appears when you are on the pad, on foot.
function drawGunshopMenu() {
  if (peaceMode()) return;                            // violence filter: the gun shop sells nothing
  if (!nearGunshop()) return;
  ctx.font = 'bold 14px Trebuchet MS';
  const title = t(usingTouch ? 'shop.titleTouch' : 'shop.titleKb');
  const rows = WEAPONS.map((w, i) => `${i + 1} · ${w.icon} ${wName(w)} — ` +
    (player.owned[i] ? t(i === player.weaponIdx ? 'shop.inUse' : 'shop.owned') : `$${w.price}`));
  let wmax = ctx.measureText(title).width;
  for (const r of rows) wmax = Math.max(wmax, ctx.measureText(r).width);
  const bw = wmax + 36, bh = 40 + rows.length * 22 + 8, bx = vw / 2 - bw / 2, by = 96;
  ctx.fillStyle = 'rgba(10,12,18,.82)'; roundRect(bx, by, bw, bh, 12); ctx.fill();
  ctx.strokeStyle = 'rgba(255,210,58,.55)'; ctx.lineWidth = 2; roundRect(bx, by, bw, bh, 12); ctx.stroke();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd23a'; ctx.fillText(title, vw / 2, by + 24);
  ctx.textAlign = 'left';
  for (let i = 0; i < rows.length; i++) {
    ctx.fillStyle = player.owned[i] ? (i === player.weaponIdx ? '#5ee06a' : '#dfe4ec')
                  : (cash >= WEAPONS[i].price ? '#ffd23a' : '#8a8f9a');
    ctx.fillText(rows[i], bx + 18, by + 48 + i * 22);
  }
}
// Arrow orbiting the vehicle + beacon on the destination + mission panel at the top:
// guidance shared by the taxi and pizza-delivery missions.
function drawTaxiGuide() {
  if (!taxiActive()) return;
  const msg = taxi.phase !== 'ride' ? null
            : taxi.timer > 0 ? t('taxi.boxTip', { pay: taxi.pay, s: Math.ceil(taxi.timer / 60) })
                             : t('taxi.boxNoTip', { pay: taxi.pay });
  drawGuide(taxiTarget(), taxi.phase === 'pickup' ? '#ffd23a' : '#5ee06a', msg);
}
function drawPizzaGuide() {
  if (!pizzaActive()) return;
  const msg = pizza.phase !== 'deliver' ? null
            : pizza.timer > 0 ? t('pizza.boxTip', { pay: pizza.pay, s: Math.ceil(pizza.timer / 60) })
                              : t('pizza.boxNoTip', { pay: pizza.pay });
  drawGuide(pizzaTarget(), pizza.phase === 'pickup' ? '#ff8a3a' : '#ff5a5a', msg);
}
// Fires: scorched halo on the ground + flickering tongues of flame.
function drawFires() {
  for (const f of fires) {
    const x = f.x - camX, y = f.y - camY;
    if (x < -80 || y < -80 || x > vw + 80 || y > vh + 80) continue;
    const k = clamp(f.hp / 140, 0.3, 1);              // flames drop lower as it burns out
    ctx.fillStyle = 'rgba(20,16,14,.55)'; ctx.beginPath(); ctx.arc(x, y, f.r + 6, 0, TAU); ctx.fill();
    for (let i = 0; i < 4; i++) {
      const fx = x + Math.cos(f.seed + i * 1.7) * 11, fy = y + Math.sin(f.seed + i * 2.3) * 8;
      const fl = (Math.sin(frame * 0.31 + i * 1.9) + 1.6) * 3 * k;
      ctx.fillStyle = 'rgba(255,90,42,.85)';  ctx.beginPath(); ctx.arc(fx, fy, 8 * k + fl, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,138,42,.9)';  ctx.beginPath(); ctx.arc(fx, fy + 1, 5.5 * k + fl * 0.6, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,210,58,.95)'; ctx.beginPath(); ctx.arc(fx, fy + 2, 3 * k + fl * 0.35, 0, TAU); ctx.fill();
    }
    // Extinguishing bar above the fire (only during the mission).
    if (firejob.site === f) {
      const bw = 44, bx = x - bw / 2, by = y - f.r - 18;
      ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(bx - 1, by - 1, bw + 2, 7);
      ctx.fillStyle = '#ff8a2a'; ctx.fillRect(bx, by, bw * clamp(f.hp / 140, 0, 1), 5);
    }
  }
}
// Hydrant jet.
function drawWater() {
  for (const w of water) {
    ctx.globalAlpha = clamp(w.life / 18, 0.25, 0.85);
    ctx.fillStyle = '#5ab8ff'; ctx.beginPath(); ctx.arc(w.x - camX, w.y - camY, 2.6, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;
}
function drawFireGuide() {
  if (!firejobActive()) return;
  drawGuide(firejob.site, '#ff8a2a', t('fire.box', { pay: firejob.pay, s: Math.ceil(firejob.timer / 60) }));
}
function drawRescueGuide() {
  if (!rescueActive()) return;
  const msg = rescue.phase !== 'deliver' ? null
            : rescue.timer > 0 ? t('rescue.boxTip', { pay: rescue.pay, s: Math.ceil(rescue.timer / 60) })
                               : t('rescue.boxNoTip', { pay: rescue.pay });
  drawGuide(rescueTarget(), rescue.phase === 'pickup' ? '#ff6a6a' : '#6ad0ff', msg);
}
function drawPatrolGuide() {
  if (!patrolActive()) return;
  const msg = t('patrol.box', { pay: patrol.pay, s: Math.ceil(patrol.timer / 60) });
  drawGuide(patrol.robber, '#4a8aff', msg);
}
function drawGuide(tgt, col, msg) {
  if (!tgt) return;
  const pxs = player.x - camX, pys = player.y - camY;
  const a = Math.atan2(tgt.y - player.y, tgt.x - player.x);
  const d = dist(player.x, player.y, tgt.x, tgt.y);
  const or = 46 + Math.sin(frame * 0.15) * 3;
  const ax = pxs + Math.cos(a) * or, ay = pys + Math.sin(a) * or;
  ctx.save(); ctx.translate(ax, ay); ctx.rotate(a);
  ctx.fillStyle = col; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(11, 0); ctx.lineTo(-7, -8); ctx.lineTo(-3, 0); ctx.lineTo(-7, 8); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.restore();
  ctx.font = 'bold 11px Trebuchet MS'; ctx.textAlign = 'center';
  const txt = t('hud.meters', { d: Math.round(d / 10) });
  ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillText(txt, ax + 1, ay + 21);
  ctx.fillStyle = '#fff'; ctx.fillText(txt, ax, ay + 20);
  ctx.textAlign = 'left';
  // Pulsing beacon on the destination point.
  const bx = tgt.x - camX, by = tgt.y - camY;
  if (bx > -60 && by > -60 && bx < vw + 60 && by < vh + 60) {
    const pr = 26 + Math.sin(frame * 0.12) * 6;
    ctx.strokeStyle = col; ctx.globalAlpha = 0.8; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(bx, by, pr, 0, TAU); ctx.stroke();
    ctx.globalAlpha = 0.15; ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(bx, by, pr, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
  }
  // Mission panel, top centre.
  if (msg) {
    ctx.font = 'bold 14px Trebuchet MS'; ctx.textAlign = 'center';
    const tw = ctx.measureText(msg).width;
    ctx.fillStyle = 'rgba(0,0,0,.55)'; roundRect(vw / 2 - tw / 2 - 12, 10, tw + 24, 26, 13); ctx.fill();
    ctx.fillStyle = '#ffd23a'; ctx.fillText(msg, vw / 2, 28);
    ctx.textAlign = 'left';
  }
}
// ---------- Multiplayer: arrows pointing at the other players ----------
// There are no jobs in multiplayer: in their place an always-visible coloured arrow points
// at each rival — so you can find each other (and fight!) in the big city. Each one takes
// the colour of that rival's shirt.
function drawPlayerArrows() {
  if (!netActive()) return;
  const pxs = player.x - camX, pys = player.y - camY;
  for (const g of net.players.values()) {
    if (g.down) continue;                          // down: they will be back shortly
    const d = dist(player.x, player.y, g.x, g.y);
    if (d < 30) continue;                          // right on top of them: no frantic arrow
    const a = Math.atan2(g.y - player.y, g.x - player.x);
    const or = 46 + Math.sin(frame * 0.15) * 3;
    const ax = pxs + Math.cos(a) * or, ay = pys + Math.sin(a) * or;
    ctx.save(); ctx.translate(ax, ay); ctx.rotate(a);
    ctx.fillStyle = g.shirt; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(11, 0); ctx.lineTo(-7, -8); ctx.lineTo(-3, 0); ctx.lineTo(-7, 8); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
    ctx.font = 'bold 11px Trebuchet MS'; ctx.textAlign = 'center';
    const txt = t('hud.meters', { d: Math.round(d / 10) });
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillText(txt, ax + 1, ay + 21);
    ctx.fillStyle = '#fff'; ctx.fillText(txt, ax, ay + 20);
    ctx.textAlign = 'left';
  }
}

function drawShadow(x, y, w, h) { ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.beginPath(); ctx.ellipse(x, y, w, h, 0, 0, TAU); ctx.fill(); }

function drawDecals() {
  for (const d of decals) {
    ctx.globalAlpha = clamp(d.life / (60 * 6), 0, 0.6);
    ctx.fillStyle = '#7a1620'; ctx.beginPath(); ctx.arc(d.x - camX, d.y - camY, d.r, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
  }
}
function drawPickups() {
  for (const k of pickups) {
    const x = k.x - camX, y = k.y - camY - Math.sin(k.t) * 2;
    ctx.globalAlpha = k.life < 90 ? clamp(k.life / 90, 0, 1) : 1;
    ctx.fillStyle = '#2fbf4a'; roundRect(x - 8, y - 6, 16, 12, 3); ctx.fill();
    ctx.fillStyle = '#1a8a30'; ctx.font = 'bold 11px Trebuchet MS'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('$', x, y + 1);
    ctx.globalAlpha = 1; ctx.textBaseline = 'alphabetic';
  }
}
function drawCoins() {
  for (const k of coins) {
    const x = k.x - camX, y = k.y - camY - Math.sin(k.bob) * 2;
    if (x < -20 || y < -20 || x > vw + 20 || y > vh + 20) continue;
    const sw = Math.abs(Math.cos(k.spin));            // varying width → a spinning coin
    drawShadow(x, y + 7, 6, 2.5);
    ctx.fillStyle = '#b8860b'; ctx.beginPath(); ctx.ellipse(x, y + 1.5, 7 * sw + 1.5, 8.5, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ffd23a'; ctx.beginPath(); ctx.ellipse(x, y, 7 * sw + 1, 8, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ffe98a'; ctx.beginPath(); ctx.ellipse(x, y, Math.max(0, 7 * sw - 1.5), 6, 0, 0, TAU); ctx.fill();
    if (sw > 0.35) {
      ctx.fillStyle = '#a9770a'; ctx.font = 'bold 9px Trebuchet MS'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('€', x, y + 0.5);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
  }
}
// ---------- Traffic lights (drawing) — only at signalled junctions ----------
function drawTrafficLights() {
  const col = { green: '#37e05a', yellow: '#ffd23a', red: '#ff4040' }, o = HALF_ROAD * 0.72;
  for (const nd of nodes) {
    if (!nd.signal) continue;
    const x = nd.x - camX, y = nd.y - camY;
    if (x < -30 || y < -30 || x > vw + 30 || y > vh + 30) continue;
    signalHead(x - o, y, hState, col, true);    // heads for the horizontal axis (E/W)
    signalHead(x + o, y, hState, col, true);
    signalHead(x, y - o, vState, col, false);   // heads for the vertical axis (N/S)
    signalHead(x, y + o, vState, col, false);
  }
}
function signalHead(x, y, state, col, horiz) {
  const order = ['red', 'yellow', 'green'];
  const w = horiz ? 15 : 7, h = horiz ? 7 : 15;
  ctx.save(); ctx.translate(x, y);
  ctx.fillStyle = 'rgba(0,0,0,.45)'; roundRect(-w / 2, -h / 2 + 1.5, w + 2, h + 2, 2.5); ctx.fill();
  ctx.fillStyle = '#16181e'; roundRect(-w / 2, -h / 2, w, h, 2.5); ctx.fill();
  for (let i = 0; i < 3; i++) {
    const key = order[i], on = key === state;
    const off = key === 'red' ? '#401414' : key === 'yellow' ? '#3d3810' : '#123d1c';
    const t = (i - 1) * 4.5, lx = horiz ? t : 0, ly = horiz ? 0 : t;
    ctx.fillStyle = on ? col[key] : off; ctx.beginPath(); ctx.arc(lx, ly, 2, 0, TAU); ctx.fill();
    if (on) { ctx.globalAlpha = 0.45; ctx.beginPath(); ctx.arc(lx, ly, 4, 0, TAU); ctx.fill(); ctx.globalAlpha = 1; }
  }
  ctx.restore();
}

// Motorbike seen from above: in-line wheels, tank, helmeted rider and (for deliveries)
// the pizza top box behind the seat.
function drawBike(c) {
  const x = c.x - camX, y = c.y - camY;
  drawVehicleShadow(x - 1, y - 1, c.angle, c.w / 2 - 3, 4, 4);
  ctx.save();
  ctx.translate(x, y); ctx.rotate(c.angle);
  const hw = c.w / 2;
  // Wheels.
  ctx.fillStyle = '#1a1a1e';
  roundRect(hw - 8, -2.5, 8, 5, 2); ctx.fill();
  roundRect(-hw, -2.5, 8, 5, 2); ctx.fill();
  // Frame + tank.
  ctx.fillStyle = c.color; roundRect(-hw + 5, -3.5, c.w - 12, 7, 3); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1.2; roundRect(-hw + 5, -3.5, c.w - 12, 7, 3); ctx.stroke();
  // Handlebars and headlight.
  ctx.strokeStyle = '#222'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(hw - 9, -7); ctx.lineTo(hw - 9, 7); ctx.stroke();
  ctx.fillStyle = '#ffe9a0'; ctx.fillRect(hw - 2, -2, 3, 4);
  // Pizza top box (with a slice drawn on the lid).
  if (c.isDelivery) {
    ctx.fillStyle = '#b02828'; roundRect(-hw + 1, -5.5, 11, 11, 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1; roundRect(-hw + 1, -5.5, 11, 11, 2); ctx.stroke();
    ctx.fillStyle = '#ffe9a0';
    ctx.beginPath(); ctx.moveTo(-hw + 3.5, 3); ctx.lineTo(-hw + 9.5, 3); ctx.lineTo(-hw + 6.5, -3.5); ctx.closePath(); ctx.fill();
  }
  // Rider (torso + helmet) — only if the bike is not parked empty.
  if (c.driver === 'player' || c.role === 'traffic' || c.role === 'police') {
    ctx.fillStyle = c.driver === 'player' ? player.shirt : c.riderShirt; ctx.beginPath(); ctx.arc(-3, 0, 5.5, 0, TAU); ctx.fill();
    ctx.fillStyle = c.helmet; ctx.beginPath(); ctx.arc(0.5, 0, 4.2, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(150,210,255,.85)'; ctx.fillRect(3, -2.5, 2.5, 5);   // visor
  }
  ctx.restore();
  if (c.burning) drawCarFlames(c);
}
// Flames anchored to a burning vehicle: particles alone lag behind when it speeds along,
// whereas these travel glued to the bodywork.
function drawCarFlames(c) {
  const x = c.x - camX, y = c.y - camY, ca = Math.cos(c.angle), sa = Math.sin(c.angle);
  for (let i = 0; i < 3; i++) {
    const t = (i - 1) * c.w * 0.28;
    const fx = x + ca * t, fy = y + sa * t;
    const h = 7 + Math.sin(frame * 0.31 + c.burnSeed + i * 2.1) * 3;
    ctx.fillStyle = '#ff8a2a';
    ctx.beginPath(); ctx.moveTo(fx - 5, fy + 2); ctx.quadraticCurveTo(fx, fy - h * 1.6, fx + 5, fy + 2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ffd23a';
    ctx.beginPath(); ctx.moveTo(fx - 2.5, fy + 2); ctx.quadraticCurveTo(fx, fy - h, fx + 2.5, fy + 2); ctx.closePath(); ctx.fill();
  }
}
// Tank seen from above: rolling tracks, hull, and a turret whose gun rotates (independently
// of the hull) towards the crosshair.
function drawTank(c) {
  const x = c.x - camX, y = c.y - camY;
  drawVehicleShadow(x, y, c.angle, c.w / 2, c.h / 2 - 1, 4);
  ctx.save();
  ctx.translate(x, y); ctx.rotate(c.angle);
  const hw = c.w / 2, hh = c.h / 2;
  // Tracks.
  ctx.fillStyle = '#2e3326';
  roundRect(-hw, -hh, c.w, 9, 4); ctx.fill();
  roundRect(-hw, hh - 9, c.w, 9, 4); ctx.fill();
  // Track links: they scroll as the tank moves.
  c.treadRoll = ((c.treadRoll || 0) + c.speed + 9) % 9;
  ctx.fillStyle = 'rgba(0,0,0,.4)';
  for (let i = 0; i < 7; i++) {
    const tx = -hw + 3 + ((i * 9 + c.treadRoll) % (c.w - 6));
    ctx.fillRect(tx, -hh + 1.5, 2.5, 6); ctx.fillRect(tx, hh - 7.5, 2.5, 6);
  }
  // Hull.
  ctx.fillStyle = c.color; roundRect(-hw + 3, -hh + 6, c.w - 6, c.h - 12, 4); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1.5; roundRect(-hw + 3, -hh + 6, c.w - 6, c.h - 12, 4); ctx.stroke();
  // Turret and gun.
  ctx.rotate((c.turretA != null ? c.turretA : c.angle) - c.angle);
  ctx.fillStyle = '#39452c'; ctx.fillRect(7, -2.5, hw + 9, 5);              // barrel
  ctx.fillStyle = '#2c3622'; ctx.fillRect(hw + 12, -3.5, 5, 7);             // muzzle brake
  ctx.fillStyle = shade(c.color, -0.14); ctx.beginPath(); ctx.arc(0, 0, 9.5, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(0, 0, 9.5, 0, TAU); ctx.stroke();
  // Military star on the turret.
  ctx.fillStyle = '#e8e4c8'; ctx.font = 'bold 9px Trebuchet MS'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('★', 0, 0.5); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.restore();
  if (c.burning) drawCarFlames(c);
}
const GLASS_COLOR = '#18202c';
const BRAKE_DECELERATION = 0.03;

function drawVehicleShadow(x, y, angle, halfLength, halfWidth, radius) {
  ctx.save();
  ctx.translate(x + 3, y + 4); ctx.rotate(angle);
  ctx.fillStyle = 'rgba(0,0,0,.16)'; roundRect(-halfLength - 1, -halfWidth - 1, halfLength * 2 + 2, halfWidth * 2 + 2, radius + 1); ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,.14)'; roundRect(-halfLength + 1, -halfWidth + 1, halfLength * 2 - 2, halfWidth * 2 - 2, radius); ctx.fill();
  ctx.restore();
}
function bodyPaint(color, angle, hw, hh) {
  const lightX = -Math.cos(angle) - Math.sin(angle), lightY = Math.sin(angle) - Math.cos(angle);
  const paint = ctx.createLinearGradient(lightX * hw * 0.5, lightY * hh, -lightX * hw * 0.5, -lightY * hh);
  paint.addColorStop(0, shade(color, 0.22)); paint.addColorStop(0.45, color); paint.addColorStop(1, shade(color, -0.28));
  return paint;
}
function drawTyres(hw, hh) {
  ctx.fillStyle = '#111215';
  for (const axleX of [hw - 11, -hw + 9]) { ctx.fillRect(axleX - 4, -hh - 1, 8, 3); ctx.fillRect(axleX - 4, hh - 2, 8, 3); }
}
function drawGlassGlint(frontX, backX, hh) {
  fillPolygon([[backX + 1, -hh + 4], [backX + 3, -hh + 4], [frontX - 1, hh - 6], [frontX - 3, hh - 6]], 'rgba(190,220,255,.30)');
}
function drawSaloonCabin(c, hw, hh, roofPaint) {
  ctx.fillStyle = GLASS_COLOR; roundRect(-hw + 9, -hh + 2.5, c.w - 20, c.h - 5, 4); ctx.fill();
  drawGlassGlint(hw - 11, hw - 17, hh);
  ctx.fillStyle = roofPaint; roundRect(-hw + 13, -hh + 4.5, c.w - 30, c.h - 9, 3); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 1; roundRect(-hw + 13, -hh + 4.5, c.w - 30, c.h - 9, 3); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.fillRect(-hw + 4, -hh + 2, c.w - 8, 1.2);
  ctx.fillStyle = 'rgba(0,0,0,.14)'; ctx.fillRect(hw - 10, -0.5, 7, 1);
  ctx.fillStyle = c.color; ctx.fillRect(hw - 15, -hh - 1.5, 2.5, 2); ctx.fillRect(hw - 15, hh - 0.5, 2.5, 2);
}
function drawVanCabin(c, hw, hh) {
  ctx.fillStyle = GLASS_COLOR; roundRect(hw - 12, -hh + 2.5, 5, c.h - 5, 2); ctx.fill();
  drawGlassGlint(hw - 7, hw - 12, hh);
  ctx.fillStyle = shade(c.color, 0.08); ctx.fillRect(-hw + 2, -hh + 2, c.w - 18, c.h - 4);
  ctx.fillStyle = 'rgba(0,0,0,.07)';
  for (let ribX = -hw + 6; ribX < hw - 17; ribX += 6) ctx.fillRect(ribX, -hh + 2, 1, c.h - 4);
  ctx.fillStyle = 'rgba(0,0,0,.30)'; ctx.fillRect(hw - 16, -hh + 2, 1.5, c.h - 4);
  ctx.fillStyle = c.color; ctx.fillRect(hw - 10, -hh - 1.5, 2.5, 2); ctx.fillRect(hw - 10, hh - 0.5, 2.5, 2);
}
function drawCarLights(c, hw, hh) {
  ctx.fillStyle = '#fff4cc';
  roundRect(hw - 3, -hh + 2.5, 3, 5, 1.2); ctx.fill(); roundRect(hw - 3, hh - 7.5, 3, 5, 1.2); ctx.fill();
  const speed = Math.abs(c.speed || 0);
  const occupied = c.driver || c.role !== 'parked';
  const braking = occupied && (speed < 0.05 || speed < (c.lastDrawnSpeed ?? speed) - BRAKE_DECELERATION);
  c.lastDrawnSpeed = speed;
  if (braking) {
    ctx.fillStyle = 'rgba(255,40,30,.28)';
    ctx.beginPath(); ctx.arc(-hw - 1, -hh + 5, 4.5, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(-hw - 1, hh - 5, 4.5, 0, TAU); ctx.fill();
  }
  ctx.fillStyle = braking ? '#ff4a3a' : '#9a1a1e';
  ctx.fillRect(-hw + 0.5, -hh + 2.5, 2.5, 5); ctx.fillRect(-hw + 0.5, hh - 7.5, 2.5, 5);
}
function drawCar(c) {
  if (c.isBike) { drawBike(c); return; }
  if (c.isTank) { drawTank(c); return; }
  const x = c.x - camX, y = c.y - camY;
  drawVehicleShadow(x, y, c.angle, c.w / 2, c.h / 2, 6);
  ctx.save();
  ctx.translate(x, y); ctx.rotate(c.angle);
  const hw = c.w / 2, hh = c.h / 2;
  drawTyres(hw, hh);
  const paint = bodyPaint(c.color, c.angle, hw, hh);
  ctx.fillStyle = paint; roundRect(-hw, -hh, c.w, c.h, 6); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 1.2; roundRect(-hw, -hh, c.w, c.h, 6); ctx.stroke();
  if (c.livery && c.livery !== 'army') drawVanCabin(c, hw, hh);
  else drawSaloonCabin(c, hw, hh, (c.role === 'police' || c.wasPolice) ? '#20407a' : paint);
  drawCarLights(c, hw, hh);
  if (c.isTaxi) {                                    // taxi livery: chequers + roof sign
    for (let i = 0; i < 5; i++) {
      const sx = -hw + 7 + i * 7;
      ctx.fillStyle = i & 1 ? '#f4f4f4' : '#1a1a1e';
      ctx.fillRect(sx, -hh, 7, 3); ctx.fillRect(sx, hh - 3, 7, 3);
    }
    ctx.fillStyle = '#16181e'; roundRect(-8, -4, 16, 8, 2); ctx.fill();
    ctx.fillStyle = '#ffd23a'; ctx.font = 'bold 7px Trebuchet MS'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(t('lm.taxi'), 0, 0.5);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }
  if (c.livery === 'ambulance') {                    // ambulance: stripes and red cross
    ctx.fillStyle = '#d23434';
    ctx.fillRect(-hw + 4, -hh + 1, c.w - 12, 2.5); ctx.fillRect(-hw + 4, hh - 3.5, c.w - 12, 2.5);
    ctx.fillRect(-2.5, -7, 5, 14); ctx.fillRect(-7, -2.5, 14, 5);
  } else if (c.livery === 'fire') {                  // fire engine: yellow stripes and roof ladder
    ctx.fillStyle = '#ffd23a';
    ctx.fillRect(-hw + 3, -hh + 1, c.w - 10, 2.5); ctx.fillRect(-hw + 3, hh - 3.5, c.w - 10, 2.5);
    ctx.fillStyle = '#c9ccd6'; roundRect(-hw + 7, -3.5, c.w - 22, 7, 2); ctx.fill();
    ctx.fillStyle = '#8a8f9a';
    for (let i = 0; i < 4; i++) ctx.fillRect(-hw + 10 + i * (c.w - 30) / 3, -3.5, 2, 7);
  } else if (c.livery === 'armored') {               // bank's armoured van: box body and $ medallion
    ctx.fillStyle = '#5a5f6a'; roundRect(-hw + 9, -hh + 2.5, c.w - 17, c.h - 5, 3); ctx.fill();
    ctx.fillStyle = '#ffd23a'; ctx.beginPath(); ctx.arc(-2, 0, 5.5, 0, TAU); ctx.fill();
    ctx.fillStyle = '#7a6420'; ctx.font = 'bold 8px Trebuchet MS'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('$', -2, 0.5); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  } else if (c.livery === 'market') {                // market van: green bands and sign
    ctx.fillStyle = '#3f7d78';
    ctx.fillRect(-hw + 4, -hh + 1, c.w - 12, 3); ctx.fillRect(-hw + 4, hh - 4, c.w - 12, 3);
    ctx.beginPath(); ctx.arc(-2, 0, 5.5, 0, TAU); ctx.fill();
    ctx.fillStyle = '#dff5ef'; ctx.font = 'bold 8px Trebuchet MS'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('M', -2, 0.5); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  } else if (c.livery === 'gunshop') {               // gun-shop van: target on the roof
    ctx.fillStyle = '#f2f4f8'; ctx.beginPath(); ctx.arc(-2, 0, 6, 0, TAU); ctx.fill();
    ctx.fillStyle = '#d23434'; ctx.beginPath(); ctx.arc(-2, 0, 4, 0, TAU); ctx.fill();
    ctx.fillStyle = '#f2f4f8'; ctx.beginPath(); ctx.arc(-2, 0, 2, 0, TAU); ctx.fill();
  } else if (c.livery === 'army') {                  // military jeep: green canvas top and star
    ctx.fillStyle = '#3a4a28'; roundRect(-hw + 8, -hh + 2.5, c.w - 16, c.h - 5, 3); ctx.fill();
    ctx.fillStyle = '#e8e4c8'; ctx.font = 'bold 10px Trebuchet MS'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('★', -1, 0.5); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }
  // Flashing lights: patrol cars mid-chase, or the player's patrol car/ambulance with the
  // siren on.
  if (c.role === 'police' || playerSirenOn(c)) {
    const on = c.role === 'police' ? Math.floor(c.lightPhase) % 2 === 0 : Math.floor(frame / 7) % 2 === 0;
    ctx.fillStyle = on ? '#ff3030' : '#3050ff'; ctx.fillRect(-3, -hh + 4, 6, 5);
    ctx.fillStyle = on ? '#3050ff' : '#ff3030'; ctx.fillRect(-3, hh - 9, 6, 5);
  }
  ctx.restore();
  if (c.burning) drawCarFlames(c);
}

function drawPerson(x, y, facing, walk, opt) {
  // Top-down body: head + shoulders, oriented towards `facing`.
  ctx.save();
  ctx.translate(x, y); ctx.rotate(facing + Math.PI / 2);
  const bob = Math.sin(walk) * 1.5;
  // Legs/steps.
  ctx.fillStyle = '#2f3440';
  const step = Math.sin(walk) * 3;
  ctx.fillRect(-5, 2, 4, 6 + step); ctx.fillRect(1, 2, 4, 6 - step);
  // Shoulders/torso.
  ctx.fillStyle = opt.shirt; roundRect(-6, -6 + bob, 12, 12, 3); ctx.fill();
  // Arms (the right one snaps forward when throwing a punch).
  ctx.fillStyle = opt.skin; ctx.fillRect(-8, -4 + bob, 3, 8);
  if (opt.punch) {
    const ext = Math.sin(opt.punch * Math.PI) * 9;
    ctx.fillRect(5, -4 + bob - ext, 3, 8);
    ctx.beginPath(); ctx.arc(6.5, -5 + bob - ext, 3, 0, TAU); ctx.fill();   // clenched fist
  } else ctx.fillRect(5, -4 + bob, 3, 8);
  // Head.
  ctx.fillStyle = opt.skin; ctx.beginPath(); ctx.arc(0, -2 + bob, 5, 0, TAU); ctx.fill();
  ctx.fillStyle = opt.hair; ctx.beginPath(); ctx.arc(0, -3 + bob, 5, Math.PI * 0.15, Math.PI * 0.85); ctx.fill();
  if (opt.cop) { ctx.fillStyle = '#1a2a5a'; ctx.fillRect(-5, -6 + bob, 10, 3); ctx.fillStyle = '#ffd23a'; ctx.fillRect(-1, -7 + bob, 2, 2); }
  // Soldier's green helmet (covers hair and forehead).
  if (opt.soldier) { ctx.fillStyle = '#4a5d33'; ctx.beginPath(); ctx.arc(0, -2 + bob, 5.5, 0, TAU); ctx.fill();
                     ctx.fillStyle = '#38452a'; ctx.fillRect(-5.5, -1 + bob, 11, 2); }
  // Gun in hand (pointing where they aim).
  if (opt.gun) { ctx.fillStyle = '#222'; ctx.fillRect(4, -1 + bob, 8, 3); }
  ctx.restore();
}
function drawPed(p) {
  const x = p.x - camX, y = p.y - camY;
  if (p.ko) {
    drawShadow(x, y + 2, 10, 5);
    ctx.save(); ctx.translate(x, y); ctx.rotate((p.spin || 0) + 1.2);
    ctx.fillStyle = p.shirt; roundRect(-8, -5, 16, 10, 3); ctx.fill();
    ctx.fillStyle = p.skin; ctx.beginPath(); ctx.arc(-9, 0, 5, 0, TAU); ctx.fill();
    ctx.restore();
    return;
  }
  if (p.role === 'injured') {                         // casualty: lying on the ground awaiting the ambulance
    drawShadow(x, y + 2, 10, 5);
    ctx.save(); ctx.translate(x, y); ctx.rotate(1.2);
    ctx.fillStyle = p.shirt; roundRect(-8, -5, 16, 10, 3); ctx.fill();
    ctx.fillStyle = p.skin; ctx.beginPath(); ctx.arc(-9, 0, 5, 0, TAU); ctx.fill();
    ctx.restore();
    if (p.sayT > 0) sayBubble(x, y, p.say, p.sayCol, p.sayT);
    else pedBubble(x, y, 'AIUTO!', '#ff5a5a');
    return;
  }
  drawShadow(x, y + 6, 8, 3);
  drawPerson(x, y, p.facing, p.walk, { shirt: p.shirt, skin: p.skin, hair: p.hair, cop: p.role === 'cop' || p.copDress,
                                       soldier: p.role === 'soldier' || p.soldierDress, gun: p.role === 'cop' || p.role === 'soldier' });
  if (p.sayT > 0) sayBubble(x, y, p.say, p.sayCol, p.sayT);           // contextual line
  else if (p.angryT > 0) pedBubble(x, y, '💢', '#ff5a5a');            // robbed driver, ranting
  else if (p.role === 'fare') pedBubble(x, y, 'TAXI!', '#ffd23a');        // fare waiting for the taxi
  else if (p.role === 'hungry') pedBubble(x, y, 'PIZZA!', '#ff8a3a'); // customer waiting for the pizza
  else if (p.role === 'robber') pedBubble(x, y, 'LADRO!', '#ff5a5a'); // rapinatore in fuga
}
// Speech bubble on a white background: the pedestrians' contextual lines.
function sayBubble(x, y, txt, col, sayT) {
  ctx.globalAlpha = clamp(sayT / 15, 0, 1);         // fade out at the end
  ctx.font = 'bold 10px Trebuchet MS';
  const w = ctx.measureText(txt).width;
  const by = y - 30 + Math.sin(frame * 0.1) * 2;
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.beginPath(); ctx.moveTo(x, y - 13); ctx.lineTo(x - 5, by + 7); ctx.lineTo(x + 5, by + 7); ctx.closePath(); ctx.fill();
  roundRect(x - w / 2 - 7, by - 8, w + 14, 17, 8); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 1;
  roundRect(x - w / 2 - 7, by - 8, w + 14, 17, 8); ctx.stroke();
  ctx.textAlign = 'center';
  ctx.fillStyle = col; ctx.fillText(txt, x, by + 4);
  ctx.textAlign = 'left';
  ctx.globalAlpha = 1;
}
// Bubble above a "mission" pedestrian's head.
function pedBubble(x, y, txt, col) {
  const by = y - 26 + Math.sin(frame * 0.12) * 3;
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.moveTo(x, by + 9); ctx.lineTo(x - 6, by + 2); ctx.lineTo(x + 6, by + 2); ctx.closePath(); ctx.fill();
  ctx.font = 'bold 10px Trebuchet MS'; ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillText(txt, x + 1, by - 1);
  ctx.fillStyle = col; ctx.fillText(txt, x, by - 2);
  ctx.textAlign = 'left';
}
function drawPlayer() {
  const x = player.x - camX, y = player.y - camY;
  drawShadow(x, y + 6, 8, 3);
  const w = WEAPONS[player.weaponIdx];
  drawPerson(x, y, player.aim, player.walk, { shirt: player.shirt, skin: player.skin, hair: player.hair,
                                              gun: !w.melee, punch: player.punchT > 0 ? player.punchT / 10 : 0 });
  // Name label.
  ctx.font = 'bold 11px Trebuchet MS'; ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillText(playerName, x + 1, y - 15);
  ctx.fillStyle = '#ffd23a'; ctx.fillText(playerName, x, y - 16);
  ctx.textAlign = 'left';
}
function drawBullets() {
  for (const b of bullets) {
    const x = b.x - camX, y = b.y - camY;
    if (b.flame) {                                    // flamethrower: a flamelet that grows and fades over its life
      const k = clamp((b.life || 0) / 8, 0, 1), r = 4 + (1 - k) * 7;
      ctx.globalAlpha = 0.35 + 0.45 * k;
      ctx.fillStyle = k > 0.6 ? '#fff0a0' : (k > 0.3 ? '#ff8a2a' : '#c22822');
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;
      continue;
    }
    ctx.strokeStyle = b.fromPlayer ? '#fff2a0' : '#ff7a5a'; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - b.vx * 1.4, y - b.vy * 1.4); ctx.stroke();
  }
  ctx.lineCap = 'butt';
}
// Tank rockets: a silhouette with a red nose cone and a tail flame.
function drawRockets() {
  for (const r of rockets) {
    const x = r.x - camX, y = r.y - camY;
    if (x < -30 || y < -30 || x > vw + 30 || y > vh + 30) continue;
    if (r.grenade) {                                                     // grenade: dark round charge with a sparking fuse
      ctx.fillStyle = '#2b2f36'; ctx.beginPath(); ctx.arc(x, y, 4, 0, TAU); ctx.fill();
      ctx.fillStyle = '#5a6068'; ctx.beginPath(); ctx.arc(x - 1.2, y - 1.2, 1.4, 0, TAU); ctx.fill();
      ctx.fillStyle = frame % 4 < 2 ? '#ffd23a' : '#ff5a2a';
      ctx.beginPath(); ctx.arc(x + 3, y - 3.5, 1.6, 0, TAU); ctx.fill();
      continue;
    }
    ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(r.vy, r.vx));
    ctx.fillStyle = frame % 4 < 2 ? '#ffd23a' : '#ff8a2a';
    ctx.beginPath(); ctx.arc(-8, 0, 3.2, 0, TAU); ctx.fill();            // tail flame
    ctx.fillStyle = '#39452c'; roundRect(-7, -2.5, 13, 5, 2.5); ctx.fill();
    ctx.fillStyle = '#c22822';
    ctx.beginPath(); ctx.moveTo(6, -2.5); ctx.lineTo(10.5, 0); ctx.lineTo(6, 2.5); ctx.closePath(); ctx.fill();   // nose cone
    ctx.restore();
  }
}
function drawParts() {
  for (const p of parts) {
    const x = p.x - camX, y = p.y - camY;
    ctx.globalAlpha = clamp(p.life / 22, 0, 1);
    ctx.fillStyle = p.color;
    if (p.kind === 'smoke') { ctx.beginPath(); ctx.arc(x, y, p.size, 0, TAU); ctx.fill(); }
    else ctx.fillRect(x - p.size / 2, y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;
}
// Floating score numbers ("+50") that rise and fade at the spot of the action.
function drawPops() {
  if (!pops.length) return;
  ctx.save();
  ctx.font = 'bold 15px system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (const q of pops) {
    const x = q.x - camX, y = q.y - camY;
    ctx.globalAlpha = clamp(q.life / 55, 0, 1);
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillText(q.text, x + 1, y + 1);
    ctx.fillStyle = '#ffd23a'; ctx.fillText(q.text, x, y);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}
function drawAim() {
  const inTank = !!(player.car && player.car.isTank);
  if (player.car && !inTank) return;              // no crosshair while driving… except in the tank
  if (usingTouch && rStick.id === null) return;   // on touch the crosshair only shows while aiming
  const x = mouseX, y = mouseY;
  if (inTank) { drawTankAim(x, y, player.car); return; }
  ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, 9, 0, TAU); ctx.moveTo(x - 14, y); ctx.lineTo(x - 4, y);
  ctx.moveTo(x + 4, y); ctx.lineTo(x + 14, y); ctx.moveTo(x, y - 14); ctx.lineTo(x, y - 4);
  ctx.moveTo(x, y + 4); ctx.lineTo(x, y + 14); ctx.stroke();
}
// The tank's military crosshair: a circle with cross ticks; green with a round chambered
// (dot at the centre), grey while reloading, with the yellow arc closing as the next rocket
// gets ready.
function drawTankAim(x, y, c) {
  const ready = (c.gunCd || 0) === 0;
  const col = ready ? 'rgba(140,220,90,.9)' : 'rgba(230,230,230,.5)';
  ctx.strokeStyle = col; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, 14, 0, TAU); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 22, y); ctx.lineTo(x - 9, y);
  ctx.moveTo(x + 9, y); ctx.lineTo(x + 22, y);
  ctx.moveTo(x, y - 22); ctx.lineTo(x, y - 9);
  ctx.moveTo(x, y + 9); ctx.lineTo(x, y + 22);
  ctx.stroke();
  if (ready) {
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, TAU); ctx.fill();
  } else {
    const k = 1 - c.gunCd / 100;                  // 100 = full reload (updateTankGun)
    ctx.strokeStyle = 'rgba(255,210,58,.9)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, 9, -Math.PI / 2, -Math.PI / 2 + k * TAU); ctx.stroke();
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

const renderEnts = [];                            // buffer reused by the sort in render()
function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#26282e'; ctx.fillRect(0, 0, vw, vh);
  drawWorld();
  drawDecals();
  drawHealPads();
  drawGunPads();
  drawPickups();
  drawCoins();
  drawFires();
  drawTurrets();                               // fixed posts at the barracks corners
  // Sort entities by Y so the lower ones draw in front (array reused between frames: no
  // allocation in the render loop).
  const ents = renderEnts; ents.length = 0;
  for (const c of cars) ents.push(c);
  for (const p of peds) ents.push(p);
  if (!player.car) ents.push(player);          // on foot, draw the player; while driving the car covers them
  ents.push(train);                            // the looping train (Y-sorted like the cars)
  if (netActive()) netPushEnts(ents);          // multiplayer: the rivals' ghosts
  ents.sort((a, b) => a.y - b.y);
  for (const e of ents) {
    if (e === player) drawPlayer();
    else if (e.isTrain) drawTrain();
    else if (e.netG) drawNetPlayer(e.netG);
    else if (e.role === 'traffic' || e.role === 'police' || e.role === 'armycar' || e.role === 'parked' || e.role === 'player') drawCar(e);
    else drawPed(e);
  }
  if (chinaGate) drawChinaGateBeam(chinaGate);
  drawTrafficLights();
  drawBullets();
  drawRockets();
  drawWater();
  drawParts();
  drawPops();
  drawTaxiGuide();
  drawPizzaGuide();
  drawRescueGuide();
  drawPatrolGuide();
  drawFireGuide();
  drawPlayerArrows();                            // multiplayer: arrows towards the rivals
  drawGunshopMenu();
  // Red flash when hit.
  if (flashT > 0) { ctx.fillStyle = `rgba(200,20,20,${flashT / 30})`; ctx.fillRect(0, 0, vw, vh); }
  drawMinimap();
  drawAim();
}

// ---------- Minimap ----------
const cityMini = document.createElement('canvas');
cityMini.width = MAP_W; cityMini.height = MAP_H;
(function bakeMini() {
  const m = cityMini.getContext('2d');
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    const t = grid[gi(x, y)];
    m.fillStyle = t === ROAD ? '#3a3d45' : t === SIDEWALK ? '#8a9098' : t === ALLEY ? '#2b2d33'
                : t === GRASS || t === TREE ? '#3f8a3a' : t === WATER ? '#2f6b9e'
                : t === COURT ? '#79807a' : '#6a5a4a';
    m.fillRect(x, y, 1, 1);
  }
  // Special buildings, clearly visible on the map.
  for (const lm of landmarks) {
    m.fillStyle = { police: '#4a6fd2', hospital: '#e84a4a', fire: '#e07a2a', bank: '#e0c04a', market: '#3ab0a0', pizzeria: '#ff8a3a', gunshop: '#c04ad2', army: '#6a8a3a' }[lm.type];
    m.fillRect(lm.x0, lm.y0, lm.x1 - lm.x0 + 1, lm.y1 - lm.y0 + 1);
  }
  // The railway: a clearly visible loop.
  m.fillStyle = '#c9a24a';
  for (let along = 0; along < RAIL_LOOP_LEN; along += T / 2) {
    const p = railPointAt(along);
    m.fillRect(Math.floor(p.x / T), Math.floor(p.y / T), 1, 1);
  }
})();
const miniEl = document.getElementById('mini');
const mctx = miniEl ? miniEl.getContext('2d') : null;
// Draws the map (city + live dots + view rectangle) onto any canvas. UNIFORM scale +
// centring (letterbox): non-square maps (medium, 184×368) are not stretched and the dots
// stay aligned with the city.
function paintMinimap(el, g) {
  const W = el.width, H = el.height, sc = Math.min(W / MAP_W, H / MAP_H);
  const ox = (W - MAP_W * sc) / 2, oy = (H - MAP_H * sc) / 2;
  const rk = sc / (160 / Math.max(MAP_W, MAP_H));   // scale the dots relative to the 160px minimap
  g.clearRect(0, 0, W, H);
  g.drawImage(cityMini, 0, 0, MAP_W, MAP_H, ox, oy, MAP_W * sc, MAP_H * sc);
  const dot = (wx, wy, col, r) => { g.fillStyle = col; g.beginPath(); g.arc(ox + wx / T * sc, oy + wy / T * sc, r * rk, 0, TAU); g.fill(); };
  for (const c of cars) if (c.role === 'police') dot(c.x, c.y, '#3a7bff', 2.2);
  for (const p of peds) if (p.role === 'cop') dot(p.x, p.y, '#3a7bff', 1.8);
  for (const c of cars) if (c.role === 'armycar') dot(c.x, c.y, '#7da03e', 2.2);
  for (const p of peds) if (p.role === 'soldier') dot(p.x, p.y, '#7da03e', 1.8);
  if (taxiActive()) { const t = taxiTarget(); if (t) dot(t.x, t.y, taxi.phase === 'pickup' ? '#ffd23a' : '#5ee06a', 2.6); }
  if (pizzaActive()) { const t = pizzaTarget(); if (t) dot(t.x, t.y, pizza.phase === 'pickup' ? '#ff8a3a' : '#ff5a5a', 2.6); }
  if (rescueActive()) { const t = rescueTarget(); if (t) dot(t.x, t.y, rescue.phase === 'pickup' ? '#ff6a6a' : '#6ad0ff', 2.6); }
  if (patrolActive() && patrol.robber) dot(patrol.robber.x, patrol.robber.y, '#4a8aff', 2.6);
  for (const f of fires) dot(f.x, f.y, frame % 20 < 10 ? '#ff8a2a' : '#ffd23a', 2.6);
  if (netActive()) for (const g2 of net.players.values()) if (!g2.down) dot(g2.x, g2.y, '#5ad0ff', 2.6);
  dot(player.x, player.y, '#7dff5a', 2.6);
  // View rectangle.
  g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = Math.max(1, rk);
  g.strokeRect(ox + camX / T * sc, oy + camY / T * sc, vw / T * sc, vh / T * sc);
}
function drawMinimap() {
  if (frame % 3 !== 0) return;                    // ~20 Hz: the minimap does not need 60 fps, the last drawing stays
  if (mctx) paintMinimap(miniEl, mctx);
  if (mapFullOpen && mfctx) paintMinimap(miniFull, mfctx);
}

// ---------- Full-screen map ----------
const mapFullEl = document.getElementById('mapFull');
const miniFull = document.getElementById('miniFull');
const mfctx = miniFull ? miniFull.getContext('2d') : null;
let mapFullOpen = false;
function sizeMapFull() {
  if (!miniFull || !mapFullEl) return;
  // Available space = viewport minus the overlay's padding.
  const cs = getComputedStyle(mapFullEl);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const maxW = innerWidth - padX, maxH = innerHeight - padY, ar = MAP_W / MAP_H;
  let w = maxW, h = w / ar;
  if (h > maxH) { h = maxH; w = h * ar; }
  const dpr = Math.min(devicePixelRatio || 1, 2);
  miniFull.style.width = w + 'px'; miniFull.style.height = h + 'px';
  miniFull.width = Math.round(w * dpr); miniFull.height = Math.round(h * dpr);
}
function openMapFull() {
  if (!mapFullEl || mapFullOpen || !started) return;
  mapFullOpen = true;
  sizeMapFull();
  mapFullEl.classList.remove('hidden');
  if (mfctx) paintMinimap(miniFull, mfctx);        // draw immediately, without waiting for the frame
}
function closeMapFull() {
  if (!mapFullOpen) return;
  mapFullOpen = false;
  if (mapFullEl) mapFullEl.classList.add('hidden');
}
if (miniEl) {
  miniEl.addEventListener('click', openMapFull);
  // On touch a click does not arrive reliably: open on touch and stop the event from
  // leaking through to the aiming stick.
  miniEl.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); openMapFull(); }, { passive: false });
}
const mapCloseBtn = document.getElementById('mapClose');
if (mapCloseBtn) mapCloseBtn.addEventListener('click', closeMapFull);
if (mapFullEl) mapFullEl.addEventListener('click', e => { if (e.target === mapFullEl || e.target === miniFull) closeMapFull(); });
addEventListener('resize', () => { if (mapFullOpen) { sizeMapFull(); if (mfctx) paintMinimap(miniFull, mfctx); } });

