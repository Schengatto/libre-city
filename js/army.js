// LIBRE CITY · js/army.js — esercito: carro armato e razzi, allarme della base,
// soldati di guardia e jeep militari.

// ---------- Carro armato 🪖 ----------
// alla CASERMA dell'esercito trovi i carri armati: sparano razzi (lentamente,
// la ricarica è lunga) e passano sopra le altre auto schiacciandole — BOOM!
function updateTankGun(c) {
  if (c.turretA == null) c.turretA = c.angle;
  // la torretta è pesante: ruota piano verso il mirino
  c.turretA = steerToward(c.turretA, Math.atan2(mouseWY() - c.y, mouseWX() - c.x), 0.055);
  if (c.gunCd > 0) c.gunCd--;
  if (mDownL && c.gunCd === 0) {
    const a = c.turretA;
    rockets.push({ x: c.x + Math.cos(a) * 44, y: c.y + Math.sin(a) * 44,
                   vx: Math.cos(a) * 6.5, vy: Math.sin(a) * 6.5, life: 120, src: c });
    c.gunCd = 100;                                    // ricarica lenta: un colpo alla volta
    spawnMuzzle(c.x + Math.cos(a) * 48, c.y + Math.sin(a) * 48, a);
    shake(4, 5); sfx.rocket();
    netRocketFired(c);                                // multigiocatore: il razzo vola anche dai rivali
  }
}
// il razzo vola lasciando una scia di fumo e scoppia al primo impatto
function updateRockets() {
  for (let i = rockets.length - 1; i >= 0; i--) {
    const r = rockets[i];
    r.x += r.vx; r.y += r.vy; r.life--;
    parts.push({ x: r.x - r.vx, y: r.y - r.vy, vx: rnd(-0.3, 0.3), vy: rnd(-0.6, -0.1),
                 life: rndi(10, 22), color: '#9aa0a8', size: rnd(2.5, 5), kind: 'smoke' });
    let boom = r.life <= 0 || r.x < 0 || r.y < 0 || r.x > WORLD_W || r.y > WORLD_H;
    if (!boom && solidTile(Math.floor(r.x / T), Math.floor(r.y / T))) boom = true;
    if (!boom) for (const c of cars) {
      if (c === r.src) continue;
      if (Math.abs(r.x - c.x) < c.w / 2 && Math.abs(r.y - c.y) < c.h / 2 + 5) {
        if (r.fromNet && c.driver === 'player') netRegisterHit(r.fromNet);   // razzo di un rivale sul nostro mezzo
        damageCar(c, 95, Math.atan2(r.vy, r.vx));     // colpo diretto: quasi sempre fatale
        boom = true; break;
      }
    }
    if (!boom) for (const p of peds)
      if (!p.ko && dist(r.x, r.y, p.x, p.y) < p.r + 5) { boom = true; break; }
    // il razzo scoppia anche addosso a un giocatore a piedi (PvP col lanciarazzi)
    if (!boom && MP) for (const v of MP) {
      if (v === r.owner || v.downT > 0 || v.car) continue;
      if (dist(r.x, r.y, v.x, v.y) < v.r + 6) { boom = true; break; }
    }
    if (boom) { explodeRocket(r); rockets.splice(i, 1); }
  }
}
function explodeRocket(r) {
  spawnExplosion(r.x, r.y);
  shake(7, 9); sfx.boom();
  // l'onda d'urto sbalza i pedoni e scheggia i veicoli intorno
  // (se il razzo è di un RIVALE in multigiocatore — r.fromNet — i suoi crimini
  //  non sono affar nostro: niente stelle né allarme militare per noi)
  for (const p of peds) if (!p.ko && dist(p.x, p.y, r.x, r.y) < 72) {
    knockPed(p, Math.atan2(p.y - r.y, p.x - r.x), 8);
    if (r.fromNet) continue;
    if (p.role === 'cop') commitCrime(1.2, '🚨 Hai bombardato un poliziotto!');
    else if (p.role === 'soldier') armyAlertT = ARMY_ALERT_T;   // l'esercito non la prende bene
    else if (p.role !== 'robber') commitCrime(0.7, '🚨 Hai bombardato un passante!');
  }
  eachActivePlayer(v => {
    const px = v.car ? v.car.x : v.x, py = v.car ? v.car.y : v.y;
    if (r.fromNet && dist(px, py, r.x, r.y) < 85) netRegisterHit(r.fromNet);   // firma del tiratore (client)
    const dd = !v.car ? dist(v.x, v.y, r.x, r.y) : Infinity;
    if (dd < 72) {
      const dmg = Math.round(120 - 85 * (dd / 72));   // ~120 in pieno (letale) → ~35 ai margini
      const wasDown = v.downT > 0, vb = v.bounty | 0;
      asPlayer(v, () => hurtPlayer(dmg, Math.atan2(v.y - r.y, v.x - r.x)));
      // razzo di un giocatore (lanciarazzi): l'uccisione di un ALTRO player fa punti e taglia
      if (!wasDown && v.downT > 0 && r.owner && v !== r.owner && typeof creditKill === 'function') creditKill(r.owner, v, vb);
    }
  });
  for (const o of [...cars]) if (o !== r.src && dist(o.x, o.y, r.x, r.y) < 85) damageCar(o, 45);
}
// i cingoli non perdonano: l'auto che finisce sotto il carro esplode sul colpo
function tankCrush(c) {
  if (Math.abs(c.speed) < 1.2) return;
  const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
  for (const o of [...cars]) {
    if (o === c || o.isTank || o.exploded) continue;
    const dx = o.x - c.x, dy = o.y - c.y;
    if (Math.abs(dx * ca + dy * sa) < c.w / 2 && Math.abs(-dx * sa + dy * ca) < c.h / 2) {
      explodeCar(o);
      shake(6, 7);
      commitCrime(o.role === 'police' || o.wasPolice ? 1.2 : 0.5,
        o.role === 'police' || o.wasPolice ? '🚨 Hai schiacciato una volante!' : '🚨 Hai schiacciato un\'auto!');
    }
  }
}

// ---------- Esercito: zona militare sorvegliata ----------
// la CASERMA è off-limits: se Federico entra nella base (o ruba un carro
// armato) scatta l'allarme — i soldati sparano a vista e le jeep militari
// armate gli danno la caccia finché non si allontana per un bel po'
const ARMY_ALERT_T = 60 * 18;
let armyAlertT = 0;
const SAY_ARMY = ['Zona militare!', 'Intruso! Fuoco!', 'Fermo dove sei!', 'Allarme! Allarme!', 'Difendete la base!', 'Non è un\'esercitazione!'];
function nearestArmyBase() {
  const fp = spawnFocus();
  let best = null, bd = Infinity;
  for (const lm of landmarks) if (lm.type === 'army') {
    const d = dist(lm.cx, lm.cy, fp.x, fp.y);
    if (d < bd) { bd = d; best = lm; }
  }
  return best;
}
// v (un giocatore) è dentro il recinto della base (a piedi o su un mezzo)
function playerInBase(lm, v) {
  v = v || player;
  return v.x > lm.x0 * T && v.x < (lm.x1 + 1) * T &&
         v.y > lm.y0 * T && v.y < (lm.y1 + 1) * T;
}
function triggerArmyAlert(lm) {
  if (armyAlertT === 0) {
    toast('🪖 ZONA MILITARE! Hai fatto scattare l\'allarme — scappa!');
    flashSiren(); sfx.alarm(null);
    // mezzo secondo abbondante per capire che aria tira: nessuno spara
    // a bruciapelo sul cancello, i soldati devono prendere la mira
    for (const p of peds) if (p.role === 'soldier') p.shootCd = Math.max(p.shootCd, rndi(45, 100));
    if (lm) {
      // i rinforzi escono dalle camerate, in mezzo al piazzale (non sul cancello)
      for (let k = 0; k < 3; k++) {
        const sp = armyInteriorSpot(lm, 40);
        if (sp) { const s = makeSoldier(sp.x, sp.y); s.shootCd = rndi(45, 100); peds.push(s); }
      }
      const rp = randomRoadNear(lm.door.x, lm.door.y, 80, 520);
      if (rp) cars.push(makeArmyCar(rp.x, rp.y));
    }
  }
  armyAlertT = ARMY_ALERT_T;
}
function updateArmy() {
  // un QUALSIASI giocatore dentro una base fa scattare l'allarme
  let intruded = null;
  eachActivePlayer(v => {
    if (intruded) return;
    for (const lm of landmarks) if (lm.type === 'army' && playerInBase(lm, v)) { intruded = lm; return; }
  });
  if (intruded) triggerArmyAlert(intruded);
  else if (armyAlertT > 0) armyAlertT--;
  // klaxon della base finché l'allarme è attivo
  const lm = nearestArmyBase();
  if (armyAlertT > 0 && frame % 90 === 0 && lm) { const h = hear(lm.cx, lm.cy, 1100); if (h) sfx.alarm(h); }
}
// (makeSoldier e makeArmyCar stanno in js/entities.js con le altre fabbriche:
//  servono già allo spawn iniziale del mondo, che gira al caricamento di quel file)
// soldato a piedi: come un poliziotto, ma spara a vista (niente arresti).
// Senza allarme le guardie fanno la ronda nel cortile della caserma.
function updateSoldier(p) {
  if (armyAlertT === 0) { updateGuardIdle(p); return; }
  const tp = nearestPlayer(p.x, p.y);
  const tx = tp.x - p.x, ty = tp.y - p.y, d = Math.hypot(tx, ty) || 1;
  p.dir = { x: tx / d, y: ty / d }; p.speed = 2.1;
  p.facing = Math.atan2(ty, tx);
  if (d < 460 && Math.random() < 0.02) pedSay(p, SAY_ARMY, '#3d5226');
  const advance = d > 100 ? p.speed : 0.3;            // sotto tiro rallenta e mira
  moveBox(p, p.dir.x * advance, p.dir.y * advance, p.r, p.r);
  p.walk += advance > 0.5 ? 0.25 : 0;
  if (p.shootCd > 0) p.shootCd--;
  if (d < 360 && p.shootCd === 0 && lineClear(p.x, p.y, tp.x, tp.y)) {
    soldierShoot(p, tp); p.shootCd = rndi(30, 50);
  }
}
// ronda a riposo: la guardia pattuglia il piazzale; se un inseguimento l'ha
// portata fuori, rientra alla base a passo svelto
function updateGuardIdle(p) {
  if (!p.guard) return;                               // i rinforzi fermi li smobilita managePopulation
  const lm = landmarks[p.baseLm];
  if (!lm) return;
  const inside = p.x > (lm.x0 + 1) * T && p.x < lm.x1 * T && p.y > (lm.y0 + 1) * T && p.y < lm.y1 * T;
  if (!inside) {                                      // rientro in caserma
    const a = Math.atan2(lm.cy - p.y, lm.cx - p.x);
    p.dir = { x: Math.cos(a), y: Math.sin(a) }; p.speed = 1.6;
    moveBox(p, p.dir.x * p.speed, p.dir.y * p.speed, p.r, p.r);
    p.facing = a; p.walk += 0.25;
    return;
  }
  p.thinkCd--;
  if (p.thinkCd <= 0) {                               // ogni tanto cambia posto o si ferma
    if (Math.random() < 0.5) { p.dir = { x: 0, y: 0 }; p.speed = 0; }
    else { p.dir = pick(DIRS); p.speed = 1.0; }
    p.thinkCd = rndi(60, 200);
  }
  if (p.speed > 0) {
    moveBox(p, p.dir.x * p.speed, p.dir.y * p.speed, p.r, p.r);
    if (p.hitX) p.dir.x *= -1;
    if (p.hitY) p.dir.y *= -1;
    // non oltrepassa il cancello durante la ronda
    if (p.x < (lm.x0 + 1) * T || p.x > lm.x1 * T) p.dir.x *= -1;
    if (p.y < (lm.y0 + 1) * T || p.y > lm.y1 * T) p.dir.y *= -1;
    p.walk += 0.2; p.facing = Math.atan2(p.dir.y, p.dir.x);
  } else p.walk = 0;
}
function soldierShoot(p, tp) {
  tp = tp || nearestPlayer(p.x, p.y);
  const a = Math.atan2(tp.y - p.y, tp.x - p.x) + rnd(-0.1, 0.1);
  bullets.push({ x: p.x + Math.cos(a) * 12, y: p.y + Math.sin(a) * 12,
                 vx: Math.cos(a) * 12, vy: Math.sin(a) * 12, life: 58, fromPlayer: false });
  spawnMuzzle(p.x + Math.cos(a) * 12, p.y + Math.sin(a) * 12, a);
  sfx.copShoot(hear(p.x, p.y, 700));
}
function updateArmyCar(c) {
  c.lightPhase += 0.2;
  const tp = nearestPlayer(c.x, c.y);
  c.angle = steerToward(c.angle, Math.atan2(tp.y - c.y, tp.x - c.x), 0.06);
  const d = dist(c.x, c.y, tp.x, tp.y);
  c.speed = d > 130 ? c.maxSpeed : c.maxSpeed * 0.35;
  moveBox(c, Math.cos(c.angle) * c.speed, Math.sin(c.angle) * c.speed, c.colH, c.colH);
  if (c.hitX || c.hitY) c.angle += rnd(-0.7, 0.7);
  applyKnockback(c);                                  // rimbalzo residuo dagli urti
  c.dir = { x: Math.cos(c.angle), y: Math.sin(c.angle) };
  if (c.shootCd > 0) c.shootCd--;
  if (d < 380 && c.shootCd === 0 && lineClear(c.x, c.y, tp.x, tp.y)) {
    const a = Math.atan2(tp.y - c.y, tp.x - c.x) + rnd(-0.11, 0.11);
    bullets.push({ x: c.x + Math.cos(a) * 26, y: c.y + Math.sin(a) * 26,
                   vx: Math.cos(a) * 12, vy: Math.sin(a) * 12, life: 55, fromPlayer: false });
    spawnMuzzle(c.x + Math.cos(a) * 26, c.y + Math.sin(a) * 26, a);
    sfx.copShoot(hear(c.x, c.y, 700));
    c.shootCd = rndi(34, 58);
  }
  runOverPlayer(c, true);                             // la jeep può investire un player a piedi
  runOver(c, false);
}

