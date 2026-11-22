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
  drawRoads();
  drawRoadDecals();
  // 3) Paving joints on the smooth pavement + building shadows on the carriageway.
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const t = grid[gi(x, y)];
    if (t !== ROAD && !(t === SIDEWALK && roadAdjacent(x, y))) continue;
    const px = Math.floor(x * T - camX), py = Math.floor(y * T - camY);
    if (t === SIDEWALK) { ctx.fillStyle = 'rgba(0,0,0,.06)'; ctx.fillRect(px, py, T, 1); ctx.fillRect(px, py, 1, T); }
    if (tileAt(x, y - 1) === BUILDING) { ctx.fillStyle = 'rgba(0,0,0,.20)'; ctx.fillRect(px, py, T, 5); }
    if (tileAt(x - 1, y) === BUILDING) { ctx.fillStyle = 'rgba(0,0,0,.14)'; ctx.fillRect(px, py, 5, T); }
  }
  drawMarkings();
  drawCrosswalks();
  drawRailway();                                  // the train track (a horizontal line)
  drawBuildingShadows();
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
// Traces a road edge's curve (Bézier) in screen coordinates.
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
function drawRoads() {
  const SWHALF = HALF_ROAD + SW_BAND, pad = SWHALF + 6;
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const nodeVisible = (n, r) => !(n.x + r < camX || n.x - r > camX + vw || n.y + r < camY || n.y - r > camY + vh);
  // --- Pavement band ---
  ctx.strokeStyle = '#9aa0a8'; ctx.lineWidth = 2 * SWHALF; ctx.beginPath();
  for (const e of edges) if (!e.dead && edgeVisible(e, pad)) traceEdge(e);
  ctx.stroke();
  ctx.fillStyle = '#9aa0a8';
  for (const n of nodes) if (n.live !== false && nodeVisible(n, SWHALF)) { ctx.beginPath(); ctx.arc(n.x - camX, n.y - camY, HALF_ROAD * 1.05 + SW_BAND, 0, TAU); ctx.fill(); }
  // --- Kerb (dark ring between paving and asphalt) ---
  ctx.strokeStyle = '#767d87'; ctx.lineWidth = 2 * HALF_ROAD + 7; ctx.beginPath();
  for (const e of edges) if (!e.dead && edgeVisible(e, pad)) traceEdge(e);
  ctx.stroke();
  ctx.fillStyle = '#767d87';
  for (const n of nodes) if (n.live !== false && nodeVisible(n, SWHALF)) { ctx.beginPath(); ctx.arc(n.x - camX, n.y - camY, HALF_ROAD * 1.05 + 3.5, 0, TAU); ctx.fill(); }
  // --- Asphalt ---
  ctx.strokeStyle = '#33363d'; ctx.lineWidth = 2 * HALF_ROAD; ctx.beginPath();
  for (const e of edges) if (!e.dead && edgeVisible(e, pad)) traceEdge(e);
  ctx.stroke();
  ctx.fillStyle = '#33363d';
  for (const n of nodes) if (n.live !== false && nodeVisible(n, SWHALF)) { ctx.beginPath(); ctx.arc(n.x - camX, n.y - camY, HALF_ROAD * 1.05, 0, TAU); ctx.fill(); }
  ctx.restore();
}
function drawTile(t, px, py, x, y) {
  if (t === ROAD) {
    ctx.fillStyle = '#33363d'; ctx.fillRect(px, py, T, T);
    if ((hash2(x, y) & 7) === 0) { ctx.fillStyle = 'rgba(255,255,255,.03)'; ctx.fillRect(px + 6, py + 8, 6, 4); }
  } else if (t === SIDEWALK) {
    ctx.fillStyle = '#9aa0a8'; ctx.fillRect(px, py, T, T);
    ctx.strokeStyle = 'rgba(0,0,0,.12)'; ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, T - 1, T - 1);
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
    ctx.fillStyle = GRASS_COLS[hash2(x >> 2, y >> 2) % GRASS_COLS.length]; ctx.fillRect(px, py, T, T);
    const h = hash2(x, y);
    ctx.fillStyle = 'rgba(0,0,0,.06)';
    ctx.fillRect(px + (h & 15), py + ((h >> 4) & 15), 3, 3);
    if (h % 31 === 0) {                                      // little flowers dotted about the lawns
      ctx.fillStyle = '#e8dff0'; ctx.fillRect(px + ((h >> 6) & 15) + 4, py + ((h >> 10) & 15) + 3, 2, 2);
      ctx.fillStyle = '#ffd23a'; ctx.fillRect(px + ((h >> 8) & 15) + 6, py + ((h >> 12) & 15) + 8, 2, 2);
    }
  } else if (t === TREE) {
    // In plazas and office forecourts the trees sit in stone planters, neatly arranged;
    // in green spaces they vary in size, position and shade.
    const bx = Math.floor(x / PERIOD), by = Math.floor(y / PERIOD), cat = blockCat(bx, by);
    const vasca = cat === PLAZA_CAT || (cat === BUILD_CAT && blockKind(bx, by) === OFF_KIND);
    ctx.fillStyle = vasca ? (cat === PLAZA_CAT ? '#9aa0a8' : '#7e838c') : GRASS_COLS[hash2(x >> 2, y >> 2) % GRASS_COLS.length];
    ctx.fillRect(px, py, T, T);
    const h = hash2(x * 7 + 1, y * 13 + 4);
    const r = vasca ? 11 : 9 + h % 5;
    const cx = px + T / 2 + (vasca ? 0 : (h >> 3) % 5 - 2), cy = py + T / 2 + (vasca ? 0 : (h >> 6) % 5 - 2);
    if (vasca) {
      ctx.fillStyle = '#7b8189'; ctx.fillRect(px + 4, py + 4, T - 8, T - 8);
      ctx.fillStyle = '#5b7d43'; ctx.fillRect(px + 6, py + 6, T - 12, T - 12);
    }
    const canopy = TREE_COLS[h % TREE_COLS.length];
    ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.beginPath(); ctx.arc(cx + 4, cy + 5, r, 0, TAU); ctx.fill();
    ctx.fillStyle = canopy[0]; ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
    ctx.fillStyle = canopy[1]; ctx.beginPath(); ctx.arc(cx - r * 0.25, cy - r * 0.25, r * 0.62, 0, TAU); ctx.fill();
    ctx.fillStyle = canopy[2]; ctx.beginPath(); ctx.arc(cx - r * 0.35, cy - r * 0.35, r * 0.28, 0, TAU); ctx.fill();
  } else if (t === WATER) {
    ctx.fillStyle = '#2f6b9e'; ctx.fillRect(px, py, T, T);
    const h = hash2(x, y);
    // Lighter shore where the water meets the land.
    ctx.fillStyle = 'rgba(190,225,245,.35)';
    if (tileAt(x, y - 1) !== WATER) ctx.fillRect(px, py, T, 3);
    if (tileAt(x, y + 1) !== WATER) ctx.fillRect(px, py + T - 3, T, 3);
    if (tileAt(x - 1, y) !== WATER) ctx.fillRect(px, py, 3, T);
    if (tileAt(x + 1, y) !== WATER) ctx.fillRect(px + T - 3, py, 3, T);
    // Reflections rippling slowly.
    const tw = 0.55 + 0.45 * Math.sin(frame * 0.05 + (h & 15));
    ctx.fillStyle = `rgba(255,255,255,${0.05 + 0.08 * tw})`;
    ctx.fillRect(px + (h & 15), py + 5 + ((h >> 4) & 7), 6, 2);
    ctx.fillRect(px + ((h >> 8) & 15), py + 19 + ((h >> 12) & 5), 5, 2);
  } else if (t === COURT) {                                  // the lot's inner courtyard
    const k = blockKind(Math.floor(x / PERIOD), Math.floor(y / PERIOD));
    const h = hash2(x + 9, y + 27);
    if (k === RES_KIND) {                                    // small private garden
      ctx.fillStyle = GRASS_COLS[hash2(x >> 2, y >> 2) % GRASS_COLS.length]; ctx.fillRect(px, py, T, T);
      ctx.fillStyle = 'rgba(0,0,0,.07)'; ctx.fillRect(px + (h & 15), py + ((h >> 4) & 15), 3, 3);
      if (h % 6 === 0) {                                     // hedges
        ctx.fillStyle = '#3d7a38'; ctx.beginPath();
        ctx.arc(px + 8 + (h & 7), py + 9 + ((h >> 3) & 7), 5, 0, TAU);
        ctx.arc(px + 15 + (h & 7), py + 11 + ((h >> 5) & 7), 4, 0, TAU); ctx.fill();
      }
    } else if (k === OFF_KIND) {                             // paved forecourt
      ctx.fillStyle = '#7e838c'; ctx.fillRect(px, py, T, T);
      ctx.strokeStyle = 'rgba(0,0,0,.10)'; ctx.lineWidth = 1; ctx.strokeRect(px + 0.5, py + 0.5, T - 1, T - 1);
      if (h % 11 === 0) { ctx.fillStyle = 'rgba(255,255,255,.10)'; ctx.fillRect(px + 5, py + 5, 8, 3); }
    } else {                                                 // industrial yard
      ctx.fillStyle = '#4d5058'; ctx.fillRect(px, py, T, T);
      ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fillRect(px + (h & 15), py + ((h >> 4) & 15), 5, 3);
      if (h % 9 === 0) {                                     // pallets and stacks
        ctx.fillStyle = '#7a5c3a'; ctx.fillRect(px + 6, py + 8, 12, 9);
        ctx.fillStyle = 'rgba(0,0,0,.30)'; ctx.fillRect(px + 6, py + 12, 12, 1);
        ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(px + 6, py + 8, 12, 2);
      }
    }
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
};

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
function drawBuildingWalls(b, px, py, W, H, L) {
  const rw = W - L, rh = H - L;
  fillPolygon([[px, py + rh], [px + rw, py + rh], [px + W, py + H], [px, py + H]], shade(b.col, -0.30));
  fillPolygon([[px + rw, py], [px + W, py], [px + W, py + H], [px + rw, py + rh]], shade(b.col, -0.50));
  const layout = WALL_LAYOUT[b.style];
  if (!layout) {
    ctx.fillStyle = 'rgba(0,0,0,.14)';
    for (let sx = px + 2; sx < px + rw; sx += 3) ctx.fillRect(sx, py + rh, 1, L);
    for (let sy = py + 2; sy < py + rh; sy += 3) ctx.fillRect(px + rw, sy, L, 1);
  } else {
    const floors = Math.max(1, Math.floor((L - 2) / layout.floorHeight));
    const windowDepth = Math.min(layout.floorHeight, L - 2) - 2;
    for (let floor = 0; floor < floors; floor++) {
      const offset = 2 + floor * layout.floorHeight;
      for (let sx = px + 4, column = 0; sx <= px + rw - layout.windowWidth - 3; sx += layout.bay, column++) {
        ctx.fillStyle = windowTone(b, column, floor); ctx.fillRect(sx, py + rh + offset, layout.windowWidth, windowDepth);
      }
      for (let sy = py + 4, column = 0; sy <= py + rh - layout.windowWidth - 3; sy += layout.bay, column++) {
        ctx.fillStyle = windowTone(b, column + 97, floor); ctx.fillRect(px + rw + offset, sy, windowDepth, layout.windowWidth);
      }
    }
  }
  ctx.fillStyle = 'rgba(0,0,0,.28)';
  ctx.fillRect(px, py + H - 2, W, 2); ctx.fillRect(px + W - 2, py, 2, H);
  ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(px + rw + 0.5, py + rh + 0.5); ctx.lineTo(px + W - 0.5, py + H - 0.5); ctx.stroke();
}
function drawParapet(b, px, py, rw, rh) {
  ctx.strokeStyle = shade(b.col, 0.24); ctx.lineWidth = 2; ctx.strokeRect(px + 1, py + 1, rw - 2, rh - 2);
  ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fillRect(px + 2, py + 2, rw - 4, 3); ctx.fillRect(px + 2, py + 5, 3, rh - 7);
}
function drawRoofWeathering(b, px, py, rw, rh) {
  for (let k = 0; k < 4; k++) {
    const roll = hash2(b.h + k * 41, k * 23 + 9);
    const radius = 8 + roll % 14;
    const sx = px + 6 + (roll >> 5) % Math.max(1, rw - 12), sy = py + 6 + (roll >> 11) % Math.max(1, rh - 12);
    const stain = ctx.createRadialGradient(sx, sy, 0, sx, sy, radius);
    stain.addColorStop(0, 'rgba(0,0,0,.09)'); stain.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = stain; ctx.fillRect(sx - radius, sy - radius, radius * 2, radius * 2);
  }
}
function drawRoofBox(x, y, w, h, color, height) {
  ctx.fillStyle = 'rgba(10,14,24,.30)'; ctx.fillRect(x + height, y + height, w, h);
  ctx.fillStyle = color; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = 'rgba(255,255,255,.20)'; ctx.fillRect(x, y, w, 1); ctx.fillRect(x, y, 1, h);
  ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(x, y + h - 1, w, 1); ctx.fillRect(x + w - 1, y, 1, h);
}
function drawHipRoof(b, px, py, rw, rh) {
  const roofColor = ROOF_COLS[b.h % ROOF_COLS.length];
  const planes = hipRoofPlanes(px, py, rw, rh);
  const tones = { north: 0.18, west: 0.06, south: -0.16, east: -0.30 };
  for (const side of ['north', 'west', 'south', 'east']) {
    fillPolygon(planes[side], shade(roofColor, tones[side]));
    ctx.save(); ctx.beginPath(); tracePolygon(planes[side]); ctx.clip();
    ctx.fillStyle = 'rgba(0,0,0,.10)';
    if (side === 'north' || side === 'south') for (let sy = py + 3; sy < py + rh; sy += 3) ctx.fillRect(px, sy, rw, 1);
    else for (let sx = px + 3; sx < px + rw; sx += 3) ctx.fillRect(sx, py, 1, rh);
    ctx.restore();
  }
  const inset = Math.min(rw, rh) / 2;
  ctx.strokeStyle = shade(roofColor, 0.36); ctx.lineWidth = 1.5; ctx.beginPath();
  ctx.moveTo(px, py); ctx.lineTo(px + inset, py + inset); ctx.lineTo(px + rw - inset, py + rh - inset); ctx.lineTo(px + rw, py + rh);
  ctx.moveTo(px + rw, py); ctx.lineTo(px + rw - inset, py + inset);
  ctx.moveTo(px, py + rh); ctx.lineTo(px + inset, py + rh - inset);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1; ctx.strokeRect(px + 0.5, py + 0.5, rw - 1, rh - 1);
  const chimneyX = px + rw * 0.25 + b.h % Math.max(1, Math.floor(rw * 0.5) - 6), chimneyY = py + rh * 0.25;
  drawRoofBox(chimneyX, chimneyY, 6, 6, '#6a625a', 4);
  ctx.fillStyle = '#221f1c'; ctx.fillRect(chimneyX + 2, chimneyY + 2, 2, 2);
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
    const L = b.lift, rw = W - L, rh = H - L;
    drawBuildingWalls(b, px, py, W, H, L);
    // Roof according to the building's style.
    if (b.style === 'house') {
      drawHipRoof(b, px, py, rw, rh);
    } else if (b.style === 'apartment') {                // block of flats: gravel, stair head, terrace
      ctx.fillStyle = b.col; ctx.fillRect(px, py, rw, rh);
      ctx.fillStyle = 'rgba(0,0,0,.07)';
      for (let k = 0; k < 12; k++) {
        const hh = hash2(b.h + k * 17, k * 29 + 1);
        ctx.fillRect(px + 5 + hh % Math.max(1, rw - 12), py + 5 + (hh >> 7) % Math.max(1, rh - 12), 3, 3);
      }
      drawRoofWeathering(b, px, py, rw, rh);
      drawParapet(b, px, py, rw, rh);
      drawRoofBox(px + 8, py + 8, 12, 14, shade(b.col, -0.22), 5);
      ctx.fillStyle = '#2c2824'; ctx.fillRect(px + 12, py + 17, 5, 5);
      ctx.fillStyle = 'rgba(120,170,210,.55)';                                             // skylights
      for (let sx = px + 28; sx <= px + rw - 16; sx += 15) { ctx.fillRect(sx, py + 10, 8, 6); }
      drawRoofBox(px + rw - 19, py + rh - 18, 10, 8, '#9aa0a6', 3);
      ctx.fillStyle = '#4c8a44'; ctx.fillRect(px + 8, py + rh - 16, 9, 8);                 // roof garden
      ctx.fillStyle = '#5fa452'; ctx.fillRect(px + 9, py + rh - 15, 4, 3);
    } else if (b.style === 'tower') {
      ctx.fillStyle = shade(b.col, 0.04); ctx.fillRect(px, py, rw, rh);
      drawRoofWeathering(b, px, py, rw, rh);
      drawParapet(b, px, py, rw, rh);
      drawRoofBox(px + rw / 2 - 14, py + rh / 2 - 10, 28, 20, shade(b.col, -0.26), 7);
      ctx.fillStyle = shade(b.col, 0.14); ctx.fillRect(px + rw / 2 - 11, py + rh / 2 - 7, 22, 4);
      ctx.fillRect(px + rw / 2 - 11, py + rh / 2, 22, 4);
      for (let k = 0; k < 3; k++) drawRoofBox(px + rw - 26 - k * 14, py + rh - 18, 10, 8, '#9aa0a6', 3);
      if (rw >= 120 && rh >= 120 && b.h % 3 === 0) {
        const padX = px + 26, padY = py + rh - 26;
        ctx.fillStyle = 'rgba(10,14,24,.25)'; ctx.beginPath(); ctx.arc(padX + 3, padY + 3, 15, 0, TAU); ctx.fill();
        ctx.fillStyle = '#4a4f57'; ctx.beginPath(); ctx.arc(padX, padY, 15, 0, TAU); ctx.fill();
        ctx.strokeStyle = '#e8c547'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(padX, padY, 12, 0, TAU); ctx.stroke();
        ctx.fillStyle = '#eef0f2'; ctx.fillRect(padX - 5, padY - 6, 2, 12); ctx.fillRect(padX + 3, padY - 6, 2, 12); ctx.fillRect(padX - 3, padY - 1, 6, 2);
      }
      ctx.strokeStyle = 'rgba(10,14,24,.30)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px + rw - 12, py + 13); ctx.lineTo(px + rw - 5, py + 20); ctx.stroke();
      ctx.strokeStyle = '#c8ccd2'; ctx.beginPath(); ctx.moveTo(px + rw - 12, py + 13); ctx.lineTo(px + rw - 12, py + 5); ctx.stroke();
      ctx.fillStyle = frame % 60 < 30 ? '#ff4a3a' : '#8a2a22'; ctx.fillRect(px + rw - 14, py + 3, 4, 4);
    } else if (b.style === 'warehouse') {              // large industrial: sawtooth roof, silos
      ctx.fillStyle = shade(b.col, -0.20); ctx.fillRect(px, py, rw, rh);
      if (rw >= rh) for (let sx = px + 2; sx < px + rw - 2; sx += 9) {
        ctx.fillStyle = shade(b.col, 0.10); ctx.fillRect(sx, py + 2, 6, rh - 4);
        ctx.fillStyle = 'rgba(160,200,225,.30)'; ctx.fillRect(sx + 5, py + 2, 1, rh - 4);
        ctx.fillStyle = shade(b.col, -0.30); ctx.fillRect(sx + 6, py + 2, 2, rh - 4);
      } else for (let sy = py + 2; sy < py + rh - 2; sy += 9) {
        ctx.fillStyle = shade(b.col, 0.10); ctx.fillRect(px + 2, sy, rw - 4, 6);
        ctx.fillStyle = 'rgba(160,200,225,.30)'; ctx.fillRect(px + 2, sy + 5, rw - 4, 1);
        ctx.fillStyle = shade(b.col, -0.30); ctx.fillRect(px + 2, sy + 6, rw - 4, 2);
      }
      drawRoofWeathering(b, px, py, rw, rh);
      ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1; ctx.strokeRect(px + 0.5, py + 0.5, rw - 1, rh - 1);
      ctx.fillStyle = 'rgba(10,14,24,.30)';
      ctx.beginPath(); ctx.arc(px + rw - 7, py + 17, 7, 0, TAU); ctx.arc(px + rw - 7, py + 33, 7, 0, TAU); ctx.fill();
      for (const siloY of [py + 12, py + 28]) {                                           // silos
        const silo = ctx.createRadialGradient(px + rw - 15, siloY - 3, 1, px + rw - 12, siloY, 7);
        silo.addColorStop(0, '#d4dadf'); silo.addColorStop(1, '#7c858c');
        ctx.fillStyle = silo; ctx.beginPath(); ctx.arc(px + rw - 12, siloY, 7, 0, TAU); ctx.fill();
      }
      ctx.strokeStyle = 'rgba(0,0,0,.30)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(px + rw - 12, py + 12, 7, 0, TAU); ctx.arc(px + rw - 12, py + 28, 7, 0, TAU); ctx.stroke();
    } else {                                           // workshop: ribbon skylight and fan
      ctx.fillStyle = shade(b.col, 0.06); ctx.fillRect(px, py, rw, rh);
      drawRoofWeathering(b, px, py, rw, rh);
      drawParapet(b, px, py, rw, rh);
      ctx.fillStyle = 'rgba(10,14,24,.22)'; ctx.fillRect(px + 8, py + rh / 2 - 2, rw - 12, 8);
      ctx.fillStyle = 'rgba(140,200,220,.45)'; ctx.fillRect(px + 6, py + rh / 2 - 4, rw - 12, 8);
      ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fillRect(px + 6, py + rh / 2 - 4, rw - 12, 1);
      ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.arc(px + 13, py + 12, 6, 0, TAU); ctx.fill();
      ctx.strokeStyle = shade(b.col, 0.25); ctx.lineWidth = 1.5; ctx.beginPath();
      for (let k = 0; k < 3; k++) {
        const a = (b.h % 7) * 0.3 + k / 3 * TAU;
        ctx.moveTo(px + 13, py + 12); ctx.lineTo(px + 13 + Math.cos(a) * 5, py + 12 + Math.sin(a) * 5);
      }
      ctx.stroke();
    }
    drawFacade(b, px, py, W, H, L);
  }
}
// Awning-shaded shopfront for shops/workshops, a main door for the rest — on the side
// that faces the street.
function drawFacade(b, px, py, W, H, L) {
  if (b.face < 0) return;
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
// Dashed centre lines following the curve of each road.
function drawMarkings() {
  ctx.save();
  ctx.strokeStyle = '#e8c84a'; ctx.lineWidth = 2; ctx.setLineDash([12, 14]); ctx.lineCap = 'butt';
  for (const e of edges) {
    if (e.dead) continue;                             // road suppressed by the military base
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
      // Beaten-earth yard with camouflage patches.
      for (let i = 0; i < 9; i++) {
        const hs = hash2(lm.x0 * 3 + i * 11, lm.y0 * 5 + i * 7);
        ctx.fillStyle = i & 1 ? 'rgba(30,40,18,.22)' : 'rgba(96,116,54,.26)';
        ctx.beginPath();
        ctx.ellipse(px + 22 + hs % Math.max(1, w - 44), py + 26 + (hs >> 6) % Math.max(1, h - 44),
                    13, 8, (hs % 7) * 0.5, 0, TAU);
        ctx.fill();
      }
      // Large star at the centre of the yard.
      ctx.fillStyle = 'rgba(232,228,200,.75)'; ctx.beginPath(); ctx.arc(cx, cy + 4, 13, 0, TAU); ctx.fill();
      ctx.fillStyle = '#4c5a3a'; ctx.font = 'bold 15px Trebuchet MS'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('★', cx, cy + 5); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
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
  drawShadow(x + 2, y + 3, c.w / 2 - 3, 5);
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
  drawShadow(x + 3, y + 4, c.w / 2, c.h / 2 - 1);
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
function drawCar(c) {
  if (c.isBike) { drawBike(c); return; }
  if (c.isTank) { drawTank(c); return; }
  const x = c.x - camX, y = c.y - camY;
  drawShadow(x + 3, y + 4, c.w / 2, c.h / 2 - 1);
  ctx.save();
  ctx.translate(x, y); ctx.rotate(c.angle);
  const hw = c.w / 2, hh = c.h / 2;
  // Body.
  ctx.fillStyle = c.color; roundRect(-hw, -hh, c.w, c.h, 6); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1.5; roundRect(-hw, -hh, c.w, c.h, 6); ctx.stroke();
  // Roof.
  ctx.fillStyle = (c.role === 'police' || c.wasPolice) ? '#20407a' : 'rgba(0,0,0,.22)';
  roundRect(-hw + 12, -hh + 3, c.w - 22, c.h - 6, 4); ctx.fill();
  // Windscreen.
  ctx.fillStyle = 'rgba(150,210,255,.85)';
  ctx.fillRect(hw - 13, -hh + 4, 4, c.h - 8);
  ctx.fillStyle = 'rgba(120,180,230,.6)';
  ctx.fillRect(-hw + 9, -hh + 4, 4, c.h - 8);
  // Headlights.
  ctx.fillStyle = '#ffe9a0'; ctx.fillRect(hw - 3, -hh + 2, 3, 4); ctx.fillRect(hw - 3, hh - 6, 3, 4);
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
  if (train.active) ents.push(train);          // the passing train (Y-sorted like the cars)
  if (netActive()) netPushEnts(ents);          // multiplayer: the rivals' ghosts
  ents.sort((a, b) => a.y - b.y);
  for (const e of ents) {
    if (e === player) drawPlayer();
    else if (e.isTrain) drawTrain();
    else if (e.netG) drawNetPlayer(e.netG);
    else if (e.role === 'traffic' || e.role === 'police' || e.role === 'armycar' || e.role === 'parked' || e.role === 'player') drawCar(e);
    else drawPed(e);
  }
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
  // The railway: a clearly visible horizontal line.
  m.fillStyle = '#c9a24a';
  m.fillRect(0, RAIL_TY, MAP_W, 1);
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

