'use strict';
// =============================================================================
// VIBE CITY · server/index.js — multiplayer server (PHASE 1)
//
// Replaces the P2P setup over PeerJS/WebRTC. The "server" used to be the host, i.e. one
// of the phones: as soon as it was backgrounded the browser suspended it, its broker
// registration lapsed and the ENTIRE room vanished (the random disconnections we saw).
// Instead, here:
//
//   • rooms live in RAM in an always-on Node process;
//   • the server RELAYS messages (state/events) between players, in a star topology but
//     without a fragile host;
//   • the server OWNS the match clock (countdown + end), so the match no longer depends
//     on anybody's phone;
//   • reconnecting within the grace window (token) recovers the same player without
//     making them appear to "leave and rejoin" to everyone else.
//
// The SIMULATION (pedestrians, traffic, police, physics) stays on each client for now,
// exactly as before: this phase fixes disconnections and transport reliability. PHASE 2
// moves the simulation here, making the server authoritative over the world and removing
// the divergence.
//
// Protocol (JSON over WebSocket) — compatible with the handlers already in js/net.js:
//   client → server: create | join | s | shot | punch | rocket | park | gone | kill | ping
//   server → client: ok | no | join | leave | end | kill | <relayed state/event> | pong
// =============================================================================

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { performance, monitorEventLoopDelay, PerformanceObserver } = require('node:perf_hooks');
const { WebSocketServer } = require('ws');
// Shared leaderboard across every room, persisted to disk: see server/leaderboard.js.
const leaderboard = require('./leaderboard');
// Phase 2: authoritative world simulation (one city per room). If the module is missing
// (or fails), the server falls back to Phase 1 relaying alone.
let createRoomSim = null, accumulateSimTime = null;
try { ({ createRoomSim, accumulateSimTime } = require('./sim-runtime')); }
catch (e) { console.error('sim-runtime non caricato, resto in modalità relay (Fase 1):', e.message); }
// Warms the JIT: the VERY FIRST city generation is ~2-3× slower (cold). We do a throwaway
// one now, so the first real room already starts fast (~90ms).
if (createRoomSim) { try { createRoomSim('WARMUP'); } catch (e) { console.error('warmup sim fallito:', e.message); createRoomSim = null; } }

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
// Folder of the game's static files (built into dist/). When set, the server ALSO serves
// the site on the same origin, so the client talks wss:// to the same host with no CORS.
// Empty = WebSocket only (site deployed separately).
const STATIC_DIR = process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : '';
const GRACE_MS = Number(process.env.GRACE_MS) || 30_000;          // reconnection window after a network drop
const SIM_MODE = process.env.SIM_MODE === 'server' ? 'server' : 'host';
const HOST_MODE = SIM_MODE === 'host';
const HOST_STALL_MS = 2000;
const HOST_BIND_MS = Number(process.env.HOST_BIND_MS) || 10_000;
const HOST_STALL_CHECK_MS = 500;
const HOST_LINK_PATH = '/hostlink';
const HOST_LINK_MAX_PAYLOAD = 256 * 1024;
const HOST_LINK_HELLO_MS = Number(process.env.HOST_LINK_HELLO_MS) || 5000;
const HOST_LINK_MESSAGES_PER_SECOND = 400;
const HOST_LINK_MESSAGE_BURST = 800;
const MAX_RELAY_BUFFERED_BYTES = 1024 * 1024;
const MAX_HOST_INPUT_BUFFERED_BYTES = 256 * 1024;
const RTC_SIGNAL_KINDS = new Set(['offer', 'answer', 'ice']);
const MAX_RTC_SDP_CHARS = 16384;
const MAX_RTC_ICE_CHARS = 2048;
const RTC_MIN_OFFER_INTERVAL_MS = 1000;
const RTC_MAX_ICE_PER_OFFER = 32;
const FORWARDED_INPUT_NUMBER_FIELDS = ['seq', 'ax', 'ay', 'aim', 'b', 'px', 'py', 'cx', 'cy', 'ca', 'csp', 'w', 'vr', 'lg', 'sa'];
const SNAPSHOT_FRAME_BYTE = 0x57;
const FRAME_SEPARATOR_BYTE = 0x7c;
const SNAPSHOT_CODEC_HEADER = [0xB5, 0x01];
const SNAPSHOT_PAYLOAD_PREFIX = Buffer.from('{"t":"w"');
const HEARTBEAT_MS = 30_000;      // application-level ping to spot dead sockets
// ABSOLUTE room lifetime cap: any instance is torn down 35 min after creation, regardless
// of the match length, reconnections or players still connected. It prevents "ghost" rooms
// that sit in RAM simulating (a 60Hz sim = CPU) for hours when nobody actually closes them.
const MAX_ROOM_MS = 35 * 60_000;
// Cap on simultaneous LIVE rooms. Each room is a city simulated at 60Hz on the same event
// loop (a single Node process): past a certain threshold nothing breaks, but EVERY match
// starts to stutter. Better to make someone wait outside than to ruin the game for those
// already playing. Anyone arriving at the cap goes into the QUEUE (see below) rather than
// getting an error: sessions are time-limited, so a slot frees up by itself and the wait is
// predictable.
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 20;
const MAX_QUEUE = Number(process.env.MAX_QUEUE) || 30;   // beyond that, better to say "try again" than promise an hour's wait
const QUEUE_TICK_MS = 5_000;      // how often position/estimate are refreshed for those queued
// How long a FINISHED room stays up for the summary screen. Its SLOT, however, is already
// free from the final whistle: nobody is playing there any more.
const END_LINGER_MS = 2 * 60_000;
// Match duration used to estimate queue rounds beyond the first (when there are more
// claimants than rooms), if none can be derived from the live rooms.
const TYPICAL_MATCH_MS = 10 * 60_000;
// The sim (movement/physics) runs on a FIXED STEP tuned for 60Hz, like single-player and
// like the client's prediction: simulating at 30Hz ran the WHOLE authoritative world at half
// speed (74 px/s instead of 148) and, with the client predicting at 60Hz, snapped it back on
// every snapshot (rubber-banding). It must stay at 60.
const SIM_HZ = 60;                // = the movement/SP/client-prediction rate (do NOT change without reworking the physics in dt)
const SNAP_EVERY = 2;             // one snapshot every N ticks → ~30/s. Doubled from 15/s to halve
                                 // the lag with which rivals/the world appear "in the past" (with
                                 // the client at INTERP_MS=50). ~2x the bandwidth, but compressed
                                 // by permessage-deflate and bounded by the per-player AOI.
const MAX_PLAYERS_CAP = 8;        // absolute cap on players per room
const SHIRTS = 8;                 // available shirts (see NET_SHIRTS in the client)
const MAX_PAYLOAD = 64 * 1024;    // a state message is a few hundred bytes
// Version of the client served by this server (a build hash generated by build.js into
// version.json). The server sends it in the `ok` handshake; the client compares it with its
// own (window.LC_BUILD) and, if they differ, prompts for a page reload. The LC_BUILD env var
// overrides it. Do NOT read it once at start-up: public/ is a bind mount that a client-only
// deploy updates WITHOUT recreating the container (the server image is unchanged, so the
// process does not restart). A value cached at boot would go stale and trigger "New version"
// on every join. We re-read the file, cached on mtime → no wasted I/O, yet every new deploy
// is picked up without a restart.
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

// ---------- Optional profiling (SIM_PROFILE=1) ------------------------------
// ZERO cost when off. It measures the three numbers that decide whether/when to move to
// worker threads: city-generation time (a one-off spike), the duration of a
// tick()+snapshot round (the sustained cost), and event-loop LAG (how much the rooms block
// each other). `cpu%` = the fraction of one core spent in the sim: close to 100% with lag
// climbing = the ceiling has been reached and it is time for workers. SIM_PROFILE_MS sets
// the report period (default 10s).
const PROFILE = !!process.env.SIM_PROFILE;
const PROFILE_MS = Number(process.env.SIM_PROFILE_MS) || 10_000;
const prof = { tickN: 0, tickSum: 0, tickMax: 0, genN: 0, genSum: 0, genMax: 0, lagN: 0, lagSum: 0, lagMax: 0 };
function profAdd(k, ms) { prof[k + 'N']++; prof[k + 'Sum'] += ms; if (ms > prof[k + 'Max']) prof[k + 'Max'] = ms; }
// Creates a sim, measuring the city-generation time when requested.
function makeSim(code) {
  if (!PROFILE) return createRoomSim(code);
  const t0 = performance.now();
  const sim = createRoomSim(code);
  profAdd('gen', performance.now() - t0);
  return sim;
}

const rooms = new Map();          // CODE (uppercase) → room

// ---------- Room ------------------------------------------------------------
// A room holds the players (including those in "grace", momentarily dropped) and the start
// instant from which the remaining time is derived.
function activeCount(room) {
  let n = 0;
  for (const p of room.players.values()) if (!p.gone) n++;
  return n;
}
// Time left in FRAMES (~60/s): the client counts in frames, so we hand it over ready-made.
function roomLeftFrames(room) {
  if (!room.minutes) return 0;                       // 0 = untimed match
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
// ---------- Contribution to the shared leaderboard --------------------------
// A player's stint is worth two numbers: the time actually PLAYED and the points scored in
// it (see server/leaderboard.js — the ranking is their ratio). The clock runs only while the
// socket is connected: the grace window in which a dropped player keeps their place is not
// time spent playing, and counting it would penalise anyone on a flaky connection.
function playedMs(p) {
  return (p.playedMs || 0) + (p.activeSince ? now() - p.activeSince : 0);
}
// The score is taken from the room's AUTHORITATIVE simulation: the server sim or, in host mode,
// the host's worker, whose reported rows are kept only for the room's players and clamped to
// plausible totals. In the Phase 1 relay fallback (no sim, no host) nothing is recorded: better
// a leaderboard with a hole in it than one built on numbers a client reports about itself.
function currentScores(room) {
  return room.sim ? room.sim.scores() : room.hostState?.scores || room.finalScores;
}
function scoreOf(room, id) {
  const list = currentScores(room);
  return (list && list.find(s => s.id === id)) || null;
}
function recordPlayer(room, p) {
  if (p.recorded) return;
  p.recorded = true;
  const ms = playedMs(p);
  p.playedMs = ms; p.activeSince = 0;              // clock stopped: never counted twice
  const s = scoreOf(room, p.id);
  if (!s) return;
  const e = leaderboard.record({ name: p.name, ms, score: s.s, kills: s.k, deaths: s.d });
  if (e) log('classifica', room.code, p.name, `+${s.s}pt in ${Math.round(ms / 1000)}s`);
}
// Everyone still in the room. Called at the final whistle and at teardown; the scores are
// snapshotted FIRST because stopSim() takes the simulation (and with it scores()) away.
function recordAll(room) {
  room.finalScores = currentScores(room);
  for (const p of room.players.values()) recordPlayer(room, p);
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
function pongFor(ping) {
  return Number.isFinite(ping.c) ? { t: 'pong', c: ping.c } : { t: 'pong' };
}
// When the minutes run out the server notifies EVERYONE: nobody is left behind.
function scheduleEnd(room) {
  clearTimeout(room.endTimer);
  if (!room.minutes) return;
  const ms = Math.max(0, room.minutes * 60_000 - (now() - room.startAt));
  room.endTimer = setTimeout(() => finishRoom(room), ms);
}
// Final whistle. From here on nobody is playing: the clients show the summary. So (a) the
// sim is shut down — 60Hz of CPU for a world nobody is watching — and (b) the room's SLOT
// becomes available again, so whoever is queued gets in straight away instead of waiting for
// the last player to close their tab. The room stays up a little longer purely for the
// summary, then disappears.
function finishRoom(room) {
  if (room.ended) return;
  room.ended = true;
  broadcast(room, { t: 'end' });
  recordAll(room);                           // before stopSim: the scores live in the sim
  stopSim(room);
  stopHostWatch(room);
  clearTimeout(room.reaperTimer);
  room.reaperTimer = setTimeout(() => destroyRoom(room), END_LINGER_MS);
  log('room ended', room.code, `(posto liberato, ${liveRooms()}/${MAX_ROOMS} vive)`);
  pumpQueue();
}
// Rooms that occupy a slot: those still in play. Finished ones do not count.
function liveRooms() {
  let n = 0;
  for (const r of rooms.values()) if (!r.ended) n++;
  return n;
}
// The instant (ms epoch) at which this room will free its slot: the final whistle, or the
// absolute lifetime cap for an untimed match. It is an UPPER-BOUND estimate: if the players
// leave sooner, the slot frees up sooner.
function roomFreeAt(room) {
  if (room.ended) return 0;
  const byMatch = room.minutes ? room.startAt + room.minutes * 60_000 : Infinity;
  return Math.min(byMatch, room.startAt + MAX_ROOM_MS);
}
// Forced teardown when the lifetime cap expires: notify whoever is still connected (so the
// UI closes the match) and then release everything.
function scheduleReaper(room) {
  clearTimeout(room.reaperTimer);
  room.reaperTimer = setTimeout(() => {
    log('room reaped', room.code, `(vita > ${Math.round(MAX_ROOM_MS / 60_000)}min)`);
    broadcast(room, { t: 'end' });
    destroyRoom(room);
    pumpQueue();                             // the slot is free: the first in the queue is up
  }, MAX_ROOM_MS);
}
function destroyRoom(room) {
  clearTimeout(room.endTimer);
  clearTimeout(room.reaperTimer);
  recordAll(room);                           // teardown (reaper, room emptied): idempotent
  stopSim(room);
  stopHostWatch(room);
  for (const p of room.players.values()) clearTimeout(p.dropTimer);
  rooms.delete(room.code);
  log('room destroyed', room.code);
}

// ---------- Waiting queue for a new room ------------------------------------
// At the cap, anyone wanting to CREATE a match is not turned away: they join the queue and
// the server starts them automatically as soon as a slot frees up (their socket stays open;
// they need do nothing). JOINING an existing room never comes through here: if a friend
// invited you, you always get in, cap or no cap.
//
// Each claimant holds a `qtoken`: if the phone is backgrounded and the socket drops, on
// returning they present the token and RECLAIM THEIR PLACE instead of starting again at the
// back (the same idea as the players' grace period).
const queue = [];                 // claimants in order of arrival
let queueTimer = null;

function queueIndexOfWs(ws) { return queue.findIndex(e => e.ws === ws); }
// Estimated wait for whoever is at position `pos` (0-based). Slots free up one at a time,
// from the first final whistle onwards: the person at the front waits for the room that
// finishes first, the second for the second, and so on. If there are more claimants than
// rooms, later rounds are estimated using a typical match duration.
function queueEtaMs(pos) {
  const frees = [];
  let minutesSum = 0;
  for (const r of rooms.values()) {
    if (r.ended) continue;
    frees.push(roomFreeAt(r));
    minutesSum += r.minutes || 0;
  }
  if (!frees.length) return 0;                       // a slot is already free: they start on the next pump
  frees.sort((a, b) => a - b);
  const matchMs = minutesSum ? (minutesSum / frees.length) * 60_000 : TYPICAL_MATCH_MS;
  const rounds = Math.floor(pos / frees.length);     // 0 while the claimants fit into the live rooms
  const at = frees[pos % frees.length] + rounds * matchMs;
  return Math.max(0, at - now());
}
function sendQueued(e, pos) {
  sendRaw(e.ws, {
    t: 'queued', pos: pos + 1, eta: queueEtaMs(pos), qtoken: e.qtoken,
    rooms: liveRooms(), max: MAX_ROOMS, waiting: queue.length, build: serverBuild(),
  });
}
function broadcastQueue() {
  queue.forEach((e, i) => { if (!e.gone) sendQueued(e, i); });
  if (queue.length && !queueTimer) queueTimer = setInterval(broadcastQueue, QUEUE_TICK_MS);
  else if (!queue.length && queueTimer) { clearInterval(queueTimer); queueTimer = null; }
}
function enqueue(ws, m) {
  if (queue.length >= MAX_QUEUE) { sendRaw(ws, { t: 'no', r: 'qfull' }); return; }
  const e = { ws, msg: m, qtoken: crypto.randomUUID(), gone: false, dropTimer: null, at: now() };
  queue.push(e);
  ws._q = true;
  log('queued', String(m.code || '?'), `pos ${queue.length}`, `(${liveRooms()}/${MAX_ROOMS} stanze vive)`);
  broadcastQueue();
}
function removeFromQueue(ws) {
  const i = queueIndexOfWs(ws);
  if (i < 0) return;
  clearTimeout(queue[i].dropTimer);
  queue.splice(i, 1);
  ws._q = false;
  broadcastQueue();
}
// A claimant's socket dropped: as for players, we hold their place for the grace window and
// only then really remove them.
function onQueueDisconnect(ws) {
  const i = queueIndexOfWs(ws);
  if (i < 0) return;
  const e = queue[i];
  e.gone = true;
  e.dropTimer = setTimeout(() => {
    const j = queue.indexOf(e);
    if (j >= 0) { queue.splice(j, 1); log('queue drop', e.msg && e.msg.code); broadcastQueue(); }
  }, GRACE_MS);
}
// A slot freed up: starts whoever is at the front of the queue and still connected. The
// `pumping` guard prevents recursion (createRoom can destroy a room).
let pumping = false;
function pumpQueue() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length && liveRooms() < MAX_ROOMS) {
      // The first one still reachable: someone momentarily dropped keeps their place but
      // cannot be given a room right now, so they are skipped for this round.
      const i = queue.findIndex(e => !e.gone && e.ws && e.ws.readyState === 1);
      if (i < 0) break;
      const [e] = queue.splice(i, 1);
      clearTimeout(e.dropTimer);
      e.ws._q = false;
      log('queue → stanza', e.msg && e.msg.code, `(attesa ${Math.round((now() - e.at) / 1000)}s)`);
      createRoom(e.ws, e.msg);        // on failure the socket gets its own 'no'
    }
  } finally { pumping = false; }
  broadcastQueue();
}

// ---------- Authoritative world simulation (Phase 2) ------------------------
// Each room simulates ONE city (traffic, pedestrians, police, physics) and broadcasts
// snapshots of it per area of interest. Clients send only INPUT ('i') and draw.
function startSim(room) {
  if (!createRoomSim) return;                 // module missing: stays a Phase 1 relay
  try { room.sim = makeSim(room.code); }
  catch (e) { console.error('sim non avviata per', room.code, '—', e.message); room.sim = null; return; }
  room.sim.setPolice(room.police);
  room.simTick = 0;
  // Fixed-step accumulator (like the client): the world advances at EXACTLY SIM_HZ steps per
  // wall-clock second even when Node's timer is imprecise or late. Without it,
  // setInterval(17ms) yields ~55Hz → the world runs at 92% and the client (60Hz) outpaces the
  // server → residual rubber-banding. With the accumulator the two rates match.
  const STEP = 1000 / SIM_HZ;
  room.simAcc = 0;
  room.simLast = performance.now();
  room.simTimer = setInterval(() => {
    const t0 = PROFILE ? performance.now() : 0;
    const t = performance.now();
    room.simAcc = accumulateSimTime(room.simAcc, t - room.simLast);
    room.simLast = t;
    let doSnap = false;
    try {
      while (room.simAcc >= STEP) {
        room.sim.tick();
        room.simAcc -= STEP;
        if (++room.simTick % SNAP_EVERY === 0) doSnap = true;   // one snapshot per round even when catching up several ticks
      }
      if (doSnap) {
        for (const p of room.players.values()) {
          if (p.gone || !p.ws || p.ws.readyState !== 1) continue;
          const snap = room.sim.snapshotFor(p.id);
          if (snap) { snap.sc = room.sim.scores(); try { p.ws.send(JSON.stringify(snap)); } catch {} }
        }
        room.sim.clearFx();                     // this round's fx have been sent: clear them
      }
    } catch (e) { console.error('tick error', room.code, e.message); }
    if (PROFILE) profAdd('tick', performance.now() - t0);   // includes serialisation+send: the real cost on the main loop
  }, Math.round(1000 / SIM_HZ));
}
function stopSim(room) {
  clearInterval(room.simTimer); room.simTimer = null; room.sim = null;
}

function hostModeActive(room) {
  return HOST_MODE && !room.sim && !room.ended;
}
function handshakeSimFields(room) {
  return HOST_MODE ? { sim: true, host: room.hostId } : { sim: !!room.sim };
}
function normalizedBuild(build) {
  return typeof build === 'string' && build ? build : null;
}
function deviceOf(hello) {
  return hello.dev === 'desktop' ? 'desktop' : 'touch';
}
function playerNumber(p) {
  return Number(p.id.slice(1));
}
function isBetterHost(candidate, current) {
  const candidateIsDesktop = candidate.dev === 'desktop';
  if (candidateIsDesktop !== (current.dev === 'desktop')) return candidateIsDesktop;
  return playerNumber(candidate) < playerNumber(current);
}
function pickHost(room, excludeId) {
  let build;
  let best = null;
  for (const p of room.players.values()) {
    if (p.gone || p.id === excludeId || room.resigned.has(p.id)) continue;
    if (build === undefined) build = normalizedBuild(serverBuild());
    if (p.build !== build) continue;
    if (!best || isBetterHost(p, best)) best = p;
  }
  return best;
}
function closeHostLink(room) {
  const link = room.hostLink;
  room.hostLink = null;
  if (link) { try { link.close(); } catch {} }
}
function fallbackToServerSim(room) {
  if (!createRoomSim || room.sim || room.ended) return;
  startSim(room);
  if (!room.sim) return;
  const savedRowById = new Map((room.hostState?.players || [])
    .filter(row => row && typeof row.id === 'string').map(row => [row.id, row]));
  for (const p of room.players.values()) {
    const savedRow = savedRowById.get(p.id);
    if (savedRow) room.sim.restorePlayer(p.id, p.name, p.shirtIdx, savedRow);
    else room.sim.addPlayer(p.name, p.shirtIdx, p.id);
  }
  room.hostState = null;
  broadcast(room, { t: 'host', id: null });
  log('server sim fallback', room.code);
}
function electHost(room, excludeId) {
  const next = pickHost(room, excludeId);
  closeHostLink(room);
  room.hostId = next ? next.id : null;
  room.hostLinkBound = false;
  awaitFirstHostFrame(room);
  if (!next) { fallbackToServerSim(room); return; }
  broadcast(room, { t: 'host', id: next.id, name: next.name });
  log('host', room.code, next.id, next.name);
}
function migrateHostIfPossible(room) {
  if (hostModeActive(room) && pickHost(room, room.hostId)) electHost(room, room.hostId);
}
function ensureHost(room) {
  if (!hostModeActive(room)) return;
  const current = room.players.get(room.hostId);
  if (current && !current.gone) return;
  if (room.hostId === null || pickHost(room, null)) electHost(room, null);
}
function awaitFirstHostFrame(room) {
  room.hostBindStartedAt = now();
  room.hostLastFrameAt = 0;
}
function hostStalled(room) {
  if (!room.hostId) return false;
  if (room.hostLastFrameAt) return now() - room.hostLastFrameAt >= HOST_STALL_MS;
  return now() - room.hostBindStartedAt >= HOST_BIND_MS;
}
function startHostWatch(room) {
  room.hostWatchTimer = setInterval(() => {
    if (room.players.size > 1 && hostStalled(room)) migrateHostIfPossible(room);
  }, HOST_STALL_CHECK_MS);
}
function stopHostWatch(room) {
  clearInterval(room.hostWatchTimer); room.hostWatchTimer = null;
  closeHostLink(room);
}
function handleHostLink(ws, m) {
  const room = rooms.get(String(m.code || '').toUpperCase());
  const p = room && typeof m.token === 'string' && [...room.players.values()].find(pp => pp.token === m.token);
  if (!p || !hostModeActive(room) || room.hostId !== p.id) { ws.terminate(); return; }
  const rebinding = room.hostLinkBound;
  const previousLink = room.hostLink;
  room.hostLink = ws;
  room.hostLinkBound = true;
  ws._hostRoom = room;
  if (previousLink) awaitFirstHostFrame(room);
  if (previousLink && previousLink !== ws) { try { previousLink.close(); } catch {} }
  sendRaw(ws, {
    t: 'hoststart',
    roster: [...room.players.values()].map(pp => ({ id: pp.id, name: pp.name, shirtIdx: pp.shirtIdx })),
    state: room.hostState?.players || [],
    police: room.police,
  });
  if (rebinding) broadcast(room, { t: 'host', id: p.id, name: p.name });
  log('hostlink', room.code, p.id);
}
function startsWithSnapshotPayload(data, payloadStart) {
  const payloadEnd = payloadStart + SNAPSHOT_PAYLOAD_PREFIX.length;
  return data.length >= payloadEnd
    && data.compare(SNAPSHOT_PAYLOAD_PREFIX, 0, SNAPSHOT_PAYLOAD_PREFIX.length, payloadStart, payloadEnd) === 0;
}
function sendSnapshotToGuest(room, guestId, payload, binary) {
  const target = room.players.get(guestId);
  if (!target || target.gone || !target.ws || target.ws.readyState !== 1) return;
  if (target.ws.bufferedAmount > MAX_RELAY_BUFFERED_BYTES) return;
  try { target.ws.send(payload, { binary }); } catch {}
}
function relaySnapshot(room, data) {
  const separatorAt = data.indexOf(FRAME_SEPARATOR_BYTE, 2);
  if (separatorAt < 0 || !startsWithSnapshotPayload(data, separatorAt + 1)) return;
  sendSnapshotToGuest(room, data.toString('utf8', 2, separatorAt), data.subarray(separatorAt + 1), false);
}
function relayBinarySnapshot(room, data) {
  const idLength = data[1];
  const payloadStart = 2 + idLength;
  if (!idLength || data.length <= payloadStart + SNAPSHOT_CODEC_HEADER.length) return;
  if (data[payloadStart] !== SNAPSHOT_CODEC_HEADER[0] || data[payloadStart + 1] !== SNAPSHOT_CODEC_HEADER[1]) return;
  sendSnapshotToGuest(room, data.toString('utf8', 2, payloadStart), data.subarray(payloadStart), true);
}
function onHostLinkHello(ws, data) {
  let m = null;
  if (data.length <= MAX_PAYLOAD) { try { m = JSON.parse(data); } catch {} }
  if (m && m.t === 'hostlink') handleHostLink(ws, m);
  else ws.terminate();
}
function withinHostLinkRate(ws) {
  const at = now();
  ws._rateTokens = Math.min(HOST_LINK_MESSAGE_BURST,
    ws._rateTokens + ((at - ws._rateCheckedAt) * HOST_LINK_MESSAGES_PER_SECOND) / 1000);
  ws._rateCheckedAt = at;
  if (ws._rateTokens < 1) return false;
  ws._rateTokens--;
  return true;
}
function plausibleHostRow(row, elapsedMs) {
  const totals = leaderboard.plausibleTotals({ score: row.s, kills: row.k, deaths: row.d }, elapsedMs);
  return { ...row, s: totals.score, k: totals.kills, d: totals.deaths };
}
function roomHostRows(room, rows) {
  if (!Array.isArray(rows)) return [];
  const elapsedMs = now() - room.startAt;
  return rows.filter(row => row && typeof row.id === 'string' && room.players.has(row.id))
    .map(row => plausibleHostRow(row, elapsedMs));
}
function onHostLinkMessage(ws, data, isBinary) {
  const room = ws._hostRoom;
  if (room.hostLink !== ws) return;
  if (isBinary) {
    room.hostLastFrameAt = now();
    relayBinarySnapshot(room, data);
    return;
  }
  const isSnapshot = data[0] === SNAPSHOT_FRAME_BYTE && data[1] === FRAME_SEPARATOR_BYTE;
  if (!isSnapshot && data.length > MAX_PAYLOAD) return;
  room.hostLastFrameAt = now();
  if (isSnapshot) { relaySnapshot(room, data); return; }
  let m;
  try { m = JSON.parse(data); } catch { return; }
  if (!m || m.t !== 'hst') return;
  room.hostState = {
    players: roomHostRows(room, m.players),
    scores: roomHostRows(room, m.scores).map(({ id, k, d, s }) => ({ id, k, d, s })),
  };
}
function forwardedInput(m, id) {
  const input = { t: 'i' };
  for (const field of FORWARDED_INPUT_NUMBER_FIELDS) if (Number.isFinite(m[field])) input[field] = m[field];
  if (m.drive && typeof m.drive === 'object') {
    input.drive = { active: !!m.drive.active, angle: Number.isFinite(m.drive.angle) ? m.drive.angle : 0 };
  }
  input.id = id;
  return input;
}
function forwardInputToHost(room, m, id) {
  const link = room.hostLink;
  if (!link || link.bufferedAmount > MAX_HOST_INPUT_BUFFERED_BYTES) return;
  sendRaw(link, forwardedInput(m, id));
}
function rtcSignalWithinBudget(sender, targetId, kind) {
  if (!sender.rtcSignalBudget) sender.rtcSignalBudget = new Map();
  let budget = sender.rtcSignalBudget.get(targetId);
  if (!budget) { budget = { offerAt: -Infinity, iceCount: 0 }; sender.rtcSignalBudget.set(targetId, budget); }
  if (kind === 'offer') {
    const at = now();
    if (at - budget.offerAt < RTC_MIN_OFFER_INTERVAL_MS) return false;
    budget.offerAt = at;
    budget.iceCount = 0;
  } else if (kind === 'answer') budget.iceCount = 0;
  else if (budget.iceCount >= RTC_MAX_ICE_PER_OFFER) return false;
  else budget.iceCount++;
  return true;
}
function relayRtcSignal(room, sender, m) {
  if (!hostModeActive(room) || !room.hostId || !RTC_SIGNAL_KINDS.has(m.k)) return;
  if ((sender.id === room.hostId) === (m.to === room.hostId)) return;
  const target = room.players.get(m.to);
  if (!target || target.gone || !target.ws || target.ws.readyState !== 1) return;
  const payload = m.d;
  const payloadFits = m.k === 'ice'
    ? payload !== null && typeof payload === 'object' && !Array.isArray(payload) && JSON.stringify(payload).length <= MAX_RTC_ICE_CHARS
    : typeof payload === 'string' && payload.length <= MAX_RTC_SDP_CHARS;
  if (!payloadFits || !rtcSignalWithinBudget(sender, m.to, m.k)) return;
  sendRaw(target.ws, { t: 'rtc', from: sender.id, k: m.k, d: payload });
}
function onHostLinkClose(ws) {
  const room = ws._hostRoom;
  if (!room || room.hostLink !== ws) return;
  room.hostLink = null;
  awaitFirstHostFrame(room);
  migrateHostIfPossible(room);
}

// ---------- Entering a match ------------------------------------------------
const normalizedPlayerName = hello => String(hello.name || 'Ospite').slice(0, 14);
function addPlayer(ws, room, hello) {
  const n = ++room.idSeq;                    // 1 for the creator, then 2, 3, …
  const id = 'p' + n;
  const p = {
    id, name: normalizedPlayerName(hello), shirtIdx: (n - 1) % SHIRTS,  // creator → shirt 0
    token: crypto.randomUUID(), ws: null, gone: false, dropTimer: null,
    playedMs: 0, activeSince: 0, recorded: false,   // shared-leaderboard accounting
    dev: deviceOf(hello), build: normalizedBuild(hello.build),
  };
  room.players.set(id, p);
  if (room.sim) room.sim.addPlayer(p.name, p.shirtIdx, p.id);   // Phase 2: join the authoritative city
  ensureHost(room);
  bindWs(ws, room, p);
  sendRaw(ws, {
    t: 'ok', id: p.id, shirtIdx: p.shirtIdx, minutes: room.minutes, police: room.police,
    left: roomLeftFrames(room), players: roster(room, p.id), token: p.token, ...handshakeSimFields(room),
    build: serverBuild(),
  });
  broadcast(room, { t: 'join', id: p.id, name: p.name, shirtIdx: p.shirtIdx }, p.id);
  sendRaw(room.hostLink, { t: 'join', id: p.id, name: p.name, shirtIdx: p.shirtIdx });
  log('join', room.code, p.id, p.name, `(${activeCount(room)}/${room.max})`);
}
// Attaches a (new) socket to a player: used both on first entry and on reconnect.
// ws._room/ws._pid identify the sender in subsequent messages.
function bindWs(ws, room, p) {
  p.ws = ws;
  ws._room = room;
  ws._pid = p.id;
  // (Re)starts the played-time clock. Zero only on first entry and after a drop: a token
  // rejoin on a still-live socket must not restart it (it would lose the time already run).
  if (!p.activeSince) p.activeSince = now();
}

// Creates the room (whoever creates it is the first player, shirt 0). First, though, it goes
// through the checks and, if the server is at its cap, through the queue.
function handleCreate(ws, m) {
  if (ws._q) return;                         // already queued: a second 'create' is ignored
  const code = String(m.code || '').toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) { sendRaw(ws, { t: 'no', r: 'badcode' }); return; }
  // Reconnection of someone who was queued and lost their socket: they reclaim THEIR place.
  if (m.qtoken) {
    const e = queue.find(x => x.qtoken === m.qtoken);
    if (e) {
      clearTimeout(e.dropTimer); e.dropTimer = null;
      e.gone = false; e.ws = ws; ws._q = true;
      log('queue resume', code, `pos ${queue.indexOf(e) + 1}`);
      sendQueued(e, queue.indexOf(e));
      pumpQueue();                           // a slot may have freed up in the meantime
      return;
    }
  }
  const existing = rooms.get(code);
  if (existing && !existing.ended && activeCount(existing) > 0) { sendRaw(ws, { t: 'no', r: 'exists' }); return; }
  if (liveRooms() >= MAX_ROOMS) { enqueue(ws, { ...m, code }); return; }
  createRoom(ws, m);
}
const ROOM_TITLE_MAX_LENGTH = 24;
const PUBLIC_ROOM_MIN_LEFT_MS = 60_000;
function sanitizeRoomTitle(rawTitle, fallbackName) {
  const title = String(rawTitle || '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, ROOM_TITLE_MAX_LENGTH).trim();
  return title || fallbackName;
}
function publicRoomList() {
  const nowMs = now();
  const listed = [];
  for (const room of rooms.values()) {
    if (!room.public || room.ended) continue;
    const players = activeCount(room);
    const leftMs = roomFreeAt(room) - nowMs;
    if (players === 0 || leftMs < PUBLIC_ROOM_MIN_LEFT_MS) continue;
    listed.push({
      code: room.code, title: room.title, players, max: room.max,
      leftSec: room.minutes ? Math.round(leftMs / 1000) : null,
    });
  }
  const leftRank = room => room.leftSec === null ? Infinity : room.leftSec;
  return listed.sort((a, b) =>
    (a.players >= a.max) - (b.players >= b.max) || b.players - a.players || leftRank(b) - leftRank(a));
}
// The actual creation: called immediately, or from the queue when your turn comes.
function createRoom(ws, m) {
  const code = String(m.code || '').toUpperCase();
  const existing = rooms.get(code);
  if (existing && !existing.ended && activeCount(existing) > 0) { sendRaw(ws, { t: 'no', r: 'exists' }); return; }
  if (existing) destroyRoom(existing);
  const isPublic = m.public === true;
  const room = {
    code, pass: isPublic ? '' : String(m.pass || ''), title: sanitizeRoomTitle(m.title, normalizedPlayerName(m)), public: isPublic, max: clamp(+m.max || 4, 2, MAX_PLAYERS_CAP),
    minutes: Math.max(0, +m.minutes || 0), police: typeof m.police === 'boolean' ? m.police : true, startAt: now(),
    idSeq: 0, players: new Map(), endTimer: null, ended: false,
    hostId: null, hostLink: null, hostLinkBound: false, hostBindStartedAt: 0, hostLastFrameAt: 0, hostState: null, resigned: new Set(), hostWatchTimer: null,
  };
  rooms.set(code, room);
  scheduleEnd(room);
  scheduleReaper(room);                      // absolute lifetime cap: 35 min, then gone
  if (HOST_MODE) startHostWatch(room);
  else startSim(room);                       // Phase 2: start the room's authoritative city
  log('room created', code, 'by', String(m.name || '?'),
      `(${room.minutes}min, max ${room.max}, sim ${room.sim ? 'on' : 'off'}, ${liveRooms()}/${MAX_ROOMS} vive)`);
  addPlayer(ws, room, m);
}
// Joins an existing room (or reconnects with the token).
function handleJoin(ws, m) {
  const code = String(m.code || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) { sendRaw(ws, { t: 'no', r: 'notfound' }); return; }

  // Reconnect: the same token within the grace window → same id/shirt, no flicker.
  if (m.token) {
    const p = [...room.players.values()].find(pp => pp.token === m.token);
    if (p && room.ended) { sendRaw(ws, { t: 'end' }); return; }
    if (p) {
      clearTimeout(p.dropTimer); p.dropTimer = null;
      const wasGone = p.gone; p.gone = false;
      p.dev = deviceOf(m); p.build = normalizedBuild(m.build);
      ensureHost(room);
      bindWs(ws, room, p);
      sendRaw(ws, {
        t: 'ok', id: p.id, shirtIdx: p.shirtIdx, minutes: room.minutes, police: room.police,
        left: roomLeftFrames(room), players: roster(room, p.id), token: p.token, resumed: true, ...handshakeSimFields(room),
        build: serverBuild(),
      });
      // If their departure had already been announced, the others re-add them.
      if (wasGone) broadcast(room, { t: 'join', id: p.id, name: p.name, shirtIdx: p.shirtIdx }, p.id);
      log('resume', room.code, p.id, p.name);
      return;
    }
  }

  // Match already finished (the room only stays up for the summary of those who were
  // there): to anyone arriving now it is as if it were gone, since the world is no longer
  // being simulated.
  if (room.ended) { sendRaw(ws, { t: 'no', r: 'notfound' }); return; }
  if (!room.public && (room.pass || '') !== String(m.pass || '')) { sendRaw(ws, { t: 'no', r: 'pass' }); return; }
  if (activeCount(room) >= room.max) { sendRaw(ws, { t: 'no', r: 'full' }); return; }
  addPlayer(ws, room, m);
}

// ---------- Game messages (relay) -------------------------------------------
function onGameMessage(ws, m) {
  const room = ws._room;
  const p = room && room.players.get(ws._pid);
  if (!room || !p) return;
  switch (m.t) {
    // Phase 2: the player's input → the authoritative city (no relay: the server owns the
    // world and answers with 'w' snapshots).
    case 'i':
      if (room.sim) room.sim.applyInput(p.id, m);
      else if (HOST_MODE && p.id !== room.hostId) forwardInputToHost(room, m, p.id);
      break;
    case 'resign':
      if (!hostModeActive(room) || room.hostId !== p.id) break;
      room.resigned.add(p.id);
      electHost(room, p.id);
      break;
    case 'rtc':
      relayRtcSignal(room, p, m);
      break;
    // Phase 1 (compat): state and events relayed to the others, signed with the sender's id.
    case 's': case 'shot': case 'punch': case 'rocket': case 'park': case 'gone':
      broadcast(room, { ...m, id: p.id }, p.id);
      break;
    // Kill credit: the VICTIM (p) reports who downed them (m.to); we tell that player.
    case 'kill': {
      const target = room.players.get(m.to);
      if (target && !target.gone) sendRaw(target.ws, { t: 'kill', id: p.id });
      break;
    }
    case 'ping':
      sendRaw(ws, pongFor(m));
      break;
  }
}

// ---------- Connection drop -------------------------------------------------
// We do not announce the departure straight away: we allow GRACE_MS to reconnect (phone back
// in the foreground, wifi returning). If it expires, the departure is real.
function onDisconnect(ws) {
  const room = ws._room;
  const p = room && room.players.get(ws._pid);
  if (!p || p.ws !== ws) return;        // socket already replaced by a reconnect: ignore
  if (p.gone) return;
  p.gone = true;
  // The played-time clock stops here: the grace window is not play (see playedMs).
  p.playedMs = playedMs(p); p.activeSince = 0;
  if (room.hostId === p.id) migrateHostIfPossible(room);
  p.dropTimer = setTimeout(() => {
    recordPlayer(room, p);                       // a real departure: their stint goes on record
    room.players.delete(p.id);
    if (room.sim) room.sim.removePlayer(p.id);   // a real departure: remove them from the authoritative city too
    broadcast(room, { t: 'leave', id: p.id });
    sendRaw(room.hostLink, { t: 'leave', id: p.id });
    log('leave', room.code, p.id, p.name);
    // Room emptied ahead of time: it disappears and the slot goes to whoever is queued.
    if (room.players.size === 0) { const live = !room.ended; destroyRoom(room); if (live) pumpQueue(); }
    else if (room.hostId === p.id && hostModeActive(room)) electHost(room, p.id);
  }, GRACE_MS);
}

// ---------- The game's static files -----------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.map': 'application/json',
};
// Cache headers consistent with build.js: hashed assets immutable, HTML/SW/version always
// fresh, icons cached briefly.
function cacheControl(rel) {
  if (/\.[0-9a-f]{10}\.js$/.test(rel)) return 'public, max-age=31536000, immutable';
  if (rel === 'version.json') return 'no-store';
  if (rel === 'index.html' || rel === '' || rel === 'sw.js' || rel === 'manifest.webmanifest')
    return 'no-cache, must-revalidate';
  if (rel.startsWith('icons/')) return 'public, max-age=86400';
  return 'public, max-age=3600';
}
function serveStatic(req, res) {
  // GET/HEAD only; no query/hash; blocks path traversal.
  let rel = decodeURIComponent((req.url.split('?')[0] || '/')).replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  const full = path.join(STATIC_DIR, rel);
  if (!full.startsWith(STATIC_DIR + path.sep) && full !== STATIC_DIR) { res.writeHead(403); res.end(); return; }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      // Navigation to a route with no file → the app shell (index.html).
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

const EVENT_LOOP_WINDOW_MS = 10_000;
const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
eventLoopDelay.enable();
let gcPauseMaxMs = 0;
let gcPauseTotalMs = 0;
new PerformanceObserver(list => {
  for (const entry of list.getEntries()) {
    gcPauseMaxMs = Math.max(gcPauseMaxMs, entry.duration);
    gcPauseTotalMs += entry.duration;
  }
}).observe({ entryTypes: ['gc'] });
const nanosecondsToMs = nanoseconds => Math.round(nanoseconds / 1e5) / 10;
const roundMs = milliseconds => Math.round(milliseconds * 10) / 10;
let eventLoopReport = { p50: 0, p99: 0, max: 0, gcMax: 0, gcTotal: 0 };
setInterval(() => {
  eventLoopReport = {
    p50: nanosecondsToMs(eventLoopDelay.percentile(50)),
    p99: nanosecondsToMs(eventLoopDelay.percentile(99)),
    max: nanosecondsToMs(eventLoopDelay.max),
    gcMax: roundMs(gcPauseMaxMs),
    gcTotal: roundMs(gcPauseTotalMs),
  };
  eventLoopDelay.reset();
  gcPauseMaxMs = 0;
  gcPauseTotalMs = 0;
}, EVENT_LOOP_WINDOW_MS).unref();

// ---------- HTTP + WebSocket ------------------------------------------------
const server = http.createServer((req, res) => {
  const [route, qs] = req.url.split('?');
  if (route === '/health') {
    const players = [...rooms.values()].reduce((n, r) => n + activeCount(r), 0);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, live: liveRooms(), max: MAX_ROOMS,
                             queue: queue.length, players, loop: eventLoopReport }));
    return;
  }
  // Shared leaderboard. Plain HTTP rather than a WebSocket message because it is read from
  // the MENU, with no match under way and no socket open. CORS is wide open: it is public
  // read-only data, and in development the page is often served from another origin than the
  // server's.
  if (route === '/leaderboard') {
    const limit = Number(new URLSearchParams(qs || '').get('limit')) || 20;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8',
                         'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(leaderboard.snapshot(limit)));
    return;
  }
  if (route === '/rooms') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8',
                         'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ rooms: publicRoomList() }));
    return;
  }
  if (STATIC_DIR && (req.method === 'GET' || req.method === 'HEAD')) { serveStatic(req, res); return; }
  res.writeHead(404); res.end();
});

// permessage-deflate: the 'w' snapshots are JSON with very repetitive keys and run to tens
// of KB raw (at 15/s = hundreds of KB/s per player: on mobile the socket clogs and
// EVERYTHING crawls). They compress to ~15-18% of raw for ~2ms of CPU per round: the single
// change that makes multiplayer playable. A low level (near-identical ratio, less CPU); a
// threshold to skip small messages (client input); and no client-side context takeover, to
// keep RAM down on phones.
const perMessageDeflate = {
  threshold: 256,                       // below 256B compression is not worth it
  zlibDeflateOptions: { level: 3, memLevel: 8 },
  clientNoContextTakeover: true, serverNoContextTakeover: false,
  concurrencyLimit: 10,
};
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate });
const hostLinkWss = new WebSocketServer({
  noServer: true, maxPayload: HOST_LINK_MAX_PAYLOAD,
  perMessageDeflate: { ...perMessageDeflate, clientNoContextTakeover: false },
});

function requestPathname(req) {
  try { return new URL(req.url, 'http://localhost').pathname; } catch { return ''; }
}
function rejectUpgrade(socket) {
  try { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); } catch {}
  socket.destroy();
}
server.on('upgrade', (req, socket, head) => {
  const target = requestPathname(req) === HOST_LINK_PATH ? (HOST_MODE ? hostLinkWss : null) : wss;
  if (!target) { rejectUpgrade(socket); return; }
  target.handleUpgrade(req, socket, head, ws => target.emit('connection', ws, req));
});

hostLinkWss.on('connection', ws => {
  ws.isAlive = true;
  ws._rateTokens = HOST_LINK_MESSAGE_BURST;
  ws._rateCheckedAt = now();
  const helloTimer = setTimeout(() => { if (!ws._hostRoom) ws.terminate(); }, HOST_LINK_HELLO_MS);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => {
    const binaryAllowed = ws._hostRoom && data[0] === SNAPSHOT_FRAME_BYTE;
    if ((isBinary && !binaryAllowed) || !withinHostLinkRate(ws)) { ws.terminate(); return; }
    if (ws._hostRoom) onHostLinkMessage(ws, data, isBinary);
    else onHostLinkHello(ws, data);
  });
  ws.on('close', () => { clearTimeout(helloTimer); onHostLinkClose(ws); });
  ws.on('error', () => onHostLinkClose(ws));
});

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });   // reply to the heartbeat ping (native WS frame)
  ws.on('message', data => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'ping') { sendRaw(ws, pongFor(m)); return; }   // application-level keepalive
    if (!ws._pid) {                                // not in a room yet: only create/join/leave-queue
      if (m.t === 'create') handleCreate(ws, m);
      else if (m.t === 'join') handleJoin(ws, m);
      else if (m.t === 'unqueue') { removeFromQueue(ws); try { ws.close(); } catch {} }
      else if (m.t !== 'hostlink') ws.close();
      return;
    }
    onGameMessage(ws, m);
  });
  ws.on('close', () => { onQueueDisconnect(ws); onDisconnect(ws); });
  ws.on('error', () => { onQueueDisconnect(ws); onDisconnect(ws); });
});

// Heartbeat: anyone not answering the ping within one round is a dead socket.
const heartbeat = setInterval(() => {
  for (const ws of [...wss.clients, ...hostLinkWss.clients]) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

// ---------- Profiling report (only with SIM_PROFILE) ------------------------
if (PROFILE) {
  // Event-loop lag: a fixed-interval timer; however late it fires beyond the expected
  // interval is time the loop spent busy (tick/gen).
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
    const cpu = (prof.tickSum / PROFILE_MS) * 100;   // ms of tick per ms of wall-clock = fraction of one core
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
  lagTimer.unref?.(); reportTimer.unref?.();      // they do not keep the process alive
  log('profilazione attiva (SIM_PROFILE): report ogni', PROFILE_MS + 'ms');
}

server.listen(PORT, HOST, () => log(`Vibe City server in ascolto su ${HOST}:${PORT}`
  + (STATIC_DIR ? ` · serve i file statici da ${STATIC_DIR}` : ' · solo WebSocket')));

// Clean shutdown (Fly/Railway send SIGTERM on redeploy).
for (const sig of ['SIGTERM', 'SIGINT']) {
  // The leaderboard is written to disk on a debounce: flushing here means a redeploy does not
  // throw away the last few minutes of matches.
  process.on(sig, () => shutdown(sig));
}
process.on('message', message => { if (message === 'shutdown') shutdown('ipc'); });
function shutdown(reason) { log('shutdown', reason); leaderboard.flush(); server.close(); process.exit(0); }
