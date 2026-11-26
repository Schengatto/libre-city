// VIBE CITY · js/missions.js — missions: taxi 🚕, pizza 🍕, ambulance 🚑, patrol 🚔
// and fire brigade 🚒 (fires, hydrant and water droplets).

// ---------- TAXI missions 🚕 ----------
// Get into a taxi: a fare is waiting on the pavement — pick them up and drive them to
// their destination following the arrow. The payout grows with the length of the ride,
// and if you arrive in time the fare leaves a tip too.
const taxi = { phase: 'idle', fare: null, dest: null, pay: 0, timer: 0, waitCd: 0, rides: 0 };
const taxiActive = () => taxi.phase !== 'idle';
const taxiTarget = () => taxi.phase === 'pickup' ? taxi.fare : taxi.dest;
function spawnFare() {
  const p = randomPublicSidewalkNear(player.x, player.y, 500, 1600);
  if (!p) { taxi.waitCd = 60; return; }
  const f = makePed(p.x, p.y, 'fare');
  f.speed = 0; f.dir = { x: 0, y: 0 };
  peds.push(f);
  taxi.phase = 'pickup'; taxi.fare = f;
  toast(t('taxi.new'));
}
function startRide() {
  const f = taxi.fare;
  let d = null;                                       // destination: a distant point on a road
  for (let r = 2400; r >= 800 && !d; r -= 400) d = randomPublicRoadNear(f.x, f.y, r * 0.6, r);
  if (!d) { cancelTaxi(); taxi.waitCd = 120; return; }
  const i = peds.indexOf(f); if (i >= 0) peds.splice(i, 1);       // the fare gets in
  taxi.fare = null; taxi.phase = 'ride'; taxi.dest = { x: d.x, y: d.y };
  const len = dist(player.x, player.y, d.x, d.y);
  taxi.pay = 15 + Math.round(len * 0.022 / 5) * 5;                // payout based on distance
  taxi.timer = Math.round(len / 2.5) + 60 * 4;                    // arrive in time → tip
  toast(t('taxi.aboard'));
  sfx.door();
}
function completeRide() {
  const tip = taxi.timer > 0 ? Math.ceil(taxi.pay * 0.5 / 5) * 5 : 0;
  cash += taxi.pay + tip; updateCash(); sfx.coin();
  addScore(SCORE.mission.taxi, player.x, player.y);
  taxi.rides++;
  toast(tip > 0 ? t('taxi.doneTip', { pay: taxi.pay, tip }) : t('taxi.done', { pay: taxi.pay }));
  const c = player.car;                                           // the fare gets out and walks off
  peds.push(makePed(c.x + Math.cos(c.angle + Math.PI / 2) * 30, c.y + Math.sin(c.angle + Math.PI / 2) * 30, 'civ'));
  taxi.phase = 'idle'; taxi.dest = null; taxi.waitCd = 150;       // another fare along shortly
}
function cancelTaxi(msg) {
  if (taxi.fare) { taxi.fare.role = 'civ'; taxi.fare.thinkCd = 0; }   // the fare gives up and strolls off
  taxi.phase = 'idle'; taxi.fare = null; taxi.dest = null; taxi.waitCd = 0;
  if (msg) toast(t(msg));
}
function updateTaxi() {
  if (taxi.waitCd > 0 && player.car && player.car.isTaxi && --taxi.waitCd === 0) spawnFare();
  if (!taxiActive()) return;
  const c = player.car;
  if (!c || !c.isTaxi) { cancelTaxi('taxi.cancel'); return; }   // got out, or the taxi was destroyed
  if (taxi.phase === 'pickup') {
    const f = taxi.fare;
    if (!f || f.ko || f.dead) { cancelTaxi('taxi.lost'); taxi.waitCd = 240; return; }
    if (dist(c.x, c.y, f.x, f.y) < 62 && Math.abs(c.speed) < 0.8) startRide();
  } else if (taxi.phase === 'ride') {
    if (taxi.timer > 0) taxi.timer--;
    if (dist(c.x, c.y, taxi.dest.x, taxi.dest.y) < 70 && Math.abs(c.speed) < 0.9) completeRide();
  }
}

// ---------- PIZZA DELIVERY missions 🍕 ----------
// Get on a delivery bike: the pizzeria prepares an order — collect the food at the shop
// door and take it to the hungry customer waiting for it. Deliver it while it is still
// hot and the customer leaves a tip too.
const pizza = { phase: 'idle', shop: null, client: null, pay: 0, timer: 0, waitCd: 0, jobs: 0 };
const pizzaActive = () => pizza.phase !== 'idle';
const pizzaTarget = () => pizza.phase === 'pickup' ? (pizza.shop && pizza.shop.door) : pizza.client;
function spawnOrder() {
  let shop = null, sd = Infinity;                     // the nearest pizzeria makes the order
  for (const lm of landmarks) if (lm.type === 'pizzeria') {
    const d = dist(lm.door.x, lm.door.y, player.x, player.y);
    if (d < sd) { sd = d; shop = lm; }
  }
  if (!shop) { pizza.waitCd = 300; return; }
  // The hungry customer waits on a pavement not too close to the shop.
  const p = randomPublicSidewalkNear(shop.door.x, shop.door.y, 600, 1800);
  if (!p) { pizza.waitCd = 60; return; }
  const cl = makePed(p.x, p.y, 'hungry');
  cl.speed = 0; cl.dir = { x: 0, y: 0 };
  peds.push(cl);
  pizza.phase = 'pickup'; pizza.shop = shop; pizza.client = cl;
  toast(t('pizza.new'));
}
function pickupFood() {
  const len = dist(pizza.shop.door.x, pizza.shop.door.y, pizza.client.x, pizza.client.y);
  pizza.pay = 20 + Math.round(len * 0.025 / 5) * 5;   // payout based on distance
  pizza.timer = Math.round(len / 2.6) + 60 * 4;       // delivered hot → tip
  pizza.phase = 'deliver';
  toast(t('pizza.aboard'));
  sfx.door();
}
function completeDelivery() {
  const tip = pizza.timer > 0 ? Math.ceil(pizza.pay * 0.5 / 5) * 5 : 0;
  cash += pizza.pay + tip; updateCash(); sfx.coin();
  addScore(SCORE.mission.pizza, player.x, player.y);
  pizza.jobs++;
  toast(tip > 0 ? t('pizza.doneTip', { pay: pizza.pay, tip }) : t('pizza.done', { pay: pizza.pay }));
  const cl = pizza.client;                            // the customer says thanks and leaves
  if (cl) { cl.role = 'civ'; cl.thinkCd = 0; }
  pizza.phase = 'idle'; pizza.shop = null; pizza.client = null;
  pizza.waitCd = 180;                                 // another order along shortly
}
function cancelPizza(msg) {
  if (pizza.client) { pizza.client.role = 'civ'; pizza.client.thinkCd = 0; }   // the customer orders elsewhere
  pizza.phase = 'idle'; pizza.shop = null; pizza.client = null; pizza.waitCd = 0;
  if (msg) toast(t(msg));
}
function updatePizza() {
  if (pizza.waitCd > 0 && player.car && player.car.isDelivery && --pizza.waitCd === 0) spawnOrder();
  if (!pizzaActive()) return;
  const c = player.car;
  if (!c || !c.isDelivery) { cancelPizza('pizza.cancel'); return; }   // got off, or the bike was destroyed
  const cl = pizza.client;
  if (!cl || cl.ko || cl.dead) { cancelPizza('pizza.lost'); pizza.waitCd = 240; return; }
  if (pizza.phase === 'pickup') {
    if (dist(c.x, c.y, pizza.shop.door.x, pizza.shop.door.y) < 70 && Math.abs(c.speed) < 0.9) pickupFood();
  } else if (pizza.phase === 'deliver') {
    if (pizza.timer > 0) pizza.timer--;
    if (dist(c.x, c.y, cl.x, cl.y) < 62 && Math.abs(c.speed) < 0.8) completeDelivery();
  }
}

// ---------- AMBULANCE RESCUE missions 🚑 ----------
// Get into an ambulance (parked in front of the hospital): someone injured is calling
// for help in the city — reach them, load them aboard and race to the nearest hospital.
// Get there quickly and you earn the rescue bonus as well.
const rescue = { phase: 'idle', patient: null, hosp: null, pay: 0, timer: 0, waitCd: 0, jobs: 0 };
const rescueActive = () => rescue.phase !== 'idle';
const rescueTarget = () => rescue.phase === 'pickup' ? rescue.patient : (rescue.hosp && rescue.hosp.door);
function spawnEmergency() {
  const p = randomPublicSidewalkNear(player.x, player.y, 600, 1800);
  if (!p) { rescue.waitCd = 60; return; }
  const inj = makePed(p.x, p.y, 'injured');
  inj.speed = 0; inj.dir = { x: 0, y: 0 };
  peds.push(inj);
  rescue.phase = 'pickup'; rescue.patient = inj;
  toast(t('rescue.new'));
}
function loadPatient() {
  const inj = rescue.patient;
  let hosp = null, hd = Infinity;                      // race to the nearest hospital
  for (const lm of landmarks) if (lm.type === 'hospital') {
    const d = dist(lm.door.x, lm.door.y, inj.x, inj.y);
    if (d < hd) { hd = d; hosp = lm; }
  }
  if (!hosp) { cancelRescue(); rescue.waitCd = 300; return; }
  const i = peds.indexOf(inj); if (i >= 0) peds.splice(i, 1);     // the casualty is loaded aboard
  rescue.patient = null; rescue.phase = 'deliver'; rescue.hosp = hosp;
  rescue.pay = 30 + Math.round(hd * 0.03 / 5) * 5;    // payout based on the run
  rescue.timer = Math.round(hd / 2.5) + 60 * 4;       // arrive quickly → bonus
  toast(t('rescue.aboard'));
  sfx.door();
}
function completeRescue() {
  const tip = rescue.timer > 0 ? Math.ceil(rescue.pay * 0.5 / 5) * 5 : 0;
  cash += rescue.pay + tip; updateCash(); sfx.coin();
  addScore(SCORE.mission.ambulance, player.x, player.y);
  rescue.jobs++;
  toast(tip > 0 ? t('rescue.doneTip', { pay: rescue.pay, tip }) : t('rescue.done', { pay: rescue.pay }));
  const d = rescue.hosp.door;                         // the patient, treated, walks away
  peds.push(makePed(d.x + rnd(-10, 10), d.y + rnd(-10, 10), 'civ'));
  rescue.phase = 'idle'; rescue.hosp = null; rescue.waitCd = 180;
}
function cancelRescue(msg) {
  if (rescue.patient) { rescue.patient.role = 'civ'; rescue.patient.thinkCd = 0; }   // they get up by themselves
  rescue.phase = 'idle'; rescue.patient = null; rescue.hosp = null; rescue.waitCd = 0;
  if (msg) toast(t(msg));
}
function updateRescue() {
  if (rescue.waitCd > 0 && player.car && player.car.livery === 'ambulance' && --rescue.waitCd === 0) spawnEmergency();
  if (!rescueActive()) return;
  const c = player.car;
  if (!c || c.livery !== 'ambulance') { cancelRescue('rescue.cancel'); return; }   // got out, or the vehicle was destroyed
  if (rescue.phase === 'pickup') {
    const inj = rescue.patient;
    if (!inj || inj.ko || inj.dead) { cancelRescue('rescue.lost'); rescue.waitCd = 240; return; }
    if (dist(c.x, c.y, inj.x, inj.y) < 70 && Math.abs(c.speed) < 0.9) loadPatient();
  } else if (rescue.phase === 'deliver') {
    if (rescue.timer > 0) rescue.timer--;
    if (dist(c.x, c.y, rescue.hosp.door.x, rescue.hosp.door.y) < 70 && Math.abs(c.speed) < 0.9) completeRescue();
  }
}

// ---------- PATROL CAR missions 🚔 ----------
// Get into a patrol car (parked in front of the station): the alarm goes off — a robber
// is fleeing a bank or a market. Catch up and stop them by pulling alongside (or the
// old-fashioned way…) before they disappear for good.
const patrol = { phase: 'idle', robber: null, pay: 0, timer: 0, timer0: 1, waitCd: 0, arrests: 0 };
const patrolActive = () => patrol.phase !== 'idle';
function spawnCrime() {
  // Crime scene: the nearest bank or market in range, otherwise a pavement.
  const spots = landmarks.filter(l => (l.type === 'bank' || l.type === 'market') &&
    dist(l.door.x, l.door.y, player.x, player.y) < 2400);
  const lm = spots.length ? pick(spots) : null;
  const cx = lm ? lm.door.x : player.x, cy = lm ? lm.door.y : player.y;
  const p = randomPublicSidewalkNear(cx, cy, lm ? 60 : 600, lm ? 260 : 1600);
  if (!p) { patrol.waitCd = 60; return; }
  const r = makePed(p.x, p.y, 'robber');
  r.shirt = '#2e2e34'; r.hair = '#1a1a1e';            // dressed in dark colours, a proper crook
  peds.push(r);
  patrol.phase = 'chase'; patrol.robber = r;
  patrol.pay = 45;
  patrol.timer0 = Math.round(dist(player.x, player.y, p.x, p.y) / 2.2) + 60 * 14;
  patrol.timer = patrol.timer0;                       // when time runs out the thief vanishes
  toast(t(lm ? (lm.type === 'bank' ? 'patrol.bank' : 'patrol.market') : 'patrol.street'));
  flashSiren();
}
function completeArrest(hard) {
  const bonus = patrol.timer > patrol.timer0 * 0.5 ? 20 : 0;   // caught quickly → bonus
  cash += patrol.pay + bonus; updateCash(); sfx.coin();
  addScore(SCORE.mission.patrol, player.x, player.y);
  patrol.arrests++;
  toast(hard ? t(bonus ? 'patrol.downBonus' : 'patrol.down', { pay: patrol.pay, bonus })
             : t(bonus ? 'patrol.arrestBonus' : 'patrol.arrest', { pay: patrol.pay, bonus }));
  const r = patrol.robber;                            // taken away with sirens blaring
  if (r && !r.ko) { const i = peds.indexOf(r); if (i >= 0) peds.splice(i, 1); }
  patrol.phase = 'idle'; patrol.robber = null; patrol.waitCd = 200;
}
function cancelPatrol(msg) {
  if (patrol.robber) { patrol.robber.role = 'civ'; patrol.robber.thinkCd = 0; }   // melts into the crowd
  patrol.phase = 'idle'; patrol.robber = null; patrol.waitCd = 0;
  if (msg) toast(t(msg));
}
function updatePatrol() {
  if (patrol.waitCd > 0 && player.car && player.car.wasPolice && --patrol.waitCd === 0) spawnCrime();
  if (!patrolActive()) return;
  const c = player.car;
  if (!c || !c.wasPolice) { cancelPatrol('patrol.cancel'); return; }   // got out, or the patrol car was destroyed
  const r = patrol.robber;
  if (!r) { cancelPatrol(); return; }
  if (r.ko || r.dead) { completeArrest(true); return; }         // floored: stopped all the same
  if (--patrol.timer <= 0) { cancelPatrol('patrol.escaped'); patrol.waitCd = 240; return; }
  if (dist(c.x, c.y, r.x, r.y) < 62 && Math.abs(c.speed) < 0.9) completeArrest(false);
}

// ---------- FIRE ENGINE missions 🚒 ----------
// Get into the fire engine (parked in front of the station): a fire has broken out in
// the city — race to the scene and put it out by spraying water with the hydrant (hold
// the left mouse button). Put it out quickly for the bonus.
const firejob = { phase: 'idle', site: null, pay: 0, timer: 0, timer0: 1, waitCd: 0, jobs: 0 };
const firejobActive = () => firejob.phase !== 'idle';
function spawnFire() {
  const p = randomPublicSidewalkNear(player.x, player.y, 600, 1800);
  if (!p) { firejob.waitCd = 60; return; }
  const site = { x: p.x, y: p.y, r: 26, hp: 140, seed: rnd(0, TAU) };
  fires.push(site);
  firejob.phase = 'extinguish'; firejob.site = site;
  const d = dist(player.x, player.y, p.x, p.y);
  firejob.pay = 35 + Math.round(d * 0.02 / 5) * 5;
  firejob.timer0 = Math.round(d / 2.2) + 60 * 16;    // after that the fire gets out of hand
  firejob.timer = firejob.timer0;
  toast(t('fire.new'));
  flashSiren();
}
function completeFirejob() {
  const bonus = firejob.timer > firejob.timer0 * 0.5 ? 20 : 0;   // put out quickly → bonus
  cash += firejob.pay + bonus; updateCash(); sfx.coin();
  addScore(SCORE.mission.fire, player.x, player.y);
  firejob.jobs++;
  toast(bonus ? t('fire.doneBonus', { pay: firejob.pay, bonus }) : t('fire.done', { pay: firejob.pay }));
  const i = fires.indexOf(firejob.site); if (i >= 0) fires.splice(i, 1);
  // Final puff of steam.
  for (let k = 0; k < 14; k++) parts.push({ x: firejob.site.x + rnd(-18, 18), y: firejob.site.y + rnd(-14, 14),
    vx: rnd(-0.5, 0.5), vy: rnd(-1.6, -0.6), life: rndi(18, 36), color: '#cfd6dd', size: rnd(4, 9), kind: 'smoke' });
  firejob.phase = 'idle'; firejob.site = null; firejob.waitCd = 200;
}
function cancelFirejob(msg) {
  if (firejob.site) { const i = fires.indexOf(firejob.site); if (i >= 0) fires.splice(i, 1); }
  firejob.phase = 'idle'; firejob.site = null; firejob.waitCd = 0;
  if (msg) toast(t(msg));
}
function updateFirejob() {
  if (firejob.waitCd > 0 && player.car && player.car.livery === 'fire' && --firejob.waitCd === 0) spawnFire();
  if (!firejobActive()) return;
  const c = player.car;
  if (!c || c.livery !== 'fire') { cancelFirejob('fire.cancel'); return; }   // got out, or the vehicle was destroyed
  if (firejob.site.hp <= 0) { completeFirejob(); return; }
  if (--firejob.timer <= 0) { cancelFirejob('fire.late'); firejob.waitCd = 240; return; }
}
// Fire-engine hydrant: sprays a jet of water towards the mouse.
function sprayWater(c) {
  const a = Math.atan2(mouseWY() - c.y, mouseWX() - c.x);
  for (let i = 0; i < 3; i++) {
    const aa = a + rnd(-0.09, 0.09), sp = rnd(6.5, 8.5);
    water.push({ x: c.x + Math.cos(a) * 26, y: c.y + Math.sin(a) * 26,
                 vx: Math.cos(aa) * sp, vy: Math.sin(aa) * sp, life: rndi(20, 30) });
  }
  if (frame % 7 === 0) sfx.spray();
}
function updateWater() {
  for (let i = water.length - 1; i >= 0; i--) {
    const w = water[i];
    w.x += w.vx; w.y += w.vy; w.life--;
    let gone = w.life <= 0 || solidTile(Math.floor(w.x / T), Math.floor(w.y / T));
    if (!gone) for (const f of fires) {
      if (dist(w.x, w.y, f.x, f.y) < f.r + 6) {       // water puts the fire out (steam!)
        f.hp -= 1.1; gone = true;
        if (frame % 2 === 0) parts.push({ x: w.x, y: w.y, vx: rnd(-0.5, 0.5), vy: rnd(-1.3, -0.4),
          life: rndi(10, 22), color: '#cfd6dd', size: rnd(3, 6), kind: 'smoke' });
        break;
      }
    }
    if (!gone) for (const c of cars) {                // water also puts out burning vehicles
      if (c.burning && dist(w.x, w.y, c.x, c.y) < 26) {
        gone = true;
        if (++c.burnWet >= 26) { c.burning = false; toast(t('fire.out')); }
        if (frame % 2 === 0) parts.push({ x: w.x, y: w.y, vx: rnd(-0.5, 0.5), vy: rnd(-1.3, -0.4),
          life: rndi(10, 22), color: '#cfd6dd', size: rnd(3, 6), kind: 'smoke' });
        break;
      }
    }
    if (!gone) for (const p of peds) {                // the spray scares passers-by (without hurting them)
      if (!p.ko && dist(w.x, w.y, p.x, p.y) < 11) {
        p.panic = 30; moveBox(p, w.vx * 0.4, w.vy * 0.4, p.r, p.r);
        gone = true; break;
      }
    }
    if (gone) water.splice(i, 1);
  }
}
// Live flames: particles, smoke, and damage if you walk into them on foot.
function updateFires() {
  for (const f of fires) {
    if (frame % 3 === 0) parts.push({ x: f.x + rnd(-f.r, f.r) * 0.7, y: f.y + rnd(-f.r, f.r) * 0.6,
      vx: rnd(-0.3, 0.3), vy: rnd(-1.7, -0.7), life: rndi(12, 26),
      color: pick(['#ff5a2a', '#ff8a2a', '#ffd23a']), size: rnd(3, 7), kind: 'smoke' });
    if (frame % 9 === 0) parts.push({ x: f.x + rnd(-10, 10), y: f.y - 6,
      vx: rnd(-0.3, 0.3), vy: rnd(-1.6, -0.9), life: rndi(24, 44), color: '#555', size: rnd(5, 9), kind: 'smoke' });
    if (!player.car && frame % 12 === 0 && dist(player.x, player.y, f.x, f.y) < f.r + 16) hurtPlayer(4);
  }
}

