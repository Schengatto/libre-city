# Edifici in stile GTA1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rifare il disegno procedurale degli edifici (`js/render.js`) fino al livello di GTA1 top-down: materiali con texture, volumi a più altezze, tetti pieni di oggetti, facciate contrastate, varietà da hash.

**Architecture:** Pattern di materiale 64×64 generati una volta e messi in cache (`createPattern`), applicati sopra il colore dell'edificio. Un pianificatore puro `planBuilding(b, W, H)` decide volumi e oggetti dal hash; i disegnatori (`drawVolume`, `drawRoofProp`, tetti per stile) li rendono nel bake dei chunk.

**Tech Stack:** Canvas 2D, JS vanilla con scope globale condiviso fra `js/*.js`; test Node `server/test-buildings.mjs` con `server/render-test-kit.mjs` (estrazione delle dichiarazioni top-level + ctx registratore).

**Spec:** `docs/superpowers/specs/2026-11-22-gta1-buildings-design.md`

## Global Constraints
- File toccabili: `js/render.js`, palette in `js/city.js`, `server/test-buildings.mjs`, `server/render-test-kit.mjs`. Nessun cambio a impronte, collisioni, `lift`, gameplay.
- Altezza massima disegnata di un edificio = `b.lift` (le ombre esistenti usano `b.lift * SHADOW_LENGTH_PER_LIFT`).
- Tutto il disegno resta dentro `drawBuildings()` (chiamata solo da `drawWorldStatic()` → bake). Nessun lavoro per frame.
- Luce da NO: bordi N/O chiari, lati S/E scuri, ombre verso SE.
- Varietà solo deterministica: niente `Math.random`, solo RNG seminato da `b.h`.
- Scope globale: prima di aggiungere un nome top-level, `Grep` del nome su tutto `js/`. Nomi già verificati liberi: `buildingRandom`, `rectsOverlap`, `materialPattern`, `materialPatterns`, `MATERIAL_TILE`, `planBuilding`, `planRoofProps`, `drawVolume`, `drawVolumeShadow`, `drawCornice`, `drawRoofProp`, `drawRoofSurface`, `drawGableRoof`, `drawSawtoothRoof`, `drawMetalRoof`, `STYLE_ROOF`.
- Codice in inglese, nessun commento nel codice. Edit raggruppati per file; Read con offset/limit; niente `cat`/`sed`.
- Ogni nuovo simbolo usato dai test va aggiunto a `DECLARATIONS` in `server/test-buildings.mjs`.
- Nessun commit nei task: il commit si fa solo dopo l'approvazione dell'anteprima da parte del proprietario.
- Script con regex: scriverli con Write, mai heredoc.

## Spazio di disegno (decisione vincolante)
Il modello esistente: impronta `W×H` a `(px,py)`, altezza `L`; tetto = `(px, py, W-L, H-L)`; facciata sud = striscia in basso, est = striscia a destra (`drawBuildingWalls`). I volumi superiori usano lo stesso trucco ricorsivamente, in coordinate **locali** (origine = angolo NO dell'impronta):
- `volume = { x, y, w, h, lift, parent }`; `volumes[0] = { x:0, y:0, w:W, h:H, lift:L0, parent:-1 }`.
- altezza parete del volume `wall = lift - (parent < 0 ? 0 : volumes[parent].lift)`.
- tetto del volume `roof = { x, y, w: w - wall, h: h - wall }`.
- un volume figlio sta interamente dentro il `roof` del padre.
- oggetto `prop = { type, x, y, w, h, height, volume }`, dentro il `roof` del suo volume con margine ≥ 3 px, senza sovrapposizioni con altri oggetti né con i volumi figli dello stesso padre.

## Review Focus
- Edifici minimi (1×1 tile, 32×32 px) con lift alto: il pianificatore non deve produrre rect a larghezza ≤ 0 né cicli infiniti → test con 1×1 e lift 24.
- Tetti stretti (1×N tile): niente oggetti fuori dal tetto → test di contenimento su tutte le SIZES.
- Pattern fra chunk: i pattern sono ancorati all'origine del canvas; `WORLD_CHUNK % MATERIAL_TILE === 0` → test.
- Collisioni di nomi nello scope globale (già causato l'acqua bianca) → test di unicità dei nomi top-level su tutti i `js/*.js`.
- Costo di bake: tempo medio di `bakeWorldChunk` misurato prima/dopo nell'anteprima; obiettivo ≤ 3× il prima.

---

### Task 1: Primitive condivise (RNG, materiali, pianificatore, oggetti del tetto)

**Files:**
- Modify: `js/render.js` (sezione edifici, dopo `WALL_LAYOUT`, ~riga 399)
- Modify: `server/test-buildings.mjs`, `server/render-test-kit.mjs` se serve uno stub `document`

**Interfaces:**
- Produces:
  - `buildingRandom(seed: number): () => number` — RNG deterministico in [0,1) (es. mulberry32).
  - `rectsOverlap(a, b): boolean` — rect `{x,y,w,h}`, contatto sul bordo = no overlap.
  - `const MATERIAL_TILE = 64`.
  - `materialPattern(name): CanvasPattern` — cache in `const materialPatterns = new Map()`; crea il canvas con `document.createElement('canvas')` alla prima richiesta. Nomi: `'gravel'` (puntini chiari/scuri 1px fitti), `'tar'` (rotoli di guaina: giunti orizzontali ogni 16 px, toppe), `'metal'` (nervature verticali ogni 4 px con riga chiara+scura), `'tilesH'` (file di coppi orizzontali, archetti ogni 6 px, righe ogni 5 px), `'tilesV'` (stessi, ruotati), `'brick'` (mattoni 6×3 sfalsati), `'panel'` (pannelli di cemento 16×8). Tile in alpha su trasparente, semi fissi.
  - `drawRoofSurface(x, y, w, h, color, material)` — fill colore, fill pattern, poi gradiente di luce NO→SE (chiaro→scuro, ~.12) e 3–5 macchie di sporco dal seme.
  - `planRoofProps(random, roof, pool, count, reserved): prop[]` — `pool` = array di `{ type, w:[min,max], h:[min,max], height }`; ogni tentativo pesca tipo e taglia, posiziona a caso dentro `roof` con margine 3, scarta se fuori o in overlap con `reserved`/già piazzati; max `count * 8` tentativi.
  - `drawRoofProp(prop, ox, oy)` — `ox,oy` = origine schermo dell'impronta. Tipi: `hvac` (box con griglia e ventola tonda), `stairHut` (box alto con porta scura sul lato sud), `tank` (cilindro: cerchio con sfumatura radiale, doghe, cappello conico chiaro a NO), `skylight` (vetro azzurro-grigio con riflesso diagonale e telaio), `vent` (fungo tondo piccolo), `antenna` (palo 1 px + traversine + ombra lineare a SE lunga `height*1.6`), `dish` (ellisse chiara con braccio), `solar` (pannello blu scuro a griglia, inclinato: bordo N chiaro), `duct` (condotta lunga 4–5 px con fasce), `chimney` (mattoni + bocca scura). Ogni oggetto: ombra SE lunga `height * SHADOW_LENGTH_PER_LIFT` alpha ~.30, lati S/E scuri, bordo N/O chiaro.

- [ ] **Step 1: Test** in `test-buildings.mjs` (nuova sezione `4) primitive`):
  - `buildingRandom(42)` produce la stessa sequenza di 5 valori due volte; tutti in [0,1).
  - `rectsOverlap({x:0,y:0,w:10,h:10},{x:10,y:0,w:5,h:5}) === false`; con `x:9` → `true`.
  - `materialPattern('gravel') === materialPattern('gravel')` e lo stub `document.createElement` è chiamato una volta per nome; `1024 % MATERIAL_TILE === 0`.
  - `planRoofProps` su `roof {x:0,y:0,w:120,h:90}`, pool di 4 tipi, `count 8`, `reserved [{x:40,y:30,w:30,h:30}]`: ogni prop dentro il roof con margine 3, nessuna coppia in overlap, nessun overlap con reserved; su roof `{w:10,h:10}` → `[]` senza eccezioni.
  - Unicità nomi: per ogni `js/*.js`, raccogli i nomi da `^(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)` (anche liste `const a = 1, b = 2` non serve: basta il primo nome) e verifica nessun nome dichiarato in più di un file o due volte nello stesso file.
- [ ] **Step 2:** Esegui `node server/test-buildings.mjs` → i nuovi test falliscono (declaration not found).
- [ ] **Step 3:** Implementa i simboli sopra; passa uno stub `document` a `loadRenderer` (parametro in più della `new Function`) che restituisce un canvas finto con `getContext` → ctx registratore.
- [ ] **Step 4:** `node server/test-buildings.mjs` → tutti OK.

### Task 2: Volumi + apartment e tower

**Files:** Modify `js/render.js` (`drawBuildings` ~526-609, nuove funzioni accanto), `server/test-buildings.mjs`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `const STYLE_ROOF = { apartment: {...}, tower: {...}, shop: {...}, workshop: {...}, warehouse: {...}, house: {...} }` — per stile: `material`, `pool` (per `planRoofProps`), `propDensity` (oggetti per 1000 px² di tetto, minimo 3 se il tetto ≥ 64×64).
  - `planBuilding(b, W, H): { volumes, props }` — spazio di disegno sopra; RNG = `buildingRandom(b.h)`.
    - apartment: 60% (dal RNG) due volumi: base `lift = b.lift - step` (step 3–5) + ala superiore che copre 55–80% del tetto addossata a un lato scelto dal RNG, `lift = b.lift`; altrimenti un volume. Pool: `stairHut`, `hvac`, `tank`, `vent`, `antenna`, `dish`.
    - tower: tetto ≥ 64 px sul lato corto → 3 volumi (base `b.lift-8`, gradone `b.lift-4` rientrato 12–25% per lato, nucleo tecnico `b.lift` di 30–45% del gradone); altrimenti 2. Pool: `hvac` in batteria, `antenna`, `vent`, `duct`, `tank`. Eliporto (regola attuale: `rw,rh >= 120 && b.h % 3 === 0`) sul gradone più ampio libero, riservato come rect prima degli oggetti.
    - altri stili: per ora un volume `lift = b.lift` (riempiti nei task 3–5).
  - `drawVolume(b, volume, wall, ox, oy, roofMaterial)` — pareti S/E del volume (riusa la logica di `drawBuildingWalls` con `L = wall`), `drawRoofSurface` sul tetto, `drawCornice`.
  - `drawCornice(x, y, w, h, color)` — cornicione a due livelli: bordo esterno 2 px (N/O `shade(+.30)`, S/E `shade(-.35)`), gola interna 1 px scura, ombra interna su N e O larga 3 px alpha .22, puntini di coprigiunto ogni 6 px sul bordo.
  - `drawVolumeShadow(child, wall, parentRoof, ox, oy)` — poligono SE del figlio lungo `wall * SHADOW_LENGTH_PER_LIFT`, clip sul tetto del padre, alpha .28.
  - `drawBuildings()` per apartment/tower: `planBuilding` → per ogni volume in ordine (padre prima del figlio) `drawVolume`, poi ombra dei figli sul padre prima di disegnare i figli, poi oggetti del volume dopo il suo tetto, poi `drawFacade` sul volume 0.
- [ ] **Step 1: Test** (sezione `5) pianificatore`), per tutti gli stili × SIZES × 6 semi, più un 1×1 con lift 24:
  - `volumes[0]` = `{x:0,y:0,w:W,h:H}`; ogni figlio dentro il `roof` del padre; `lift` crescente lungo la catena; `max lift === b.lift`; nessun `w/h ≤ 0`.
  - ogni prop dentro il roof del suo volume (margine 3), nessun overlap fra props dello stesso volume né con i figli dello stesso padre.
  - `planBuilding` due volte sullo stesso `b` → `JSON.stringify` identico.
  - tower con tetto ≥ 64 px → `volumes.length >= 2`; apartment: ≥ 30% dei campioni con 2 volumi.
  - apartment/tower con tetto ≥ 64×64 → `props.length >= 3`.
  - varietà: 20 apartment 4×5 con `h` diversi → ≥ 15 firme distinte (`JSON.stringify(props.map(p => [p.type, p.x, p.y]))`).
- [ ] **Step 2:** Esegui, vedi fallire. **Step 3:** Implementa. **Step 4:** Test verdi.
- [ ] **Step 5: Verifica visiva:** `node .tmp/preview3.mjs after` → leggi `.tmp/after-zoom-apartment.png`, `after-zoom-tower.png`, `after-block.png`; confronta con `before-*`. Itera finché: ghiaia visibile, gradoni con ombre, ≥3 oggetti distinti, palazzi vicini diversi. Nessun errore in console.

### Task 3: shop e workshop

**Files:** `js/render.js`, `server/test-buildings.mjs`
**Interfaces:** Consumes `STYLE_ROOF`, `planBuilding`, `drawVolume`, `planRoofProps`, `drawRoofProp`. Produces `drawSawtoothRoof(b, x, y, w, h, color)`.
- shop: guaina `tar`, un volume; 30% dal RNG un locale tecnico basso (`lift = b.lift`, base `b.lift - 3`) sul retro (lato opposto a `b.face`). Pool: `hvac` piccole, `duct`, `skylight`, `vent`. Tenda/insegna esistenti in `drawFacade` restano.
- workshop: 50% shed a dente di sega (`drawSawtoothRoof`: denti paralleli al lato lungo, passo 12–16 px, faccia vetrata azzurra rivolta a N chiara, falda opaca `metal` scura, ombra di ogni dente sul successivo), 50% lamiera piana `metal`. Pool: `vent`, `chimney` (camino industriale tondo), `duct`.
- [ ] **Step 1: Test:** il disegno di un workshop shed registra almeno `floor(h / 16)` fill di denti (conta `fill` fra `save`/`restore` del tetto oppure espone `sawtoothTeeth(w, h)` puro e ne testa conteggio e copertura); shop con tetto ≥ 64×64 → ≥ 3 props.
- [ ] **Step 2–4:** fallire → implementare → verde.
- [ ] **Step 5:** anteprima `after-zoom-shop.png`, `after-zoom-workshop.png`.

### Task 4: warehouse

**Files:** `js/render.js`, `server/test-buildings.mjs`
**Interfaces:** Produces `drawMetalRoof(b, x, y, w, h, color)`, `gableRoofPlanes(x, y, w, h)` → `{ a: polygon, b: polygon, ridge: [[x1,y1],[x2,y2]] }` con colmo lungo il lato lungo (usato anche dalla casa).
- Capriata a due falde con colmo centrale sul lato lungo; falda a NO/N chiara, falda a SE/S scura; pattern `metal` con nervature perpendicolari al colmo; fasce di lucernari traslucidi ogni 3–5 nervate (dal RNG); 2–6 chiazze di ruggine (gradiente radiale arancio-bruno alpha .25); colmo con aeratore continuo; sfiati a fungo come props.
- [ ] **Step 1: Test:** `gableRoofPlanes` per `[64,32],[32,80],[40,40],[25,57]`: area delle due falde = `w*h`, vertici dentro il rect, colmo parallelo al lato lungo.
- [ ] **Step 2–4.** **Step 5:** anteprima `after-zoom-warehouse.png`.

### Task 5: house

**Files:** `js/render.js` (`drawHipRoof` ~498), `server/test-buildings.mjs`
**Interfaces:** Consumes `hipRoofPlanes`, `gableRoofPlanes`, `materialPattern('tilesH'|'tilesV')`.
- Dal RNG: 55% padiglione, 45% capanna. Falde con pattern coppi orientato (file parallele alla gronda: `tilesH` per falde N/S, `tilesV` per E/O); toni falda come oggi ma contrasto più forte (N +.22, O +.08, S -.18, E -.34); colmi e displuvi 2 px chiari con ombra 1 px; gronda 1 px scura lungo il bordo; 1–2 comignoli (`chimney`) con ombra; 25% pannelli solari sulla falda S; 20% abbaino sulla falda S (piccolo volume con mini-padiglione).
- [ ] **Step 1: Test:** le case con lo stesso stile e `h` diversi producono entrambi i tipi di tetto su 20 campioni; props della casa dentro il tetto.
- [ ] **Step 2–4.** **Step 5:** anteprima `after-zoom-house.png`.

### Task 6: Facciate

**Files:** `js/render.js` (`drawBuildingWalls` ~448-474, `WALL_LAYOUT`), `server/test-buildings.mjs`
- Contrasto: sud `shade(col, -0.38)`, est `shade(col, -0.58)`; gradiente verticale (più scuro verso terra, alpha .18); pattern per stile: `brick` (house, apartment, shop), `panel` (tower), `metal` (warehouse, workshop); marcapiano 1 px chiaro ogni `floorHeight`; finestre con davanzale chiaro 1 px e architrave scuro; zoccolo scuro 2 px alla base; spigolo SE con linea chiara (già presente). Varietà: tinta della facciata `shade(col, ±0.06)` dal RNG.
- [ ] **Step 1: Test:** il ctx registratore vede `createPattern` usato in facciata per tutti gli stili; nessun NaN (test esistente).
- [ ] **Step 2–4.** **Step 5:** anteprima di tutti gli zoom + `after-game.png`.

### Task 7 (sessione principale): verifica finale
- [ ] `gate-runner`: `node server/test-buildings.mjs` e `node server/test-terrain.mjs` verdi.
- [ ] `node .tmp/preview3.mjs after` senza errori in console; confronto affiancato prima/dopo (zoom per stile + vista di gioco) e tempo medio di bake prima/dopo.
- [ ] Mostrare al proprietario, attendere approvazione, poi Archivist, commit `feat(render): edifici in stile GTA1`, LIBRE-3 in review/done.
