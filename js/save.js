// LIBRE CITY · js/save.js — salvataggio della partita in GIOCATORE SINGOLO.
//
// La città è generata in modo deterministico dal seme = codice stanza (ROOM_CODE,
// vedi core.js): NON va salvata, basta ricordare il codice e rigenerarla. Quindi un
// salvataggio è solo lo stato "vivo" del giocatore (posizione, salute, armi, soldi,
// livello ricercato, tempo rimasto, contatori missioni) più il codice della sua città.
//
// Slot unico per browser (localStorage, chiave `libreCity.save`). Il traffico e i
// pedoni non si salvano: ripopolano da soli all'avvio, indistinguibili.
//
// Ricaricare implica RIGENERARE il mondo: se il codice salvato ≠ ROOM_CODE corrente,
// si ricarica la pagina su `#room=<codice>` (come fa il flusso host/join) e al ritorno
// si applica lo stato — la meccanica è in ui.js (loadIntent), qui c'è solo la logica.

const SAVE_VERSION = 1;

// In multigiocatore lo stato è autoritativo del server: niente salvataggio locale.
function canSave() { return started && !netActive(); }
// c'è un salvataggio compatibile da poter ricaricare?
function hasSave() { const s = store.get('save', null); return !!(s && s.v === SAVE_VERSION && s.code); }

// fotografa lo stato corrente in un oggetto serializzabile
function captureSave() {
  return {
    v: SAVE_VERSION,
    date: Date.now(),
    code: ROOM_CODE,                       // seme della città: la rigenera identica al reload
    name: playerName,
    minutes: gameMinutes,
    timeLeft,                              // frame rimasti (0 = partita senza limiti)
    cash,
    wanted, wantedHeat, crimeCd,
    lightClock,
    player: {
      x: player.x, y: player.y, health: player.health,
      weaponIdx: player.weaponIdx, owned: player.owned.slice(),
      shirt: player.shirt, skin: player.skin, hair: player.hair,
      score: player.score, kills: player.kills, deaths: player.deaths,
    },
    // contatori delle missioni (le missioni in corso NON si salvano: al carico
    // ripartono da "libere", ma i totali di corse/consegne/soccorsi restano)
    missions: { rides: taxi.rides, pizza: pizza.jobs, rescue: rescue.jobs,
                arrests: patrol.arrests, fire: firejob.jobs },
  };
}

// applica un salvataggio ai globali di gioco. PRESUPPONE che il mondo sia già stato
// generato col codice giusto (stessa città): qui si rimette in piedi solo il giocatore.
function applySave(s) {
  if (!s || s.v !== SAVE_VERSION) return false;
  playerName = s.name || playerName; store.set('name', playerName);
  gameMinutes = s.minutes | 0; store.set('minutes', gameMinutes);
  timeLeft = s.timeLeft | 0;
  cash = s.cash | 0;
  wanted = s.wanted | 0; wantedHeat = +s.wantedHeat || 0; crimeCd = s.crimeCd | 0;
  lightClock = s.lightClock | 0;
  const p = s.player || {};
  player.x = p.x; player.y = p.y;
  player.health = clamp(p.health == null ? 100 : p.health, 1, 100);
  player.weaponIdx = clamp(p.weaponIdx | 0, 0, WEAPONS.length - 1);
  // le armi gratis restano sempre sbloccate anche se il salvataggio è più vecchio
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

// salva la partita in corso (dalla pausa). Ritorna true se salvato.
function saveGame() {
  if (!canSave()) return false;
  store.set('save', captureSave());
  return true;
}

function deleteSave() { store.set('save', null); }
