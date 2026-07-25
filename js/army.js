// LIBRE CITY · js/army.js — the army: tank and rockets, base alarm, guard soldiers
// and military jeeps.

// ---------- Tank 🪖 ----------
// Tanks are found at the army BARRACKS: they fire rockets (slowly — the reload is long)
// and drive straight over other cars, crushing them — BOOM!
function updateTankGun(c) {
  if (c.turretA == null) c.turretA = c.angle;
  // The turret is heavy: it swings slowly towards the crosshair.
  c.turretA = steerToward(c.turretA, Math.atan2(mouseWY() - c.y, mouseWX() - c.x), 0.055);
  if (c.gunCd > 0) c.gunCd--;
  if (!peaceMode() && mDownL && c.gunCd === 0) {    // violence filter: the tank gun does not fire
    const a = c.turretA;
    rockets.push({ x: c.x + Math.cos(a) * 44, y: c.y + Math.sin(a) * 44,
                   vx: Math.cos(a) * 6.5, vy: Math.sin(a) * 6.5, life: 120, src: c });
    c.gunCd = 100;                                    // slow reload: one shot at a time
    spawnMuzzle(c.x + Math.cos(a) * 48, c.y + Math.sin(a) * 48, a);
    shake(4, 5); sfx.rocket();
    netRocketFired(c);                                // multiplayer: the rocket flies for rivals too
  }
}
// The rocket flies leaving a smoke trail and bursts on first impact.
function updateRockets() {
  for (let i = rockets.length - 1; i >= 0; i--) {
    const r = rockets[i];
    r.x += r.vx; r.y += r.vy; r.life--;
    if (!r.grenade) parts.push({ x: r.x - r.vx, y: r.y - r.vy, vx: rnd(-0.3, 0.3), vy: rnd(-0.6, -0.1),
                 life: rndi(10, 22), color: '#9aa0a8', size: rnd(2.5, 5), kind: 'smoke' });   // smoke trail (rockets only)
    let boom = r.life <= 0 || r.x < 0 || r.y < 0 || r.x > WORLD_W || r.y > WORLD_H;
    if (!boom && solidTile(Math.floor(r.x / T), Math.floor(r.y / T))) boom = true;
    if (!boom) for (const c of cars) {
      if (c === r.src) continue;
      if (Math.abs(r.x - c.x) < c.w / 2 && Math.abs(r.y - c.y) < c.h / 2 + 5) {
        if (r.fromNet && c.driver === 'player') netRegisterHit(r.fromNet);   // a rival's rocket on our vehicle
        damageCar(c, 95 * (r.pw || 1), Math.atan2(r.vy, r.vx));     // direct hit: nearly always fatal (less so for grenades, pw<1)
        boom = true; break;
      }
    }
    if (!boom) for (const p of peds)
      if (!p.ko && dist(r.x, r.y, p.x, p.y) < p.r + 5) { boom = true; break; }
    // The rocket also bursts against a player on foot (rocket-launcher PvP).
    if (!boom && MP) for (const v of MP) {
      if (v === r.owner || v.downT > 0 || v.car) continue;
      if (dist(r.x, r.y, v.x, v.y) < v.r + 6) { boom = true; break; }
    }
    if (boom) { explodeRocket(r); rockets.splice(i, 1); }
  }
}
function explodeRocket(r) {
  const pw = r.pw || 1;                          // < 1 for grenades: smaller, less lethal blast
  const pedR = 72 * pw, carR = 85 * pw;
  spawnExplosion(r.x, r.y);
  shake(7 * pw, Math.round(9 * pw)); sfx.boom();
  // The blast throws pedestrians clear and damages nearby vehicles.
  // (If the rocket belongs to a RIVAL in multiplayer — r.fromNet — their crimes are not
  //  our business: no stars and no military alert for us.)
  for (const p of peds) if (!p.ko && dist(p.x, p.y, r.x, r.y) < pedR) {
    knockPed(p, Math.atan2(p.y - r.y, p.x - r.x), 8 * pw);
    if (r.fromNet) continue;
    addScore(pedScore(p), p.x, p.y);
    // The crime is attributed to whoever fired (the explosion runs in the shared world phase).
    if (p.role === 'cop') asPlayer(r.owner || player, () => commitCrime(1.2, 'crime.bombCop'));
    else if (p.role === 'soldier') armyAlertT = ARMY_ALERT_T;   // the army does not take it well
    else if (p.role !== 'robber') asPlayer(r.owner || player, () => commitCrime(0.7, 'crime.bombPed'));
  }
  eachActivePlayer(v => {
    const px = v.car ? v.car.x : v.x, py = v.car ? v.car.y : v.y;
    if (r.fromNet && dist(px, py, r.x, r.y) < carR) netRegisterHit(r.fromNet);   // shooter's signature (client)
    const dd = !v.car ? dist(v.x, v.y, r.x, r.y) : Infinity;
    if (dd < pedR) {
      const dmg = Math.round((120 - 85 * (dd / pedR)) * pw);   // ~120·pw dead-centre → ~35·pw at the edge
      const wasDown = v.downT > 0, vb = v.bounty | 0;
      asPlayer(v, () => hurtPlayer(dmg, Math.atan2(v.y - r.y, v.x - r.x)));
      // A player's rocket/grenade: killing ANOTHER player earns points and a bounty.
      if (!wasDown && v.downT > 0 && r.owner && v !== r.owner && typeof creditKill === 'function') creditKill(r.owner, v, vb);
    }
  });
  for (const o of [...cars]) if (o !== r.src && dist(o.x, o.y, r.x, r.y) < carR) damageCar(o, 45 * pw);
}
// The tracks are unforgiving: a car caught under the tank explodes on the spot.
function tankCrush(c) {
  if (Math.abs(c.speed) < 1.2) return;
  for (const o of [...cars]) {
    if (o === c || o.isTank || o.exploded) continue;
    const dx = o.x - c.x, dy = o.y - c.y;
    if (dx * dx + dy * dy > CAR_REACH * CAR_REACH) continue;              // broad-phase
    // Real contact between the two silhouettes: it crushes as soon as the bodywork
    // touches, not once the car is already half inside the tank.
    if (carHit(c, o)) {
      explodeCar(o);
      shake(6, 7);
      // The crime belongs to whoever drives the tank (locally: the single player); an
      // army tank with no player driver makes nobody wanted.
      const by = MP ? c.owner : player;
      if (by || !MP) asPlayer(by, () => commitCrime(o.role === 'police' || o.wasPolice ? 1.2 : 0.5,
        o.role === 'police' || o.wasPolice ? 'crime.crushPolice' : 'crime.crushCar'));
    }
  }
}

// ---------- Army: guarded military zone ----------
// The BARRACKS is off-limits: if the player enters the base (or steals a tank) the
// alarm goes off — soldiers shoot on sight and armed military jeeps give chase until
// they have kept well away for a good while.
const ARMY_ALERT_T = 60 * 18;
let armyAlertT = 0;
const SAY_ARMY = 'say.army';               // the phrases live in js/i18n.js
function nearestArmyBase() {
  const fp = spawnFocus();
  let best = null, bd = Infinity;
  for (const lm of landmarks) if (lm.type === 'army') {
    const d = dist(lm.cx, lm.cy, fp.x, fp.y);
    if (d < bd) { bd = d; best = lm; }
  }
  return best;
}
// True if v (a player) is inside the base fence, on foot or in a vehicle.
function playerInBase(lm, v) {
  v = v || player;
  return v.x > lm.x0 * T && v.x < (lm.x1 + 1) * T &&
         v.y > lm.y0 * T && v.y < (lm.y1 + 1) * T;
}
function triggerArmyAlert(lm) {
  if (armyAlertT === 0) {
    toast(t('army.alarm'));
    flashSiren(); sfx.alarm(null);
    // A good half-second to read the room: nobody fires point-blank at the gate, the
    // soldiers have to take aim first.
    for (const p of peds) if (p.role === 'soldier') p.shootCd = Math.max(p.shootCd, rndi(45, 100));
    if (lm) {
      // Reinforcements come out of the barrack rooms, into the middle of the yard
      // (not at the gate).
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
  // ANY player inside a base sets off the alarm.
  let intruded = null;
  eachActivePlayer(v => {
    if (intruded) return;
    for (const lm of landmarks) if (lm.type === 'army' && playerInBase(lm, v)) { intruded = lm; return; }
  });
  if (intruded) triggerArmyAlert(intruded);
  else if (armyAlertT > 0) armyAlertT--;
  // The base klaxon sounds for as long as the alarm is up.
  const lm = nearestArmyBase();
  if (armyAlertT > 0 && frame % 90 === 0 && lm) { const h = hear(lm.cx, lm.cy, 1100); if (h) sfx.alarm(h); }
  updateTurrets();                                   // the corner turrets fire on intruders
}
// (makeSoldier and makeArmyCar live in js/entities.js with the other factories: they
//  are already needed by the initial world spawn, which runs as that file loads.)
// Soldier on foot: like a cop, but shoots on sight (no arrests). With no alarm raised,
// guards patrol the barracks yard.
function updateSoldier(p) {
  if (armyAlertT === 0) { updateGuardIdle(p); return; }
  const tp = nearestPlayer(p.x, p.y);
  const tx = tp.x - p.x, ty = tp.y - p.y, d = Math.hypot(tx, ty) || 1;
  p.dir = { x: tx / d, y: ty / d }; p.speed = 2.1;
  p.facing = Math.atan2(ty, tx);
  if (d < 460 && Math.random() < 0.02) pedSay(p, SAY_ARMY, '#3d5226');
  const advance = d > 100 ? p.speed : 0.3;            // in firing range they slow down and aim
  moveBox(p, p.dir.x * advance, p.dir.y * advance, p.r, p.r);
  p.walk += advance > 0.5 ? 0.25 : 0;
  if (p.shootCd > 0) p.shootCd--;
  if (d < 360 && p.shootCd === 0 && lineClear(p.x, p.y, tp.x, tp.y)) {
    soldierShoot(p, tp); p.shootCd = rndi(30, 50);
  }
}
// Idle patrol: the guard walks the yard; if a chase took them outside, they head back
// to the base at a brisk pace.
function updateGuardIdle(p) {
  if (!p.guard) return;                               // idle reinforcements are stood down by managePopulation
  const lm = landmarks[p.baseLm];
  if (!lm) return;
  const inside = p.x > (lm.x0 + 1) * T && p.x < lm.x1 * T && p.y > (lm.y0 + 1) * T && p.y < lm.y1 * T;
  if (!inside) {                                      // heading back to barracks
    const a = Math.atan2(lm.cy - p.y, lm.cx - p.x);
    p.dir = { x: Math.cos(a), y: Math.sin(a) }; p.speed = 1.6;
    moveBox(p, p.dir.x * p.speed, p.dir.y * p.speed, p.r, p.r);
    p.facing = a; p.walk += 0.25;
    return;
  }
  p.thinkCd--;
  if (p.thinkCd <= 0) {                               // now and then move somewhere else, or stop
    if (Math.random() < 0.5) { p.dir = { x: 0, y: 0 }; p.speed = 0; }
    else { p.dir = pick(DIRS); p.speed = 1.0; }
    p.thinkCd = rndi(60, 200);
  }
  if (p.speed > 0) {
    moveBox(p, p.dir.x * p.speed, p.dir.y * p.speed, p.r, p.r);
    if (p.hitX) p.dir.x *= -1;
    if (p.hitY) p.dir.y *= -1;
    // Do not stray past the gate while on patrol.
    if (p.x < (lm.x0 + 1) * T || p.x > lm.x1 * T) p.dir.x *= -1;
    if (p.y < (lm.y0 + 1) * T || p.y > lm.y1 * T) p.dir.y *= -1;
    p.walk += 0.2; p.facing = Math.atan2(p.dir.y, p.dir.x);
  } else p.walk = 0;
}
function soldierShoot(p, tp) {
  if (peaceMode()) return;                          // violence filter: guards do not shoot
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
  applyKnockback(c);                                  // residual bounce from collisions
  c.dir = { x: Math.cos(c.angle), y: Math.sin(c.angle) };
  if (c.shootCd > 0) c.shootCd--;
  if (!peaceMode() && d < 380 && c.shootCd === 0 && lineClear(c.x, c.y, tp.x, tp.y)) {   // violence filter: the jeep does not shoot
    const a = Math.atan2(tp.y - c.y, tp.x - c.x) + rnd(-0.11, 0.11);
    bullets.push({ x: c.x + Math.cos(a) * 26, y: c.y + Math.sin(a) * 26,
                   vx: Math.cos(a) * 12, vy: Math.sin(a) * 12, life: 55, fromPlayer: false });
    spawnMuzzle(c.x + Math.cos(a) * 26, c.y + Math.sin(a) * 26, a);
    sfx.copShoot(hear(c.x, c.y, 700));
    c.shootCd = rndi(34, 58);
  }
  runOverPlayer(c, true);                             // the jeep can run down a player on foot
  runOver(c, false);
}

// ---------- Turrets at the barracks corners 🗼 ----------
// Each of the four fence corners holds a fortified post with a soldier on lookout: it
// opens fire on ANYONE who sets foot inside the compound (no general alarm needed — the
// turrets defend the perimeter on their own). They never move.
const turrets = [];
const TURRET_RANGE = 540;                             // engagement radius: covers the whole compound from a corner
function buildTurrets() {
  turrets.length = 0;
  for (let i = 0; i < landmarks.length; i++) {
    const lm = landmarks[i];
    if (lm.type !== 'army') continue;
    // Just inside the fence, one per corner.
    const corners = [[lm.x0 + 1, lm.y0 + 1], [lm.x1 - 1, lm.y0 + 1],
                     [lm.x0 + 1, lm.y1 - 1], [lm.x1 - 1, lm.y1 - 1]];
    for (const [tx, ty] of corners) {
      const x = (tx + 0.5) * T, y = (ty + 0.5) * T;
      turrets.push({ x, y, baseLm: i, cd: rndi(20, 60),
                     ang: Math.atan2(lm.cy - y, lm.cx - x) });   // at rest it faces the yard
    }
  }
}
// Target: the nearest active player, but only once they have ENTERED the compound.
function turretTarget(tr) {
  const lm = landmarks[tr.baseLm];
  let tp = null, bd = TURRET_RANGE;
  eachActivePlayer(v => {
    if (v.downT > 0 || (lm && !playerInBase(lm, v))) return;
    const d = dist(tr.x, tr.y, v.x, v.y);
    if (d < bd) { bd = d; tp = v; }
  });
  return tp;
}
function updateTurrets() {
  for (const tr of turrets) {
    if (tr.cd > 0) tr.cd--;
    const tp = turretTarget(tr);
    if (!tp) continue;                                // no intruder: the turret stays quiet
    const aim = Math.atan2(tp.y - tr.y, tp.x - tr.x);
    tr.ang = steerToward(tr.ang, aim, 0.16);          // the machine gun swings onto the target
    if (tr.cd === 0 && Math.abs(angDiff(tr.ang, aim)) < 0.3 && lineClear(tr.x, tr.y, tp.x, tp.y)) {
      turretShoot(tr); tr.cd = rndi(24, 40);
    }
  }
}
function turretShoot(tr) {
  if (peaceMode()) return;                          // violence filter: turrets do not fire
  const a = tr.ang + rnd(-0.05, 0.05);
  bullets.push({ x: tr.x + Math.cos(a) * 16, y: tr.y + Math.sin(a) * 16,
                 vx: Math.cos(a) * 13, vy: Math.sin(a) * 13, life: 46, fromPlayer: false });
  spawnMuzzle(tr.x + Math.cos(a) * 16, tr.y + Math.sin(a) * 16, a);
  sfx.copShoot(hear(tr.x, tr.y, 760));
}
buildTurrets();                                       // posts derived from the base corners

