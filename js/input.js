// VIBE CITY · js/input.js — keyboard, mouse and touch controls; enter/exit vehicles,
// carjacking, missions ON/OFF, horn/siren and the weapon bar.

// ---------- Input ----------
const keys = {};
let mouseX = 0, mouseY = 0, mDownL = false, mClicked = false;   // mClicked: click edge (semi-auto)
addEventListener('keydown', e => {
  // In menu fields (name, settings) the keyboard types instead of playing.
  if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.code === 'Escape' && emoteState.barOpen) { closeEmoteBar(); return; }
  if (e.code === 'Escape') { if (mapFullOpen) { closeMapFull(); return; } togglePause(); return; }
  if (e.code === 'KeyM' && e.shiftKey && !e.repeat && started) { openMapFull(); return; }
  if (e.code === 'Tab' && started) {                 // match scoreboard (multiplayer)
    e.preventDefault();
    toggleLadder();
    return;
  }
  if (paused) return;
  if (e.code === 'KeyT' && !e.repeat && net.mode && started) { toggleEmoteBar(); return; }
  if (emoteState.barOpen && /^Digit[1-8]$/.test(e.code)) { sendEmote(+e.code.slice(5) - 1); return; }
  keys[e.code] = true;
  if (e.code === 'KeyE') { initAudio(); toggleCar(); }
  if (e.code === 'Space' && !e.repeat) { initAudio(); hornOrSiren(); }
  if (e.code === 'KeyM' && !e.repeat) { initAudio(); toggleMissions(); }
  if (e.code === 'KeyH' && !e.repeat) toggleHelp();

  if (e.code.startsWith('Digit')) {                  // 1-5: buy/equip weapons
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
const touchHeld = {};                              // "keys" held by the virtual stick
const held = (...codes) => codes.some(c => keys[c] || touchHeld[c]);
const mouseWX = () => mouseX + camX, mouseWY = () => mouseY + camY;

// ---------- Touch controls (mobile) ----------
// Left half of the screen: virtual stick to move; while driving the stick points at the
// ON-SCREEN direction to head for (the vehicle lines itself up with it).
// Right half: aiming stick — push it past half travel to fire (or to work the fire
// engine's hydrant); a quick tap fires a single shot.
// On-screen buttons cover E (🚗 enter/exit), Space (📣 horn/siren), M (📋 missions)
// and 1-4 (the weapon bar at the top).
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
const touchDrive = { active: false, angle: 0 };    // left stick while driving: on-screen heading
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
      // Quick tap without dragging = one single shot in the last aimed direction.
      if (!rStick.fired && frame - rStick.t0 < 18) touchTap = true;
      rStick.id = null; rStick.dx = rStick.dy = 0; padHide(padR);
    }
  }
}
canvas.addEventListener('touchend', onTouchEnd, { passive: false });
canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });
// Pours the stick state into the existing controls (keys + virtual mouse).
function applyTouchInput() {
  if (!usingTouch) return;
  // While driving the stick is not a WASD d-pad: it gives the on-screen angle to drive at.
  const driving = !!player.car;
  touchDrive.active = driving && lStick.id !== null && Math.hypot(lStick.dx, lStick.dy) > MOVE_ON;
  if (touchDrive.active) touchDrive.angle = Math.atan2(lStick.dy, lStick.dx);
  touchHeld.KeyW = !driving && lStick.id !== null && lStick.dy < -MOVE_ON;
  touchHeld.KeyS = !driving && lStick.id !== null && lStick.dy >  MOVE_ON;
  touchHeld.KeyA = !driving && lStick.id !== null && lStick.dx < -MOVE_ON;
  touchHeld.KeyD = !driving && lStick.id !== null && lStick.dx >  MOVE_ON;
  const firing = rStick.id !== null && Math.hypot(rStick.dx, rStick.dy) > FIRE_ON;
  if (firing) rStick.fired = true;
  // The virtual mouse sits in the aiming direction, just beyond the character.
  const ax = (player.car ? player.car.x : player.x) - camX;
  const ay = (player.car ? player.car.y : player.y) - camY;
  mouseX = ax + Math.cos(touchAim) * 130; mouseY = ay + Math.sin(touchAim) * 130;
  mDownL = firing;
  if (firing || touchTap) mClicked = true;
  touchTap = false;
}
// On-screen action buttons.
function bindBtn(id, fn) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); enterTouchMode(); initAudio(); fn(); }, { passive: false });
  el.addEventListener('mousedown', e => { e.preventDefault(); initAudio(); fn(); });
}
bindBtn('btnCar', toggleCar);
bindBtn('btnHorn', hornOrSiren);
bindBtn('btnMissions', toggleMissions);
bindBtn('btnEmote', toggleEmoteBar);
bindBtn('btnLadder', () => toggleLadder());   // multiplayer scoreboard (only visible in a 🌐 match)
// Weapon bar: tap an icon to equip (or to buy at the gun shop).
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

// ---------- Enter / exit a vehicle ----------
function toggleCar() {
  if (!started || downT > 0) return;
  if (net.authoritative) { net.enterEdge = true; return; }   // the server decides enter/exit
  if (player.car) {
    const c = player.car;
    // Step out beside the vehicle, onto a free spot.
    const nx = Math.cos(c.angle + Math.PI / 2), ny = Math.sin(c.angle + Math.PI / 2);
    let ex = c.x + nx * 34, ey = c.y + ny * 34;
    if (boxHits(ex, ey, player.r, player.r)) { ex = c.x - nx * 34; ey = c.y - ny * 34; }
    if (boxHits(ex, ey, player.r, player.r)) { ex = c.x; ey = c.y; }
    player.x = ex; player.y = ey;
    mClicked = false;                              // a click made while driving must not fire on exit
    c.driver = null; c.speed = 0;
    c.role = 'parked'; c.edge = null;              // stays where you left it (off the rail)
    netAbandonCar(c);                              // multiplayer: stays visible to everyone else too
    player.car = null;
    engineGain(0);
    if (taxiActive()) cancelTaxi('taxi.abandon');
    else if (pizzaActive()) cancelPizza('pizza.abandon');
    else if (rescueActive()) cancelRescue('rescue.abandon');
    else if (patrolActive()) cancelPatrol('patrol.abandon');
    else if (firejobActive()) cancelFirejob('fire.abandon');
    else { taxi.waitCd = 0; pizza.waitCd = 0; rescue.waitCd = 0; patrol.waitCd = 0; firejob.waitCd = 0; toast(t('veh.out')); }
    return;
  }
  let best = null, bd = 52;
  for (const c of cars) {
    if (c.driver) continue;
    const d = dist(c.x, c.y, player.x, player.y);
    if (d < bd) { bd = d; best = c; }
  }
  if (best) {
    // The vehicle had a driver: they get thrown out and do not take it well.
    if (best.role === 'traffic' || best.role === 'police' || best.role === 'armycar') tossDriver(best);
    player.car = best; best.driver = 'player';
    if (best.role === 'traffic' || best.role === 'parked') best.role = 'player';
    netAssignCarId(best);                          // multiplayer: stable network id for the vehicle
    // In multiplayer the mission vehicles (taxi/pizza/ambulance/patrol) hand out no jobs:
    // they fall back to the generic "you got in the car/on the bike" notice.
    if (best.isTaxi && !netActive()) toast(t('taxi.enter'));
    else if (best.isDelivery && !netActive()) toast(t('pizza.enter'));
    else if (best.livery === 'ambulance' && !netActive()) toast(t('rescue.enter'));
    else if (best.livery === 'fire') toast(t(usingTouch ? 'fire.enterTouch' : 'fire.enterKb'));
    else if (best.wasPolice && !netActive()) toast(t('patrol.enter'));
    else if (best.isTank) { toast(t(usingTouch ? 'veh.tankTouch' : 'veh.tankKb'));
                            triggerArmyAlert(nearestArmyBase()); }   // stealing a tank does not go unnoticed
    else if (best.livery === 'army') toast(t('veh.jeep'));
    else if (usingTouch) toast(t(best.isBike ? 'veh.bikeTouch' : 'veh.carTouch'));
    else toast(t(best.isBike ? 'veh.bikeKb' : 'veh.carKb'));
    armMissionForCar();                            // the first job arrives right away (if missions are on)
    if (!missionsOn && (best.isTaxi || best.isDelivery || best.wasPolice || best.livery === 'ambulance' || best.livery === 'fire'))
      toast(t(usingTouch ? 'miss.offTouch' : 'miss.offKb'));
    sfx.door(); sfx.ignition();
  } else sfx.err();
}

// ---------- Carjacking: the driver goes flying ----------
// When the player steals an occupied vehicle the driver is flung out on the far side:
// they lie stunned for a moment, then get up angry and chase after them with fists
// flying (see updateAngryDriver).
function tossDriver(c) {
  const nx = Math.cos(c.angle + Math.PI / 2), ny = Math.sin(c.angle + Math.PI / 2);
  // Land on the opposite side from the one the player gets in from (if it is free).
  const side = (player.x - c.x) * nx + (player.y - c.y) * ny > 0 ? -1 : 1;
  let ex = c.x + nx * side * (c.h / 2 + 20), ey = c.y + ny * side * (c.h / 2 + 20);
  if (boxHits(ex, ey, 7, 7)) { ex = c.x - nx * side * (c.h / 2 + 20); ey = c.y - ny * side * (c.h / 2 + 20); }
  if (boxHits(ex, ey, 7, 7)) { ex = c.x + Math.cos(c.angle) * (c.w / 2 + 18); ey = c.y + Math.sin(c.angle) * (c.w / 2 + 18); }
  const p = makePed(ex, ey, 'civ');
  if (c.riderShirt) p.shirt = c.riderShirt;                        // same shirt as the rider in the saddle
  if (c.role === 'police' || c.wasPolice) { p.shirt = '#20407a'; p.hair = '#1a1a2a'; p.copDress = true; }
  if (c.role === 'armycar' || c.livery === 'army') { p.shirt = '#3d5226'; p.hair = '#2a2a1e'; p.soldierDress = true; }
  p.stolenBike = !!c.isBike;                                       // for the first outburst ("My bike!")
  const a = Math.atan2(ey - c.y, ex - c.x);                        // flung away from the vehicle
  p.ko = true; p.getsUp = true; p.koT = rndi(55, 85);              // stunned, but they will get up
  p.kx = Math.cos(a) * 3.4; p.ky = Math.sin(a) * 3.4;
  p.spin = rnd(-0.5, 0.5);
  peds.push(p);
  sfx.thud(); sfx.yell(hear(ex, ey, 700));
}

// ---------- Missions ON/OFF (M) ----------
// Sometimes you just want to cruise around in the ambulance or the patrol car without
// jobs: M turns the special-vehicle missions off (and back on).
let missionsOn = true;
// If you are in a special vehicle and missions are on, arm the next call.
// (No jobs in multiplayer: there the game is hunting each other down.)
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
  if (netActive()) { toast(t('mp.noMissions')); return; }
  missionsOn = !missionsOn;
  if (!missionsOn) {
    cancelTaxi(); cancelPizza(); cancelRescue(); cancelPatrol(); cancelFirejob();
    taxi.waitCd = pizza.waitCd = rescue.waitCd = patrol.waitCd = firejob.waitCd = 0;
    toast(t(usingTouch ? 'miss.offTouch' : 'miss.offKb'));
  } else {
    armMissionForCar();
    toast(t('miss.on'));
  }
}

// ---------- Horn & siren (Space) ----------
// In any vehicle Space sounds the horn; in a patrol car or ambulance it toggles the
// siren. With a mission running the siren starts by itself.
function hornOrSiren() {
  if (!started || !player.car) return;
  if (net.authoritative) { net.hornEdge = true; return; }    // horn/siren: over to the server
  const c = player.car;
  if (c.wasPolice || c.livery === 'ambulance' || c.livery === 'fire') {
    c.sirenOn = !c.sirenOn;
    toast(t(c.sirenOn ? 'veh.sirenOn' : 'veh.sirenOff'));
  } else sfx.horn({ v: 1, pan: 0 }, c);
}
// The siren on the player's vehicle sounds (and flashes) either when switched on with
// Space or automatically while its mission is running.
function playerSirenOn(c) {
  if (!c || c.driver !== 'player') return false;
  if (c.wasPolice) return c.sirenOn || patrolActive();
  if (c.livery === 'ambulance') return c.sirenOn || rescueActive();
  if (c.livery === 'fire') return c.sirenOn || firejobActive();
  return false;
}
