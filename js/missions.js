// LIBRE CITY · js/missions.js — missioni: taxi 🚕, pizza 🍕, ambulanza 🚑, pattuglia 🚔
// e pompieri 🚒 (incendi, idrante e gocce d'acqua).

// ---------- Missioni TAXI 🚕 ----------
// Sali su un taxi: un cliente ti aspetta sul marciapiede — caricalo e portalo a
// destinazione seguendo la freccia. Il compenso cresce con la lunghezza della
// corsa, e se arrivi in tempo il cliente lascia pure la mancia!
const taxi = { phase: 'idle', fare: null, dest: null, pay: 0, timer: 0, waitCd: 0, rides: 0 };
const taxiActive = () => taxi.phase !== 'idle';
const taxiTarget = () => taxi.phase === 'pickup' ? taxi.fare : taxi.dest;
function spawnFare() {
  const p = randomTileNear(player.x, player.y, 500, 1600, (tx, ty) => tileAt(tx, ty) === SIDEWALK);
  if (!p) { taxi.waitCd = 60; return; }
  const f = makePed(p.x, p.y, 'fare');
  f.speed = 0; f.dir = { x: 0, y: 0 };
  peds.push(f);
  taxi.phase = 'pickup'; taxi.fare = f;
  toast('🚕 Un cliente ti sta aspettando — segui la freccia!');
}
function startRide() {
  const f = taxi.fare;
  let d = null;                                       // destinazione: un punto su strada, lontano
  for (let r = 2400; r >= 800 && !d; r -= 400) d = randomRoadNear(f.x, f.y, r * 0.6, r);
  if (!d) { cancelTaxi(); taxi.waitCd = 120; return; }
  const i = peds.indexOf(f); if (i >= 0) peds.splice(i, 1);       // il cliente sale a bordo
  taxi.fare = null; taxi.phase = 'ride'; taxi.dest = { x: d.x, y: d.y };
  const len = dist(player.x, player.y, d.x, d.y);
  taxi.pay = 15 + Math.round(len * 0.022 / 5) * 5;                // compenso in base alla distanza
  taxi.timer = Math.round(len / 2.5) + 60 * 4;                    // arriva in tempo → mancia
  toast('🧳 Cliente a bordo! Portalo a destinazione');
  sfx.door();
}
function completeRide() {
  const tip = taxi.timer > 0 ? Math.ceil(taxi.pay * 0.5 / 5) * 5 : 0;
  cash += taxi.pay + tip; updateCash(); sfx.coin();
  addScore(SCORE.mission.taxi, player.x, player.y);
  taxi.rides++;
  toast(tip > 0 ? `💰 Corsa completata! +$${taxi.pay} · mancia +$${tip} ⏱️`
                : `💰 Corsa completata! +$${taxi.pay}`);
  const c = player.car;                                           // il cliente scende e se ne va
  peds.push(makePed(c.x + Math.cos(c.angle + Math.PI / 2) * 30, c.y + Math.sin(c.angle + Math.PI / 2) * 30, 'civ'));
  taxi.phase = 'idle'; taxi.dest = null; taxi.waitCd = 150;       // fra poco un altro cliente
}
function cancelTaxi(msg) {
  if (taxi.fare) { taxi.fare.role = 'civ'; taxi.fare.thinkCd = 0; }   // il cliente rinuncia e passeggia
  taxi.phase = 'idle'; taxi.fare = null; taxi.dest = null; taxi.waitCd = 0;
  if (msg) toast(msg);
}
function updateTaxi() {
  if (taxi.waitCd > 0 && player.car && player.car.isTaxi && --taxi.waitCd === 0) spawnFare();
  if (!taxiActive()) return;
  const c = player.car;
  if (!c || !c.isTaxi) { cancelTaxi('🚕 Corsa annullata'); return; }   // sceso o taxi distrutto
  if (taxi.phase === 'pickup') {
    const f = taxi.fare;
    if (!f || f.ko || f.dead) { cancelTaxi('😵 Il cliente è rimasto a terra… corsa annullata'); taxi.waitCd = 240; return; }
    if (dist(c.x, c.y, f.x, f.y) < 62 && Math.abs(c.speed) < 0.8) startRide();
  } else if (taxi.phase === 'ride') {
    if (taxi.timer > 0) taxi.timer--;
    if (dist(c.x, c.y, taxi.dest.x, taxi.dest.y) < 70 && Math.abs(c.speed) < 0.9) completeRide();
  }
}

// ---------- Missioni PIZZA DELIVERY 🍕 ----------
// Sali su una moto delle consegne: la pizzeria prepara un ordine — ritira il
// cibo all'ingresso del negozio e portalo al cliente affamato che lo aspetta.
// Se consegni finché è caldo il cliente lascia pure la mancia!
const pizza = { phase: 'idle', shop: null, client: null, pay: 0, timer: 0, waitCd: 0, jobs: 0 };
const pizzaActive = () => pizza.phase !== 'idle';
const pizzaTarget = () => pizza.phase === 'pickup' ? (pizza.shop && pizza.shop.door) : pizza.client;
function spawnOrder() {
  let shop = null, sd = Infinity;                     // la pizzeria più vicina prepara l'ordine
  for (const lm of landmarks) if (lm.type === 'pizzeria') {
    const d = dist(lm.door.x, lm.door.y, player.x, player.y);
    if (d < sd) { sd = d; shop = lm; }
  }
  if (!shop) { pizza.waitCd = 300; return; }
  // il cliente affamato aspetta su un marciapiede non troppo vicino al negozio
  const p = randomTileNear(shop.door.x, shop.door.y, 600, 1800, (tx, ty) => tileAt(tx, ty) === SIDEWALK);
  if (!p) { pizza.waitCd = 60; return; }
  const cl = makePed(p.x, p.y, 'hungry');
  cl.speed = 0; cl.dir = { x: 0, y: 0 };
  peds.push(cl);
  pizza.phase = 'pickup'; pizza.shop = shop; pizza.client = cl;
  toast('🍕 Nuovo ordine! Ritira il cibo alla PIZZERIA — segui la freccia');
}
function pickupFood() {
  const len = dist(pizza.shop.door.x, pizza.shop.door.y, pizza.client.x, pizza.client.y);
  pizza.pay = 20 + Math.round(len * 0.025 / 5) * 5;   // compenso in base alla distanza
  pizza.timer = Math.round(len / 2.6) + 60 * 4;       // consegna calda → mancia
  pizza.phase = 'deliver';
  toast('🛵 Ordine nel bauletto! Consegnalo finché è caldo');
  sfx.door();
}
function completeDelivery() {
  const tip = pizza.timer > 0 ? Math.ceil(pizza.pay * 0.5 / 5) * 5 : 0;
  cash += pizza.pay + tip; updateCash(); sfx.coin();
  addScore(SCORE.mission.pizza, player.x, player.y);
  pizza.jobs++;
  toast(tip > 0 ? `💰 Consegnata calda! +$${pizza.pay} · mancia +$${tip} 🔥`
                : `💰 Pizza consegnata! +$${pizza.pay}`);
  const cl = pizza.client;                            // il cliente ringrazia e se ne va
  if (cl) { cl.role = 'civ'; cl.thinkCd = 0; }
  pizza.phase = 'idle'; pizza.shop = null; pizza.client = null;
  pizza.waitCd = 180;                                 // fra poco un altro ordine
}
function cancelPizza(msg) {
  if (pizza.client) { pizza.client.role = 'civ'; pizza.client.thinkCd = 0; }   // il cliente ordina altrove
  pizza.phase = 'idle'; pizza.shop = null; pizza.client = null; pizza.waitCd = 0;
  if (msg) toast(msg);
}
function updatePizza() {
  if (pizza.waitCd > 0 && player.car && player.car.isDelivery && --pizza.waitCd === 0) spawnOrder();
  if (!pizzaActive()) return;
  const c = player.car;
  if (!c || !c.isDelivery) { cancelPizza('🍕 Consegna annullata'); return; }   // sceso o moto distrutta
  const cl = pizza.client;
  if (!cl || cl.ko || cl.dead) { cancelPizza('😵 Il cliente è rimasto a terra… consegna annullata'); pizza.waitCd = 240; return; }
  if (pizza.phase === 'pickup') {
    if (dist(c.x, c.y, pizza.shop.door.x, pizza.shop.door.y) < 70 && Math.abs(c.speed) < 0.9) pickupFood();
  } else if (pizza.phase === 'deliver') {
    if (pizza.timer > 0) pizza.timer--;
    if (dist(c.x, c.y, cl.x, cl.y) < 62 && Math.abs(c.speed) < 0.8) completeDelivery();
  }
}

// ---------- Missioni SOCCORSO in AMBULANZA 🚑 ----------
// Sali su un'ambulanza (parcheggiata davanti all'ospedale): un ferito chiede
// aiuto in città — raggiungilo, caricalo a bordo e corri all'ospedale più
// vicino. Arriva in fretta e ricevi pure il bonus di soccorso!
const rescue = { phase: 'idle', patient: null, hosp: null, pay: 0, timer: 0, waitCd: 0, jobs: 0 };
const rescueActive = () => rescue.phase !== 'idle';
const rescueTarget = () => rescue.phase === 'pickup' ? rescue.patient : (rescue.hosp && rescue.hosp.door);
function spawnEmergency() {
  const p = randomTileNear(player.x, player.y, 600, 1800, (tx, ty) => tileAt(tx, ty) === SIDEWALK);
  if (!p) { rescue.waitCd = 60; return; }
  const inj = makePed(p.x, p.y, 'injured');
  inj.speed = 0; inj.dir = { x: 0, y: 0 };
  peds.push(inj);
  rescue.phase = 'pickup'; rescue.patient = inj;
  toast('🚑 Emergenza! Un ferito ha bisogno di te — segui la freccia');
}
function loadPatient() {
  const inj = rescue.patient;
  let hosp = null, hd = Infinity;                      // corri all'ospedale più vicino
  for (const lm of landmarks) if (lm.type === 'hospital') {
    const d = dist(lm.door.x, lm.door.y, inj.x, inj.y);
    if (d < hd) { hd = d; hosp = lm; }
  }
  if (!hosp) { cancelRescue(); rescue.waitCd = 300; return; }
  const i = peds.indexOf(inj); if (i >= 0) peds.splice(i, 1);     // il ferito sale a bordo
  rescue.patient = null; rescue.phase = 'deliver'; rescue.hosp = hosp;
  rescue.pay = 30 + Math.round(hd * 0.03 / 5) * 5;    // compenso in base alla corsa
  rescue.timer = Math.round(hd / 2.5) + 60 * 4;       // arriva in fretta → bonus
  toast('🩹 Ferito a bordo! Corri all\'OSPEDALE');
  sfx.door();
}
function completeRescue() {
  const tip = rescue.timer > 0 ? Math.ceil(rescue.pay * 0.5 / 5) * 5 : 0;
  cash += rescue.pay + tip; updateCash(); sfx.coin();
  addScore(SCORE.mission.ambulance, player.x, player.y);
  rescue.jobs++;
  toast(tip > 0 ? `💰 Paziente salvo! +$${rescue.pay} · bonus soccorso +$${tip} ⏱️`
                : `💰 Paziente consegnato! +$${rescue.pay}`);
  const d = rescue.hosp.door;                         // il paziente, curato, se ne va
  peds.push(makePed(d.x + rnd(-10, 10), d.y + rnd(-10, 10), 'civ'));
  rescue.phase = 'idle'; rescue.hosp = null; rescue.waitCd = 180;
}
function cancelRescue(msg) {
  if (rescue.patient) { rescue.patient.role = 'civ'; rescue.patient.thinkCd = 0; }   // si rialza da solo
  rescue.phase = 'idle'; rescue.patient = null; rescue.hosp = null; rescue.waitCd = 0;
  if (msg) toast(msg);
}
function updateRescue() {
  if (rescue.waitCd > 0 && player.car && player.car.livery === 'ambulance' && --rescue.waitCd === 0) spawnEmergency();
  if (!rescueActive()) return;
  const c = player.car;
  if (!c || c.livery !== 'ambulance') { cancelRescue('🚑 Soccorso annullato'); return; }   // sceso o mezzo distrutto
  if (rescue.phase === 'pickup') {
    const inj = rescue.patient;
    if (!inj || inj.ko || inj.dead) { cancelRescue('😵 Il ferito è stato travolto… soccorso annullato'); rescue.waitCd = 240; return; }
    if (dist(c.x, c.y, inj.x, inj.y) < 70 && Math.abs(c.speed) < 0.9) loadPatient();
  } else if (rescue.phase === 'deliver') {
    if (rescue.timer > 0) rescue.timer--;
    if (dist(c.x, c.y, rescue.hosp.door.x, rescue.hosp.door.y) < 70 && Math.abs(c.speed) < 0.9) completeRescue();
  }
}

// ---------- Missioni PATTUGLIA in VOLANTE 🚔 ----------
// Sali su una volante (parcheggiata davanti alla centrale): scatta l'allarme —
// un rapinatore fugge da una banca o da un mercato. Raggiungilo e fermalo
// accostando (o alla vecchia maniera…) prima che faccia perdere le sue tracce!
const patrol = { phase: 'idle', robber: null, pay: 0, timer: 0, timer0: 1, waitCd: 0, arrests: 0 };
const patrolActive = () => patrol.phase !== 'idle';
function spawnCrime() {
  // scena del crimine: la banca o il mercato più a portata, altrimenti un marciapiede
  const spots = landmarks.filter(l => (l.type === 'bank' || l.type === 'market') &&
    dist(l.door.x, l.door.y, player.x, player.y) < 2400);
  const lm = spots.length ? pick(spots) : null;
  const cx = lm ? lm.door.x : player.x, cy = lm ? lm.door.y : player.y;
  const p = randomTileNear(cx, cy, lm ? 60 : 600, lm ? 260 : 1600, (tx, ty) => tileAt(tx, ty) === SIDEWALK);
  if (!p) { patrol.waitCd = 60; return; }
  const r = makePed(p.x, p.y, 'robber');
  r.shirt = '#2e2e34'; r.hair = '#1a1a1e';            // vestito di scuro, da vero bandito
  peds.push(r);
  patrol.phase = 'chase'; patrol.robber = r;
  patrol.pay = 45;
  patrol.timer0 = Math.round(dist(player.x, player.y, p.x, p.y) / 2.2) + 60 * 14;
  patrol.timer = patrol.timer0;                       // scaduto il tempo, il ladro sparisce nel nulla
  toast(lm ? (lm.type === 'bank' ? '🚨 Rapina in BANCA! Ferma il ladro in fuga' : '🚨 Furto al MERCATO! Ferma il ladro in fuga')
           : '🚨 Scippo in strada! Ferma il ladro in fuga');
  flashSiren();
}
function completeArrest(hard) {
  const bonus = patrol.timer > patrol.timer0 * 0.5 ? 20 : 0;   // preso al volo → bonus
  cash += patrol.pay + bonus; updateCash(); sfx.coin();
  addScore(SCORE.mission.patrol, player.x, player.y);
  patrol.arrests++;
  toast(hard ? `🚔 Ladro steso e refurtiva recuperata! +$${patrol.pay}${bonus ? ` · bonus +$${bonus} ⏱️` : ''}`
             : `🚔 Ladro arrestato! +$${patrol.pay}${bonus ? ` · bonus rapidità +$${bonus} ⏱️` : ''}`);
  const r = patrol.robber;                            // portato via a sirene spiegate
  if (r && !r.ko) { const i = peds.indexOf(r); if (i >= 0) peds.splice(i, 1); }
  patrol.phase = 'idle'; patrol.robber = null; patrol.waitCd = 200;
}
function cancelPatrol(msg) {
  if (patrol.robber) { patrol.robber.role = 'civ'; patrol.robber.thinkCd = 0; }   // si mescola alla folla
  patrol.phase = 'idle'; patrol.robber = null; patrol.waitCd = 0;
  if (msg) toast(msg);
}
function updatePatrol() {
  if (patrol.waitCd > 0 && player.car && player.car.wasPolice && --patrol.waitCd === 0) spawnCrime();
  if (!patrolActive()) return;
  const c = player.car;
  if (!c || !c.wasPolice) { cancelPatrol('🚔 Pattuglia interrotta'); return; }   // sceso o volante distrutta
  const r = patrol.robber;
  if (!r) { cancelPatrol(); return; }
  if (r.ko || r.dead) { completeArrest(true); return; }         // steso: comunque fermato
  if (--patrol.timer <= 0) { cancelPatrol('💨 Il ladro è riuscito a fuggire…'); patrol.waitCd = 240; return; }
  if (dist(c.x, c.y, r.x, r.y) < 62 && Math.abs(c.speed) < 0.9) completeArrest(false);
}

// ---------- Missioni POMPIERI con l'AUTOPOMPA 🚒 ----------
// Sali sull'autopompa (parcheggiata davanti alla caserma): un incendio divampa
// in città — corri sul posto e spegnilo sparando acqua con l'idrante (tieni
// premuto il tasto sinistro del mouse). Spegnilo in fretta per il bonus!
const firejob = { phase: 'idle', site: null, pay: 0, timer: 0, timer0: 1, waitCd: 0, jobs: 0 };
const firejobActive = () => firejob.phase !== 'idle';
function spawnFire() {
  const p = randomTileNear(player.x, player.y, 600, 1800, (tx, ty) => tileAt(tx, ty) === SIDEWALK);
  if (!p) { firejob.waitCd = 60; return; }
  const site = { x: p.x, y: p.y, r: 26, hp: 140, seed: rnd(0, TAU) };
  fires.push(site);
  firejob.phase = 'extinguish'; firejob.site = site;
  const d = dist(player.x, player.y, p.x, p.y);
  firejob.pay = 35 + Math.round(d * 0.02 / 5) * 5;
  firejob.timer0 = Math.round(d / 2.2) + 60 * 16;    // poi l'incendio sfugge di mano
  firejob.timer = firejob.timer0;
  toast('🔥 INCENDIO in città! Corri sul posto e spegnilo con l\'idrante');
  flashSiren();
}
function completeFirejob() {
  const bonus = firejob.timer > firejob.timer0 * 0.5 ? 20 : 0;   // spento al volo → bonus
  cash += firejob.pay + bonus; updateCash(); sfx.coin();
  addScore(SCORE.mission.fire, player.x, player.y);
  firejob.jobs++;
  toast(bonus ? `💧 Incendio spento! +$${firejob.pay} · bonus rapidità +$${bonus} ⏱️`
              : `💧 Incendio spento! +$${firejob.pay}`);
  const i = fires.indexOf(firejob.site); if (i >= 0) fires.splice(i, 1);
  // nuvola di vapore finale
  for (let k = 0; k < 14; k++) parts.push({ x: firejob.site.x + rnd(-18, 18), y: firejob.site.y + rnd(-14, 14),
    vx: rnd(-0.5, 0.5), vy: rnd(-1.6, -0.6), life: rndi(18, 36), color: '#cfd6dd', size: rnd(4, 9), kind: 'smoke' });
  firejob.phase = 'idle'; firejob.site = null; firejob.waitCd = 200;
}
function cancelFirejob(msg) {
  if (firejob.site) { const i = fires.indexOf(firejob.site); if (i >= 0) fires.splice(i, 1); }
  firejob.phase = 'idle'; firejob.site = null; firejob.waitCd = 0;
  if (msg) toast(msg);
}
function updateFirejob() {
  if (firejob.waitCd > 0 && player.car && player.car.livery === 'fire' && --firejob.waitCd === 0) spawnFire();
  if (!firejobActive()) return;
  const c = player.car;
  if (!c || c.livery !== 'fire') { cancelFirejob('🚒 Intervento annullato'); return; }   // sceso o mezzo distrutto
  if (firejob.site.hp <= 0) { completeFirejob(); return; }
  if (--firejob.timer <= 0) { cancelFirejob('🔥 Troppo tardi… ha dovuto pensarci un\'altra caserma'); firejob.waitCd = 240; return; }
}
// idrante dell'autopompa: spara un getto d'acqua verso il mouse
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
      if (dist(w.x, w.y, f.x, f.y) < f.r + 6) {       // l'acqua spegne il fuoco (vapore!)
        f.hp -= 1.1; gone = true;
        if (frame % 2 === 0) parts.push({ x: w.x, y: w.y, vx: rnd(-0.5, 0.5), vy: rnd(-1.3, -0.4),
          life: rndi(10, 22), color: '#cfd6dd', size: rnd(3, 6), kind: 'smoke' });
        break;
      }
    }
    if (!gone) for (const c of cars) {                // l'acqua spegne anche i veicoli in fiamme
      if (c.burning && dist(w.x, w.y, c.x, c.y) < 26) {
        gone = true;
        if (++c.burnWet >= 26) { c.burning = false; toast('💦 Fiamme spente!'); }
        if (frame % 2 === 0) parts.push({ x: w.x, y: w.y, vx: rnd(-0.5, 0.5), vy: rnd(-1.3, -0.4),
          life: rndi(10, 22), color: '#cfd6dd', size: rnd(3, 6), kind: 'smoke' });
        break;
      }
    }
    if (!gone) for (const p of peds) {                // lo spruzzo spaventa (ma non ferisce) i passanti
      if (!p.ko && dist(w.x, w.y, p.x, p.y) < 11) {
        p.panic = 30; moveBox(p, w.vx * 0.4, w.vy * 0.4, p.r, p.r);
        gone = true; break;
      }
    }
    if (gone) water.splice(i, 1);
  }
}
// fiamme vive: particelle, fumo e danno se ci finisci in mezzo a piedi
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

