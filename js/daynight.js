const DAY_DURATION_FRAMES = 25200;
const NIGHT_DURATION_FRAMES = 14400;
const DAY_CYCLE_FRAMES = DAY_DURATION_FRAMES + NIGHT_DURATION_FRAMES;

const DAY_NIGHT_KEYFRAMES = [
  { frame: 0,     r: 255, g: 255, b: 255, light: 0 },
  { frame: 21600, r: 255, g: 255, b: 255, light: 0 },
  { frame: 23400, r: 255, g: 170, b: 120, light: 0.4 },
  { frame: 25200, r: 70,  g: 85,  b: 140, light: 1 },
  { frame: 37800, r: 70,  g: 85,  b: 140, light: 1 },
  { frame: 38700, r: 230, g: 190, b: 200, light: 0.4 },
  { frame: 39600, r: 255, g: 255, b: 255, light: 0 },
];

function dayCycleFrame(elapsedFrames) {
  return ((Math.floor(elapsedFrames) % DAY_CYCLE_FRAMES) + DAY_CYCLE_FRAMES) % DAY_CYCLE_FRAMES;
}

function dayNightAmbient(cycleFrame) {
  let next = 1;
  while (DAY_NIGHT_KEYFRAMES[next].frame < cycleFrame) next++;
  const from = DAY_NIGHT_KEYFRAMES[next - 1], to = DAY_NIGHT_KEYFRAMES[next];
  const progress = (cycleFrame - from.frame) / (to.frame - from.frame);
  const mix = (a, b) => a + (b - a) * progress;
  return {
    r: Math.round(mix(from.r, to.r)),
    g: Math.round(mix(from.g, to.g)),
    b: Math.round(mix(from.b, to.b)),
    light: mix(from.light, to.light),
  };
}

const NIGHT_LIGHT_SCALE = 0.5;
const NIGHT_LAMP_RADIUS = 65;
const NIGHT_LAMP_CORE_ALPHA = 0.55;
const NIGHT_WINDOW_RADIUS = 20;
const NIGHT_WINDOW_MID_RATIO = 0.7;
const NIGHT_FIRE_RADIUS = 110;
const NIGHT_BLAST_RADIUS = 48;
const NIGHT_ROCKET_RADIUS = 36;
const NIGHT_HEADLIGHT_REACH = 120;
const NIGHT_HEADLIGHT_HALF_ANGLE = 0.5;
const NIGHT_LAMP_SPACING = 8;
const NIGHT_WINDOWS_PER_BUILDING = 3;
const NIGHT_WINDOW_LIT_PERCENT = 60;
const NIGHT_WINDOW_EDGE_INSET = 8;
const NIGHT_BLAST_COLORS = new Set(['#ffe14a', '#ff5a2a']);

const nightLightMap = { canvas: null, context: null };
const nightLightSprites = { lamp: null, window: null, fire: null, blast: null, rocket: null, headlight: null };
const nightLightSources = { lamps: null, windows: null };

function nightLightHash(index, slot) {
  let hash = Math.imul(index + 1, 0x9E3779B1) ^ Math.imul(slot + 1, 0x85EBCA6B);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x2C1B3C6D);
  hash ^= hash >>> 12;
  return hash >>> 0;
}

function nightLightRow(worldY) {
  return Math.min(MAP_H - 1, Math.max(0, Math.floor(worldY / T)));
}

function nightLightBucketByRow(points) {
  points.sort((a, b) => a.y - b.y);
  const rowStart = new Int32Array(MAP_H + 1);
  for (const point of points) rowStart[nightLightRow(point.y) + 1]++;
  for (let row = 0; row < MAP_H; row++) rowStart[row + 1] += rowStart[row];
  return { points, rowStart };
}

function nightLightLampBucket() {
  if (nightLightSources.lamps) return nightLightSources.lamps;
  const lamps = [];
  for (let ty = 0; ty < MAP_H; ty++) for (let tx = 0; tx < MAP_W; tx++) {
    if ((tx + ty) % NIGHT_LAMP_SPACING !== 0 || tileAt(tx, ty) !== SIDEWALK) continue;
    if (tileAt(tx - 1, ty) === ROAD || tileAt(tx + 1, ty) === ROAD || tileAt(tx, ty - 1) === ROAD || tileAt(tx, ty + 1) === ROAD) {
      lamps.push({ x: tx * T + T / 2, y: ty * T + T / 2 });
    }
  }
  return nightLightSources.lamps = nightLightBucketByRow(lamps);
}

function nightLightWindowBucket() {
  if (nightLightSources.windows) return nightLightSources.windows;
  const windows = [];
  bldgs.forEach((building, index) => {
    const usableWidth = (building.x1 - building.x0 + 1) * T - 2 * NIGHT_WINDOW_EDGE_INSET;
    for (let slot = 0; slot < NIGHT_WINDOWS_PER_BUILDING; slot++) {
      const hash = nightLightHash(index, slot);
      if (hash % 100 >= NIGHT_WINDOW_LIT_PERCENT) continue;
      windows.push({
        x: building.x0 * T + NIGHT_WINDOW_EDGE_INSET + ((hash >>> 8) % 1000) / 1000 * usableWidth,
        y: (building.y1 + 1) * T - building.lift / 2,
      });
    }
  });
  return nightLightSources.windows = nightLightBucketByRow(windows);
}

function buildStreetLamps() {
  return nightLightLampBucket().points;
}

function buildWindowLights() {
  return nightLightWindowBucket().points;
}

function nightLightCreateCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function buildNightLightSprite(worldRadius, rgb, coreAlpha = 1, midRatio = 0.4) {
  const radius = worldRadius * NIGHT_LIGHT_SCALE;
  const canvas = nightLightCreateCanvas(radius * 2, radius * 2);
  const spriteContext = canvas.getContext('2d');
  const gradient = spriteContext.createRadialGradient(radius, radius, 0, radius, radius, radius);
  gradient.addColorStop(0, `rgba(${rgb},${coreAlpha})`);
  gradient.addColorStop(0.45, `rgba(${rgb},${coreAlpha * midRatio})`);
  gradient.addColorStop(1, `rgba(${rgb},0)`);
  spriteContext.fillStyle = gradient;
  spriteContext.fillRect(0, 0, radius * 2, radius * 2);
  return canvas;
}

function buildNightHeadlightSprite() {
  const reach = NIGHT_HEADLIGHT_REACH * NIGHT_LIGHT_SCALE;
  const canvas = nightLightCreateCanvas(reach, reach * 2);
  const spriteContext = canvas.getContext('2d');
  const gradient = spriteContext.createRadialGradient(0, reach, 0, 0, reach, reach);
  gradient.addColorStop(0, 'rgba(255,255,235,0.9)');
  gradient.addColorStop(1, 'rgba(255,255,235,0)');
  spriteContext.fillStyle = gradient;
  spriteContext.beginPath();
  spriteContext.moveTo(0, reach);
  spriteContext.arc(0, reach, reach, -NIGHT_HEADLIGHT_HALF_ANGLE, NIGHT_HEADLIGHT_HALF_ANGLE);
  spriteContext.closePath();
  spriteContext.fill();
  return canvas;
}

function nightLightEnsureSprites() {
  if (nightLightSprites.lamp) return;
  nightLightSprites.lamp = buildNightLightSprite(NIGHT_LAMP_RADIUS, '255,190,110', NIGHT_LAMP_CORE_ALPHA);
  nightLightSprites.window = buildNightLightSprite(NIGHT_WINDOW_RADIUS, '255,200,110', 1, NIGHT_WINDOW_MID_RATIO);
  nightLightSprites.fire = buildNightLightSprite(NIGHT_FIRE_RADIUS, '255,130,50');
  nightLightSprites.blast = buildNightLightSprite(NIGHT_BLAST_RADIUS, '255,170,60');
  nightLightSprites.rocket = buildNightLightSprite(NIGHT_ROCKET_RADIUS, '255,160,60');
  nightLightSprites.headlight = buildNightHeadlightSprite();
}

function nightLightPrepareMap() {
  const width = Math.ceil(vw * NIGHT_LIGHT_SCALE), height = Math.ceil(vh * NIGHT_LIGHT_SCALE);
  if (!nightLightMap.canvas) {
    nightLightMap.canvas = nightLightCreateCanvas(width, height);
    nightLightMap.context = nightLightMap.canvas.getContext('2d');
  } else if (nightLightMap.canvas.width !== width || nightLightMap.canvas.height !== height) {
    nightLightMap.canvas.width = width;
    nightLightMap.canvas.height = height;
  }
  nightLightEnsureSprites();
  return nightLightMap.context;
}

function nightLightOnScreen(worldX, worldY, margin) {
  const x = worldX - camX, y = worldY - camY;
  return x >= -margin && y >= -margin && x <= vw + margin && y <= vh + margin;
}

function nightLightBlit(lightContext, sprite, worldX, worldY, scale) {
  const width = sprite.width * scale, height = sprite.height * scale;
  lightContext.drawImage(sprite, (worldX - camX) * NIGHT_LIGHT_SCALE - width / 2, (worldY - camY) * NIGHT_LIGHT_SCALE - height / 2, width, height);
}

function nightLightBlitBucket(lightContext, bucket, sprite, margin) {
  const firstRow = Math.max(0, Math.floor((camY - margin) / T));
  const lastRow = Math.min(MAP_H - 1, Math.floor((camY + vh + margin) / T));
  if (firstRow > lastRow) return;
  const { points, rowStart } = bucket;
  for (let index = rowStart[firstRow], end = rowStart[lastRow + 1]; index < end; index++) {
    const point = points[index];
    if (nightLightOnScreen(point.x, point.y, margin)) nightLightBlit(lightContext, sprite, point.x, point.y, 1);
  }
}

function nightLightHeadlight(lightContext, x, y, angle, length) {
  const frontX = x + Math.cos(angle) * length / 2, frontY = y + Math.sin(angle) * length / 2;
  if (!nightLightOnScreen(frontX, frontY, NIGHT_HEADLIGHT_REACH)) return;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  lightContext.setTransform(cos, sin, -sin, cos, (frontX - camX) * NIGHT_LIGHT_SCALE, (frontY - camY) * NIGHT_LIGHT_SCALE);
  lightContext.drawImage(nightLightSprites.headlight, 0, -nightLightSprites.headlight.height / 2);
}

function nightLightCarHeadlight(lightContext, car) {
  if (!car.driver && car.role === 'parked') return;
  nightLightHeadlight(lightContext, car.x, car.y, car.angle, car.w || 24);
}

function drawNightLightSources(lightContext) {
  nightLightBlitBucket(lightContext, nightLightLampBucket(), nightLightSprites.lamp, NIGHT_LAMP_RADIUS);
  nightLightBlitBucket(lightContext, nightLightWindowBucket(), nightLightSprites.window, NIGHT_WINDOW_RADIUS);
  for (const car of cars) nightLightCarHeadlight(lightContext, car);
  if (netActive()) {
    for (const ghost of net.players.values()) if (ghost.car && !ghost.down && (!net.authoritative || ghost.seen)) nightLightCarHeadlight(lightContext, ghost.car);
    for (const car of net.remoteCops.values()) nightLightCarHeadlight(lightContext, car);
  }
  for (const segment of train.segs) if (segment.loco) nightLightHeadlight(lightContext, segment.cx, segment.cy, segment.angle, segment.w);
  lightContext.setTransform(1, 0, 0, 1, 0, 0);
  const flicker = 0.9 + 0.1 * Math.sin(frame * 0.3);
  for (const fire of fires) if (nightLightOnScreen(fire.x, fire.y, NIGHT_FIRE_RADIUS)) nightLightBlit(lightContext, nightLightSprites.fire, fire.x, fire.y, flicker);
  for (const rocket of rockets) if (nightLightOnScreen(rocket.x, rocket.y, NIGHT_ROCKET_RADIUS)) nightLightBlit(lightContext, nightLightSprites.rocket, rocket.x, rocket.y, 1);
  for (const particle of parts) {
    if (particle.life > 3 && NIGHT_BLAST_COLORS.has(particle.color) && nightLightOnScreen(particle.x, particle.y, NIGHT_BLAST_RADIUS)) {
      nightLightBlit(lightContext, nightLightSprites.blast, particle.x, particle.y, 1);
    }
  }
}

function drawDayNight() {
  if (!dayNightOn || vw <= 0 || vh <= 0) return;
  const ambient = dayNightAmbient(dayCycleFrame(matchElapsedFrames));
  if (ambient.r === 255 && ambient.g === 255 && ambient.b === 255) return;
  const lightContext = nightLightPrepareMap();
  lightContext.fillStyle = `rgb(${ambient.r},${ambient.g},${ambient.b})`;
  lightContext.fillRect(0, 0, nightLightMap.canvas.width, nightLightMap.canvas.height);
  lightContext.globalCompositeOperation = 'lighter';
  lightContext.globalAlpha = ambient.light;
  drawNightLightSources(lightContext);
  lightContext.globalCompositeOperation = 'source-over';
  lightContext.globalAlpha = 1;
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(nightLightMap.canvas, 0, 0, vw, vh);
  ctx.globalCompositeOperation = 'source-over';
}
