# LIBRE-15 — Multiplayer: un giocatore fa da host della simulazione, con migrazione (design)

## Intento
Il multiplayer va ancora a scatti. Causa misurata in LIBRE-11: il server di prod non regge la simulazione a 60 Hz (una città per stanza sullo stesso event loop). Con 2 stanze i buchi fra snapshot arrivano a ~2 s. Il proprietario chiede che **uno dei giocatori faccia da host** e che, **se l'host si disconnette, il ruolo passi a un altro giocatore** senza chiudere la partita.

## Obiettivi
- La città di una stanza viene simulata nel browser di un giocatore (host), non sul server.
- Il server diventa relay leggero: stanze, coda, orologio, fine partita, elezione dell'host.
- Se l'host cade (socket chiuso o silenzioso), il server nomina subito un altro giocatore connesso; la partita continua con lo stato dei giocatori conservato.
- I client non host restano come oggi: inviano input `i`, ricevono snapshot `w` e li disegnano (`netOnSnapshot`/`updateNetClient` invariati).

## Non obiettivi
- Trasferire traffico, pedoni, proiettili all'host nuovo: si rigenerano attorno ai giocatori (`managePopulation`).
- WebRTC/P2P: il trasporto resta il WebSocket verso il server (niente broker, niente NAT).
- Anti-cheat sull'host.

## Anti-obiettivi
- La partita non deve chiudersi o resettare punti/soldi/kill quando l'host cade.
- Il disegno a schermo dell'host non deve rallentare per colpa della simulazione.
- Nessuna regressione della modalità con simulazione sul server.

## Vincoli (dal codice)
- La sim è un insieme di classic script con scope globale condiviso: `core, i18n, city, train, entities, missions, army, gameplay, server-sim-glue` (`server/sim-runtime.js` `SIM_FILES`). Gira già headless con gli stub di `makeBrowserStub`; in un Web Worker gira con `importScripts` e un preambolo di stub equivalente. Il codice stanza arriva da `location.hash` (`core.js:43`): nel worker va passato nell'URL (`sim-worker.js#room=CODE`).
- `__sim` (`js/server-sim-glue.js:260-311`): `addPlayer`, `removePlayer`, `applyInput`, `tick`, `snapshotFor`, `scores`, `clearFx`. `addPlayer` non sa ripristinare lo stato di un giocatore.
- `build.js` hasha solo gli `<script>` di `index.html`: un worker richiede uno step di build dedicato e il precache in `sw.js`.
- Il deploy copia i file sim in `release/sim` per il server (`.github/workflows/deploy.yml:75-77`): resta necessario per la modalità server.

## Approcci considerati
1. **Host nel browser, sim in Web Worker, server relay (scelto).** Il carico della sim esce dal server (una stanza = un dispositivo). Il worker isola la sim dal thread di rendering. Costo: upload dell'host = (N-1) snapshot × 30/s (compressi da permessage-deflate), e un telefono lento come host può non tenere i 60 Hz.
2. **Sim sul server in `worker_threads`, una stanza per thread.** Toglie l'interferenza fra stanze, ma non risolve una VPS con pochi core e non è ciò che è stato chiesto (host = giocatore).
3. **P2P WebRTC con host.** È l'architettura abbandonata in Fase 1: dipende da broker/NAT e la stanza muore con l'host. Scartato.

Scelta: 1, con la modalità server mantenuta come fallback (`SIM_MODE=server`).

## Design

### Modalità
- Env del server `SIM_MODE`: `host` (default) o `server` (comportamento attuale). In `host` il server non chiama `createRoomSim`.
- Messaggio `ok`: `sim: true` in entrambe le modalità, più `host: <playerId>` in modalità host (assente in modalità server).

### Elezione dell'host (server)
- `room.hostId`: il creatore all'inizio.
- Ogni hello (`create`/`join`) porta `dev: 'desktop' | 'touch'` (da `usingTouch`). L'elezione preferisce un giocatore connesso `desktop`, poi l'id più basso.
- Si elegge un nuovo host quando: il socket dell'host si chiude; oppure l'host non manda frame per `HOST_STALL_MS` (2000 ms) e c'è un altro giocatore connesso.
- All'elezione il server manda a tutti `{t:'host', id, state}`; `state` è l'ultimo stato giocatori ricevuto dall'host (sotto). Il vecchio host, se ancora connesso o quando si riaggancia, riceve `host` / `ok` con un altro id e ferma il suo worker.
- Nessun giocatore connesso: `hostId = null`; il primo che si riaggancia diventa host.

### Protocollo in modalità host
- Input: i client mandano `i` come oggi; il server lo inoltra all'host aggiungendo `id` del mittente. L'input dell'host va diretto al suo worker.
- Snapshot: l'host manda frame testuali `W|<playerId>|<json>`; il server legge il prefisso, taglia al secondo `|` e inoltra il JSON grezzo al giocatore, senza `JSON.parse`. Lo snapshot dell'host stesso non passa dalla rete.
- Stato giocatori: ogni 500 ms l'host manda `{t:'hst', players:[{id,x,y,hp,cash,k,d,s,stk,b,own,wp,wanted,wantedHeat}]}`. Il server lo conserva in `room.hostState` e lo usa per: classifica (`scoreOf`/`recordAll`), migrazione, `sc`.
- Roster: su `join` (nuovo giocatore) e `leave` (fine grace) l'host aggiunge/toglie il giocatore nel worker.
- Orologio e `end`: invariati sul server. Su `end` l'host termina il worker.

### Lato host (client)
- `js/sim-host.js` (thread principale): avvia/ferma il worker, inoltra roster e input, consegna lo snapshot proprio a `netOnSnapshot`, spedisce gli altri al server, invia `hst`.
- `js/sim-worker.js`: preambolo stub (gli stessi di `makeBrowserStub`, condivisi in `js/sim-stubs.js` e usati anche da `server/sim-runtime.js` per evitare divergenze), `importScripts` dei file sim, loop a step fisso 60 Hz con il cap di catch-up di 250 ms, uno snapshot per giocatore ogni 2 tick con `sc = scores()`, poi `clearFx()`.
- Glue: nuovi `__sim.exportPlayers()` e `__sim.restorePlayer(id, name, shirtIdx, state)` (crea il giocatore e applica posizione, salute, soldi, punteggi, armi, wanted).
- Avvio da host con `state` non vuoto (migrazione): il worker ripristina ogni giocatore da `state`; quelli senza stato entrano freschi.
- Toast a tutti: «Nuovo host: <nome>».

### Build
- `build.js`: concatena `sim-stubs` + `SIM_FILES` + `sim-worker` in un unico `sim-worker.<hash>.js`, ne scrive l'URL in un `<meta name="lc-sim-worker">` di `index.html` e lo aggiunge al precache. In sviluppo (senza build) il client usa `js/sim-worker.js`, che fa `importScripts` dei singoli file.

### Test
- Nuovo `server/test-host-mode.mjs` (server reale in `SIM_MODE=host`, client WS finti): `ok.host` = creatore; inoltro `i` all'host con `id`; inoltro `W|pid|json` al solo destinatario; elezione alla chiusura dell'host con `state` dell'ultimo `hst`; elezione per stallo; preferenza `desktop`; classifica da `hst` a fine partita; vecchio host che si riaggancia riceve `ok` con un altro host.
- Test headless di `exportPlayers`/`restorePlayer` sul glue.
- I test esistenti che dipendono dalla sim sul server (`test-server-sim`, `test-leaderboard`, `test-queue`) avviano il server con `SIM_MODE=server`.

## Decisioni dopo la revisione del builder (mie)
1. **Canale host nel worker.** Il worker apre un SUO WebSocket (`{t:'hostlink', code, token}`): snapshot `W`, `hst` e input inoltrati viaggiano lì, non nel thread principale (che in una tab nascosta è rallentato a ~1 Hz). Il socket principale del giocatore resta com'è. Conta come segno di vita qualunque frame sul canale host. Niente "ritorno" automatico del vecchio host: il ruolo cambia solo per chiusura, stallo o dimissioni.
2. **Stato conservato.** `hst` ogni 500 ms. Alla migrazione si accetta di perdere ≤0,5 s, il veicolo (si riparte a piedi), missioni ed effetti in corso. Restano punti, soldi, kill/morti, streak/taglia, armi, salute, wanted, posizione.
3. **Worker che fallisce.** Il worker segnala l'errore; il client manda `{t:'resign'}`; il server elegge un altro escludendo chi si è dimesso. Se non resta nessun candidato e `createRoomSim` è disponibile, la stanza passa alla sim sul server (fallback per stanza) ripristinando i giocatori da `room.hostState` con lo stesso `restorePlayer`.
4. **Capienza.** Resta 8 giocatori, 30 snapshot/s. Il piano include una misura della banda dell'host (byte/s compressi con 4 giocatori); niente throttling se resta sotto 300 KB/s. `MAX_ROOMS` invariato (è un parametro operativo via env).
5. **Autorità dei frame.** Il server scarta `W`/`hst` da chiunque non sia il canale host corrente e scarta `W` diretti a un id non presente nella stanza.
6. **Cambio host.** Il server manda `{t:'host', id, name}` a tutti e `{t:'hoststart', roster, state}` al nuovo host; roster = tutti i giocatori della stanza, anche quelli in grace (restano nel mondo come oggi). Chi entra mentre non c'è host viene messo nel roster e aggiunto quando l'host parte. Per gli altri client solo il toast «Nuovo host: <nome>».
7. **Versioni.** Eleggibile solo chi ha `build` uguale a quella del server (l'hello porta `build`; in sviluppo entrambe nulle). Se nessuno è eleggibile: fallback per stanza come al punto 3.
8. **Latenza.** Accettato ~2×RTT sul mondo; il giocatore locale è già client-authoritative, nessuna modifica alla predizione.

## Lasciato al builder
- Nomi interni, struttura dei messaggi worker↔thread principale.
- Come esporre `usingTouch` nell'hello (variabile già globale in `input.js`).
- Dettagli del preambolo stub nel worker (es. `self.document`).

## Rischi accettati (scelte mie)
- Classifica basata sui numeri dell'host: un host modificato può barare. Accettato: il gioco è casual e la stanza è fra amici.
- Telefono come host: mitigato da preferenza desktop ed elezione per stallo; se tutti sono su telefono, l'host resta un telefono.
- Durante la migrazione il mondo si ferma ~1-2 s e il traffico si rigenera.
