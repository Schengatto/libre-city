// LIBRE CITY · js/train.js — ferrovia e treno di passaggio.
// Ogni mappa ha UN binario orizzontale, a una quota verticale casuale ma
// deterministica (dipende solo dal codice stanza, come tutta la generazione:
// host, ospiti e server autoritativo vedono la stessa linea). Un treno la
// percorre ogni 30 secondi: le auto del traffico si fermano al passaggio
// (tranne le volanti in inseguimento), la locomotiva schiaccia le auto che
// tocca, i vagoni le sballottano come un normale urto.

// ---------- Geometria del binario (deterministica dal seme) ----------
// Riga di tile su cui corre la ferrovia: fascia centrale, mai sui bordi.
// hashStr (core.js) NON pesca dal generatore seedato della città: così
// aggiungere il binario non altera la sequenza RNG di city.js.
const RAIL_TY = 20 + hashStr(ROOM_CODE + ':RAIL') % Math.max(1, MAP_H - 40);
const RAIL_Y = (RAIL_TY + 0.5) * T;      // quota verticale del binario (px mondo)
const RAIL_GAUGE = 20;                    // scartamento: distanza fra le due rotaie
const RAIL_BALLAST = RAIL_GAUGE + 24;     // massicciata (ghiaia) attorno alle rotaie
const RAIL_TIE_H = RAIL_GAUGE + 14;       // lunghezza delle traversine

// ---------- Il treno ----------
const TRAIN_PERIOD = 60 * 30;             // un passaggio ogni 30 s (frame)
const LOCO_L = 66, WAG_L = 52, WAG_N = 3, TRAIN_GAP = 8;   // locomotiva + 3 vagoni
const TRAIN_BODY_H = 30;                  // larghezza (in Y) della sagoma del treno
const TRAIN_LEN = LOCO_L + WAG_N * (WAG_L + TRAIN_GAP);
const TRAIN_EDGE = TRAIN_LEN + 120;       // margine fuori mappa a inizio/fine corsa
const TRAIN_TRAVEL = WORLD_W + 2 * TRAIN_EDGE;
const TRAIN_CROSS_F = Math.round(TRAIN_PERIOD * 0.72);     // frame per attraversare tutta la mappa
const TRAIN_SPEED = TRAIN_TRAVEL / TRAIN_CROSS_F;          // px/frame (scala con la mappa)
const TRAIN_STOP_BAND = 2.6 * T;          // entro questa distanza dal binario le auto si fermano
const TRAIN_WARN = 360;                   // margine orizzontale entro cui il treno "blocca" il traffico

// stato del treno: rigenerato ogni frame in updateTrains(); `segs` sono i
// riquadri (locomotiva + vagoni) con centro X, larghezza e flag locomotiva.
const train = { active: false, isTrain: true, x: 0, y: RAIL_Y, dir: 1, headX: 0, minX: 0, maxX: 0, segs: [] };

// posizione del treno in funzione del solo `frame` (nessuna casualità: identica
// su ogni client/server). doCollisions=false ⇒ solo cinematica (client che RENDE
// un server autoritativo: gli urti li decide il server).
function updateTrains(doCollisions) {
  const phase = frame % TRAIN_PERIOD;
  const pass = Math.floor(frame / TRAIN_PERIOD);
  const dir = pass % 2 === 0 ? 1 : -1;                     // direzione alternata a ogni passaggio
  train.active = phase <= TRAIN_CROSS_F;
  if (!train.active) { train.segs.length = 0; return; }
  const traveled = phase * TRAIN_SPEED;
  const headX = dir > 0 ? -TRAIN_EDGE + traveled : WORLD_W + TRAIN_EDGE - traveled;   // muso del treno
  train.dir = dir; train.headX = headX; train.x = headX;
  // sagome: dal muso verso la coda (all'indietro rispetto alla marcia)
  train.segs.length = 0;
  let off = 0;
  const addSeg = (len, loco) => { train.segs.push({ cx: headX - dir * (off + len / 2), w: len, loco }); off += len + TRAIN_GAP; };
  addSeg(LOCO_L, true);
  for (let i = 0; i < WAG_N; i++) addSeg(WAG_L, false);
  let minX = Infinity, maxX = -Infinity;
  for (const s of train.segs) { if (s.cx - s.w / 2 < minX) minX = s.cx - s.w / 2; if (s.cx + s.w / 2 > maxX) maxX = s.cx + s.w / 2; }
  train.minX = minX; train.maxX = maxX;
  if (doCollisions) trainCollide();
  // rombo/tromba del treno vicino al giocatore (sul server hear() è nullo ⇒ muto)
  if (frame % 10 === 0) { const h = hear(headX, RAIL_Y, 1000); if (h) sfx.train(h, phase < TRAIN_SPEED); }
}

// true se il treno impone lo STOP a un'auto del traffico (near il binario e near il treno)
function trainBlocking(c) {
  if (!train.active) return false;
  if (Math.abs(c.y - RAIL_Y) > TRAIN_STOP_BAND) return false;
  return c.x > train.minX - TRAIN_WARN && c.x < train.maxX + TRAIN_WARN;
}

// urti del treno: la locomotiva schiaccia (distrugge) le auto che tocca; i
// vagoni le scaraventano di lato come un urto forte. A piedi: la locomotiva è
// letale, un vagone ti sbatte via ferendoti.
function trainCollide() {
  const halfH = TRAIN_BODY_H / 2;
  // --- auto (all'indietro: explodeCar rimuove dall'array) ---
  for (let i = cars.length - 1; i >= 0; i--) {
    const c = cars[i];
    if (Math.abs(c.y - RAIL_Y) > halfH + 15) continue;
    for (const s of train.segs) {
      if (c.x < s.cx - s.w / 2 - 12 || c.x > s.cx + s.w / 2 + 12) continue;
      if (s.loco) {
        explodeCar(c);                                    // schiacciata: distrutta
      } else {
        const away = c.y < RAIL_Y ? -1 : 1;               // scaraventata via dal binario
        applyImpulse(c, train.dir * 3.5, away * 4.6);
        damageCar(c, 8);
        if (c.driver === 'player') { shake(6, 7); sfx.crash(); }
      }
      break;
    }
  }
  // --- giocatori a piedi ---
  eachActivePlayer(v => {
    if (v.car || v.downT > 0) return;
    if (Math.abs(v.y - RAIL_Y) > halfH + v.r) return;
    for (const s of train.segs) {
      if (v.x < s.cx - s.w / 2 - v.r || v.x > s.cx + s.w / 2 + v.r) continue;
      const away = v.y < RAIL_Y ? -1 : 1;
      asPlayer(v, () => {
        hurtPlayer(s.loco ? 120 : 45, Math.atan2(away, train.dir));   // locomotiva = letale
        moveBox(player, train.dir * 4, away * 6, player.r, player.r);
        shake(7, 9);
      });
      break;
    }
  });
}

// ---------- Disegno della ferrovia (statico, cotto nei chunk da render.js) ----------
function drawRailway() {
  const sy = Math.round(RAIL_Y - camY);
  if (sy < -RAIL_BALLAST || sy > vh + RAIL_BALLAST) return;               // binario fuori dal chunk
  // massicciata (ghiaia)
  ctx.fillStyle = '#484440';
  ctx.fillRect(0, sy - RAIL_BALLAST / 2, vw, RAIL_BALLAST);
  ctx.fillStyle = 'rgba(255,255,255,.05)';
  for (let wx = Math.floor(camX / 9) * 9; wx < camX + vw; wx += 9) {
    const px = Math.round(wx - camX), h = hash2(wx | 0, RAIL_TY);
    ctx.fillRect(px + (h & 3), sy - RAIL_BALLAST / 2 + (h >> 2) % RAIL_BALLAST, 2, 2);
  }
  // traversine
  ctx.fillStyle = '#5a3f2a';
  const step = 16;
  for (let wx = Math.floor(camX / step) * step; wx < camX + vw + step; wx += step)
    ctx.fillRect(Math.round(wx - camX), sy - RAIL_TIE_H / 2, 6, RAIL_TIE_H);
  // le due rotaie d'acciaio, con luce sopra
  ctx.fillStyle = '#8a9098';
  ctx.fillRect(0, sy - RAIL_GAUGE / 2 - 1, vw, 3);
  ctx.fillRect(0, sy + RAIL_GAUGE / 2 - 1, vw, 3);
  ctx.fillStyle = 'rgba(255,255,255,.30)';
  ctx.fillRect(0, sy - RAIL_GAUGE / 2 - 1, vw, 1);
  ctx.fillRect(0, sy + RAIL_GAUGE / 2 - 1, vw, 1);
}

// ---------- Disegno del treno (entità dinamica, ordinata per Y in render()) ----------
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
    // corpo
    ctx.fillStyle = s.loco ? '#8a2f2f' : (i % 2 ? '#3f6a8c' : '#3a7a5a');
    roundRect(x - hw, y - hh, s.w, TRAIN_BODY_H, 5); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = 1.5; roundRect(x - hw, y - hh, s.w, TRAIN_BODY_H, 5); ctx.stroke();
    // tetto
    ctx.fillStyle = 'rgba(0,0,0,.22)'; roundRect(x - hw + 6, y - hh + 4, s.w - 12, TRAIN_BODY_H - 8, 3); ctx.fill();
    // finestrini
    ctx.fillStyle = 'rgba(150,210,255,.8)';
    for (let wx = x - hw + 11; wx < x + hw - 9; wx += 14) ctx.fillRect(wx, y - 4, 8, 8);
    if (s.loco) {
      const front = train.dir > 0 ? x + hw : x - hw;
      ctx.fillStyle = '#ffe9a0'; ctx.beginPath(); ctx.arc(front - train.dir * 4, y, 3, 0, TAU); ctx.fill();   // faro
      ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(x - train.dir * hw * 0.4, y, 4, 0, TAU); ctx.fill();   // comignolo
    }
  }
}
