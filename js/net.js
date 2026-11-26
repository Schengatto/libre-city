// VIBE CITY · js/net.js — multiplayer: create/join a room on a real WebSocket SERVER,
// ghosts of remote players, PvP damage and the scoreboard (ladder).
//
// PHASE 1. The transport is no longer P2P over PeerJS/WebRTC but an always-on Node server
// (see server/): no more phone-as-host that, once backgrounded, took the whole room down
// with it (the cause of the random disconnections). The server holds the rooms, relays
// messages and owns the match clock. Reconnecting with the token recovers the same player.
//
// MODEL (unchanged in Phase 1). Every client still simulates ITS OWN city: pedestrians,
// traffic and police are local (the map is identical for everyone thanks to the ROOM_CODE
// seed, see core.js). Only position/vehicle/shots travel between players (~15 messages a
// second). PvP damage is decided by WHOEVER TAKES IT (authoritative victim): the player hit
// removes their own health and, if they die, credits the kill to the shooter with a 'kill'
// message. PHASE 2 moves the simulation onto the server, removing the divergence.

const NET_SHIRTS = ['#e0533a', '#3a72d2', '#37a05a', '#c9a227', '#8a3ad2', '#e06a2a', '#2ab0b0', '#d94a90'];

const net = {
  mode: null,            // null = single-player · 'host' (created the room) · 'client'
  sock: null,            // WebSocket to the server
  url: null,             // resolved server URL (see netServerUrl)
  players: new Map(),    // id → remote player's ghost
  myId: null, token: null,           // token: key to reconnect as the same player
  hostId: null,
  pass: '', maxPlayers: 4,
  hello: null, rejoin: null, _open: null,   // data for (re)opening the connection
  clockLeft: null,       // match frames left, as reported by the server
  reconnT: null, reconnDelay: 0, wantOpen: false, dropped: false,  // automatic reconnection
  // ---- Waiting queue (server at its room cap) ----
  qtoken: null,          // key to reclaim OUR OWN place in the queue after a drop
  queue: null,           // { pos, eta, rooms, max, at } · null = not queued
  queueT: null,          // timer for the countdown shown on screen
  wake: null,            // wake lock: screen stays on while in multiplayer
  kills: 0, deaths: 0, score: 0, streak: 0, bounty: 0,   // score, streak and the bounty on our head
  lastHitBy: null, lastHitT: -9999,   // last rival who hit us (for the kill credit)
  looseCars: new Map(),   // netId → vehicle abandoned by a rival (shared parked shape)
  carSeq: 0,              // running id for the vehicles the local player drives
  remoteCops: new Map(),  // netId → patrol car chasing a wanted rival (shared, drawn and solid)
  copSeq: 0,              // running id for the patrol cars I broadcast while wanted
  // ---- Phase 2: client of an AUTHORITATIVE SERVER ----
  authoritative: false,   // true = the server owns the world; here we only render it
  snap: null,             // last 'w' snapshot received
  lastSnapTick: -1,
  snapshotRing: new Map(),
  snapshotAckTick: null,
  trainOffset: null, trainOffsetTarget: 0, trainSlewFrame: 0,
  inSeq: 0,               // running id of the input sent
  firePending: false, enterEdge: false, hornEdge: false, weaponReq: null,  // one-shot actions → server
  wcars: new Map(), wpeds: new Map(),   // id → world entities (interpolated)
  wbullets: [], wrockets: [],           // bullets/rockets (extrapolated between snapshots)
  predBullets: [], predictedShots: [],
};
const netActive = () => net.mode !== null;

// ---------- Server URL -----------------------------------------------------
// In development (localhost / file://) it points at the local server on 8787. In production
// the URL comes from <meta name="vc-server" content="wss://…"> in index.html (or from
// window.VIBE_CITY_SERVER or ?server=…). That keeps net.js generic and lets the server
// address be configured without touching the code.
const NET_PROD_SERVER = '';       // fallback when there is no meta/override (fill in after deploy)
function netServerUrl() {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q;
  const meta = document.querySelector('meta[name="vc-server"]');
  if (meta && meta.content.trim()) return meta.content.trim();
  if (window.VIBE_CITY_SERVER) return window.VIBE_CITY_SERVER;
  const h = location.hostname;
  if (!h || h === 'localhost' || h === '127.0.0.1') return 'ws://' + (h || 'localhost') + ':8787';
  return NET_PROD_SERVER || null;
}

// ---------- Ghost: the shape of a remote player ----------
function makeGhost(id, name, shirtIdx) {
  return {
    id, name: String(name || 'Ospite').slice(0, 14),
    shirtIdx: shirtIdx || 0, shirt: NET_SHIRTS[(shirtIdx || 0) % NET_SHIRTS.length],
    skin: '#f6c79a', hair: '#3a2410',
    x: player.x, y: player.y, tx: player.x, ty: player.y,   // current and target position (interpolated)
    aim: 0, walk: 0, moving: false, gun: false, hp: 100, down: false,
    punchT: 0, car: null,
    stats: { k: 0, d: 0, c: 0, s: 0, b: 0 },
  };
}

// ---------- Connecting to the server (host = create, client = join) ----------
// The host CREATES the room on the server; the client JOINS it. After that first entry they
// are symmetric: both send state/events to the server, which signs them with their id and
// relays them to the others. A token allows reconnecting as the same player after a network
// drop.

// Host: creates the room and sets its parameters (duration, max players, password).
function netStartHost(pass, maxPlayers, police, done, options) {
  const url = netServerUrl();
  if (!url) { done('noserver'); return; }
  net.mode = 'host'; net.url = url;
  net.pass = pass || ''; net.maxPlayers = clamp(maxPlayers || 4, 2, 8);
  player.shirt = NET_SHIRTS[0];                 // in multiplayer everyone gets their own shirt
  document.body.classList.add('mp');
  net.rejoin = { code: ROOM_CODE, name: playerName, pass: net.pass };
  net.hello  = { t: 'create', code: ROOM_CODE, name: playerName, pass: net.pass,
                 max: net.maxPlayers, minutes: gameMinutes, police,
                 title: (options && options.title) || '', public: !!(options && options.isPublic) };
  netDial(done);
}
// Client: joins a room that already exists.
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

// Opens the WebSocket, handles the initial entry and sets up automatic reconnection.
// done(null) on success, done(errorCode) on failure.
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
    ws.binaryType = 'arraybuffer';
    net.sock = ws;
    ws.onopen = () => {
      net.reconnDelay = 0;
      // First entry: initial create/join · reconnect: join with the token · reconnect while
      // queued: create with the qtoken, to reclaim our place.
      const hello = net.token ? { ...net.rejoin, t: 'join', token: net.token }
                  : net.qtoken ? { ...net.hello, qtoken: net.qtoken }
                  : net.hello;
      ws.send(JSON.stringify({ ...hello, ...netClientInfo() }));
    };
    ws.onmessage = ev => {
      if (ev.data instanceof ArrayBuffer) {
        const snapshot = settled ? netDecodeBinarySnapshot(ev.data) : null;
        if (snapshot) onServerMessage(snapshot);
        return;
      }
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || typeof m !== 'object' || netForgedSnapshotFrame(ev.data, m)) return;
      if (!settled) {                            // awaiting the outcome of the first entry
        if (m.t === 'ok') { settled = true; clearTimeout(timer); netQueueEnd(); netOnJoined(m); netWakeLock(); done(null); return; }
        if (m.t === 'no') { settled = true; clearTimeout(timer); netQueueEnd(); netShutdown(); done(m.r); return; }
        // Server at its cap: we are queued. This is NOT a failure and there is no maximum
        // wait any more — the match starts by itself when our turn comes.
        if (m.t === 'queued') { clearTimeout(timer); netOnQueued(m); return; }
        return;                                  // other messages before the ok: ignored
      }
      onServerMessage(m);
    };
    ws.onclose = () => {
      if (ws !== net.sock) return;               // socket already replaced by a reconnect
      if (!settled) { status(t('net.retry')); netScheduleReconnect(); return; }
      if (net.wantOpen) {                         // dropped after entry: silent reconnect
        if (!net.dropped) { net.dropped = true; toast(t('net.lost')); netRefreshBadge(); }
        netScheduleReconnect();
      }
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  };
  net._open = open;
  open();
}
function netClientInfo() {
  return { dev: usingTouch ? 'touch' : 'desktop', build: window.LC_BUILD || null };
}
const NET_SNAPSHOT_FRAME_PREFIX = '{"t":"w"';
function netDecodeBinarySnapshot(data) {
  const decoded = snapshotDecode(new Uint8Array(data));
  return decoded && typeof decoded === 'object' && decoded.t === 'w' ? decoded : null;
}
function netForgedSnapshotFrame(raw, m) {
  return typeof raw === 'string' && raw.startsWith(NET_SNAPSHOT_FRAME_PREFIX) && m.t !== 'w';
}
// Reconnect with growing backoff (up to ~8s); `immediate` retries straight away.
function netScheduleReconnect(immediate) {
  if (!net.wantOpen || !net._open) return;
  clearTimeout(net.reconnT);
  net.reconnDelay = immediate ? 0 : Math.min((net.reconnDelay || 400) * 1.6, 8000);
  net.reconnT = setTimeout(() => { if (net.wantOpen) net._open(); }, net.reconnDelay);
}

// ---------- Waiting queue ----------
// The server caps the number of simultaneous rooms: beyond it, everybody's match would start
// to stutter. At the cap we are not turned away but put in line, and the room opens BY
// ITSELF when our turn comes (an ordinary 'ok' arrives): only the state for the waiting
// screen is kept here. Sessions are time-limited, so the server can estimate the remaining
// wait and refreshes it every few seconds.
function netOnQueued(m) {
  net.qtoken = m.qtoken || net.qtoken;
  net.queue = { pos: m.pos | 0, eta: Math.max(0, m.eta | 0), rooms: m.rooms | 0, max: m.max | 0, at: Date.now() };
  if (!net.queueT) net.queueT = setInterval(updateQueuePanel, 1000);   // estimate ticking down between refreshes
  showQueuePanel();
}
// How long is left RIGHT NOW: the server's last estimate minus the time elapsed since.
function netQueueEta() {
  if (!net.queue) return 0;
  return Math.max(0, net.queue.eta - (Date.now() - net.queue.at));
}
function netQueueEnd() {
  clearInterval(net.queueT); net.queueT = null;
  net.queue = null; net.qtoken = null;
}
// The user gives up waiting: leave the queue and go back to the "create" panel.
function netCancelQueue() {
  netSend({ t: 'unqueue' });
  netQueueEnd();
  netShutdown();
}

// Applies a successful entry (or reconnect): id, shirt, roster, clock.
function netOnJoined(m) {
  const resumed = !!m.resumed;
  net.myId = m.id;
  if (m.token) net.token = m.token;
  net.authoritative = !!m.sim;                       // Phase 2: the server simulates the world
  net.hostId = m.host ?? null;
  netResetSnapshotBaseline();
  netSyncHostRole();
  player.shirt = NET_SHIRTS[m.shirtIdx % NET_SHIRTS.length];
  if (m.minutes != null) gameMinutes = m.minutes;   // the server sets the match's pace
  policeOn = m.police !== false;
  net.clockLeft = m.left;
  if (resumed && started && gameMinutes > 0) timeLeft = net.clockLeft;
  // Sync the roster without clearing ghosts that are already there (important on reconnect).
  for (const p of (m.players || [])) if (!net.players.has(p.id)) net.players.set(p.id, makeGhost(p.id, p.name, p.shirtIdx));
  if (!resumed && !net.authoritative) {
    // First entry (Phase 1 only): offset the position so players do not start stacked up
    // (in authoritative mode the server decides the position).
    player.x += 26 * m.shirtIdx;
    unstick(player, player.r, player.r);
  } else if (net.dropped) {
    net.dropped = false; toast(t('net.back'));
  }
  netRefreshBadge();
  // The server is on a different build from ours → prompt for a client reload.
  if (m.build && window.LC_BUILD && m.build !== window.LC_BUILD) netUpdatePrompt();
}
function netSyncHostRole() {
  if (net.hostId !== null && net.hostId === net.myId) {
    if (!simHostActive()) simHostStart();
    rtcGuestClose();
    net.stats.transport = 'host';
  } else {
    simHostStop();
    if (net.hostId !== null) rtcGuestConnect(net.hostId);
    else rtcGuestClose();
  }
}

// Shows a persistent notice when the running client is older than the server (typically: a
// page left open from before a deploy). A click reloads. Idempotent: on reconnect the server
// sends `ok` again, but the banner stays a single one.
function netUpdatePrompt() {
  if (net.updatePrompted) return;
  net.updatePrompted = true;
  let el = document.getElementById('updateBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'updateBanner';
    el.textContent = t('net.update');
    el.addEventListener('click', () => location.reload());
    document.body.appendChild(el);
  }
  el.classList.add('show');
}

// Dispatches the server's messages after entry.
function onServerMessage(m) {
  switch (m.t) {
    case 'ok': netOnJoined(m); break;             // reconnect succeeded
    case 'join':
      net.players.set(m.id, makeGhost(m.id, m.name, m.shirtIdx));
      toast(t('net.joined', { name: m.name })); sfx.coin(); netRefreshBadge();
      break;
    case 'leave': {
      const g = net.players.get(m.id);
      if (g) { net.players.delete(m.id); netDropCarsOf(m.id); toast(t('net.left', { name: g.name })); }
      netRefreshBadge();
      break;
    }
    case 'rtc': if (simHostActive()) rtcHostOnSignal(m.from, m.k, m.d); else rtcGuestOnSignal(m.from, m.k, m.d); break;
    case 'host': {
      const hostChanged = (m.id ?? null) !== net.hostId;
      net.hostId = m.id ?? null;
      netResetSnapshotBaseline();
      netSyncHostRole();
      if (hostChanged && net.hostId !== null && net.hostId !== net.myId) toast(t('net.newHost', { name: m.name }));
      break;
    }
    case 'end': simHostStop(); if (started) endGame('time'); break;
    case 'no':
      if (m.r === 'notfound') { net.wantOpen = false; clearTimeout(net.reconnT); if (started) endGame('time'); }
      break;
    case 'kill': netScoreKill(m.id); break;
    case 'w': netOnSnapshot(m); break;             // Phase 2: authoritative world snapshot
    case 'pong': netStatsOnPong(net.stats, m.c, performance.now()); break;
    default: if (m.id && m.id !== net.myId) netApplyRemote(m.id, m);
  }
}

// Shuts everything down and returns to single-player mode (ghosts included).
function netShutdown() {
  net.wantOpen = false; net.dropped = false;
  simHostStop(); rtcGuestClose(); net.hostId = null; netResetSnapshotBaseline();
  clearTimeout(net.reconnT); net.reconnT = null;
  clearInterval(net.queueT); net.queueT = null; net.queue = null; net.qtoken = null;
  try { if (net.wake) net.wake.release(); } catch (e) {}
  net.wake = null;
  if (net.sock) { try { net.sock.onclose = null; net.sock.onerror = null; net.sock.close(); } catch (e) {} }
  net.sock = null; net._open = null; net.hello = null; net.rejoin = null;
  net.players.clear(); net.looseCars.clear(); net.remoteCops.clear();
  net.mode = null; net.myId = null; net.token = null; net.clockLeft = null;
  net.trainOffset = null;
  net.predBullets.length = 0; net.predictedShots.length = 0;
  net.stats = createNetStats();
  net.score = 0; net.streak = 0; net.bounty = 0; updateBountyHud(0);
  policeOn = true;
  document.body.classList.remove('mp');
  netRefreshBadge();
}

// ---------- Surviving a backgrounded phone ----------
// With the screen off or the app in the background, the browser suspends the page and the
// WebSocket drops. With a real server the room does NOT disappear though: on returning to
// the foreground we reconnect with the token and resume the same player (within the grace
// period).
function netWakeLock() {
  if (!netActive() || !navigator.wakeLock) return;
  navigator.wakeLock.request('screen').then(w => { net.wake = w; }, () => {});
}
function netWakeIfNeeded() {
  if (!netActive()) return;
  netWakeLock();
  if (!net.sock || net.sock.readyState > 1) netScheduleReconnect(true);   // CLOSING/CLOSED → reconnect now
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) netWakeIfNeeded(); });
addEventListener('pageshow', netWakeIfNeeded);

// ---------- Sending ----------
// An event from the local player: sent to the server, which signs it with our id and relays
// it to the others.
function netSend(m) {
  if (net.sock && net.sock.readyState === 1) { try { net.sock.send(JSON.stringify(m)); } catch (e) {} }
}
function netSendEvt(m) { if (netActive()) netSend(m); }
// A vehicle's network description: the same one for a driven vehicle (inside the state) and
// for an abandoned one ('park' event). `cid` is the vehicle's stable id.
function carNetPayload(c) {
  return {
    cid: c.netId || null, x: c.x, y: c.y, an: c.angle, sp: c.speed, w: c.w, h: c.h, col: c.color,
    bike: !!c.isBike, tank: !!c.isTank, taxi: !!c.isTaxi, del: !!c.isDelivery,
    liv: c.livery || null, pol: !!c.wasPolice, hel: c.helmet || null,
    tur: c.isTank ? c.turretA : null, dn: c.dents || undefined,
  };
}
// Compact state of the local player (position, vehicle, statistics).
function netMyState() {
  const c = player.car;
  return {
    t: 's', x: player.x, y: player.y, a: player.aim, w: player.walk, m: player.moving,
    g: !WEAPONS[player.weaponIdx].melee, hp: player.health, dn: downT > 0,
    st: { k: net.kills, d: net.deaths, c: cash, s: net.score, b: net.bounty },
    c: c ? carNetPayload(c) : null,
    pol: netCopPayloads(),                        // patrol cars chasing me (when wanted)
  };
}
// The patrol cars chasing me are simulated by me alone: I broadcast them so EVERYONE sees
// them (previously only the wanted player could). A stable netId identifies them on the
// receiving side; omitted when I have none.
function netCopPayloads() {
  let out = null;
  for (const c of cars) {
    if (c.role !== 'police') continue;
    if (!c.netId) c.netId = net.myId + '#c' + (net.copSeq++);
    (out || (out = [])).push({ cid: c.netId, x: Math.round(c.x), y: Math.round(c.y),
      an: c.angle, sp: c.speed, w: c.w, h: c.h, col: c.color, lp: c.lightPhase || 0, dn: c.dents || undefined });
  }
  return out;   // null when there are none: the receiver removes mine
}
// ---------- Vehicles the local player drives/abandons (shared with everyone) ----------
// On getting in: a stable network id, so rivals recognise it both while you drive it (inside
// your state) and once you leave it (it becomes a parked shape).
function netAssignCarId(c) { if (netActive() && c && !c.netId) c.netId = net.myId + '#' + (net.carSeq++); }
// On getting out/abandoning: broadcast it as a stationary vehicle so it does NOT vanish from
// everyone else's screens (previously, with the state at `c:null`, it disappeared entirely).
function netAbandonCar(c) { if (netActive() && c && c.netId) netSendEvt({ t: 'park', car: carNetPayload(c) }); }
// Vehicle destroyed (exploded): the others remove the corresponding stationary shape.
function netDestroyCar(c) { if (netActive() && c && c.netId) netSendEvt({ t: 'gone', cid: c.netId }); }
// Hooks called by the gameplay when the local player attacks.
function netShotFired(w) {
  netSendEvt({ t: 'shot', x: player.x, y: player.y, a: player.aim, n: w.pellets || 1,
               sp: w.spread, spd: w.spd, life: w.life, dmg: w.dmgCar, pdmg: w.pvp || 8, fk: w.fire ? 1 : 0 });
}
function netPunched() { netSendEvt({ t: 'punch', x: player.x, y: player.y, a: player.aim }); }
function netRocketFired(c) { netSendEvt({ t: 'rocket', x: c.x, y: c.y, a: c.turretA, spd: c.spd, life: c.life, pw: c.pw, gr: c.grenade ? 1 : 0 }); }

// ---------- Receiving: applies a rival's state/events ----------
function netApplyRemote(id, m) {
  const g = net.players.get(id);
  if (!g) return;
  if (m.t === 's') {
    g.tx = m.x; g.ty = m.y; g.aim = m.a; g.walk = m.w || 0; g.moving = !!m.m;
    g.gun = !!m.g; g.hp = m.hp; g.down = !!m.dn;
    if (m.st) g.stats = m.st;
    if (m.c) {
      if (!g.car) g.car = { role: 'traffic', driver: 'net', speed: 0, gear: 1,
                            kvx: 0, kvy: 0, lightPhase: 0, x: m.c.x, y: m.c.y, angle: m.c.an, tx: null };
      const c = g.car;
      if (c.tx == null || dist(c.x, c.y, m.c.x, m.c.y) > 280) { c.x = m.c.x; c.y = m.c.y; c.angle = m.c.an; }  // teleport
      c.tx = m.c.x; c.ty = m.c.y; c.ta = m.c.an; c.speed = m.c.sp;
      c.w = m.c.w; c.h = m.c.h; c.colH = vehicleColH(m.c.bike, m.c.h); c.color = m.c.col;
      c.isBike = m.c.bike; c.isTank = m.c.tank; c.isTaxi = m.c.taxi; c.isDelivery = m.c.del;
      c.livery = m.c.liv || null; c.wasPolice = m.c.pol; c.dents = m.c.dn || 0;
      c.helmet = m.c.hel || '#2a2a2e'; c.riderShirt = g.shirt;
      if (m.c.tur != null) c.turretA = m.c.tur;
      if (m.c.cid != null) { c.netId = m.c.cid; net.looseCars.delete(m.c.cid); }  // they are driving it: drop the parked shape
    } else g.car = null;
    netApplyCops(id, m.pol);                       // patrol cars chasing them (removed once they are no longer wanted)
  }
  else if (m.t === 'park') netParkCar(id, m.car);
  else if (m.t === 'gone') net.looseCars.delete(m.cid);
  else if (m.t === 'shot') netSpawnShot(id, m);
  else if (m.t === 'punch') netPunchAt(id, m);
  else if (m.t === 'rocket') netSpawnRocket(id, m);
}
// A rival abandoned a vehicle: we keep it as a shared stationary shape until they take it
// back (it returns inside their state) or we move too far away. Each client manages its own
// copy — distance culling is local, exactly as for self-simulated traffic.
function netParkCar(owner, p) {
  if (!p || p.cid == null) return;
  let c = net.looseCars.get(p.cid);
  if (!c) { c = { netId: p.cid, role: 'parked', driver: null, speed: 0, gear: 1, lightPhase: 0, kvx: 0, kvy: 0 }; net.looseCars.set(p.cid, c); }
  c.owner = owner;
  c.x = p.x; c.y = p.y; c.angle = p.an; c.speed = p.sp || 0;
  c.w = p.w; c.h = p.h; c.colH = vehicleColH(p.bike, p.h); c.color = p.col;
  c.isBike = p.bike; c.isTank = p.tank; c.isTaxi = p.taxi; c.isDelivery = p.del;
  c.livery = p.liv || null; c.wasPolice = p.pol; c.dents = p.dn || 0;
  c.helmet = p.hel || '#2a2a2e';
  if (p.tur != null) c.turretA = p.tur;
}
// Patrol cars broadcast by a wanted rival: we keep them updated (one copy per netId, with an
// owner) and drop any missing from the latest list — so they disappear by themselves when
// that rival loses their wanted level or shakes them off.
function netApplyCops(owner, list) {
  const seen = list ? new Set(list.map(p => p.cid)) : null;
  if (list) for (const p of list) {
    let c = net.remoteCops.get(p.cid);
    if (!c) {
      c = { netId: p.cid, owner, role: 'police', driver: 'net', wasPolice: true, mass: 1.6,
            colH: 13, gear: 1, kvx: 0, kvy: 0, lightPhase: p.lp || 0,
            x: p.x, y: p.y, angle: p.an, tx: p.x, ty: p.y, ta: p.an };
      net.remoteCops.set(p.cid, c);
    } else if (dist(c.x, c.y, p.x, p.y) > 280) { c.x = p.x; c.y = p.y; c.angle = p.an; }  // teleport
    c.tx = p.x; c.ty = p.y; c.ta = p.an; c.speed = p.sp;
    c.w = p.w; c.h = p.h; c.color = p.col; c.dents = p.dn || 0;
  }
  for (const [cid, c] of net.remoteCops) if (c.owner === owner && (!seen || !seen.has(cid))) net.remoteCops.delete(cid);
}
// All SOLID remote cars my own car can collide with (players, abandoned vehicles, patrol
// cars). Used by the collision resolution in gameplay.js.
function netSolidCars(out) {
  for (const g of net.players.values()) if (g.car && !g.down) out.push(g.car);
  for (const c of net.looseCars.values()) out.push(c);
  for (const c of net.remoteCops.values()) out.push(c);
  // Phase 2: the authoritative world's traffic is solid for my car too, but we do NOT move
  // it (the server owns and pushes it): my car simply bounces off it. That keeps traffic
  // collision O(n) on the player's car alone rather than O(n²) over all pairs, and it does
  // not fight the traffic interpolation.
  if (net.authoritative) {
    const leadFrames = netTrafficLeadFrames(net.stats);
    for (const c of net.wcars.values()) out.push(netTrafficCollider(c, leadFrames));
  }
  return out;
}
// A rival left the match: remove the vehicles they abandoned and their patrol cars too.
function netDropCarsOf(id) {
  for (const [cid, c] of net.looseCars) if (c.owner === id) net.looseCars.delete(cid);
  for (const [cid, c] of net.remoteCops) if (c.owner === id) net.remoteCops.delete(cid);
}
// A rival's "ghost" bullets: hostile like the police's, but signed (fromNet) so that any
// resulting death is credited to the shooter.
function netSpawnShot(id, m) {
  if (!started) return;
  for (let i = 0; i < (m.n || 1); i++) {
    const a = m.a + rnd(-(m.sp || 0), m.sp || 0);
    bullets.push({ x: m.x + Math.cos(a) * 14, y: m.y + Math.sin(a) * 14,
                   vx: Math.cos(a) * (m.spd || 12), vy: Math.sin(a) * (m.spd || 12),
                   life: m.life || 50, fromPlayer: false, fromNet: id, dmg: m.dmg, pdmg: m.pdmg, flame: !!m.fk });
  }
  spawnMuzzle(m.x + Math.cos(m.a) * 14, m.y + Math.sin(m.a) * 14, m.a);
  const h = hear(m.x, m.y, 850); if (h) { if (m.fk) sfx.whoosh(); else sfx.copShoot(h); }
}
// A rival's punch: it only counts if it reaches the local player (authoritative victim).
function netPunchAt(id, m) {
  const g = net.players.get(id);
  if (g) g.punchT = 10;                         // triggers the ghost's arm animation
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
  const spd = m.spd || 6.5, life = m.life || 120;
  rockets.push({ x: m.x + Math.cos(m.a) * 44, y: m.y + Math.sin(m.a) * 44,
                 vx: Math.cos(m.a) * spd, vy: Math.sin(m.a) * spd, life, pw: m.pw, grenade: !!m.gr, src: null, fromNet: id });
  const h = hear(m.x, m.y, 1000); if (h) { if (m.gr) sfx.whoosh(); else sfx.rocket(); }
}

// ---------- Kill credit (authoritative victim) ----------
// Anyone who wounds us over the network leaves their signature: if we die within a few
// seconds the finishing blow is theirs, and we send them the point.
function netRegisterHit(id) { net.lastHitBy = id; net.lastHitT = frame; }
// Called by startDown(): updates deaths and credits any killer.
function netReportDown(kind) {
  if (!netActive()) return;
  if (kind === 'dead' || kind === 'busted') { net.streak = 0; net.bounty = 0; updateBountyHud(0); }   // streak/bounty reset
  if (kind !== 'dead') return;
  net.deaths++;
  if (net.lastHitBy != null && frame - net.lastHitT < 60 * 6) {
    netSend({ t: 'kill', to: net.lastHitBy });    // the server delivers the point to the shooter
    const g = net.players.get(net.lastHitBy);
    if (g) toast(t('pvp.down', { name: g.name }));
  }
  net.lastHitBy = null;
}
// A point came in: we downed the victim `victimId`.
function netScoreKill(victimId) {
  net.kills++;
  net.streak++;
  net.score += KILL_POINTS;
  const nb = bountyForStreak(net.streak);
  if (nb > net.bounty) toast(t('pvp.onYou', { n: nb }));
  net.bounty = nb; updateBountyHud(nb);
  const g = net.players.get(victimId);
  cash += 25; updateCash();                     // bounty on the downed rival
  toast(t('pvp.killedCash', { name: g ? g.name : t('pvp.rival') }));
  sfx.coin();
}

// ---------- Network tick: ghost interpolation, run-over PvP, state upload ----------
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
      // A rival's vehicle can run you over: the victim detects it (and pays for it).
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
      if (dist(g.x, g.y, g.tx, g.ty) > 280) { g.x = g.tx; g.y = g.ty; }   // teleport (respawn)
      if (g.moving) g.walk += 0.3; else g.walk = 0;
    }
  }
  // Remote patrol cars: interpolated towards the target + flashing siren.
  for (const c of net.remoteCops.values()) {
    if (c.tx != null) {
      c.x += (c.tx - c.x) * 0.28; c.y += (c.ty - c.y) * 0.28;
      c.angle += angDiff(c.angle, c.ta != null ? c.ta : c.angle) * 0.35;
    }
    c.lightPhase = (c.lightPhase || 0) + 0.5;
  }
  // Abandoned-vehicle shapes and remote patrol cars are culled as you move away (like traffic).
  const far = Math.max(vw, vh) * 1.3 + 300;
  for (const [cid, c] of net.looseCars) if (dist(c.x, c.y, player.x, player.y) > far) net.looseCars.delete(cid);
  for (const [cid, c] of net.remoteCops) if (dist(c.x, c.y, player.x, player.y) > far) net.remoteCops.delete(cid);
  if (frame % 4 === 0) netSendEvt(netMyState());                 // ~15 times a second
  if (frame % 30 === 0 && ladderEl && !ladderEl.classList.contains('hidden')) renderLadder();
}

// =============================================================================
//  PHASE 2 · CLIENT OF AN AUTHORITATIVE SERVER
//  The world (traffic, pedestrians, police, bullets) is simulated by the server and sent
//  as snapshots ('w') per area of interest. Nothing is simulated here: only our own
//  player is PREDICTED (for responsiveness) and the snapshots are interpolated towards
//  their targets. update() (gameplay.js) diverts here when net.authoritative is true.
// =============================================================================

// ---------- Snapshot interpolation (rendering in the past) ----------
// The standard technique for authoritative games. We do NOT chase the latest position with
// exponential damping (which, at 15 snapshots/s, ALWAYS lags a moving vehicle and stutters —
// the cause of "everything feels slow"). Instead we keep a small BUFFER of the last known
// positions and draw the world with a delay of ~1.5 snapshot intervals, interpolating
// LINEARLY between the two snapshots that bracket the render instant. Motion is then smooth
// and at the CORRECT speed even on a flaky network, WITHOUT extrapolating (which would make
// vehicles and pedestrians "dance" at every correction). To cut the delay, raise the
// snapshot RATE (server side) rather than extrapolate. The local player does NOT come
// through here: they are predicted (updateNetClient) to stay responsive.
// Render delay = measured mean snapshot interval + 2 × jitter (~1.5 intervals on a steady
// stream): renderT ALWAYS falls between two real samples →
// pure interpolation (smooth, no extrapolation or jumps). The rival's "position in the past"
// lag drops by raising the server-side snapshot RATE (SNAP_EVERY): at 30/s (33ms) a 50ms
// delay is enough, half the 100ms needed at 15/s — same smoothness, half the lag.
const INTERP_MS = 50;                     // default render delay until enough intervals are measured (~1.5 snapshot intervals @30Hz)
const INTERP_KEEP = 8;                    // states kept per entity (~230ms of history @30Hz = max delay + one interval)
const INTERP_MIN_MS = 35;
const INTERP_MAX_MS = 150;
const INTERP_MARGIN_MS = 8;
const INTERP_MIN_INTERVALS = 10;
const INTERP_STEP_MS = 0.5;
function netInterpDelayTarget(snapshotWindow) {
  if (!snapshotWindow || snapshotWindow.intervalCount < INTERP_MIN_INTERVALS) return INTERP_MS;
  const target = snapshotWindow.meanInterval + 2 * snapshotWindow.jitter + INTERP_MARGIN_MS;
  return Math.min(INTERP_MAX_MS, Math.max(INTERP_MIN_MS, target));
}
function netInterpDelayStep(current, target) {
  return current + Math.max(-INTERP_STEP_MS, Math.min(INTERP_STEP_MS, target - current));
}
function interpFeed(e, x, y, a) {
  const t = performance.now();
  const buf = e.ib || (e.ib = []);
  const last = buf[buf.length - 1];
  if (last && (Math.abs(x - last.x) > 280 || Math.abs(y - last.y) > 280)) buf.length = 0;   // teleport (respawn): restart, do not crawl
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
    if (renderT >= a0.t) {                  // pair [a0,a1] bracketing renderT (or the last one if renderT is in the future → holds on the latest)
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
const NET_SIM_FRAME_MS = 1000 / 60;
const NET_TRAFFIC_LEAD_MAX_MS = 200;
const NET_TRAFFIC_LEAD_EASE = 0.25;
const NET_TRAFFIC_STILL_SPEED = 0.05;
function netTrafficLeadFrames(stats) {
  const oneWayMs = stats.rtt === null ? 0 : stats.rtt / 2;
  return Math.min(NET_TRAFFIC_LEAD_MAX_MS, stats.interpDelay + oneWayMs) / NET_SIM_FRAME_MS;
}
function netTrafficCollider(car, leadFrames) {
  const velocityX = Math.cos(car.angle) * car.speed + car.kvx;
  const velocityY = Math.sin(car.angle) * car.speed + car.kvy;
  const collider = car.collider || (car.collider = { leadX: 0, leadY: 0 });
  const moving = Math.abs(velocityX) + Math.abs(velocityY) > NET_TRAFFIC_STILL_SPEED;
  collider.leadX += ((moving ? velocityX * leadFrames : 0) - collider.leadX) * NET_TRAFFIC_LEAD_EASE;
  collider.leadY += ((moving ? velocityY * leadFrames : 0) - collider.leadY) * NET_TRAFFIC_LEAD_EASE;
  collider.x = car.x + collider.leadX; collider.y = car.y + collider.leadY;
  collider.angle = car.angle; collider.speed = car.speed; collider.kvx = car.kvx; collider.kvy = car.kvy;
  collider.w = car.w; collider.h = car.h; collider.mass = car.mass;
  return collider;
}

const NET_STATS_SMOOTHING = 0.2;
const NET_STATS_WINDOW_MS = 5000;
const NET_STATS_HOST_HZ_MIN_SPAN_MS = 1000;
const NET_STATS_PENDING_INPUTS = 64;
const NET_STATS_PING_MS = 1000;
const NET_STATS_OVERLAY_REFRESH_MS = 500;
function createNetStats() {
  return {
    rtt: null, rttLast: null,
    inputRtt: null, inputRttLast: null, pendingInputs: [],
    snapshotTimes: [], snapshotWindow: null,
    hostHz: null, tickSamples: [],
    interpDelay: INTERP_MS,
    transport: 'WS',
  };
}
function netStatsSmooth(previous, sample) {
  return previous === null ? sample : previous + (sample - previous) * NET_STATS_SMOOTHING;
}
function netStatsOnPong(stats, clientTime, now) {
  if (!Number.isFinite(clientTime) || clientTime > now) return;
  stats.rttLast = now - clientTime;
  stats.rtt = netStatsSmooth(stats.rtt, stats.rttLast);
}
function netStatsOnInputSent(stats, seq, now) {
  stats.pendingInputs.push({ seq, sentAt: now });
  if (stats.pendingInputs.length > NET_STATS_PENDING_INPUTS) stats.pendingInputs.shift();
}
function netStatsOnAck(stats, ack, now) {
  if (!Number.isFinite(ack)) return;
  const pending = stats.pendingInputs;
  let ackedCount = 0;
  while (ackedCount < pending.length && pending[ackedCount].seq <= ack) ackedCount++;
  if (ackedCount === 0) return;
  stats.inputRttLast = now - pending[ackedCount - 1].sentAt;
  stats.inputRtt = netStatsSmooth(stats.inputRtt, stats.inputRttLast);
  pending.splice(0, ackedCount);
}
const NET_PREDICTED_SHOT_TTL_MS = 1000;
function netLagCompMs(stats) {
  if (stats.inputRtt == null) return 0;
  return clamp(Math.round((stats.inputRtt + stats.interpDelay) / 5) * 5, 0, LAG_COMP_MAX_MS);
}
function netPredictedShotPush(queue, now) {
  queue.push(now);
}
function netPredictedShotConsume(queue, now) {
  while (queue.length && queue[0] < now - NET_PREDICTED_SHOT_TTL_MS) queue.shift();
  if (!queue.length) return false;
  queue.shift();
  return true;
}
function netStatsOnTick(stats, tick, now) {
  if (!Number.isFinite(tick)) return;
  const samples = stats.tickSamples;
  if (samples.length && tick < samples[samples.length - 1].tick) samples.length = 0;
  samples.push({ tick, at: now });
  while (samples[0].at < now - NET_STATS_WINDOW_MS) samples.shift();
  const oldest = samples[0], span = now - oldest.at;
  stats.hostHz = span >= NET_STATS_HOST_HZ_MIN_SPAN_MS ? (tick - oldest.tick) * 1000 / span : null;
}
function netStatsSnapshotWindow(times, now) {
  let first = 0;
  while (first < times.length && times[first] < now - NET_STATS_WINDOW_MS) first++;
  const intervalCount = Math.max(0, times.length - first - 1);
  if (times.length === first) return { rate: 0, meanInterval: null, jitter: null, maxGap: null, intervalCount };
  let intervalSum = 0;
  for (let i = first + 1; i < times.length; i++) intervalSum += times[i] - times[i - 1];
  const meanInterval = intervalCount ? intervalSum / intervalCount : null;
  let deviationSum = 0, maxGap = now - times[times.length - 1];
  for (let i = first + 1; i < times.length; i++) {
    const interval = times[i] - times[i - 1];
    deviationSum += Math.abs(interval - meanInterval);
    if (interval > maxGap) maxGap = interval;
  }
  const span = now - times[first];
  return {
    rate: span > 0 ? intervalCount * 1000 / span : 0,
    meanInterval,
    jitter: intervalCount ? deviationSum / intervalCount : null,
    maxGap,
    intervalCount,
  };
}
function netStatsOnSnapshot(stats, snapshot, now) {
  const times = stats.snapshotTimes;
  times.push(now);
  while (times[0] < now - NET_STATS_WINDOW_MS) times.shift();
  stats.snapshotWindow = netStatsSnapshotWindow(times, now);
  netStatsOnAck(stats, snapshot.ack, now);
  netStatsOnTick(stats, snapshot.tick, now);
}
function netStatsLines(stats, interpDelay, now) {
  const snapshotWindow = netStatsSnapshotWindow(stats.snapshotTimes, now);
  const ms = (value, digits = 0) => value === null ? '-' : value.toFixed(digits) + ' ms';
  const withLast = (smoothed, last) => last === null ? ms(smoothed) : ms(smoothed) + ' (last ' + ms(last) + ')';
  return [
    ['transport', stats.transport],
    ['RTT', withLast(stats.rtt, stats.rttLast)],
    ['input RTT', withLast(stats.inputRtt, stats.inputRttLast)],
    ['snap/s', snapshotWindow.rate.toFixed(1)],
    ['interval', ms(snapshotWindow.meanInterval, 1)],
    ['jitter', ms(snapshotWindow.jitter, 1)],
    ['max gap 5s', ms(snapshotWindow.maxGap)],
    ['host Hz', stats.hostHz === null ? '-' : stats.hostHz.toFixed(1)],
    ['interp delay', ms(interpDelay, 1)],
  ].map(([label, value]) => label.padEnd(13) + value).join('\n');
}
net.stats = createNetStats();

let netStatsOverlayOn = new URLSearchParams(location.search).has('netstats');
let netStatsOverlayEl = null;
function netRenderStatsOverlay() {
  const visible = netStatsOverlayOn && netActive() && net.myId !== null;
  if (!visible) { if (netStatsOverlayEl) netStatsOverlayEl.classList.remove('show'); return; }
  if (!netStatsOverlayEl) {
    netStatsOverlayEl = document.createElement('pre');
    netStatsOverlayEl.id = 'netStats';
    document.body.appendChild(netStatsOverlayEl);
  }
  netStatsOverlayEl.textContent = netStatsLines(net.stats, net.stats.interpDelay, performance.now());
  netStatsOverlayEl.classList.add('show');
}
function netSendPing() {
  if (netActive()) netSend({ t: 'ping', c: performance.now() });
}
addEventListener('keydown', e => {
  if (e.code !== 'F3') return;
  e.preventDefault();
  netStatsOverlayOn = !netStatsOverlayOn;
  netRenderStatsOverlay();
});
setInterval(netSendPing, NET_STATS_PING_MS);
setInterval(netRenderStatsOverlay, NET_STATS_OVERLAY_REFRESH_MS);

// Applies a car's NON-positional fields from the snapshot (appearance/state); the position
// goes into the separate interpolation buffer (interpFeed).
function netApplyCar(c, cp) {
  c.speed = cp.sp;
  c.w = cp.w; c.h = cp.h; c.color = cp.col; c.role = cp.role;
  c.isBike = cp.bike; c.isTank = cp.tank; c.isTaxi = cp.taxi; c.isDelivery = cp.del;
  c.livery = cp.liv || null; c.wasPolice = cp.pol; c.helmet = cp.hel || '#2a2a2e'; c.dents = cp.dn || 0;
  if (cp.tur != null) c.turretA = cp.tur;
  c.sirenOn = cp.siren; c.lightPhase = cp.lp || 0; c.burning = cp.burn; c.smoking = cp.smk;
}
function netMakeWorldCar(cp) {
  const c = { netId: cp.id, driver: 'net', colH: vehicleColH(cp.bike, cp.h), gear: 1,
              kvx: 0, kvy: 0, x: cp.x, y: cp.y, angle: cp.an };
  netApplyCar(c, cp); interpFeed(c, cp.x, cp.y, cp.an);
  return c;
}
// Creates the car DRIVEN by the local player from the snapshot (with the driving physics the
// payload carries: top/accel/mass/gears — needed for prediction).
function netMakePlayerCar(cp) {
  const c = netMakeWorldCar(cp);
  c.driver = 'player'; c.speed = 0; c.gear = 1;
  c.top = cp.top || 4; c.accel = cp.acc || 0.08; c.mass = cp.mass || 1; c.gears = cp.gears || 4;
  return c;
}

const TRAIN_CLOCK_SNAP = 30, TRAIN_CLOCK_DEADBAND = 2;
function netSlewTrainOffset() {
  const gap = net.trainOffsetTarget - net.trainOffset;
  const step = Math.min(Math.abs(gap), Math.max(0, frame - net.trainSlewFrame));
  net.trainOffset += Math.sign(gap) * step;
  net.trainSlewFrame = frame;
}
function netNoteTrainTick(m) {
  if (!Number.isFinite(m.tick)) return;
  const target = m.tick - frame;
  if (net.trainOffset !== null) netSlewTrainOffset();
  const error = net.trainOffset === null ? Infinity : Math.abs(target - net.trainOffset);
  if (error > TRAIN_CLOCK_SNAP) { net.trainOffset = target; net.trainSlewFrame = frame; }
  net.trainOffsetTarget = error > TRAIN_CLOCK_DEADBAND ? target : net.trainOffset;
}
function netTrainClock() {
  if (net.trainOffset === null) return frame;
  netSlewTrainOffset();
  return frame + net.trainOffset;
}
function netApplyWorldEvents(fx, ev) {
  if (fx) for (const e of fx) netApplyFx(e);
  if (Array.isArray(ev)) for (const event of ev) {
    const txt = evText(event); toast(txt);
    if (txt[0] === '💀' || txt[0] === '🎯') sfx.coin();
  }
}
function netResetSnapshotBaseline() {
  net.lastSnapTick = -1;
  net.snapshotRing.clear();
  net.snapshotAckTick = null;
}
function netResolveSnapshot(m) {
  const { state, fx, ev } = snapshotDeltaSplitEvents(m);
  if (m.base === undefined) {
    snapshotDeltaRemember(net.snapshotRing, state);
    if (Number.isFinite(m.tick)) net.snapshotAckTick = m.tick;
    return m;
  }
  const result = snapshotDeltaApply(net.snapshotRing.get(m.base), state);
  if (!result) {
    net.snapshotRing.clear();
    net.snapshotAckTick = null;
    return null;
  }
  snapshotDeltaRemember(net.snapshotRing, result);
  net.snapshotAckTick = result.tick;
  return snapshotDeltaWithEvents(result, fx, ev);
}
// A snapshot arrives: update the interpolation targets for the world and the ghosts.
function netOnSnapshot(m) {
  if (!rtcFreshSnapshot(net.lastSnapTick, m.tick)) { netApplyWorldEvents(m.fx, m.me && m.me.ev); return; }
  if (Number.isFinite(m.tick)) net.lastSnapTick = m.tick;
  const resolved = netResolveSnapshot(m);
  if (!resolved) { netApplyWorldEvents(m.fx, m.me && m.me.ev); return; }
  m = resolved;
  net.snap = m;
  netNoteTrainTick(m);
  netStatsOnSnapshot(net.stats, m, performance.now());
  // --- World cars (traffic/police/parked/abandoned) ---
  const seen = new Set();
  for (const cp of m.cars) {
    seen.add(cp.id);
    let c = net.wcars.get(cp.id);
    if (!c) { c = netMakeWorldCar(cp); net.wcars.set(cp.id, c); }
    else { netApplyCar(c, cp); interpFeed(c, cp.x, cp.y, cp.an); }
  }
  for (const id of net.wcars.keys()) if (!seen.has(id)) net.wcars.delete(id);
  // --- Pedestrians ---
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
  // --- Bullets and rockets (extrapolated locally between snapshots) ---
  net.wbullets = netWorldBulletsFrom(m.bul, net.myId);
  net.wrockets = m.rkt.map(r => ({ x: r.x, y: r.y, vx: Math.cos(r.a) * 6.5, vy: Math.sin(r.a) * 6.5, grenade: !!r.gr }));
  // --- Coins and fires (static: rebuilt on every snapshot) ---
  coins.length = 0; for (const k of m.coins) coins.push({ x: k.x, y: k.y, val: k.v, spin: rnd(0, TAU), bob: rnd(0, TAU) });
  fires.length = 0; for (const f of m.fires) fires.push({ x: f.x, y: f.y, r: 20, hp: 100 });
  netApplyWorldEvents(m.fx, m.me && m.me.ev);
  // --- Remote players' ghosts (AOI positions; the roster still comes from join/leave) ---
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
  // --- Scoreboard from the snapshot (authoritative stats) ---
  if (Array.isArray(m.sc)) for (const s of m.sc) {
    if (s.id === net.myId) { net.kills = s.k; net.deaths = s.d; }   // my own score/bounty: via `me`
    else { const g = net.players.get(s.id); if (g) g.stats = { k: s.k, d: s.d, c: s.c, s: s.s | 0, b: s.b | 0 }; }
  }
}

// Recreates a cosmetic effect received from the server (existing particles + audio).
function netWorldBulletsFrom(bul, myId) {
  const worldBullets = [];
  for (const b of bul) {
    if (b.o != null && b.o === myId) continue;
    const bullet = { x: b.x, y: b.y, vx: Math.cos(b.a) * 12, vy: Math.sin(b.a) * 12, hostile: b.hostile, flame: !!b.fl };
    if (b.o != null) bullet.fromPlayer = true;
    worldBullets.push(bullet);
  }
  return worldBullets;
}
function netPredictFire() {
  if (!net.authoritative || downT > 0 || player.car || peaceMode()) return;
  const w = WEAPONS[player.weaponIdx];
  if (!w || w.melee || w.rocket || w.grenade || player.shootCd > 0) return;
  if (!(w.auto ? mDownL : mClicked)) return;
  player.shootCd = w.cd;
  const aim = Math.atan2(mouseWY() - player.y, mouseWX() - player.x);
  for (let i = 0; i < (w.pellets || 1); i++) {
    const a = aim + rnd(-w.spread, w.spread);
    net.predBullets.push({ x: player.x + Math.cos(a) * 14, y: player.y + Math.sin(a) * 14,
                           vx: Math.cos(a) * w.spd, vy: Math.sin(a) * w.spd, life: w.life, fromPlayer: true, flame: w.fire });
  }
  spawnMuzzle(player.x + Math.cos(aim) * 14, player.y + Math.sin(aim) * 14, aim);
  (sfx[w.sfx] || sfx.shoot)();
  netPredictedShotPush(net.predictedShots, performance.now());
}
function netStepPredictedBullets() {
  const predicted = net.predBullets;
  for (let i = predicted.length - 1; i >= 0; i--) {
    const b = predicted[i];
    b.x += b.vx; b.y += b.vy; b.life--;
    if (b.life <= 0 || solidTile(Math.floor(b.x / T), Math.floor(b.y / T))) predicted.splice(i, 1);
  }
}
function netApplyFx(e) {
  if (e.k === 0) {
    if (e.o != null && e.o === net.myId && netPredictedShotConsume(net.predictedShots, performance.now())) return;
    spawnMuzzle(e.x, e.y, e.a); const h = hear(e.x, e.y, 850); if (h) sfx.copShoot(h);   // gunshot
  }
  else if (e.k === 1) spawnBlood(e.x, e.y);
  else if (e.k === 2) spawnSparks(e.x, e.y, e.n || 3);
  else if (e.k === 3) { spawnExplosion(e.x, e.y); const h = hear(e.x, e.y, 1100); if (h) sfx.boom(); }     // explosion
  else if (e.k === 4) sfx.horn(hear(e.x, e.y, 850), { hornF: e.f, hornKind: e.h });
}

// Samples the world at the render instant (in the past) from the interpolation buffer, and
// extrapolates the bullets. Smooth and at the correct speed at any frame rate.
function netInterpWorld() {
  const stats = net.stats;
  stats.interpDelay = netInterpDelayStep(stats.interpDelay, netInterpDelayTarget(stats.snapshotWindow));
  const renderT = performance.now() - stats.interpDelay;
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

// Rebuilds the global arrays render.js draws from (using the interpolated targets).
function netRebuildArrays() {
  cars.length = 0;
  for (const c of net.wcars.values()) cars.push(c);
  if (player.car) cars.push(player.car);
  peds.length = 0;
  for (const p of net.wpeds.values()) peds.push(p);
  bullets.length = 0; for (const b of net.wbullets) bullets.push(b);
  for (const b of net.predBullets) bullets.push(b);
  rockets.length = 0; for (const r of net.wrockets) rockets.push(r);
}

// Reconciles our own player with the authoritative state (health, cash, weapon, car, and
// position by dead reckoning: only obvious drift is corrected, not latency).
function netReconcileMe() {
  const me = net.snap && net.snap.me;
  if (!me) return;
  if (player.health !== me.hp) { player.health = me.hp; updateHealth(); }
  if (cash !== me.cash) { cash = me.cash; updateCash(); }
  if (me.wp != null && player.weaponIdx !== me.wp) { player.weaponIdx = me.wp; updateWeapon(); }
  if (Array.isArray(me.own)) player.owned = me.own.slice();
  if (me.wanted != null && me.wanted !== wanted) { wanted = me.wanted; updateStars(); }
  if (me.k != null) net.kills = me.k;
  if (me.d != null) net.deaths = me.d;
  if (me.sco != null) net.score = me.sco;
  if (me.stk != null) net.streak = me.stk;
  if (me.bty != null) { net.bounty = me.bty | 0; updateBountyHud(net.bounty); }   // idempotent ⇒ fine every frame
  // Car: create/remove following the authority.
  if (me.car && !player.car) { player.car = netMakePlayerCar(me.car); }
  else if (!me.car && player.car) { player.car = null; engineGain(0); }
  else if (me.car && player.car) { player.car.sirenOn = me.car.siren; player.car.dents = me.car.dn || 0; if (me.car.tur != null) player.car.turretA = me.car.tur; }
  // Out of play (dead/busted): overlay with the server's countdown.
  const bm = $('#bigMsg');
  if (me.down) {
    downT = me.dt || 1;
    if (bm) {
      bm.classList.remove('hidden'); bm.classList.toggle('busted', me.dk === 'busted');
      const bt = $('#bigTitle'); if (bt) bt.textContent = t(me.dk === 'busted' ? 'big.busted' : 'big.dead');
      const c = $('#bigCount'); if (c) c.textContent = Math.max(1, Math.ceil(downT / 60));
    }
  } else {
    if (downT > 0 && bm) bm.classList.add('hidden');
    downT = 0;
  }
  // Position: CLIENT-AUTHORITATIVE. The player owns their own movement and simulates it
  // locally (updateNetClient); the server no longer corrects it — that was the cause of the
  // "server moves you"/rubber-banding. We only realign on a genuine teleport (a respawn or
  // arrest that puts you elsewhere), beyond a large threshold.
  const tx = me.car ? me.car.x : me.x, ty = me.car ? me.car.y : me.y;
  if (dist(player.x, player.y, tx, ty) > 300) {
    player.x = tx; player.y = ty;
    if (player.car) { player.car.x = tx; player.car.y = ty; }
  }
}

// Compact command to the server (axes, aim, one-shot buttons, weapon change).
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
                px: Math.round(player.x), py: Math.round(player.y),   // client-authoritative position
                lg: netLagCompMs(net.stats) };
  const c = player.car;
  if (c) { cmd.cx = Math.round(c.x); cmd.cy = Math.round(c.y);
           cmd.ca = Math.round(c.angle * 256) / 256; cmd.csp = Math.round(c.speed * 100) / 100; }
  if (typeof touchDrive !== 'undefined' && touchDrive.active) cmd.drive = { active: true, angle: touchDrive.angle };
  if (net.weaponReq != null) { cmd.w = net.weaponReq; net.weaponReq = null; }
  if (Number.isFinite(net.snapshotAckTick)) cmd.sa = net.snapshotAckTick;
  // Adaptive area of interest: ask the server ONLY for entities my screen can actually show
  // (+ a margin for interpolation/pop-in), rather than a fixed 1200 tuned for desktop. On a
  // phone that cuts entities/bandwidth/GC considerably → smoother. Sent only when it changes
  // (orientation/resize); it is idempotent server-side.
  const vr = Math.round(Math.max(vw, vh) * 0.5 + 250);
  if (vr !== net.lastVR) { cmd.vr = vr; net.lastVR = vr; }
  netStatsOnInputSent(net.stats, cmd.seq, performance.now());
  if (simHostActive()) simHostSendInput(cmd);
  else if (!rtcGuestSendInput(cmd)) netSend(cmd);
}

// The authoritative client's loop (called by update() in place of the simulation).
function updateNetClient() {
  applyTouchInput();                                   // mobile: pours the sticks into virtual keys/aim/fire (no-op on desktop)
  if (mClicked) net.firePending = true;                // remember the click (the server does the firing)
  netPredictFire();
  updateTrainKinematics(netTrainClock());              // train: kinematics only, on the sim's clock (the server rules on impacts)
  netInterpWorld();                                    // world (traffic/pedestrians) from the snapshots
  netStepPredictedBullets();
  netRebuildArrays();                                  // populates cars[]/peds[] (world + your own vehicle)
  netReconcileMe();                                    // health/cash/weapon/car/death from the server (NOT the position)
  // The player is CLIENT-AUTHORITATIVE: a full local simulation (movement + collisions with
  // traffic) for maximum smoothness. The resulting position goes to the server
  // (netSendInput), which propagates it to the others. While down they stay put (the server
  // decides the respawn).
  if (downT === 0) {
    player.aim = Math.atan2(mouseWY() - player.y, mouseWX() - player.x);
    if (player.car) updateDrive(player.car); else updatePlayerFoot();
    // The traffic belongs to the server (immovable for us): we resolve ONLY our own car
    // against world+rivals (O(n)). No O(n²) resolveCarCollisions across all the traffic —
    // that caused the stutter with many nearby vehicles and fought the interpolation.
    resolveRemoteCarCollisions();
  }
  if (frame % 2 === 0) netSendInput();                 // ~30 commands/s (axes, aim, buttons + position)
  updateParts();                                       // decay of local cosmetic particles
  // Ambient audio derived from the authoritative state (updateDrive already covers the engine).
  if (wanted > 0 && frame % 26 === 0) sfx.siren((frame / 26) % 2 < 1);
  if (playerSirenOn(player.car) && frame % 24 === 0) sfx.emergency(player.car.livery === 'ambulance', (frame / 24) % 2 < 1);
  updateCamera();                                      // our own player draws at the EXACT position (responsive), no interpolation
  frame++;
  if (frame % 30 === 0 && ladderEl && !ladderEl.classList.contains('hidden')) renderLadder();
}

// ---------- Drawing the ghosts (called by render.js) ----------
function netPushEnts(ents) {
  // In authoritative mode, only show ghosts once a snapshot has positioned them.
  for (const g of net.players.values()) if (!g.down && (!net.authoritative || g.seen)) ents.push({ netG: g, y: g.y });
  for (const c of net.looseCars.values()) ents.push(c);   // (Phase 1) vehicles abandoned by rivals
  for (const c of net.remoteCops.values()) ents.push(c);  // (Phase 1) patrol cars chasing wanted rivals
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
// A rival's tag: name in blue + health bar.
function netTag(g, x, y) {
  ctx.font = 'bold 11px Trebuchet MS'; ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillText(g.name, x + 1, y - 17);
  ctx.fillStyle = '#8fd6ff'; ctx.fillText(g.name, x, y - 18);
  // Bounty on the rival's head: a prized target (💰 in gold above the name).
  const b = (g.stats && g.stats.b) | 0;
  if (b > 0) { ctx.fillStyle = '#ffd23a'; ctx.fillText('🎯 $' + b, x, y - 30); }
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(x - 14, y - 15, 28, 3);
  ctx.fillStyle = '#5ee06a'; ctx.fillRect(x - 14, y - 15, 28 * clamp(g.hp, 0, 100) / 100, 3);
}

// ---------- Ladder: the match scoreboard (Tab or the 🏆 button) ----------
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
  rows.sort((a, b) => b.s - a.s || b.k - a.k || a.d - b.d);   // score, then kills, then fewest deaths
  return rows;
}
// Fills both the in-game ladder and the end-of-match screen's.
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
      const name = (r.b > 0 ? '🎯 ' : '') + r.name;          // active bounty: target flagged
      for (const txt of [rank, name, r.s, r.k, r.d, r.b > 0 ? '$' + r.b : '—']) {
        const td = document.createElement('td');
        td.textContent = txt;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    });
  }
}

// ---------- Bounty on your own head (HUD) ----------
function updateBountyHud(b) {
  const el = document.getElementById('bountyBadge');
  if (!el) return;
  if (b > 0) { el.textContent = t('net.bounty', { n: b }); el.classList.remove('hidden'); }
  else el.classList.add('hidden');
}

// ---------- Badge, invite link, sharing ----------
function netRefreshBadge() {
  const el = document.getElementById('mpBadge');
  if (el) {
    el.classList.toggle('hidden', !netActive());
    if (netActive()) {
      const n = net.players.size + 1;
      el.innerHTML = t(n === 1 ? 'net.badge' : 'net.badgeN', { code: ROOM_CODE, n });
    }
  }
  const lc = document.getElementById('lobbyCount');
  if (lc && netActive()) lc.textContent = `${net.players.size + 1} / ${net.maxPlayers}`;
}
function inviteLink() { return location.href.split('#')[0] + '#room=' + ROOM_CODE; }
// Sharing via the system's native sheet (WhatsApp, Messages, etc.); if the device does not
// expose it, fall back to copying to the clipboard.
function shareInvite(btn) {
  const url = inviteLink();
  if (navigator.share) {
    navigator.share({
      title: t('invite.shareTitle'),
      text: t('invite.shareText', { code: ROOM_CODE }),
      url,
    }).catch(() => {});                            // cancelled by the user: not an error
    return;
  }
  copyInvite(btn);                                 // no native sheet: just copy
}
function copyInvite(btn) {
  const link = inviteLink();
  const orig = btn ? btn.textContent : '';
  const ok = () => { if (btn) { btn.textContent = t('invite.copied'); setTimeout(() => { btn.textContent = orig; }, 1500); } };
  const fallback = () => {
    const inp = document.getElementById('inviteLink');
    if (inp) { inp.focus(); inp.select(); try { document.execCommand('copy'); ok(); } catch (e) {} }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(ok, fallback);
  else fallback();
}
