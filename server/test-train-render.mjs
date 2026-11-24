import vm from 'node:vm';
import runtime from './sim-runtime.js';
import stubs from '../js/sim-stubs.js';
import { readSource, extractTopLevel, createRecordingContext } from './render-test-kit.mjs';
const { BUNDLE } = runtime;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const CODES = ['PTRN0', 'PTRN1', 'MTRN0', 'GTRN0'];
const CHUNK = 1024, T = 32;
const RENDER_SOURCE = readSource('render.js');
const RENDER_HELPERS = [
  extractTopLevel(RENDER_SOURCE, 'roundRect'),
  extractTopLevel(RENDER_SOURCE, 'clipOutTiles'),
  extractTopLevel(RENDER_SOURCE, 'drawArmyGate'),
  RENDER_SOURCE.match(/^function drawShadow\(.*$/m)[0],
].join('\n');

const REFERENCE_DRAW_RAILWAY = `function referenceDrawRailway() {
  const { x0, y0, x1, y1 } = railLoop, r = RAIL_CORNER_R, b = RAIL_BALLAST;
  const touches = (ax0, ay0, ax1, ay1) => camX < ax1 && camX + vw > ax0 && camY < ay1 && camY + vh > ay0;
  if (!touches(x0 - b, y0 - b, x1 + b, y0 + r + b) && !touches(x0 - b, y1 - r - b, x1 + b, y1 + b)
    && !touches(x0 - b, y0 - b, x0 + r + b, y1 + b) && !touches(x1 - r - b, y0 - b, x1 + b, y1 + b)) return;
  const loopPath = inset => roundRect(x0 + inset - camX, y0 + inset - camY, x1 - x0 - 2 * inset, y1 - y0 - 2 * inset, r - inset);
  const inChunk = p => p.x > camX - b && p.x < camX + vw + b && p.y > camY - b && p.y < camY + vh + b;
  ctx.save();
  clipOutTiles((tx, ty) => tileAt(tx, ty) === ROAD);
  ctx.strokeStyle = '#484440'; ctx.lineWidth = b; loopPath(0); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.05)';
  for (let along = 0; along < RAIL_LOOP_LEN; along += 9) {
    const p = railPointAt(along);
    if (!inChunk(p)) continue;
    const h = hash2(along | 0, RAIL_INSET), side = (h >> 2) % b - b / 2, jitter = h & 3;
    ctx.fillRect(p.x - camX + Math.cos(p.angle) * jitter - Math.sin(p.angle) * side, p.y - camY + Math.sin(p.angle) * jitter + Math.cos(p.angle) * side, 2, 2);
  }
  ctx.fillStyle = '#5a3f2a';
  ctx.beginPath();
  for (let along = 0; along < RAIL_LOOP_LEN; along += 16) {
    const p = railPointAt(along);
    if (!inChunk(p) || tileAt(Math.floor(p.x / T), Math.floor(p.y / T)) === ROAD) continue;
    const tx = Math.cos(p.angle) * 3, ty = Math.sin(p.angle) * 3, nx = -Math.sin(p.angle) * RAIL_TIE_H / 2, ny = Math.cos(p.angle) * RAIL_TIE_H / 2;
    const sx = p.x - camX, sy = p.y - camY;
    ctx.moveTo(sx - tx - nx, sy - ty - ny); ctx.lineTo(sx + tx - nx, sy + ty - ny);
    ctx.lineTo(sx + tx + nx, sy + ty + ny); ctx.lineTo(sx - tx + nx, sy - ty + ny); ctx.closePath();
  }
  ctx.fill();
  ctx.restore();
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
}`;

const TRACE_RAIL = `const railPointAtUntraced = railPointAt;
var railCallAlongs = [];
railPointAt = s => { railCallAlongs.push(s); return railPointAtUntraced(s); };`;

function loadCity(code) {
  const sandbox = stubs.makeSimStubs(code, 900, { setTimeout, clearTimeout, setInterval, clearInterval });
  sandbox.makeRecorder = createRecordingContext;
  const context = vm.createContext(sandbox);
  vm.runInContext(BUNDLE, context, { timeout: 10000 });
  vm.runInContext(RENDER_HELPERS + '\n' + REFERENCE_DRAW_RAILWAY + '\n' + TRACE_RAIL, context);
  return expr => vm.runInContext(expr, context);
}

const CHECK_CHUNK = (cx, cy) => `(() => {
  camX = ${cx * CHUNK}; camY = ${cy * CHUNK}; vw = ${CHUNK}; vh = ${CHUNK};
  const b = RAIL_BALLAST;
  const inChunk = s => { const p = railPointAtUntraced(s); return p.x > camX - b && p.x < camX + vw + b && p.y > camY - b && p.y < camY + vh + b; };
  const record = draw => {
    const recorder = makeRecorder(); ctx = recorder.context; railCallAlongs = [];
    draw();
    return { calls: JSON.stringify(recorder.calls), alongs: railCallAlongs };
  };
  const reference = record(referenceDrawRailway), current = record(drawRailway);
  const drawnSet = alongs => [...new Set(alongs.filter(inChunk))].sort((a, b) => a - b).join();
  return JSON.stringify({
    touched: reference.calls !== '[]',
    sameCalls: reference.calls === current.calls,
    sameDrawnAlongs: drawnSet(reference.alongs) === drawnSet(current.alongs),
    drawnAlongs: new Set(current.alongs.filter(inChunk)).size,
    referenceCount: reference.alongs.length, currentCount: current.alongs.length,
  });
})()`;

const FIND_VERTICAL_TRAIN = `(() => {
  for (let clock = 0; clock < RAIL_LOOP_LEN / TRAIN_SPEED; clock += 7) {
    updateTrainKinematics(clock);
    if (train.segs.every(s => Math.abs(Math.cos(s.angle)) < 1e-9)) return clock;
  }
  return -1;
})()`;

const CHECK_SORT_ENTRIES = `(() => {
  const ents = [];
  pushTrainSegments(ents);
  const between = { y: (train.segs[0].y + train.segs[1].y) / 2 };
  const sorted = [...ents, between].sort((a, b) => a.y - b.y), order = sorted.indexOf(between);
  const firstTwo = [sorted.indexOf(train.segs[0]), sorted.indexOf(train.segs[1])].sort((a, b) => a - b);
  return JSON.stringify({
    count: ents.length, segments: train.segs.length, expected: 1 + WAG_N,
    sameObjects: ents.every((e, k) => e === train.segs[k]),
    centred: ents.every(e => e.isTrainSegment && e.y === e.cy),
    interleaves: order > firstTwo[0] && order < firstTwo[1],
  });
})()`;

const CHECK_TRAIN_DRAW = `(() => {
  const middle = train.segs[1];
  camX = middle.cx - 512; camY = middle.cy - 512; vw = 1024; vh = 1024;
  const shadowRecorder = makeRecorder(); ctx = shadowRecorder.context;
  drawTrainShadows();
  const shadows = shadowRecorder.calls.filter(([name]) => name === 'ellipse').length;
  const visible = train.segs.filter(trainSegmentVisible).length;
  const bodies = train.segs.map(s => {
    const recorder = makeRecorder(); ctx = recorder.context;
    drawTrainSegment(s);
    const rotations = recorder.calls.filter(([name]) => name === 'rotate');
    const translate = recorder.calls.find(([name]) => name === 'translate');
    const bodyColour = recorder.calls.find(([name]) => name === 'set:fillStyle')[1][0];
    return {
      ellipses: recorder.calls.filter(([name]) => name === 'ellipse').length,
      oneSegment: rotations.length === 1 && rotations[0][1][0] === s.angle && translate[1][0] === s.cx - camX && translate[1][1] === s.cy - camY,
      colourOk: bodyColour === (s.loco ? '#8a2f2f' : (s.index % 2 ? '#3f6a8c' : '#3a7a5a')),
    };
  });
  return JSON.stringify({ shadows, visible, total: train.segs.length, bodies });
})()`;

const CHECK_GATE_DRAW = `(() => {
  const army = landmarks.find(l => l.type === 'army');
  const gateTileX = Math.floor(army.gate.x / T), gateTileY = Math.floor(army.gate.y / T);
  const horizontalFence = gateTileY === army.y0 || gateTileY === army.y1;
  const opening = [];
  if (horizontalFence) { for (let x = army.x0; x <= army.x1; x++) if (tileAt(x, gateTileY) !== BUILDING) opening.push(x); }
  else for (let y = army.y0; y <= army.y1; y++) if (tileAt(gateTileX, y) !== BUILDING) opening.push(y);
  const ends = [opening[0] * T, (opening[opening.length - 1] + 1) * T];
  const fenceLine = horizontalFence ? army.gate.y : army.gate.x;
  const inwardSign = horizontalFence ? (gateTileY === army.y0 ? 1 : -1) : (gateTileX === army.x0 ? 1 : -1);
  camX = army.gate.x - 512; camY = army.gate.y - 512; vw = 1024; vh = 1024;
  const recorder = makeRecorder(); ctx = recorder.context;
  drawArmyGate(army);
  const posts = recorder.calls.filter(([name, args]) => name === 'fillRect' && args[2] === 10 && args[3] === 10)
    .map(([, [x, y]]) => horizontalFence ? x + 5 + camX : y + 5 + camY).sort((a, b) => a - b);
  const depths = recorder.calls.filter(([name]) => name === 'lineTo')
    .map(([, [x, y]]) => ((horizontalFence ? y + camY : x + camX) - fenceLine) * inwardSign);
  return JSON.stringify({ openingTiles: opening.length, ends, posts, maxDepth: Math.max(...depths), minDepth: Math.min(...depths) });
})()`;

const renderBody = extractTopLevel(RENDER_SOURCE, 'render');
const shadowsAt = renderBody.indexOf('drawTrainShadows();'), entityLoopAt = renderBody.indexOf('for (const e of ents)');
console.log('0) render() wiring');
ok(!renderBody.includes('ents.push(train)'), 'render() no longer sorts the whole train as one entity');
ok(renderBody.includes('pushTrainSegments(ents);'), 'render() pushes one sort entry per train segment');
ok(shadowsAt >= 0 && shadowsAt < entityLoopAt, 'train shadows are drawn in one pass before the sorted entity loop');
ok(renderBody.includes('else if (e.isTrainSegment) drawTrainSegment(e);'), 'a train sort entry draws only its own segment');
const gateSource = extractTopLevel(RENDER_SOURCE, 'drawArmyGate');
ok(extractTopLevel(RENDER_SOURCE, 'drawLandmarks').includes('drawArmyGate(lm);'), 'the baked landmark pass draws the army gate');
ok(!/\bframe\b|Date|performance|Math\.random/.test(gateSource), 'the gate drawing is static (no clock or randomness)');

for (const code of CODES) {
  console.log(code);
  const run = loadCity(code);
  const chunksX = Math.ceil(run('WORLD_W') / CHUNK), chunksY = Math.ceil(run('WORLD_H') / CHUNK);
  let touched = 0, worstRatio = Infinity, drawnAlongs = 0;
  const callMismatch = [], alongMismatch = [], slowChunks = [];
  for (let cy = 0; cy < chunksY; cy++) for (let cx = 0; cx < chunksX; cx++) {
    const chunk = JSON.parse(run(CHECK_CHUNK(cx, cy)));
    if (!chunk.sameCalls) callMismatch.push(`${cx},${cy}`);
    if (!chunk.touched) continue;
    touched++;
    drawnAlongs += chunk.drawnAlongs;
    if (!chunk.sameDrawnAlongs) alongMismatch.push(`${cx},${cy}`);
    const ratio = chunk.referenceCount / Math.max(1, chunk.currentCount);
    worstRatio = Math.min(worstRatio, ratio);
    if (ratio < 5) slowChunks.push(`${cx},${cy} (${chunk.referenceCount} -> ${chunk.currentCount})`);
  }
  ok(touched > 0 && drawnAlongs > 0, `${code}: ${touched} chunks touch the rail (${drawnAlongs} pattern samples drawn)`);
  ok(callMismatch.length === 0, `${code}: drawRailway issues exactly the reference draw calls in every chunk${callMismatch.length ? ' (differs at ' + callMismatch.slice(0, 10).join(' ') + ')' : ''}`);
  ok(alongMismatch.length === 0, `${code}: the drawn along values equal the full-ring reference${alongMismatch.length ? ' (differs at ' + alongMismatch.slice(0, 10).join(' ') + ')' : ''}`);
  ok(slowChunks.length === 0, `${code}: railPointAt calls per chunk drop by >= 5x (worst ${worstRatio.toFixed(1)}x)${slowChunks.length ? ': ' + slowChunks.slice(0, 10).join(' ') : ''}`);

  const verticalClock = run(FIND_VERTICAL_TRAIN);
  ok(verticalClock >= 0, `${code}: the train runs along a vertical side at clock ${verticalClock}`);
  const sortEntries = JSON.parse(run(CHECK_SORT_ENTRIES));
  ok(sortEntries.count === sortEntries.expected && sortEntries.segments === sortEntries.expected && sortEntries.sameObjects,
    `${code}: one sort entry per segment (${sortEntries.count} of ${sortEntries.expected})`);
  ok(sortEntries.centred, `${code}: every sort entry y is its segment centre`);
  ok(sortEntries.interleaves, `${code}: an entity between two carriages sorts between them`);
  const trainDraw = JSON.parse(run(CHECK_TRAIN_DRAW));
  ok(trainDraw.visible === trainDraw.total && trainDraw.shadows === trainDraw.total, `${code}: one shadow under every segment (${trainDraw.shadows} of ${trainDraw.total})`);
  ok(trainDraw.bodies.every(body => body.ellipses === 0 && body.oneSegment && body.colourOk), `${code}: a segment entry draws only its own body, no shadow, same livery`);

  const gate = JSON.parse(run(CHECK_GATE_DRAW));
  ok(gate.openingTiles === 5, `${code}: the gate opening is 5 tiles`);
  ok(gate.posts.length === 2 && gate.posts.every((post, k) => Math.abs(post - gate.ends[k]) < 1e-6), `${code}: two gate posts stand at the ends of the opening (${gate.posts.map(p => p.toFixed(1)).join(', ')} vs ${gate.ends.join(', ')})`);
  ok(gate.maxDepth > T && gate.maxDepth < 3 * T && gate.minDepth > -T / 4, `${code}: the gate leaves swing open into the yard (depth ${gate.minDepth.toFixed(1)}..${gate.maxDepth.toFixed(1)} px)`);
}

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
