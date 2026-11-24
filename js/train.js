// LIBRE CITY · js/train.js — ring railway and looping train.
// The track is a closed loop inside the outer ring road (railPointAt in city.js): it
// depends only on the room code, like all generation, so host, guests and the
// authoritative server see the same line. One train runs around it without stopping:
// traffic stops at the level crossings while it is near (except patrol cars mid-chase),
// the locomotive crushes any car it touches, and the carriages are solid walls.

const RAIL_GAUGE = 20;                    // gauge: distance between the two rails
const RAIL_BALLAST = RAIL_GAUGE + 24;     // ballast (gravel) around the rails
const RAIL_TIE_H = RAIL_GAUGE + 14;       // sleeper length

// ---------- The train ----------
const TRAIN_SPEED = 6.5;                  // px/frame
const LOCO_L = 66, WAG_L = 52, WAG_N = 3, TRAIN_GAP = 8;   // locomotive + 3 carriages
const TRAIN_BODY_H = 30;                  // width of the train's silhouette across the track
const TRAIN_LEN = LOCO_L + WAG_N * (WAG_L + TRAIN_GAP);
const TRAIN_STOP_BAND = 2.6 * T;          // cars within this distance of a crossing stop
const TRAIN_WARN = 360;                   // margin along the track within which the train holds traffic
const TRAIN_HORN_NEAR = 300, TRAIN_HORN_FAR = 370;

// Train state: rebuilt every frame in updateTrainKinematics(); `segs` are the oriented
// boxes (locomotive + carriages) with centre, heading, length and a locomotive flag.
const train = { x: 0, y: 0, s: 0, segs: [] };
const railWrap = along => ((along % RAIL_LOOP_LEN) + RAIL_LOOP_LEN) % RAIL_LOOP_LEN;

// Train position as a function of `trainClock` alone (default `frame`; a client rendering
// a server passes the snapshot tick): no randomness, identical on every client/server. Kinematics only — collisions live in trainCollide(), called AFTER
// cars and players have moved so the wall is solid (no one-frame overlap). A client
// rendering an authoritative server calls only this one (the server rules on impacts).
function updateTrainKinematics(trainClock = frame) {
  const headS = railWrap(trainClock * TRAIN_SPEED), head = railPointAt(headS);
  train.s = headS; train.x = head.x; train.y = head.y;
  train.segs.length = 0;
  let off = 0;
  const addSeg = (len, loco) => {
    const p = railPointAt(headS - (off + len / 2));
    train.segs.push({ isTrainSegment: true, index: train.segs.length, cx: p.x, cy: p.y, y: p.y, angle: p.angle, cos: Math.cos(p.angle), sin: Math.sin(p.angle), w: len, loco });
    off += len + TRAIN_GAP;
  };
  addSeg(LOCO_L, true);
  for (let i = 0; i < WAG_N; i++) addSeg(WAG_L, false);
  // Rumble/whistle when near the player (on the server hear() is null ⇒ silent).
  if (frame % 10 === 0) {
    const h = hear(train.x, train.y, 1000);
    if (h) sfx.train(h, railCrossings.some(cr => { const ahead = railWrap(cr.s - headS); return ahead >= TRAIN_HORN_NEAR && ahead <= TRAIN_HORN_FAR; }));
  }
}

// True if the train forces a traffic car to STOP (near a crossing and near the train).
function trainBlocking(c) {
  const reach = TRAIN_STOP_BAND + c.colH, spanStart = train.s - TRAIN_LEN - TRAIN_WARN, span = TRAIN_LEN + 2 * TRAIN_WARN;
  for (const cr of railCrossings) {
    const dx = c.x - cr.x, dy = c.y - cr.y;
    if (Math.abs(dx) > reach || Math.abs(dy) > reach || Math.hypot(dx, dy) > reach) continue;
    if (railWrap(cr.s - spanStart) <= span) return true;
  }
  return false;
}

// Train collisions (called AFTER movement). The train is an immovable WALL: it is never
// pushed. The locomotive crushes (destroys) any car it touches; the carriages are solid
// walls — a car touching one is shoved back out of the silhouette and slowed, as against
// a wall. On foot the locomotive is lethal, while a carriage knocks you back and hurts.
function trainCollide() {
  const halfH = TRAIN_BODY_H / 2;
  // --- cars (backwards: explodeCar removes from the array) ---
  for (let i = cars.length - 1; i >= 0; i--) {
    const c = cars[i];
    const cr = c.colH;                                    // collision half-extent
    for (const s of train.segs) {
      const dx = c.x - s.cx, dy = c.y - s.cy, reach = s.w / 2 + halfH + 2 * cr;
      if (Math.abs(dx) > reach || Math.abs(dy) > reach) continue;
      const lx = dx * s.cos + dy * s.sin, ly = dy * s.cos - dx * s.sin;
      const penX = s.w / 2 + cr - Math.abs(lx), penY = halfH + cr - Math.abs(ly);
      if (penX <= 0 || penY <= 0) continue;               // no overlap
      if (s.loco) { explodeCar(c); break; }              // run over: destroyed
      // Carriage = wall: push the car out along the shallower side, and brake it.
      const alongTrack = penX < penY;
      const pushX = alongTrack ? (lx < 0 ? -1 : 1) * (penX + 0.5) : 0, pushY = alongTrack ? 0 : (ly < 0 ? -1 : 1) * (penY + 0.5);
      moveBox(c, pushX * s.cos - pushY * s.sin, pushX * s.sin + pushY * s.cos, c.colH, c.colH);
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
    for (const s of train.segs) {
      const dx = v.x - s.cx, dy = v.y - s.cy;
      const lx = dx * s.cos + dy * s.sin, ly = dy * s.cos - dx * s.sin;
      const penY = halfH + v.r - Math.abs(ly);
      if (Math.abs(lx) >= s.w / 2 + v.r || penY <= 0) continue;
      const away = ly < 0 ? -1 : 1;
      asPlayer(v, () => {
        hurtPlayer(s.loco ? 120 : 45, s.angle + Math.atan2(away, 1));   // locomotive = lethal
        moveBox(player, -s.sin * away * (penY + 1), s.cos * away * (penY + 1), player.r, player.r);   // pushed clear of the train
        shake(7, 9);
      });
      break;
    }
  });
}

// ---------- Drawing the railway (static, baked into the chunks by render.js) ----------
function railAlongSpans(rx0, ry0, rx1, ry1) {
  const { straights, arcLen, sideStarts } = railLoop, spans = [], pad = 1;
  const axisRange = (start, direction, low, high) => direction > 0 ? [low - start, high - start]
    : direction < 0 ? [start - high, start - low]
    : start >= low && start <= high ? [-Infinity, Infinity] : [Infinity, -Infinity];
  let along = 0;
  for (let side = 0; side < 4; side++) {
    const length = straights[side % 2], [sx, sy] = sideStarts[side], dx = [1, 0, -1, 0][side], dy = [0, 1, 0, -1][side];
    const [xLow, xHigh] = axisRange(sx, dx, rx0, rx1), [yLow, yHigh] = axisRange(sy, dy, ry0, ry1);
    const low = Math.max(0, xLow, yLow), high = Math.min(length, xHigh, yHigh);
    if (low <= high) spans.push([along + low - pad, along + high + pad]);
    along += length;
    const ex = sx + dx * length, ey = sy + dy * length, [nx, ny] = sideStarts[(side + 1) % 4];
    if (Math.min(ex, nx) <= rx1 && Math.max(ex, nx) >= rx0 && Math.min(ey, ny) <= ry1 && Math.max(ey, ny) >= ry0) spans.push([along - pad, along + arcLen + pad]);
    along += arcLen;
  }
  return spans;
}
function drawRailway() {
  const { x0, y0, x1, y1 } = railLoop, r = RAIL_CORNER_R, b = RAIL_BALLAST;
  const touches = (ax0, ay0, ax1, ay1) => camX < ax1 && camX + vw > ax0 && camY < ay1 && camY + vh > ay0;
  if (!touches(x0 - b, y0 - b, x1 + b, y0 + r + b) && !touches(x0 - b, y1 - r - b, x1 + b, y1 + b)
    && !touches(x0 - b, y0 - b, x0 + r + b, y1 + b) && !touches(x1 - r - b, y0 - b, x1 + b, y1 + b)) return;   // track outside this chunk
  const loopPath = inset => roundRect(x0 + inset - camX, y0 + inset - camY, x1 - x0 - 2 * inset, y1 - y0 - 2 * inset, r - inset);
  const inChunk = p => p.x > camX - b && p.x < camX + vw + b && p.y > camY - b && p.y < camY + vh + b;
  const spans = railAlongSpans(camX - b, camY - b, camX + vw + b, camY + vh + b);
  const forEachRailStep = (step, visit) => {
    let along = 0;
    for (const [low, high] of spans)
      for (along = Math.max(along, Math.ceil(low / step) * step); along <= high && along < RAIL_LOOP_LEN; along += step) visit(along, railPointAt(along));
  };
  ctx.save();
  clipOutTiles((tx, ty) => tileAt(tx, ty) === ROAD);
  // Ballast (gravel).
  ctx.strokeStyle = '#484440'; ctx.lineWidth = b; loopPath(0); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.05)';
  forEachRailStep(9, (along, p) => {
    if (!inChunk(p)) return;
    const h = hash2(along | 0, RAIL_INSET), side = (h >> 2) % b - b / 2, jitter = h & 3;
    ctx.fillRect(p.x - camX + Math.cos(p.angle) * jitter - Math.sin(p.angle) * side, p.y - camY + Math.sin(p.angle) * jitter + Math.cos(p.angle) * side, 2, 2);
  });
  // Sleepers.
  ctx.fillStyle = '#5a3f2a';
  ctx.beginPath();
  forEachRailStep(16, (along, p) => {
    if (!inChunk(p) || tileAt(Math.floor(p.x / T), Math.floor(p.y / T)) === ROAD) return;
    const tx = Math.cos(p.angle) * 3, ty = Math.sin(p.angle) * 3, nx = -Math.sin(p.angle) * RAIL_TIE_H / 2, ny = Math.cos(p.angle) * RAIL_TIE_H / 2;
    const sx = p.x - camX, sy = p.y - camY;
    ctx.moveTo(sx - tx - nx, sy - ty - ny); ctx.lineTo(sx + tx - nx, sy + ty - ny);
    ctx.lineTo(sx + tx + nx, sy + ty + ny); ctx.lineTo(sx - tx + nx, sy - ty + ny); ctx.closePath();
  });
  ctx.fill();
  ctx.restore();
  // The two steel rails, with a highlight along the top.
  ctx.strokeStyle = '#8a9098'; ctx.lineWidth = 3;
  loopPath(-RAIL_GAUGE / 2); ctx.stroke();
  loopPath(RAIL_GAUGE / 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.30)'; ctx.lineWidth = 1;
  loopPath(-RAIL_GAUGE / 2); ctx.stroke();
  loopPath(RAIL_GAUGE / 2); ctx.stroke();
  ctx.fillStyle = 'rgba(240,240,240,.85)';
  const stopHalf = HALF_ROAD - 6, stopOff = RAIL_TIE_H / 2 + T;
  for (const cr of railCrossings) {
    if (cr.x < camX - 3 * T || cr.x > camX + vw + 3 * T || cr.y < camY - 3 * T || cr.y > camY + vh + 3 * T) continue;
    const angle = railPointAt(cr.s).angle;
    for (let side = -1; side <= 1; side += 2) {
      ctx.save();
      ctx.translate(cr.x - camX - Math.sin(angle) * side * stopOff, cr.y - camY + Math.cos(angle) * side * stopOff);
      ctx.rotate(angle);
      ctx.fillRect(-stopHalf, -2, 2 * stopHalf, 4);
      ctx.restore();
    }
  }
}

// ---------- Drawing the train (dynamic entity, Y-sorted in render()) ----------
function trainSegmentVisible(s) {
  const x = s.cx - camX, y = s.cy - camY, hw = s.w / 2;
  return x + hw >= -20 && x - hw <= vw + 20 && y + hw >= -20 && y - hw <= vh + 20;
}
function pushTrainSegments(ents) {
  for (const s of train.segs) ents.push(s);
}
function drawTrainShadows() {
  for (const s of train.segs) {
    if (!trainSegmentVisible(s)) continue;
    ctx.save(); ctx.translate(s.cx - camX + 3, s.cy - camY + 5); ctx.rotate(s.angle);
    drawShadow(0, 0, s.w / 2, TRAIN_BODY_H / 2);
    ctx.restore();
  }
}
function drawTrainSegment(s) {
  if (!trainSegmentVisible(s)) return;
  const hw = s.w / 2, hh = TRAIN_BODY_H / 2;
  ctx.save(); ctx.translate(s.cx - camX, s.cy - camY); ctx.rotate(s.angle);
  // Body.
  ctx.fillStyle = s.loco ? '#8a2f2f' : (s.index % 2 ? '#3f6a8c' : '#3a7a5a');
  roundRect(-hw, -hh, s.w, TRAIN_BODY_H, 5); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = 1.5; roundRect(-hw, -hh, s.w, TRAIN_BODY_H, 5); ctx.stroke();
  // Roof.
  ctx.fillStyle = 'rgba(0,0,0,.22)'; roundRect(-hw + 6, -hh + 4, s.w - 12, TRAIN_BODY_H - 8, 3); ctx.fill();
  // Windows.
  ctx.fillStyle = 'rgba(150,210,255,.8)';
  for (let wx = -hw + 11; wx < hw - 9; wx += 14) ctx.fillRect(wx, -4, 8, 8);
  if (s.loco) {
    ctx.fillStyle = '#ffe9a0'; ctx.beginPath(); ctx.arc(hw - 4, 0, 3, 0, TAU); ctx.fill();   // headlight
    ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(-hw * 0.4, 0, 4, 0, TAU); ctx.fill();   // chimney
  }
  ctx.restore();
}
