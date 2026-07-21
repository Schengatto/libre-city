// LIBRE CITY · js/gameplay.js — regole e fisica: player a piedi e alla guida, pugni e spari,
// pedoni e poliziotti, IA del traffico, collisioni, proiettili, danni/morte, popolamento, camera e update().

// ---------- Ospedale: cura a pagamento davanti all'ingresso ----------
let healMsgCd = 0;
function updateHealPads() {
  if (healMsgCd > 0) healMsgCd--;
  if (player.car) return;
  for (const lm of landmarks) {
    if (lm.type !== 'hospital' || dist(player.x, player.y, lm.door.x, lm.door.y) >= 26) continue;
    if (player.health >= 100) return;
    if (cash >= 25) { cash -= 25; player.health = 100; updateHealth(); updateCash(); toast('🏥 Curato! (−$25)'); sfx.coin(); }
    else if (healMsgCd === 0) { toast('🏥 Ti servono $25 per farti curare'); healMsgCd = 150; }
    return;
  }
}

// ---------- Armeria: compra le armi sul pad davanti all'ingresso ----------
// Avvicinati a piedi al pad dell'ARMERIA: compare il listino — premi il numero
// dell'arma per comprarla (se hai i soldi) o per equipaggiarne una che possiedi.
function nearGunshop() {
  if (player.car) return null;
  for (const lm of landmarks)
    if (lm.type === 'gunshop' && dist(player.x, player.y, lm.door.x, lm.door.y) < 46) return lm;
  return null;
}
function weaponKey(i) {
  if (!started) return;
  if (authClient()) { net.weaponReq = i; return; }   // equipaggia/compra: lo fa il server
  const w = WEAPONS[i];
  if (player.owned[i]) {                              // già tua: la impugni
    if (player.weaponIdx !== i) { player.weaponIdx = i; updateWeapon(); toast(`${w.icon} ${w.name} equipaggiata`); sfx.door(); }
    return;
  }
  if (nearGunshop()) {
    if (cash >= w.price) {
      cash -= w.price; player.owned[i] = true; player.weaponIdx = i;
      updateCash(); updateWeapon();
      toast(`🛒 ${w.name} acquistata! (−$${w.price})`); sfx.coin();
    } else { toast(`💸 Ti servono $${w.price} per ${w.name}`); sfx.err(); }
  } else { toast(`🔒 ${w.name} si compra all'ARMERIA`); sfx.err(); }
}

// ---------- Crimini & ricercato ----------
function commitCrime(amount, msg) {
  const before = wanted;
  wantedHeat = clamp(wantedHeat + amount, 0, 5.99);
  crimeCd = 60 * 9;
  wanted = Math.floor(wantedHeat);
  updateStars();
  if (wanted > before) { toast(msg || '⭐ Livello ricercato: ' + wanted); flashSiren(); }
}
function flashSiren() { shake(6, 8); }

// ---------- Player a piedi ----------
function updatePlayerFoot() {
  unstick(player, player.r, player.r);                  // mai restare incastrati in un muro
  const dx = (held('KeyD','ArrowRight') ? 1 : 0) - (held('KeyA','ArrowLeft') ? 1 : 0);
  const dy = (held('KeyS','ArrowDown')  ? 1 : 0) - (held('KeyW','ArrowUp')   ? 1 : 0);
  const sp = 2.6;
  let mvx = dx, mvy = dy;
  if (mvx && mvy) { mvx *= 0.707; mvy *= 0.707; }
  moveBox(player, mvx * sp, mvy * sp, player.r, player.r);
  player.moving = dx !== 0 || dy !== 0;
  if (player.moving) player.walk += 0.3; else player.walk = 0;
  // mira verso il mouse
  player.aim = Math.atan2(mouseWY() - player.y, mouseWX() - player.x);
  // sparo: le armi automatiche sparano tenendo premuto, le altre un colpo per click
  if (player.shootCd > 0) player.shootCd--;
  if (player.punchT > 0) player.punchT--;
  const w = WEAPONS[player.weaponIdx];
  // su un client autoritativo lo sparo lo decide il server (predizione senza proiettili locali)
  if (!authClient() && (w.auto ? mDownL : mClicked) && player.shootCd === 0) { (w.melee ? playerPunch : playerShoot)(w); player.shootCd = w.cd; }
  mClicked = false;
}
function playerShoot(w) {
  if (w.rocket) { playerFireRocket(w); return; }      // il lanciarazzi spara un razzo esplosivo
  for (let i = 0; i < (w.pellets || 1); i++) {        // il fucile a pompa spara una rosa di pallini
    const a = player.aim + rnd(-w.spread, w.spread);
    const bx = player.x + Math.cos(a) * 14, by = player.y + Math.sin(a) * 14;
    bullets.push({ x: bx, y: by, vx: Math.cos(a) * w.spd, vy: Math.sin(a) * w.spd,
                   life: w.life, fromPlayer: true, dmg: w.dmgCar, knock: w.knock, owner: player, pvp: w.pvp || 8 });
  }
  spawnMuzzle(player.x + Math.cos(player.aim) * 14, player.y + Math.sin(player.aim) * 14, player.aim);
  shake(w.shake || 2, 3);
  (sfx[w.sfx] || sfx.shoot)();
  netShotFired(w);                                    // in multigiocatore i rivali vedono (e subiscono) i colpi
}
// il razzo del lanciarazzi: vola dritto dal player e scoppia al primo impatto
// (updateRockets/explodeRocket). `owner` firma il colpo per punti/taglie in PvP.
function playerFireRocket(w) {
  const a = player.aim;
  const bx = player.x + Math.cos(a) * 16, by = player.y + Math.sin(a) * 16;
  rockets.push({ x: bx, y: by, vx: Math.cos(a) * (w.spd || 7), vy: Math.sin(a) * (w.spd || 7),
                 life: w.life || 120, src: player.car || player, owner: player });
  spawnMuzzle(bx, by, a);
  shake(w.shake || 6, 6);
  (sfx[w.sfx] || sfx.rocket)();
  netRocketFired({ x: player.x, y: player.y, turretA: a });   // Fase 1: i rivali vedono il razzo volare
}

// ---------- Pugni: attacco ravvicinato — al terzo colpo il pedone va al tappeto ----------
const PUNCH_KILL = 3;
function playerPunch(w) {
  player.punchT = 10;                                 // fa scattare l'animazione del braccio
  netPunched();                                       // in multigiocatore anche i rivali possono prenderle
  // PvP (server autoritativo): un pugno nel cono stende un altro giocatore a piedi
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
  // colpisce il pedone più vicino nel cono davanti al player
  let best = null, bd = w.range;
  for (const p of peds) {
    if (p.ko || p.dead) continue;
    const d = dist(player.x, player.y, p.x, p.y);
    if (d < bd && Math.abs(angDiff(player.aim, Math.atan2(p.y - player.y, p.x - player.x))) < 1.0) { bd = d; best = p; }
  }
  if (best) { punchPed(best, w); return; }
  // nessuno a tiro: il pugno può comunque ammaccare un'auto a portata
  const fx = player.x + Math.cos(player.aim) * 18, fy = player.y + Math.sin(player.aim) * 18;
  for (const c of cars) {
    if (Math.abs(fx - c.x) < c.w / 2 + 4 && Math.abs(fy - c.y) < c.h / 2 + 6) {
      damageCar(c, w.dmgCar, player.aim); spawnSparks(fx, fy, 2); sfx.clank(hear(fx, fy, 700));
      return;
    }
  }
  sfx.whoosh();                                       // pugno a vuoto
}
function punchPed(p, w) {
  p.punches = (p.punches || 0) + 1;
  spawnBlood(p.x, p.y);
  sfx.punch();
  if (p.punches >= PUNCH_KILL) {                      // terzo pugno: steso
    knockPed(p, player.aim, w.knock);
    if (p.role === 'cop') commitCrime(1.2, '🚨 Hai steso un poliziotto a pugni!');
    else if (p.role === 'soldier') armyAlertT = ARMY_ALERT_T;
    else if (p.role !== 'robber') { cash += 3; commitCrime(0.6, '🚨 Hai steso un passante a pugni!'); }
    return;
  }
  // ferito ma ancora in piedi: barcolla via in preda al panico
  const a = Math.atan2(p.y - player.y, p.x - player.x);
  p.dir = { x: Math.cos(a), y: Math.sin(a) };
  p.speed = 2.4; p.panic = 60; p.thinkCd = 20;
  pedSay(p, SAY_PANIC, '#c22822', true);
  if (p.role === 'cop') commitCrime(0.6, '🚨 Hai colpito un poliziotto!');
  else if (p.role === 'soldier') armyAlertT = ARMY_ALERT_T;
}

// ---------- Guida ----------
// rapporti del cambio: fino a che velocità "tira" la marcia g (prima corta, ultime lunghe)
function gearTop(c, g) { return c.top * Math.pow(g / (c.gears || 4), 1.15); }
function updateDrive(c) {
  unstick(c, c.colH, c.colH);                           // mai restare incastrati in un muro
  let up = held('KeyW','ArrowUp'), down = held('KeyS','ArrowDown');
  let steer = (held('KeyD','ArrowRight') ? 1 : 0) - (held('KeyA','ArrowLeft') ? 1 : 0);
  if (touchDrive.active) {
    // guida relativa allo schermo: il muso insegue la direzione dello stick;
    // stick quasi opposto al muso → frena e poi retromarcia
    const d = angDiff(c.angle, touchDrive.angle);
    if (Math.abs(d) > 2.5) {
      up = false; down = true;
      // in retro sterza in modo che sia la CODA ad andare verso lo stick
      steer = c.speed < -0.25 ? clamp(-angDiff(c.angle + Math.PI, touchDrive.angle) / 0.3, -1, 1) : 0;
    } else {
      up = true; down = false;
      steer = clamp(d / 0.3, -1, 1);
    }
  }
  // spunto e velocità massima dipendono dal mezzo (massa, motore) — e dalla marcia:
  // la spinta è piena a inizio marcia, cala verso il fuorigiri, e al cambio marcia
  // la frizione stacca per qualche istante (i mezzi pesanti cambiano più lenti)
  if (!c.gear) { c.gear = 1; c.shiftT = 0; }
  const spd = Math.abs(c.speed);
  while (c.gear > 1 && spd < gearTop(c, c.gear - 1) * 0.82) c.gear--;   // scalata
  const lo = c.gear > 1 ? gearTop(c, c.gear - 1) : 0;
  const rpm = clamp((spd - lo) / (gearTop(c, c.gear) - lo), 0, 1);      // giri nella marcia
  if (c.shiftT > 0) c.shiftT--;
  else if (up && c.speed >= 0 && rpm >= 0.97 && c.gear < (c.gears || 4)) {
    c.gear++; c.shiftT = Math.round(7 + c.mass * 4);                    // marcia su
  }
  const pull = c.shiftT > 0 ? 0 : (1.45 - 0.8 * rpm) * (1 - 0.07 * (c.gear - 1));
  if (up) c.speed += c.accel * (c.speed >= 0 ? pull : 1);   // in retro il freno resta pieno
  else if (down) c.speed -= c.accel * 0.9;
  else c.speed *= 0.96;
  c.speed = clamp(c.speed, -c.top * 0.45, c.top);
  if (Math.abs(c.speed) > 0.25)
    c.angle += steer * (c.isBike ? 0.075 : c.isTank ? 0.045 : 0.06) * Math.sign(c.speed) * clamp(Math.abs(c.speed) / 3, 0.45, 1);
  moveBox(c, Math.cos(c.angle) * c.speed, Math.sin(c.angle) * c.speed, c.colH, c.colH);
  if ((c.hitX || c.hitY) && Math.abs(c.speed) > 2.6) { crashCar(c); c.speed *= 0.28; }
  applyKnockback(c);                                    // rimbalzo residuo dagli urti
  // effetti autoritativi (investimenti, idrante, cannone/cingoli): sul client
  // autoritativo li fa il server — qui predìco solo il MOTO del mezzo
  if (!authClient()) {
    runOver(c, true);
    if (c.livery === 'fire' && mDownL) sprayWater(c);   // autopompa: idrante col mouse
    if (c.isTank) { updateTankGun(c); tankCrush(c); }   // carro: torretta + cingoli
  }
  // il player segue l'auto
  player.x = c.x; player.y = c.y;
  // audio motore: i giri salgono dentro la marcia e ricadono alla cambiata
  const rev = c.shiftT > 0 ? 0.1 : (Math.abs(c.speed) < 0.15 && !up ? 0 : rpm);
  engineGain(0.03 + Math.abs(c.speed) * 0.002 + rev * 0.03,
             52 + rev * (c.isBike ? 175 : 125) + Math.abs(c.speed) * 5);
}
function crashCar(c) {
  spawnSparks(c.x + Math.cos(c.angle) * 22, c.y + Math.sin(c.angle) * 22, 6);
  shake(4, 5); sfx.crash();
}

// investe i pedoni davanti all'auto (controllo box orientato)
function runOver(c, byPlayer) {
  const sp = Math.abs(c.speed);
  if (sp < 1.6) return;
  const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
  for (const p of peds) {
    if (p.ko) continue;
    const dx = p.x - c.x, dy = p.y - c.y;
    const lx = dx * ca + dy * sa;         // avanti/indietro nell'auto
    const ly = -dx * sa + dy * ca;        // laterale
    if (Math.abs(lx) < c.w / 2 + p.r && Math.abs(ly) < c.h / 2 + p.r) {
      knockPed(p, c.angle, sp);
      if (byPlayer && p.role !== 'robber') {          // fermare il ladro non è reato
        cash += 5;
        commitCrime(p.role === 'cop' ? 1.1 : 0.7,
          p.role === 'cop' ? '🚨 Hai investito un poliziotto!' : '🚨 Hai investito un passante!');
      }
    }
  }
}

// ---------- Pedoni ----------
function knockPed(p, angle, force) {
  p.ko = true; p.koT = 60 * 7;
  p.getsUp = false; p.angryT = 0;                   // un colpo vero non perdona: niente rialzata
  p.sayT = 0;                                       // a terra non si chiacchiera
  p.kx = Math.cos(angle) * clamp(force, 2, 8);
  p.ky = Math.sin(angle) * clamp(force, 2, 8);
  p.spin = rnd(-0.4, 0.4);
  spawnBlood(p.x, p.y);
  decals.push({ x: p.x, y: p.y, r: rnd(9, 15), life: 60 * 20 });
  if (decals.length > 70) decals.shift();
  // a volte lascia dei soldi
  if (Math.random() < 0.6) pickups.push({ x: p.x + rnd(-6, 6), y: p.y + rnd(-6, 6), v: rndi(10, 60), life: 60 * 22, t: 0 });
  sfx.scream(hear(p.x, p.y, 800));
  sfx.thud();
}
// ---------- Frasi dei pedoni: fumetti contestuali sopra la testa ----------
const SAY_GREET   = ['Ciao {nome}!', 'Ehi, ciao!', 'Bella giornata, eh?', 'Buongiorno!', 'Che traffico oggi…', 'Salve!', 'Hai visto che città?'];
const SAY_WANTED  = ['È lui il ricercato!', 'Aiuto, un criminale!', 'Chiamate la polizia!', 'La polizia ti cerca!', 'Scappate, è lui!', 'Eccolo! È qui!'];
const SAY_PANIC   = ['AAAH!', 'Attento!', 'È impazzito!', 'Aiutooo!', 'Via! Via!', 'Al pazzo!'];
const SAY_COP     = ['FERMO!', 'Mani in alto!', 'Fermati, {nome}!', 'In nome della legge!', 'Non scappare!', 'Ti abbiamo trovato!'];
const SAY_FARE    = ['TAXI! Sono qui!', 'Mi porti in centro?', 'Ho fretta!', 'Finalmente, il taxi!'];
const SAY_HUNGRY  = ['Che fame!', 'La mia pizza?', 'Muoio di fame!', 'Sbrigati, si fredda!'];
const SAY_INJURED = ['AIUTO!', 'Mi fa male tutto…', "Un'ambulanza, presto!", 'Non mi sento bene…'];
const SAY_ROBBER  = ['Non mi prenderai mai!', 'Ah ah, addio!', 'Più veloce, sbirro!', 'Il malloppo è mio!'];
const SAY_CARJACK = ['Al ladro! Al ladro!', 'Torna qui subito!', 'Ti ho visto, sai?!', 'Che maleducato!', 'Chiamo la polizia!', 'Fermati, brigante!', 'La mia assicurazione!'];
// fa dire una frase al pedone; il cooldown evita che parli a raffica
function pedSay(p, list, col, force) {
  if (!force && p.sayCd > 0) return;
  p.say = pick(list).replace('{nome}', playerName || 'tu'); p.sayCol = col || '#20242e';
  p.sayT = 110; p.sayCd = rndi(300, 600);
}
// da tranquilli i pedoni preferiscono marciapiedi, prati e vicoli, non l'asfalto.
// sceglie una direzione che eviti la strada (se possibile) senza sbattere sui muri.
function calmWalkDir(p) {
  const soft = [], road = [];
  for (const d of DIRS) {
    const t = tileAt(Math.floor((p.x + d.x * T) / T), Math.floor((p.y + d.y * T) / T));
    if (t === BUILDING || t === TREE || t === WATER) continue;   // muro: scarta
    (t === ROAD ? road : soft).push(d);
  }
  // di rado attraversa comunque la strada, altrimenti resta sul marciapiede
  if (soft.length && !(road.length && Math.random() < 0.12)) return pick(soft);
  if (road.length) return pick(road);
  return pick(DIRS);
}
// direzione verso il marciapiede più vicino (per uscire dalla carreggiata)
function offRoadDir(wx, wy) {
  const cx = Math.floor(wx / T), cy = Math.floor(wy / T);
  let best = null, bestK = 99;
  for (const d of DIRS) {
    for (let k = 1; k <= 5; k++) {
      const t = tileAt(cx + d.x * k, cy + d.y * k);
      if (t === BUILDING || t === TREE || t === WATER) break;    // direzione bloccata
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
    moveBox(p, p.kx || 0, p.ky || 0, p.r, p.r);   // scivola a terra, ma i muri lo fermano
    if (p.hitX) p.kx *= -0.35;
    if (p.hitY) p.ky *= -0.35;
    p.kx *= 0.86; p.ky *= 0.86;
    p.spin *= 0.96;
    if (p.koT <= 0) {
      if (p.getsUp) {                               // il guidatore scippato si rialza furibondo
        p.ko = false; p.getsUp = false; p.panic = 0;
        p.angryT = 60 * 6;
        pedSay(p, [p.copDress ? 'Ehi! La volante!' : p.stolenBike ? 'Ehi! La mia moto!' : 'Ehi! La mia auto!'], '#c22822', true);
        sfx.yell(hear(p.x, p.y, 700));
      } else p.dead = true;
    }
    return;
  }
  if (p.angryT > 0) { updateAngryDriver(p); return; }
  if (p.role === 'fare' || p.role === 'hungry') {   // cliente (taxi o pizza): aspetta sul marciapiede
    p.walk = 0; p.speed = 0;
    p.facing = Math.atan2(player.y - p.y, player.x - p.x);
    // quando ti vede arrivare ti chiama, ognuno per il suo servizio
    if (dist(p.x, p.y, player.x, player.y) < 220 && Math.random() < 0.02)
      pedSay(p, p.role === 'fare' ? SAY_FARE : SAY_HUNGRY, p.role === 'fare' ? '#8a6410' : '#b04a1e');
    return;
  }
  if (p.role === 'injured') {                       // ferito: resta a terra e invoca aiuto
    p.walk = 0; p.speed = 0;
    if (Math.random() < 0.012) pedSay(p, SAY_INJURED, '#c22822');
    return;
  }
  if (p.role === 'robber') { updateRobber(p); return; }
  if (p.role === 'cop') { updateCop(p); return; }
  if (p.role === 'soldier') { updateSoldier(p); return; }
  // civile: passeggia sui marciapiedi; fugge dalle auto veloci e — nel panico — sbanda in strada
  const threat = nearestThreatCar(p.x, p.y, 150);
  if (threat) { if (p.panic === 0) { sfx.yell(hear(p.x, p.y, 700)); pedSay(p, SAY_PANIC, '#c22822', true); } const a = Math.atan2(p.y - threat.y, p.x - threat.x); p.dir = { x: Math.cos(a), y: Math.sin(a) }; p.speed = 2.4; p.panic = 40; p.thinkCd = 20; }
  else if (p.panic > 0) { p.panic--; p.speed = 2.0; }   // ancora spaventato: corre dove capita, anche sull'asfalto
  else {
    // se tranquillo si è ritrovato in mezzo alla strada, rientra verso il marciapiede
    if (tileTypeAt(p.x, p.y) === ROAD) {
      const back = toNearestSidewalk(p.x, p.y);
      if (back) { p.dir = back; p.speed = 1.3; p.thinkCd = rndi(20, 40); }
    }
    p.thinkCd--;
    if (p.thinkCd <= 0) {
      if (Math.random() < 0.18) { p.dir = { x: 0, y: 0 }; p.speed = 0; }
      else { p.dir = pickWalkDir(p); p.speed = rnd(0.8, 1.5); }
      if (Math.random() < 0.15) sfx.chat(hear(p.x, p.y, 420));   // chiacchiericcio dei passanti vicini
      p.thinkCd = rndi(40, 150);
    }
    // commenta quando Federico gli passa accanto: saluto, o allarme se è ricercato
    if (dist(p.x, p.y, player.x, player.y) < 90 && Math.random() < 0.02)
      pedSay(p, wanted > 0 ? SAY_WANTED : SAY_GREET, wanted > 0 ? '#c22822' : '#20242e');
  }
  moveBox(p, p.dir.x * p.speed, p.dir.y * p.speed, p.r, p.r);
  if (p.hitX) p.dir.x *= -1;
  if (p.hitY) p.dir.y *= -1;
  const mv = Math.abs(p.dir.x) + Math.abs(p.dir.y);
  if (mv > 0.01 && p.speed > 0.1) { p.walk += 0.25; p.facing = Math.atan2(p.dir.y, p.dir.x); } else p.walk = 0;
}
// il derubato appena rialzato: rincorre Federico (o il suo ex mezzo) urlando,
// poi sbollisce e torna a passeggiare come se niente fosse
function updateAngryDriver(p) {
  p.angryT--;
  const tp = nearestPlayer(p.x, p.y);
  const tx = tp.car ? tp.car.x : tp.x;
  const ty = tp.car ? tp.car.y : tp.y;
  const d = dist(p.x, p.y, tx, ty);
  if (p.angryT <= 0 || d > 620) { p.angryT = 0; p.speed = 0; p.thinkCd = 0; return; }   // si arrende
  const a = Math.atan2(ty - p.y, tx - p.x);
  p.facing = a;
  if (d > 40) {
    p.dir = { x: Math.cos(a), y: Math.sin(a) }; p.speed = 2.1;
    moveBox(p, p.dir.x * p.speed, p.dir.y * p.speed, p.r, p.r);
    p.walk += 0.3;
  } else { p.speed = 0; p.walk += 0.45; }           // ti è addosso: pesta i piedi dalla rabbia
  if (p.sayT === 0 && Math.random() < 0.03) pedSay(p, SAY_CARJACK, '#c22822', true);
}
function nearestThreatCar(x, y, range) {
  let best = null, bd = range;
  for (const c of cars) {
    if (Math.abs(c.speed) < 3) continue;
    const d = dist(c.x, c.y, x, y);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

// ---------- Rapinatore in fuga ----------
// corre sempre nella direzione opposta al player, con qualche zigzag,
// rimbalzando sui muri: raggiungilo in volante e fermalo
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
  // ogni tanto ti sfotte mentre scappa
  if (Math.random() < 0.006) pedSay(p, SAY_ROBBER, '#c22822');
}

// ---------- Poliziotto a piedi ----------
const COP_RANGE = 330;
function updateCop(p) {
  const tp = nearestPlayer(p.x, p.y);            // dà la caccia al giocatore più vicino
  const tx = tp.x - p.x, ty = tp.y - p.y, d = Math.hypot(tx, ty) || 1;
  p.dir = { x: tx / d, y: ty / d }; p.speed = 2.0;
  p.facing = Math.atan2(ty, tx);
  if (frame % 120 === 0 && Math.random() < 0.5) sfx.whistle(hear(p.x, p.y, 900));   // fischietto d'inseguimento
  if (d < 420 && Math.random() < 0.02) pedSay(p, SAY_COP, '#20407a');   // intima l'alt mentre ti dà la caccia

  // player in macchina (quasi) ferma: l'agente corre alla portiera, la apre e lo arresta
  const canBust = tp.car && Math.abs(tp.car.speed) < 1.0;
  if (canBust && d < 42) {
    sfx.door();                                   // apre la portiera...
    asPlayer(tp, arrestPlayer);                   // ...e porta in centrale QUEL giocatore
    return;
  }
  // si ferma poco più vicino per sparare (ma per l'arresto arriva fino alla portiera)
  const advance = (d > 90 || canBust) ? p.speed : 0.3;
  moveBox(p, p.dir.x * advance, p.dir.y * advance, p.r, p.r);
  p.walk += advance > 0.5 ? 0.25 : 0;
  if (p.shootCd > 0) p.shootCd--;
  if (d < COP_RANGE && p.shootCd === 0 && lineClear(p.x, p.y, tp.x, tp.y)) {
    copShoot(p, tp); p.shootCd = rndi(42, 66);
  }
}
function copShoot(p, tp) {
  tp = tp || nearestPlayer(p.x, p.y);
  const a = Math.atan2(tp.y - p.y, tp.x - p.x) + rnd(-0.13, 0.13);
  const bx = p.x + Math.cos(a) * 12, by = p.y + Math.sin(a) * 12;
  bullets.push({ x: bx, y: by, vx: Math.cos(a) * 11, vy: Math.sin(a) * 11, life: 60, fromPlayer: false });
  spawnMuzzle(bx, by, a);
  sfx.copShoot(hear(p.x, p.y, 700));
}
// linea di tiro libera da edifici (campionatura)
function lineClear(x0, y0, x1, y1) {
  const steps = Math.ceil(dist(x0, y0, x1, y1) / T);
  for (let i = 1; i < steps; i++) {
    const t = i / steps, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    if (solidTile(Math.floor(x / T), Math.floor(y / T))) return false;
  }
  return true;
}

// ---------- IA veicoli ----------
// spazio libero davanti al veicolo (cono in avanti) → distanza di sicurezza
function gapAhead(c, maxLook) {
  let gap = maxLook;
  const ax = c.dir.x, ay = c.dir.y;
  for (const o of cars) {
    if (o === c || o.role === 'parked') continue;
    const dx = o.x - c.x, dy = o.y - c.y;
    const along = dx * ax + dy * ay;                   // avanti (>0)
    const side = -dx * ay + dy * ax;                   // laterale
    if (along > 0 && along < gap && Math.abs(side) < 18) gap = along;
  }
  return gap;
}
// distanza fino alla linea d'arresto se l'incrocio ha semaforo rosso (Infinity se libero)
function signalStop(c) {
  const e = edges[c.edge];
  const node = c.ed > 0 ? nodes[e.b] : nodes[e.a];
  if (!node.signal) return Infinity;                   // incrocio senza semaforo
  const horiz = Math.abs(c.dir.x) >= Math.abs(c.dir.y);
  if (horiz ? greenH : greenV) return Infinity;        // verde per il mio asse
  const distToNode = (c.ed > 0 ? (1 - c.t) : c.t) * e.len;
  const gap = distToNode - HALF_ROAD * 1.1;            // fermati prima dell'incrocio
  return gap > 0 ? gap : Infinity;                     // se già dentro, prosegui e svuota
}
// arrivo a un incrocio → scegli il prossimo arco (per lo più prosegue dritto)
function enterNode(c, nodeIdx) {
  const node = nodes[nodeIdx], inDir = c.dir, outs = [];
  for (const ei of node.edges) {
    if (edges[ei].dead) continue;                           // strada soppressa: non si imbocca
    if (ei === c.edge && node.edges.length > 1) continue;   // evita l'inversione se ci sono alternative
    const e = edges[ei], startsHere = e.a === nodeIdx, ed = startsHere ? 1 : -1;
    const tan = edgeTangent(e, startsHere ? 0 : 1);
    const align = (tan.x * ed) * inDir.x + (tan.y * ed) * inDir.y;   // 1 = dritto
    outs.push({ ei, ed, align });
  }
  let ch;
  if (!outs.length) ch = { ei: c.edge, ed: -c.ed };          // vicolo cieco → inversione a U
  else { outs.sort((p, q) => q.align - p.align); ch = Math.random() < 0.6 ? outs[0] : pick(outs); }
  c.edge = ch.ei; c.ed = ch.ed; c.t = ch.ed > 0 ? 0 : 1;
  railPlace(c);
}
// nodo verso cui punta un veicolo su rotaia + distanza che manca per arrivarci
function carTargetNode(c) {
  const e = edges[c.edge];
  return { ni: c.ed > 0 ? e.b : e.a,
           d:  (c.ed > 0 ? (1 - c.t) : c.t) * e.len };
}
// ---- precedenza agli incroci: due auto AI non si infilano insieme nello stesso
// incrocio. `c` cede (frena prima della linea) se un'altra auto sta già
// attraversando l'incrocio o vi arriverà prima. Priorità come ordine totale:
// passa chi è più vicino al nodo; a parità, id più basso. Essendo un ordine
// totale, in ogni conflitto cede esattamente una delle due → nessuna collisione
// e nessuno stallo (niente deadlock circolare agli incroci a 4 vie).
function crossingYield(c, ni, myDist) {
  const node = nodes[ni];
  const WATCH = HALF_ROAD * 3.4;                      // inizia a “guardare” l'incrocio da qui
  const BOX   = HALF_ROAD * 1.3;                      // raggio dell'incrocio vero e proprio
  const stopGap = myDist - HALF_ROAD * 1.15;          // dove fermarsi (prima del box)
  if (stopGap <= 0 || myDist > WATCH) return Infinity; // già impegnato nel box, o ancora lontano
  const brake = clamp((stopGap - 6) * 0.06, 0, c.maxSpeed);
  for (const o of cars) {
    if (o === c || o.role !== 'traffic') continue;    // cede solo ad altre auto AI
    if (o.edge === c.edge) continue;                  // stessa via: ci pensano gapAhead / le corsie
    const od = dist(o.x, o.y, node.x, node.y);
    if (od > WATCH) continue;                         // non è a questo incrocio
    if (c.dir.x * o.dir.x + c.dir.y * o.dir.y < -0.5) continue; // opposta: tiene la sua corsia, nessun conflitto
    if (od < BOX) return brake;                       // sta già occupando l'incrocio → cedo
    const ot = carTargetNode(o);                      // in arrivo sullo stesso incrocio?
    if (ot.ni !== ni) continue;
    if (ot.d < myDist - 4 || (Math.abs(ot.d - myDist) <= 4 && o.id < c.id)) return brake; // arriva prima → cedo
  }
  return Infinity;
}
function updateCar(c) {
  if (c.driver === 'player') return;
  if (c.role === 'parked') { c.speed *= 0.8; applyKnockback(c); return; }   // tamponata: slitta via
  if (c.role === 'police') { updatePoliceCar(c); return; }
  if (c.role === 'armycar') { updateArmyCar(c); return; }
  // ---- traffico su rotaia: segue la strada anche in curva, guida sensata ----
  const e = edges[c.edge];
  let cap = c.maxSpeed;
  // rallenta in curva (come un vero autista): guarda quanto gira poco più avanti
  const tA = edgeTangent(e, c.t), tB = edgeTangent(e, clamp(c.t + c.ed * 0.06, 0, 1));
  const turn = Math.abs(angDiff(Math.atan2(tA.y, tA.x), Math.atan2(tB.y, tB.x)));
  cap = Math.min(cap, c.maxSpeed * (1 - clamp(turn * 1.6, 0, 0.6)));
  // semaforo rosso
  const sg = signalStop(c);
  if (sg !== Infinity) cap = Math.min(cap, clamp((sg - 24) * 0.05, 0, c.maxSpeed));
  // auto che precede (mantiene le distanze, niente tamponamenti)
  const gap = gapAhead(c, T * 5);
  cap = Math.min(cap, clamp((gap - 30) * 0.15, 0, c.maxSpeed));
  // incrocio senza semaforo → rallenta e dà un'occhiata
  const nodeAheadIdx = c.ed > 0 ? e.b : e.a;
  const nodeAhead = nodes[nodeAheadIdx];
  const distNode = (c.ed > 0 ? (1 - c.t) : c.t) * e.len;
  if (!nodeAhead.signal && distNode < HALF_ROAD * 1.6) cap = Math.min(cap, c.maxSpeed * 0.5);
  // precedenza al traffico che attraversa l'incrocio (niente collisioni fra auto AI)
  const yg = crossingYield(c, nodeAheadIdx, distNode);
  if (yg !== Infinity) cap = Math.min(cap, yg);
  // passaggio a livello: al treno il traffico si ferma (le volanti in caccia no,
  // updatePoliceCar non passa di qui; anche l'esercito prosegue)
  if (trainBlocking(c)) cap = 0;
  // accelerazione/frenata morbida (lo spunto dipende dal mezzo)
  c.speed += clamp(cap - c.speed, -0.6, c.accel * 1.4);
  if (c.speed < 0) c.speed = 0;
  // clacson: bloccato da qualcuno (non dal semaforo) → dopo un po' protesta
  if (gap < T * 2.2 && c.speed < 0.7 && sg === Infinity) {
    c.stuckT = (c.stuckT || 0) + 1;
    if (c.stuckT > 70 && Math.random() < 0.03) sfx.horn(hear(c.x, c.y, 850), c);
  } else c.stuckT = 0;
  // avanza lungo l'arco
  c.t += c.ed * (c.speed / Math.max(1, e.len));
  if (c.ed > 0 && c.t >= 1) enterNode(c, e.b);
  else if (c.ed < 0 && c.t <= 0) enterNode(c, e.a);
  else railPlace(c);
  // colpita: sbanda fuori corsia (kox/koy) e poi ci rientra dolcemente,
  // perché railPlace la riporta in carreggiata man mano che la spinta si esaurisce
  if (c.kvx || c.kvy || c.kox || c.koy) {
    c.kox = (c.kox + c.kvx) * 0.9; c.koy = (c.koy + c.kvy) * 0.9;
    c.kvx *= 0.85; c.kvy *= 0.85;
    if (Math.abs(c.kvx) < 0.05) c.kvx = 0;
    if (Math.abs(c.kvy) < 0.05) c.kvy = 0;
    if (Math.abs(c.kox) < 0.05) c.kox = 0;
    if (Math.abs(c.koy) < 0.05) c.koy = 0;
    const rx = c.x, ry = c.y;                 // posizione in corsia (railPlace)
    moveBox(c, c.kox, c.koy, c.colH, c.colH);
    c.kox = c.x - rx; c.koy = c.y - ry;       // l'offset si ferma dove si è fermata l'auto
  }
  runOverPlayer(c, false);                              // il traffico può urtare un player a piedi
  runOver(c, false);
}
function updatePoliceCar(c) {
  c.lightPhase += 0.2;
  const tp = nearestPlayer(c.x, c.y);
  const target = Math.atan2(tp.y - c.y, tp.x - c.x);
  c.angle = steerToward(c.angle, target, 0.07);
  const d = dist(c.x, c.y, tp.x, tp.y);
  // bersaglio a tiro (a piedi, o fermo in macchina): la volante accosta
  // e l'agente scende a piedi per sparare o venirti ad arrestare
  const playerStopped = !tp.car || Math.abs(tp.car.speed) < 1.2;
  if (d < 150 && playerStopped && wanted > 0) { copStepsOut(c); return; }
  c.speed = d > 90 ? c.maxSpeed : c.maxSpeed * 0.4;
  moveBox(c, Math.cos(c.angle) * c.speed, Math.sin(c.angle) * c.speed, c.colH, c.colH);
  if (c.hitX || c.hitY) c.angle += rnd(-0.7, 0.7);
  applyKnockback(c);                                    // rimbalzo residuo dagli urti
  c.dir = { x: Math.cos(c.angle), y: Math.sin(c.angle) };
  runOverPlayer(c, true);                               // la volante può investire (e uccidere) un player a piedi
  runOver(c, false);
}
// l'agente scende dalla volante: la macchina resta lì, lui prosegue a piedi
// (da lì in poi spara con updateCop e, se sei in auto, ti apre la portiera)
function copStepsOut(c) {
  const nx = Math.cos(c.angle + Math.PI / 2), ny = Math.sin(c.angle + Math.PI / 2);
  let ex = c.x + nx * (c.h / 2 + 14), ey = c.y + ny * (c.h / 2 + 14);
  if (boxHits(ex, ey, 7, 7)) { ex = c.x - nx * (c.h / 2 + 14); ey = c.y - ny * (c.h / 2 + 14); }
  if (boxHits(ex, ey, 7, 7)) { ex = c.x; ey = c.y; }
  const p = makePed(ex, ey, 'cop');
  p.shootCd = rndi(30, 55);                       // un attimo per prendere la mira
  peds.push(p);
  pedSay(p, SAY_COP, '#20407a', true);
  c.role = 'parked'; c.wasPolice = true; c.speed = 0;   // la volante resta accostata
  sfx.door();
}
// investimento del player a piedi (box orientato dell'auto); strong=volante → letale
function runOverPlayer(c, strong) {
  const sp = Math.abs(c.speed);
  if (sp < (strong ? 2.4 : 3)) return;
  const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
  eachActivePlayer(v => {
    if (v.car || v.downT > 0) return;                   // in auto/a terra non lo si investe a piedi
    const dx = v.x - c.x, dy = v.y - c.y;
    const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca;
    if (Math.abs(lx) >= c.w / 2 + v.r || Math.abs(ly) >= c.h / 2 + v.r) return;
    asPlayer(v, () => {
      if (strong) {
        hurtPlayer(18 + sp * 3, c.angle);               // può portare a 0 la salute
        moveBox(player, ca * sp * 1.4, sa * sp * 1.4, player.r, player.r);
        shake(6, 7);
      } else hurtPlayer(6, c.angle);                    // urto del traffico: meno grave
    });
  });
}

// ---------- Collisioni auto ↔ auto ----------
// ogni veicolo è approssimato da due cerchi (muso e coda) → forma allungata
// (la moto è più corta e stretta: cerchi ravvicinati e raggio ridotto)
function carCircles(c) {
  const off = c.isBike ? 8 : c.isTank ? 16 : 13;
  const cx = Math.cos(c.angle) * off, cy = Math.sin(c.angle) * off;
  return [[c.x + cx, c.y + cy], [c.x - cx, c.y - cy]];
}
const carRadius = c => c.isBike ? 7 : c.isTank ? 14 : 11;
// applica uno spostamento a un'auto rispettandone il tipo di moto
function shoveCar(c, dx, dy) {
  if (c.role === 'traffic' && c.edge != null) {         // auto su rotaia: arretra lungo la corsia
    const along = dx * c.dir.x + dy * c.dir.y;
    c.t = clamp(c.t + (along / Math.max(1, edges[c.edge].len)) * c.ed, 0, 1);
    moveBox(c, dx, dy, c.colH, c.colH);
  } else {                                              // parcheggiate / player / polizia
    moveBox(c, dx, dy, c.colH, c.colH);
  }
}
// velocità vettoriale di un veicolo: marcia + spinta residua dagli urti
const carVel = c => ({ x: Math.cos(c.angle) * c.speed + c.kvx, y: Math.sin(c.angle) * c.speed + c.kvy });
// trasferisce un cambio di velocità al modello di moto del veicolo:
// la parte nel senso di marcia agisce sul gas/freno, il resto è scivolata (kv)
function applyImpulse(c, dvx, dvy) {
  // parcheggiate (nessun gas) e polizia (il gas lo decide l'inseguimento,
  // c.speed viene riscritto ogni frame): tutta la spinta è scivolata
  if (c.role === 'parked' || c.role === 'police' || c.role === 'armycar') { c.kvx += dvx; c.kvy += dvy; return; }
  const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
  const along = dvx * ca + dvy * sa;
  c.speed += along;
  c.kvx += dvx - ca * along;
  c.kvy += dvy - sa * along;
}
// muove il veicolo con la spinta residua (rispettando i muri) e la smorza
function applyKnockback(c) {
  if (!c.kvx && !c.kvy) return;
  moveBox(c, c.kvx, c.kvy, c.colH, c.colH);
  if (c.hitX) { if (Math.abs(c.kvx) > 2.2) spawnSparks(c.x, c.y, 3); c.kvx *= -0.35; }  // sbatte sul muro
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
      if (ddx * ddx + ddy * ddy > 60 * 60) continue;    // broad-phase
      // il carro armato lanciato non rimbalza sulle auto: ci passa sopra (tankCrush)
      if ((a.isTank && Math.abs(a.speed) >= 1.2) || (b.isTank && Math.abs(b.speed) >= 1.2)) continue;
      const ac = carCircles(a), bc = carCircles(b), rr = carRadius(a) + carRadius(b);
      let pen = 0, nx = 0, ny = 0;
      for (const p of ac) for (const q of bc) {
        const dx = q[0] - p[0], dy = q[1] - p[1], d = Math.hypot(dx, dy) || 0.001, pp = rr - d;
        if (pp > pen) { pen = pp; nx = dx / d; ny = dy / d; }   // normale da a → b
      }
      if (pen <= 0) continue;
      // sovrapposizione profonda (i cerchi si scavalcano): la normale può
      // puntare all'indietro — riallineala alla direzione centro → centro
      if (nx * ddx + ny * ddy < 0) { nx = -nx; ny = -ny; }
      // chi pesa di più si sposta di meno: un camion spinge via una moto
      const wa = (a.role === 'parked' ? 0.18 : 1) / (a.mass || 1);
      const wb = (b.role === 'parked' ? 0.18 : 1) / (b.mass || 1);
      const tot = wa + wb;
      shoveCar(a, -nx * pen * (wb / tot), -ny * pen * (wb / tot));
      shoveCar(b,  nx * pen * (wa / tot),  ny * pen * (wa / tot));
      // rimbalzo: urto parzialmente elastico — l'impulso dipende dalle masse
      // e dalla velocità con cui i due si avvicinano (un camion lanciato fa
      // volare una moto, una moto contro un camion ci rimbalza addosso)
      const va = carVel(a), vb = carVel(b);
      const vn = (vb.x - va.x) * nx + (vb.y - va.y) * ny;   // velocità di avvicinamento
      if (vn < 0) {
        const ma = a.mass || 1, mb = b.mass || 1;
        const jn = -(1 + 0.45) * vn / (1 / ma + 1 / mb);    // 0.45 = restituzione (quanto rimbalza)
        applyImpulse(a, -nx * jn / ma, -ny * jn / ma);
        applyImpulse(b,  nx * jn / mb,  ny * jn / mb);
        // impatto: scintille, scossone e danno proporzionali alla botta
        const imp = -vn;
        if (imp > 1.6) {
          spawnSparks((a.x + b.x) / 2, (a.y + b.y) / 2, Math.min(10, Math.round(2 + imp * 1.4)));
          if (a.driver === 'player' || b.driver === 'player') {
            shake(Math.min(8, 2 + imp * 0.8), Math.min(9, 3 + imp * 0.7)); sfx.crash();
            const other = a.driver === 'player' ? b : a;
            if (other.role !== 'parked') damageCar(other, Math.min(16, 2 + imp * 2.2));   // sperona il traffico
          }
        }
      }
    }
  }
  if (player.car) { player.x = player.car.x; player.y = player.car.y; }
}
// Collisioni della MIA auto contro le auto REMOTE (giocatori, mezzi abbandonati,
// volanti dei rivali ricercati). Sono interpolate e "di proprietà" di un altro
// client: qui NON le muoviamo, spostiamo e facciamo rimbalzare solo la nostra
// auto (l'altro fa lo stesso dalla sua parte). Prima si attraversavano; ora si
// scontrano davvero. Ogni veicolo è due cerchi, come in resolveCarCollisions.
function resolveRemoteCarCollisions() {
  if (!netActive() || !player.car) return;
  const a = player.car;
  if (a.isTank && Math.abs(a.speed) >= 1.2) return;   // il carro lanciato ci passa sopra
  const remotes = netSolidCars([]);
  for (const b of remotes) {
    const ddx = b.x - a.x, ddy = b.y - a.y;
    if (ddx * ddx + ddy * ddy > 60 * 60) continue;     // broad-phase
    const ac = carCircles(a), bc = carCircles(b), rr = carRadius(a) + carRadius(b);
    let pen = 0, nx = 0, ny = 0;
    for (const p of ac) for (const q of bc) {
      const dx = q[0] - p[0], dy = q[1] - p[1], d = Math.hypot(dx, dy) || 0.001, pp = rr - d;
      if (pp > pen) { pen = pp; nx = dx / d; ny = dy / d; }
    }
    if (pen <= 0) continue;
    if (nx * ddx + ny * ddy < 0) { nx = -nx; ny = -ny; }
    shoveCar(a, -nx * pen, -ny * pen);                 // la remota è immobile per noi: ci scostiamo tutto noi
    const va = carVel(a), vb = carVel(b);
    const vn = (vb.x - va.x) * nx + (vb.y - va.y) * ny; // velocità di avvicinamento
    if (vn < 0) {
      const ma = a.mass || 1, mb = (b.mass || 1) * 8;   // le remote pesano molto: ci respingono
      const jn = -(1 + 0.4) * vn / (1 / ma + 1 / mb);
      applyImpulse(a, -nx * jn / ma, -ny * jn / ma);
      const imp = -vn;
      if (imp > 1.6) {                                  // botta vera: scintille, scossone, danno
        spawnSparks((a.x + b.x) / 2, (a.y + b.y) / 2, Math.min(10, Math.round(2 + imp * 1.4)));
        shake(Math.min(8, 2 + imp * 0.8), Math.min(9, 3 + imp * 0.7)); sfx.crash();
        damageCar(a, Math.min(16, 2 + imp * 2.2));
      }
    }
  }
  player.x = a.x; player.y = a.y;
}

// ---------- Proiettili ----------
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
          if (p.role === 'cop') commitCrime(1.2, '🚨 Hai sparato a un poliziotto!');
          else if (p.role === 'soldier') armyAlertT = ARMY_ALERT_T;   // sparare ai soldati li scatena
          else if (p.role !== 'robber') { asPlayer(b.owner || player, () => { cash += 3; }); commitCrime(0.6, '🚨 Hai sparato a un passante!'); }
          hit = true; break;
        }
      }
      // PvP (solo server autoritativo): il colpo può stendere un ALTRO giocatore
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
          damageCar(c, b.dmg || 10, Math.atan2(b.vy, b.vx)); spawnSparks(b.x, b.y, 3); sfx.clank(hear(b.x, b.y, 700)); hit = true; break;
        }
      }
    } else if (!hit && !b.fromPlayer) {
      // proiettile ostile: di un poliziotto/soldato oppure di un RIVALE in
      // multigiocatore (fromNet): in quel caso il danno è quello dell'arma
      // e il colpo resta "firmato" per l'eventuale kill credit (vittima autoritativa).
      // Può colpire QUALSIASI giocatore (in autoritativo il primo raggiunto).
      eachActivePlayer(v => {
        if (hit || v.downT > 0) return;
        if (v.car) {
          const c = v.car;
          if (Math.abs(b.x - c.x) < c.w / 2 + 2 && Math.abs(b.y - c.y) < c.h / 2 + 4) {
            if (b.fromNet) netRegisterHit(b.fromNet);
            if (c.isTank) { damageCar(c, 1); sfx.ricochet(hear(b.x, b.y, 620)); }   // la corazza ride dei proiettili
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
function damageCar(c, dmg, angle) {
  c.health -= dmg;
  if (c.health <= 30 && !c.smoking) c.smoking = true;
  if (c.smoking && frame % 4 === 0) parts.push({ x: c.x + rnd(-10, 10), y: c.y + rnd(-8, 8), vx: rnd(-0.4, 0.4), vy: rnd(-1.4, -0.5), life: rndi(20, 40), color: '#555', size: rnd(4, 8), kind: 'smoke' });
  // molto malridotta: può prendere fuoco — da lì in poi si consuma da sola (updateBurningCars)
  if (!c.burning && c.health > 0 && c.health <= 25 && (c.health <= 12 || Math.random() < 0.35)) igniteCar(c);
  if (c.health <= 0) explodeCar(c);
}
// il veicolo prende fuoco: miccia accesa, conviene allontanarsi
function igniteCar(c) {
  c.burning = true; c.burnSeed = rnd(0, TAU); c.burnWet = 0;
  if (c.driver === 'player') toast('🔥 La macchina è in fiamme! Scendi prima che esploda!');
}
// veicoli in fiamme: il fuoco li consuma piano piano finché non esplodono;
// i passanti scappano dal rogo e l'idrante dell'autopompa può ancora spegnerli
function updateBurningCars() {
  for (let i = cars.length - 1; i >= 0; i--) {
    const c = cars[i];
    // le auto ammaccate (ma non ancora in fiamme) sbuffano un filo di fumo
    if (c.smoking && !c.burning && frame % 10 === 0)
      parts.push({ x: c.x + rnd(-8, 8), y: c.y + rnd(-6, 6), vx: rnd(-0.3, 0.3), vy: rnd(-1.1, -0.4), life: rndi(16, 30), color: '#666', size: rnd(3, 6), kind: 'smoke' });
    if (!c.burning) continue;
    if (frame % 3 === 0) parts.push({ x: c.x + rnd(-c.w / 3, c.w / 3), y: c.y + rnd(-c.h / 3, c.h / 3),
      vx: rnd(-0.3, 0.3), vy: rnd(-1.7, -0.7), life: rndi(12, 26),
      color: pick(['#ff5a2a', '#ff8a2a', '#ffd23a']), size: rnd(3, 7), kind: 'smoke' });
    if (frame % 8 === 0) parts.push({ x: c.x + rnd(-10, 10), y: c.y - 6,
      vx: rnd(-0.3, 0.3), vy: rnd(-1.6, -0.9), life: rndi(24, 44), color: '#444', size: rnd(5, 9), kind: 'smoke' });
    // i passanti scappano dal rogo
    if (frame % 6 === 0) for (const p of peds) {
      if (p.ko || dist(p.x, p.y, c.x, c.y) >= 90) continue;
      if (p.panic === 0) { sfx.yell(hear(p.x, p.y, 700)); pedSay(p, SAY_PANIC, '#c22822', true); }
      const a = Math.atan2(p.y - c.y, p.x - c.x);
      p.dir = { x: Math.cos(a), y: Math.sin(a) }; p.speed = 2.4; p.panic = 40; p.thinkCd = 20;
    }
    // il fuoco consuma la carrozzeria: ~4-5 secondi di miccia, poi il botto
    c.health -= 0.09;
    if (c.health <= 0) explodeCar(c);
  }
}
function explodeCar(c) {
  if (c.exploded) return; c.exploded = true;   // guardia anti doppio-botto nelle reazioni a catena
  netDestroyCar(c);                            // multigiocatore: togli la sagoma ferma dagli altri schermi
  const i = cars.indexOf(c); if (i >= 0) cars.splice(i, 1);
  spawnExplosion(c.x, c.y);
  shake(9, 12); sfx.boom();
  // onda d'urto: sbalza pedoni e player vicini
  for (const p of peds) if (!p.ko && dist(p.x, p.y, c.x, c.y) < 90) knockPed(p, Math.atan2(p.y - c.y, p.x - c.x), 7);
  // dentro il carro armato si è al riparo dall'onda d'urto (se a scoppiare non è lui)
  eachActivePlayer(v => {
    if (v.car && v.car.isTank && v.car !== c) return;
    if (dist(v.x, v.y, c.x, c.y) < 90) asPlayer(v, () => hurtPlayer(28, Math.atan2(v.y - c.y, v.x - c.x)));
  });
  // ...e scheggia le auto accanto, che a loro volta possono incendiarsi: reazione a catena!
  for (const o of [...cars]) if (dist(o.x, o.y, c.x, c.y) < 95) damageCar(o, 26);
  if (player.car === c) { player.car = null; engineGain(0); }
}

// ---------- Punteggio, serie di uccisioni e taglie (PvP multigiocatore) ----------
const KILL_POINTS = 100;                          // punti base per un'uccisione
// nomi delle serie ravvicinate, per il messaggio a schermo
const STREAK_NAME = { 2: 'Doppia uccisione!', 3: 'Tripla uccisione!', 4: 'Quadrupla!',
                      5: 'Scatenato!', 7: 'Inarrestabile!', 10: 'LEGGENDARIO!' };
// più uccisioni fai senza morire, più alta è la TAGLIA sulla tua testa: chi ti
// stende la incassa (in punti e in soldi). Diventi il bersaglio numero uno.
function bountyForStreak(s) {
  if (s >= 10) return 1000;
  if (s >= 7)  return 500;
  if (s >= 5)  return 300;
  if (s >= 3)  return 150;
  return 0;
}
// un messaggio per un giocatore: in locale è un toast immediato, sul server
// autoritativo va in coda e parte col prossimo snapshot (vedi snapshotFor).
function pushEvent(pl, text) {
  if (!MP) { toast(text); return; }
  (pl.events || (pl.events = [])).push(text);
}
// accredita a `killer` l'uccisione di `victim`. `vb` è la taglia della vittima
// CATTURATA PRIMA del colpo (startDown l'azzera), che il killer incassa.
function creditKill(killer, victim, vb) {
  killer.kills  = (killer.kills  | 0) + 1;
  killer.streak = (killer.streak | 0) + 1;
  killer.score  = (killer.score  | 0) + KILL_POINTS;
  victim.deaths = (victim.deaths | 0) + 1;
  vb = vb | 0;
  const streakMsg = STREAK_NAME[killer.streak] ? ' · ' + STREAK_NAME[killer.streak] : '';
  pushEvent(killer, (vb > 0 ? `💀 Hai steso ${victim.name}! Taglia +$${vb}` : `💀 Hai steso ${victim.name}!`) + streakMsg);
  pushEvent(victim, `☠️ ${killer.name} ti ha steso!`);
  if (vb > 0) { asPlayer(killer, () => { cash += vb; }); killer.score += vb; }   // incassa la taglia
  // la nuova serie può alzare la taglia sulla testa del killer
  const nb = bountyForStreak(killer.streak);
  if (nb > (killer.bounty | 0)) pushEvent(killer, `🎯 Taglia su di te: $${nb} — sei un bersaglio!`);
  killer.bounty = nb;
}

// ---------- Danno al player / morte ----------
function hurtPlayer(dmg, angle) {
  if (downT > 0) return;                          // già a terra: niente danni extra
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
// il player è fuori gioco: schermata "Ti hanno ucciso" / "Arrestato" con
// countdown di 3 secondi, poi riparte (ospedale se morto, centrale se arrestato)
function startDown(kind) {
  if (downT > 0) return;                          // già a terra: niente doppioni
  downT = 180; downKind = kind;
  player.streak = 0; player.bounty = 0;           // muori/ti arrestano: serie e taglia azzerate
  netReportDown(kind);                            // multigiocatore: conta la morte e accredita l'uccisore
  sfx.bust();
  if (kind === 'dead') { cash = Math.floor(cash * 0.5); updateCash(); }
  wantedHeat = 0; wanted = 0; crimeCd = 0; updateStars();
  // la caccia finisce: agenti via, volanti tornano auto qualsiasi
  for (let i = peds.length - 1; i >= 0; i--) if (peds[i].role === 'cop') peds.splice(i, 1);
  for (const c of cars) if (c.role === 'police') c.role = 'parked';
  // ...e anche l'esercito rientra in caserma
  armyAlertT = 0;
  for (let i = peds.length - 1; i >= 0; i--) if (peds[i].role === 'soldier') peds.splice(i, 1);
  for (const c of cars) if (c.role === 'armycar') c.role = 'parked';
  // l'auto resta in sosta dove l'hai lasciata (come scendendo con E): senza
  // ruolo 'parked' updateCar la tratterebbe come traffico su una rotaia che non ha
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
    $('#bigTitle').textContent = kind === 'busted' ? 'Arrestato' : 'Ti hanno ucciso';
    $('#bigCount').textContent = '3';
  }
}
// scala il countdown a schermo e, allo scadere, rimette in gioco il player
function updateDown() {
  downT--;
  const el = $('#bigCount');
  if (el) el.textContent = Math.max(1, Math.ceil(downT / 60));
  if (downT <= 0) respawnPlayer();
}
function respawnPlayer() {
  player.health = 100; player.hurtCd = 0; updateHealth();
  // morto → ospedale più vicino; arrestato → centrale di polizia più vicina
  const type = downKind === 'busted' ? 'police' : 'hospital';
  let best = null, bd = Infinity;
  for (const l of landmarks) if (l.type === type) { const d = dist(l.cx, l.cy, player.x, player.y); if (d < bd) { bd = d; best = l; } }
  const p = best ? best.door : (randomRoadNear(player.x, player.y, 500, 1100) || nodes[Math.floor(nodes.length / 2)]);
  player.x = p.x; player.y = p.y;
  const el = $('#bigMsg'); if (el) el.classList.add('hidden');
  toast(downKind === 'busted' ? '👮 Rilasciato dalla centrale — comportati bene!'
                              : '🏥 Rimesso in sesto dall\'ospedale');
  downKind = null;
}

// ---------- Popolamento dinamico (spawn/despawn attorno al player) ----------
function managePopulation() {
  const despawnR = Math.max(vw, vh) * 1.3 + 300;
  const nP = MP ? Math.max(1, MP.length) : 1;    // scala la densità col numero di giocatori
  const fp = spawnFocus();                        // giocatore attorno a cui spawnare (a rotazione)
  // Centro dell'inquadratura: sul client segue la camera (che può essere "incollata"
  // ai bordi del mondo, quindi il player NON è al centro), sul server headless coincide
  // col giocatore. Spawnare attorno a QUESTO centro, oltre la semi-diagonale della vista,
  // garantisce che nessuna entità nasca dentro il rettangolo visibile: niente pop-in in campo.
  const scx = cameraActive ? camX + vw / 2 : fp.x;
  const scy = cameraActive ? camY + vh / 2 : fp.y;
  const viewDiag = Math.hypot(vw, vh) / 2;         // distanza dal centro all'angolo visibile più lontano
  const inMin = viewDiag + 80;                     // appena FUORI dall'angolo dell'inquadratura
  const inMax = viewDiag + Math.max(vw, vh) * 0.5; // fascia di spawn subito oltre il bordo (entro il raggio di despawn)
  // rimuove entità morte o troppo lontane da OGNI giocatore
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
  // conteggi per ruolo in UN passaggio (niente .filter che alloca ogni frame)
  let nCiv = 0, nCop = 0, nSoldier = 0;
  for (const p of peds) { if (p.role === 'civ') nCiv++; else if (p.role === 'cop') nCop++; else if (p.role === 'soldier') nSoldier++; }
  let nTraf = 0, nPark = 0, nTaxi = 0, nDeliv = 0, nArmy = 0, nPolice = 0;
  for (const c of cars) {
    if (c.role === 'traffic') nTraf++; else if (c.role === 'armycar') nArmy++; else if (c.role === 'police') nPolice++;
    if (c.parkedDecor && c.role === 'parked') nPark++;
    if (c.isTaxi) nTaxi++;
    if (c.isDelivery) nDeliv++;
  }
  // civili
  if (nCiv < 26 * nP && frame % 8 === 0) { const p = randomWalkNear(scx, scy, inMin, inMax); if (p) peds.push(makePed(p.x, p.y, 'civ')); }
  // traffico in movimento
  if (nTraf < 14 * nP && frame % 12 === 0) { const c = spawnTrafficNear(scx, scy, inMin, inMax); if (c) cars.push(c); }
  // auto parcheggiate
  if (nPark < 14 * nP && frame % 16 === 0) { const p = randomParkingNear(scx, scy, inMin, inMax); if (p) cars.push(makeParked(p.x, p.y, p.angle)); }
  // qualche taxi in giro per la città, sempre
  if (frame % 40 === 0 && nTaxi < 3 * nP) {
    const c = spawnTrafficNear(scx, scy, inMin, inMax);
    if (c) { makeTaxi(c); cars.push(c); }
  }
  // ...e almeno un paio di moto delle consegne
  if (frame % 40 === 20 && nDeliv < 2 * nP) {
    const c = spawnTrafficNear(scx, scy, inMin, inMax);
    if (c) { makeDeliveryMoto(c); cars.push(c); }
  }
  // rimpiazza (fuori campo) i mezzi di servizio davanti a ogni struttura speciale
  if (frame % 120 === 0) for (const lm of landmarks) {
    const d = distToNearestPlayer(lm.cx, lm.cy);
    if (d < 600 || d > despawnR) continue;
    if (lm.type === 'army') {                          // ripristina il presidio della base
      const tanks = cars.filter(c => c.role === 'parked' && c.serviceType === 'army' && dist(c.x, c.y, lm.cx, lm.cy) < 600).length;
      for (let k = tanks; k < (SERVICE_COUNT.army || 1); k++) parkServiceCar(lm);
      const jeeps = cars.filter(c => c.role === 'parked' && c.serviceType === 'armyjeep' && dist(c.x, c.y, lm.cx, lm.cy) < 600).length;
      for (let k = jeeps; k < 3; k++) parkArmyJeep(lm);
      const guards = peds.filter(p => p.guard && dist(p.x, p.y, lm.cx, lm.cy) < 600).length;
      for (let k = guards; k < 8; k++) { const g = makeGuard(lm); if (g) peds.push(g); }
      continue;
    }
    const has = cars.some(c => c.role === 'parked' && c.serviceType === lm.type &&
      dist(c.x, c.y, lm.door.x, lm.door.y) < 600);
    if (!has) parkServiceCar(lm);
  }
  // monetine sparse + qualche monetina nascosta nei vicoli
  const wantCoins = 2 * nP;
  if (coins.length < wantCoins && frame % 40 === 0) spawnCoinNear(scx, scy, inMin, inMax);
  if (coins.length < wantCoins && frame % 120 === 0) spawnAlleyCoin(scx, scy, inMax);
  // ALLARME MILITARE: finché è attivo, soldati e jeep armate danno la caccia
  if (armyAlertT > 0) {
    if (nSoldier < 3 * nP && frame % 40 === 0) { const p = randomWalkNear(scx, scy, inMin, inMax); if (p) peds.push(makeSoldier(p.x, p.y)); }
    if (nArmy < 2 * nP && frame % 60 === 0) { const p = randomRoadNear(scx, scy, inMin, inMax); if (p) cars.push(makeArmyCar(p.x, p.y)); }
  }
  // POLIZIA in base al livello ricercato (heat di stanza condiviso in multigiocatore)
  const wantCops = wanted * nP;                  // poliziotti a piedi
  const wantCopCars = Math.max(0, wanted - 1) * nP;   // volanti
  if (wanted > 0 && nCop < wantCops && frame % 30 === 0) { const p = randomWalkNear(scx, scy, inMin, inMax); if (p) peds.push(makePed(p.x, p.y, 'cop')); }
  if (wanted >= 2 && nPolice < wantCopCars && frame % 50 === 0) { const p = randomRoadNear(scx, scy, inMin, inMax); if (p) { const c = makeCar(p.x, p.y, 'police'); c.wasPolice = true; cars.push(c); } }
}

// ---------- Particelle / effetti ----------
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
// raccolta delle monetine sparse (a piedi o in auto)
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

// ---------- Update principale ----------
function update() {
  // Fase 2: su un server autoritativo il client non simula il mondo, lo RENDE
  // (predizione del proprio player + interpolazione degli snapshot). Vedi net.js.
  if (authClient()) { updateNetClient(); return; }
  // partita a tempo: il cronometro scorre sempre, anche da morto/arrestato
  if (gameMinutes > 0) {
    timeLeft--;
    if (timeLeft % 20 === 0) updateTimer();
    if (timeLeft <= 0) { endGame('time'); return; }
  }
  // fuori gioco (morto/arrestato): scena congelata, conta solo il countdown
  // (la rete però resta viva: i ghost si muovono e lo stato "a terra" parte lo stesso)
  if (downT > 0) { updateDown(); netTick(); frame++; return; }
  applyTouchInput();
  if (player.hurtCd > 0) player.hurtCd--;
  if (flashT > 0) flashT--;
  updateLights();
  updateTrainKinematics();                        // treno: posizione (serve a trainBlocking negli updateCar)
  if (player.car) updateDrive(player.car); else updatePlayerFoot();
  for (const c of cars) updateCar(c);
  resolveCarCollisions();
  resolveRemoteCarCollisions();                  // urti con le auto degli altri giocatori/volanti
  trainCollide();                                // treno = muro solido: dopo il movimento (blocco senza ritardo)
  for (const p of peds) updatePed(p);
  updateBullets();
  updateRockets();
  updateParts();
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
  // decadimento del livello ricercato
  if (crimeCd > 0) crimeCd--;
  else if (wantedHeat > 0) { wantedHeat = Math.max(0, wantedHeat - 0.0016); const w = Math.floor(wantedHeat); if (w !== wanted) { wanted = w; updateStars(); } }
  // sirena della polizia che ti dà la caccia
  if (wanted > 0 && frame % 26 === 0) sfx.siren((frame / 26) % 2 < 1);
  // sirena del tuo mezzo di servizio (missione attiva o accesa con Spazio)
  if (playerSirenOn(player.car) && frame % 24 === 0)
    sfx.emergency(player.car.livery === 'ambulance', (frame / 24) % 2 < 1);
  // brusio del traffico vicino + cooldown dei suoni "anti-raffica"
  if (frame % 5 === 0) updateTrafficEngine();
  for (const k in sfxCd) if (sfxCd[k] > 0) sfxCd[k]--;
  netTick();                                     // multigiocatore: ghost, PvP da investimento, invio stato
  updateCamera();
  frame++;
}

