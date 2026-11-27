// VIBE CITY · js/save.js — SINGLE-PLAYER game saves.
//
// The city is generated deterministically from the room code (ROOM_CODE, see
// core.js), so it is NOT saved: remembering the code is enough to regenerate it.
// A save therefore holds only the player's live state (position, health, weapons,
// cash, wanted level, time left, mission counters) plus that city's code.
//
// One slot per browser (localStorage, key `vibeCity.save`). Traffic and pedestrians
// are not saved: they repopulate on their own, indistinguishably.
//
// Reloading implies REGENERATING the world: if the saved code differs from the
// current ROOM_CODE the page reloads onto `#room=<code>` (like the host/join flow)
// and the state is applied on the way back — that plumbing lives in ui.js
// (loadIntent); this file holds only the logic.

const SAVE_VERSION = 1;

// In multiplayer the server owns the state: no local saving.
function canSave() { return started && !netActive(); }
function hasSave() { const s = store.get('save', null); return !!(s && s.v === SAVE_VERSION && s.code); }

function captureSave() {
  return {
    v: SAVE_VERSION,
    date: Date.now(),
    code: ROOM_CODE,                       // city seed: regenerates it identically on reload
    name: playerName,
    minutes: gameMinutes,
    violence: violenceOn,
    dayNight: dayNightOn,
    timeLeft,                              // frames left (0 = untimed game)
    matchElapsed: matchElapsedFrames,
    cash,
    wanted, wantedHeat, crimeCd,
    lightClock,
    player: {
      x: player.x, y: player.y, health: player.health,
      weaponIdx: player.weaponIdx, owned: player.owned.slice(),
      shirt: player.shirt, skin: player.skin, hair: player.hair,
      score: player.score, kills: player.kills, deaths: player.deaths,
    },
    // Mission counters. Missions in progress are NOT saved: on load they restart as
    // "available", but the ride/delivery/rescue totals carry over.
    missions: { rides: taxi.rides, pizza: pizza.jobs, rescue: rescue.jobs,
                arrests: patrol.arrests, fire: firejob.jobs },
  };
}

// Applies a save to the game globals. ASSUMES the world was already generated with
// the right code (same city): this only puts the player back together.
function applySave(s) {
  if (!s || s.v !== SAVE_VERSION) return false;
  playerName = s.name || playerName; store.set('name', playerName);
  gameMinutes = s.minutes | 0; store.set('minutes', gameMinutes);
  violenceOn = s.violence !== false;     // old saves (no field) = violence on
  dayNightOn = s.dayNight !== false;
  timeLeft = s.timeLeft | 0;
  matchElapsedFrames = s.matchElapsed | 0;
  cash = s.cash | 0;
  wanted = s.wanted | 0; wantedHeat = +s.wantedHeat || 0; crimeCd = s.crimeCd | 0;
  lightClock = s.lightClock | 0;
  const p = s.player || {};
  const onMap = p.x > 0 && p.y > 0 && p.x < WORLD_W && p.y < WORLD_H;
  if (onMap && !boxHits(p.x, p.y, player.r, player.r)) { player.x = p.x; player.y = p.y; }
  player.health = clamp(p.health == null ? 100 : p.health, 1, 100);
  player.weaponIdx = clamp(p.weaponIdx | 0, 0, WEAPONS.length - 1);
  // Free weapons stay unlocked even if the save predates them.
  player.owned = WEAPONS.map((w, i) => !w.price || !!(p.owned && p.owned[i]));
  if (p.shirt) player.shirt = p.shirt;
  if (p.skin)  player.skin  = p.skin;
  if (p.hair)  player.hair  = p.hair;
  player.score = p.score | 0; player.kills = p.kills | 0; player.deaths = p.deaths | 0;
  player.car = null; player.streak = 0; player.bounty = 0;
  const m = s.missions || {};
  taxi.rides = m.rides | 0; pizza.jobs = m.pizza | 0; rescue.jobs = m.rescue | 0;
  patrol.arrests = m.arrests | 0; firejob.jobs = m.fire | 0;
  return true;
}

// Saves the running game (from the pause menu). Returns true if it was saved.
function saveGame() {
  if (!canSave()) return false;
  store.set('save', captureSave());
  return true;
}

function deleteSave() { store.set('save', null); }
