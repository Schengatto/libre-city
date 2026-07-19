// LIBRE CITY · js/ui.js — HUD DOM, loop principale, menu, impostazioni, classifica, pausa e avvio.

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
// cronometro della partita a tempo (nascosto in modalità senza limiti)
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
  el.textContent = w.melee ? `${w.icon} ${w.name}` : `${w.icon} ${w.name} · ∞`;
}
// marcia attuale: visibile solo alla guida (R in retromarcia)
function updateGear() {
  const el = $('#gear'); if (!el) return;
  const c = player.car;
  el.classList.toggle('hidden', !c);
  if (!c) return;
  const txt = c.speed < -0.3 ? '⚙️ R' : `⚙️ ${c.gear || 1}ª`;
  if (el.textContent !== txt) el.textContent = txt;
}
let toastT = 0;
function toast(msg) { const el = $('#toast'); if (!el) return; el.textContent = msg; el.classList.add('show'); toastT = 150; }
function updateToast() { if (toastT > 0 && --toastT === 0) $('#toast').classList.remove('show'); }
// guida comandi (desktop): compatta di default, H o un clic la apre/chiude tutta
function toggleHelp() { const el = $('#hint'); if (el) el.classList.toggle('open'); }
const hintBox = $('#hint');
if (hintBox) hintBox.onclick = toggleHelp;

// =========================================================
//  LOOP
// =========================================================
function loop() {
  if (!started) return;
  // in pausa la catena RAF resta viva (evita doppi loop alla ripresa), ma il gioco è fermo
  if (!paused) {
    update();
    render();
    if ((frame & 7) === 0) updateCash();
    if ((frame & 3) === 0) updateGear();
    updateToast();
  }
  requestAnimationFrame(loop);
}

// =========================================================
//  MENU PRINCIPALE · IMPOSTAZIONI · CLASSIFICA · PAUSA
// =========================================================
const PANELS = ['namePanel', 'menuPanel', 'settingsPanel', 'scoresPanel', 'howtoPanel',
                'mpPanel', 'hostPanel', 'invitePanel', 'joinPanel'];
function showPanel(id) {
  for (const p of PANELS) { const el = $('#' + p); if (el) el.classList.toggle('hidden', p !== id); }
}
function showMenu() {
  const nm = $('#menuName'); if (nm) nm.textContent = playerName;
  showPanel('menuPanel');
}

// ---- classifica (top 10 in localStorage) ----
// salva la partita appena conclusa e ritorna la posizione in classifica (0 = fuori dalla top 10)
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
      ['', s.min > 0 ? s.min + ' min' : 'libera'],
      ['', new Date(s.date).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })],
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

// ---- pausa (Esc o pulsante ⏸ su touch) ----
function togglePause() {
  if (!started) return;
  paused = !paused;
  const el = $('#pause'); if (el) el.classList.toggle('hidden', !paused);
  const pc = $('#pauseShare'); if (pc) pc.classList.toggle('hidden', !netActive());   // invito in multigiocatore
  if (paused) { engineGain(0); for (const k in keys) keys[k] = false; mDownL = false; }
}

// ---- fine partita: tempo scaduto o uscita dalla pausa ----
function endGame(reason) {
  if (!started) return;
  started = false; paused = false;
  engineGain(0);
  const p = $('#pause'); if (p) p.classList.add('hidden');
  const bm = $('#bigMsg'); if (bm) bm.classList.add('hidden');
  const lad = $('#ladder'); if (lad) lad.classList.add('hidden');
  const rank = saveScore();
  const t = $('#goTitle'); if (t) t.textContent = reason === 'time' ? '⏱ Tempo scaduto!' : '🏁 Partita terminata';
  const s = $('#goScore'); if (s) s.textContent = '$' + cash;
  const r = $('#goRank');
  const glw = $('#goLadderWrap');
  if (netActive()) {
    // multigiocatore: l'host avvisa gli ospiti e il riepilogo mostra la ladder
    if (net.mode === 'host') netBroadcast({ t: 'end' });
    renderLadder();
    if (glw) glw.classList.remove('hidden');
    const rows = ladderRows(), my = rows.findIndex(x => x.me) + 1;
    if (r) r.textContent = `${playerName}, sei ${my}º su ${rows.length} — 💀 ${net.kills} · ☠️ ${net.deaths}`;
  } else {
    if (glw) glw.classList.add('hidden');
    if (r) r.textContent = rank > 0 ? `${playerName}, sei ${rank}º in classifica! 🏆` : 'Peccato, niente top 10 stavolta…';
  }
  const go = $('#gameOver'); if (go) go.classList.remove('hidden');
  sfx.coin();
}

// ---- avvio partita (singolo, host o ospite appena entrato) ----
function startMatch() {
  if (started) return;
  initAudio();
  $('#start').style.display = 'none';
  started = true;
  timeLeft = gameMinutes * 60 * 60;              // minuti → frame (~60 fps)
  if (netActive() && net.mode === 'client' && net.clockLeft != null) timeLeft = net.clockLeft;   // orologio dell'host
  updateStars(); updateHealth(); updateCash(); updateWeapon(); updateTimer();
  const hi = usingTouch ? 'Avvicinati a un\'auto e tocca 🚗' : 'Ruba un\'auto con E';
  const mp = netActive() ? (usingTouch ? ' · 🏆 per la classifica' : ' · Tab per la classifica') : '';
  toast(`Benvenuto a Libre City, ${playerName}! 🏙️  ${hi}${mp}`);
  loop();
}
const playBtn = $('#playBtn');
if (playBtn) playBtn.onclick = startMatch;

// ---- navigazione dei pannelli ----
function onClick(id, fn) { const el = $('#' + id); if (el) el.onclick = fn; }
onClick('settingsBtn', () => {
  const n = $('#setName'), d = $('#setDuration');
  if (n) n.value = playerName;
  if (d) d.value = String(gameMinutes);
  showPanel('settingsPanel');
});
onClick('settingsSave', () => {
  const n = $('#setName'), d = $('#setDuration');
  const name = n ? n.value.trim() : '';
  if (!name) { if (n) { n.focus(); n.placeholder = 'Serve un nome!'; } return; }
  playerName = name; store.set('name', playerName);
  gameMinutes = d ? +d.value : 0; store.set('minutes', gameMinutes);
  showMenu();
});
onClick('settingsBack', showMenu);
onClick('scoresBtn', () => { renderScores(); showPanel('scoresPanel'); });
onClick('scoresBack', showMenu);
onClick('howtoBtn', () => showPanel('howtoPanel'));
onClick('howtoBack', showMenu);
onClick('resumeBtn', togglePause);
onClick('quitBtn', () => { paused = false; endGame('quit'); });
onClick('backToMenu', () => location.reload());
bindBtn('btnPause', togglePause);

// =========================================================
//  MULTIGIOCATORE: crea/entra, invito, avvio (la rete è in js/net.js)
// =========================================================
onClick('mpBtn', () => {
  if (typeof Peer === 'undefined') { toast('🌐 Il multigiocatore ha bisogno di internet — riprova più tardi'); return; }
  showPanel('mpPanel');
});
onClick('mpBack', showMenu);
onClick('mpHostBtn', () => { const s = $('#hostStatus'); if (s) s.textContent = ''; showPanel('hostPanel'); });
onClick('mpJoinBtn', () => showJoinPanel());
onClick('hostBack', () => showPanel('mpPanel'));
onClick('joinBack', () => showPanel('mpPanel'));

// messaggi d'errore della rete in italiano
function netErrText(err) {
  return { offline: 'Serve una connessione internet',
           pass: 'Password sbagliata',
           full: 'La partita è al completo',
           'peer-unavailable': 'Partita non trovata — controlla il codice e chiedi all\'host di tenere il gioco aperto sullo schermo',
           'unavailable-id': 'Codice stanza già in uso: ricarica la pagina e riprova',
           timeout: 'Nessuna risposta dall\'host — il suo telefono deve avere il gioco aperto',
           host: 'L\'host ha rifiutato la connessione' }[err] || ('Errore di rete: ' + err);
}

// ---- ospita: crea la stanza e mostra il pannello d'invito ----
onClick('hostGo', () => {
  const st = $('#hostStatus');
  if (st) st.textContent = 'Creazione della stanza…';
  const pass = $('#hostPass') ? $('#hostPass').value : '';
  const maxP = $('#hostMax') ? +$('#hostMax').value : 4;
  netStartHost(pass, maxP, err => {
    if (err) { if (st) st.textContent = netErrText(err); return; }
    if (st) st.textContent = '';
    const c = $('#inviteCode'); if (c) c.textContent = ROOM_CODE;
    const l = $('#inviteLink'); if (l) l.value = inviteLink();
    netRefreshBadge();
    showPanel('invitePanel');
  });
});
onClick('inviteShare', () => shareInvite($('#inviteShare')));
onClick('inviteCopy', () => copyInvite($('#inviteCopy')));
onClick('invitePlay', startMatch);
onClick('inviteBack', () => { netShutdown(); showMenu(); });
onClick('pauseShare', () => shareInvite($('#pauseShare')));

// ---- entra: pannello con nome + codice + password ----
// prefill: nome salvato, codice dal link (#room=…) e password di un eventuale
// tentativo interrotto dal ricaricamento (joinIntent, vedi sotto)
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
  if (!name) { const n = $('#joinName'); if (n) { n.focus(); n.placeholder = 'Serve un nome!'; } return; }
  if (!/^[A-Z0-9]{4,12}$/.test(code)) { if (st) st.textContent = 'Codice non valido (es. K7PF2M)'; return; }
  playerName = name; store.set('name', playerName);
  if (code !== ROOM_CODE) {
    // la città è già stata generata con un altro seme: memorizza l'intento
    // e ricarica la pagina sul codice giusto (al ritorno il pannello è precompilato)
    store.set('joinIntent', { code, pass });
    location.hash = 'room=' + code;
    location.reload();
    return;
  }
  store.set('joinIntent', null);
  if (st) st.textContent = 'Connessione…';
  netJoin(code, pass, err => {
    if (err) { if (st) st.textContent = netErrText(err); return; }
    startMatch();
  });
});
// Invio nei campi del pannello "entra" = pulsante Entra
for (const id of ['joinCode', 'joinPass', 'joinName']) {
  const el = $('#' + id);
  if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') { const b = $('#joinGo'); if (b) b.onclick(); } });
}

// ---- primo avvio: chiedi il nome del giocatore ----
function confirmName() {
  const inp = $('#nameInput');
  const name = inp ? inp.value.trim() : '';
  if (!name) { if (inp) { inp.focus(); inp.placeholder = 'Serve un nome!'; } return; }
  playerName = name; store.set('name', playerName);
  showMenu();
}
onClick('nameOk', confirmName);
const nameInput = $('#nameInput');
if (nameInput) nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') confirmName(); });

// arrivati da un link d'invito (#room=…): dritti al pannello "entra in partita"
// (che chiede anche il nome, quindi va bene pure al primo avvio)
if (ROOM_FROM_URL) showJoinPanel();
else if (playerName) showMenu();
else { showPanel('namePanel'); if (nameInput) nameInput.focus(); }
