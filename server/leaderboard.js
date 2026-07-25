'use strict';
// =============================================================================
// LIBRE CITY · server/leaderboard.js — SHARED multiplayer leaderboard.
//
// The per-match ladder (Tab / 🏆) lives and dies with the room: it says who won THAT match
// and nothing else. This module is the other half — a leaderboard shared by everyone on the
// server and surviving restarts, so playing multiplayer leaves a trace.
//
// THE METRIC: POINTS PER MINUTE. Rooms last anything from a few minutes to half an hour
// (`minutes` is chosen by whoever creates them), so the raw score is not comparable: 1000
// points in 5 minutes is a very different thing from 1000 points in 30. We therefore
// accumulate, per player, the score earned and the time actually PLAYED, and rank on their
// ratio:
//
//     ppm = score / (msPlayed / 60000)
//
// Two consequences worth knowing:
//   • the time is that spent CONNECTED and in play — the grace window during which a
//     dropped player is held is not counted (index.js freezes the clock when they drop);
//   • a player needs QUALIFY_MS of total play before appearing: without it, whoever gets a
//     lucky kill in the first thirty seconds and leaves would sit on top for ever.
//
// IDENTITY. There are no accounts: the name typed in the menu is the identity, normalised
// (trimmed, collapsed whitespace, case-insensitive) but SHOWN as last typed. Homonyms
// therefore share a row — the acceptable price for a game you enter by typing a nickname.
//
// PERSISTENCE. One JSON file, rewritten atomically (tmp + rename) and debounced, so a busy
// server does not do I/O on every kill. If the file cannot be written (read-only volume) the
// leaderboard keeps working in RAM and says so once in the log.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

const FILE = process.env.LEADERBOARD_FILE || path.join(__dirname, 'data', 'leaderboard.json');
// Minimum total play before a player is ranked. Below it the entry is stored (the time keeps
// adding up match after match) but stays out of the standings.
const QUALIFY_MS = Number(process.env.LEADERBOARD_QUALIFY_MS) || 3 * 60_000;
// Sessions shorter than this are not recorded at all: someone who joins, sees the room and
// leaves would otherwise dilute their own ppm with dead time.
const MIN_SESSION_MS = Number(process.env.LEADERBOARD_MIN_SESSION_MS) || 30_000;
// Cap on stored entries: the file stays small and the read stays O(small). Beyond the cap the
// lowest ppm drop out (the unranked ones first, since they have no standing to lose).
const MAX_ENTRIES = Number(process.env.LEADERBOARD_MAX) || 500;
const SAVE_DEBOUNCE_MS = 5_000;

const log = (...a) => console.log(new Date().toISOString(), '[leaderboard]', ...a);

// key (normalised name) → entry
const entries = new Map();
let dirty = false, saveTimer = null, ioBroken = false;

// The name as an identity: case- and spacing-insensitive, so "Fede" and " fede " are one
// player. The DISPLAYED name stays the last one typed (see record()).
function keyOf(name) { return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
function ppmOf(e) { return e.ms > 0 ? (e.score * 60_000) / e.ms : 0; }
// The name as it is SHOWN: tidied up (the padding is not part of the nickname), capped at the
// same 14 characters the client allows.
function displayName(name) { return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 14); }

function blank(name) {
  return { name: displayName(name), ms: 0, score: 0, kills: 0, deaths: 0, matches: 0,
           best: null, at: 0 };
}

// ---------- Recording -------------------------------------------------------
// One player's stint in one room. `ms` is the time actually played, `score` the points earned
// in that match (kills + bounties, exactly what the ladder shows). Returns the updated entry,
// or null if the stint was too short to count.
function record({ name, ms, score = 0, kills = 0, deaths = 0, at = Date.now() }) {
  const key = keyOf(name);
  if (!key || !(ms > 0)) return null;
  if (ms < MIN_SESSION_MS) return null;
  let e = entries.get(key);
  if (!e) { e = blank(name); entries.set(key, e); }
  else e.name = displayName(name);           // the display name follows the latest spelling
  e.ms += ms;
  e.score += Math.max(0, score | 0);
  e.kills += Math.max(0, kills | 0);
  e.deaths += Math.max(0, deaths | 0);
  e.matches++;
  e.at = at;
  // Personal best: the single match with the highest ppm, kept as a "career highlight"
  // alongside the (more honest) career average. Only qualifying-length matches compete for
  // it, otherwise the best is always the shortest match.
  const mppm = (score * 60_000) / ms;
  if (ms >= MIN_SESSION_MS * 2 && (!e.best || mppm > e.best.ppm)) {
    e.best = { ppm: Math.round(mppm * 10) / 10, score: score | 0, ms, at };
  }
  touch();
  return e;
}

// ---------- Reading ---------------------------------------------------------
// The standings: qualified players only, best points-per-minute first. Ties (frequent at 0
// points, before anyone gets a kill) fall back to who has played more.
function top(limit = 20) {
  const rows = [];
  for (const e of entries.values()) {
    if (e.ms < QUALIFY_MS) continue;
    rows.push({ ...e, ppm: Math.round(ppmOf(e) * 10) / 10 });
  }
  rows.sort((a, b) => b.ppm - a.ppm || b.ms - a.ms);
  return rows.slice(0, Math.max(1, Math.min(100, limit | 0 || 20)))
             .map((r, i) => ({ rank: i + 1, ...r }));
}
// The payload served on GET /leaderboard: the standings plus the numbers that let the client
// explain itself (why a player is missing, how many are tracked).
function snapshot(limit = 20) {
  let ranked = 0;
  for (const e of entries.values()) if (e.ms >= QUALIFY_MS) ranked++;
  return { ok: true, metric: 'ppm', qualifyMs: QUALIFY_MS, tracked: entries.size, ranked,
           top: top(limit) };
}
// Where a given player stands (used to tell them their position after a match). null if they
// have not qualified yet.
function rankOf(name) {
  const key = keyOf(name);
  const rows = top(100);
  const i = rows.findIndex(r => keyOf(r.name) === key);
  return i < 0 ? null : rows[i];
}

// ---------- Persistence -----------------------------------------------------
function touch() {
  dirty = true;
  if (saveTimer || ioBroken) return;
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();          // a pending save must not keep the process alive
}
// Drops the weakest entries once past the cap. Unqualified ones go first: they have played
// too little to have earned a place, and they are the ones a flood of one-off nicknames
// would create.
function prune() {
  if (entries.size <= MAX_ENTRIES) return;
  const rows = [...entries.entries()]
    .sort(([, a], [, b]) => (a.ms >= QUALIFY_MS) - (b.ms >= QUALIFY_MS) || ppmOf(a) - ppmOf(b));
  for (let i = 0; i < rows.length - MAX_ENTRIES; i++) entries.delete(rows[i][0]);
}
function save() {
  if (!dirty || ioBroken) return;
  prune();
  const data = { v: 1, savedAt: Date.now(), entries: [...entries.values()] };
  const tmp = FILE + '.tmp';
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, FILE);   // atomic: a crash mid-write never truncates the good file
    dirty = false;
  } catch (e) {
    ioBroken = true;            // say it ONCE: the leaderboard carries on in RAM
    log('salvataggio non riuscito su', FILE, '—', e.message, '(la classifica resta in RAM)');
    try { fs.unlinkSync(tmp); } catch {}
  }
}
function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const e of data.entries || []) {
      const key = keyOf(e.name);
      if (!key) continue;
      entries.set(key, { ...blank(e.name), ...e, name: displayName(e.name) });
    }
    log(entries.size, 'giocatori caricati da', FILE);
  } catch (e) {
    if (e.code !== 'ENOENT') log('file illeggibile', FILE, '—', e.message, '(riparto vuoto)');
  }
}
// Writes immediately (shutdown): a redeploy must not throw away the last few minutes.
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  save();
}
// Tests only: back to a clean slate without touching the file.
function _reset() { entries.clear(); dirty = false; }

load();

module.exports = { record, top, snapshot, rankOf, flush, save, _reset,
                   FILE, QUALIFY_MS, MIN_SESSION_MS };
