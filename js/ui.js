// VIBE CITY · js/ui.js — DOM HUD, main loop, menus, settings, high scores, pause and start-up.

// =========================================================
//  HUD
// =========================================================
const $ = s => document.querySelector(s);
function updateStars() {
  const el = $('#stars'); if (!el) return;
  let s = '';
  for (let i = 0; i < 5; i++) s += `<span class="star ${i < wanted ? 'on' : ''}">★</span>`;
  el.innerHTML = s;
  $('#wantedLabel').classList.toggle('hidden', wanted === 0);
  document.body.classList.toggle('wanted', wanted > 0);
}
function updateHealth() { const b = $('#healthBar'); if (b) b.style.width = clamp(player.health, 0, 100) + '%'; }
function updateCash() { const c = $('#cash'); if (c) c.textContent = '$' + cash; }
// Action score: in multiplayer this is the server's authoritative one (net.score), in
// single-player the local player's.
function updateScore() {
  const el = $('#score'); if (!el) return;
  el.classList.toggle('hidden', isShiftRun());
  el.textContent = '🏆 ' + (netActive() ? (net.score | 0) : (player.score | 0));
}
// Clock for a timed match (hidden in untimed mode).
function updateTimer() {
  const el = $('#timer'); if (!el) return;
  el.classList.toggle('hidden', gameMinutes <= 0);
  if (gameMinutes <= 0) return;
  const s = Math.max(0, Math.ceil(timeLeft / 60));
  el.textContent = `⏱ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  el.classList.toggle('low', s <= 60);
}
function updateWeapon() {
  updateWpnBar();
  const el = $('#weapon'); if (!el) return;
  const w = WEAPONS[player.weaponIdx];
  el.textContent = w.melee ? `${w.icon} ${wName(w)}` : `${w.icon} ${wName(w)} · ∞`;
}
// Current gear: only visible while driving (R for reverse).
function updateGear() {
  const el = $('#gear'); if (!el) return;
  const c = player.car;
  el.classList.toggle('hidden', !c);
  if (!c) return;
  const txt = c.speed < -0.3 ? t('hud.gearR') : t('hud.gear', { g: c.gear || 1 });
  if (el.textContent !== txt) el.textContent = txt;
}
let toastT = 0;
function toast(msg) { const el = $('#toast'); if (!el) return; el.textContent = msg; el.classList.add('show'); toastT = 150; }
function updateToast() { if (toastT > 0 && --toastT === 0) $('#toast').classList.remove('show'); }
// Controls guide (desktop): compact by default; H or a click expands/collapses it.
function toggleHelp() { const el = $('#hint'); if (el) el.classList.toggle('open'); }
const hintBox = $('#hint');
if (hintBox) hintBox.onclick = toggleHelp;

// =========================================================
//  LOOP
// =========================================================
// FIXED TIMESTEP. The sim is tuned for 60 steps per second (movement, physics, countdowns
// in frames). It used to advance ONE step per rendered frame: on a 30fps device EVERYTHING
// ran at half speed (the multiplayer "slowness"). Now an accumulator scales the logic to
// REAL time — 60 updates/s at any frame rate — and we draw once per frame. The
// authoritative world (interpolated against real time) and the predicted player therefore
// stay at the correct speed even at 30/40 fps.
const LOGIC_STEP = 1000 / 60;          // duration of one logic step (ms)
const LOGIC_MAX = 5;                    // max catch-up steps per frame (brake on the "death spiral")
let _loopLast = 0, _loopAcc = 0;
function loop(nowT) {
  if (!started) return;
  requestAnimationFrame(loop);
  const t = nowT || performance.now();
  // While paused the RAF chain stays alive but no time accumulates (no jump on resume).
  if (paused) { _loopLast = t; return; }
  if (!_loopLast) _loopLast = t;
  _loopAcc += Math.min(t - _loopLast, LOGIC_STEP * LOGIC_MAX);   // clamp: do not blow up after a stall (backgrounded tab)
  _loopLast = t;
  let n = 0;
  while (_loopAcc >= LOGIC_STEP && n < LOGIC_MAX) { update(); _loopAcc -= LOGIC_STEP; n++; }
  render();                             // one draw per frame, at ANY fps
  if ((frame & 7) === 0) { updateCash(); updateScore(); }
  if ((frame & 3) === 0) updateGear();
  updateToast();
}

// =========================================================
//  MAIN MENU · SETTINGS · HIGH SCORES · PAUSE
// =========================================================
const PANELS = ['langPanel', 'namePanel', 'menuPanel', 'spPanel', 'shiftPanel', 'settingsPanel', 'scoresPanel', 'lbPanel',
                'howtoPanel', 'mpPanel', 'publicPanel', 'hostPanel', 'queuePanel', 'invitePanel', 'joinPanel'];
const PUBLIC_GAMES_POLL_MS = 5000;
const PUBLIC_GAMES_TICK_MS = 1000;
const PUBLIC_ROOM_CODE_PATTERN = /^[A-Z0-9]{4,12}$/;
let publicGamesFetchTimer = null;
let publicGamesTickTimer = null;
let publicGamesEpoch = 0;
let publicGamesFetching = false;
let publicGamesJoining = false;
let publicGamesList = [];
let publicGamesFetchedAtMs = 0;
let publicGamesFailed = false;
let publicGamesRenderedKey = null;
function showPanel(id) {
  for (const p of PANELS) { const el = $('#' + p); if (el) el.classList.toggle('hidden', p !== id); }
  if (id === 'publicPanel') startPublicGamesPolling(); else stopPublicGamesPolling();
}
function showMenu() {
  const nm = $('#menuName'); if (nm) nm.textContent = playerName;
  const lb = $('#loadBtn'); if (lb) lb.classList.toggle('hidden', !hasSave());   // 💾 only when a save exists
  updateHiScore();                                                              // must be rewritten after a language change
  resetMutators();
  showPanel('menuPanel');
}
// ---- Arcade-cabinet HI-SCORE on the title screen (best saved score) ----
function updateHiScore() {
  const el = $('#hiScore'); if (!el) return;
  const best = store.get('scores', [])[0];
  if (best) el.textContent = t('hi.score', { score: best.score, name: String(best.name).toUpperCase() });
}

// ---- High scores (top 10 in localStorage) ----
// Saves the match just finished and returns its rank (0 = outside the top 10).
function saveScore() {
  const scores = store.get('scores', []);
  const entry = { name: playerName, score: cash, min: gameMinutes, date: Date.now() };
  scores.push(entry);
  scores.sort((a, b) => b.score - a.score);
  const rank = scores.indexOf(entry) + 1;
  store.set('scores', scores.slice(0, 10));
  return rank <= 10 ? rank : 0;
}
function renderScores() {
  const body = $('#scoreTable tbody'), empty = $('#scoreEmpty');
  if (!body) return;
  const scores = store.get('scores', []);
  $('#scoreTable').classList.toggle('hidden', scores.length === 0);
  if (empty) empty.classList.toggle('hidden', scores.length > 0);
  body.innerHTML = '';
  scores.forEach((s, i) => {
    const tr = document.createElement('tr');
    const cells = [
      ['', i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1],
      ['nm', s.name],
      ['sc', '$' + s.score],
      ['', s.min > 0 ? t('common.min_short', { n: s.min }) : t('common.free')],
      ['', new Date(s.date).toLocaleDateString(dateLocale(), { day: '2-digit', month: '2-digit' })],
    ];
    for (const [cls, txt] of cells) {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = txt;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  });
}

// ---- Shared online leaderboard (the server's, not this device's) ----
// The high scores above are local: they live in this browser's localStorage and only know
// about single-player. This one comes from the SERVER and holds everyone who has played
// multiplayer, ranked on POINTS PER MINUTE — the score divided by the minutes actually
// played, so a 5-minute room and a 20-minute one are comparable (see server/leaderboard.js).
// It is fetched over plain HTTP: it is read from the menu, with no match and no socket open.
function leaderboardUrl() {
  const ws = netServerUrl();
  if (!ws) return null;
  return serverHttpBase(ws) + '/leaderboard?limit=20';
}
// "2h 05m" / "48m": the total played, which for a regular player quickly goes past the hour.
function fmtPlayed(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  return min >= 60 ? t('lb.dur_hm', { h: Math.floor(min / 60), m: String(min % 60).padStart(2, '0') })
                   : t('lb.dur_m', { m: min });
}
let lbFetching = false;
async function renderLeaderboard() {
  const table = $('#lbTable'), body = $('#lbTable tbody'), msg = $('#lbMsg'), note = $('#lbNote');
  if (!table || !body || !msg) return;
  const show = (key, params) => { table.classList.add('hidden'); note.classList.add('hidden');
                                  msg.classList.remove('hidden'); msg.textContent = t(key, params); };
  const url = leaderboardUrl();
  if (!url) { show('lb.noServer'); return; }
  if (lbFetching) return;                       // a second tap while loading: one request is enough
  lbFetching = true;
  show('lb.loading');
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const rows = data.top || [];
    if (!rows.length) { show('lb.empty'); return; }
    body.innerHTML = '';
    const meKey = String(playerName || '').trim().toLowerCase();
    for (const r of rows) {
      const tr = document.createElement('tr');
      if (String(r.name).trim().toLowerCase() === meKey) tr.className = 'me';
      const cells = [
        ['', r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : r.rank],
        ['nm', r.name],
        ['sc', r.ppm],
        ['', r.matches],
        ['', fmtPlayed(r.ms)],
        ['', r.best ? r.best.ppm : '—'],
      ];
      for (const [cls, txt] of cells) {
        const td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = txt;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    table.classList.remove('hidden');
    msg.classList.add('hidden');
    // The qualifying threshold explains the absences: without it, "I played and I'm not
    // there" looks like a bug.
    note.textContent = t('lb.note') + ' ' + t('lb.qualify', { n: Math.round((data.qualifyMs || 0) / 60000) });
    note.classList.remove('hidden');
  } catch (e) {
    show('lb.error');
  } finally { lbFetching = false; }
}

// ---- Pause (Esc, or the ⏸ button on touch) ----
function togglePause() {
  if (!started) return;
  paused = !paused;
  const el = $('#pause'); if (el) el.classList.toggle('hidden', !paused);
  const pc = $('#pauseShare'); if (pc) pc.classList.toggle('hidden', !netActive());   // invite, in multiplayer
  const ps = $('#pauseSave');                                                         // 💾 save: single-player only
  if (ps) { ps.classList.toggle('hidden', netActive() || !!runConfig); ps.textContent = t('pause.save'); ps.disabled = false; }
  const qb = $('#quitBtn'); if (qb) qb.textContent = t(runConfig ? 'shift.quit' : 'pause.quit');
  if (paused) { engineGain(0); for (const k in keys) keys[k] = false; mDownL = false; }
}

// ---- End of match: time up, or quitting from the pause menu ----
function endGame(reason) {
  if (!started) return;
  started = false; paused = false;
  engineGain(0);
  const p = $('#pause'); if (p) p.classList.add('hidden');
  const bm = $('#bigMsg'); if (bm) bm.classList.add('hidden');
  const lad = $('#ladder'); if (lad) lad.classList.add('hidden');
  if (runConfig) { finishRun(reason); return; }
  const rank = saveScore();
  const gt = $('#goTitle'); if (gt) gt.textContent = t(reason === 'time' ? 'go.time' : 'go.quit');
  const sc = netActive() ? (net.score | 0) : (player.score | 0);
  const s = $('#goScore'); if (s) s.textContent = `🏆 ${sc} · $${cash}`;
  const r = $('#goRank');
  const glw = $('#goLadderWrap');
  if (netActive()) {
    // Multiplayer: the server calls time ('end' message); here we only show the summary
    // with the ladder.
    renderLadder();
    if (glw) glw.classList.remove('hidden');
    const rows = ladderRows(), my = rows.findIndex(x => x.me) + 1;
    if (r) r.textContent = t('go.mpRank', { name: playerName, rank: my, tot: rows.length,
                                            kills: net.kills, deaths: net.deaths });
  } else {
    if (glw) glw.classList.add('hidden');
    if (r) r.textContent = rank > 0 ? t('go.rank', { name: playerName, rank }) : t('go.noRank');
  }
  const go = $('#gameOver'); if (go) go.classList.remove('hidden');
  sfx.coin();
}

// ---- Starting a match (single-player, host, or a guest who just joined) ----
// resume=true → a match resumed from a save: time and score have already been applied by
// applySave() and must not be reset.
function startMatch(resume) {
  if (started) return;
  stopPublicGamesPolling();
  initAudio();
  $('#start').style.display = 'none';
  stopMenuMusic();
  started = true;
  gameEvents.enabled = !netActive();
  if (netActive()) resetMutators();
  if (!resume) {
    timeLeft = gameMinutes * 60 * 60;            // minutes → frames (~60 fps)
    if (netActive() && net.clockLeft != null) timeLeft = net.clockLeft;   // the server's authoritative clock
    matchElapsedFrames = 0;
    if (netActive() && net.clockLeft != null && gameMinutes > 0) matchElapsedFrames = gameMinutes * 60 * 60 - net.clockLeft;
    player.score = 0;                            // new match: score reset (in MP net.score is what counts)
  }
  if (runConfig) startRun();
  // Violence filter (single-player): no weapons in hand → hide the weapon readout and the
  // weapon bar.
  const peace = peaceMode();
  const wpn = $('#weapon'); if (wpn) wpn.style.display = peace ? 'none' : '';
  const wb = $('#wpnBar'); if (wb) wb.style.display = peace ? 'none' : '';
  updateStars(); updateHealth(); updateCash(); updateScore(); updateWeapon(); updateTimer(); updateMutatorBadges();
  const hi =t(usingTouch ? 'game.hintTouch' : 'game.hintKb');
  const mp = netActive() ? t(usingTouch ? 'game.mpLadderTouch' : 'game.mpLadderKb') : '';
  toast(resume ? t('game.welcomeBack', { name: playerName })
               : t('game.welcome', { name: playerName, hint: hi, mp }));
  _loopLast = 0; _loopAcc = 0;                    // start clean (no catch-up from the previous match)
  loop();
}
// ---- Single-player: creation panel (violence, duration, map size) ----
// As for the host, the map size lives in the code's seed → a reload onto the right city is
// needed; violence and duration travel inside the intent and are applied on the way back.
function updateMutatorBadges() {
  const badges = $('#mutatorBadges'); if (!badges) return;
  badges.textContent = '';
  const visible = activeMutatorIds.length > 0 && !netActive();
  badges.classList.toggle('hidden', !visible);
  if (!visible) return;
  for (const id of activeMutatorIds) {
    const badge = document.createElement('span');
    badge.textContent = MUTATORS[id].icon;
    badge.title = t('mut.' + id);
    badges.appendChild(badge);
  }
}
function readSpMutatorPick() {
  const ticked = [...document.querySelectorAll('#spMutators input:checked')].map(input => input.value);
  return sanitizeMutatorIds(ticked);
}
function updateSpMutatorDesc() {
  const desc = $('#spMutatorDesc'); if (!desc) return;
  desc.textContent = readSpMutatorPick().map(id => t('mut.' + id + 'Desc')).join(' ');
}
function fillSpMutatorPick(ids) {
  const wanted = new Set(sanitizeMutatorIds(ids));
  for (const input of document.querySelectorAll('#spMutators input')) input.checked = wanted.has(input.value);
  updateSpMutatorDesc();
}
function buildSpMutatorChips() {
  const box = $('#spMutators'); if (!box) return;
  box.textContent = '';
  for (const id of MUTATOR_IDS) {
    const chip = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = id;
    input.onchange = updateSpMutatorDesc;
    const name = document.createElement('span');
    name.textContent = MUTATORS[id].icon + ' ' + t('mut.' + id);
    chip.append(input, name);
    box.appendChild(chip);
  }
}
onClick('playBtn', () => {
  const d = $('#spDuration'); if (d) d.value = String(gameMinutes);
  const v = $('#spViolence'); if (v) v.value = violenceOn ? 'on' : 'off';
  buildSpMutatorChips();
  fillSpMutatorPick(store.get('mutatorsPick', []));
  showPanel('spPanel');
});
onClick('spBack', showMenu);
onClick('shiftBtn', () => { renderShiftPanel(); showPanel('shiftPanel'); });
onClick('shiftBack', showMenu);
onClick('spGo', () => {
  const mins = $('#spDuration') ? +$('#spDuration').value : 0;
  const viol = $('#spViolence') ? $('#spViolence').value === 'on' : true;
  const dayNight = $('#spDayNight') ? $('#spDayNight').value !== 'off' : true;
  const size = $('#spSize') ? $('#spSize').value : 'P';
  const code = makeSizedRoomCode(size);
  const mutators = readSpMutatorPick();
  store.set('mutatorsPick', mutators);
  store.set('spIntent', { code, mins, violence: viol, dayNight, name: playerName, mutators });
  location.hash = 'room=' + code;
  location.reload();
});

// ---- Panel navigation ----
function onClick(id, fn) { const el = $('#' + id); if (el) el.onclick = fn; }
onClick('settingsBtn', () => {
  const n = $('#setName'), a = $('#setAudio'), l = $('#setLang');
  if (n) n.value = playerName;
  if (a) a.value = audioOn ? 'on' : 'off';
  if (l) l.value = LANG;
  showPanel('settingsPanel');
});
onClick('settingsSave', () => {
  const n = $('#setName'), a = $('#setAudio'), l = $('#setLang');
  const name = n ? n.value.trim() : '';
  if (!name) { if (n) { n.focus(); n.placeholder = t('name.required'); } return; }
  playerName = name; store.set('name', playerName);
  audioOn = a ? a.value === 'on' : true; store.set('audio', audioOn);
  applyAudioSetting();                           // takes effect immediately, even mid-match
  if (l && l.value !== LANG) setLang(l.value);   // re-applies all the wording straight away
  showMenu();
});
onClick('settingsBack', showMenu);
onClick('scoresBtn', () => { renderScores(); showPanel('scoresPanel'); });
onClick('scoresBack', showMenu);
// The online leaderboard is shown FIRST and filled in when the reply arrives: the panel must
// not wait on the network to open.
onClick('lbBtn', () => { showPanel('lbPanel'); renderLeaderboard(); });
onClick('lbBack', showMenu);
onClick('howtoBtn', () => showPanel('howtoPanel'));
onClick('howtoBack', showMenu);
onClick('resumeBtn', togglePause);
// 💾 Saves the running match (single-player only): feedback on the button itself.
onClick('pauseSave', () => {
  const ok = saveGame();
  const ps = $('#pauseSave');
  if (ps) { ps.textContent = t(ok ? 'pause.saved' : 'pause.saveFail'); ps.disabled = ok; }
  if (ok) toast(t('game.saved'));
});
// 💾 Resumes the saved match: regenerates the right city (reload onto #room=…) and applies
// the state.
onClick('loadBtn', () => {
  const s = store.get('save', null);
  if (!hasSave() || !s) { toast(t('game.noSave')); return; }
  if (s.code === ROOM_CODE) {                     // already the right city: apply and go
    if (applySave(s)) startMatch(true);
    return;
  }
  // A different city: store the intent and reload onto the saved seed (it is applied below
  // on the way back).
  store.set('loadIntent', true);
  location.hash = 'room=' + s.code;
  location.reload();
});
onClick('quitBtn', () => { paused = false; endGame('quit'); });
onClick('backToMenu', () => location.reload());
bindBtn('btnPause', togglePause);

// =========================================================
//  MULTIPLAYER: create/join, invite, start (the networking lives in js/net.js)
// =========================================================
onClick('mpBtn', () => {
  if (!netServerUrl()) { toast(t('mp.noServer')); return; }
  showPanel('mpPanel');
});
onClick('mpBack', showMenu);
onClick('mpPublicBtn', () => {
  if (!netServerUrl()) { toast(t('mp.noServer')); return; }
  showPanel('publicPanel');
});
function stopPublicGamesPolling() {
  publicGamesEpoch++;
  clearInterval(publicGamesFetchTimer);
  clearInterval(publicGamesTickTimer);
  publicGamesFetchTimer = null;
  publicGamesTickTimer = null;
  publicGamesFetching = false;
}
function startPublicGamesPolling() {
  stopPublicGamesPolling();
  publicGamesJoining = false;
  publicGamesList = [];
  publicGamesFetchedAtMs = 0;
  publicGamesFailed = false;
  publicGamesRenderedKey = null;
  renderPublicGames();
  fetchPublicGames();
  publicGamesFetchTimer = setInterval(fetchPublicGames, PUBLIC_GAMES_POLL_MS);
  publicGamesTickTimer = setInterval(renderPublicGames, PUBLIC_GAMES_TICK_MS);
}
function isRenderablePublicRoom(room) {
  return !!room && PUBLIC_ROOM_CODE_PATTERN.test(room.code) && Number.isFinite(room.players) &&
    Number.isFinite(room.max) && (room.leftSec === null || Number.isInteger(room.leftSec));
}
async function fetchPublicGames() {
  if (publicGamesFetching) return;
  const epoch = publicGamesEpoch;
  publicGamesFetching = true;
  try {
    const res = await fetch(publicRoomsUrl(netServerUrl()), { cache: 'no-store', signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(PUBLIC_GAMES_POLL_MS) : undefined });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (epoch !== publicGamesEpoch) return;
    publicGamesList = (Array.isArray(data.rooms) ? data.rooms : []).filter(isRenderablePublicRoom);
    publicGamesFetchedAtMs = Date.now();
    publicGamesFailed = false;
  } catch (e) {
    if (epoch !== publicGamesEpoch) return;
    publicGamesFailed = true;
  } finally {
    if (epoch === publicGamesEpoch) { publicGamesFetching = false; renderPublicGames(); }
  }
}
function setPublicGameTime(cell, leftSec) {
  cell.textContent = formatTimeLeft(leftSec);
  cell.className = 'tm' + (isTimeLeftLow(leftSec) ? ' low' : '');
}
function buildPublicGameRow(room) {
  const row = document.createElement('tr');
  const isFull = isPublicRoomFull(room);
  if (isFull) row.className = 'full';
  const nameCell = document.createElement('td');
  nameCell.className = 'nm';
  nameCell.textContent = room.title;
  const playersCell = document.createElement('td');
  playersCell.textContent = room.players + '/' + room.max;
  const sizeCell = document.createElement('td');
  sizeCell.textContent = t(publicGameSizeKey(room.code));
  const timeCell = document.createElement('td');
  setPublicGameTime(timeCell, room.leftSec);
  const joinCell = document.createElement('td');
  const joinButton = document.createElement('button');
  joinButton.className = 'pubjoin';
  joinButton.textContent = t(isFull ? 'pub.full' : 'pub.join');
  joinButton.disabled = isFull;
  joinButton.onclick = () => joinPublicGame(room.code);
  joinCell.appendChild(joinButton);
  row.append(nameCell, playersCell, sizeCell, timeCell, joinCell);
  return row;
}
function renderPublicGames() {
  const table = $('#pubTable'), body = $('#pubTable tbody'), msg = $('#pubMsg'), count = $('#pubCount');
  const empty = $('#pubEmpty'), create = $('#pubCreate');
  if (!table || !body || !msg || !count || !empty || !create) return;
  const loaded = publicGamesFetchedAtMs > 0 && !publicGamesFailed;
  const elapsedSec = Math.max(0, Math.floor((Date.now() - publicGamesFetchedAtMs) / 1000));
  const rooms = loaded ? visiblePublicRooms(publicGamesList, elapsedSec) : [];
  msg.textContent = publicGamesFailed ? t('pub.error') : '';
  msg.classList.toggle('hidden', !publicGamesFailed);
  count.textContent = loaded ? t(rooms.length === 1 ? 'pub.countOne' : 'pub.count', { n: rooms.length }) : '';
  table.classList.toggle('hidden', rooms.length === 0);
  empty.classList.toggle('hidden', !loaded || rooms.length > 0);
  create.classList.toggle('hidden', !loaded || rooms.length > 0);
  const renderedKey = rooms.map(room => room.code + ':' + room.players + '/' + room.max).join('|');
  if (renderedKey !== publicGamesRenderedKey) {
    body.replaceChildren(...rooms.map(buildPublicGameRow));
    publicGamesRenderedKey = renderedKey;
  } else {
    rooms.forEach((room, index) => setPublicGameTime(body.rows[index].cells[3], room.leftSec));
  }
}
function joinPublicGame(code) {
  if (publicGamesJoining || !PUBLIC_ROOM_CODE_PATTERN.test(code)) return;
  publicGamesJoining = true;
  if (code !== ROOM_CODE) {
    store.set('joinIntent', { code, pass: '', auto: true });
    location.hash = 'room=' + code;
    location.reload();
    return;
  }
  stopPublicGamesPolling();
  showJoinPanel();
  const joinCodeInput = $('#joinCode'); if (joinCodeInput) joinCodeInput.value = code;
  if (!playerName) {
    publicGamesJoining = false;
    const joinNameInput = $('#joinName'); if (joinNameInput) joinNameInput.focus();
    return;
  }
  const joinStatus = $('#joinStatus'); if (joinStatus) joinStatus.textContent = t('join.connecting');
  netJoin(code, '', err => {
    publicGamesJoining = false;
    if (err) { if (joinStatus) joinStatus.textContent = netErrText(err); return; }
    startMatch();
  });
}
onClick('pubRefresh', fetchPublicGames);
onClick('pubCreate', () => { const hostButton = $('#mpHostBtn'); if (hostButton) hostButton.onclick(); });
onClick('publicBack', () => showPanel('mpPanel'));
function syncHostPassField() {
  const visibility = $('#hostVisibility');
  const passField = $('#hostPassField');
  if (passField) passField.classList.toggle('hidden', !!visibility && visibility.value === 'public');
}
if ($('#hostVisibility')) $('#hostVisibility').onchange = syncHostPassField;
onClick('mpHostBtn', () => {
  const s = $('#hostStatus'); if (s) s.textContent = '';
  const titleInput = $('#hostTitle');
  if (titleInput && !titleInput.value.trim() && playerName) titleInput.value = t('host.titleDefault', { name: playerName });
  syncHostPassField();
  showPanel('hostPanel');
});
onClick('mpJoinBtn', () => showJoinPanel());
onClick('hostBack', () => showPanel('mpPanel'));
onClick('joinBack', () => showPanel('mpPanel'));

// Network error messages, translated (an unknown key → a generic message).
const NET_ERRS = ['offline', 'noserver', 'pass', 'full', 'notfound', 'exists', 'badcode', 'timeout', 'qfull'];
function netErrText(err) {
  return NET_ERRS.includes(err) ? t('net.err.' + err) : t('net.err.other', { err });
}

// ---- Host: creates the room and shows the invite panel ----
// A room code whose 1st letter encodes the map size (P/M/G, see city.js).
function makeSizedRoomCode(sizeChar) {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';        // no ambiguous glyphs (0/O, 1/I/L)
  let tail = '';
  for (let i = 0; i < 5; i++) tail += A[Math.floor(Math.random() * A.length)];
  return (/[PMG]/.test(sizeChar) ? sizeChar : 'P') + tail;
}
onClick('hostGo', () => {
  const st = $('#hostStatus');
  const isPublic = !!$('#hostVisibility') && $('#hostVisibility').value === 'public';
  const pass = !isPublic && $('#hostPass') ? $('#hostPass').value : '';
  const typedTitle = $('#hostTitle') ? $('#hostTitle').value.trim() : '';
  const title = typedTitle || t('host.titleDefault', { name: playerName });
  const maxP = $('#hostMax') ? +$('#hostMax').value : 4;
  const mins = $('#hostDuration') ? +$('#hostDuration').value : 10;
  const size = $('#hostSize') ? $('#hostSize').value : 'P';
  const police = $('#hostPolice') ? $('#hostPolice').value !== 'off' : true;
  const dayNight = $('#hostDayNight') ? $('#hostDayNight').value !== 'off' : true;
  const code = makeSizedRoomCode(size);
  // The city of the chosen size is generated at LOAD time from the seed = code: as when
  // joining with a code, we reload onto the right room; on the way back, once the hostIntent
  // is recognised, we actually create the room and show the invite.
  store.set('hostIntent', { code, pass, maxP, mins, police, dayNight, title, isPublic, name: playerName });
  if (st) st.textContent = t('host.creating');
  location.hash = 'room=' + code;
  location.reload();
});
// ---- Waiting room: the server is at its room cap and we are queued ----
// The place in line and the estimate come from the server (netOnQueued in net.js); here we
// draw them and tick the countdown down between refreshes.
function fmtWait(ms) {
  if (ms < 15_000) return t('queue.etaNow');
  const s = Math.round(ms / 1000);
  if (s < 90) return t('queue.etaSec', { n: Math.ceil(s / 10) * 10 });
  return t('queue.etaMin', { n: Math.ceil(s / 60) });
}
function updateQueuePanel() {
  const q = net.queue; if (!q) return;
  const pos = $('#queuePos'); if (pos) pos.textContent = t('queue.posFmt', { n: q.pos });
  const why = $('#queueWhy'); if (why) why.textContent = t('queue.why', { rooms: q.rooms, max: q.max });
  const eta = $('#queueEta'); if (eta) eta.textContent = fmtWait(netQueueEta());
}
function showQueuePanel() {
  updateQueuePanel();
  showPanel('queuePanel');
}
onClick('queueCancel', () => { netCancelQueue(); showPanel('hostPanel'); });

onClick('inviteShare', () => shareInvite($('#inviteShare')));
onClick('inviteCopy', () => copyInvite($('#inviteCopy')));
onClick('invitePlay', () => startMatch(false));   // NB: without the lambda the click event would arrive as `resume` (truthy) and skip the clock init → timer stuck at 0:00
onClick('inviteBack', () => { netShutdown(); showMenu(); });
onClick('pauseShare', () => shareInvite($('#pauseShare')));

// ---- Join: panel with name + code + password ----
// Prefilled with: the saved name, the code from the link (#room=…) and the password of any
// attempt interrupted by the reload (joinIntent, see below).
function showJoinPanel() {
  const intent = store.get('joinIntent', null);
  const n = $('#joinName'); if (n) n.value = playerName;
  const c = $('#joinCode'); if (c) c.value = ROOM_FROM_URL || (intent && intent.code) || '';
  const p = $('#joinPass'); if (p) p.value = intent && intent.code === ROOM_CODE ? intent.pass || '' : '';
  const st = $('#joinStatus'); if (st) st.textContent = '';
  showPanel('joinPanel');
}
onClick('joinGo', () => {
  const st = $('#joinStatus');
  const name = $('#joinName') ? $('#joinName').value.trim() : playerName;
  const code = ($('#joinCode') ? $('#joinCode').value : '').trim().toUpperCase();
  const pass = $('#joinPass') ? $('#joinPass').value : '';
  if (!name) { const n = $('#joinName'); if (n) { n.focus(); n.placeholder = t('name.required'); } return; }
  if (!/^[A-Z0-9]{4,12}$/.test(code)) { if (st) st.textContent = t('join.badCode'); return; }
  playerName = name; store.set('name', playerName);
  if (code !== ROOM_CODE) {
    // The city has already been generated from a different seed: store the intent and reload
    // the page onto the right code (the panel comes back prefilled).
    store.set('joinIntent', { code, pass });
    location.hash = 'room=' + code;
    location.reload();
    return;
  }
  store.set('joinIntent', null);
  if (st) st.textContent = t('join.connecting');
  netJoin(code, pass, err => {
    if (err) { if (st) st.textContent = netErrText(err); return; }
    startMatch();
  });
});
// Enter in the "join" panel's fields = the Join button.
for (const id of ['joinCode', 'joinPass', 'joinName']) {
  const el = $('#' + id);
  if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') { const b = $('#joinGo'); if (b) b.onclick(); } });
}

// ---- First run: ask for the player's name ----
function confirmName() {
  const inp = $('#nameInput');
  const name = inp ? inp.value.trim() : '';
  if (!name) { if (inp) { inp.focus(); inp.placeholder = t('name.required'); } return; }
  playerName = name; store.set('name', playerName);
  showMenu();
}
onClick('nameOk', confirmName);
const nameInput = $('#nameInput');
if (nameInput) nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') confirmName(); });

// ---- First run: language choice (before anything else) ----
// After choosing, we continue with the name (or straight to the menu if a name already exists).
function chooseLang(l) {
  setLang(l);
  if (ROOM_FROM_URL) showJoinPanel();            // arrived from an invite link: carry on there (it asks for the name)
  else if (playerName) showMenu();
  else { showPanel('namePanel'); if (nameInput) nameInput.focus(); }
}
onClick('langItBtn', () => chooseLang('it'));
onClick('langEnBtn', () => chooseLang('en'));

// At start-up we decide WHICH screen to show based on what brought us here (a "Resume
// match" reload, a room creation, an invite link…).
const _loadIntent = store.get('loadIntent', null);
const _save = store.get('save', null);
const _hostIntent = store.get('hostIntent', null);
const _spIntent = store.get('spIntent', null);
const _joinIntent = store.get('joinIntent', null);
if (_spIntent && ROOM_FROM_URL === _spIntent.code) {
  // Back from the SINGLE-PLAYER creation reload: the map of the chosen size has now been
  // generated from the code's seed → apply violence/duration and start. Clears the hash so a
  // later refresh starts over from the menu (without coming back through here).
  store.set('spIntent', null);
  history.replaceState(null, '', location.pathname + location.search);
  if (_spIntent.name) { playerName = _spIntent.name; store.set('name', playerName); }
  runConfig = _spIntent.runConfig || null;
  gameMinutes = _spIntent.mins | 0;
  if (!runConfig) store.set('minutes', gameMinutes);
  violenceOn = _spIntent.violence !== false;
  dayNightOn = _spIntent.dayNight !== false;
  applyMutators(runConfig ? (runConfig.mutators || []) : (_spIntent.mutators || []));
  startMatch(false);
}
else if (_loadIntent && _save && _save.code && ROOM_FROM_URL === _save.code) {
  // Back from the "Resume match" reload (single-player): the city has now been regenerated
  // from the saved seed → apply the state and resume. Clears the #room= hash so a later
  // refresh returns to ordinary single-player (the save keeps its own code regardless).
  store.set('loadIntent', null);
  history.replaceState(null, '', location.pathname + location.search);
  if (applySave(_save)) startMatch(true);
  else showMenu();
}
else if (_hostIntent && ROOM_FROM_URL === _hostIntent.code) {
  // Back from the room-creation reload (host): the map of the chosen size has now been
  // generated from the code's seed → actually create the room and show the invite.
  store.set('hostIntent', null);
  if (_hostIntent.name) { playerName = _hostIntent.name; store.set('name', playerName); }
  gameMinutes = _hostIntent.mins;
  showPanel('invitePanel');
  const c = $('#inviteCode'); if (c) c.textContent = ROOM_CODE;
  const l = $('#inviteLink'); if (l) l.value = inviteLink();
  netStartHost(_hostIntent.pass, _hostIntent.maxP, _hostIntent.police !== false, err => {
    if (err) {
      showPanel('hostPanel');
      const st = $('#hostStatus'); if (st) st.textContent = netErrText(err);
      return;
    }
    showPanel('invitePanel');       // if we were in the waiting room: the room is ours now
    netRefreshBadge();
  }, { title: _hostIntent.title, isPublic: _hostIntent.isPublic === true, dayNight: _hostIntent.dayNight !== false });
}
// Very first run: language first of all (then name, then menu).
else if (!langChosen()) showPanel('langPanel');
// Arrived from an invite link (#room=…): straight to the "join match" panel (which also asks
// for the name, so it works on a first run too).
else if (_joinIntent && _joinIntent.auto && ROOM_FROM_URL === _joinIntent.code && playerName) {
  store.set('joinIntent', null);
  showJoinPanel();
  const autoJoinStatus = $('#joinStatus'); if (autoJoinStatus) autoJoinStatus.textContent = t('join.connecting');
  netJoin(_joinIntent.code, '', err => {
    if (err) { if (autoJoinStatus) autoJoinStatus.textContent = netErrText(err); return; }
    startMatch();
  });
}
else if (ROOM_FROM_URL) showJoinPanel();
else if (playerName) showMenu();
else { showPanel('namePanel'); if (nameInput) nameInput.focus(); }

updateHiScore();
