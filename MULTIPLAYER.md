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
