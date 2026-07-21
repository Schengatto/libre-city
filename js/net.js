// LIBRE CITY · js/net.js — multigiocatore: crea/entra in una stanza su un vero
// SERVER (WebSocket), ghost dei giocatori remoti, danni PvP e classifica (ladder).
//
// FASE 1. Il transport non è più P2P via PeerJS/WebRTC ma un server Node sempre
// acceso (vedi server/): niente più host-telefono che, andando in background,
// fa sparire l'intera stanza (era la causa delle disconnessioni casuali). Il
// server tiene le stanze, fa da ripetitore dei messaggi e possiede l'orologio
// della partita. Un riaggancio col token recupera lo stesso giocatore.
//
// MODELLO (invariato in Fase 1). Ogni client simula ancora la PROPRIA città:
// pedoni, traffico e polizia sono locali (la mappa è identica per tutti grazie
// al seme ROOM_CODE, vedi core.js). Degli altri giocatori viaggiano solo
// posizione/mezzo/spari (~15 messaggi al secondo). I danni PvP li decide CHI LI
// SUBISCE (vittima autoritativa): il colpito si toglie la vita da solo e, se
// muore, accredita l'uccisione al tiratore con un messaggio 'kill'. La FASE 2
// sposterà la simulazione sul server, eliminando il disallineamento.

const NET_SHIRTS = ['#e0533a', '#3a72d2', '#37a05a', '#c9a227', '#8a3ad2', '#e06a2a', '#2ab0b0', '#d94a90'];

const net = {
  mode: null,            // null = in solitaria · 'host' (ha creato la stanza) · 'client'
  sock: null,            // WebSocket verso il server
  url: null,             // URL del server risolto (vedi netServerUrl)
  players: new Map(),    // id → ghost del giocatore remoto
  myId: null, token: null,           // token: chiave per riagganciarsi come lo stesso giocatore
  pass: '', maxPlayers: 4,
  hello: null, rejoin: null, _open: null,   // dati per (ri)aprire la connessione
  clockLeft: null,       // frame di partita rimasti, comunicati dal server
  reconnT: null, reconnDelay: 0, wantOpen: false, dropped: false,  // riaggancio automatico
  wake: null,            // wake lock: schermo acceso finché si è in multigiocatore
  kills: 0, deaths: 0, score: 0, streak: 0, bounty: 0,   // punteggio, serie e taglia sulla nostra testa
  lastHitBy: null, lastHitT: -9999,   // ultimo rivale che ci ha colpito (per il kill credit)
  looseCars: new Map(),   // netId → mezzo abbandonato da un rivale (sagoma parcheggiata, condivisa)
  carSeq: 0,              // id progressivo dei mezzi che il player locale guida
  remoteCops: new Map(),  // netId → volante di un rivale ricercato (condivisa, disegnata e solida)
  copSeq: 0,              // id progressivo delle volanti che trasmetto quando sono ricercato
  // ---- Fase 2: client di un SERVER AUTORITATIVO ----
  authoritative: false,   // true = il mondo lo possiede il server; qui si rende soltanto
  snap: null,             // ultimo snapshot 'w' ricevuto
  inSeq: 0,               // id progressivo dell'input inviato
  firePending: false, enterEdge: false, hornEdge: false, weaponReq: null,  // azioni one-shot → server
  wcars: new Map(), wpeds: new Map(),   // id → entità del mondo (interpolate)
  wbullets: [], wrockets: [],           // proiettili/razzi (estrapolati tra gli snapshot)
};
const netActive = () => net.mode !== null;

// ---------- URL del server -------------------------------------------------
// In sviluppo (localhost / file://) punta al server locale sulla 8787. In
// produzione l'URL arriva da <meta name="lc-server" content="wss://…"> in
// index.html (oppure window.LIBRE_CITY_SERVER o ?server=…). Così net.js resta
// generico e l'indirizzo del server si configura senza toccare il codice.
const NET_PROD_SERVER = '';       // fallback se non c'è meta/override (da riempire dopo il deploy)
function netServerUrl() {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q;
  const meta = document.querySelector('meta[name="lc-server"]');
  if (meta && meta.content.trim()) return meta.content.trim();
  if (window.LIBRE_CITY_SERVER) return window.LIBRE_CITY_SERVER;
  const h = location.hostname;
  if (!h || h === 'localhost' || h === '127.0.0.1') return 'ws://' + (h || 'localhost') + ':8787';
  return NET_PROD_SERVER || null;
}

// ---------- Ghost: la sagoma di un giocatore remoto ----------
function makeGhost(id, name, shirtIdx) {
  return {
    id, name: String(name || 'Ospite').slice(0, 14),
    shirtIdx: shirtIdx || 0, shirt: NET_SHIRTS[(shirtIdx || 0) % NET_SHIRTS.length],
    skin: '#f6c79a', hair: '#3a2410',
    x: player.x, y: player.y, tx: player.x, ty: player.y,   // posizione attuale e bersaglio (interpolata)
    aim: 0, walk: 0, moving: false, gun: false, hp: 100, down: false,
    punchT: 0, car: null,
    stats: { k: 0, d: 0, c: 0, s: 0, b: 0 },
  };
}

// ---------- Connessione al server (host = crea, client = entra) ----------
// L'host CREA la stanza sul server; il client vi ENTRA. Dopo il primo ingresso
// sono simmetrici: mandano stato/eventi al server, che li firma col loro id e
// li ripete agli altri. Un token permette di riagganciarsi come lo stesso
// giocatore dopo una caduta di rete.

// host: crea la stanza e ne detta i parametri (durata, max giocatori, password)
function netStartHost(pass, maxPlayers, done) {
  const url = netServerUrl();
  if (!url) { done('noserver'); return; }
  net.mode = 'host'; net.url = url;
  net.pass = pass || ''; net.maxPlayers = clamp(maxPlayers || 4, 2, 8);
  player.shirt = NET_SHIRTS[0];                 // in multigiocatore ognuno ha la sua maglia
  document.body.classList.add('mp');
  net.rejoin = { code: ROOM_CODE, name: playerName, pass: net.pass };
  net.hello  = { t: 'create', code: ROOM_CODE, name: playerName, pass: net.pass,
                 max: net.maxPlayers, minutes: gameMinutes };
  netDial(done);
}
// client: entra in una stanza già creata
function netJoin(code, pass, done) {
  const url = netServerUrl();
  if (!url) { done('noserver'); return; }
  net.mode = 'client'; net.url = url;
  net.pass = pass || '';
  document.body.classList.add('mp');
  net.rejoin = { code, name: playerName, pass: net.pass };
  net.hello  = { t: 'join', code, name: playerName, pass: net.pass };
  netDial(done);
}

// apre la WebSocket, gestisce l'ingresso iniziale e prepara il riaggancio
// automatico. done(null) alla riuscita, done(codiceErrore) al fallimento.
function netDial(done) {
  net.wantOpen = true; net.dropped = false; net.reconnDelay = 0;
  let settled = false;
  const status = txt => { const el = document.getElementById('joinStatus'); if (el && !settled) el.textContent = txt; };
  const timer = setTimeout(() => { if (!settled) { settled = true; netShutdown(); done('timeout'); } }, 15000);

  const open = () => {
    if (!net.wantOpen) return;
    let ws;
    try { ws = new WebSocket(net.url); }
    catch (e) { if (!settled) { settled = true; clearTimeout(timer); netShutdown(); done('offline'); } return; }
    net.sock = ws;
    ws.onopen = () => {
      net.reconnDelay = 0;
      // primo ingresso: create/join iniziale · riaggancio: join col token
      ws.send(JSON.stringify(net.token ? { ...net.rejoin, t: 'join', token: net.token } : net.hello));
    };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || typeof m !== 'object') return;
      if (!settled) {                            // in attesa dell'esito del primo ingresso
        if (m.t === 'ok') { settled = true; clearTimeout(timer); netOnJoined(m); netWakeLock(); done(null); return; }
        if (m.t === 'no') { settled = true; clearTimeout(timer); netShutdown(); done(m.r); return; }
        return;                                  // altri messaggi prima dell'ok: si ignorano
      }
      onServerMessage(m);
    };
    ws.onclose = () => {
      if (ws !== net.sock) return;               // socket già sostituita da un riaggancio
      if (!settled) { status('🔌 Connessione al server… riprovo'); netScheduleReconnect(); return; }
      if (net.wantOpen) {                         // caduta dopo l'ingresso: riaggancio silenzioso
        if (!net.dropped) { net.dropped = true; toast('🌐 Connessione persa, riaggancio…'); netRefreshBadge(); }
        netScheduleReconnect();
      }
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  };
  net._open = open;
  open();
}
// riaggancio con backoff crescente (fino a ~8s); `immediate` riparte subito
function netScheduleReconnect(immediate) {
  if (!net.wantOpen || !net._open) return;
  clearTimeout(net.reconnT);
  net.reconnDelay = immediate ? 0 : Math.min((net.reconnDelay || 400) * 1.6, 8000);
  net.reconnT = setTimeout(() => { if (net.wantOpen) net._open(); }, net.reconnDelay);
}

// applica l'ingresso riuscito (o il riaggancio): id, maglia, roster, orologio
function netOnJoined(m) {
  const resumed = !!m.resumed;
  net.myId = m.id;
  if (m.token) net.token = m.token;
  net.authoritative = !!m.sim;                       // Fase 2: il server simula il mondo
  player.shirt = NET_SHIRTS[m.shirtIdx % NET_SHIRTS.length];
  if (m.minutes != null) gameMinutes = m.minutes;   // il ritmo della partita lo detta il server
  net.clockLeft = m.left;
  // sincronizza il roster senza azzerare i ghost già presenti (importante al riaggancio)
  for (const p of (m.players || [])) if (!net.players.has(p.id)) net.players.set(p.id, makeGhost(p.id, p.name, p.shirtIdx));
  if (!resumed && !net.authoritative) {
    // primo ingresso (solo Fase 1): sfalsa la posizione così i giocatori non partono impilati
    // (in autoritativo la posizione la decide il server)
    player.x += 26 * m.shirtIdx;
    unstick(player, player.r, player.r);
  } else if (net.dropped) {
    net.dropped = false; toast('🌐 Riconnesso alla partita');
  }
  netRefreshBadge();
}

// smista i messaggi del server dopo l'ingresso
function onServerMessage(m) {
  switch (m.t) {
    case 'ok': netOnJoined(m); break;             // riaggancio riuscito
    case 'join':
      net.players.set(m.id, makeGhost(m.id, m.name, m.shirtIdx));
      toast(`🌐 ${m.name} è entrato in partita!`); sfx.coin(); netRefreshBadge();
      break;
    case 'leave': {
      const g = net.players.get(m.id);
      if (g) { net.players.delete(m.id); netDropCarsOf(m.id); toast(`🌐 ${g.name} ha lasciato la partita`); }
      netRefreshBadge();
      break;
    }
    case 'end': if (started) endGame('time'); break;
    case 'kill': netScoreKill(m.id); break;
    case 'w': netOnSnapshot(m); break;             // Fase 2: snapshot del mondo autoritativo
    case 'pong': break;
    default: if (m.id && m.id !== net.myId) netApplyRemote(m.id, m);
  }
}

// chiude tutto e torna alla modalità in solitaria (ghost compresi)
function netShutdown() {
  net.wantOpen = false; net.dropped = false;
  clearTimeout(net.reconnT); net.reconnT = null;
  try { if (net.wake) net.wake.release(); } catch (e) {}
  net.wake = null;
  if (net.sock) { try { net.sock.onclose = null; net.sock.onerror = null; net.sock.close(); } catch (e) {} }
  net.sock = null; net._open = null; net.hello = null; net.rejoin = null;
  net.players.clear(); net.looseCars.clear(); net.remoteCops.clear();
  net.mode = null; net.myId = null; net.token = null; net.clockLeft = null;
  net.score = 0; net.streak = 0; net.bounty = 0; updateBountyHud(0);
  document.body.classList.remove('mp');
  netRefreshBadge();
}

// ---------- Sopravvivere al telefono in background ----------
// Da spento/in background il browser sospende la pagina e la WebSocket cade.
// Con un vero server la stanza però NON sparisce: al ritorno in primo piano ci
// si riaggancia col token e si riprende lo stesso giocatore (entro la grazia).
function netWakeLock() {
  if (!netActive() || !navigator.wakeLock) return;
  navigator.wakeLock.request('screen').then(w => { net.wake = w; }, () => {});
}
function netWakeIfNeeded() {
  if (!netActive()) return;
  netWakeLock();
  if (!net.sock || net.sock.readyState > 1) netScheduleReconnect(true);   // CLOSING/CLOSED → riaggancia subito
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) netWakeIfNeeded(); });
addEventListener('pageshow', netWakeIfNeeded);

// ---------- Invio ----------
// un evento del giocatore locale: lo si manda al server, che lo firma col
// nostro id e lo ripete agli altri
function netSend(m) {
  if (net.sock && net.sock.readyState === 1) { try { net.sock.send(JSON.stringify(m)); } catch (e) {} }
}
function netSendEvt(m) { if (netActive()) netSend(m); }
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
    st: { k: net.kills, d: net.deaths, c: cash, s: net.score, b: net.bounty },
    c: c ? carNetPayload(c) : null,
    pol: netCopPayloads(),                        // volanti al mio inseguimento (se ricercato)
  };
}
// le volanti che mi inseguono le simulo solo io: le trasmetto così TUTTI le
// vedono (prima erano visibili al solo giocatore ricercato). netId stabile per
// riconoscerle lato ricevente; omesse se non ne ho.
function netCopPayloads() {
  let out = null;
  for (const c of cars) {
    if (c.role !== 'police') continue;
    if (!c.netId) c.netId = net.myId + '#c' + (net.copSeq++);
    (out || (out = [])).push({ cid: c.netId, x: Math.round(c.x), y: Math.round(c.y),
      an: c.angle, sp: c.speed, w: c.w, h: c.h, col: c.color, lp: c.lightPhase || 0 });
  }
  return out;   // null se nessuna: il ricevente rimuove quelle mie
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
    netApplyCops(id, m.pol);                       // volanti al suo inseguimento (o le rimuove se non è più ricercato)
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
// volanti trasmesse da un rivale ricercato: le teniamo aggiornate (una copia per
// netId, con owner) e rimuoviamo quelle non più presenti nell'ultimo elenco —
// così spariscono da sole quando lui perde il livello ricercato o le semina.
function netApplyCops(owner, list) {
  const seen = list ? new Set(list.map(p => p.cid)) : null;
  if (list) for (const p of list) {
    let c = net.remoteCops.get(p.cid);
    if (!c) {
      c = { netId: p.cid, owner, role: 'police', driver: 'net', wasPolice: true, mass: 1.6,
            colH: 13, gear: 1, kvx: 0, kvy: 0, lightPhase: p.lp || 0,
            x: p.x, y: p.y, angle: p.an, tx: p.x, ty: p.y, ta: p.an };
      net.remoteCops.set(p.cid, c);
    } else if (dist(c.x, c.y, p.x, p.y) > 280) { c.x = p.x; c.y = p.y; c.angle = p.an; }  // teletrasporto
    c.tx = p.x; c.ty = p.y; c.ta = p.an; c.speed = p.sp;
    c.w = p.w; c.h = p.h; c.color = p.col;
  }
  for (const [cid, c] of net.remoteCops) if (c.owner === owner && (!seen || !seen.has(cid))) net.remoteCops.delete(cid);
}
// tutte le auto remote SOLIDE con cui la mia auto può scontrarsi (giocatori,
// mezzi abbandonati, volanti). Usata dalla risoluzione collisioni in gameplay.js.
function netSolidCars(out) {
  for (const g of net.players.values()) if (g.car && !g.down) out.push(g.car);
  for (const c of net.looseCars.values()) out.push(c);
  for (const c of net.remoteCops.values()) out.push(c);
  // Fase 2: anche il traffico del mondo autoritativo è solido per la mia auto, ma
  // NON lo muoviamo noi (lo possiede/spinge il server): la mia auto ci rimbalza e
  // basta. Così la collisione col traffico è O(n) sulla sola auto del player, non
  // O(n²) su tutte le coppie, e non litiga con l'interpolazione del traffico.
  if (net.authoritative) for (const c of net.wcars.values()) out.push(c);
  return out;
}
// un rivale ha lasciato la partita: via anche i mezzi che aveva abbandonato e le sue volanti
function netDropCarsOf(id) {
  for (const [cid, c] of net.looseCars) if (c.owner === id) net.looseCars.delete(cid);
  for (const [cid, c] of net.remoteCops) if (c.owner === id) net.remoteCops.delete(cid);
}
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
  if (!netActive()) return;
  if (kind === 'dead' || kind === 'busted') { net.streak = 0; net.bounty = 0; updateBountyHud(0); }   // serie/taglia azzerate
  if (kind !== 'dead') return;
  net.deaths++;
  if (net.lastHitBy != null && frame - net.lastHitT < 60 * 6) {
    netSend({ t: 'kill', to: net.lastHitBy });    // il server recapita il punto al tiratore
    const g = net.players.get(net.lastHitBy);
    if (g) toast(`☠️ ${g.name} ti ha steso!`);
  }
  net.lastHitBy = null;
}
// ci è arrivato un punto: abbiamo steso la vittima `victimId`
function netScoreKill(victimId) {
  net.kills++;
  net.streak++;
  net.score += KILL_POINTS;
  const nb = bountyForStreak(net.streak);
  if (nb > net.bounty) toast(`🎯 Taglia su di te: $${nb} — sei un bersaglio!`);
  net.bounty = nb; updateBountyHud(nb);
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
  // volanti remote: interpolate verso il bersaglio + sirena che lampeggia
  for (const c of net.remoteCops.values()) {
    if (c.tx != null) {
      c.x += (c.tx - c.x) * 0.28; c.y += (c.ty - c.y) * 0.28;
      c.angle += angDiff(c.angle, c.ta != null ? c.ta : c.angle) * 0.35;
    }
    c.lightPhase = (c.lightPhase || 0) + 0.5;
  }
  // le sagome dei mezzi abbandonati e le volanti remote si diradano quando ti allontani (come il traffico)
  const far = Math.max(vw, vh) * 1.3 + 300;
  for (const [cid, c] of net.looseCars) if (dist(c.x, c.y, player.x, player.y) > far) net.looseCars.delete(cid);
  for (const [cid, c] of net.remoteCops) if (dist(c.x, c.y, player.x, player.y) > far) net.remoteCops.delete(cid);
  if (frame % 4 === 0) netSendEvt(netMyState());                 // ~15 volte al secondo
  if (frame % 30 === 0 && ladderEl && !ladderEl.classList.contains('hidden')) renderLadder();
}

// =============================================================================
//  FASE 2 · CLIENT DI UN SERVER AUTORITATIVO
//  Il mondo (traffico, pedoni, polizia, proiettili) lo simula il server e lo manda
//  a snapshot ('w') per area d'interesse. Qui NON si simula: si PREDICE solo il
//  proprio player (per la reattività) e si interpolano gli snapshot verso i target.
//  update() (gameplay.js) devia qui quando net.authoritative è vero.
// =============================================================================

// ---------- Interpolazione a snapshot (rendering nel passato) ----------
// Tecnica standard dei giochi autoritativi. NON si insegue l'ultima posizione con
// uno smorzamento esponenziale (che con snapshot a 15/s resta SEMPRE indietro
// rispetto a un veicolo in moto e va a scatti — la causa del "tutto lento"). Invece
// si tiene un piccolo BUFFER delle ultime posizioni note e si disegna il mondo con
// ~100ms di ritardo, interpolando LINEARMENTE tra i due snapshot che racchiudono
// l'istante di rendering. Così il moto è fluido e a velocità CORRETTA anche con
// pochi snapshot al secondo e rete ballerina. Il player locale NON passa di qui:
// lui è predetto (updateNetClient) per restare reattivo.
const INTERP_MS = 100;                    // ritardo di rendering (~1.5 intervalli di snapshot @15Hz)
const INTERP_KEEP = 5;                    // stati tenuti per entità (~330ms di storia = margine per il jitter)
function interpFeed(e, x, y, a) {
  const t = performance.now();
  const buf = e.ib || (e.ib = []);
  const last = buf[buf.length - 1];
  if (last && (Math.abs(x - last.x) > 280 || Math.abs(y - last.y) > 280)) buf.length = 0;   // teletrasporto (respawn): riparti, non strisciare
  buf.push({ x, y, a, t });
  if (buf.length > INTERP_KEEP) buf.shift();
  if (buf.length === 1) { e.x = x; e.y = y; e.angle = a; }
}
function interpSample(e, renderT) {
  const buf = e.ib;
  if (!buf || !buf.length) return;
  if (buf.length === 1 || renderT <= buf[0].t) { const s = buf[0]; e.x = s.x; e.y = s.y; e.angle = s.a; return; }
  for (let i = buf.length - 1; i > 0; i--) {
    const a0 = buf[i - 1];
    if (renderT >= a0.t) {                 // coppia [a0,a1] che racchiude renderT (o l'ultima se renderT è nel futuro → si ferma sull'ultimo)
      const a1 = buf[i], span = a1.t - a0.t;
      let f = span > 0 ? (renderT - a0.t) / span : 1;
      if (f > 1) f = 1;
      e.x = a0.x + (a1.x - a0.x) * f;
      e.y = a0.y + (a1.y - a0.y) * f;
      e.angle = a0.a + angDiff(a0.a, a1.a) * f;
      return;
    }
  }
}

// applica i campi NON di posizione di un'auto dallo snapshot (aspetto/stato); la
// posizione va nel buffer d'interpolazione a parte (interpFeed).
function netApplyCar(c, cp) {
  c.speed = cp.sp;
  c.w = cp.w; c.h = cp.h; c.color = cp.col; c.role = cp.role;
  c.isBike = cp.bike; c.isTank = cp.tank; c.isTaxi = cp.taxi; c.isDelivery = cp.del;
  c.livery = cp.liv || null; c.wasPolice = cp.pol; c.helmet = cp.hel || '#2a2a2e';
  if (cp.tur != null) c.turretA = cp.tur;
  c.sirenOn = cp.siren; c.lightPhase = cp.lp || 0; c.burning = cp.burn; c.smoking = cp.smk;
}
function netMakeWorldCar(cp) {
  const c = { netId: cp.id, driver: 'net', colH: cp.tank ? 16 : cp.bike ? 8 : 13, gear: 1,
              kvx: 0, kvy: 0, x: cp.x, y: cp.y, angle: cp.an };
  netApplyCar(c, cp); interpFeed(c, cp.x, cp.y, cp.an);
  return c;
}
// crea l'auto GUIDATA dal player locale a partire dallo snapshot (con la fisica di
// guida, che il payload trasporta: top/accel/mass/gears — servono alla predizione)
function netMakePlayerCar(cp) {
  const c = netMakeWorldCar(cp);
  c.driver = 'player'; c.speed = 0; c.gear = 1;
  c.top = cp.top || 4; c.accel = cp.acc || 0.08; c.mass = cp.mass || 1; c.gears = cp.gears || 4;
  return c;
}

// arriva uno snapshot: aggiorna i target di interpolazione di mondo e ghost
function netOnSnapshot(m) {
  net.snap = m;
  // --- auto del mondo (traffico/polizia/parcheggiate/abbandonate) ---
  const seen = new Set();
  for (const cp of m.cars) {
    seen.add(cp.id);
    let c = net.wcars.get(cp.id);
    if (!c) { c = netMakeWorldCar(cp); net.wcars.set(cp.id, c); }
    else { netApplyCar(c, cp); interpFeed(c, cp.x, cp.y, cp.an); }
  }
  for (const id of net.wcars.keys()) if (!seen.has(id)) net.wcars.delete(id);
  // --- pedoni ---
  const seenP = new Set();
  for (const pp of m.peds) {
    seenP.add(pp.id);
    let p = net.wpeds.get(pp.id);
    if (!p) { p = { netId: pp.id }; net.wpeds.set(pp.id, p); }
    p.facing = pp.f; p.walk = pp.wk; p.role = pp.role; p.ko = pp.ko;
    p.shirt = pp.sh; p.skin = pp.sk; p.hair = pp.ha;
    p.copDress = pp.dr === 1; p.soldierDress = pp.dr === 2;
    interpFeed(p, pp.x, pp.y, pp.f);
  }
  for (const id of net.wpeds.keys()) if (!seenP.has(id)) net.wpeds.delete(id);
  // --- proiettili e razzi (estrapolati localmente tra gli snapshot) ---
  net.wbullets = m.bul.map(b => ({ x: b.x, y: b.y, vx: Math.cos(b.a) * 12, vy: Math.sin(b.a) * 12, hostile: b.hostile }));
  net.wrockets = m.rkt.map(r => ({ x: r.x, y: r.y, vx: Math.cos(r.a) * 6.5, vy: Math.sin(r.a) * 6.5 }));
  // --- monete e incendi (statici: ricostruiti a ogni snapshot) ---
  coins.length = 0; for (const k of m.coins) coins.push({ x: k.x, y: k.y, val: k.v, spin: rnd(0, TAU), bob: rnd(0, TAU) });
  fires.length = 0; for (const f of m.fires) fires.push({ x: f.x, y: f.y, r: 20, hp: 100 });
  // --- effetti cosmetici del server: particelle + audio posizionale ---
  if (m.fx) for (const e of m.fx) netApplyFx(e);
  // --- ghost dei giocatori remoti (posizioni AOI; il roster resta da join/leave) ---
  for (const pv of m.players) {
    let g = net.players.get(pv.id);
    if (!g) { g = makeGhost(pv.id, pv.name, pv.sh); net.players.set(pv.id, g); }
    g.seen = true; g.name = pv.name; g.shirtIdx = pv.sh; g.shirt = NET_SHIRTS[pv.sh % NET_SHIRTS.length];
    g.aim = pv.aim; g.walk = pv.wk; g.moving = pv.mov;
    g.gun = pv.gun; g.hp = pv.hp; g.down = pv.down; if (pv.punch) g.punchT = 10;
    if (pv.car) {
      if (!g.car) g.car = netMakeWorldCar(pv.car);
      else { netApplyCar(g.car, pv.car); interpFeed(g.car, pv.car.x, pv.car.y, pv.car.an); }
      g.car.riderShirt = g.shirt;
    } else { g.car = null; interpFeed(g, pv.x, pv.y, pv.aim); }
  }
  // --- messaggi del server per me (uccisioni, taglie): toast UNA volta per snapshot ---
  if (m.me && Array.isArray(m.me.ev)) for (const t of m.me.ev) { toast(t); if (t[0] === '💀' || t[0] === '🎯') sfx.coin(); }
  // --- classifica dallo snapshot (stats autoritative) ---
  if (Array.isArray(m.sc)) for (const s of m.sc) {
    if (s.id === net.myId) { net.kills = s.k; net.deaths = s.d; }   // punteggio/taglia miei: via `me`
    else { const g = net.players.get(s.id); if (g) g.stats = { k: s.k, d: s.d, c: s.c, s: s.s | 0, b: s.b | 0 }; }
  }
}

// ricrea un effetto cosmetico ricevuto dal server (particelle esistenti + audio)
function netApplyFx(e) {
  if (e.k === 0) { spawnMuzzle(e.x, e.y, e.a); const h = hear(e.x, e.y, 850); if (h) sfx.copShoot(h); }   // sparo
  else if (e.k === 1) spawnBlood(e.x, e.y);
  else if (e.k === 2) spawnSparks(e.x, e.y, e.n || 3);
  else if (e.k === 3) { spawnExplosion(e.x, e.y); const h = hear(e.x, e.y, 1100); if (h) sfx.boom(); }     // esplosione
}

// campiona il mondo all'istante di rendering (nel passato) dal buffer d'interpolazione
// + estrapola i proiettili. Fluido e a velocità corretta a qualunque frame-rate.
function netInterpWorld() {
  const renderT = performance.now() - INTERP_MS;
  for (const c of net.wcars.values()) interpSample(c, renderT);
  for (const p of net.wpeds.values()) interpSample(p, renderT);
  for (const g of net.players.values()) {
    if (g.punchT > 0) g.punchT--;
    if (g.car) { interpSample(g.car, renderT); g.x = g.car.x; g.y = g.car.y; }
    else { interpSample(g, renderT); if (g.moving) g.walk += 0.3; }
  }
  for (const k of coins) { k.spin += 0.13; k.bob += 0.08; }
  for (const b of net.wbullets) { b.x += b.vx; b.y += b.vy; }
  for (const r of net.wrockets) { r.x += r.vx; r.y += r.vy; }
}

// ricostruisce gli array globali che render.js disegna (dai target interpolati)
function netRebuildArrays() {
  cars.length = 0;
  for (const c of net.wcars.values()) cars.push(c);
  if (player.car) cars.push(player.car);
  peds.length = 0;
  for (const p of net.wpeds.values()) peds.push(p);
  bullets.length = 0; for (const b of net.wbullets) bullets.push(b);
  rockets.length = 0; for (const r of net.wrockets) rockets.push(r);
}

// riconcilia il proprio player con lo stato autoritativo (salute, soldi, arma, auto,
// posizione con dead-reckoning: si corregge solo la deriva evidente, non la latenza)
function netReconcileMe() {
  const me = net.snap && net.snap.me;
  if (!me) return;
  if (player.health !== me.hp) { player.health = me.hp; updateHealth(); }
  if (cash !== me.cash) { cash = me.cash; updateCash(); }
  if (me.wp != null && player.weaponIdx !== me.wp) { player.weaponIdx = me.wp; updateWeapon(); }
  if (me.own) player.owned = me.own;
  if (me.wanted != null && me.wanted !== wanted) { wanted = me.wanted; updateStars(); }
  if (me.k != null) net.kills = me.k;
  if (me.d != null) net.deaths = me.d;
  if (me.sco != null) net.score = me.sco;
  if (me.stk != null) net.streak = me.stk;
  if (me.bty != null) { net.bounty = me.bty | 0; updateBountyHud(net.bounty); }   // idempotente ⇒ ok ogni frame
  // auto: crea/rimuovi seguendo l'autorità
  if (me.car && !player.car) { player.car = netMakePlayerCar(me.car); }
  else if (!me.car && player.car) { player.car = null; engineGain(0); }
  else if (me.car && player.car) { player.car.sirenOn = me.car.siren; if (me.car.tur != null) player.car.turretA = me.car.tur; }
  // fuori gioco (morto/arrestato): overlay col conto alla rovescia del server
  const bm = $('#bigMsg');
  if (me.down) {
    downT = me.dt || 1;
    if (bm) {
      bm.classList.remove('hidden'); bm.classList.toggle('busted', me.dk === 'busted');
      const t = $('#bigTitle'); if (t) t.textContent = me.dk === 'busted' ? 'Arrestato' : 'Ti hanno ucciso';
      const c = $('#bigCount'); if (c) c.textContent = Math.max(1, Math.ceil(downT / 60));
    }
  } else {
    if (downT > 0 && bm) bm.classList.add('hidden');
    downT = 0;
  }
  // posizione: CLIENT-AUTHORITATIVE. Il player possiede il proprio movimento e lo
  // simula in locale (updateNetClient); il server NON lo corregge più — era la causa
  // del "server che ti sposta"/rubber-band. Ci si riallinea SOLO su un teletrasporto
  // vero (respawn/arresto che ti riposiziona altrove), oltre una soglia grande.
  const tx = me.car ? me.car.x : me.x, ty = me.car ? me.car.y : me.y;
  if (dist(player.x, player.y, tx, ty) > 300) {
    player.x = tx; player.y = ty;
    if (player.car) { player.car.x = tx; player.car.y = ty; }
  }
}

// comando compatto verso il server (assi, mira, pulsanti one-shot, cambio arma)
function netSendInput() {
  const ax = (held('KeyD', 'ArrowRight') ? 1 : 0) - (held('KeyA', 'ArrowLeft') ? 1 : 0);
  const ay = (held('KeyS', 'ArrowDown') ? 1 : 0) - (held('KeyW', 'ArrowUp') ? 1 : 0);
  const aim = Math.atan2(mouseWY() - player.y, mouseWX() - player.x);
  let b = 0;
  if (mDownL) b |= 1;
  if (net.firePending) { b |= 2; net.firePending = false; }
  if (net.enterEdge) { b |= 4; net.enterEdge = false; }
  if (net.hornEdge) { b |= 8; net.hornEdge = false; }
  const cmd = { t: 'i', seq: ++net.inSeq, ax, ay, aim: Math.round(aim * 256) / 256, b,
                px: Math.round(player.x), py: Math.round(player.y) };   // posizione client-authoritative
  const c = player.car;
  if (c) { cmd.cx = Math.round(c.x); cmd.cy = Math.round(c.y);
           cmd.ca = Math.round(c.angle * 256) / 256; cmd.csp = Math.round(c.speed * 100) / 100; }
  if (typeof touchDrive !== 'undefined' && touchDrive.active) cmd.drive = { active: true, angle: touchDrive.angle };
  if (net.weaponReq != null) { cmd.w = net.weaponReq; net.weaponReq = null; }
  // raggio d'interesse adattivo: chiedo al server SOLO le entità che il mio schermo
  // può mostrare (+ margine per interpolazione/pop-in), non un fisso 1200 tarato sul
  // desktop. Su un telefono taglia di molto entità/banda/GC → più fluido. Lo mando
  // solo quando cambia (orientamento/resize), è idempotente lato server.
  const vr = Math.round(Math.max(vw, vh) * 0.5 + 250);
  if (vr !== net.lastVR) { cmd.vr = vr; net.lastVR = vr; }
  netSend(cmd);
}

// il loop del client autoritativo (chiamato da update() al posto della simulazione)
function updateNetClient() {
  if (mClicked) net.firePending = true;                // ricorda il click (lo sparo lo fa il server)
  updateTrains(false);                                 // treno: solo cinematica (gli urti li decide il server)
  netInterpWorld();                                    // mondo (traffico/pedoni) dagli snapshot
  netRebuildArrays();                                  // popola cars[]/peds[] (mondo + il tuo mezzo)
  netReconcileMe();                                    // salute/soldi/arma/auto/morte dal server (NON la posizione)
  // render interpolation: memorizzo la posizione LOGICA prima del passo (dopo l'eventuale
  // snap di respawn), così il loop (ui.js) può disegnare il player interpolato tra due passi
  // → niente micro-scatti quando un frame esegue 0 o 2 update (fps non allineati a 60).
  player._prevX = player.x; player._prevY = player.y;
  if (player.car) { player.car._prevX = player.car.x; player.car._prevY = player.car.y; }
  // il player è CLIENT-AUTHORITATIVE: simulazione locale completa (movimento + collisioni
  // col traffico) per la massima fluidità. La posizione risultante va al server (netSendInput),
  // che la propaga agli altri. A terra resta fermo (respawn deciso dal server).
  if (downT === 0) {
    player.aim = Math.atan2(mouseWY() - player.y, mouseWX() - player.x);
    if (player.car) updateDrive(player.car); else updatePlayerFoot();
    // il traffico è del server (immobile per noi): risolviamo SOLO la nostra auto contro
    // mondo+rivali (O(n)). Niente resolveCarCollisions O(n²) su tutto il traffico — era
    // la causa degli scatti con molti veicoli vicini e litigava con l'interpolazione.
    resolveRemoteCarCollisions();
  }
  if (frame % 2 === 0) netSendInput();                 // ~30 comandi/s (assi, mira, pulsanti + posizione)
  updateParts();                                       // decadimento particelle cosmetiche locali
  // audio d'ambiente derivato dallo stato autoritativo (il motore lo fa già updateDrive)
  if (wanted > 0 && frame % 26 === 0) sfx.siren((frame / 26) % 2 < 1);
  if (playerSirenOn(player.car) && frame % 24 === 0) sfx.emergency(player.car.livery === 'ambulance', (frame / 24) % 2 < 1);
  // NB: updateCamera() NON qui — la camera segue la posizione INTERPOLATA al momento del
  // render (vedi loop in ui.js), altrimenti seguirebbe i passi logici discreti e sobbalzerebbe.
  frame++;
  if (frame % 30 === 0 && ladderEl && !ladderEl.classList.contains('hidden')) renderLadder();
}

// ---------- Disegno dei ghost (chiamato da render.js) ----------
function netPushEnts(ents) {
  // in autoritativo mostra i ghost solo dopo che uno snapshot li ha posizionati
  for (const g of net.players.values()) if (!g.down && (!net.authoritative || g.seen)) ents.push({ netG: g, y: g.y });
  for (const c of net.looseCars.values()) ents.push(c);   // (Fase 1) mezzi abbandonati dai rivali
  for (const c of net.remoteCops.values()) ents.push(c);  // (Fase 1) volanti dei rivali ricercati
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
  // taglia sulla testa del rivale: bersaglio ambito (💰 in oro sopra il nome)
  const b = (g.stats && g.stats.b) | 0;
  if (b > 0) { ctx.fillStyle = '#ffd23a'; ctx.fillText('🎯 $' + b, x, y - 30); }
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
  const rows = [{ name: playerName, s: net.score, k: net.kills, d: net.deaths, b: net.bounty, me: true }];
  for (const g of net.players.values())
    rows.push({ name: g.name, s: g.stats.s | 0, k: g.stats.k, d: g.stats.d, b: g.stats.b | 0, me: false });
  rows.sort((a, b) => b.s - a.s || b.k - a.k || a.d - b.d);   // punteggio, poi uccisioni, poi meno morti
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
      const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1;
      const name = (r.b > 0 ? '🎯 ' : '') + r.name;          // taglia attiva: bersaglio segnalato
      for (const txt of [rank, name, r.s, r.k, r.d, r.b > 0 ? '$' + r.b : '—']) {
        const td = document.createElement('td');
        td.textContent = txt;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    });
  }
}

// ---------- Taglia sulla propria testa (HUD) ----------
function updateBountyHud(b) {
  const el = document.getElementById('bountyBadge');
  if (!el) return;
  if (b > 0) { el.textContent = `🎯 Taglia: $${b}`; el.classList.remove('hidden'); }
  else el.classList.add('hidden');
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
