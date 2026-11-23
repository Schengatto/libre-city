// LIBRE CITY · js/gameplay.js — rules and physics: player on foot and driving, fists and
// gunfire, pedestrians and cops, traffic AI, collisions, bullets, damage/death,
// population management, camera and update().

// ---------- Hospital: paid healing at the entrance ----------
let healMsgCd = 0;
function updateHealPads() {
  if (healMsgCd > 0) healMsgCd--;
  if (player.car) return;
  for (const lm of landmarks) {
    if (lm.type !== 'hospital' || dist(player.x, player.y, lm.door.x, lm.door.y) >= 26) continue;
    if (player.health >= 100) return;
    if (cash >= 25) { cash -= 25; player.health = 100; updateHealth(); updateCash(); toast(t('heal.done')); sfx.coin(); }
    else if (healMsgCd === 0) { toast(t('heal.need')); healMsgCd = 150; }
    return;
  }
}

// ---------- Gun shop: buy weapons on the pad by the entrance ----------
// Walk up to the GUN SHOP pad and the price list appears — press a weapon's number to
// buy it (if you can afford it) or to equip one you already own.
function nearGunshop() {
  if (player.car) return null;
  for (const lm of landmarks)
    if (lm.type === 'gunshop' && dist(player.x, player.y, lm.door.x, lm.door.y) < 46) return lm;
  return null;
}
function weaponKey(i) {
  if (!started) return;
  if (peaceMode()) return;                            // violence filter: no weapons to buy or hold
  if (authClient()) { net.weaponReq = i; return; }   // equip/buy: the server does it
  const w = WEAPONS[i];
  if (player.owned[i]) {                              // already yours: just draw it
    if (player.weaponIdx !== i) { player.weaponIdx = i; updateWeapon(); toast(t('shop.equipped', { icon: w.icon, name: wName(w) })); sfx.door(); }
    return;
  }
  if (nearGunshop()) {
    if (cash >= w.price) {
      cash -= w.price; player.owned[i] = true; player.weaponIdx = i;
      updateCash(); updateWeapon();
      toast(t('shop.bought', { name: wName(w), price: w.price })); sfx.coin();
    } else { toast(t('shop.tooPoor', { name: wName(w), price: w.price })); sfx.err(); }
  } else { toast(t('shop.locked', { name: wName(w) })); sfx.err(); }
}

// ---------- Crimes & wanted level ----------
function commitCrime(amount, key) {
  const before = wanted;
  wantedHeat = clamp(wantedHeat + amount, 0, 5.99);
  crimeCd = 60 * 9;
  wanted = Math.floor(wantedHeat);
  updateStars();
  if (wanted > before) { toast(key ? t(key) : t('wanted.level', { n: wanted })); flashSiren(); }
}
function flashSiren() { shake(6, 8); }

// ---------- Player on foot ----------
function updatePlayerFoot() {
  unstick(player, player.r, player.r);                  // never stay wedged inside a wall
  const dx = (held('KeyD','ArrowRight') ? 1 : 0) - (held('KeyA','ArrowLeft') ? 1 : 0);
  const dy = (held('KeyS','ArrowDown')  ? 1 : 0) - (held('KeyW','ArrowUp')   ? 1 : 0);
  const sp = 2.6;
  let mvx = dx, mvy = dy;
  if (mvx && mvy) { mvx *= 0.707; mvy *= 0.707; }
  moveBox(player, mvx * sp, mvy * sp, player.r, player.r);
  player.moving = dx !== 0 || dy !== 0;
  if (player.moving) player.walk += 0.3; else player.walk = 0;
  // Aim towards the mouse.
  player.aim = Math.atan2(mouseWY() - player.y, mouseWX() - player.x);
  // Firing: automatic weapons fire while held, the rest one shot per click.
  if (player.shootCd > 0) player.shootCd--;
  if (player.punchT > 0) player.punchT--;
  const w = WEAPONS[player.weaponIdx];
  // On an authoritative client the server rules on shots (prediction with no local
  // bullets). With the violence filter on (single-player) the player does not attack at
  // all: no shots and no punches.
  if (!authClient() && !peaceMode() && (w.auto ? mDownL : mClicked) && player.shootCd === 0) { (w.melee ? playerPunch : playerShoot)(w); player.shootCd = w.cd; }
  mClicked = false;
}
function playerShoot(w) {
  if (w.rocket) { playerFireRocket(w); return; }      // the launcher fires an explosive rocket
  if (w.grenade) { playerThrowGrenade(w); return; }   // grenades throw a charge that explodes over an area
  for (let i = 0; i < (w.pellets || 1); i++) {        // the shotgun fires a spread of pellets
    const a = player.aim + rnd(-w.spread, w.spread);
    const bx = player.x + Math.cos(a) * 14, by = player.y + Math.sin(a) * 14;
    bullets.push({ x: bx, y: by, vx: Math.cos(a) * w.spd, vy: Math.sin(a) * w.spd,
                   life: w.life, fromPlayer: true, dmg: w.dmgCar, knock: w.knock, owner: player, pvp: w.pvp || 8, flame: w.fire });
  }
  spawnMuzzle(player.x + Math.cos(player.aim) * 14, player.y + Math.sin(player.aim) * 14, player.aim);
  shake(w.shake || 2, 3);
  (sfx[w.sfx] || sfx.shoot)();
  netShotFired(w);                                    // in multiplayer rivals see (and take) the shots
}
// The launcher's rocket: flies straight out from the player and bursts on first impact
// (updateRockets/explodeRocket). `owner` signs the shot for PvP points/bounties.
function playerFireRocket(w) {
  const a = player.aim;
  const bx = player.x + Math.cos(a) * 16, by = player.y + Math.sin(a) * 16;
  rockets.push({ x: bx, y: by, vx: Math.cos(a) * (w.spd || 7), vy: Math.sin(a) * (w.spd || 7),
                 life: w.life || 120, src: player.car || player, owner: player });
  spawnMuzzle(bx, by, a);
  shake(w.shake || 6, 6);
  (sfx[w.sfx] || sfx.rocket)();
  netRocketFired({ x: player.x, y: player.y, turretA: a });   // Phase 1: rivals see the rocket fly
}
// Grenades: a thrown charge that flies a short way then explodes over an area (fuse =
// w.life; it also bursts early on impact, like rockets). Reuses the rocket system with a
// reduced blast via `pw` (< 1). `owner` signs the shot for points/bounties.
function playerThrowGrenade(w) {
  const a = player.aim, spd = w.spd || 7.5, life = w.life || 26, pw = w.pw || 0.72;
  const bx = player.x + Math.cos(a) * 16, by = player.y + Math.sin(a) * 16;
  rockets.push({ x: bx, y: by, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
                 life, pw, grenade: true, src: player.car || player, owner: player });
  shake(w.shake || 4, 5);
  (sfx[w.sfx] || sfx.whoosh)();
  netRocketFired({ x: player.x, y: player.y, turretA: a, spd, life, pw, grenade: true });
}

// ---------- Fists: close-quarters attack — the third punch floors a pedestrian ----------
const PUNCH_KILL = 3;
function playerPunch(w) {
  player.punchT = 10;                                 // triggers the arm animation
  netPunched();                                       // in multiplayer rivals can be hit too
  // PvP (authoritative server): a punch inside the cone floors another player on foot.
  if (MP) { const puncher = player;
    for (const v of MP) {
      if (v === puncher || v.downT > 0 || v.car) continue;
      if (dist(puncher.x, puncher.y, v.x, v.y) < w.range &&
          Math.abs(angDiff(puncher.aim, Math.atan2(v.y - puncher.y, v.x - puncher.x))) < 1.0) {
        const wasDown = v.downT > 0, vb = v.bounty | 0;
        asPlayer(v, () => hurtPlayer(12, puncher.aim));
        if (!wasDown && v.downT > 0) creditKill(puncher, v, vb);
        return;
      }
    }
  }
  // Hits the nearest pedestrian in the cone in front of the player.
  let best = null, bd = w.range;
  for (const p of peds) {
    if (p.ko || p.dead) continue;
    const d = dist(player.x, player.y, p.x, p.y);
    if (d < bd && Math.abs(angDiff(player.aim, Math.atan2(p.y - player.y, p.x - player.x))) < 1.0) { bd = d; best = p; }
  }
  if (best) { punchPed(best, w); return; }
  // Nobody in range: the punch can still dent a car within reach.
  const fx = player.x + Math.cos(player.aim) * 18, fy = player.y + Math.sin(player.aim) * 18;
  for (const c of cars) {
    if (Math.abs(fx - c.x) < c.w / 2 + 4 && Math.abs(fy - c.y) < c.h / 2 + 6) {
      damageCar(c, w.dmgCar, player.aim); spawnSparks(fx, fy, 2); sfx.clank(hear(fx, fy, 700));
      return;
    }
  }
  sfx.whoosh();                                       // swing and a miss
}
function punchPed(p, w) {
  p.punches = (p.punches || 0) + 1;
  spawnBlood(p.x, p.y);
  sfx.punch();
  if (p.punches >= PUNCH_KILL) {                      // third punch: floored
    knockPed(p, player.aim, w.knock);
    addScore(pedScore(p), p.x, p.y);
    if (p.role === 'cop') commitCrime(1.2, 'crime.punchCop');
    else if (p.role === 'soldier') armyAlertT = ARMY_ALERT_T;
    else if (p.role !== 'robber') { cash += 3; commitCrime(0.6, 'crime.punchPed'); }
    return;
  }
  // Hurt but still standing: staggers away in a panic.
  const a = Math.atan2(p.y - player.y, p.x - player.x);
  p.dir = { x: Math.cos(a), y: Math.sin(a) };
  p.speed = 2.4; p.panic = 60; p.thinkCd = 20;
  pedSay(p, SAY_PANIC, '#c22822', true);
  if (p.role === 'cop') commitCrime(0.6, 'crime.hitCop');
  else if (p.role === 'soldier') armyAlertT = ARMY_ALERT_T;
}

// ---------- Driving ----------
// Gear ratios: how fast gear g pulls to (first is short, the top gears long).
function gearTop(c, g) { return c.top * Math.pow(g / (c.gears || 4), 1.15); }
function updateDrive(c) {
  unstick(c, c.colH, c.colH);                           // never stay wedged inside a wall
  let up = held('KeyW','ArrowUp'), down = held('KeyS','ArrowDown');
  let steer = (held('KeyD','ArrowRight') ? 1 : 0) - (held('KeyA','ArrowLeft') ? 1 : 0);
  if (touchDrive.active) {
    // Screen-relative driving: the nose chases the stick's direction; a stick pointing
    // almost opposite the nose means brake, then reverse.
    const d = angDiff(c.angle, touchDrive.angle);
    if (Math.abs(d) > 2.5) {
      up = false; down = true;
      // In reverse, steer so that the TAIL goes towards the stick.
      steer = c.speed < -0.25 ? clamp(-angDiff(c.angle + Math.PI, touchDrive.angle) / 0.3, -1, 1) : 0;
    } else {
      up = true; down = false;
      steer = clamp(d / 0.3, -1, 1);
    }
  }
  // Pickup and top speed depend on the vehicle (mass, engine) — and on the gear: pull is
  // full at the bottom of a gear, fades towards the redline, and on an upshift the clutch
  // disengages for a moment (heavy vehicles shift more slowly).
  if (!c.gear) { c.gear = 1; c.shiftT = 0; }
  const spd = Math.abs(c.speed);
  while (c.gear > 1 && spd < gearTop(c, c.gear - 1) * 0.82) c.gear--;   // downshift
  const lo = c.gear > 1 ? gearTop(c, c.gear - 1) : 0;
  const rpm = clamp((spd - lo) / (gearTop(c, c.gear) - lo), 0, 1);      // revs within the gear
  if (c.shiftT > 0) c.shiftT--;
  else if (up && c.speed >= 0 && rpm >= 0.97 && c.gear < (c.gears || 4)) {
    c.gear++; c.shiftT = Math.round(7 + c.mass * 4);                    // upshift
  }
  const pull = c.shiftT > 0 ? 0 : (1.45 - 0.8 * rpm) * (1 - 0.07 * (c.gear - 1));
  if (up) c.speed += c.accel * (c.speed >= 0 ? pull : 1);   // in reverse the brake stays full
  else if (down) c.speed -= c.accel * 0.9;
  else c.speed *= 0.96;
  c.speed = clamp(c.speed, -c.top * 0.45, c.top);
  if (Math.abs(c.speed) > 0.25)
    c.angle += steer * (c.isBike ? 0.075 : c.isTank ? 0.045 : 0.06) * Math.sign(c.speed) * clamp(Math.abs(c.speed) / 3, 0.45, 1);
  moveBox(c, Math.cos(c.angle) * c.speed, Math.sin(c.angle) * c.speed, c.colH, c.colH);
  if ((c.hitX || c.hitY) && Math.abs(c.speed) > 2.6) { crashCar(c); c.speed *= 0.28; }
  applyKnockback(c);                                    // residual bounce from collisions
  // Authoritative effects (running people over, hydrant, gun/tracks): on an authoritative
  // client the server handles them — here we only predict the vehicle's MOTION.
  if (!authClient()) {
    runOver(c, true);
    // Multiplayer: a rival on foot goes under the wheels too. Only the authority decides
    // this — locally MP is null and the only "player" is the driver, who is skipped.
    if (MP) runOverPlayer(c, false, player);
    if (c.livery === 'fire' && mDownL) sprayWater(c);   // fire engine: hydrant on the mouse
    if (c.isTank) { updateTankGun(c); tankCrush(c); }   // tank: turret + tracks
  }
  // The player rides along with the car.
  player.x = c.x; player.y = c.y;
  // Engine audio: revs climb within a gear and drop on the shift.
  const rev = c.shiftT > 0 ? 0.1 : (Math.abs(c.speed) < 0.15 && !up ? 0 : rpm);
  engineGain(0.03 + Math.abs(c.speed) * 0.002 + rev * 0.03,
             52 + rev * (c.isBike ? 175 : 125) + Math.abs(c.speed) * 5);
}
function crashCar(c) {
  spawnSparks(c.x + Math.cos(c.angle) * 22, c.y + Math.sin(c.angle) * 22, 6);
  shake(4, 5); sfx.crash();
}

// Runs down pedestrians in front of the car (oriented-box test).
function runOver(c, byPlayer) {
  const sp = Math.abs(c.speed);
  if (sp < 1.6) return;
  const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
  for (const p of peds) {
    if (p.ko) continue;
    const dx = p.x - c.x, dy = p.y - c.y;
    const lx = dx * ca + dy * sa;         // fore/aft in the car's frame
    const ly = -dx * sa + dy * ca;        // lateral
    if (Math.abs(lx) < c.w / 2 + p.r && Math.abs(ly) < c.h / 2 + p.r) {
      if (peaceMode()) { shovePed(p, c.angle); continue; }   // violence filter: nobody is run down, the pedestrian leaps clear unhurt
      knockPed(p, c.angle, sp);
      if (byPlayer && p.role !== 'robber') {          // stopping the thief is not a crime
        // The hit-and-run belongs to whoever is driving: cash/score/stars go to the
        // driver, not the global player (runOver runs in the shared world phase).
        asPlayer(MP ? c.owner : player, () => {
          cash += 5;
          addScore(pedScore(p), p.x, p.y);
          commitCrime(p.role === 'cop' ? 1.1 : 0.7,
            p.role === 'cop' ? 'crime.runCop' : 'crime.runPed');
        });
      }
    }
  }
}

// ---------- Pedestrians ----------
// Violence filter: instead of being run over, the pedestrian leaps aside in a panic and
// is unharmed (no knockout, no blood, no death).
function shovePed(p, angle) {
  if (p.ko || p.dead) return;
  const side = angle + (Math.random() < 0.5 ? Math.PI / 2 : -Math.PI / 2);
  p.dir = { x: Math.cos(side), y: Math.sin(side) };
  p.speed = 2.6; p.panic = 60; p.thinkCd = 20;
  pedSay(p, SAY_PANIC, '#c22822', true);
  sfx.scream(hear(p.x, p.y, 800));
}
function knockPed(p, angle, force) {
  p.ko = true; p.koT = 60 * 7;
  p.getsUp = false; p.angryT = 0;                   // a real hit is unforgiving: no getting up
  p.sayT = 0;                                       // no small talk on the ground
  p.kx = Math.cos(angle) * clamp(force, 2, 8);
  p.ky = Math.sin(angle) * clamp(force, 2, 8);
  p.spin = rnd(-0.4, 0.4);
  spawnBlood(p.x, p.y);
  decals.push({ x: p.x, y: p.y, r: rnd(9, 15), life: 60 * 20 });
  if (decals.length > 70) decals.shift();
  // Sometimes they drop cash.
  if (Math.random() < 0.6) pickups.push({ x: p.x + rnd(-6, 6), y: p.y + rnd(-6, 6), v: rndi(10, 60), life: 60 * 22, t: 0 });
  sfx.scream(hear(p.x, p.y, 800));
  sfx.thud();
}
// ---------- Pedestrian chatter: contextual speech bubbles overhead ----------
// The phrases live in js/i18n.js: only the list KEYS stay here.
const SAY_GREET   = 'say.greet';
const SAY_WANTED  = 'say.wanted';
const SAY_PANIC   = 'say.panic';
const SAY_COP     = 'say.cop';
const SAY_FARE    = 'say.fare';
const SAY_HUNGRY  = 'say.hungry';
const SAY_INJURED = 'say.injured';
const SAY_ROBBER  = 'say.robber';
const SAY_CARJACK = 'say.carjack';
// Makes a pedestrian say a line; the cooldown stops them chattering nonstop.
// `key` is the key of a phrase list (tList) — see js/i18n.js.
function pedSay(p, key, col, force) {
  if (!force && p.sayCd > 0) return;
  p.say = pick(tList(key)).split('{name}').join(playerName || t('pvp.rival')); p.sayCol = col || '#20242e';
  p.sayT = 110; p.sayCd = rndi(300, 600);
}
// When calm, pedestrians prefer pavements, lawns and alleys over the asphalt. Picks a
// direction that avoids the road where possible, without walking into walls.
function calmWalkDir(p) {
  const soft = [], road = [];
  for (const d of DIRS) {
    const t = tileAt(Math.floor((p.x + d.x * T) / T), Math.floor((p.y + d.y * T) / T));
    if (t === BUILDING || t === TREE || t === WATER) continue;   // wall: discard
    (t === ROAD ? road : soft).push(d);
  }
  // Occasionally cross the road anyway, otherwise stay on the pavement.
  if (soft.length && !(road.length && Math.random() < 0.12)) return pick(soft);
  if (road.length) return pick(road);
  return pick(DIRS);
}
// Direction towards the nearest pavement (to get off the carriageway).
function offRoadDir(wx, wy) {
  const cx = Math.floor(wx / T), cy = Math.floor(wy / T);
  let best = null, bestK = 99;
  for (const d of DIRS) {
    for (let k = 1; k <= 5; k++) {
      const t = tileAt(cx + d.x * k, cy + d.y * k);
      if (t === BUILDING || t === TREE || t === WATER) break;    // direction blocked
      if (t === SIDEWALK || t === GRASS || t === ALLEY) { if (k < bestK) { bestK = k; best = d; } break; }
    }
  }
  return best;
}
function updatePed(p) {
  if (p.sayT > 0) p.sayT--;
  if (p.sayCd > 0) p.sayCd--;
  if (p.ko) {
    p.koT--;
    moveBox(p, p.kx || 0, p.ky || 0, p.r, p.r);   // slides along the ground, but walls stop them
    if (p.hitX) p.kx *= -0.35;
    if (p.hitY) p.ky *= -0.35;
    p.kx *= 0.86; p.ky *= 0.86;
    p.spin *= 0.96;
    if (p.koT <= 0) {
      if (p.getsUp) {                               // the carjacked driver gets up furious
        p.ko = false; p.getsUp = false; p.panic = 0;
        p.angryT = 60 * 6;
        pedSay(p, p.copDress ? 'say.stolenPolice' : p.stolenBike ? 'say.stolenBike' : 'say.stolenCar', '#c22822', true);
        sfx.yell(hear(p.x, p.y, 700));
      } else p.dead = true;
    }
    return;
  }
  if (p.angryT > 0) { updateAngryDriver(p); return; }
  if (p.role === 'fare' || p.role === 'hungry') {   // customer (taxi or pizza): waits on the pavement
    p.walk = 0; p.speed = 0;
    p.facing = Math.atan2(player.y - p.y, player.x - p.x);
    // When they see you coming they call out, each for their own service.
    if (dist(p.x, p.y, player.x, player.y) < 220 && Math.random() < 0.02)
      pedSay(p, p.role === 'fare' ? SAY_FARE : SAY_HUNGRY, p.role === 'fare' ? '#8a6410' : '#b04a1e');
    return;
  }
  if (p.role === 'injured') {                       // casualty: stays down and calls for help
    p.walk = 0; p.speed = 0;
    if (Math.random() < 0.012) pedSay(p, SAY_INJURED, '#c22822');
    return;
  }
  if (p.role === 'robber') { updateRobber(p); return; }
  if (p.role === 'cop') { updateCop(p); return; }
  if (p.role === 'soldier') { updateSoldier(p); return; }
  // Civilian: strolls the pavements; flees fast cars and — while panicking — veers into
  // the road.
  const threat = nearestThreatCar(p.x, p.y, 150);
  if (threat) { if (p.panic === 0) { sfx.yell(hear(p.x, p.y, 700)); pedSay(p, SAY_PANIC, '#c22822', true); } const a = Math.atan2(p.y - threat.y, p.x - threat.x); p.dir = { x: Math.cos(a), y: Math.sin(a) }; p.speed = 2.4; p.panic = 40; p.thinkCd = 20; }
  else if (p.panic > 0) { p.panic--; p.speed = 2.0; }   // still scared: runs anywhere, asphalt included
  else {
    // If a calm pedestrian has ended up in the road, head back to the pavement.
    if (tileTypeAt(p.x, p.y) === ROAD) {
      const back = toNearestSidewalk(p.x, p.y);
      if (back) { p.dir = back; p.speed = 1.3; p.thinkCd = rndi(20, 40); }
    }
    p.thinkCd--;
    if (p.thinkCd <= 0) {
      if (Math.random() < 0.18) { p.dir = { x: 0, y: 0 }; p.speed = 0; }
      else { p.dir = pickWalkDir(p); p.speed = rnd(0.8, 1.5); }
      if (Math.random() < 0.15) sfx.chat(hear(p.x, p.y, 420));   // chatter from nearby passers-by
      p.thinkCd = rndi(40, 150);
    }
    // They comment as the player walks past: a greeting, or alarm if they are wanted.
    if (dist(p.x, p.y, player.x, player.y) < 90 && Math.random() < 0.02)
      pedSay(p, wanted > 0 ? SAY_WANTED : SAY_GREET, wanted > 0 ? '#c22822' : '#20242e');
  }
  moveBox(p, p.dir.x * p.speed, p.dir.y * p.speed, p.r, p.r);
  if (p.hitX) p.dir.x *= -1;
  if (p.hitY) p.dir.y *= -1;
  const mv = Math.abs(p.dir.x) + Math.abs(p.dir.y);
  if (mv > 0.01 && p.speed > 0.1) { p.walk += 0.25; p.facing = Math.atan2(p.dir.y, p.dir.x); } else p.walk = 0;
}
// The robbed driver, just back on their feet: chases the player (or their former
// vehicle) shouting, then cools off and strolls on as if nothing had happened.
function updateAngryDriver(p) {
  p.angryT--;
  const tp = nearestPlayer(p.x, p.y);
  const tx = tp.car ? tp.car.x : tp.x;
  const ty = tp.car ? tp.car.y : tp.y;
  const d = dist(p.x, p.y, tx, ty);
  if (p.angryT <= 0 || d > 620) { p.angryT = 0; p.speed = 0; p.thinkCd = 0; return; }   // gives up
  const a = Math.atan2(ty - p.y, tx - p.x);
  p.facing = a;
  if (d > 40) {
    p.dir = { x: Math.cos(a), y: Math.sin(a) }; p.speed = 2.1;
    moveBox(p, p.dir.x * p.speed, p.dir.y * p.speed, p.r, p.r);
    p.walk += 0.3;
  } else { p.speed = 0; p.walk += 0.45; }           // right on top of you: stamping with rage
  if (p.sayT === 0 && Math.random() < 0.03) pedSay(p, SAY_CARJACK, '#c22822', true);
}
function nearestThreatCar(x, y, range) {
  let best = null, bestDistSq = range * range;
  for (const c of cars) {
    if (Math.abs(c.speed) < 3) continue;
    const dx = c.x - x;
    if (dx >= range || dx <= -range) continue;
    const dy = c.y - y;
    if (dy >= range || dy <= -range) continue;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) { bestDistSq = distSq; best = c; }
  }
  return best;
}

// ---------- Fleeing robber ----------
// Always runs away from the player, zigzagging a little and bouncing off walls: catch up
// in a patrol car and stop them.
function updateRobber(p) {
  p.thinkCd--;
  if (p.thinkCd <= 0) {
    const tp = nearestPlayer(p.x, p.y);
    const away = Math.atan2(p.y - tp.y, p.x - tp.x) + rnd(-0.7, 0.7);
    p.dir = { x: Math.cos(away), y: Math.sin(away) };
    p.thinkCd = rndi(18, 42);
  }
  p.speed = 2.15;
  moveBox(p, p.dir.x * p.speed, p.dir.y * p.speed, p.r, p.r);
  if (p.hitX) { p.dir.x *= -1; p.thinkCd = Math.min(p.thinkCd, 10); }
  if (p.hitY) { p.dir.y *= -1; p.thinkCd = Math.min(p.thinkCd, 10); }
  p.walk += 0.3; p.facing = Math.atan2(p.dir.y, p.dir.x);
  // Now and then they taunt you as they run.
  if (Math.random() < 0.006) pedSay(p, SAY_ROBBER, '#c22822');
}

// ---------- Cop on foot ----------
const COP_RANGE = 330;
function updateCop(p) {
  const tp = nearestWantedPlayer(p.x, p.y);      // hunts the nearest wanted player
  const tx = tp.x - p.x, ty = tp.y - p.y, d = Math.hypot(tx, ty) || 1;
  p.dir = { x: tx / d, y: ty / d }; p.speed = 2.0;
  p.facing = Math.atan2(ty, tx);
  if (frame % 120 === 0 && Math.random() < 0.5) sfx.whistle(hear(p.x, p.y, 900));   // chase whistle
  if (d < 420 && Math.random() < 0.02) pedSay(p, SAY_COP, '#20407a');   // shouts at you to halt mid-chase

  // Player in a (nearly) stopped car: the officer runs to the door, opens it and arrests them.
  const canBust = tp.car && Math.abs(tp.car.speed) < 1.0;
  if (canBust && d < 42) {
    sfx.door();                                   // opens the door...
    asPlayer(tp, arrestPlayer);                   // ...and takes THAT player to the station
    return;
  }
  // Stops a little closer to shoot (but for an arrest goes all the way to the door).
  const advance = (d > 90 || canBust) ? p.speed : 0.3;
  moveBox(p, p.dir.x * advance, p.dir.y * advance, p.r, p.r);
  p.walk += advance > 0.5 ? 0.25 : 0;
  if (p.shootCd > 0) p.shootCd--;
  if (d < COP_RANGE && p.shootCd === 0 && lineClear(p.x, p.y, tp.x, tp.y)) {
    copShoot(p, tp); p.shootCd = rndi(42, 66);
  }
}
function copShoot(p, tp) {
  if (peaceMode()) return;                          // violence filter: police do not shoot (they arrest in person)
  tp = tp || nearestPlayer(p.x, p.y);
  const a = Math.atan2(tp.y - p.y, tp.x - p.x) + rnd(-0.13, 0.13);
  const bx = p.x + Math.cos(a) * 12, by = p.y + Math.sin(a) * 12;
  bullets.push({ x: bx, y: by, vx: Math.cos(a) * 11, vy: Math.sin(a) * 11, life: 60, fromPlayer: false });
  spawnMuzzle(bx, by, a);
  sfx.copShoot(hear(p.x, p.y, 700));
}
// Line of fire clear of buildings (sampled).
function lineClear(x0, y0, x1, y1) {
  const steps = Math.ceil(dist(x0, y0, x1, y1) / T);
  for (let i = 1; i < steps; i++) {
    const t = i / steps, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    if (solidTile(Math.floor(x / T), Math.floor(y / T))) return false;
  }
  return true;
}

// ---------- Vehicle geometry (shared by AI and collisions) ----------
// Gap an AI car leaves between its own nose and the bumper ahead when queuing at a
// standstill (while moving the distance grows with speed).
const SAFE_GAP = 16;

// Every vehicle is ITS OWN oriented w×h box, the same one render.js draws. carProj = the
// box's half-extent along a unit axis (u): used both to measure gaps (where the bumper
// ends) and for the collision test.
function carProj(c, ux, uy) {
  const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
  return (c.w || 46) / 2 * Math.abs(ux * ca + uy * sa)
       + (c.h || 24) / 2 * Math.abs(uy * ca - ux * sa);
}

// ---------- Vehicle AI ----------
// Free space ahead of the vehicle, measured BUMPER to bumper (not centre to centre): the
// safe distance is then the same for a hatchback and for a lorry, and nobody ends up
// glued to the vehicle in front.
// With `push` set the driver has run out of patience: they ignore anyone stopped across
// their path (see the stall-breaker in updateCar) and try to get around them.
function gapAhead(c, maxLook, push) {
  let gap = maxLook;
  const ax = c.dir.x, ay = c.dir.y;
  const myFront = carProj(c, ax, ay);                  // from my centre to my nose
  const myHalfW = carProj(c, -ay, ax);                 // half width
  for (const o of cars) {
    if (o === c || o.role === 'parked') continue;
    if (push && Math.abs(o.speed) < 0.2 &&
        c.dir.x * o.dir.x + c.dir.y * o.dir.y < 0.3) continue;   // stopped across my path: go around
    const dx = o.x - c.x, dy = o.y - c.y;
    const along = dx * ax + dy * ay;                   // ahead (>0)
    if (along <= 0) continue;                          // it is behind me
    const otherMaxReach = ((o.w || 46) + (o.h || 24)) / 2;
    if (along - myFront - otherMaxReach >= gap) continue;
    const side = -dx * ay + dy * ax;                   // lateral
    if (Math.abs(side) > myHalfW + otherMaxReach + 4) continue;
    // The other vehicle's extent on MY axes (it may be rotated relative to me).
    if (Math.abs(side) > myHalfW + carProj(o, -ay, ax) + 4) continue;   // not in my path
    const g = along - myFront - carProj(o, ax, ay);    // empty space between the two bumpers
    if (g < gap) gap = g;
  }
  return Math.max(0, gap);
}
// Distance to the stop line if the junction's light is red (Infinity if clear).
function signalStop(c) {
  const e = edges[c.edge];
  const node = c.ed > 0 ? nodes[e.b] : nodes[e.a];
  if (!node.signal) return Infinity;                   // junction with no traffic light
  const horiz = Math.abs(c.dir.x) >= Math.abs(c.dir.y);
  if (horiz ? greenH : greenV) return Infinity;        // green on my axis
  const distToNode = (c.ed > 0 ? (1 - c.t) : c.t) * e.len;
  const gap = distToNode - HALF_ROAD * 1.1;            // stop short of the junction
  return gap > 0 ? gap : Infinity;                     // if already inside, carry on and clear it
}
// Arriving at a junction → pick the next edge (mostly carries straight on).
function enterNode(c, nodeIdx) {
  const node = nodes[nodeIdx], inDir = c.dir, outs = [];
  for (const ei of node.edges) {
    if (edges[ei].dead) continue;                           // suppressed road: cannot be taken
    if (ei === c.edge && node.edges.length > 1) continue;   // avoid a U-turn if there are alternatives
    const e = edges[ei], startsHere = e.a === nodeIdx, ed = startsHere ? 1 : -1;
    const tan = edgeTangent(e, startsHere ? 0 : 1);
    const align = (tan.x * ed) * inDir.x + (tan.y * ed) * inDir.y;   // 1 = straight on
    outs.push({ ei, ed, align });
  }
  let ch;
  if (!outs.length) ch = { ei: c.edge, ed: -c.ed };          // dead end → U-turn
  else { outs.sort((p, q) => q.align - p.align); ch = Math.random() < 0.6 ? outs[0] : pick(outs); }
  c.edge = ch.ei; c.ed = ch.ed; c.t = ch.ed > 0 ? 0 : 1;
  railPlace(c);
}
// The node a railed vehicle is heading for, plus the distance still to cover.
function carTargetNode(c) {
  const e = edges[c.edge];
  return { ni: c.ed > 0 ? e.b : e.a,
           d:  (c.ed > 0 ? (1 - c.t) : c.t) * e.len };
}
// ---- Right of way at junctions: two AI cars never enter the same junction together.
// `c` yields (braking before the line) if another car is already crossing the junction or
// will get there first. Priority is a total order: whoever is nearer the node goes; on a
// tie, the lower id. Because it is a total order, in every conflict exactly one of the two
// yields → no collisions and no stalls (no circular deadlock at 4-way junctions).
function crossingYield(c, ni, myDist) {
  const node = nodes[ni];
  const WATCH = HALF_ROAD * 3.4;                      // start "watching" the junction from here
  const BOX   = HALF_ROAD * 1.3;                      // radius of the junction box proper
  const stopGap = myDist - HALF_ROAD * 1.15;          // where to stop (short of the box)
  if (stopGap <= 0 || myDist > WATCH) return Infinity; // already committed in the box, or still far off
  const brake = clamp((stopGap - 6) * 0.06, 0, c.maxSpeed);
  for (const o of cars) {
    if (o === c || o.role !== 'traffic') continue;    // only yields to other AI cars
    if (o.edge === c.edge) continue;                  // same street: gapAhead / the lanes handle it
    const od = dist(o.x, o.y, node.x, node.y);
    if (od > WATCH) continue;                         // not at this junction
    if (c.dir.x * o.dir.x + c.dir.y * o.dir.y < -0.5) continue; // oncoming: keeps its own lane, no conflict
    if (od < BOX) return brake;                       // already occupying the junction → yield
    const ot = carTargetNode(o);                      // heading for the same junction?
    if (ot.ni !== ni) continue;
    if (ot.d < myDist - 4 || (Math.abs(ot.d - myDist) <= 4 && o.id < c.id)) return brake; // gets there first → yield
  }
  return Infinity;
}
function updateCar(c) {
  if (c.driver === 'player') return;
  if (c.role === 'parked') { c.speed *= 0.8; applyKnockback(c); return; }   // rear-ended: slides away
  if (c.role === 'police') { updatePoliceCar(c); return; }
  if (c.role === 'armycar') { updateArmyCar(c); return; }
  // ---- Railed traffic: follows the road through bends, driving sensibly ----
  const e = edges[c.edge];
  let cap = c.maxSpeed;
  // Slow into bends (like a real driver): look at how much the road turns just ahead.
  const tA = edgeTangent(e, c.t), tB = edgeTangent(e, clamp(c.t + c.ed * 0.06, 0, 1));
  const turn = Math.abs(angDiff(Math.atan2(tA.y, tA.x), Math.atan2(tB.y, tB.x)));
  cap = Math.min(cap, c.maxSpeed * (1 - clamp(turn * 1.6, 0, 0.6)));
  // Red light.
  const sg = signalStop(c);
  if (sg !== Infinity) cap = Math.min(cap, clamp((sg - 24) * 0.05, 0, c.maxSpeed));
  // Car ahead: keeps a safe bumper-to-bumper distance — at a standstill a SAFE_GAP
  // margin remains, and while moving it grows with speed (at equilibrium
  // gap ≈ SAFE_GAP + speed / 0.16, i.e. ~32px at cruising speed).
  const gap = gapAhead(c, T * 5, c.pushT > 0);
  cap = Math.min(cap, clamp((gap - SAFE_GAP) * 0.16, 0, c.maxSpeed));
  // Unsignalled junction → slow down and take a look.
  const nodeAheadIdx = c.ed > 0 ? e.b : e.a;
  const nodeAhead = nodes[nodeAheadIdx];
  const distNode = (c.ed > 0 ? (1 - c.t) : c.t) * e.len;
  if (!nodeAhead.signal && distNode < HALF_ROAD * 1.6) cap = Math.min(cap, c.maxSpeed * 0.5);
  // Give way to traffic crossing the junction (no collisions between AI cars).
  const yg = crossingYield(c, nodeAheadIdx, distNode);
  if (yg !== Infinity) cap = Math.min(cap, yg);
  // Level crossing: traffic stops for the train (patrol cars mid-chase do not —
  // updatePoliceCar does not come through here; the army carries on too).
  if (trainBlocking(c)) cap = 0;
  // Stall-breaker: while squeezing past someone stopped, crawl along.
  if (c.pushT > 0) { c.pushT--; cap = Math.min(cap, 1.0); }
  // Smooth acceleration/braking (pickup depends on the vehicle).
  c.speed += clamp(cap - c.speed, -0.6, c.accel * 1.4);
  if (c.speed < 0) c.speed = 0;
  // Horn: blocked by someone (not by the lights) → after a while, a protest.
  if (gap < T * 1.6 && c.speed < 0.7 && sg === Infinity) {
    c.stuckT = (c.stuckT || 0) + 1;
    if (c.stuckT > 70 && Math.random() < 0.03) sfx.horn(hear(c.x, c.y, 850), c);
    // Long stall: two cars endlessly yielding to each other at a junction, or a player's
    // car parked across the road. The driver runs out of patience and squeezes past for a
    // while (without this, yielding to a yielder would stay stuck forever).
    if (c.stuckT > 150) { c.pushT = 90; c.stuckT = 0; }
  } else c.stuckT = 0;
  // Advance along the edge.
  c.t += c.ed * (c.speed / Math.max(1, e.len));
  if (c.ed > 0 && c.t >= 1) enterNode(c, e.b);
  else if (c.ed < 0 && c.t <= 0) enterNode(c, e.a);
  else railPlace(c);
  // Hit: it swerves out of lane (kox/koy) then eases back in, because railPlace pulls it
  // back onto the carriageway as the shove dies away.
  if (c.kvx || c.kvy || c.kox || c.koy) {
    c.kox = (c.kox + c.kvx) * 0.9; c.koy = (c.koy + c.kvy) * 0.9;
    c.kvx *= 0.85; c.kvy *= 0.85;
    if (Math.abs(c.kvx) < 0.05) c.kvx = 0;
    if (Math.abs(c.kvy) < 0.05) c.kvy = 0;
    if (Math.abs(c.kox) < 0.05) c.kox = 0;
    if (Math.abs(c.koy) < 0.05) c.koy = 0;
    const rx = c.x, ry = c.y;                 // in-lane position (railPlace)
    moveBox(c, c.kox, c.koy, c.colH, c.colH);
    c.kox = c.x - rx; c.koy = c.y - ry;       // the offset stops where the car stopped
  }
  runOverPlayer(c, false);                              // traffic can hit a player on foot
  runOver(c, false);
}
function updatePoliceCar(c) {
  c.lightPhase += 0.2;
  const tp = nearestWantedPlayer(c.x, c.y);
  const target = Math.atan2(tp.y - c.y, tp.x - c.x);
  c.angle = steerToward(c.angle, target, 0.07);
  const d = dist(c.x, c.y, tp.x, tp.y);
  // Target in reach (on foot, or stopped in a car): the patrol car pulls over and the
  // officer gets out on foot to shoot or to come and arrest you.
  const playerStopped = !tp.car || Math.abs(tp.car.speed) < 1.2;
  if (d < 150 && playerStopped && wanted > 0) { copStepsOut(c); return; }
  c.speed = d > 90 ? c.maxSpeed : c.maxSpeed * 0.4;
  moveBox(c, Math.cos(c.angle) * c.speed, Math.sin(c.angle) * c.speed, c.colH, c.colH);
  if (c.hitX || c.hitY) c.angle += rnd(-0.7, 0.7);
  applyKnockback(c);                                    // residual bounce from collisions
  c.dir = { x: Math.cos(c.angle), y: Math.sin(c.angle) };
  runOverPlayer(c, true);                               // the patrol car can run down (and kill) a player on foot
  runOver(c, false);
}
// The officer gets out of the patrol car: the car stays put, they continue on foot (from
// then on they shoot via updateCop and, if you are in a car, open your door).
function copStepsOut(c) {
  const nx = Math.cos(c.angle + Math.PI / 2), ny = Math.sin(c.angle + Math.PI / 2);
  let ex = c.x + nx * (c.h / 2 + 14), ey = c.y + ny * (c.h / 2 + 14);
  if (boxHits(ex, ey, 7, 7)) { ex = c.x - nx * (c.h / 2 + 14); ey = c.y - ny * (c.h / 2 + 14); }
  if (boxHits(ex, ey, 7, 7)) { ex = c.x; ey = c.y; }
  const p = makePed(ex, ey, 'cop');
  p.shootCd = rndi(30, 55);                       // a moment to take aim
  peds.push(p);
  pedSay(p, SAY_COP, '#20407a', true);
  c.role = 'parked'; c.wasPolice = true; c.speed = 0;   // the patrol car stays pulled over
  sfx.door();
}
// Running down a player on foot (the car's oriented box); strong=patrol car → lethal.
// `by` (authoritative server) = the RIVAL at the wheel: they are never their own victim,
// the hit is PvP-weighted and any kill is credited to them.
function runOverPlayer(c, strong, by) {
  const sp = Math.abs(c.speed);
  if (sp < (by ? 2.2 : strong ? 2.4 : 3)) return;
  const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
  eachActivePlayer(v => {
    if (v === by || v.car || v.downT > 0) return;       // the driver, in a car, or already down: not run over on foot
    const dx = v.x - c.x, dy = v.y - c.y;
    const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca;
    if (Math.abs(lx) >= c.w / 2 + v.r || Math.abs(ly) >= c.h / 2 + v.r) return;
    const vb = v.bounty | 0;                            // captured BEFORE the hit (startDown clears it)
    asPlayer(v, () => {
      // A rival at the wheel: the same damage as Phase 1 (netTick), so being run over hurts
      // the same in both multiplayer modes.
      if (by) hurtPlayer(12 + sp * 2.5, c.angle);
      else if (strong) {
        hurtPlayer(18 + sp * 3, c.angle);               // can take health all the way to 0
        moveBox(player, ca * sp * 1.4, sa * sp * 1.4, player.r, player.r);
        shake(6, 7);
      } else hurtPlayer(6, c.angle);                    // a knock from traffic: less serious
    });
    if (by && v.downT > 0) creditKill(by, v, vb);
  });
}

// ---------- Car ↔ car collisions ----------
// Every vehicle is its own oriented w×h box (the same silhouette that gets drawn) rather
// than two circles: circles are too fat at the flanks and too round at the nose, so the
// impact used to trigger inside the car's artwork. Here contact is exactly on the edge,
// via the separating axis theorem (SAT).
// Returns null if they do not touch, otherwise the minimum separation: normal (nx, ny)
// pointing from a towards b, penetration `pen`, and the contact point on the edge.
function carHit(a, b) {
  const ca = Math.cos(a.angle), sa = Math.sin(a.angle);
  const cb = Math.cos(b.angle), sb = Math.sin(b.angle);
  const ahw = (a.w || 46) / 2, ahh = (a.h || 24) / 2;
  const bhw = (b.w || 46) / 2, bhh = (b.h || 24) / 2;
  const dx = b.x - a.x, dy = b.y - a.y;
  // 4 candidate axes: the sides of the two boxes (in 2D these are enough).
  const axes = [ca, sa, -sa, ca, cb, sb, -sb, cb];
  let pen = Infinity, nx = 0, ny = 0, reachA = 0;
  for (let k = 0; k < 8; k += 2) {
    const ux = axes[k], uy = axes[k + 1];
    const pa = ahw * Math.abs(ux * ca + uy * sa) + ahh * Math.abs(uy * ca - ux * sa);
    const pb = bhw * Math.abs(ux * cb + uy * sb) + bhh * Math.abs(uy * cb - ux * sb);
    const d = dx * ux + dy * uy;
    const p = pa + pb - Math.abs(d);
    if (p <= 0) return null;                            // separating axis found → no contact
    if (p < pen) { pen = p; reachA = pa; const s = d < 0 ? -1 : 1; nx = ux * s; ny = uy * s; }
  }
  // Impact point on the bodywork (for sparks and shake), not between the centres.
  return { pen, nx, ny, px: a.x + nx * (reachA - pen / 2), py: a.y + ny * (reachA - pen / 2) };
}
// Distance beyond which two vehicles cannot touch (broad-phase): half the diagonal of the
// largest box in play (the tank, 56×30) ×2.
const CAR_REACH = 64;
// Applies a displacement to a car, respecting its kind of motion.
function shoveCar(c, dx, dy) {
  if (c.role === 'traffic' && c.edge != null) {         // railed car: backs up along its lane
    const along = dx * c.dir.x + dy * c.dir.y;
    c.t = clamp(c.t + (along / Math.max(1, edges[c.edge].len)) * c.ed, 0, 1);
    moveBox(c, dx, dy, c.colH, c.colH);
  } else {                                              // parked / player / police
    moveBox(c, dx, dy, c.colH, c.colH);
  }
}
// A vehicle's velocity vector: drive + residual shove from collisions.
const carVel = c => ({ x: Math.cos(c.angle) * c.speed + c.kvx, y: Math.sin(c.angle) * c.speed + c.kvy });
// Transfers a velocity change into the vehicle's motion model: the component along the
// direction of travel acts on throttle/brake, the rest is a slide (kv).
function applyImpulse(c, dvx, dvy) {
  // Parked cars (no throttle) and police (the chase sets the throttle, and c.speed is
  // rewritten every frame): the whole shove becomes a slide.
  if (c.role === 'parked' || c.role === 'police' || c.role === 'armycar') { c.kvx += dvx; c.kvy += dvy; return; }
  const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
  const along = dvx * ca + dvy * sa;
  c.speed += along;
  c.kvx += dvx - ca * along;
  c.kvy += dvy - sa * along;
}
// Moves the vehicle by its residual shove (respecting walls) and damps it.
function applyKnockback(c) {
  if (!c.kvx && !c.kvy) return;
  moveBox(c, c.kvx, c.kvy, c.colH, c.colH);
  if (c.hitX) { if (Math.abs(c.kvx) > 2.2) spawnSparks(c.x, c.y, 3); c.kvx *= -0.35; }  // slams into the wall
  if (c.hitY) { if (Math.abs(c.kvy) > 2.2) spawnSparks(c.x, c.y, 3); c.kvy *= -0.35; }
  c.kvx *= 0.86; c.kvy *= 0.86;
  if (Math.abs(c.kvx) < 0.05) c.kvx = 0;
  if (Math.abs(c.kvy) < 0.05) c.kvy = 0;
}
function resolveCarCollisions() {
  for (let i = 0; i < cars.length; i++) {
    const a = cars[i];
    for (let j = i + 1; j < cars.length; j++) {
      const b = cars[j];
      const ddx = b.x - a.x, ddy = b.y - a.y;
      if (ddx * ddx + ddy * ddy > CAR_REACH * CAR_REACH) continue;    // broad-phase
      // A tank at speed does not bounce off cars: it drives over them (tankCrush).
      if ((a.isTank && Math.abs(a.speed) >= 1.2) || (b.isTank && Math.abs(b.speed) >= 1.2)) continue;
      const hit = carHit(a, b);
      if (!hit) continue;
      const { pen, nx, ny } = hit;
      // The heavier one moves less: a lorry shoves a motorbike aside.
      const wa = (a.role === 'parked' ? 0.18 : 1) / (a.mass || 1);
      const wb = (b.role === 'parked' ? 0.18 : 1) / (b.mass || 1);
      const tot = wa + wb;
      shoveCar(a, -nx * pen * (wb / tot), -ny * pen * (wb / tot));
      shoveCar(b,  nx * pen * (wa / tot),  ny * pen * (wa / tot));
      // Bounce: a partially elastic impact — the impulse depends on the masses and on the
      // closing speed (a lorry at speed sends a motorbike flying, while a motorbike into a
      // lorry bounces straight off it).
      const va = carVel(a), vb = carVel(b);
      const vn = (vb.x - va.x) * nx + (vb.y - va.y) * ny;   // closing speed
      if (vn < 0) {
        const ma = a.mass || 1, mb = b.mass || 1;
        const jn = -(1 + 0.45) * vn / (1 / ma + 1 / mb);    // 0.45 = restitution (how much it bounces)
        applyImpulse(a, -nx * jn / ma, -ny * jn / ma);
        applyImpulse(b,  nx * jn / mb,  ny * jn / mb);
        // Impact: sparks, shake and damage in proportion to the hit.
        const imp = -vn;
        if (imp > 1.6) {
          spawnSparks(hit.px, hit.py, Math.min(10, Math.round(2 + imp * 1.4)));
          if (a.driver === 'player' || b.driver === 'player') {
            shake(Math.min(8, 2 + imp * 0.8), Math.min(9, 3 + imp * 0.7)); sfx.crash();
            const other = a.driver === 'player' ? b : a;
            if (other.role !== 'parked') damageCar(other, Math.min(16, 2 + imp * 2.2));   // ramming the traffic
          }
        }
      }
    }
  }
  if (player.car) { player.x = player.car.x; player.y = player.car.y; }
}
// Collisions between MY car and REMOTE cars (players, abandoned vehicles, rivals' patrol
// cars). Those are interpolated and "owned" by another client: we do NOT move them here,
// only our own car is displaced and bounced (the other client does the same on its side).
// They used to pass through each other; now they genuinely collide. Every vehicle is its
// own oriented box, as in resolveCarCollisions (same carHit → same contact on the edge).
function resolveRemoteCarCollisions() {
  if (!netActive() || !player.car) return;
  const a = player.car;
  if (a.isTank && Math.abs(a.speed) >= 1.2) return;   // a tank at speed drives straight over
  const remotes = netSolidCars([]);
  for (const b of remotes) {
    const ddx = b.x - a.x, ddy = b.y - a.y;
    if (ddx * ddx + ddy * ddy > CAR_REACH * CAR_REACH) continue;     // broad-phase
    const hit = carHit(a, b);
    if (!hit) continue;
    const { pen, nx, ny } = hit;
    shoveCar(a, -nx * pen, -ny * pen);                 // the remote car is immovable for us: we move aside entirely
    const va = carVel(a), vb = carVel(b);
    const vn = (vb.x - va.x) * nx + (vb.y - va.y) * ny; // closing speed
    if (vn < 0) {
      const ma = a.mass || 1, mb = (b.mass || 1) * 8;   // remote cars are heavy: they push us back
      const jn = -(1 + 0.4) * vn / (1 / ma + 1 / mb);
      applyImpulse(a, -nx * jn / ma, -ny * jn / ma);
      const imp = -vn;
      if (imp > 1.6) {                                  // a real hit: sparks, shake, damage
        spawnSparks(hit.px, hit.py, Math.min(10, Math.round(2 + imp * 1.4)));
        shake(Math.min(8, 2 + imp * 0.8), Math.min(9, 3 + imp * 0.7)); sfx.crash();
        damageCar(a, Math.min(16, 2 + imp * 2.2));
      }
    }
  }
  player.x = a.x; player.y = a.y;
}

// ---------- Bullets ----------
function updateBullets() {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx; b.y += b.vy; b.life--;
    let hit = false;
    if (solidTile(Math.floor(b.x / T), Math.floor(b.y / T))) { spawnSparks(b.x, b.y, 3); sfx.ricochet(hear(b.x, b.y, 620)); hit = true; }
    if (!hit && b.fromPlayer) {
      for (const p of peds) {
        if (p.ko) continue;
        if (dist(b.x, b.y, p.x, p.y) < p.r + 3) {
          knockPed(p, Math.atan2(b.vy, b.vx), b.knock || 4);
          asPlayer(b.owner || player, () => addScore(pedScore(p), p.x, p.y));
          // The crime (stars) is attributed to WHOEVER FIRED, not to the current global
          // player (bullets resolve in the shared world phase).
          if (p.role === 'cop') asPlayer(b.owner || player, () => commitCrime(1.2, 'crime.shootCop'));
          else if (p.role === 'soldier') armyAlertT = ARMY_ALERT_T;   // shooting soldiers sets them off
          else if (p.role !== 'robber') asPlayer(b.owner || player, () => { cash += 3; commitCrime(0.6, 'crime.shootPed'); });
          hit = true; break;
        }
      }
      // PvP (authoritative server only): the shot can floor ANOTHER player.
      if (!hit && MP) for (const v of MP) {
        if (v === b.owner || v.downT > 0) continue;
        if (v.car) {
          const c = v.car;
          if (Math.abs(b.x - c.x) < c.w / 2 && Math.abs(b.y - c.y) < c.h / 2 + 4) {
            const wasDown = v.downT > 0, vb = v.bounty | 0;
            asPlayer(v, () => { damageCar(c, b.dmg || 10, Math.atan2(b.vy, b.vx)); hurtPlayer(3); });
            if (!wasDown && v.downT > 0 && b.owner) creditKill(b.owner, v, vb);
            spawnSparks(b.x, b.y, 2); hit = true; break;
          }
        } else if (dist(b.x, b.y, v.x, v.y) < v.r + 3) {
          const wasDown = v.downT > 0, vb = v.bounty | 0;
          asPlayer(v, () => hurtPlayer(b.pvp || 8, Math.atan2(b.vy, b.vx)));
          if (!wasDown && v.downT > 0 && b.owner) creditKill(b.owner, v, vb);
          hit = true; break;
        }
      }
      if (!hit) for (const c of cars) {
        if (c.driver === 'player') continue;
        if (Math.abs(b.x - c.x) < c.w / 2 && Math.abs(b.y - c.y) < c.h / 2 + 4) {
          damageCar(c, b.dmg || 10, Math.atan2(b.vy, b.vx)); spawnSparks(b.x, b.y, 3); sfx.clank(hear(b.x, b.y, 700));
          if (b.flame && !c.burning && Math.random() < 0.25) igniteCar(c);   // the flamethrower sets vehicles alight
          hit = true; break;
        }
      }
    } else if (!hit && !b.fromPlayer) {
      // Hostile bullet: from a cop/soldier, or from a RIVAL in multiplayer (fromNet). In
      // that case the damage is the weapon's, and the shot stays "signed" for any kill
      // credit (authoritative victim). It can hit ANY player (in authoritative mode, the
      // first one reached).
      eachActivePlayer(v => {
        if (hit || v.downT > 0) return;
        if (v.car) {
          const c = v.car;
          if (Math.abs(b.x - c.x) < c.w / 2 + 2 && Math.abs(b.y - c.y) < c.h / 2 + 4) {
            if (b.fromNet) netRegisterHit(b.fromNet);
            if (c.isTank) { damageCar(c, 1); sfx.ricochet(hear(b.x, b.y, 620)); }   // the armour laughs off bullets
            else asPlayer(v, () => { damageCar(c, b.fromNet ? (b.dmg || 4) : 4); hurtPlayer(3); });
            spawnSparks(b.x, b.y, 2); hit = true;
          }
        } else if (dist(b.x, b.y, v.x, v.y) < v.r + 3) {
          if (b.fromNet) netRegisterHit(b.fromNet);
          asPlayer(v, () => hurtPlayer(b.fromNet ? (b.pdmg || 8) : 8, Math.atan2(b.vy, b.vx))); hit = true;
        }
      });
    }
    if (hit || b.life <= 0 || b.x < 0 || b.y < 0 || b.x > WORLD_W || b.y > WORLD_H) bullets.splice(i, 1);
  }
}
function damageCar(c, dmg, angle, chain = 0) {
  c.health -= dmg;
  if (c.health <= 30 && !c.smoking) c.smoking = true;
  if (c.smoking && frame % 4 === 0) parts.push({ x: c.x + rnd(-10, 10), y: c.y + rnd(-8, 8), vx: rnd(-0.4, 0.4), vy: rnd(-1.4, -0.5), life: rndi(20, 40), color: '#555', size: rnd(4, 8), kind: 'smoke' });
  // Badly damaged: it can catch fire — from then on it burns itself out (updateBurningCars).
  if (!c.burning && c.health > 0 && c.health <= 25 && (c.health <= 12 || Math.random() < 0.35)) igniteCar(c);
  if (c.health <= 0) explodeCar(c, chain);
}
// The vehicle catches fire: the fuse is lit, best to get clear.
function igniteCar(c) {
  c.burning = true; c.burnSeed = rnd(0, TAU); c.burnWet = 0;
  if (c.driver === 'player') toast(t('veh.burning'));
}
// Burning vehicles: the fire eats away at them until they explode; passers-by flee the
// blaze and the fire engine's hydrant can still put them out.
function updateBurningCars() {
  for (let i = cars.length - 1; i >= 0; i--) {
    const c = cars[i];
    // Dented cars (not yet alight) puff out a wisp of smoke.
    if (c.smoking && !c.burning && frame % 10 === 0)
      parts.push({ x: c.x + rnd(-8, 8), y: c.y + rnd(-6, 6), vx: rnd(-0.3, 0.3), vy: rnd(-1.1, -0.4), life: rndi(16, 30), color: '#666', size: rnd(3, 6), kind: 'smoke' });
    if (!c.burning) continue;
    if (frame % 3 === 0) parts.push({ x: c.x + rnd(-c.w / 3, c.w / 3), y: c.y + rnd(-c.h / 3, c.h / 3),
      vx: rnd(-0.3, 0.3), vy: rnd(-1.7, -0.7), life: rndi(12, 26),
      color: pick(['#ff5a2a', '#ff8a2a', '#ffd23a']), size: rnd(3, 7), kind: 'smoke' });
    if (frame % 8 === 0) parts.push({ x: c.x + rnd(-10, 10), y: c.y - 6,
      vx: rnd(-0.3, 0.3), vy: rnd(-1.6, -0.9), life: rndi(24, 44), color: '#444', size: rnd(5, 9), kind: 'smoke' });
    // Passers-by flee the blaze.
    if (frame % 6 === 0) for (const p of peds) {
      if (p.ko || dist(p.x, p.y, c.x, c.y) >= 90) continue;
      if (p.panic === 0) { sfx.yell(hear(p.x, p.y, 700)); pedSay(p, SAY_PANIC, '#c22822', true); }
      const a = Math.atan2(p.y - c.y, p.x - c.x);
      p.dir = { x: Math.cos(a), y: Math.sin(a) }; p.speed = 2.4; p.panic = 40; p.thinkCd = 20;
    }
    // The fire eats through the bodywork: a ~4-5 second fuse, then the bang.
    c.health -= 0.09;
    if (c.health <= 0) explodeCar(c);
  }
}
function explodeCar(c, chain = 0) {
  if (c.exploded) return; c.exploded = true;   // guard against a double bang in chain reactions
  netDestroyCar(c);                            // multiplayer: remove the stationary shape from other screens
  const i = cars.indexOf(c); if (i >= 0) cars.splice(i, 1);
  spawnExplosion(c.x, c.y);
  shake(9, 12); sfx.boom();
  // Points: only for the trigger and the first links of the chain (no farming in car
  // parks), and never for YOUR OWN car blowing up.
  const scoring = chain < SCORE.chainMax;
  if (scoring && c.driver !== 'player') addScore(carScore(c), c.x, c.y);
  // Blast wave: throws nearby pedestrians and players (passers-by caught in it score
  // separately).
  for (const p of peds) if (!p.ko && dist(p.x, p.y, c.x, c.y) < 90) {
    knockPed(p, Math.atan2(p.y - c.y, p.x - c.x), 7);
    if (scoring) addScore(pedScore(p), p.x, p.y);
  }
  // Inside the tank you are shielded from the blast (unless the tank is what exploded).
  eachActivePlayer(v => {
    if (v.car && v.car.isTank && v.car !== c) return;
    if (dist(v.x, v.y, c.x, c.y) < 90) asPlayer(v, () => hurtPlayer(28, Math.atan2(v.y - c.y, v.x - c.x)));
  });
  // ...and it damages the cars alongside, which can catch fire in turn: chain reaction!
  for (const o of [...cars]) if (dist(o.x, o.y, c.x, c.y) < 95) damageCar(o, 26, undefined, chain + 1);
  if (player.car === c) { player.car = null; engineGain(0); }
}

// ---------- Action score: crimes, explosions and missions ----------
// Points the player racks up for what they get up to in the city. Killing ANOTHER player
// (KILL_POINTS) stays the biggest reward; missions pay well but carry no risk, so they are
// worth less than PvP.
const SCORE = {
  civ: 10, cop: 50, soldier: 75,      // people floored (punched, shot, run over, blown up)
  car: 25, carSpecial: 40,            // vehicle blown up (patrol/military vehicles are worth more)
  chainMax: 3,                        // how many cars in a chain reaction still score (no farming)
  mission: { taxi: 150, pizza: 150, ambulance: 200, patrol: 200, fire: 250 },
};
// Points for a person floored, by role (the robber is a mission target, not a "victim").
function pedScore(p) {
  if (p.role === 'robber') return 0;
  if (p.role === 'cop') return SCORE.cop;
  if (p.role === 'soldier') return SCORE.soldier;
  return SCORE.civ;
}
// Points for a destroyed vehicle (patrol cars and army vehicles are worth more).
function carScore(c) {
  const special = c.role === 'police' || c.wasPolice || c.role === 'armycar' ||
                  c.isTank || c.livery === 'army' || c.serviceType === 'army' || c.serviceType === 'armyjeep';
  return special ? SCORE.carSpecial : SCORE.car;
}
// Credits `n` points to a player and shows a floating "+N" at the spot of the action.
function awardScore(pl, n, x, y) {
  if (!pl || !n) return;
  pl.score = (pl.score | 0) + n;
  scorePop(n, x, y);
}
// As above, but on the current player (global `player`, the way `cash += …` does).
function addScore(n, x, y) { awardScore(player, n, x, y); }
// Floating score number: only on the rendering client (pointless on the MP server).
function scorePop(n, x, y) {
  if (MP || !n) return;
  pops.push({ x, y: y - 6, vy: -0.45, life: 55, text: '+' + n });
  if (pops.length > 40) pops.shift();
}
function updatePops() {
  for (let i = pops.length - 1; i >= 0; i--) {
    const q = pops[i]; q.y += q.vy; q.life--;
    if (q.life <= 0) pops.splice(i, 1);
  }
}

// ---------- Score, kill streaks and bounties (multiplayer PvP) ----------
const KILL_POINTS = 500;                          // points for downing ANOTHER player (the biggest reward)
// Names for consecutive-kill streaks, for the on-screen message.
const STREAK_KEY = { 2: 'streak.2', 3: 'streak.3', 4: 'streak.4',
                     5: 'streak.5', 7: 'streak.7', 10: 'streak.10' };
// The more kills you get without dying, the bigger the BOUNTY on your head: whoever downs
// you collects it (in points and in cash). You become target number one.
function bountyForStreak(s) {
  if (s >= 10) return 1000;
  if (s >= 7)  return 500;
  if (s >= 5)  return 300;
  if (s >= 3)  return 150;
  return 0;
}
// A message for one player: locally an immediate toast, on the authoritative server it is
// queued and goes out with the next snapshot (see snapshotFor).
// `k` is a translation key and `p` its parameters: the TEXT is composed by the client that
// receives the event, so everyone reads it in THEIR OWN language.
// `sk` is the key of an optional suffix (the kill streak), appended with ' · '.
function pushEvent(pl, k, p, sk) {
  const ev = { k }; if (p) ev.p = p; if (sk) ev.s = sk;
  if (!MP) { toast(evText(ev)); return; }
  (pl.events || (pl.events = [])).push(ev);
}
// Credits `killer` with the kill on `victim`. `vb` is the victim's bounty CAPTURED BEFORE
// the hit (startDown clears it), which the killer collects.
function creditKill(killer, victim, vb) {
  killer.kills  = (killer.kills  | 0) + 1;
  killer.streak = (killer.streak | 0) + 1;
  killer.score  = (killer.score  | 0) + KILL_POINTS;
  victim.deaths = (victim.deaths | 0) + 1;
  vb = vb | 0;
  pushEvent(killer, vb > 0 ? 'pvp.killedBounty' : 'pvp.killed',
            { name: victim.name, bounty: vb }, STREAK_KEY[killer.streak]);
  pushEvent(victim, 'pvp.down', { name: killer.name });
  if (vb > 0) { asPlayer(killer, () => { cash += vb; }); killer.score += vb; }   // collect the bounty
  // The new streak may raise the bounty on the killer's own head.
  const nb = bountyForStreak(killer.streak);
  if (nb > (killer.bounty | 0)) pushEvent(killer, 'pvp.onYou', { n: nb });
  killer.bounty = nb;
}

// ---------- Player damage / death ----------
function hurtPlayer(dmg, angle) {
  if (downT > 0) return;                          // already down: no extra damage
  if (player.hurtCd > 0 && dmg < 12) return;
  player.hurtCd = 6;
  player.health -= dmg;
  flashT = 8; shake(3, 4);
  if (angle != null && !player.car) moveBox(player, Math.cos(angle) * 4, Math.sin(angle) * 4, player.r, player.r);
  sfx.ouch();
  updateHealth();
  if (player.health <= 0) die();
}
function die() { startDown('dead'); }
function arrestPlayer() { startDown('busted'); }
// The player is out of play: a "You were killed" / "Busted" screen with a 3-second
// countdown, then they respawn (hospital if killed, station if busted).
function startDown(kind) {
  if (downT > 0) return;                          // already down: no duplicates
  downT = 180; downKind = kind;
  player.streak = 0; player.bounty = 0;           // die or get busted: streak and bounty reset
  netReportDown(kind);                            // multiplayer: count the death and credit the killer
  sfx.bust();
  if (kind === 'dead') { cash = Math.floor(cash * 0.5); updateCash(); }
  wantedHeat = 0; wanted = 0; crimeCd = 0; updateStars();
  // The hunt is over: officers leave, patrol cars go back to being ordinary cars.
  for (let i = peds.length - 1; i >= 0; i--) if (peds[i].role === 'cop') peds.splice(i, 1);
  for (const c of cars) if (c.role === 'police') c.role = 'parked';
  // ...and the army returns to barracks too.
  armyAlertT = 0;
  for (let i = peds.length - 1; i >= 0; i--) if (peds[i].role === 'soldier') peds.splice(i, 1);
  for (const c of cars) if (c.role === 'armycar') c.role = 'parked';
  // The car stays parked where you left it (as when getting out with E): without the
  // 'parked' role, updateCar would treat it as traffic on a rail it does not have.
  if (player.car) { const c = player.car; c.driver = null; c.speed = 0; c.role = 'parked'; c.edge = null; netAbandonCar(c); player.car = null; engineGain(0); }
  cancelTaxi();
  cancelPizza();
  cancelRescue();
  cancelPatrol();
  cancelFirejob();
  const el = $('#bigMsg');
  if (el) {
    el.classList.remove('hidden');
    el.classList.toggle('busted', kind === 'busted');
    $('#bigTitle').textContent = t(kind === 'busted' ? 'big.busted' : 'big.dead');
    $('#bigCount').textContent = '3';
  }
}
// Ticks down the on-screen countdown and, when it expires, puts the player back in play.
function updateDown() {
  downT--;
  const el = $('#bigCount');
  if (el) el.textContent = Math.max(1, Math.ceil(downT / 60));
  if (downT <= 0) respawnPlayer();
}
function respawnPlayer() {
  player.health = 100; player.hurtCd = 0; updateHealth();
  // Killed → nearest hospital; busted → nearest police station.
  const type = downKind === 'busted' ? 'police' : 'hospital';
  let best = null, bd = Infinity;
  for (const l of landmarks) if (l.type === type) { const d = dist(l.cx, l.cy, player.x, player.y); if (d < bd) { bd = d; best = l; } }
  const p = best ? best.door : (randomRoadNear(player.x, player.y, 500, 1100) || nodes[Math.floor(nodes.length / 2)]);
  player.x = p.x; player.y = p.y;
  const el = $('#bigMsg'); if (el) el.classList.add('hidden');
  toast(t(downKind === 'busted' ? 'respawn.busted' : 'respawn.dead'));
  downKind = null;
}

// ---------- Dynamic population (spawn/despawn around the player) ----------
// Centre of the viewport: on the client it follows the camera (which can be "stuck" to
// the world edges, so the player is NOT at the centre), and on the headless server it
// coincides with the player. Spawning around THIS centre, beyond the view's half
// diagonal, guarantees no entity is born inside the visible rectangle: no pop-in on screen.
function spawnCentre(focus = spawnFocus()) {
  return cameraActive ? { x: camX + vw / 2, y: camY + vh / 2 } : focus;
}
function managePopulation() {
  const despawnR = Math.max(vw, vh) * 1.3 + 300;
  const nP = MP ? Math.max(1, MP.length) : 1;    // scale density with the number of players
  const viewDiag = Math.hypot(vw, vh) / 2;         // distance from centre to the furthest visible corner
  const inMin = viewDiag + 80;                     // just OUTSIDE the corner of the viewport
  const inMax = viewDiag + Math.max(vw, vh) * 0.5; // spawn band just past the edge (within the despawn radius)
  // Removes entities that are dead or too far from EVERY player.
  for (let i = peds.length - 1; i >= 0; i--) {
    const p = peds[i];
    if (p.dead || (p.role !== 'cop' && p.role !== 'fare' && p.role !== 'hungry' && p.role !== 'injured' && p.role !== 'robber' && distToNearestPlayer(p.x, p.y) > despawnR)) peds.splice(i, 1);
    else if (p.role === 'cop' && (wanted === 0 || distToNearestPlayer(p.x, p.y) > despawnR * 1.4)) peds.splice(i, 1);
    else if (p.role === 'soldier' && !p.guard && (armyAlertT === 0 || distToNearestPlayer(p.x, p.y) > despawnR * 1.4)) peds.splice(i, 1);
  }
  for (let i = cars.length - 1; i >= 0; i--) {
    const c = cars[i];
    if (c.driver === 'player') continue;
    if (c.role === 'police' && (wanted < 2 || distToNearestPlayer(c.x, c.y) > despawnR * 1.5)) cars.splice(i, 1);
    else if (c.role === 'armycar' && armyAlertT === 0) cars.splice(i, 1);
    else if (c.role !== 'police' && distToNearestPlayer(c.x, c.y) > despawnR) cars.splice(i, 1);
  }
  for (let i = coins.length - 1; i >= 0; i--) if (distToNearestPlayer(coins[i].x, coins[i].y) > despawnR) coins.splice(i, 1);
  // Per-role counts in ONE pass (no .filter allocating every frame).
  let nCiv = 0, nCop = 0, nSoldier = 0;
  for (const p of peds) { if (p.role === 'civ') nCiv++; else if (p.role === 'cop') nCop++; else if (p.role === 'soldier') nSoldier++; }
  let nTraf = 0, nPark = 0, nTaxi = 0, nDeliv = 0, nArmy = 0, nPolice = 0;
  for (const c of cars) {
    if (c.role === 'traffic') nTraf++; else if (c.role === 'armycar') nArmy++; else if (c.role === 'police') nPolice++;
    if (c.parkedDecor && c.role === 'parked') nPark++;
    if (c.isTaxi) nTaxi++;
    if (c.isDelivery) nDeliv++;
  }
  // Civilians.
  if (nCiv < 26 * nP && frame % 8 === 0) { const centre = spawnCentre(); const p = randomWalkNear(centre.x, centre.y, inMin, inMax); if (p) peds.push(makePed(p.x, p.y, 'civ')); }
  // Moving traffic.
  if (nTraf < 14 * nP && frame % 12 === 0) { const centre = spawnCentre(); const c = spawnTrafficNear(centre.x, centre.y, inMin, inMax); if (c) cars.push(c); }
  // Parked cars.
  if (nPark < 14 * nP && frame % 16 === 0) { const centre = spawnCentre(); const p = randomParkingNear(centre.x, centre.y, inMin, inMax); if (p) cars.push(makeParked(p.x, p.y, p.angle)); }
  // A few taxis around the city, always.
  if (frame % 40 === 0 && nTaxi < 3 * nP) {
    const centre = spawnCentre();
    const c = spawnTrafficNear(centre.x, centre.y, inMin, inMax);
    if (c) { makeTaxi(c); cars.push(c); }
  }
  // ...and at least a couple of delivery bikes.
  if (frame % 40 === 20 && nDeliv < 2 * nP) {
    const centre = spawnCentre();
    const c = spawnTrafficNear(centre.x, centre.y, inMin, inMax);
    if (c) { makeDeliveryMoto(c); cars.push(c); }
  }
  // Replaces (off-screen) the service vehicles in front of each special building.
  if (frame % 120 === 0) for (const lm of landmarks) {
    const d = distToNearestPlayer(lm.cx, lm.cy);
    if (d < 600 || d > despawnR) continue;
    if (lm.type === 'army') {                          // restore the base garrison
      const tanks = cars.filter(c => c.role === 'parked' && c.serviceType === 'army' && dist(c.x, c.y, lm.cx, lm.cy) < 600).length;
      for (let k = tanks; k < (SERVICE_COUNT.army || 1); k++) parkServiceCar(lm);
      const jeeps = cars.filter(c => c.role === 'parked' && c.serviceType === 'armyjeep' && dist(c.x, c.y, lm.cx, lm.cy) < 600).length;
      for (let k = jeeps; k < 2; k++) parkArmyJeep(lm);
      restoreArmyGuards(lm);
      continue;
    }
    const has = cars.some(c => c.role === 'parked' && c.serviceType === lm.type &&
      dist(c.x, c.y, lm.door.x, lm.door.y) < 600);
    if (!has) parkServiceCar(lm);
  }
  // Scattered coins + a few hidden away in the alleys.
  const wantCoins = 2 * nP;
  if (coins.length < wantCoins && frame % 40 === 0) { const centre = spawnCentre(); spawnCoinNear(centre.x, centre.y, inMin, inMax); }
  if (coins.length < wantCoins && frame % 120 === 0) { const centre = spawnCentre(); spawnAlleyCoin(centre.x, centre.y, inMax); }
  // MILITARY ALERT: while it lasts, soldiers and armed jeeps give chase.
  if (armyAlertT > 0) {
    if (nSoldier < 3 * nP && frame % 40 === 0) { const centre = spawnCentre(); const p = randomWalkNear(centre.x, centre.y, inMin, inMax); if (p) peds.push(makeSoldier(p.x, p.y)); }
    if (nArmy < 2 * nP && frame % 60 === 0) { const centre = spawnCentre(); const p = randomRoadNear(centre.x, centre.y, inMin, inMax); if (p) cars.push(makeArmyCar(p.x, p.y)); }
  }
  // POLICE according to the wanted level (room-wide heat, shared in multiplayer).
  const wantCops = wanted * nP;                  // cops on foot
  const wantCopCars = Math.max(0, wanted - 1) * nP;   // patrol cars
  if (wanted > 0 && nCop < wantCops && frame % 30 === 0) { const centre = spawnCentre(policeSpawnFocus()); const p = randomWalkNear(centre.x, centre.y, inMin, inMax); if (p) peds.push(makePed(p.x, p.y, 'cop')); }
  if (wanted >= 2 && nPolice < wantCopCars && frame % 50 === 0) { const centre = spawnCentre(policeSpawnFocus()); const p = randomRoadNear(centre.x, centre.y, inMin, inMax); if (p) { const c = makeCar(p.x, p.y, 'police'); c.wasPolice = true; cars.push(c); } }
}

// ---------- Particles / effects ----------
function spawnBlood(x, y) { for (let i = 0; i < 10; i++) { const a = rnd(0, TAU), s = rnd(1, 4); parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rndi(16, 30), color: '#b0202a', size: rnd(3, 6), kind: 'blood' }); } }
function spawnSparks(x, y, n) { for (let i = 0; i < n; i++) { const a = rnd(0, TAU), s = rnd(1, 4); parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rndi(8, 18), color: Math.random() < .5 ? '#ffd23a' : '#ff8a2a', size: rnd(2, 4), kind: 'spark' }); } }
function spawnMuzzle(x, y, a) { for (let i = 0; i < 4; i++) parts.push({ x, y, vx: Math.cos(a) * rnd(1, 4) + rnd(-1, 1), vy: Math.sin(a) * rnd(1, 4) + rnd(-1, 1), life: rndi(4, 9), color: '#ffe89a', size: rnd(2, 5), kind: 'spark' }); }
function spawnExplosion(x, y) { for (let i = 0; i < 30; i++) { const a = rnd(0, TAU), s = rnd(1.5, 7); const c = Math.random() < .4 ? '#ffe14a' : (Math.random() < .6 ? '#ff5a2a' : '#555'); parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rndi(16, 42), color: c, size: rnd(4, 12), kind: 'smoke' }); } }
function updateParts() {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.x += p.vx; p.y += p.vy; p.life--;
    if (p.kind === 'smoke') { p.vx *= 0.94; p.vy *= 0.94; p.vy -= 0.05; }
    else { p.vx *= 0.9; p.vy *= 0.9; }
    if (p.life <= 0) parts.splice(i, 1);
  }
  for (let i = decals.length - 1; i >= 0; i--) if (--decals[i].life <= 0) decals.splice(i, 1);
  for (let i = pickups.length - 1; i >= 0; i--) {
    const k = pickups[i]; k.t += 0.12; k.life--;
    const got = playerTouching(k.x, k.y, 22);
    if (got) { asPlayer(got, () => { cash += k.v; updateCash(); }); sfx.coin(); pickups.splice(i, 1); }
    else if (k.life <= 0) pickups.splice(i, 1);
  }
}
// Picking up scattered coins (on foot or in a car).
function updateCoins() {
  for (let i = coins.length - 1; i >= 0; i--) {
    const k = coins[i];
    k.spin += 0.13; k.bob += 0.08;
    const got = playerTouching(k.x, k.y, 24);
    if (got) {
      asPlayer(got, () => { cash += k.val; updateCash(); }); sfx.coin();
      for (let j = 0; j < 7; j++) { const a = rnd(0, TAU), s = rnd(1, 3); parts.push({ x: k.x, y: k.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1, life: rndi(10, 20), color: Math.random() < .5 ? '#ffe14a' : '#fff2a0', size: rnd(2, 4), kind: 'spark' }); }
      coins.splice(i, 1);
    }
  }
}
function shake(mag, t) { if (mag > shakeMag) { shakeMag = mag; shakeT = t; } }

// ---------- Camera ----------
function updateCamera() {
  cameraActive = true;
  const tx = player.x, ty = player.y;
  camX = clamp(tx - vw / 2, 0, Math.max(0, WORLD_W - vw));
  camY = clamp(ty - vh / 2, 0, Math.max(0, WORLD_H - vh));
  if (WORLD_W < vw) camX = (WORLD_W - vw) / 2;
  if (WORLD_H < vh) camY = (WORLD_H - vh) / 2;
  if (shakeT > 0) { shakeT--; camX += rnd(-shakeMag, shakeMag); camY += rnd(-shakeMag, shakeMag); if (shakeT === 0) shakeMag = 0; }
}

// ---------- Main update ----------
const SERVER_END_GRACE_FRAMES = 5 * 60;
function update() {
  // Timed match: the clock always runs, even while dead/busted and even on an
  // authoritative server (where updateNetClient RENDERS the rest of the world). In MP the
  // real END is called by the server ('end' message); here the countdown starts from the
  // clock received on join (net.clockLeft) and only exists to display it.
  if (gameMinutes > 0) {
    timeLeft--;
    if (timeLeft % 20 === 0) updateTimer();
    if (timeLeft <= (authClient() ? -SERVER_END_GRACE_FRAMES : 0)) { endGame('time'); return; }
  }
  // Phase 2: with an authoritative server the client does not simulate the world, it
  // RENDERS it (prediction of its own player + snapshot interpolation). See net.js.
  if (authClient()) { updateNetClient(); return; }
  // Out of play (dead/busted): the scene freezes and only the countdown runs (the network
  // stays alive though: ghosts keep moving and the "down" state is still sent).
  if (downT > 0) { updateDown(); netTick(); frame++; return; }
  applyTouchInput();
  if (player.hurtCd > 0) player.hurtCd--;
  if (flashT > 0) flashT--;
  updateLights();
  updateTrainKinematics();                        // train position (needed by trainBlocking inside updateCar)
  if (player.car) updateDrive(player.car); else updatePlayerFoot();
  for (const c of cars) updateCar(c);
  resolveCarCollisions();
  resolveRemoteCarCollisions();                  // impacts with other players' cars/patrol cars
  trainCollide();                                // train = solid wall: after movement (blocks with no lag)
  for (const p of peds) updatePed(p);
  updateBullets();
  updateRockets();
  updateParts();
  updatePops();
  updateCoins();
  updateTaxi();
  updatePizza();
  updateRescue();
  updatePatrol();
  updateFirejob();
  updateArmy();
  updateFires();
  updateBurningCars();
  updateWater();
  updateHealPads();
  managePopulation();
  // Wanted-level decay.
  if (crimeCd > 0) crimeCd--;
  else if (wantedHeat > 0) { wantedHeat = Math.max(0, wantedHeat - 0.0016); const w = Math.floor(wantedHeat); if (w !== wanted) { wanted = w; updateStars(); } }
  // Siren of the police hunting you.
  if (wanted > 0 && frame % 26 === 0) sfx.siren((frame / 26) % 2 < 1);
  // Siren on your own service vehicle (mission running, or switched on with Space).
  if (playerSirenOn(player.car) && frame % 24 === 0)
    sfx.emergency(player.car.livery === 'ambulance', (frame / 24) % 2 < 1);
  // Hum of nearby traffic + cooldowns for the anti-machine-gun sound limiter.
  if (frame % 5 === 0) updateTrafficEngine();
  for (const k in sfxCd) if (sfxCd[k] > 0) sfxCd[k]--;
  netTick();                                     // multiplayer: ghosts, run-over PvP, state upload
  updateCamera();
  frame++;
}

