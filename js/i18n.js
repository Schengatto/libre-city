// LIBRE CITY · js/i18n.js — traduzioni (italiano · inglese) e applicazione al DOM.
//
// Come funziona:
//   • `t('chiave', {p:1})` → la stringa nella lingua corrente, con i segnaposto
//     {…} sostituiti. Se una chiave manca in inglese si ripiega sull'italiano
//     (mai una schermata vuota: nel peggiore dei casi si vede la chiave).
//   • `tList('chiave')` → un array di frasi (fumetti dei pedoni).
//   • Il DOM statico di index.html è marcato con attributi:
//       data-i18n="k"       → textContent
//       data-i18n-html="k"  → innerHTML (per le stringhe con <b>)
//       data-i18n-ph="k"    → placeholder
//       data-i18n-title="k" → title
//       data-i18n-aria="k"  → aria-label
//     `applyI18n()` li riempie; `setLang('en')` salva la scelta e riapplica.
//   • La lingua vive in localStorage ('libreCity.lang'): al primo avvio è null →
//     ui.js mostra la scelta della lingua prima del nome (vedi #langPanel).
//
// NB: questo file è nel bundle della sim headless (server/sim-runtime.js), dove
// non esistono né localStorage né document: ogni accesso è difeso.

const LANGS = ['it', 'en'];

// lingua salvata · altrimenti quella del browser (solo come default del selettore:
// finché l'utente non sceglie, `langChosen()` resta false e ui.js chiede)
function _storedLang() {
  try { const v = localStorage.getItem('libreCity.lang'); return v ? JSON.parse(v) : null; } catch { return null; }
}
function _browserLang() {
  try { return /^it/i.test(navigator.language || '') ? 'it' : 'en'; } catch { return 'it'; }
}
// `_langChosen` fotografa la scelta SALVATA: LANG ricade sulla lingua del browser
// per non mostrare mai una schermata senza testo, ma finché la scelta manca ui.js
// mostra #langPanel (vedi langChosen()).
const _langChosen = LANGS.includes(_storedLang());
let LANG = _langChosen ? _storedLang() : _browserLang();
function langChosen() { return _langChosen; }

function setLang(l) {
  if (!LANGS.includes(l)) return;
  LANG = l;
  try { localStorage.setItem('libreCity.lang', JSON.stringify(l)); } catch {}
  applyLangAttrs();
  applyI18n();
}

// `lang` del documento + manifest della lingua giusta (descrizione dell'app nel
// prompt d'installazione della PWA: manifest.webmanifest / manifest.en.webmanifest)
function applyLangAttrs() {
  try {
    document.documentElement.lang = LANG;
    const m = document.querySelector('link[rel="manifest"]');
    if (m) m.setAttribute('href', LANG === 'en' ? 'manifest.en.webmanifest' : 'manifest.webmanifest');
  } catch {}
}

// t('k', {a:1}) → stringa tradotta con i segnaposto sostituiti
function t(k, p) {
  const tbl = STR[LANG] || STR.it;
  let s = tbl[k];
  if (s === undefined) s = STR.it[k];
  if (s === undefined) return k;                       // chiave sconosciuta: la mostro, così salta all'occhio
  if (Array.isArray(s)) s = s[0];
  if (p) for (const key in p) s = s.split('{' + key + '}').join(p[key]);
  return s;
}
// lista di frasi (fumetti): sempre un array, anche se la chiave manca
function tList(k) {
  const tbl = STR[LANG] || STR.it;
  const s = tbl[k] !== undefined ? tbl[k] : STR.it[k];
  return Array.isArray(s) ? s : (s === undefined ? [k] : [s]);
}

// riempie il DOM statico marcato con data-i18n*
function applyI18n() {
  let root;
  try { root = document; if (!root || !root.querySelectorAll) return; } catch { return; }
  const set = (attr, fn) => {
    let els;
    try { els = root.querySelectorAll('[' + attr + ']'); } catch { return; }
    for (const el of els) fn(el, t(el.getAttribute(attr)));
  };
  set('data-i18n',       (el, s) => { el.textContent = s; });
  set('data-i18n-html',  (el, s) => { el.innerHTML = s; });
  set('data-i18n-ph',    (el, s) => { el.placeholder = s; });
  set('data-i18n-title', (el, s) => { el.title = s; });
  set('data-i18n-aria',  (el, s) => { el.setAttribute('aria-label', s); });
}

// formato data della classifica
function dateLocale() { return LANG === 'en' ? 'en-GB' : 'it-IT'; }

// testo di un evento di partita ({k, p, s}, vedi pushEvent in js/gameplay.js): il
// server manda chiavi, ogni client compone il messaggio nella PROPRIA lingua.
// Una stringa nuda (server di una build precedente) passa così com'è.
function evText(e) {
  if (typeof e === 'string') return e;
  if (!e || !e.k) return '';
  return t(e.k, e.p) + (e.s ? ' · ' + t(e.s) : '');
}

const STR = {
  // =======================================================================
  //  ITALIANO
  // =======================================================================
  it: {
    // ---- scelta della lingua ----
    'lang.title': '🌍 Lingua · Language',
    'lang.it': '🇮🇹 Italiano',
    'lang.en': '🇬🇧 English',
    'lang.label': 'Lingua del gioco',

    // ---- HUD ----
    'hud.wanted': '★ CERCATO ★',
    'hud.fists': '👊 Pugni',
    'hud.gear': '⚙️ {g}ª',
    'hud.gearR': '⚙️ R',
    'hud.miniTitle': 'Tocca per aprire la mappa a schermo intero',
    'hud.mapClose': 'Chiudi mappa',
    'hud.mapCloseTitle': 'Chiudi (Esc)',
    'hud.meters': '{d} m',

    // ---- guida comandi in basso a sinistra ----
    'hint.title': 'Mostra o nascondi la guida completa',
    'hint.short': '<b>WASD / frecce</b> muovi &amp; guida · <b>Mouse</b> mira · <b>Click sx</b> pugni/spari<br>' +
      '<b>E</b> sali/scendi · <b>Spazio</b> clacson/sirena 🚨 · <b>1-5</b> armi · <b>M</b> missioni',
    'hint.full': '<b>Tab</b> classifica della partita (in multigiocatore 🌐)<br>' +
      '👊 Parti a mani nude: 3 pugni stendono un passante<br>' +
      '🛒 Compra le armi all\'<b>ARMERIA</b> (pistola, mitra, fucile a pompa, lanciarazzi)<br>' +
      '🚕 Sali su un <b>taxi</b>: porta i clienti a destinazione e guadagna<br>' +
      '🍕 Sali sulla <b>moto delle consegne</b>: ritira il cibo in pizzeria e consegnalo<br>' +
      '🚑 Sali sull\'<b>ambulanza</b> (all\'ospedale): soccorri i feriti in città<br>' +
      '🚔 Sali sulla <b>volante</b> (alla centrale): ferma i ladri in fuga<br>' +
      '🚒 Sali sull\'<b>autopompa</b> (dai pompieri): spegni gli incendi — <b>mouse premuto</b> = idrante 💧<br>' +
      '🪖 La <b>CASERMA</b> è un\'area recintata: nel cortile ci sono <b>jeep</b> e <b>carri armati</b><br>' +
      '&nbsp;&nbsp;&nbsp;&nbsp;(razzi col mouse, schiacciano le auto!) — ma è piena di <b>soldati</b> che sparano a vista!<br>' +
      '🪙 Raccogli le monetine · 🏥 curati all\'ospedale ($25) · 🚦 occhio ai semafori<br>' +
      '🚨 Investi o spara ai passanti → arriva la polizia: gli agenti scendono, sparano<br>' +
      '&nbsp;&nbsp;&nbsp;&nbsp;e se ti fermano in auto ti <b>arrestano</b> (riparti dalla centrale!)',
    'hint.key': '<b>H</b> (o un clic qui) — guida completa',

    // ---- morte / arresto ----
    'big.dead': 'Ti hanno ucciso',
    'big.busted': 'Arrestato',

    // ---- pausa ----
    'pause.title': '⏸ Pausa',
    'pause.resume': '▶ Riprendi',
    'pause.save': '💾 Salva partita',
    'pause.saved': '✅ Partita salvata',
    'pause.saveFail': '⚠️ Salvataggio non riuscito',
    'pause.share': '📤 Invita un amico',
    'pause.quit': '🏁 Termina e salva il punteggio',

    // ---- fine partita ----
    'go.time': '⏱ Tempo scaduto!',
    'go.quit': '🏁 Partita terminata',
    'go.back': '↩ Torna al menu',
    'go.rank': '{name}, sei {rank}º in classifica! 🏆',
    'go.noRank': 'Peccato, niente top 10 stavolta…',
    'go.mpRank': '{name}, sei {rank}º su {tot} — 💀 {kills} · ☠️ {deaths}',

    // ---- classifica della partita (multigiocatore) ----
    'lad.title': '🏆 Classifica della partita',
    'lad.hint': 'Premi Tab (o tocca 🏆) per chiudere',
    'lad.name': 'Nome',
    'lad.points': '🏆 Punti',
    'lad.downs': '💀 Stesi',
    'lad.deaths': '☠️ Morti',
    'lad.bounty': '🎯 Taglia',

    // ---- schermata iniziale ----
    'start.tag': 'Corri · Consegna · Soccorri',
    'start.hiscore': 'HI-SCORE&nbsp; $0',
    'start.credits': 'CREDITI&nbsp;1',
    'start.credit': 'Realizzato da <a href="https://enricoschintu.com" target="_blank" rel="noopener">Enrico Schintu</a> · © 2026',
    'start.ticker': '🚕 PORTA I CLIENTI A DESTINAZIONE · 🍕 CONSEGNA LA PIZZA FINCHÉ È CALDA · 🚑 SOCCORRI I FERITI · 🚒 SPEGNI GLI INCENDI · 🪙 RACCOGLI LE MONETINE NEI VICOLI · 🚔 OCCHIO ALLE STELLE: LA POLIZIA NON DIMENTICA · 🪖 LA CASERMA È PIENA DI SOLDATI (E DI CARRI ARMATI) · 🚕 PORTA I CLIENTI A DESTINAZIONE · 🍕 CONSEGNA LA PIZZA FINCHÉ È CALDA · 🚑 SOCCORRI I FERITI · 🚒 SPEGNI GLI INCENDI · 🪙 RACCOGLI LE MONETINE NEI VICOLI',
    'hi.score': 'HI-SCORE  ${score} — {name}',

    // ---- primo avvio: nome ----
    'name.title': 'Come ti chiami?',
    'name.label': 'Nome del personaggio',
    'name.ph': 'Il tuo nome',
    'name.next': 'Avanti ➜',
    'name.required': 'Serve un nome!',

    // ---- menu principale ----
    'menu.hello': 'Ciao, <b id="menuName"></b>!',
    'menu.play': '▶ Giocatore singolo',
    'menu.load': '💾 Riprendi partita',
    'menu.mp': '🌐 Multigiocatore',
    'menu.settings': '⚙️ Impostazioni',
    'menu.scores': '🏆 Classifica',
    'menu.howto': '❓ Come si gioca',
    'menu.install': '📲 Installa l\'app',
    'menu.installed': 'App installata! 🎉',

    // ---- giocatore singolo ----
    'sp.title': '▶ Giocatore singolo',
    'sp.violence': 'Violenza',
    'sp.violenceOn': 'Sì — armi e scontri',
    'sp.violenceOff': 'No — nessuna arma, non si uccide',
    'sp.duration': 'Durata della partita',
    'sp.size': 'Dimensione della mappa',
    'sp.note': 'Col filtro violenza su <b>No</b> non ci sono armi: nessuno spara né viene ucciso ' +
      '(nemmeno gli NPC) e per le missioni in volante 🚔 basta <b>raggiungere il ladro in fuga</b>.',
    'sp.go': '🏙️ Inizia a giocare',
    'common.back': '↩ Indietro',
    'common.min': '{n} minuti',
    'common.noLimit': 'Senza limiti di tempo',
    'common.sizeS': 'Piccola',
    'common.sizeM': 'Media (area 2×)',
    'common.sizeL': 'Grande (area 4×)',
    'common.free': 'libera',
    'common.min_short': '{n} min',
    'dur.5': '5 minuti', 'dur.10': '10 minuti', 'dur.15': '15 minuti',
    'dur.30': '30 minuti', 'dur.60': '60 minuti',

    // ---- multigiocatore ----
    'mp.title': '🌐 Multigiocatore',
    'mp.note': 'Ospita una partita e condividi il link (con password facoltativa e numero massimo di ' +
      'giocatori), oppure entra nella stanza di un amico. In partita la <b>classifica</b> ' +
      '(stesi / morti / soldi) si apre con <b>Tab</b> o col pulsante 🏆.',
    'mp.host': '🏠 Crea una partita',
    'mp.join': '🔗 Entra con un codice',
    'mp.noServer': '🌐 Server multigiocatore non configurato',
    'mp.noMissions': '🌐 In multigiocatore non ci sono missioni — dai la caccia agli altri!',

    'host.title': '🏠 Crea una partita',
    'host.pass': 'Password (facoltativa)',
    'host.passPh': 'Nessuna password',
    'host.max': 'Numero massimo di giocatori',
    'host.p2': '2 giocatori', 'host.p3': '3 giocatori', 'host.p4': '4 giocatori',
    'host.p6': '6 giocatori', 'host.p8': '8 giocatori',
    'host.creating': 'Creazione della stanza…',
    'host.go': '🏙️ Crea la stanza',

    'queue.title': '⏳ Sala d\'attesa',
    'queue.why': 'Partite in corso: {rooms} su {max}, il massimo che il server regge bene. ' +
      'Sei in fila: la tua stanza si apre da sola appena una finisce.',
    'queue.posFmt': '{n}°',
    'queue.posLabel': 'posto in fila',
    'queue.etaNow': 'Tocca a te da un momento all\'altro',
    'queue.etaSec': 'Attesa stimata: circa {n} secondi',
    'queue.etaMin': 'Attesa stimata: circa {n} minuti',
    'queue.stay': '<b>Resta su questa schermata</b>: quando tocca a te la partita parte da sola, ' +
      'non devi rifare nulla.',
    'queue.joinNote': 'Nel frattempo puoi sempre entrare nella stanza di un amico: da lì non si passa dalla fila.',
    'queue.cancel': '↩ Rinuncia e torna indietro',

    'invite.title': '🎟️ Invita i tuoi amici',
    'invite.link': 'Link da condividere',
    'invite.share': '📤 Condividi link',
    'invite.copy': '📋 Copia link',
    'invite.copied': '✅ Copiato!',
    'invite.lobby': '👥 In stanza: <b id="lobbyCount">1 / 4</b>',
    'invite.note1': 'L\'amico apre il link, oppure sceglie «Entra con un codice» e digita il codice qui ' +
      'sopra. Si può entrare anche a partita già iniziata.',
    'invite.note2': '📱 <b>Torna subito qui dopo aver condiviso il link</b>: mentre il gioco è in ' +
      'un\'altra app la stanza non è raggiungibile, e ricompare appena riapri questa pagina.',
    'invite.play': '▶ Inizia a giocare',
    'invite.cancel': '↩ Annulla la partita',
    'invite.shareTitle': 'Libre City',
    'invite.shareText': 'Entra nella mia partita di Libre City! Codice stanza: {code}',

    'join.title': '🔗 Entra in partita',
    'join.name': 'Il tuo nome',
    'join.code': 'Codice stanza',
    'join.codePh': 'es. MK7PF2',
    'join.pass': 'Password (se richiesta)',
    'join.go': '➜ Entra',
    'join.badCode': 'Codice non valido (es. K7PF2M)',
    'join.connecting': 'Connessione…',

    // ---- impostazioni ----
    'set.title': '⚙️ Impostazioni',
    'set.audio': 'Audio',
    'set.audioOn': '🔊 Attivo',
    'set.audioOff': '🔇 Disattivato',
    'set.save': '💾 Salva',

    // ---- classifica locale ----
    'scores.title': '🏆 Classifica',
    'scores.name': 'Nome',
    'scores.score': 'Punteggio',
    'scores.duration': 'Durata',
    'scores.date': 'Data',
    'scores.empty': 'Nessuna partita giocata — la classifica ti aspetta!',

    // ---- come si gioca ----
    'howto.desc': 'Esplora una grande città con <b>quartieri diversi</b> — case, uffici, fabbriche — e strutture ' +
      'come <b>ospedali 🏥</b> (dove curarti), <b>centrali di polizia 🚔</b>, caserme dei pompieri, banche e ' +
      'mercati. <b>Ruba qualsiasi auto</b>, sfreccia nel traffico e raccogli le <b>monetine 🪙</b> nascoste nei ' +
      '<b>vicoli</b>. Sali su un <b>taxi 🚕</b> per fare il tassista: carica i clienti e portali a destinazione ' +
      'seguendo la <b>freccia</b> — più la corsa è lunga (e veloce!), più guadagni. Oppure salta su una ' +
      '<b>moto delle consegne 🏍️</b>: ritira il cibo alla <b>pizzeria 🍕</b> e portalo ai clienti affamati ' +
      'finché è caldo — consegna in fretta e prendi la mancia! Davanti a ogni struttura trovi i suoi ' +
      '<b>mezzi parcheggiati</b>: prendi l\'<b>ambulanza 🚑</b> all\'ospedale per soccorrere i feriti, la ' +
      '<b>volante 🚔</b> alla centrale per inseguire i <b>rapinatori</b> di banche e mercati, o ' +
      'l\'<b>autopompa 🚒</b> dei pompieri per spegnere gli <b>incendi</b> sparando acqua con l\'idrante — e con ' +
      '<b>Spazio</b> accendi la sirena! La <b>caserma dell\'esercito 🪖</b> è un\'<b>area recintata</b>: oltre il ' +
      'cancello, nel cortile, trovi <b>jeep militari</b> e il <b>carro armato</b> — spara <b>razzi</b> ' +
      '(ricarica lenta!) e passa sopra le altre auto schiacciandole. Ma la base è presidiata da <b>tanti ' +
      'soldati</b>: appena entri nella zona militare ti sparano a vista, e le <b>jeep armate</b> ti danno la ' +
      'caccia! Parti <b>a mani nude</b>: i <b>pugni 👊</b> feriscono i passanti e al <b>terzo colpo</b> li ' +
      'stendono. Coi soldi guadagnati passa all\'<b>ARMERIA 🔫</b>: la <b>pistola</b> costa pochi dollari, poi ' +
      'arrivano <b>mitra, fucile a pompa e lanciarazzi</b>. Ma attento: se investi, picchi o spari la gente, la ' +
      '<b>polizia</b> ti darà la caccia — più stelle ⭐ hai, più diventano cattivi!',
    'howto.kb1': '<b>WASD</b> / frecce', 'howto.kb1v': 'muovere / guidare',
    'howto.kb2': '<b>Mouse</b>', 'howto.kb2v': 'mirare',
    'howto.kb3': '<b>Click sinistro</b>', 'howto.kb3v': 'pugni / sparare (a piedi)',
    'howto.kb4': '<b>E</b>', 'howto.kb4v': 'salire / scendere dall\'auto',
    'howto.kb5': '<b>Spazio</b>', 'howto.kb5v': 'clacson / sirena 🚨',
    'howto.kb6': '<b>M</b>', 'howto.kb6v': 'missioni on / off',
    'howto.kb7': '<b>1-5</b>', 'howto.kb7v': 'cambiare / comprare arma',
    'howto.t1': '<b>🕹️ Stick sinistro</b>', 'howto.t1v': 'muovere / guidare',
    'howto.t2': '<b>🎯 Stick destro</b>', 'howto.t2v': 'mirare — spingi a fondo per sparare',
    'howto.t3': '<b>🚗</b>', 'howto.t3v': 'salire / scendere dal mezzo',
    'howto.t4': '<b>📣</b>', 'howto.t4v': 'clacson / sirena 🚨',
    'howto.t5': '<b>📋</b>', 'howto.t5v': 'missioni on / off',
    'howto.t6': '<b>Icone in alto</b>', 'howto.t6v': 'cambiare / comprare arma',
    'howto.volume': '🔊 Alza il volume per motori, spari e sirene!',

    // ---- armi ----
    'weapon.fists': 'Pugni',
    'weapon.pistol': 'Pistola',
    'weapon.smg': 'Mitra',
    'weapon.shotgun': 'Fucile a pompa',
    'weapon.grenade': 'Granate',
    'weapon.flamer': 'Lanciafiamma',
    'weapon.rocket': 'Lanciarazzi',

    // ---- armeria ----
    'shop.titleTouch': '🛒 ARMERIA — tocca l\'icona dell\'arma in alto per comprare',
    'shop.titleKb': '🛒 ARMERIA — premi il numero per comprare o equipaggiare',
    'shop.inUse': 'in uso ✔',
    'shop.owned': 'tua',
    'shop.equipped': '{icon} {name} equipaggiata',
    'shop.bought': '🛒 {name} acquistata! (−${price})',
    'shop.tooPoor': '💸 Ti servono ${price} per {name}',
    'shop.locked': '🔒 {name} si compra all\'ARMERIA',

    // ---- etichette in mappa ----
    'lm.hospital': '✚ OSPEDALE',
    'lm.police': 'POLIZIA',
    'lm.fire': 'POMPIERI',
    'lm.bank': 'BANCA',
    'lm.pizza': '🍕 PIZZERIA',
    'lm.gunshop': '🔫 ARMERIA',
    'lm.army': '🪖 CASERMA · ZONA MILITARE',
    'lm.market': 'MERCATO',
    'lm.taxi': 'TAXI',

    // ---- ospedale ----
    'heal.done': '🏥 Curato! (−$25)',
    'heal.need': '🏥 Ti servono $25 per farti curare',

    // ---- ricercato ----
    'wanted.level': '⭐ Livello ricercato: {n}',

    // ---- missioni: taxi ----
    'taxi.new': '🚕 Un cliente ti sta aspettando — segui la freccia!',
    'taxi.aboard': '🧳 Cliente a bordo! Portalo a destinazione',
    'taxi.doneTip': '💰 Corsa completata! +${pay} · mancia +${tip} ⏱️',
    'taxi.done': '💰 Corsa completata! +${pay}',
    'taxi.cancel': '🚕 Corsa annullata',
    'taxi.lost': '😵 Il cliente è rimasto a terra… corsa annullata',
    'taxi.abandon': '🚕 Corsa annullata — hai abbandonato il cliente',
    'taxi.boxTip': '🚕 ${pay} · mancia se arrivi entro {s}s',
    'taxi.boxNoTip': '🚕 ${pay} · mancia persa',
    'taxi.enter': '🚕 Sei salito su un TAXI — carica i clienti e portali a destinazione!',

    // ---- missioni: pizza ----
    'pizza.new': '🍕 Nuovo ordine! Ritira il cibo alla PIZZERIA — segui la freccia',
    'pizza.aboard': '🛵 Ordine nel bauletto! Consegnalo finché è caldo',
    'pizza.doneTip': '💰 Consegnata calda! +${pay} · mancia +${tip} 🔥',
    'pizza.done': '💰 Pizza consegnata! +${pay}',
    'pizza.cancel': '🍕 Consegna annullata',
    'pizza.lost': '😵 Il cliente è rimasto a terra… consegna annullata',
    'pizza.abandon': '🍕 Consegna annullata — il cliente resta a bocca asciutta',
    'pizza.boxTip': '🍕 ${pay} · mancia se consegni entro {s}s',
    'pizza.boxNoTip': '🍕 ${pay} · pizza fredda, niente mancia',
    'pizza.enter': '🍕 Sei salito sulla moto delle consegne — ritira il cibo e portalo ai clienti!',

    // ---- missioni: ambulanza ----
    'rescue.new': '🚑 Emergenza! Un ferito ha bisogno di te — segui la freccia',
    'rescue.aboard': '🩹 Ferito a bordo! Corri all\'OSPEDALE',
    'rescue.doneTip': '💰 Paziente salvo! +${pay} · bonus soccorso +${tip} ⏱️',
    'rescue.done': '💰 Paziente consegnato! +${pay}',
    'rescue.cancel': '🚑 Soccorso annullato',
    'rescue.lost': '😵 Il ferito è stato travolto… soccorso annullato',
    'rescue.abandon': '🚑 Soccorso annullato — il ferito aspetta ancora aiuto',
    'rescue.boxTip': '🚑 ${pay} · bonus se arrivi entro {s}s',
    'rescue.boxNoTip': '🚑 ${pay} · bonus soccorso perso',
    'rescue.enter': '🚑 Sei salito sull\'AMBULANZA — soccorri i feriti e portali in ospedale!',

    // ---- missioni: volante ----
    'patrol.bank': '🚨 Rapina in BANCA! Ferma il ladro in fuga',
    'patrol.market': '🚨 Furto al MERCATO! Ferma il ladro in fuga',
    'patrol.street': '🚨 Scippo in strada! Ferma il ladro in fuga',
    'patrol.downBonus': '🚔 Ladro steso e refurtiva recuperata! +${pay} · bonus +${bonus} ⏱️',
    'patrol.down': '🚔 Ladro steso e refurtiva recuperata! +${pay}',
    'patrol.arrestBonus': '🚔 Ladro arrestato! +${pay} · bonus +${bonus} ⏱️',
    'patrol.arrest': '🚔 Ladro arrestato! +${pay}',
    'patrol.cancel': '🚔 Pattuglia interrotta',
    'patrol.escaped': '💨 Il ladro è riuscito a fuggire…',
    'patrol.abandon': '🚔 Inseguimento annullato — il ladro se l\'è svignata',
    'patrol.box': '🚔 ${pay} · fermalo entro {s}s!',
    'patrol.enter': '🚔 Sei salito sulla VOLANTE — rispondi alle chiamate e ferma i criminali!',

    // ---- missioni: pompieri ----
    'fire.new': '🔥 INCENDIO in città! Corri sul posto e spegnilo con l\'idrante',
    'fire.doneBonus': '💧 Incendio spento! +${pay} · bonus rapidità +${bonus} ⏱️',
    'fire.done': '💧 Incendio spento! +${pay}',
    'fire.cancel': '🚒 Intervento annullato',
    'fire.late': '🔥 Troppo tardi… ha dovuto pensarci un\'altra caserma',
    'fire.abandon': '🚒 Intervento annullato — l\'incendio si è spento da solo',
    'fire.out': '💦 Fiamme spente!',
    'fire.box': '🚒 ${pay} · spegni l\'incendio entro {s}s!',
    'fire.enterTouch': '🚒 Sei salito sull\'AUTOPOMPA — spingi lo stick destro per l\'idrante!',
    'fire.enterKb': '🚒 Sei salito sull\'AUTOPOMPA — tieni premuto il mouse per l\'idrante!',

    // ---- veicoli ----
    'veh.out': '🚶 Sei sceso',
    'veh.tankTouch': '🪖 Sei salito sul CARRO ARMATO — stick destro: razzi · passa sopra le auto!',
    'veh.tankKb': '🪖 Sei salito sul CARRO ARMATO — mouse: razzi · passa sopra le auto!',
    'veh.jeep': '🪖 Sei salito sulla jeep militare — l\'esercito non gradisce…',
    'veh.bikeTouch': '🏍️ Sei salito in moto — stick sinistro per guidare, 🚗 per scendere',
    'veh.carTouch': '🚗 Sei salito in auto — stick sinistro per guidare, 🚗 per scendere',
    'veh.bikeKb': '🏍️ Sei salito in moto — WASD guida, E scendi',
    'veh.carKb': '🚗 Sei salito in auto — WASD guida, E scendi',
    'veh.burning': '🔥 La macchina è in fiamme! Scendi prima che esploda!',
    'veh.sirenOn': '🚨 Sirena accesa',
    'veh.sirenOff': '🔇 Sirena spenta',

    // ---- missioni on/off ----
    'miss.offTouch': '🚫 Missioni disattivate — tocca 📋 per riattivarle',
    'miss.offKb': '🚫 Missioni disattivate — premi M per riattivarle',
    'miss.on': '✅ Missioni riattivate!',

    // ---- crimini (livello ricercato) ----
    'crime.punchCop': '🚨 Hai steso un poliziotto a pugni!',
    'crime.punchPed': '🚨 Hai steso un passante a pugni!',
    'crime.hitCop': '🚨 Hai colpito un poliziotto!',
    'crime.runCop': '🚨 Hai investito un poliziotto!',
    'crime.runPed': '🚨 Hai investito un passante!',
    'crime.shootCop': '🚨 Hai sparato a un poliziotto!',
    'crime.shootPed': '🚨 Hai sparato a un passante!',
    'crime.bombCop': '🚨 Hai bombardato un poliziotto!',
    'crime.bombPed': '🚨 Hai bombardato un passante!',
    'crime.crushPolice': '🚨 Hai schiacciato una volante!',
    'crime.crushCar': '🚨 Hai schiacciato un\'auto!',
    'army.alarm': '🪖 ZONA MILITARE! Hai fatto scattare l\'allarme — scappa!',

    // ---- respawn ----
    'respawn.busted': '👮 Rilasciato dalla centrale — comportati bene!',
    'respawn.dead': '🏥 Rimesso in sesto dall\'ospedale',

    // ---- partita ----
    'game.welcome': 'Benvenuto a Libre City, {name}! 🏙️  {hint}{mp}',
    'game.welcomeBack': 'Bentornato a Libre City, {name}! 🏙️ Partita ripresa.',
    'game.hintTouch': 'Avvicinati a un\'auto e tocca 🚗',
    'game.hintKb': 'Ruba un\'auto con E',
    'game.mpLadderTouch': ' · 🏆 per la classifica',
    'game.mpLadderKb': ' · Tab per la classifica',
    'game.saved': '💾 Partita salvata',
    'game.noSave': 'Nessuna partita salvata',

    // ---- rete ----
    'net.retry': '🔌 Connessione al server… riprovo',
    'net.lost': '🌐 Connessione persa, riaggancio…',
    'net.back': '🌐 Riconnesso alla partita',
    'net.update': '🔄 Nuova versione disponibile — tocca per aggiornare',
    'net.joined': '🌐 {name} è entrato in partita!',
    'net.left': '🌐 {name} ha lasciato la partita',
    'net.badge': '🌐 <b>{code}</b> · {n} giocatore',
    'net.badgeN': '🌐 <b>{code}</b> · {n} giocatori',
    'net.bounty': '🎯 Taglia: ${n}',
    'net.err.offline': 'Impossibile raggiungere il server — controlla la connessione',
    'net.err.noserver': 'Server multigiocatore non configurato',
    'net.err.pass': 'Password sbagliata',
    'net.err.full': 'La partita è al completo',
    'net.err.notfound': 'Partita non trovata — controlla il codice stanza',
    'net.err.exists': 'Esiste già una partita con questo codice: ricarica la pagina',
    'net.err.badcode': 'Codice stanza non valido',
    'net.err.timeout': 'Nessuna risposta dal server — riprova tra poco',
    'net.err.qfull': 'Anche la sala d\'attesa è piena — riprova tra qualche minuto',
    'net.err.other': 'Errore di rete: {err}',

    // ---- PvP ----
    'pvp.killed': '💀 Hai steso {name}!',
    'pvp.killedBounty': '💀 Hai steso {name}! Taglia +${bounty}',
    'pvp.down': '☠️ {name} ti ha steso!',
    'pvp.onYou': '🎯 Taglia su di te: ${n} — sei un bersaglio!',
    'pvp.killedCash': '💀 Hai steso {name}! (+$25)',
    'pvp.rival': 'un rivale',
    'streak.2': 'Doppia uccisione!',
    'streak.3': 'Tripla uccisione!',
    'streak.4': 'Quadrupla!',
    'streak.5': 'Scatenato!',
    'streak.7': 'Inarrestabile!',
    'streak.10': 'LEGGENDARIO!',

    // ---- fumetti dei pedoni ----
    'say.greet': ['Ciao {name}!', 'Ehi, ciao!', 'Bella giornata, eh?', 'Buongiorno!', 'Che traffico oggi…', 'Salve!', 'Hai visto che città?'],
    'say.wanted': ['È lui il ricercato!', 'Aiuto, un criminale!', 'Chiamate la polizia!', 'La polizia ti cerca!', 'Scappate, è lui!', 'Eccolo! È qui!'],
    'say.panic': ['AAAH!', 'Attento!', 'È impazzito!', 'Aiutooo!', 'Via! Via!', 'Al pazzo!'],
    'say.cop': ['FERMO!', 'Mani in alto!', 'Fermati, {name}!', 'In nome della legge!', 'Non scappare!', 'Ti abbiamo trovato!'],
    'say.fare': ['TAXI! Sono qui!', 'Mi porti in centro?', 'Ho fretta!', 'Finalmente, il taxi!'],
    'say.hungry': ['Che fame!', 'La mia pizza?', 'Muoio di fame!', 'Sbrigati, si fredda!'],
    'say.injured': ['AIUTO!', 'Mi fa male tutto…', 'Un\'ambulanza, presto!', 'Non mi sento bene…'],
    'say.robber': ['Non mi prenderai mai!', 'Ah ah, addio!', 'Più veloce, sbirro!', 'Il malloppo è mio!'],
    'say.carjack': ['Al ladro! Al ladro!', 'Torna qui subito!', 'Ti ho visto, sai?!', 'Che maleducato!', 'Chiamo la polizia!', 'Fermati, brigante!', 'La mia assicurazione!'],
    'say.army': ['Zona militare!', 'Intruso! Fuoco!', 'Fermo dove sei!', 'Allarme! Allarme!', 'Difendete la base!', 'Non è un\'esercitazione!'],
    'say.stolenPolice': ['Ehi! La volante!'],
    'say.stolenBike': ['Ehi! La mia moto!'],
    'say.stolenCar': ['Ehi! La mia auto!'],
  },

  // =======================================================================
  //  ENGLISH
  // =======================================================================
  en: {
    'lang.title': '🌍 Language · Lingua',
    'lang.it': '🇮🇹 Italiano',
    'lang.en': '🇬🇧 English',
    'lang.label': 'Game language',

    'hud.wanted': '★ WANTED ★',
    'hud.fists': '👊 Fists',
    'hud.gear': '⚙️ {g}',
    'hud.gearR': '⚙️ R',
    'hud.miniTitle': 'Tap to open the full-screen map',
    'hud.mapClose': 'Close map',
    'hud.mapCloseTitle': 'Close (Esc)',
    'hud.meters': '{d} m',

    'hint.title': 'Show or hide the full guide',
    'hint.short': '<b>WASD / arrows</b> move &amp; drive · <b>Mouse</b> aim · <b>Left click</b> punch/shoot<br>' +
      '<b>E</b> enter/exit · <b>Space</b> horn/siren 🚨 · <b>1-5</b> weapons · <b>M</b> missions',
    'hint.full': '<b>Tab</b> match scoreboard (in multiplayer 🌐)<br>' +
      '👊 You start bare-handed: 3 punches knock a pedestrian down<br>' +
      '🛒 Buy weapons at the <b>GUN SHOP</b> (pistol, SMG, shotgun, rocket launcher)<br>' +
      '🚕 Hop in a <b>taxi</b>: drive fares to their destination and earn<br>' +
      '🍕 Hop on the <b>delivery bike</b>: pick the food up at the pizzeria and deliver it<br>' +
      '🚑 Take the <b>ambulance</b> (at the hospital): rescue the injured around town<br>' +
      '🚔 Take the <b>patrol car</b> (at the station): stop the fleeing thieves<br>' +
      '🚒 Take the <b>fire engine</b> (at the fire station): put fires out — <b>hold the mouse</b> = hose 💧<br>' +
      '🪖 The <b>BARRACKS</b> is a fenced compound: the yard holds <b>jeeps</b> and <b>tanks</b><br>' +
      '&nbsp;&nbsp;&nbsp;&nbsp;(rockets with the mouse, they crush cars!) — but it is full of <b>soldiers</b> shooting on sight!<br>' +
      '🪙 Collect the coins · 🏥 heal up at the hospital ($25) · 🚦 mind the traffic lights<br>' +
      '🚨 Run over or shoot pedestrians → the police come: officers get out and shoot,<br>' +
      '&nbsp;&nbsp;&nbsp;&nbsp;and if they stop your car they <b>bust</b> you (you restart at the station!)',
    'hint.key': '<b>H</b> (or a click here) — full guide',

    'big.dead': 'You were killed',
    'big.busted': 'Busted',

    'pause.title': '⏸ Paused',
    'pause.resume': '▶ Resume',
    'pause.save': '💾 Save game',
    'pause.saved': '✅ Game saved',
    'pause.saveFail': '⚠️ Save failed',
    'pause.share': '📤 Invite a friend',
    'pause.quit': '🏁 End and save the score',

    'go.time': '⏱ Time\'s up!',
    'go.quit': '🏁 Game over',
    'go.back': '↩ Back to menu',
    'go.rank': '{name}, you are #{rank} on the leaderboard! 🏆',
    'go.noRank': 'Too bad, no top 10 this time…',
    'go.mpRank': '{name}, you are #{rank} of {tot} — 💀 {kills} · ☠️ {deaths}',

    'lad.title': '🏆 Match scoreboard',
    'lad.hint': 'Press Tab (or tap 🏆) to close',
    'lad.name': 'Name',
    'lad.points': '🏆 Points',
    'lad.downs': '💀 Downs',
    'lad.deaths': '☠️ Deaths',
    'lad.bounty': '🎯 Bounty',

    'start.tag': 'Drive · Deliver · Rescue',
    'start.hiscore': 'HI-SCORE&nbsp; $0',
    'start.credits': 'CREDITS&nbsp;1',
    'start.credit': 'Made by <a href="https://enricoschintu.com" target="_blank" rel="noopener">Enrico Schintu</a> · © 2026',
    'start.ticker': '🚕 DRIVE YOUR FARES HOME · 🍕 DELIVER THE PIZZA WHILE IT IS HOT · 🚑 RESCUE THE INJURED · 🚒 PUT THE FIRES OUT · 🪙 COLLECT THE COINS IN THE ALLEYS · 🚔 WATCH THE STARS: THE POLICE NEVER FORGET · 🪖 THE BARRACKS IS FULL OF SOLDIERS (AND TANKS) · 🚕 DRIVE YOUR FARES HOME · 🍕 DELIVER THE PIZZA WHILE IT IS HOT · 🚑 RESCUE THE INJURED · 🚒 PUT THE FIRES OUT · 🪙 COLLECT THE COINS IN THE ALLEYS',
    'hi.score': 'HI-SCORE  ${score} — {name}',

    'name.title': 'What\'s your name?',
    'name.label': 'Character name',
    'name.ph': 'Your name',
    'name.next': 'Next ➜',
    'name.required': 'A name is required!',

    'menu.hello': 'Hi, <b id="menuName"></b>!',
    'menu.play': '▶ Single player',
    'menu.load': '💾 Resume game',
    'menu.mp': '🌐 Multiplayer',
    'menu.settings': '⚙️ Settings',
    'menu.scores': '🏆 Leaderboard',
    'menu.howto': '❓ How to play',
    'menu.install': '📲 Install the app',
    'menu.installed': 'App installed! 🎉',

    'sp.title': '▶ Single player',
    'sp.violence': 'Violence',
    'sp.violenceOn': 'Yes — weapons and fights',
    'sp.violenceOff': 'No — no weapons, nobody is killed',
    'sp.duration': 'Match length',
    'sp.size': 'Map size',
    'sp.note': 'With the violence filter set to <b>No</b> there are no weapons: nobody shoots and nobody is ' +
      'killed (not even the NPCs), and patrol car 🚔 missions only ask you to <b>catch up with the fleeing thief</b>.',
    'sp.go': '🏙️ Start playing',
    'common.back': '↩ Back',
    'common.min': '{n} minutes',
    'common.noLimit': 'No time limit',
    'common.sizeS': 'Small',
    'common.sizeM': 'Medium (2× area)',
    'common.sizeL': 'Large (4× area)',
    'common.free': 'free',
    'common.min_short': '{n} min',
    'dur.5': '5 minutes', 'dur.10': '10 minutes', 'dur.15': '15 minutes',
    'dur.30': '30 minutes', 'dur.60': '60 minutes',

    'mp.title': '🌐 Multiplayer',
    'mp.note': 'Host a game and share the link (with an optional password and a maximum number of players), ' +
      'or join a friend\'s room. In game the <b>scoreboard</b> (downs / deaths / cash) opens with <b>Tab</b> ' +
      'or the 🏆 button.',
    'mp.host': '🏠 Create a game',
    'mp.join': '🔗 Join with a code',
    'mp.noServer': '🌐 Multiplayer server not configured',
    'mp.noMissions': '🌐 No missions in multiplayer — hunt the other players instead!',

    'host.title': '🏠 Create a game',
    'host.pass': 'Password (optional)',
    'host.passPh': 'No password',
    'host.max': 'Maximum number of players',
    'host.p2': '2 players', 'host.p3': '3 players', 'host.p4': '4 players',
    'host.p6': '6 players', 'host.p8': '8 players',
    'host.creating': 'Creating the room…',
    'host.go': '🏙️ Create the room',

    'queue.title': '⏳ Waiting room',
    'queue.why': 'Matches running: {rooms} of {max}, as many as the server handles well. ' +
      'You are in line: your room opens by itself as soon as one finishes.',
    'queue.posFmt': '#{n}',
    'queue.posLabel': 'place in line',
    'queue.etaNow': 'Your turn is about to come',
    'queue.etaSec': 'Estimated wait: about {n} seconds',
    'queue.etaMin': 'Estimated wait: about {n} minutes',
    'queue.stay': '<b>Stay on this screen</b>: when your turn comes the match starts by itself, ' +
      'you do not have to do anything again.',
    'queue.joinNote': 'Meanwhile you can always join a friend\'s room: that never goes through the line.',
    'queue.cancel': '↩ Give up and go back',

    'invite.title': '🎟️ Invite your friends',
    'invite.link': 'Link to share',
    'invite.share': '📤 Share link',
    'invite.copy': '📋 Copy link',
    'invite.copied': '✅ Copied!',
    'invite.lobby': '👥 In the room: <b id="lobbyCount">1 / 4</b>',
    'invite.note1': 'Your friend opens the link, or picks “Join with a code” and types the code above. ' +
      'Joining a match already in progress works too.',
    'invite.note2': '📱 <b>Come straight back here after sharing the link</b>: while the game sits in another ' +
      'app the room is unreachable, and it comes back as soon as you reopen this page.',
    'invite.play': '▶ Start playing',
    'invite.cancel': '↩ Cancel the game',
    'invite.shareTitle': 'Libre City',
    'invite.shareText': 'Join my Libre City game! Room code: {code}',

    'join.title': '🔗 Join a game',
    'join.name': 'Your name',
    'join.code': 'Room code',
    'join.codePh': 'e.g. MK7PF2',
    'join.pass': 'Password (if required)',
    'join.go': '➜ Join',
    'join.badCode': 'Invalid code (e.g. K7PF2M)',
    'join.connecting': 'Connecting…',

    'set.title': '⚙️ Settings',
    'set.audio': 'Audio',
    'set.audioOn': '🔊 On',
    'set.audioOff': '🔇 Off',
    'set.save': '💾 Save',

    'scores.title': '🏆 Leaderboard',
    'scores.name': 'Name',
    'scores.score': 'Score',
    'scores.duration': 'Length',
    'scores.date': 'Date',
    'scores.empty': 'No games played yet — the leaderboard is waiting for you!',

    'howto.desc': 'Explore a big city with <b>different districts</b> — houses, offices, factories — and ' +
      'landmarks such as <b>hospitals 🏥</b> (where you heal), <b>police stations 🚔</b>, fire stations, banks ' +
      'and markets. <b>Steal any car</b>, race through the traffic and collect the <b>coins 🪙</b> hidden in the ' +
      '<b>alleys</b>. Hop in a <b>taxi 🚕</b> and work as a cabbie: pick fares up and take them to their ' +
      'destination following the <b>arrow</b> — the longer (and faster!) the ride, the more you earn. Or jump on ' +
      'a <b>delivery bike 🏍️</b>: collect the food at the <b>pizzeria 🍕</b> and bring it to hungry customers ' +
      'while it is still hot — deliver fast and get the tip! In front of every landmark you find its ' +
      '<b>parked vehicles</b>: take the <b>ambulance 🚑</b> at the hospital to rescue the injured, the ' +
      '<b>patrol car 🚔</b> at the station to chase bank and market <b>robbers</b>, or the fire brigade\'s ' +
      '<b>fire engine 🚒</b> to put <b>fires</b> out by spraying water with the hose — and press <b>Space</b> ' +
      'for the siren! The <b>army barracks 🪖</b> is a <b>fenced compound</b>: past the gate, in the yard, you ' +
      'find <b>military jeeps</b> and the <b>tank</b> — fire <b>rockets</b> (slow reload!) and drive over other ' +
      'cars, crushing them. But the base is guarded by <b>plenty of soldiers</b>: the moment you enter the ' +
      'military zone they shoot on sight, and the <b>armed jeeps</b> hunt you down! You start ' +
      '<b>bare-handed</b>: <b>punches 👊</b> hurt pedestrians and the <b>third hit</b> knocks them out. With the ' +
      'money you earn head to the <b>GUN SHOP 🔫</b>: the <b>pistol</b> costs a few dollars, then come the ' +
      '<b>SMG, shotgun and rocket launcher</b>. But watch out: run people over, beat them up or shoot them and ' +
      'the <b>police</b> will hunt you — the more stars ⭐ you have, the nastier they get!',
    'howto.kb1': '<b>WASD</b> / arrows', 'howto.kb1v': 'move / drive',
    'howto.kb2': '<b>Mouse</b>', 'howto.kb2v': 'aim',
    'howto.kb3': '<b>Left click</b>', 'howto.kb3v': 'punch / shoot (on foot)',
    'howto.kb4': '<b>E</b>', 'howto.kb4v': 'enter / exit the car',
    'howto.kb5': '<b>Space</b>', 'howto.kb5v': 'horn / siren 🚨',
    'howto.kb6': '<b>M</b>', 'howto.kb6v': 'missions on / off',
    'howto.kb7': '<b>1-5</b>', 'howto.kb7v': 'switch / buy weapon',
    'howto.t1': '<b>🕹️ Left stick</b>', 'howto.t1v': 'move / drive',
    'howto.t2': '<b>🎯 Right stick</b>', 'howto.t2v': 'aim — push all the way to shoot',
    'howto.t3': '<b>🚗</b>', 'howto.t3v': 'enter / exit the vehicle',
    'howto.t4': '<b>📣</b>', 'howto.t4v': 'horn / siren 🚨',
    'howto.t5': '<b>📋</b>', 'howto.t5v': 'missions on / off',
    'howto.t6': '<b>Icons on top</b>', 'howto.t6v': 'switch / buy weapon',
    'howto.volume': '🔊 Turn the volume up for engines, gunshots and sirens!',

    'weapon.fists': 'Fists',
    'weapon.pistol': 'Pistol',
    'weapon.smg': 'SMG',
    'weapon.shotgun': 'Shotgun',
    'weapon.grenade': 'Grenades',
    'weapon.flamer': 'Flamethrower',
    'weapon.rocket': 'Rocket launcher',

    'shop.titleTouch': '🛒 GUN SHOP — tap the weapon icon on top to buy',
    'shop.titleKb': '🛒 GUN SHOP — press the number to buy or equip',
    'shop.inUse': 'in use ✔',
    'shop.owned': 'yours',
    'shop.equipped': '{icon} {name} equipped',
    'shop.bought': '🛒 {name} bought! (−${price})',
    'shop.tooPoor': '💸 You need ${price} for the {name}',
    'shop.locked': '🔒 The {name} is sold at the GUN SHOP',

    'lm.hospital': '✚ HOSPITAL',
    'lm.police': 'POLICE',
    'lm.fire': 'FIRE DEPT',
    'lm.bank': 'BANK',
    'lm.pizza': '🍕 PIZZERIA',
    'lm.gunshop': '🔫 GUN SHOP',
    'lm.army': '🪖 BARRACKS · MILITARY ZONE',
    'lm.market': 'MARKET',
    'lm.taxi': 'TAXI',

    'heal.done': '🏥 Healed! (−$25)',
    'heal.need': '🏥 You need $25 to get treated',

    'wanted.level': '⭐ Wanted level: {n}',

    'taxi.new': '🚕 A fare is waiting for you — follow the arrow!',
    'taxi.aboard': '🧳 Fare aboard! Take them to the destination',
    'taxi.doneTip': '💰 Ride completed! +${pay} · tip +${tip} ⏱️',
    'taxi.done': '💰 Ride completed! +${pay}',
    'taxi.cancel': '🚕 Ride cancelled',
    'taxi.lost': '😵 The fare was knocked out… ride cancelled',
    'taxi.abandon': '🚕 Ride cancelled — you left your fare behind',
    'taxi.boxTip': '🚕 ${pay} · tip if you arrive within {s}s',
    'taxi.boxNoTip': '🚕 ${pay} · tip lost',
    'taxi.enter': '🚕 You got into a TAXI — pick fares up and drive them home!',

    'pizza.new': '🍕 New order! Pick the food up at the PIZZERIA — follow the arrow',
    'pizza.aboard': '🛵 Order in the box! Deliver it while it is hot',
    'pizza.doneTip': '💰 Delivered hot! +${pay} · tip +${tip} 🔥',
    'pizza.done': '💰 Pizza delivered! +${pay}',
    'pizza.cancel': '🍕 Delivery cancelled',
    'pizza.lost': '😵 The customer was knocked out… delivery cancelled',
    'pizza.abandon': '🍕 Delivery cancelled — the customer stays hungry',
    'pizza.boxTip': '🍕 ${pay} · tip if you deliver within {s}s',
    'pizza.boxNoTip': '🍕 ${pay} · cold pizza, no tip',
    'pizza.enter': '🍕 You got on the delivery bike — pick the food up and bring it to the customers!',

    'rescue.new': '🚑 Emergency! An injured person needs you — follow the arrow',
    'rescue.aboard': '🩹 Patient aboard! Rush to the HOSPITAL',
    'rescue.doneTip': '💰 Patient saved! +${pay} · rescue bonus +${tip} ⏱️',
    'rescue.done': '💰 Patient delivered! +${pay}',
    'rescue.cancel': '🚑 Rescue cancelled',
    'rescue.lost': '😵 The injured person was run over… rescue cancelled',
    'rescue.abandon': '🚑 Rescue cancelled — the injured person is still waiting',
    'rescue.boxTip': '🚑 ${pay} · bonus if you arrive within {s}s',
    'rescue.boxNoTip': '🚑 ${pay} · rescue bonus lost',
    'rescue.enter': '🚑 You got into the AMBULANCE — rescue the injured and take them to the hospital!',

    'patrol.bank': '🚨 BANK robbery! Stop the fleeing thief',
    'patrol.market': '🚨 MARKET theft! Stop the fleeing thief',
    'patrol.street': '🚨 Street mugging! Stop the fleeing thief',
    'patrol.downBonus': '🚔 Thief down and loot recovered! +${pay} · bonus +${bonus} ⏱️',
    'patrol.down': '🚔 Thief down and loot recovered! +${pay}',
    'patrol.arrestBonus': '🚔 Thief arrested! +${pay} · bonus +${bonus} ⏱️',
    'patrol.arrest': '🚔 Thief arrested! +${pay}',
    'patrol.cancel': '🚔 Patrol interrupted',
    'patrol.escaped': '💨 The thief got away…',
    'patrol.abandon': '🚔 Chase cancelled — the thief slipped away',
    'patrol.box': '🚔 ${pay} · stop him within {s}s!',
    'patrol.enter': '🚔 You got into the PATROL CAR — answer the calls and stop the criminals!',

    'fire.new': '🔥 FIRE in the city! Rush there and put it out with the hose',
    'fire.doneBonus': '💧 Fire out! +${pay} · speed bonus +${bonus} ⏱️',
    'fire.done': '💧 Fire out! +${pay}',
    'fire.cancel': '🚒 Callout cancelled',
    'fire.late': '🔥 Too late… another station had to handle it',
    'fire.abandon': '🚒 Callout cancelled — the fire burned itself out',
    'fire.out': '💦 Flames out!',
    'fire.box': '🚒 ${pay} · put the fire out within {s}s!',
    'fire.enterTouch': '🚒 You got into the FIRE ENGINE — push the right stick for the hose!',
    'fire.enterKb': '🚒 You got into the FIRE ENGINE — hold the mouse down for the hose!',

    'veh.out': '🚶 You got out',
    'veh.tankTouch': '🪖 You got into the TANK — right stick: rockets · drive over the cars!',
    'veh.tankKb': '🪖 You got into the TANK — mouse: rockets · drive over the cars!',
    'veh.jeep': '🪖 You got into the military jeep — the army will not like this…',
    'veh.bikeTouch': '🏍️ You got on a bike — left stick to ride, 🚗 to get off',
    'veh.carTouch': '🚗 You got into a car — left stick to drive, 🚗 to get out',
    'veh.bikeKb': '🏍️ You got on a bike — WASD to ride, E to get off',
    'veh.carKb': '🚗 You got into a car — WASD to drive, E to get out',
    'veh.burning': '🔥 The car is on fire! Get out before it blows up!',
    'veh.sirenOn': '🚨 Siren on',
    'veh.sirenOff': '🔇 Siren off',

    'miss.offTouch': '🚫 Missions off — tap 📋 to turn them back on',
    'miss.offKb': '🚫 Missions off — press M to turn them back on',
    'miss.on': '✅ Missions back on!',

    'crime.punchCop': '🚨 You punched a police officer down!',
    'crime.punchPed': '🚨 You punched a pedestrian down!',
    'crime.hitCop': '🚨 You hit a police officer!',
    'crime.runCop': '🚨 You ran a police officer over!',
    'crime.runPed': '🚨 You ran a pedestrian over!',
    'crime.shootCop': '🚨 You shot a police officer!',
    'crime.shootPed': '🚨 You shot a pedestrian!',
    'crime.bombCop': '🚨 You blew up a police officer!',
    'crime.bombPed': '🚨 You blew up a pedestrian!',
    'crime.crushPolice': '🚨 You crushed a patrol car!',
    'crime.crushCar': '🚨 You crushed a car!',
    'army.alarm': '🪖 MILITARY ZONE! You set the alarm off — run!',

    'respawn.busted': '👮 Released from the station — behave yourself!',
    'respawn.dead': '🏥 Patched up by the hospital',

    'game.welcome': 'Welcome to Libre City, {name}! 🏙️  {hint}{mp}',
    'game.welcomeBack': 'Welcome back to Libre City, {name}! 🏙️ Game resumed.',
    'game.hintTouch': 'Walk up to a car and tap 🚗',
    'game.hintKb': 'Steal a car with E',
    'game.mpLadderTouch': ' · 🏆 for the scoreboard',
    'game.mpLadderKb': ' · Tab for the scoreboard',
    'game.saved': '💾 Game saved',
    'game.noSave': 'No saved game',

    'net.retry': '🔌 Connecting to the server… retrying',
    'net.lost': '🌐 Connection lost, reconnecting…',
    'net.back': '🌐 Back in the game',
    'net.update': '🔄 New version available — tap to update',
    'net.joined': '🌐 {name} joined the game!',
    'net.left': '🌐 {name} left the game',
    'net.badge': '🌐 <b>{code}</b> · {n} player',
    'net.badgeN': '🌐 <b>{code}</b> · {n} players',
    'net.bounty': '🎯 Bounty: ${n}',
    'net.err.offline': 'Cannot reach the server — check your connection',
    'net.err.noserver': 'Multiplayer server not configured',
    'net.err.pass': 'Wrong password',
    'net.err.full': 'The game is full',
    'net.err.notfound': 'Game not found — check the room code',
    'net.err.exists': 'A game with this code already exists: reload the page',
    'net.err.badcode': 'Invalid room code',
    'net.err.timeout': 'No answer from the server — try again shortly',
    'net.err.qfull': 'The waiting room is full too — try again in a few minutes',
    'net.err.other': 'Network error: {err}',

    'pvp.killed': '💀 You took {name} down!',
    'pvp.killedBounty': '💀 You took {name} down! Bounty +${bounty}',
    'pvp.down': '☠️ {name} took you down!',
    'pvp.onYou': '🎯 Bounty on your head: ${n} — you are a target!',
    'pvp.killedCash': '💀 You took {name} down! (+$25)',
    'pvp.rival': 'a rival',
    'streak.2': 'Double kill!',
    'streak.3': 'Triple kill!',
    'streak.4': 'Quad kill!',
    'streak.5': 'Rampage!',
    'streak.7': 'Unstoppable!',
    'streak.10': 'LEGENDARY!',

    'say.greet': ['Hi {name}!', 'Hey, hello!', 'Lovely day, isn\'t it?', 'Good morning!', 'What a traffic today…', 'Hello there!', 'Some city, huh?'],
    'say.wanted': ['That\'s the wanted guy!', 'Help, a criminal!', 'Call the police!', 'The cops are after you!', 'Run, it\'s him!', 'There he is! Right here!'],
    'say.panic': ['AAAH!', 'Look out!', 'He\'s gone mad!', 'Heeelp!', 'Go! Go!', 'Madman!'],
    'say.cop': ['FREEZE!', 'Hands up!', 'Stop right there, {name}!', 'In the name of the law!', 'Don\'t run!', 'We found you!'],
    'say.fare': ['TAXI! Over here!', 'Downtown, please?', 'I\'m in a hurry!', 'Finally, a cab!'],
    'say.hungry': ['So hungry!', 'Where\'s my pizza?', 'I\'m starving!', 'Hurry, it\'s getting cold!'],
    'say.injured': ['HELP!', 'Everything hurts…', 'An ambulance, quick!', 'I don\'t feel well…'],
    'say.robber': ['You\'ll never catch me!', 'Ha ha, so long!', 'Faster, copper!', 'The loot is mine!'],
    'say.carjack': ['Thief! Thief!', 'Get back here!', 'I saw you, you know?!', 'How rude!', 'I\'m calling the police!', 'Stop, you crook!', 'My insurance!'],
    'say.army': ['Military zone!', 'Intruder! Fire!', 'Freeze right there!', 'Alarm! Alarm!', 'Defend the base!', 'This is not a drill!'],
    'say.stolenPolice': ['Hey! The patrol car!'],
    'say.stolenBike': ['Hey! My bike!'],
    'say.stolenCar': ['Hey! My car!'],
  },
};

// applica subito la lingua al DOM (se c'è un DOM: headless è no-op)
applyLangAttrs();
applyI18n();
