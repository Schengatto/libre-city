'use strict';
// =============================================================================
// LIBRE CITY · server/index.js — server multigiocatore (FASE 1)
//
// Sostituisce il P2P via PeerJS/WebRTC. Prima il "server" era l'host, cioè uno
// dei telefoni: appena andava in background il browser lo sospendeva, la sua
// registrazione al broker cadeva e l'INTERA stanza spariva (le disconnessioni
// casuali che vediamo). Qui invece:
//
//   • le stanze vivono in RAM su un processo Node sempre acceso;
//   • il server fa da RIPETITORE dei messaggi (stato/eventi) tra i giocatori,
//     con topologia a stella ma senza un host fragile;
//   • il server POSSIEDE l'orologio della partita (countdown + fine),
//     così la partita non dipende più dal telefono di nessuno;
//   • un riaggancio entro la finestra di grazia (token) recupera lo stesso
//     giocatore senza farlo "uscire e rientrare" agli occhi degli altri.
//
// La SIMULAZIONE (pedoni, traffico, polizia, fisica) resta per ora su ogni
// client, esattamente come prima: questa fase risolve disconnessioni e
// affidabilità del transport. La FASE 2 sposterà la simulazione qui, rendendo
// il server autoritativo sul mondo ed eliminando il disallineamento.
//
// Protocollo (JSON su WebSocket) — compatibile con gli handler già esistenti
// in js/net.js:
//   client → server: create | join | s | shot | punch | rocket | park | gone | kill | ping
//   server → client: ok | no | join | leave | end | kill | <stato/evento ripetuto> | pong
// =============================================================================

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { WebSocketServer } = require('ws');
// Fase 2: simulazione autoritativa del mondo (una città per stanza). Se il modulo
// non è disponibile (o fallisce), il server ricade sul solo relay della Fase 1.
let createRoomSim = null;
try { ({ createRoomSim } = require('./sim-runtime')); }
catch (e) { console.error('sim-runtime non caricato, resto in modalità relay (Fase 1):', e.message); }
// scalda il JIT: la PRIMISSIMA generazione della città è ~2-3× più lenta (cold).
// La facciamo ora, a vuoto, così la prima stanza reale parte già veloce (~90ms).
if (createRoomSim) { try { createRoomSim('WARMUP'); } catch (e) { console.error('warmup sim fallito:', e.message); createRoomSim = null; } }

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
// cartella dei file statici del gioco (build in dist/). Se impostata, il server
// serve ANCHE il sito sulla stessa origin: così il client parla in wss:// verso
// lo stesso host, senza CORS. Vuota = solo WebSocket (deploy separato del sito).
const STATIC_DIR = process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : '';
const GRACE_MS = 30_000;          // finestra di riaggancio dopo una caduta di rete
const HEARTBEAT_MS = 30_000;      // ping applicativo per scovare le socket morte
// Tetto di vita ASSOLUTO della stanza: qualunque istanza viene abbattuta 35 min
// dopo la creazione, a prescindere dai minuti di partita, dai riagganci o dai
// giocatori ancora connessi. Evita le stanze "fantasma" che restano in RAM a
// simulare (sim a 60Hz = CPU) per ore quando nessuno le chiude davvero.
const MAX_ROOM_MS = 35 * 60_000;
// La sim (movimento/fisica) è a PASSO FISSO tarato su 60Hz, come il single-player e
// come la predizione del client: simulare a 30Hz faceva girare TUTTO il mondo
// autoritativo a metà velocità (74 px/s invece di 148) e, con il client che predice
// a 60Hz, lo faceva sbattere indietro a ogni snapshot (rubber-band). Deve stare a 60.
const SIM_HZ = 60;                // = rate del movimento/SP/predizione client (NON toccare senza rifare la fisica in dt)
const SNAP_EVERY = 2;             // uno snapshot ogni N tick → ~30/s. Raddoppiato da 15/s per
                                 // dimezzare il ritardo con cui i rivali/il mondo appaiono "nel
                                 // passato" (col client a INTERP_MS=50). Banda ~2x ma compressa
                                 // da permessage-deflate e limitata dall'AOI per-giocatore.
const MAX_PLAYERS_CAP = 8;        // tetto assoluto di giocatori per stanza
const SHIRTS = 8;                 // maglie disponibili (vedi NET_SHIRTS nel client)
const MAX_PAYLOAD = 64 * 1024;    // un messaggio di stato è ~qualche centinaio di byte
// Versione del client servito da questo server (build hash generato da build.js in
// version.json). Il server la manda nell'handshake `ok`; il client la confronta con
// la propria (window.LC_BUILD) e, se differiscono, invita a ricaricare la pagina.
// Env LC_BUILD sovrascrive. NON leggerla una-tantum: public/ è un bind mount che un
// deploy solo-client aggiorna SENZA ricreare il container (l'immagine server è invariata,
// quindi il processo non riparte). Un valore memorizzato all'avvio resterebbe stantio e
// farebbe scattare "Nuova versione" a ogni ingresso. Rileggiamo il file, con cache su
// mtime → zero I/O superfluo, ma ogni nuovo deploy viene raccolto senza riavvio.
const VERSION_FILE = path.join(STATIC_DIR, 'version.json');
let _buildCache = { mtimeMs: -1, build: '' };
function serverBuild() {
  if (process.env.LC_BUILD) return process.env.LC_BUILD;
  try {
    const mtimeMs = fs.statSync(VERSION_FILE).mtimeMs;
    if (mtimeMs !== _buildCache.mtimeMs) {
      _buildCache = { mtimeMs, build: JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')).build || '' };
    }
    return _buildCache.build;
  } catch { return ''; }
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const now = () => Date.now();
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- Profilazione opzionale (SIM_PROFILE=1) --------------------------
// A costo ZERO quando spenta. Misura i tre numeri che decidono se/quando passare
// ai worker thread: durata della gen-città (spike una tantum), durata del giro di
// tick()+snapshot (costo sostenuto), e LAG dell'event loop (di quanto le stanze si
// bloccano a vicenda). `cpu%` = frazione di un core spesa nella sim: vicino al
// 100% con lag che sale = tetto raggiunto, è ora dei worker. SIM_PROFILE_MS regola
// il periodo del report (default 10s).
const PROFILE = !!process.env.SIM_PROFILE;
const PROFILE_MS = Number(process.env.SIM_PROFILE_MS) || 10_000;
const prof = { tickN: 0, tickSum: 0, tickMax: 0, genN: 0, genSum: 0, genMax: 0, lagN: 0, lagSum: 0, lagMax: 0 };
function profAdd(k, ms) { prof[k + 'N']++; prof[k + 'Sum'] += ms; if (ms > prof[k + 'Max']) prof[k + 'Max'] = ms; }
// crea una sim misurando (se richiesto) il tempo di generazione della città
function makeSim(code) {
  if (!PROFILE) return createRoomSim(code);
  const t0 = performance.now();
  const sim = createRoomSim(code);
  profAdd('gen', performance.now() - t0);
  return sim;
}

const rooms = new Map();          // CODICE(maiuscolo) → stanza

// ---------- Stanza ----------------------------------------------------------
// Una stanza tiene i giocatori (anche quelli in "grazia", momentaneamente
// caduti) e l'istante di avvio da cui si ricava il tempo rimasto.
function activeCount(room) {
  let n = 0;
  for (const p of room.players.values()) if (!p.gone) n++;
  return n;
}
// tempo rimasto in FRAME (~60/s): il client conta a frame, glielo diamo pronto
function roomLeftFrames(room) {
  if (!room.minutes) return 0;                       // 0 = partita senza limite di tempo
  const remMs = room.minutes * 60_000 - (now() - room.startAt);
  return Math.max(0, Math.round((remMs / 1000) * 60));
}
function roster(room, exceptId) {
  const out = [];
  for (const p of room.players.values()) {
    if (p.gone || p.id === exceptId) continue;
    out.push({ id: p.id, name: p.name, shirtIdx: p.shirtIdx });
  }
  return out;
}
function broadcast(room, msg, exceptId) {
  const s = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.gone || p.id === exceptId || !p.ws || p.ws.readyState !== 1) continue;
    try { p.ws.send(s); } catch {}
  }
}
function sendRaw(ws, msg) {
  if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(msg)); } catch {} }
}
// alla scadenza dei minuti il server avvisa TUTTI: nessuno resta indietro
function scheduleEnd(room) {
  clearTimeout(room.endTimer);
  if (!room.minutes) return;
  const ms = Math.max(0, room.minutes * 60_000 - (now() - room.startAt));
  room.endTimer = setTimeout(() => broadcast(room, { t: 'end' }), ms);
}
// abbattimento forzato allo scadere del tetto di vita: avvisa chi è ancora
// connesso (così la UI chiude la partita) e poi libera tutto.
function scheduleReaper(room) {
  clearTimeout(room.reaperTimer);
  room.reaperTimer = setTimeout(() => {
    log('room reaped', room.code, `(vita > ${Math.round(MAX_ROOM_MS / 60_000)}min)`);
    broadcast(room, { t: 'end' });
    destroyRoom(room);
  }, MAX_ROOM_MS);
}
function destroyRoom(room) {
  clearTimeout(room.endTimer);
  clearTimeout(room.reaperTimer);
  stopSim(room);
  for (const p of room.players.values()) clearTimeout(p.dropTimer);
  rooms.delete(room.code);
  log('room destroyed', room.code);
}

// ---------- Simulazione autoritativa del mondo (Fase 2) -------------------
// Ogni stanza simula UNA città (traffico, pedoni, polizia, fisica) e ne diffonde
// snapshot per area d'interesse. I client mandano solo INPUT ('i') e disegnano.
function startSim(room) {
  if (!createRoomSim) return;                 // modulo assente: resta relay Fase 1
  try { room.sim = makeSim(room.code); }
  catch (e) { console.error('sim non avviata per', room.code, '—', e.message); room.sim = null; return; }
  room.simTick = 0;
  // Accumulatore a passo fisso (come il client): il mondo avanza a ESATTAMENTE
  // SIM_HZ passi/s di wall-clock anche se il timer di Node è impreciso/in ritardo.
  // Senza, setInterval(17ms) rende ~55Hz → mondo al 92% e client (60Hz) più veloce
  // del server → rubber-band residuo. Con l'accumulatore i due rate combaciano.
  const STEP = 1000 / SIM_HZ;
  room.simAcc = 0;
  room.simLast = performance.now();
  room.simTimer = setInterval(() => {
    const t0 = PROFILE ? performance.now() : 0;
    const t = performance.now();
    room.simAcc += Math.min(t - room.simLast, STEP * 5);   // clamp: dopo un blocco non recuperare all'infinito
    room.simLast = t;
    let doSnap = false;
    try {
      while (room.simAcc >= STEP) {
        room.sim.tick();
        room.simAcc -= STEP;
        if (++room.simTick % SNAP_EVERY === 0) doSnap = true;   // uno snapshot per giro anche se recupero più tick
      }
      if (doSnap) {
        for (const p of room.players.values()) {
          if (p.gone || !p.ws || p.ws.readyState !== 1) continue;
          const snap = room.sim.snapshotFor(p.id);
          if (snap) { snap.sc = room.sim.scores(); try { p.ws.send(JSON.stringify(snap)); } catch {} }
        }
        room.sim.clearFx();                     // gli fx del giro sono stati spediti: svuota
      }
    } catch (e) { console.error('tick error', room.code, e.message); }
    if (PROFILE) profAdd('tick', performance.now() - t0);   // include serializzazione+send: è il vero costo sul main loop
  }, Math.round(1000 / SIM_HZ));
}
function stopSim(room) {
  clearInterval(room.simTimer); room.simTimer = null; room.sim = null;
}

// ---------- Ingresso in partita --------------------------------------------
function addPlayer(ws, room, name) {
  const n = ++room.idSeq;                    // 1 al creatore, poi 2, 3, …
  const id = 'p' + n;
  const p = {
    id, name: String(name || 'Ospite').slice(0, 14), shirtIdx: (n - 1) % SHIRTS,  // creatore → maglia 0
    token: crypto.randomUUID(), ws: null, gone: false, dropTimer: null,
  };
  room.players.set(id, p);
  bindWs(ws, room, p);
  if (room.sim) room.sim.addPlayer(p.name, p.shirtIdx, p.id);   // Fase 2: entra nella città autoritativa
  sendRaw(ws, {
    t: 'ok', id: p.id, shirtIdx: p.shirtIdx, minutes: room.minutes,
    left: roomLeftFrames(room), players: roster(room, p.id), token: p.token, sim: !!room.sim,
    build: serverBuild(),
  });
  broadcast(room, { t: 'join', id: p.id, name: p.name, shirtIdx: p.shirtIdx }, p.id);
  log('join', room.code, p.id, p.name, `(${activeCount(room)}/${room.max})`);
}
// aggancia una (nuova) socket a un giocatore: usata sia al primo ingresso sia
// al riaggancio. ws._room/ws._pid identificano il mittente nei messaggi seguenti.
function bindWs(ws, room, p) {
  p.ws = ws;
  ws._room = room;
  ws._pid = p.id;
}

// crea la stanza (chi la crea è il primo giocatore, maglia 0)
function handleCreate(ws, m) {
  const code = String(m.code || '').toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) { sendRaw(ws, { t: 'no', r: 'badcode' }); return; }
  const existing = rooms.get(code);
  if (existing && activeCount(existing) > 0) { sendRaw(ws, { t: 'no', r: 'exists' }); return; }
  if (existing) destroyRoom(existing);
  const room = {
    code, pass: String(m.pass || ''), max: clamp(+m.max || 4, 2, MAX_PLAYERS_CAP),
    minutes: Math.max(0, +m.minutes || 0), startAt: now(),
    idSeq: 0, players: new Map(), endTimer: null,
  };
  rooms.set(code, room);
  scheduleEnd(room);
  scheduleReaper(room);                      // tetto di vita assoluto: 35 min poi via
  startSim(room);                            // Fase 2: avvia la città autoritativa della stanza
  log('room created', code, 'by', String(m.name || '?'), `(${room.minutes}min, max ${room.max}, sim ${room.sim ? 'on' : 'off'})`);
  addPlayer(ws, room, m.name);
}
// entra in una stanza esistente (o riaggancia con il token)
function handleJoin(ws, m) {
  const code = String(m.code || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) { sendRaw(ws, { t: 'no', r: 'notfound' }); return; }

  // riaggancio: stesso token entro la grazia → stesso id/maglia, niente flicker
  if (m.token) {
    const p = [...room.players.values()].find(pp => pp.token === m.token);
    if (p) {
      clearTimeout(p.dropTimer); p.dropTimer = null;
      const wasGone = p.gone; p.gone = false;
      bindWs(ws, room, p);
      sendRaw(ws, {
        t: 'ok', id: p.id, shirtIdx: p.shirtIdx, minutes: room.minutes,
        left: roomLeftFrames(room), players: roster(room, p.id), token: p.token, resumed: true, sim: !!room.sim,
        build: serverBuild(),
      });
      // se la sua uscita era già stata annunciata, gli altri lo re-inseriscono
      if (wasGone) broadcast(room, { t: 'join', id: p.id, name: p.name, shirtIdx: p.shirtIdx }, p.id);
      log('resume', room.code, p.id, p.name);
      return;
    }
  }

  if ((room.pass || '') !== String(m.pass || '')) { sendRaw(ws, { t: 'no', r: 'pass' }); return; }
  if (activeCount(room) >= room.max) { sendRaw(ws, { t: 'no', r: 'full' }); return; }
  addPlayer(ws, room, m.name);
}

// ---------- Messaggi di gioco (relay) --------------------------------------
function onGameMessage(ws, m) {
  const room = ws._room;
  const p = room && room.players.get(ws._pid);
  if (!room || !p) return;
  switch (m.t) {
    // Fase 2: input del giocatore → città autoritativa (nessun relay: il mondo lo
    // possiede il server, che risponde con gli snapshot 'w')
    case 'i':
      if (room.sim) room.sim.applyInput(p.id, m);
      break;
    // Fase 1 (compat): stato ed eventi ripetuti agli altri firmati con l'id del mittente
    case 's': case 'shot': case 'punch': case 'rocket': case 'park': case 'gone':
      broadcast(room, { ...m, id: p.id }, p.id);
      break;
    // kill credit: la VITTIMA (p) segnala chi l'ha stesa (m.to); lo diciamo a lui
    case 'kill': {
      const target = room.players.get(m.to);
      if (target && !target.gone) sendRaw(target.ws, { t: 'kill', id: p.id });
      break;
    }
    case 'ping':
      sendRaw(ws, { t: 'pong' });
      break;
  }
}

// ---------- Caduta di connessione ------------------------------------------
// Non annunciamo subito l'uscita: diamo GRACE_MS per riagganciarsi (telefono
// tornato in primo piano, wifi che rientra). Se scade, allora l'uscita è vera.
function onDisconnect(ws) {
  const room = ws._room;
  const p = room && room.players.get(ws._pid);
  if (!p || p.ws !== ws) return;        // socket già sostituita da un riaggancio: ignora
  if (p.gone) return;
  p.gone = true;
  p.dropTimer = setTimeout(() => {
    room.players.delete(p.id);
    if (room.sim) room.sim.removePlayer(p.id);   // uscita vera: via anche dalla città autoritativa
    broadcast(room, { t: 'leave', id: p.id });
    log('leave', room.code, p.id, p.name);
    if (room.players.size === 0) destroyRoom(room);
  }, GRACE_MS);
}

// ---------- File statici del gioco -----------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.map': 'application/json',
};
// header di cache coerenti con build.js: asset con hash immutabili, HTML/SW/
// version sempre freschi, icone cache breve.
function cacheControl(rel) {
  if (/\.[0-9a-f]{10}\.js$/.test(rel)) return 'public, max-age=31536000, immutable';
  if (rel === 'version.json') return 'no-store';
  if (rel === 'index.html' || rel === '' || rel === 'sw.js' || rel === 'manifest.webmanifest')
    return 'no-cache, must-revalidate';
  if (rel.startsWith('icons/')) return 'public, max-age=86400';
  return 'public, max-age=3600';
}
function serveStatic(req, res) {
  // solo GET/HEAD; niente query/hash; blocca il path traversal
  let rel = decodeURIComponent((req.url.split('?')[0] || '/')).replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  const full = path.join(STATIC_DIR, rel);
  if (!full.startsWith(STATIC_DIR + path.sep) && full !== STATIC_DIR) { res.writeHead(403); res.end(); return; }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      // navigazione verso una rotta senza file → l'app-shell (index.html)
      if (rel !== 'index.html' && !path.extname(rel)) return sendFile(res, path.join(STATIC_DIR, 'index.html'), 'index.html', req.method);
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found'); return;
    }
    sendFile(res, full, rel, req.method);
  });
}
function sendFile(res, full, rel, method) {
  const headers = { 'content-type': MIME[path.extname(full)] || 'application/octet-stream',
                    'cache-control': cacheControl(rel) };
  if (method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
  const stream = fs.createReadStream(full);
  stream.on('open', () => { res.writeHead(200, headers); stream.pipe(res); });
  stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
}

// ---------- HTTP + WebSocket ------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.url === '/health' || (req.url.split('?')[0] === '/health')) {
    const players = [...rooms.values()].reduce((n, r) => n + activeCount(r), 0);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players }));
    return;
  }
  if (STATIC_DIR && (req.method === 'GET' || req.method === 'HEAD')) { serveStatic(req, res); return; }
  res.writeHead(404); res.end();
});

// permessage-deflate: gli snapshot 'w' sono JSON con chiavi molto ripetitive e
// pesano decine di KB grezzi (a 15/s = ~centinaia di KB/s per giocatore: su mobile
// la socket si intasa e TUTTO diventa lentissimo). Comprimono a ~15-18% del grezzo
// per ~2ms di CPU a giro: il singolo intervento che rende giocabile il multiplayer.
// Livello basso (rapporto quasi uguale, meno CPU); soglia per saltare i messaggi
// piccoli (input del client); niente context-takeover lato client per non far
// crescere la RAM sui telefoni.
const wss = new WebSocketServer({
  server, maxPayload: MAX_PAYLOAD,
  perMessageDeflate: {
    threshold: 256,                       // sotto i 256B non conviene comprimere
    zlibDeflateOptions: { level: 3, memLevel: 8 },
    clientNoContextTakeover: true, serverNoContextTakeover: false,
    concurrencyLimit: 10,
  },
});

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });   // risposta al ping del cuore (frame WS nativo)
  ws.on('message', data => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'ping') { sendRaw(ws, { t: 'pong' }); return; }   // keepalive applicativo
    if (!ws._pid) {                                // non ancora in una stanza: solo create/join
      if (m.t === 'create') handleCreate(ws, m);
      else if (m.t === 'join') handleJoin(ws, m);
      else ws.close();
      return;
    }
    onGameMessage(ws, m);
  });
  ws.on('close', () => onDisconnect(ws));
  ws.on('error', () => onDisconnect(ws));
});

// battito del cuore: chi non risponde al ping entro un giro è una socket morta
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

// ---------- Report di profilazione (solo con SIM_PROFILE) -------------------
if (PROFILE) {
  // lag dell'event loop: un timer a intervallo fisso; quanto arriva in ritardo
  // oltre l'intervallo previsto è tempo in cui il loop era occupato (tick/gen).
  let last = performance.now();
  const lagTimer = setInterval(() => {
    const p = performance.now();
    const lag = (p - last) - 500;
    last = p;
    if (lag > 0) profAdd('lag', lag);
  }, 500);
  const reportTimer = setInterval(() => {
    const tickAvg = prof.tickN ? prof.tickSum / prof.tickN : 0;
    const lagAvg = prof.lagN ? prof.lagSum / prof.lagN : 0;
    const cpu = (prof.tickSum / PROFILE_MS) * 100;   // ms di tick per ms di wall-clock = frazione di un core
    log('[profile]',
      `rooms=${rooms.size}`,
      `ticks=${prof.tickN}`,
      `tick(ms) avg=${tickAvg.toFixed(2)} max=${prof.tickMax.toFixed(1)}`,
      `cpu=${cpu.toFixed(1)}%`,
      `loop-lag(ms) avg=${lagAvg.toFixed(1)} max=${prof.lagMax.toFixed(1)}`,
      prof.genN ? `gen(ms) n=${prof.genN} avg=${(prof.genSum / prof.genN).toFixed(1)} max=${prof.genMax.toFixed(1)}` : 'gen=—');
    prof.tickN = prof.tickSum = prof.tickMax = 0;
    prof.genN = prof.genSum = prof.genMax = 0;
    prof.lagN = prof.lagSum = prof.lagMax = 0;
  }, PROFILE_MS);
  lagTimer.unref?.(); reportTimer.unref?.();      // non tengono vivo il processo
  log('profilazione attiva (SIM_PROFILE): report ogni', PROFILE_MS + 'ms');
}

server.listen(PORT, HOST, () => log(`Libre City server in ascolto su ${HOST}:${PORT}`
  + (STATIC_DIR ? ` · serve i file statici da ${STATIC_DIR}` : ' · solo WebSocket')));

// spegnimento pulito (Fly/Railway mandano SIGTERM al redeploy)
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { log('shutdown', sig); server.close(); process.exit(0); });
}
