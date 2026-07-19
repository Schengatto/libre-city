// LIBRE CITY · js/net.js — multigiocatore: ospita/entra via PeerJS (WebRTC),
// stanza con codice + password facoltativa + numero massimo di giocatori,
// ghost dei giocatori remoti, danni PvP e classifica della partita (ladder).
//
// MODELLO. Ogni client simula la PROPRIA città: pedoni, traffico e polizia sono
// locali (la mappa però è identica per tutti grazie al seme ROOM_CODE, vedi
// core.js). Degli altri giocatori viaggiano solo posizione/mezzo/spari (~15
// messaggi al secondo) con topologia a stella: tutti parlano con l'host, che fa
// da ripetitore. I danni PvP li decide CHI LI SUBISCE (vittima autoritativa):
// il colpito si toglie la vita da solo e, se muore, accredita l'uccisione al
// tiratore con un messaggio 'kill' — niente conflitti fra simulazioni.
// Ogni giocatore possiede le proprie statistiche (uccisioni/morti/soldi) e le
// allega allo stato: la ladder è la vista locale dei numeri dichiarati da tutti.

const NET_SHIRTS = ['#e0533a', '#3a72d2', '#37a05a', '#c9a227', '#8a3ad2', '#e06a2a', '#2ab0b0', '#d94a90'];

const net = {
  mode: null,            // null = in solitaria · 'host' · 'client'
  peer: null,            // oggetto Peer (PeerJS) — creato solo quando serve
  conns: [],             // host: connessioni verso gli ospiti
  hostConn: null,        // client: connessione verso l'host
  players: new Map(),    // id → ghost del giocatore remoto
  myId: null, pass: '', maxPlayers: 4, seq: 0,
  clockLeft: null,       // client: frame di partita rimasti comunicati dall'host
  reconnT: null,         // timer dei tentativi di riaggancio al broker PeerJS
  wake: null,            // wake lock: schermo acceso finché si è in multigiocatore
  kills: 0, deaths: 0,
  lastHitBy: null, lastHitT: -9999,   // ultimo rivale che ci ha colpito (per il kill credit)
  looseCars: new Map(),   // netId → mezzo abbandonato da un rivale (sagoma parcheggiata, condivisa)
  carSeq: 0,              // id progressivo dei mezzi che il player locale guida
};
const netActive = () => net.mode !== null;

// ---------- Ghost: la sagoma di un giocatore remoto ----------
function makeGhost(id, name, shirtIdx) {
  return {
    id, name: String(name || 'Ospite').slice(0, 14),
    shirtIdx: shirtIdx || 0, shirt: NET_SHIRTS[(shirtIdx || 0) % NET_SHIRTS.length],
    skin: '#f6c79a', hair: '#3a2410',
    x: player.x, y: player.y, tx: player.x, ty: player.y,   // posizione attuale e bersaglio (interpolata)
    aim: 0, walk: 0, moving: false, gun: false, hp: 100, down: false,
    punchT: 0, car: null,
    stats: { k: 0, d: 0, c: 0 },
  };
}

// ---------- Host: crea la stanza ----------
function netStartHost(pass, maxPlayers, done) {
  if (typeof Peer === 'undefined') { done('offline'); return; }
  net.mode = 'host'; net.myId = 'h';
  net.pass = pass || ''; net.maxPlayers = clamp(maxPlayers || 4, 2, 8);
  player.shirt = NET_SHIRTS[0];                 // in multigiocatore ognuno ha la sua maglia
  document.body.classList.add('mp');
  let opened = false;
  net.peer = new Peer('librecity-' + ROOM_CODE.toLowerCase());
  net.peer.on('open', () => {
    if (opened) { netRefreshBadge(); return; }   // ri-registrazione dopo un riaggancio
    opened = true; netWakeLock(); netRefreshBadge(); done(null);
  });
  net.peer.on('connection', conn => netWireHostConn(conn));
  net.peer.on('disconnected', () => netPlanReconnect(1000));
  net.peer.on('error', err => {
    // prima dell'apertura è un errore di creazione stanza; dopo, 'peer-unavailable'
    // e simili riguardano un singolo ospite sparito: si ignorano
    if (!opened) { netShutdown(); done((err && err.type) || 'error'); }
  });
}
function netWireHostConn(conn) {
  conn.on('data', m => {
    if (!m || typeof m !== 'object') return;
    if (!conn._ocId) {                          // primo messaggio: deve presentarsi ('hi')
      if (m.t !== 'hi') { conn.close(); return; }
      if ((net.pass || '') !== (m.pass || '')) { conn.send({ t: 'no', r: 'pass' }); setTimeout(() => conn.close(), 400); return; }
      if (net.players.size + 1 >= net.maxPlayers) { conn.send({ t: 'no', r: 'full' }); setTimeout(() => conn.close(), 400); return; }
      const id = 'p' + (++net.seq), shirtIdx = net.seq % NET_SHIRTS.length;
      conn._ocId = id;
      net.conns.push(conn);
      const g = makeGhost(id, m.name, shirtIdx);
      net.players.set(id, g);
      const roster = [{ id: 'h', name: playerName, shirtIdx: 0 }];
      for (const [pid, pg] of net.players) if (pid !== id) roster.push({ id: pid, name: pg.name, shirtIdx: pg.shirtIdx });
      conn.send({ t: 'ok', id, shirtIdx, minutes: gameMinutes, left: timeLeft, players: roster });
      netBroadcast({ t: 'join', id, name: g.name, shirtIdx }, conn);
      toast(`🌐 ${g.name} è entrato in partita!`); sfx.coin();
      netRefreshBadge();
      return;
    }
    netFromGuest(conn._ocId, m, conn);
  });
  const drop = () => netHostDrop(conn);
  conn.on('close', drop);
  conn.on('error', drop);
}
// un ospite se n'è andato (o è caduta la connessione)
function netHostDrop(conn) {
  net.conns = net.conns.filter(c => c !== conn);
  const id = conn._ocId;
  conn._ocId = null;
  if (!id || !net.players.has(id)) return;
  const g = net.players.get(id);
  net.players.delete(id); netDropCarsOf(id);
  netBroadcast({ t: 'leave', id });
  toast(`🌐 ${g.name} ha lasciato la partita`);
  netRefreshBadge();
}
// l'host smista i messaggi di un ospite: li applica e li ripete agli altri
function netFromGuest(id, m, srcConn) {
  if (m.t === 'kill') {                         // instradato solo al tiratore da accreditare
    if (m.to === 'h') netScoreKill(id);
    else { const c = net.conns.find(c => c._ocId === m.to); if (c && c.open) c.send({ t: 'kill', id }); }
    return;
  }
  netApplyRemote(id, m);
  netBroadcast({ ...m, id }, srcConn);
}

// ---------- Client: entra in una stanza ----------
// 'peer-unavailable' NON significa per forza che la stanza non esiste: spesso
// l'host ha solo il telefono in background (sta condividendo il link!) e la sua
// registrazione al broker è momentaneamente caduta. Perciò si riprova ogni
// pochi secondi finché la stanza non ricompare, prima di arrendersi.
function netJoin(code, pass, done) {
  if (typeof Peer === 'undefined') { done('offline'); return; }
  net.mode = 'client';
  document.body.classList.add('mp');
  let settled = false, lastErr = null, retryT = null;
  const fail = err => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(retryT); netShutdown(); done(err); } };
  const timer = setTimeout(() => fail(lastErr || 'timeout'), 20000);
  const status = txt => { const el = document.getElementById('joinStatus'); if (el && !settled) el.textContent = txt; };
  const tryConnect = () => {
    if (settled || !net.peer || net.peer.destroyed) return;
    const conn = net.peer.connect('librecity-' + code.toLowerCase(), { reliable: true, serialization: 'json' });
    net.hostConn = conn;
    conn.on('open', () => conn.send({ t: 'hi', name: playerName, pass: pass || '' }));
    conn.on('data', m => {
      if (net.hostConn !== conn || !m || typeof m !== 'object') return;
      if (m.t === 'ok') {
        clearTimeout(timer);
        net.myId = m.id;
        player.shirt = NET_SHIRTS[m.shirtIdx % NET_SHIRTS.length];
        // niente giocatori impilati: ognuno parte qualche passo più in là
        player.x += 26 * m.shirtIdx;
        unstick(player, player.r, player.r);
        for (const p of m.players) net.players.set(p.id, makeGhost(p.id, p.name, p.shirtIdx));
        gameMinutes = m.minutes;                // il ritmo della partita lo detta l'host
        net.clockLeft = m.left;
        netWakeLock(); netRefreshBadge();
        settled = true; done(null);
      }
      else if (m.t === 'no') { clearTimeout(timer); fail(m.r); }
      else if (m.t === 'join') { net.players.set(m.id, makeGhost(m.id, m.name, m.shirtIdx)); toast(`🌐 ${m.name} è entrato in partita!`); sfx.coin(); netRefreshBadge(); }
      else if (m.t === 'leave') { const g = net.players.get(m.id); if (g) { net.players.delete(m.id); netDropCarsOf(m.id); toast(`🌐 ${g.name} ha lasciato la partita`); } netRefreshBadge(); }
      else if (m.t === 'end') { if (started) endGame('time'); }
      else if (m.t === 'kill') netScoreKill(m.id);
      else if (m.id && m.id !== net.myId) netApplyRemote(m.id, m);
    });
    // gli handler contano solo per la connessione corrente: i tentativi
    // scartati dal retry vengono chiusi e non devono far fallire il join
    const bye = () => { if (net.hostConn !== conn) return; if (settled) netHostGone(); else fail('host'); };
    conn.on('close', bye);
    conn.on('error', bye);
  };
  net.peer = new Peer();
  net.peer.on('open', tryConnect);
  net.peer.on('disconnected', () => netPlanReconnect(1000));
  net.peer.on('error', err => {
    const t = (err && err.type) || 'error';
    if (t === 'peer-unavailable' && !settled) {
      lastErr = t;
      const dead = net.hostConn; net.hostConn = null;
      if (dead) { try { dead.close(); } catch (e) {} }
      status('🔎 Partita non trovata, riprovo… (l\'host deve avere il gioco aperto)');
      clearTimeout(retryT);
      retryT = setTimeout(tryConnect, 2500);
      return;
    }
    fail(t);
  });
}
function netHostGone() {
  if (!netActive()) return;
  toast('🌐 L\'host ha chiuso la partita — continui in solitaria');
  netShutdown();
}
// chiude tutto e torna alla modalità in solitaria (ghost compresi)
function netShutdown() {
  clearTimeout(net.reconnT); net.reconnT = null;
  try { if (net.wake) net.wake.release(); } catch (e) {}
  net.wake = null;
  try { if (net.peer) net.peer.destroy(); } catch (e) {}
  net.peer = null; net.hostConn = null; net.conns = [];
  net.players.clear(); net.looseCars.clear();
  net.mode = null; net.myId = null; net.clockLeft = null;
  document.body.classList.remove('mp');
  netRefreshBadge();
}

// ---------- Sopravvivere al telefono in background ----------
// Quando la pagina finisce in background (l'host passa a WhatsApp per
// condividere il link, o lo schermo si blocca) il browser la sospende: il
// collegamento col broker PeerJS cade e la stanza sparisce dall'elenco — chi
// prova a entrare trova 'peer-unavailable'. PeerJS NON si ricollega da solo:
// qui ci ri-registriamo con lo stesso id appena possibile (subito al ritorno
// in primo piano, altrimenti a tentativi).
function netPlanReconnect(delay) {
  clearTimeout(net.reconnT);
  net.reconnT = setTimeout(() => {
    if (!netActive() || !net.peer || net.peer.destroyed) return;
    if (net.peer.disconnected) {
      try { net.peer.reconnect(); } catch (e) {}
      netPlanReconnect(3000);                    // finché non riesce, si riprova
    }
  }, delay);
}
// schermo acceso finché si è in multigiocatore: da spento la pagina viene
// sospesa e la stanza sparirebbe (il blocco decade da solo in background,
// perciò lo si richiede di nuovo a ogni ritorno in primo piano)
function netWakeLock() {
  if (!netActive() || !navigator.wakeLock) return;
  navigator.wakeLock.request('screen').then(w => { net.wake = w; }, () => {});
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { netPlanReconnect(150); netWakeLock(); }
});
addEventListener('pageshow', () => netPlanReconnect(150));

// ---------- Invio ----------
function netBroadcast(m, exceptConn) {
  for (const c of net.conns) if (c !== exceptConn && c.open) c.send(m);
}
function netSendToHost(m) {
  if (net.hostConn && net.hostConn.open) net.hostConn.send(m);
}
// un evento del giocatore locale: l'host lo diffonde, l'ospite lo affida all'host
function netSendEvt(m) {
  if (!netActive()) return;
  if (net.mode === 'host') netBroadcast({ ...m, id: 'h' });
  else netSendToHost(m);
}
// descrizione di rete di un mezzo: la stessa sia per il mezzo guidato (dentro lo
// stato) sia per quello abbandonato (evento 'park'). `cid` è l'id stabile del mezzo
function carNetPayload(c) {
  return {
    cid: c.netId || null, x: c.x, y: c.y, an: c.angle, sp: c.speed, w: c.w, h: c.h, col: c.color,
    bike: !!c.isBike, tank: !!c.isTank, taxi: !!c.isTaxi, del: !!c.isDelivery,
    liv: c.livery || null, pol: !!c.wasPolice, hel: c.helmet || null,
    tur: c.isTank ? c.turretA : null,
  };
}
// stato compatto del giocatore locale (posizione, mezzo, statistiche)
function netMyState() {
  const c = player.car;
  return {
    t: 's', x: player.x, y: player.y, a: player.aim, w: player.walk, m: player.moving,
    g: !WEAPONS[player.weaponIdx].melee, hp: player.health, dn: downT > 0,
    st: { k: net.kills, d: net.deaths, c: cash },
    c: c ? carNetPayload(c) : null,
  };
}
// ---------- Mezzi che il player locale guida/abbandona (condivisi con gli altri) ----------
// salendo a bordo: id di rete stabile, così i rivali lo riconoscono quando lo
// guidi (dentro il tuo stato) e quando lo lasci (diventa una sagoma parcheggiata)
function netAssignCarId(c) { if (netActive() && c && !c.netId) c.netId = net.myId + '#' + (net.carSeq++); }
// scendendo/abbandonando: lo diffonde come mezzo fermo così NON sparisce dagli
// schermi degli altri (prima invece, con lo stato a `c:null`, svaniva del tutto)
function netAbandonCar(c) { if (netActive() && c && c.netId) netSendEvt({ t: 'park', car: carNetPayload(c) }); }
// mezzo distrutto (esploso): gli altri tolgono la sagoma ferma corrispondente
function netDestroyCar(c) { if (netActive() && c && c.netId) netSendEvt({ t: 'gone', cid: c.netId }); }
// ganci chiamati dal gameplay quando il giocatore locale attacca
function netShotFired(w) {
  netSendEvt({ t: 'shot', x: player.x, y: player.y, a: player.aim, n: w.pellets || 1,
               sp: w.spread, spd: w.spd, life: w.life, dmg: w.dmgCar, pdmg: w.pvp || 8 });
}
function netPunched() { netSendEvt({ t: 'punch', x: player.x, y: player.y, a: player.aim }); }
function netRocketFired(c) { netSendEvt({ t: 'rocket', x: c.x, y: c.y, a: c.turretA }); }

// ---------- Ricezione: applica lo stato/gli eventi di un rivale ----------
function netApplyRemote(id, m) {
  const g = net.players.get(id);
  if (!g) return;
  if (m.t === 's') {
    g.tx = m.x; g.ty = m.y; g.aim = m.a; g.walk = m.w || 0; g.moving = !!m.m;
    g.gun = !!m.g; g.hp = m.hp; g.down = !!m.dn;
    if (m.st) g.stats = m.st;
    if (m.c) {
      if (!g.car) g.car = { role: 'traffic', driver: 'net', colH: 13, speed: 0, gear: 1,
                            kvx: 0, kvy: 0, lightPhase: 0, x: m.c.x, y: m.c.y, angle: m.c.an, tx: null };
      const c = g.car;
      if (c.tx == null || dist(c.x, c.y, m.c.x, m.c.y) > 280) { c.x = m.c.x; c.y = m.c.y; c.angle = m.c.an; }  // teletrasporto
      c.tx = m.c.x; c.ty = m.c.y; c.ta = m.c.an; c.speed = m.c.sp;
      c.w = m.c.w; c.h = m.c.h; c.color = m.c.col;
      c.isBike = m.c.bike; c.isTank = m.c.tank; c.isTaxi = m.c.taxi; c.isDelivery = m.c.del;
      c.livery = m.c.liv || null; c.wasPolice = m.c.pol;
      c.helmet = m.c.hel || '#2a2a2e'; c.riderShirt = g.shirt;
      if (m.c.tur != null) c.turretA = m.c.tur;
      if (m.c.cid != null) { c.netId = m.c.cid; net.looseCars.delete(m.c.cid); }  // lo sta guidando: via la sagoma ferma
    } else g.car = null;
  }
  else if (m.t === 'park') netParkCar(id, m.car);
  else if (m.t === 'gone') net.looseCars.delete(m.cid);
  else if (m.t === 'shot') netSpawnShot(id, m);
  else if (m.t === 'punch') netPunchAt(id, m);
  else if (m.t === 'rocket') netSpawnRocket(id, m);
}
// un rivale ha abbandonato un mezzo: lo teniamo come sagoma ferma condivisa
// finché non lo riprende (torna nel suo stato) o non ci allontaniamo troppo.
// Ogni client gestisce la propria copia — il diradamento per distanza è locale,
// esattamente come per il traffico simulato in proprio.
function netParkCar(owner, p) {
  if (!p || p.cid == null) return;
  let c = net.looseCars.get(p.cid);
  if (!c) { c = { netId: p.cid, role: 'parked', driver: null, colH: 13, speed: 0, gear: 1, lightPhase: 0, kvx: 0, kvy: 0 }; net.looseCars.set(p.cid, c); }
  c.owner = owner;
  c.x = p.x; c.y = p.y; c.angle = p.an; c.speed = p.sp || 0;
  c.w = p.w; c.h = p.h; c.color = p.col;
  c.isBike = p.bike; c.isTank = p.tank; c.isTaxi = p.taxi; c.isDelivery = p.del;
  c.livery = p.liv || null; c.wasPolice = p.pol;
  c.helmet = p.hel || '#2a2a2e';
  if (p.tur != null) c.turretA = p.tur;
}
// un rivale ha lasciato la partita: via anche i mezzi che aveva abbandonato
function netDropCarsOf(id) { for (const [cid, c] of net.looseCars) if (c.owner === id) net.looseCars.delete(cid); }
// proiettili "fantasma" di un rivale: ostili come quelli dei poliziotti, ma
// firmati (fromNet) così un'eventuale morte viene accreditata al tiratore
function netSpawnShot(id, m) {
  if (!started) return;
  for (let i = 0; i < (m.n || 1); i++) {
    const a = m.a + rnd(-(m.sp || 0), m.sp || 0);
    bullets.push({ x: m.x + Math.cos(a) * 14, y: m.y + Math.sin(a) * 14,
                   vx: Math.cos(a) * (m.spd || 12), vy: Math.sin(a) * (m.spd || 12),
                   life: m.life || 50, fromPlayer: false, fromNet: id, dmg: m.dmg, pdmg: m.pdmg });
  }
  spawnMuzzle(m.x + Math.cos(m.a) * 14, m.y + Math.sin(m.a) * 14, m.a);
  const h = hear(m.x, m.y, 850); if (h) sfx.copShoot(h);
}
// pugno di un rivale: conta solo se raggiunge il giocatore locale (vittima autoritativa)
function netPunchAt(id, m) {
  const g = net.players.get(id);
  if (g) g.punchT = 10;                         // fa scattare l'animazione del braccio del ghost
  if (!started || player.car || downT > 0) return;
  if (dist(m.x, m.y, player.x, player.y) < 40 &&
      Math.abs(angDiff(m.a, Math.atan2(player.y - m.y, player.x - m.x))) < 1.1) {
    netRegisterHit(id);
    hurtPlayer(12, m.a);
    sfx.punch();
  }
}
function netSpawnRocket(id, m) {
  if (!started) return;
  rockets.push({ x: m.x + Math.cos(m.a) * 44, y: m.y + Math.sin(m.a) * 44,
                 vx: Math.cos(m.a) * 6.5, vy: Math.sin(m.a) * 6.5, life: 120, src: null, fromNet: id });
  const h = hear(m.x, m.y, 1000); if (h) sfx.rocket();
}

// ---------- Kill credit (vittima autoritativa) ----------
// chiunque ci ferisce via rete lascia la firma: se moriamo entro pochi secondi
// il colpo di grazia è suo e gli spediamo il punto
function netRegisterHit(id) { net.lastHitBy = id; net.lastHitT = frame; }
// chiamato da startDown(): aggiorna morti e accredita l'eventuale uccisore
function netReportDown(kind) {
  if (!netActive() || kind !== 'dead') return;
  net.deaths++;
  if (net.lastHitBy != null && frame - net.lastHitT < 60 * 6) {
    const killer = net.lastHitBy;
    if (net.mode === 'host') { const c = net.conns.find(c => c._ocId === killer); if (c && c.open) c.send({ t: 'kill', id: 'h' }); }
    else netSendToHost({ t: 'kill', to: killer });
    const g = net.players.get(killer);
    if (g) toast(`☠️ ${g.name} ti ha steso!`);
  }
  net.lastHitBy = null;
}
// ci è arrivato un punto: abbiamo steso la vittima `victimId`
function netScoreKill(victimId) {
  net.kills++;
  const g = net.players.get(victimId);
  cash += 25; updateCash();                     // taglia sul rivale steso
  toast(`💀 Hai steso ${g ? g.name : 'un rivale'}! (+$25)`);
  sfx.coin();
}

// ---------- Tick di rete: interpolazione ghost, PvP da investimento, invio stato ----------
function netTick() {
  if (!netActive()) return;
  for (const g of net.players.values()) {
    if (g.punchT > 0) g.punchT--;
    if (g.car) {
      const c = g.car;
      if (c.tx != null) {
        c.x += (c.tx - c.x) * 0.28; c.y += (c.ty - c.y) * 0.28;
        c.angle += angDiff(c.angle, c.ta != null ? c.ta : c.angle) * 0.35;
      }
      g.x = c.x; g.y = c.y;
      // il mezzo di un rivale può investirti: lo rileva (e lo paga) la vittima
      if (!g.down && !player.car && downT === 0 && started && Math.abs(c.speed) >= 2.2) {
        const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
        const dx = player.x - c.x, dy = player.y - c.y;
        if (Math.abs(dx * ca + dy * sa) < c.w / 2 + player.r && Math.abs(-dx * sa + dy * ca) < c.h / 2 + player.r) {
          netRegisterHit(g.id);
          hurtPlayer(12 + Math.abs(c.speed) * 2.5, c.angle);
          moveBox(player, ca * c.speed * 1.3, sa * c.speed * 1.3, player.r, player.r);
        }
      }
    } else {
      g.x += (g.tx - g.x) * 0.3; g.y += (g.ty - g.y) * 0.3;
      if (dist(g.x, g.y, g.tx, g.ty) > 280) { g.x = g.tx; g.y = g.ty; }   // teletrasporto (respawn)
      if (g.moving) g.walk += 0.3; else g.walk = 0;
    }
  }
  // le sagome dei mezzi abbandonati si diradano quando ti allontani (come il traffico)
  const far = Math.max(vw, vh) * 1.3 + 300;
  for (const [cid, c] of net.looseCars) if (dist(c.x, c.y, player.x, player.y) > far) net.looseCars.delete(cid);
  if (frame % 4 === 0) netSendEvt(netMyState());                 // ~15 volte al secondo
  if (frame % 30 === 0 && ladderEl && !ladderEl.classList.contains('hidden')) renderLadder();
}

// ---------- Disegno dei ghost (chiamato da render.js) ----------
function netPushEnts(ents) {
  for (const g of net.players.values()) if (!g.down) ents.push({ netG: g, y: g.y });
  for (const c of net.looseCars.values()) ents.push(c);   // mezzi abbandonati dai rivali (role 'parked' → drawCar)
}
function drawNetPlayer(g) {
  if (g.car) { drawCar(g.car); netTag(g, g.car.x - camX, g.car.y - camY - g.car.h / 2 - 6); return; }
  const x = g.x - camX, y = g.y - camY;
  if (x < -60 || y < -60 || x > vw + 60 || y > vh + 60) return;
  drawShadow(x, y + 6, 8, 3);
  drawPerson(x, y, g.aim, g.walk, { shirt: g.shirt, skin: g.skin, hair: g.hair,
                                    gun: g.gun, punch: g.punchT > 0 ? g.punchT / 10 : 0 });
  netTag(g, x, y);
}
// targhetta del rivale: nome azzurro + barretta della vita
function netTag(g, x, y) {
  ctx.font = 'bold 11px Trebuchet MS'; ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillText(g.name, x + 1, y - 17);
  ctx.fillStyle = '#8fd6ff'; ctx.fillText(g.name, x, y - 18);
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(x - 14, y - 15, 28, 3);
  ctx.fillStyle = '#5ee06a'; ctx.fillRect(x - 14, y - 15, 28 * clamp(g.hp, 0, 100) / 100, 3);
}

// ---------- Ladder: classifica della partita (Tab o pulsante 🏆) ----------
const ladderEl = document.getElementById('ladder');
function toggleLadder() {
  if (!netActive() || !started || !ladderEl) return;
  ladderEl.classList.toggle('hidden');
  if (!ladderEl.classList.contains('hidden')) renderLadder();
}
function ladderRows() {
  const rows = [{ name: playerName, k: net.kills, d: net.deaths, c: cash, me: true }];
  for (const g of net.players.values()) rows.push({ name: g.name, k: g.stats.k, d: g.stats.d, c: g.stats.c, me: false });
  rows.sort((a, b) => b.k - a.k || a.d - b.d || b.c - a.c);
  return rows;
}
// riempie sia la ladder in gioco sia quella della schermata di fine partita
function renderLadder() {
  const rows = ladderRows();
  for (const sel of ['#ladderTable tbody', '#goLadderTable tbody']) {
    const body = document.querySelector(sel);
    if (!body) continue;
    body.innerHTML = '';
    rows.forEach((r, i) => {
      const tr = document.createElement('tr');
      if (r.me) tr.className = 'me';
      for (const txt of [i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1, r.name, r.k, r.d, '$' + r.c]) {
        const td = document.createElement('td');
        td.textContent = txt;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    });
  }
}

// ---------- Badge, link d'invito, condivisione ----------
function netRefreshBadge() {
  const el = document.getElementById('mpBadge');
  if (el) {
    el.classList.toggle('hidden', !netActive());
    if (netActive()) {
      const n = net.players.size + 1;
      el.innerHTML = `🌐 <b>${ROOM_CODE}</b> · ${n} giocator${n === 1 ? 'e' : 'i'}`;
    }
  }
  const lc = document.getElementById('lobbyCount');
  if (lc && netActive()) lc.textContent = `${net.players.size + 1} / ${net.maxPlayers}`;
}
function inviteLink() { return location.href.split('#')[0] + '#room=' + ROOM_CODE; }
// condivisione col foglio nativo del sistema (WhatsApp, Messaggi, ecc.); se il
// dispositivo non lo espone si ripiega sulla copia negli appunti
function shareInvite(btn) {
  const url = inviteLink();
  if (navigator.share) {
    navigator.share({
      title: 'Libre City',
      text: `Entra nella mia partita di Libre City! Codice stanza: ${ROOM_CODE}`,
      url,
    }).catch(() => {});                            // annullato dall'utente: nessun errore
    return;
  }
  copyInvite(btn);                                 // niente foglio nativo: copia e basta
}
function copyInvite(btn) {
  const link = inviteLink();
  const orig = btn ? btn.textContent : '';
  const ok = () => { if (btn) { btn.textContent = '✅ Copiato!'; setTimeout(() => { btn.textContent = orig; }, 1500); } };
  const fallback = () => {
    const inp = document.getElementById('inviteLink');
    if (inp) { inp.focus(); inp.select(); try { document.execCommand('copy'); ok(); } catch (e) {} }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(ok, fallback);
  else fallback();
}
