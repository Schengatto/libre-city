// LIBRE CITY · js/train.js — railway and passing train.
// Every map has ONE horizontal track at a random but deterministic vertical position
// (it depends only on the room code, like all generation: host, guests and the
// authoritative server see the same line). A train runs along it every 30 seconds:
// traffic stops at the crossing (except patrol cars mid-chase), the locomotive crushes
// any car it touches, and the carriages knock them about like a normal collision.

// ---------- Track geometry (deterministic from the seed) ----------
// Tile row the railway runs along: central band, never on the edges. hashStr (core.js)
// does NOT draw from the city's seeded generator, so adding the track does not disturb
// city.js's RNG sequence.
const RAIL_TY = 20 + hashStr(ROOM_CODE + ':RAIL') % Math.max(1, MAP_H - 40);
const RAIL_Y = (RAIL_TY + 0.5) * T;      // vertical position of the track (world px)
const RAIL_GAUGE = 20;                    // gauge: distance between the two rails
const RAIL_BALLAST = RAIL_GAUGE + 24;     // ballast (gravel) around the rails
const RAIL_TIE_H = RAIL_GAUGE + 14;       // sleeper length

// ---------- The train ----------
const TRAIN_PERIOD = 60 * 30;             // one pass every 30 s (frames)
const LOCO_L = 66, WAG_L = 52, WAG_N = 3, TRAIN_GAP = 8;   // locomotive + 3 carriages
const TRAIN_BODY_H = 30;                  // width (in Y) of the train's silhouette
const TRAIN_LEN = LOCO_L + WAG_N * (WAG_L + TRAIN_GAP);
const TRAIN_EDGE = TRAIN_LEN + 120;       // off-map margin at the start/end of a run
const TRAIN_TRAVEL = WORLD_W + 2 * TRAIN_EDGE;
const TRAIN_CROSS_F = Math.round(TRAIN_PERIOD * 0.72);     // frames to cross the whole map
const TRAIN_SPEED = TRAIN_TRAVEL / TRAIN_CROSS_F;          // px/frame (scales with the map)
const TRAIN_STOP_BAND = 2.6 * T;          // cars within this distance of the track stop
const TRAIN_WARN = 360;                   // horizontal margin within which the train holds traffic

// Train state: rebuilt every frame in updateTrainKinematics(); `segs` are the boxes
// (locomotive + carriages) with centre X, width and a locomotive flag.
const train = { active: false, isTrain: true, x: 0, y: RAIL_Y, dir: 1, headX: 0, minX: 0, maxX: 0, segs: [] };

// Train position as a function of `frame` alone (no randomness: identical on every
// client/server). Kinematics only — collisions live in trainCollide(), called AFTER
// cars and players have moved so the wall is solid (no one-frame overlap). A client
// rendering an authoritative server calls only this one (the server rules on impacts).
function updateTrainKinematics() {
  const phase = frame % TRAIN_PERIOD;
  const pass = Math.floor(frame / TRAIN_PERIOD);
  const dir = pass % 2 === 0 ? 1 : -1;                     // direction alternates each pass
  train.active = phase <= TRAIN_CROSS_F;
  if (!train.active) { train.segs.length = 0; return; }
  const traveled = phase * TRAIN_SPEED;
  const headX = dir > 0 ? -TRAIN_EDGE + traveled : WORLD_W + TRAIN_EDGE - traveled;   // nose of the train
  train.dir = dir; train.headX = headX; train.x = headX;
  // Silhouettes: from the nose back towards the tail (against the direction of travel).
  train.segs.length = 0;
  let off = 0;
  const addSeg = (len, loco) => { train.segs.push({ cx: headX - dir * (off + len / 2), w: len, loco }); off += len + TRAIN_GAP; };
  addSeg(LOCO_L, true);
  for (let i = 0; i < WAG_N; i++) addSeg(WAG_L, false);
  let minX = Infinity, maxX = -Infinity;
  for (const s of train.segs) { if (s.cx - s.w / 2 < minX) minX = s.cx - s.w / 2; if (s.cx + s.w / 2 > maxX) maxX = s.cx + s.w / 2; }
  train.minX = minX; train.maxX = maxX;
  // Rumble/whistle when near the player (on the server hear() is null ⇒ silent).
  if (frame % 10 === 0) { const h = hear(headX, RAIL_Y, 1000); if (h) sfx.train(h, phase < TRAIN_SPEED); }
}

// True if the train forces a traffic car to STOP (near the track and near the train).
function trainBlocking(c) {
  if (!train.active) return false;
  if (Math.abs(c.y - RAIL_Y) > TRAIN_STOP_BAND) return false;
  return c.x > train.minX - TRAIN_WARN && c.x < train.maxX + TRAIN_WARN;
}

// Train collisions (called AFTER movement). The train is an immovable WALL: it is never
// pushed. The locomotive crushes (destroys) any car it touches; the carriages are solid
// walls — a car touching one is shoved back out of the silhouette and slowed, as against
// a wall. On foot the locomotive is lethal, while a carriage knocks you back and hurts.
function trainCollide() {
  if (!train.active) return;
  const halfH = TRAIN_BODY_H / 2;
  // --- cars (backwards: explodeCar removes from the array) ---
  for (let i = cars.length - 1; i >= 0; i--) {
    const c = cars[i];
    const cr = c.colH;                                    // collision half-extent
    if (Math.abs(c.y - RAIL_Y) >= halfH + cr) continue;
    for (const s of train.segs) {
      if (c.x <= s.cx - s.w / 2 - cr || c.x >= s.cx + s.w / 2 + cr) continue;   // no overlap
      if (s.loco) { explodeCar(c); break; }              // run over: destroyed
      // Carriage = wall: push the car out of the side it is on, and brake it.
      const sign = c.y < RAIL_Y ? -1 : 1;
      const penY = (halfH + cr) - Math.abs(c.y - RAIL_Y);
      moveBox(c, 0, sign * (penY + 0.5), c.colH, c.colH);
      c.speed *= 0.3; c.kvx *= 0.5; c.kvy *= 0.5;         // hit a wall: almost stopped
      damageCar(c, 4);
      if (c.driver === 'player') { shake(5, 6); sfx.crash(); }
      break;
    }
  }
  eachActivePlayer(v => { if (v.car) { v.x = v.car.x; v.y = v.car.y; } });   // resync whoever is driving
  // --- players on foot ---
  eachActivePlayer(v => {
    if (v.car || v.downT > 0) return;
    if (Math.abs(v.y - RAIL_Y) >= halfH + v.r) return;
    for (const s of train.segs) {
      if (v.x <= s.cx - s.w / 2 - v.r || v.x >= s.cx + s.w / 2 + v.r) continue;
      const away = v.y < RAIL_Y ? -1 : 1;
      asPlayer(v, () => {
        hurtPlayer(s.loco ? 120 : 45, Math.atan2(away, train.dir));   // locomotive = lethal
        const penY = (halfH + player.r) - Math.abs(player.y - RAIL_Y);
        moveBox(player, 0, away * (penY + 1), player.r, player.r);     // pushed clear of the train
        shake(7, 9);
      });
      break;
    }
  });
}

// ---------- Drawing the railway (static, baked into the chunks by render.js) ----------
function drawRailway() {
  const sy = Math.round(RAIL_Y - camY);
  if (sy < -RAIL_BALLAST || sy > vh + RAIL_BALLAST) return;               // track outside this chunk
  // Ballast (gravel).
  ctx.fillStyle = '#484440';
  ctx.fillRect(0, sy - RAIL_BALLAST / 2, vw, RAIL_BALLAST);
  ctx.fillStyle = 'rgba(255,255,255,.05)';
  for (let wx = Math.floor(camX / 9) * 9; wx < camX + vw; wx += 9) {
    const px = Math.round(wx - camX), h = hash2(wx | 0, RAIL_TY);
    ctx.fillRect(px + (h & 3), sy - RAIL_BALLAST / 2 + (h >> 2) % RAIL_BALLAST, 2, 2);
  }
  // Sleepers.
  ctx.fillStyle = '#5a3f2a';
  const step = 16;
  for (let wx = Math.floor(camX / step) * step; wx < camX + vw + step; wx += step)
    ctx.fillRect(Math.round(wx - camX), sy - RAIL_TIE_H / 2, 6, RAIL_TIE_H);
  // The two steel rails, with a highlight along the top.
  ctx.fillStyle = '#8a9098';
  ctx.fillRect(0, sy - RAIL_GAUGE / 2 - 1, vw, 3);
  ctx.fillRect(0, sy + RAIL_GAUGE / 2 - 1, vw, 3);
  ctx.fillStyle = 'rgba(255,255,255,.30)';
  ctx.fillRect(0, sy - RAIL_GAUGE / 2 - 1, vw, 1);
  ctx.fillRect(0, sy + RAIL_GAUGE / 2 - 1, vw, 1);
}

// ---------- Drawing the train (dynamic entity, Y-sorted in render()) ----------
function drawTrain() {
  if (!train.active) return;
  const y = RAIL_Y - camY;
  for (const s of train.segs) {
    const x = s.cx - camX;
    if (x + s.w / 2 < -20 || x - s.w / 2 > vw + 20) continue;
    drawShadow(x + 3, y + 5, s.w / 2, TRAIN_BODY_H / 2);
  }
  for (let i = 0; i < train.segs.length; i++) {
    const s = train.segs[i];
    const x = s.cx - camX;
    if (x + s.w / 2 < -20 || x - s.w / 2 > vw + 20) continue;
    const hw = s.w / 2, hh = TRAIN_BODY_H / 2;
    // Body.
    ctx.fillStyle = s.loco ? '#8a2f2f' : (i % 2 ? '#3f6a8c' : '#3a7a5a');
    roundRect(x - hw, y - hh, s.w, TRAIN_BODY_H, 5); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = 1.5; roundRect(x - hw, y - hh, s.w, TRAIN_BODY_H, 5); ctx.stroke();
    // Roof.
    ctx.fillStyle = 'rgba(0,0,0,.22)'; roundRect(x - hw + 6, y - hh + 4, s.w - 12, TRAIN_BODY_H - 8, 3); ctx.fill();
    // Windows.
    ctx.fillStyle = 'rgba(150,210,255,.8)';
    for (let wx = x - hw + 11; wx < x + hw - 9; wx += 14) ctx.fillRect(wx, y - 4, 8, 8);
    if (s.loco) {
      const front = train.dir > 0 ? x + hw : x - hw;
      ctx.fillStyle = '#ffe9a0'; ctx.beginPath(); ctx.arc(front - train.dir * 4, y, 3, 0, TAU); ctx.fill();   // headlight
      ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(x - train.dir * hw * 0.4, y, 4, 0, TAU); ctx.fill();   // chimney
    }
  }
}
