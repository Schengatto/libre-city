// LIBRE CITY · js/input.js — tastiera, mouse e controlli touch; sali/scendi dall'auto,
// furto con scasso, missioni ON/OFF, clacson/sirena e barra delle armi.

// ---------- Input ----------
const keys = {};
let mouseX = 0, mouseY = 0, mDownL = false, mClicked = false;   // mClicked: fronte del click (semi-auto)
addEventListener('keydown', e => {
  // nei campi del menu (nome, impostazioni) la tastiera scrive, non gioca
  if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.code === 'Escape') { togglePause(); return; }
  if (e.code === 'Tab' && started) {                 // classifica della partita (multigiocatore)
    e.preventDefault();
    toggleLadder();
    return;
  }
  if (paused) return;
  keys[e.code] = true;
  if (e.code === 'KeyE') { initAudio(); toggleCar(); }
  if (e.code === 'Space' && !e.repeat) { initAudio(); hornOrSiren(); }
  if (e.code === 'KeyM' && !e.repeat) { initAudio(); toggleMissions(); }
  if (e.code === 'KeyH' && !e.repeat) toggleHelp();      // apre/chiude la guida comandi

  if (e.code.startsWith('Digit')) {                  // 1-5: compra/equipaggia le armi
    const i = +e.code.slice(5) - 1;
    if (i >= 0 && i < WEAPONS.length) { initAudio(); weaponKey(i); }
  }
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; mDownL = false; mClicked = false; });
canvas.addEventListener('mousemove', e => { mouseX = e.clientX; mouseY = e.clientY; });
canvas.addEventListener('mousedown', e => { if (e.button === 0) { initAudio(); mDownL = true; mClicked = true; } });
addEventListener('mouseup', e => { if (e.button === 0) mDownL = false; });
canvas.addEventListener('contextmenu', e => e.preventDefault());
const touchHeld = {};                              // "tasti" premuti dallo stick virtuale
const held = (...codes) => codes.some(c => keys[c] || touchHeld[c]);
const mouseWX = () => mouseX + camX, mouseWY = () => mouseY + camY;

// ---------- Controlli touch (mobile) ----------
// Metà sinistra dello schermo: stick virtuale per muoversi; in auto lo stick
// indica la direzione SULLO SCHERMO verso cui andare (il mezzo ci si allinea).
// Metà destra: stick di mira — spingilo oltre metà corsa per sparare (o per
// azionare l'idrante dell'autopompa); un tocco rapido spara un colpo singolo.
// I pulsanti a schermo coprono E (🚗 sali/scendi), Spazio (📣 clacson/sirena),
// M (📋 missioni) e 1-4 (barra delle armi in alto).
const isTouchDevice = matchMedia('(pointer: coarse)').matches;
let usingTouch = false;
function enterTouchMode() {
  if (usingTouch) return;
  usingTouch = true;
  document.body.classList.add('touch');
}
if (isTouchDevice) enterTouchMode();

const PAD_R = 55, FIRE_ON = 0.5, MOVE_ON = 0.32;
const lStick = { id: null, cx: 0, cy: 0, dx: 0, dy: 0 };
const rStick = { id: null, cx: 0, cy: 0, dx: 0, dy: 0, t0: 0, fired: false };
let touchAim = 0, touchTap = false;
const touchDrive = { active: false, angle: 0 };    // stick sinistro in auto: direzione su schermo
const padL = document.getElementById('padL'), padR = document.getElementById('padR');
function padShow(el, x, y) { if (el) { el.style.display = 'block'; el.style.left = x + 'px'; el.style.top = y + 'px'; } }
function padKnob(el, dx, dy) { const k = el && el.firstElementChild; if (k) k.style.transform = `translate(${dx * PAD_R}px, ${dy * PAD_R}px)`; }
function padHide(el) { if (el) { el.style.display = 'none'; padKnob(el, 0, 0); } }
function stickVec(st, x, y) {
  let dx = (x - st.cx) / PAD_R, dy = (y - st.cy) / PAD_R;
  const m = Math.hypot(dx, dy);
  if (m > 1) { dx /= m; dy /= m; }
  st.dx = dx; st.dy = dy;
}
canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  enterTouchMode(); initAudio();
  if (!started) return;
  for (const t of e.changedTouches) {
    if (t.clientX < vw / 2 && lStick.id === null) {
      lStick.id = t.identifier; lStick.cx = t.clientX; lStick.cy = t.clientY; lStick.dx = lStick.dy = 0;
      padShow(padL, t.clientX, t.clientY); padKnob(padL, 0, 0);
    } else if (t.clientX >= vw / 2 && rStick.id === null) {
      rStick.id = t.identifier; rStick.cx = t.clientX; rStick.cy = t.clientY;
      rStick.dx = rStick.dy = 0; rStick.t0 = frame; rStick.fired = false;
      padShow(padR, t.clientX, t.clientY); padKnob(padR, 0, 0);
    }
  }
}, { passive: false });
canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.identifier === lStick.id) { stickVec(lStick, t.clientX, t.clientY); padKnob(padL, lStick.dx, lStick.dy); }
    else if (t.identifier === rStick.id) {
      stickVec(rStick, t.clientX, t.clientY); padKnob(padR, rStick.dx, rStick.dy);
      if (Math.hypot(rStick.dx, rStick.dy) > 0.18) touchAim = Math.atan2(rStick.dy, rStick.dx);
    }
  }
}, { passive: false });
function onTouchEnd(e) {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.identifier === lStick.id) { lStick.id = null; lStick.dx = lStick.dy = 0; padHide(padL); }
    else if (t.identifier === rStick.id) {
      // tocco rapido senza trascinare = un colpo singolo nell'ultima direzione di mira
      if (!rStick.fired && frame - rStick.t0 < 18) touchTap = true;
      rStick.id = null; rStick.dx = rStick.dy = 0; padHide(padR);
    }
  }
}
canvas.addEventListener('touchend', onTouchEnd, { passive: false });
canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });
// riversa lo stato degli stick sui controlli esistenti (tasti + mouse virtuale)
function applyTouchInput() {
  if (!usingTouch) return;
  // in auto lo stick non fa da crocetta WASD: dà l'angolo (su schermo) verso cui guidare
  const driving = !!player.car;
  touchDrive.active = driving && lStick.id !== null && Math.hypot(lStick.dx, lStick.dy) > MOVE_ON;
  if (touchDrive.active) touchDrive.angle = Math.atan2(lStick.dy, lStick.dx);
  touchHeld.KeyW = !driving && lStick.id !== null && lStick.dy < -MOVE_ON;
  touchHeld.KeyS = !driving && lStick.id !== null && lStick.dy >  MOVE_ON;
  touchHeld.KeyA = !driving && lStick.id !== null && lStick.dx < -MOVE_ON;
  touchHeld.KeyD = !driving && lStick.id !== null && lStick.dx >  MOVE_ON;
  const firing = rStick.id !== null && Math.hypot(rStick.dx, rStick.dy) > FIRE_ON;
  if (firing) rStick.fired = true;
  // il mouse virtuale sta nella direzione di mira, poco oltre il personaggio
  const ax = (player.car ? player.car.x : player.x) - camX;
  const ay = (player.car ? player.car.y : player.y) - camY;
  mouseX = ax + Math.cos(touchAim) * 130; mouseY = ay + Math.sin(touchAim) * 130;
  mDownL = firing;
  if (firing || touchTap) mClicked = true;
  touchTap = false;
}
// pulsanti azione a schermo
function bindBtn(id, fn) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); enterTouchMode(); initAudio(); fn(); }, { passive: false });
  el.addEventListener('mousedown', e => { e.preventDefault(); initAudio(); fn(); });
}
bindBtn('btnCar', toggleCar);
bindBtn('btnHorn', hornOrSiren);
bindBtn('btnMissions', toggleMissions);
bindBtn('btnLadder', () => toggleLadder());   // classifica multigiocatore (visibile solo in partita 🌐)
// barra delle armi: tocca l'icona per equipaggiare (o comprare all'armeria)
const wpnBar = document.getElementById('wpnBar');
if (wpnBar) WEAPONS.forEach((w, i) => {
  const b = document.createElement('button');
  b.className = 'wbtn'; b.textContent = w.icon;
  b.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); initAudio(); weaponKey(i); }, { passive: false });
  b.addEventListener('mousedown', e => { e.preventDefault(); initAudio(); weaponKey(i); });
  wpnBar.appendChild(b);
});
function updateWpnBar() {
  if (!wpnBar) return;
  for (let i = 0; i < wpnBar.children.length; i++) {
    wpnBar.children[i].classList.toggle('equipped', i === player.weaponIdx);
    wpnBar.children[i].classList.toggle('locked', !player.owned[i]);
  }
}
updateWpnBar();

// ---------- Sali / scendi dall'auto ----------
function toggleCar() {
  if (!started || downT > 0) return;
  if (net.authoritative) { net.enterEdge = true; return; }   // sali/scendi lo decide il server
  if (player.car) {
    const c = player.car;
    // scendi accanto al lato dell'auto, in un punto libero
    const nx = Math.cos(c.angle + Math.PI / 2), ny = Math.sin(c.angle + Math.PI / 2);
    let ex = c.x + nx * 34, ey = c.y + ny * 34;
    if (boxHits(ex, ey, player.r, player.r)) { ex = c.x - nx * 34; ey = c.y - ny * 34; }
    if (boxHits(ex, ey, player.r, player.r)) { ex = c.x; ey = c.y; }
    player.x = ex; player.y = ey;
    mClicked = false;                              // un click fatto in auto non spara appena scendi
    c.driver = null; c.speed = 0;
    c.role = 'parked'; c.edge = null;              // resta ferma dove l'hai lasciata (niente rotaia)
    netAbandonCar(c);                              // multigiocatore: resta visibile anche agli altri
    player.car = null;
    engineGain(0);
    if (taxiActive()) cancelTaxi('🚕 Corsa annullata — hai abbandonato il cliente');
    else if (pizzaActive()) cancelPizza('🍕 Consegna annullata — il cliente resta a bocca asciutta');
    else if (rescueActive()) cancelRescue('🚑 Soccorso annullato — il ferito aspetta ancora aiuto');
    else if (patrolActive()) cancelPatrol('🚔 Inseguimento annullato — il ladro se l\'è svignata');
    else if (firejobActive()) cancelFirejob('🚒 Intervento annullato — l\'incendio si è spento da solo');
    else { taxi.waitCd = 0; pizza.waitCd = 0; rescue.waitCd = 0; patrol.waitCd = 0; firejob.waitCd = 0; toast('🚶 Sei sceso'); }
    return;
  }
  let best = null, bd = 52;
  for (const c of cars) {
    if (c.driver) continue;
    const d = dist(c.x, c.y, player.x, player.y);
    if (d < bd) { bd = d; best = c; }
  }
  if (best) {
    // il mezzo era guidato da qualcuno: il guidatore vola a terra e non la prende bene
    if (best.role === 'traffic' || best.role === 'police' || best.role === 'armycar') tossDriver(best);
    player.car = best; best.driver = 'player';
    if (best.role === 'traffic' || best.role === 'parked') best.role = 'player';
    netAssignCarId(best);                          // multigiocatore: id di rete stabile del mezzo
    // in multigiocatore i mezzi-missione (taxi/pizza/ambulanza/volante) non danno
    // incarichi: ricadono sull'avviso generico "sei salito in auto/moto"
    if (best.isTaxi && !netActive()) toast('🚕 Sei salito su un TAXI — carica i clienti e portali a destinazione!');
    else if (best.isDelivery && !netActive()) toast('🍕 Sei salito sulla moto delle consegne — ritira il cibo e portalo ai clienti!');
    else if (best.livery === 'ambulance' && !netActive()) toast('🚑 Sei salito sull\'AMBULANZA — soccorri i feriti e portali in ospedale!');
    else if (best.livery === 'fire') toast(usingTouch ? '🚒 Sei salito sull\'AUTOPOMPA — spingi lo stick destro per l\'idrante!'
                                                      : '🚒 Sei salito sull\'AUTOPOMPA — tieni premuto il mouse per l\'idrante!');
    else if (best.wasPolice && !netActive()) toast('🚔 Sei salito sulla VOLANTE — rispondi alle chiamate e ferma i criminali!');
    else if (best.isTank) { toast(usingTouch ? '🪖 Sei salito sul CARRO ARMATO — stick destro: razzi · passa sopra le auto!'
                                             : '🪖 Sei salito sul CARRO ARMATO — mouse: razzi · passa sopra le auto!');
                            triggerArmyAlert(nearestArmyBase()); }   // rubare un carro non passa inosservato
    else if (best.livery === 'army') toast('🪖 Sei salito sulla jeep militare — l\'esercito non gradisce…');
    else if (usingTouch) toast(best.isBike ? '🏍️ Sei salito in moto — stick sinistro per guidare, 🚗 per scendere'
                             : '🚗 Sei salito in auto — stick sinistro per guidare, 🚗 per scendere');
    else toast(best.isBike ? '🏍️ Sei salito in moto — WASD guida, E scendi'
             : '🚗 Sei salito in auto — WASD guida, E scendi');
    armMissionForCar();                            // il primo incarico arriva subito (se le missioni sono attive)
    if (!missionsOn && (best.isTaxi || best.isDelivery || best.wasPolice || best.livery === 'ambulance' || best.livery === 'fire'))
      toast(usingTouch ? '🚫 Missioni disattivate — tocca 📋 per riattivarle' : '🚫 Missioni disattivate — premi M per riattivarle');
    sfx.door(); sfx.ignition();
  } else sfx.err();
}

// ---------- Furto con scasso: il guidatore vola a terra ----------
// quando Federico ruba un mezzo con qualcuno alla guida, il guidatore viene
// scaraventato sul lato opposto: resta stordito a terra un attimo, poi si
// rialza arrabbiato e lo insegue agitando i pugni (vedi updateAngryDriver)
function tossDriver(c) {
  const nx = Math.cos(c.angle + Math.PI / 2), ny = Math.sin(c.angle + Math.PI / 2);
  // atterra dal lato opposto a quello da cui sale Federico (se è libero)
  const side = (player.x - c.x) * nx + (player.y - c.y) * ny > 0 ? -1 : 1;
  let ex = c.x + nx * side * (c.h / 2 + 20), ey = c.y + ny * side * (c.h / 2 + 20);
  if (boxHits(ex, ey, 7, 7)) { ex = c.x - nx * side * (c.h / 2 + 20); ey = c.y - ny * side * (c.h / 2 + 20); }
  if (boxHits(ex, ey, 7, 7)) { ex = c.x + Math.cos(c.angle) * (c.w / 2 + 18); ey = c.y + Math.sin(c.angle) * (c.w / 2 + 18); }
  const p = makePed(ex, ey, 'civ');
  if (c.riderShirt) p.shirt = c.riderShirt;                        // stessa maglietta del pilota in sella
  if (c.role === 'police' || c.wasPolice) { p.shirt = '#20407a'; p.hair = '#1a1a2a'; p.copDress = true; }
  if (c.role === 'armycar' || c.livery === 'army') { p.shirt = '#3d5226'; p.hair = '#2a2a1e'; p.soldierDress = true; }
  p.stolenBike = !!c.isBike;                                       // per la prima sfuriata ("La mia moto!")
  const a = Math.atan2(ey - c.y, ex - c.x);                        // sbalzato via dal mezzo
  p.ko = true; p.getsUp = true; p.koT = rndi(55, 85);              // stordito, ma si rialzerà
  p.kx = Math.cos(a) * 3.4; p.ky = Math.sin(a) * 3.4;
  p.spin = rnd(-0.5, 0.5);
  peds.push(p);
  sfx.thud(); sfx.yell(hear(ex, ey, 700));
}

// ---------- Missioni ON/OFF (M) ----------
// A volte vuoi solo scorrazzare con l'ambulanza o la volante senza incarichi:
// M disattiva (e riattiva) le missioni dei mezzi speciali.
let missionsOn = true;
// se sei su un mezzo speciale e le missioni sono attive, prepara la chiamata
// (in multigiocatore niente incarichi: si gioca a darsi la caccia fra rivali)
function armMissionForCar() {
  const c = player.car;
  if (!c || !missionsOn || netActive()) return;
  if (c.isTaxi && !taxiActive()) taxi.waitCd = 40;
  else if (c.isDelivery && !pizzaActive()) pizza.waitCd = 40;
  else if (c.livery === 'ambulance' && !rescueActive()) rescue.waitCd = 40;
  else if (c.livery === 'fire' && !firejobActive()) firejob.waitCd = 40;
  else if (c.wasPolice && !patrolActive()) patrol.waitCd = 40;
}
function toggleMissions() {
  if (!started) return;
  if (netActive()) { toast('🌐 In multigiocatore non ci sono missioni — dai la caccia agli altri!'); return; }
  missionsOn = !missionsOn;
  if (!missionsOn) {
    cancelTaxi(); cancelPizza(); cancelRescue(); cancelPatrol(); cancelFirejob();
    taxi.waitCd = pizza.waitCd = rescue.waitCd = patrol.waitCd = firejob.waitCd = 0;
    toast(usingTouch ? '🚫 Missioni disattivate — tocca 📋 per riattivarle' : '🚫 Missioni disattivate — premi M per riattivarle');
  } else {
    armMissionForCar();
    toast('✅ Missioni riattivate!');
  }
}

// ---------- Clacson & sirena (Spazio) ----------
// In un mezzo qualsiasi Spazio suona il clacson; in volante o ambulanza
// accende/spegne la sirena. Con una missione attiva la sirena parte da sola.
function hornOrSiren() {
  if (!started || !player.car) return;
  if (net.authoritative) { net.hornEdge = true; return; }    // clacson/sirena: al server
  const c = player.car;
  if (c.wasPolice || c.livery === 'ambulance' || c.livery === 'fire') {
    c.sirenOn = !c.sirenOn;
    toast(c.sirenOn ? '🚨 Sirena accesa' : '🔇 Sirena spenta');
  } else sfx.horn({ v: 1, pan: 0 }, c);
}
// la sirena del mezzo del player suona (e lampeggia) se attivata con Spazio
// oppure automaticamente quando la sua missione è in corso
function playerSirenOn(c) {
  if (!c || c.driver !== 'player') return false;
  if (c.wasPolice) return c.sirenOn || patrolActive();
  if (c.livery === 'ambulance') return c.sirenOn || rescueActive();
  if (c.livery === 'fire') return c.sirenOn || firejobActive();
  return false;
}

