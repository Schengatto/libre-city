# LIBRE-3 — Edifici in stile GTA1 (design)

## Intento
Gli edifici devono sembrare quelli di GTA 1 (1997) visti dall'alto: tetti ricchi e leggibili, materiali con texture evidente, volumi a più altezze, forte contrasto tetto/facciate, varietà fra vicini. Il proprietario giudica gli attuali "molto brutti": serve un salto netto, non un ritocco.

## Diagnosi dello stato attuale (anteprime `.tmp/before-zoom-*.png`)
- **house**: padiglione a strisce piatte, niente coppi, colmi pallidi, comignolo minuscolo, facciata di 7 px quasi invisibile; tutte le case uguali.
- **apartment**: tetto beige uniforme con macchie sfocate, nessuna ghiaia; oggetti sempre negli stessi angoli → palazzi vicini identici; un solo volume.
- **shop**: lastra verde con una striscia di lucernario e un'icona ventola: segnaposto.
- **tower**: grande lastra grigia vuota, un box e tre cubetti; niente gradoni né impianti.
- **warehouse**: lamiera monotona, due bocchette nello stesso punto, niente colmo/lucernari/ruggine.
- **workshop**: piatto, una striscia di lucernario, niente shed.
- **Comune**: nessuna texture ad alta frequenza, layout fissi, cornicione sottile, contrasto debole.

## Obiettivi
- Materiali: ghiaia, guaina/catrame, lamiera grecata, coppi, mattoni, pannelli di cemento.
- Volumi a più altezze (gradoni, torrino scala, ali più basse) con ombre fra i volumi.
- Oggetti sul tetto: UTA/condizionatori con griglia ventola, lucernari vetrati, cisterne, torrino scala con porta, scale alla marinara, antenne, parabole, pannelli solari, tubi/condotte, sfiati, eliporto.
- Cornicioni a più livelli (bordo chiaro a NO, scuro a SE, ombra interna su N e O).
- Facciate: gradiente verticale, marcapiani, finestre con telaio, zoccolo; più scure del tetto.
- Varietà deterministica da `b.h`: tinta, materiale, layout volumi, set di oggetti.

## Non obiettivi / vincoli
- Nessun cambio a gameplay, collisioni, impronte, `lift` (resta solo grafico; altezza massima disegnata = `b.lift`).
- Si toccano solo `js/render.js`, eventuali palette in `js/city.js`, `server/test-buildings.mjs` (+ `render-test-kit.mjs` se serve).
- Tutto nel bake (`drawWorldStatic`), zero costo per frame.
- Nessuno sprite copiato. Luce da NO, ombre a SE.
- Scope globale condiviso: ogni nuovo nome top-level va cercato in tutto `js/` prima di usarlo.

## Approcci
- **A. Ritocco delle funzioni esistenti** — scartato: non dà il salto richiesto.
- **B. Texture disegnate a pixel nel bake per ogni tetto** — scartato: centinaia di migliaia di `fillRect` per chunk, scatti durante il bake on-the-fly.
- **C. (scelto) Pattern di materiale procedurali in cache + pianificatore puro di volumi/oggetti.** Ogni materiale è una tile 64×64 in scala di grigi/alpha generata una volta (`createPattern`), applicata sopra il colore base dell'edificio: costa una `fill` per superficie. 1024 % 64 = 0 → pattern allineati al mondo, senza cuciture fra chunk. Un pianificatore puro (`planBuilding(b, W, H)`) produce volumi e oggetti dal hash; i disegnatori li rendono. Il pianificatore è testabile senza canvas.

## Architettura
- `materialPattern(name)`: cache lazy di pattern (`gravel`, `tar`, `metal`, `tilesH`, `tilesV`, `brick`, `panel`); tile generate con RNG seminato → deterministiche.
- `planBuilding(b, W, H)` → `{ volumes: [{x,y,w,h,lift,material,tint}], props: [{type,x,y,w,h,height,volume}] }` in coordinate locali; volume 0 = base sull'intera impronta; volumi superiori contenuti nel tetto del volume sottostante, `lift` totale ≤ `b.lift`. Oggetti posizionati con RNG da `b.h` e test di non sovrapposizione, dentro il tetto del proprio volume con margine dal cornicione.
- `drawVolume(...)`: facciate S/E (materiale + finestre di stile), tetto con materiale, cornicione; l'ombra del volume superiore sul tetto inferiore (poligono SE, clip sul tetto inferiore).
- `drawRoofProp(prop, ...)`: un ramo per tipo; ogni oggetto ha faccia superiore, lati S/E scuri e ombra SE proporzionale all'altezza.
- Stili:
  - **house**: padiglione o capanna (dal hash), coppi a file, colmi marcati, comignoli con ombra, a volte abbaino/pannelli solari, grondaia.
  - **apartment**: ghiaia, 1–2 volumi (corpo + ala più bassa o torrino), torrini scala, UTA, cisterne, antenne, parabole.
  - **shop**: guaina con giunti, condotte, UTA piccole, lucernari, insegna/tenda sul fronte.
  - **tower**: 2–3 gradoni, pannelli di cemento in facciata, locale macchine, UTA in batteria, antenne; eliporto mantenuto con la regola attuale.
  - **warehouse**: lamiera grecata con colmo centrale, falde chiaro/scuro, fasce di lucernari, ruggine, sfiati a fungo.
  - **workshop**: shed a dente di sega (falde vetrate), oppure lamiera piana; sfiati e camino.

## Lasciato al builder
Dimensioni esatte, palette fini, numero di oggetti per area, purché le anteprime per stile reggano il confronto con GTA1 e i test restino verdi.

## Verifica
- `server/test-buildings.mjs` esteso: determinismo, varietà fra vicini, volumi dentro l'impronta e ≤ `b.lift`, oggetti senza sovrapposizioni e dentro il tetto, cache pattern, unicità dei nomi top-level in `js/`.
- `server/test-terrain.mjs` verde.
- Anteprime prima/dopo (zoom per stile + vista di gioco) senza errori in console, approvate dal proprietario.
