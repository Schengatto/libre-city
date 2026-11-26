# Multigiocatore di Libre City

Il multigiocatore gira su un **vero server** (Node + WebSocket, in `server/`).
Prima era P2P via PeerJS/WebRTC: uno dei telefoni faceva da host e, appena andava
in background, il browser lo sospendeva, la stanza spariva e gli altri venivano
buttati fuori — le **disconnessioni casuali**. Inoltre ogni client simulava la
propria città, quindi traffico e mezzi **si disallineavano** tra i giocatori.

Il passaggio al server avviene in due fasi.

## Fase 1 — Server come transport (attuale)

```
   Alice ─┐                         ┌─ Bob
          ├──WebSocket──► [ SERVER ] ◄──WebSocket──┤
   Cara ──┘   (stanze, relay,       └─ Dario
               orologio partita)
```

- Le stanze vivono in RAM su un processo Node sempre acceso: **niente più
  host-telefono fragile**.
- Il server fa da **ripetitore** dei messaggi (posizione, mezzo, spari, kill) e
  possiede l'**orologio** della partita (countdown + fine con il messaggio `end`).
- Una caduta di rete non butta fuori: entro **30 s** ci si **riaggancia col
  token** e si riprende lo stesso giocatore, senza flicker per gli altri.
- La **simulazione** (pedoni, traffico, polizia, fisica) resta ancora su ogni
  client: questa fase risolve **disconnessioni** e affidabilità del transport, non
  ancora il disallineamento del mondo.

File coinvolti:

| File | Ruolo |
|------|-------|
| `server/index.js` | Server WebSocket: stanze, relay, orologio, riaggancio |
| `server/test.mjs` | Smoke test del protocollo (`npm test` in `server/`) |
| `js/net.js` | Client: crea/entra, ghost, PvP, ladder, riaggancio automatico |
| `index.html` | `<meta name="lc-server">` con l'URL del server |

## Fase 2 — Server autoritativo (prossima)

Spostare la **simulazione** sul server: un'unica città autoritativa, i client
mandano input e disegnano gli snapshot (con prediction sul proprio player). È ciò
che elimina davvero il **disallineamento** e i **veicoli invisibili**. La sim
(`city.js`, `entities.js`, `gameplay.js`, `army.js`, `missions.js`) è già quasi
headless: quasi nessuna dipendenza dai global del browser. Vedi la roadmap in fondo.

## Fase 3 — Host giocatore

La sim non gira più sul server: gira nel browser di un giocatore (**host**), in un
Web Worker (`js/sim-worker.js`). Il server resta relay, tiene il clock di stanza,
elegge e migra l'host. È la modalità di default.

**Ruoli**
- **Host**: il suo worker apre un secondo WebSocket su `/hostlink` (auth con `code` + `token`),
  riceve `hoststart` (roster + ultimo stato giocatori), simula a 60 Hz e manda al server
  gli snapshot per gli altri giocatori come frame `W|<id>|<json>` (uno ogni 2 tick, ~30/s)
  e ogni 500 ms `hst` (stato giocatori e punteggi, usato per la migrazione e la classifica).
  Il suo snapshot passa dal worker al thread principale, non dalla rete.
- **Guest**: come in Fase 2 (input → snapshot, prediction sul proprio player). Non vede la differenza.
- **Server**: relay di input verso l'host e di snapshot verso i guest, clock, punteggi.
  Un host "barare" è accettato per design: l'host è autoritativo sulla stanza.

**Elezione**
- Eleggibile solo chi ha `build` uguale a quella del server (in sviluppo entrambe nulle).
- Preferenza: giocatore connesso `desktop` (`dev` nell'hello, da `usingTouch`), poi id più basso.
  Chi ha rinunciato (`resign`, es. worker fallito) è escluso; solo l'host può rinunciare.
- Nuova elezione quando il socket dell'host si chiude, oppure non arrivano frame per
  `HOST_STALL_MS` (2000 ms), oppure l'host eletto non aggancia l'hostlink entro `HOST_BIND_MS`
  (10000 ms, env `HOST_BIND_MS`). Stallo e mancato aggancio rieleggono solo se la stanza ha
  almeno 2 giocatori e c'è un altro giocatore connesso eleggibile: altrimenti l'host resta.
  Il server avvisa tutti con `{t:'host', id, name}`;
  `ok.host` porta l'host corrente a chi entra o si riaggancia.

**`SIM_MODE`**
- `SIM_MODE=host` (default): sim sull'host.
- `SIM_MODE=server`: comportamento di Fase 2 (sim sul server, `ok.host` assente), come rollback.

**Fallback per stanza**: se nessun giocatore è eleggibile (build diversa, tutti hanno
rinunciato) la stanza usa la sim del server; `ok.host` nullo = sim del server.

**Migrazione dell'host**: il nuovo host riparte dall'ultimo `hst` (giocatori e punteggi).
Si perdono: il veicolo di ogni giocatore, le missioni in corso e fino a 0,5 s di stato.

**Banda** (misura con `.tmp/host-bandwidth.mjs`: worker reale nell'harness di
`server/test-sim-worker.mjs`, 4 giocatori, 10 s, `Math.random` con seed, 900 frame `W`
da ~26 KB raw, 30/s per guest). Soglia: 300 KB/s di upload dell'host.

| Compressione dei frame `W` sull'hostlink | seed 1 | seed 1-5 (media / max) |
|---|---|---|
| raw | 2303,9 KB/s | 2294 / 2502 KB/s |
| prima: senza context takeover, livello 3 | 444,6 KB/s | 441 / 473 KB/s |
| dopo: context takeover, livello 3 | 265,6 KB/s | 267 / 324 KB/s |
| dopo: context takeover, livello 6 | 180,2 KB/s | 183 / 239 KB/s |

L'hostlink (`hostLinkWss`) non chiede più `client_no_context_takeover`: il compressore del
browser host tiene il dizionario tra un frame e l'altro, e i frame consecutivi (snapshot
quasi uguali, anche di guest diversi) si comprimono contro il precedente. Il socket di gioco
resta senza context takeover lato client, per la RAM dei telefoni. Il livello 6 è quello
reale: i browser comprimono con il livello zlib di default, il livello 3 della config vale
solo per ciò che comprime il server. Decisione: basta il context takeover (~183 KB/s reali,
max 239); delta e frequenza più bassa degli snapshot non servono per ora.

**LIBRE-34 fase 1** (snapshot JSON più snelli: la fisica di guida viaggia solo per l'auto del
giocatore, angoli e `aim` arrotondati a 0,01). Stessa misura, livello 6, seed 1-5, media / max:

| Metrica | prima (adc6bb8) | dopo |
|---|---|---|
| raw | 2171 / 2587 KB/s | 1771 / 2114 KB/s |
| byte medi per frame raw | 24700 / 29432 B | 20154 / 24053 B |
| senza context takeover | 341 / 393 KB/s | 211 / 243 KB/s |
| con context takeover | 128 / 225 KB/s | 56 / 71 KB/s |

La colonna "prima" è rimisurata su adc6bb8: i 183 / 239 KB/s della tabella sopra vengono da
un main precedente, con un mondo diverso. Il raw conta ora perché il canale `fast` P2P
(LIBRE-33) invia senza deflate.

**LIBRE-34 fase 2** (snapshot binari: codec `js/snapshot-codec.js`, tabella delle stringhe
ripetute e interi varint al posto del JSON; sull'hostlink il frame è `0x57`, lunghezza id,
id, codec). Stessa misura, livello 6, seed 1-5, media / max, con `.tmp/host-bandwidth.mjs`
adattato a contare i frame binari davvero inviati:

| Metrica | fase 1 | fase 2 |
|---|---|---|
| raw | 1771 / 2114 KB/s | 349 / 409 KB/s |
| byte medi per frame raw | 20154 / 24053 B | 3975 / 4656 B |
| senza context takeover | 211 / 243 KB/s | 184 / 211 KB/s |
| con context takeover | 56 / 71 KB/s | 32 / 36 KB/s |

Il raw cala di circa 5 volte e conta per il canale `fast` P2P, che invia senza deflate. Il
deflate guadagna meno sul binario che sul JSON (senza context takeover solo -13%), perché il
codec ha già tolto la ridondanza che deflate sfruttava; con context takeover resta un -44%.

**LIBRE-34 fase 3** (snapshot delta rispetto all'ultimo snapshot confermato dal guest). Stessa
misura, livello 6, seed 1-5, media / max, con `.tmp/host-bandwidth.mjs` esteso con una catena
guest per `p2..p4` che risolve i frame come `netResolveSnapshot` e conferma il tick dopo 100 ms
simulati. Misurati i primi 10 s dopo 1 s di riscaldamento:

| Metrica | fase 2 | fase 3 |
|---|---|---|
| raw | 349 / 409 KB/s | 62 / 73 KB/s |
| byte medi per frame raw | 3975 / 4656 B | 701 / 836 B |
| senza context takeover | 184 / 211 KB/s | 54 / 64 KB/s |
| con context takeover | 32 / 36 KB/s | 20 / 23 KB/s |
| quota di frame delta | 0% / 0% | 100% / 100% |

Nessun frame scartato con gli ack a 100 ms. Il controllo `ACK=off` (nessun `sa`, solo frame
pieni) riproduce la fase 2 entro lo 0,5%. Il raw cala di circa 5,7 volte e conta per il canale
`fast` P2P, che invia senza deflate; il deflate guadagna meno sul delta (senza context takeover
-71%, con context takeover -38%) perché il delta ha già tolto la ridondanza tra un frame e l'altro.

Protocollo:

- Il guest manda `sa` (tick dell'ultimo snapshot risolto) in ogni input; l'host lo registra per
  guest e codifica contro quel tick.
- Host e guest tengono una storia di 32 snapshot; se il tick di base non c'è più o il delta non
  si applica, il guest svuota la storia e smette di mandare `sa`.
- Frame pieno (senza `base`) a ingresso, cambio host e perdita della base.
- Gli eventi (`fx`, `me.ev`) restano fuori dal delta: inline sul WS e nel messaggio `we` sul
  canale `rel`.

### Trasporto P2P (WebRTC)

Snapshot e input dei guest non passano più dal VPS: viaggiano su un DataChannel WebRTC
direttamente tra guest e host. Il VPS fa solo da signaling (`{t:'rtc', to, k, d}` rimbalzato
come `{t:'rtc', from, k, d}`) e da fallback.

```
guest ⇄ host            (P2P, DataChannel)
guest ⇄ VPS ⇄ host      (solo signaling e fallback WS)
```

- Due canali per guest. `fast`: non ordinato, senza ritrasmissioni (`maxRetransmits: 0`),
  per snapshot e input di movimento. `rel`: ordinato e affidabile, per gli eventi del mondo
  e per gli input a fronte (sparo, entra/esci, clacson, cambio arma, area di interesse).
- Fallback: finché il canale non è utilizzabile gli input e gli snapshot restano sul WS.
  Se la connessione cade o non si apre, il guest riprova con backoff da 5 s a 60 s; il
  ritorno su P2P azzera il backoff. Ogni input va su un solo trasporto.
- Solo STUN, nessun TURN: dove il NAT simmetrico impedisce il P2P il guest resta su WS.
- `?rtc=off` disattiva il P2P sul client (guest sempre su WS), utile per confronti.
- Cambio host: alla migrazione il guest chiude il link, azzera il tick dell'ultimo snapshot
  (`net.lastSnapTick`) e la storia degli snapshot (`net.snapshotRing`, con `net.snapshotAckTick`),
  poi si connette al nuovo host; chi viene eletto host chiude il lato guest.
- Overlay `?netstats` (o F3): la riga `transport` vale `P2P`, `WS` oppure `host`.
- Solo STUN: host e guest vedono l'IP pubblico l'uno dell'altro (candidate srflx), come in
  Fase 1 con PeerJS. `?rtc=off` lo evita per un guest; nasconderlo richiederebbe un relay TURN (non usato).
- Race accettata: gli eventi one-shot (toast, fx) che il worker ha già estratto per un guest
  nei 1-2 frame in cui il suo canale si chiude vanno persi; punteggi e stato si riallineano
  dagli snapshot successivi (`sc`, `me`).
- Misurare: aprire il guest con `?netstats` (P2P) e poi con `?netstats&rtc=off` (WS) e
  confrontare RTT, `input RTT`, `snap/s`, jitter e `max gap 5s`.

---

## Avvio in locale

**1. Server**
```bash
cd server && npm install    # una volta (installa 'ws')
# poi, dalla ROOT del progetto:
npm run server              # in ascolto su ws://localhost:8787
npm test                    # (facoltativo) verifica il protocollo
npm run build               # genera dist/ (senza URL = sviluppo locale)
```

**2. Client**

In sviluppo `js/net.js` punta da solo a `ws://localhost:8787` quando il sito è
aperto da `localhost`/`127.0.0.1`/`file://` — non serve configurare niente.
Serve il sito statico e apri due schede (o due dispositivi in LAN):
```bash
# dalla root del progetto, un qualsiasi server statico, es:
python3 -m http.server 5173
# poi apri http://localhost:5173 in due schede: una "Ospita", l'altra "Entra"
```

Per puntare a un server diverso al volo, senza toccare i file:
`http://localhost:5173/?server=ws://192.168.1.10:8787`

---

## Deploy

Il **sito statico** e il **server** si mettono online separatamente.

**1. Server** — su un host che tiene un processo Node acceso. Esempio **Fly.io**:
```bash
cd server
fly launch --no-deploy      # crea l'app (modifica app/region in fly.toml)
fly deploy                  # build del Dockerfile e messa online
fly open /health            # → {"ok":true,...}
```
Su **Railway/Render**: nuovo servizio dal repo puntando alla cartella `server/`
(usano il `Dockerfile`), start `node index.js`. La porta arriva dall'env `PORT`.

**2. Sito** — genera `dist/` **passando l'URL del server**: il build lo inietta
nel `<meta name="lc-server">`, così non tocchi `index.html` a mano.
```bash
LC_SERVER=wss://libre-city.fly.dev npm run build
# equivalenti:  npm run build -- --server=wss://libre-city.fly.dev
#               node build.js wss://libre-city.fly.dev
```
Poi carica il contenuto di `dist/` su Cloudflare Pages / Netlify / Apache.
Senza URL (`npm run build`) il meta resta vuoto: va bene per lo sviluppo locale
(il client ripiega su `ws://localhost:8787`). All'occorrenza puoi comunque forzare
l'URL a runtime con `window.LIBRE_CITY_SERVER = 'wss://…'` o `?server=wss://…`.

> Nota Fly: con `min_machines_running = 0` la macchina si sospende a stanza vuota
> (costo ~0) ma il **primo** ingresso paga un cold start di qualche secondo — il
> client riprova da solo. Mettilo a `1` per partenze istantanee.

---

## Protocollo (JSON su WebSocket)

**client → server**

| msg | quando |
|-----|--------|
| `create {code,name,pass,max,minutes}` | l'host crea la stanza |
| `join {code,name,pass[,token]}` | entra (o riaggancia col `token`) |
| `s {…}` | stato del giocatore (~15/s): posizione, mezzo, statistiche |
| `shot`/`punch`/`rocket`/`park`/`gone` | eventi di gioco |
| `kill {to}` | la vittima accredita l'uccisione al tiratore `to` |

**server → client**

| msg | significato |
|-----|-------------|
| `ok {id,shirtIdx,minutes,left,players,token[,resumed]}` | ingresso riuscito |
| `no {r}` | rifiutato: `pass`/`full`/`notfound`/`exists`/`badcode` |
| `join`/`leave {id,…}` | un giocatore è entrato/uscito |
| `end` | tempo scaduto (orologio del server) |
| `kill {id}` | hai steso la vittima `id` |
| `<stato/evento con id>` | ripetuto da un altro giocatore |

Danni PvP: li decide **chi li subisce** (vittima autoritativa). Nessun conflitto
tra simulazioni finché la Fase 2 non le unifica.

---

## Classifica condivisa

La ladder in partita (Tab / 🏆) muore con la stanza. La **classifica condivisa**
(`server/leaderboard.js`) è l'altra metà: vive sul server, vale per tutte le
stanze e sopravvive ai riavvii.

La metrica sono i **punti al minuto**. Le stanze durano da pochi minuti a mezz'ora
(`minutes` lo sceglie chi crea), quindi il punteggio grezzo non è confrontabile:
per ogni giocatore si sommano i punti fatti e il tempo **effettivamente giocato**,
e si ordina sul rapporto `punti / minuti`.

- Il tempo è quello **connesso e in gioco**: la finestra di grazia di chi cade
  dalla rete non conta (il cronometro si ferma alla disconnessione).
- Ci si entra dopo **3 minuti** di gioco totali (`LEADERBOARD_QUALIFY_MS`):
  senza soglia, chi fa un'uccisione fortunata nei primi trenta secondi e se ne va
  resterebbe primo per sempre.
- Il punteggio è **solo quello della sim autoritativa**. Se la sim non è attiva
  (ripiego Fase 1, relay puro) non si registra nulla: meglio un buco che numeri
  che il client dichiara su se stesso.
- L'identità è il **nome** scritto nel menu, normalizzato (spazi/maiuscole).
  Non ci sono account: gli omonimi condividono la riga.

Il client la legge in **HTTP semplice**, non via WebSocket: si consulta dal menu
(`🌐 Classifica online`), senza partita né socket aperto.

```
GET /leaderboard?limit=20
→ { ok, metric:'ppm', qualifyMs, tracked, ranked,
    top:[ {rank,name,ppm,score,ms,matches,kills,deaths,best:{ppm,score,ms,at}} ] }
```

| Variabile | Default | Cosa fa |
|-----------|---------|---------|
| `LEADERBOARD_FILE` | `server/data/leaderboard.json` | dove si salva (in produzione: volume `./data`) |
| `LEADERBOARD_QUALIFY_MS` | `180000` | gioco totale necessario per entrare in classifica |
| `LEADERBOARD_MIN_SESSION_MS` | `30000` | sotto questa permanenza non si registra nulla |
| `LEADERBOARD_MAX` | `500` | voci conservate (le più deboli escono) |

Il file è riscritto **atomico** (tmp + rename) e con un ritardo di qualche secondo,
più un flush allo spegnimento: un redeploy non butta via gli ultimi minuti. Se il
volume è in sola lettura la classifica prosegue in RAM e lo dice **una volta** nel log.

Test: `node server/test-leaderboard.mjs` (nella catena di `npm test` in `server/`).

---

## Roadmap Fase 2 (server autoritativo)

1. **Isolare la simulazione headless.** Estrarre da `core.js` gli util puri
   (RNG seedato, `clamp`, `dist`, `angDiff`) e far girare `city.js` +
   `entities.js` + gli `update*` di `gameplay.js`/`army.js`/`missions.js` in Node
   senza `canvas`/DOM/audio, stubbando le funzioni di presentazione (`sfx.*`,
   `spawnMuzzle/Blood/…`, `update*` della HUD) con no-op o eventi.
2. **Loop autoritativo sul server** (~30 Hz): il server simula pedoni, traffico,
   polizia, proiettili e ne diffonde gli **snapshot** (con delta/aree di interesse).
3. **Client = renderer.** Manda input, disegna gli snapshot, fa prediction +
   reconciliation solo sul proprio player per la reattività.
4. **Migrazione morbida** riusando il transport della Fase 1 (stesse stanze,
   stesso riaggancio): cambia solo *cosa* viaggia (mondo intero vs solo i player).
