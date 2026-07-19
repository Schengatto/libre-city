// LIBRE CITY · js/server-sim-glue.js — colla HEADLESS per la simulazione autoritativa (Fase 2).
//
// NON è incluso in index.html: viene concatenato IN CODA al bundle della sim solo
// da server/sim-runtime.js (Node + vm), così condivide lo scope globale dei
// <script> classici del gioco e può leggere/scrivere player/cars/peds e chiamare
// update(). Qui vivono:
//   1) gli SHIM DI INPUT che nel browser stanno in input.js (assente sul server):
//      held/mouseWX/mouseWY/mDownL/mClicked/keys/touchDrive/… alimentati dal comando
//      di rete del giocatore attualmente in simulazione;
//   2) l'API di controllo `__sim` che l'harness Node richiama oltre il confine vm.
//
// (Stage 1: un solo giocatore, fermo al centro città; Stage 2 introdurrà players[].)

// ---- comando del giocatore attualmente simulato ----
var __curInput = { ax: 0, ay: 0, aim: 0, fireHeld: false, fireEdge: false };
var keys = {};                          // compat: alcune funzioni azzerano keys[...]
var touchDrive = { active: false, angle: 0 };
var usingTouch = false;
var missionsOn = false;                 // sul server autoritativo non ci sono missioni
var mDownL = false, mClicked = false;

// nel browser `held(...codes)` legge la tastiera; qui traduce gli assi del comando
function held(...codes) {
  const i = __curInput;
  for (const c of codes) {
    if ((c === 'KeyD' || c === 'ArrowRight') && i.ax > 0) return true;
    if ((c === 'KeyA' || c === 'ArrowLeft')  && i.ax < 0) return true;
    if ((c === 'KeyS' || c === 'ArrowDown')  && i.ay > 0) return true;
    if ((c === 'KeyW' || c === 'ArrowUp')    && i.ay < 0) return true;
  }
  return false;
}
// il mouse non esiste sul server: ricostruiamo un punto davanti al player a partire
// dall'angolo di mira trasmesso, così `atan2(mouseWY-y, mouseWX-x)` torna quell'angolo
function mouseWX() { return player.x + Math.cos(__curInput.aim) * 130; }
function mouseWY() { return player.y + Math.sin(__curInput.aim) * 130; }
function applyTouchInput() {}           // il tick lo guida la glue: nessun input touch da leggere

// ---- API di controllo (var top-level ⇒ diventa proprietà del global del contesto,
//      quindi leggibile da Node come ctx.__sim) ----
var __sim = {
  // avanza la simulazione di un tick per il giocatore singolo (Stage 1)
  tick(input) {
    if (input) __curInput = Object.assign(__curInput, input);
    mDownL = __curInput.fireHeld; mClicked = __curInput.fireEdge;
    update();
    __curInput.fireEdge = false;        // gli edge valgono un tick solo
  },
  setInput(input) { __curInput = Object.assign(__curInput, input || {}); },
  // la città generata dal seme: serve a verificare il determinismo host↔server
  worldInfo() {
    // il grafo stradale è una griglia a topologia fissa (nodes/edges costanti tra i
    // semi): per confrontare la mappa serve una firma del CONTENUTO seedato (grid +
    // tipi/posizioni dei landmark), identica solo a parità di codice stanza.
    let sig = 0;
    for (let i = 0; i < grid.length; i++) sig = (sig * 31 + grid[i]) | 0;
    for (const l of landmarks) sig = (sig * 31 + l.x0 * 7 + l.y0 * 13 + l.type.charCodeAt(0)) | 0;
    return { room: ROOM_CODE, worldW: WORLD_W, worldH: WORLD_H,
             nodes: nodes.length, edges: edges.length, landmarks: landmarks.length, sig };
  },
  counts() {
    return { frame, cars: cars.length, peds: peds.length, coins: coins.length,
             bullets: bullets.length, parts: parts.length };
  },
  playerPos() { return { x: Math.round(player.x), y: Math.round(player.y), health: player.health, inCar: !!player.car }; },
  carSnapshot() {
    return cars.map(c => ({ id: c.id, x: Math.round(c.x), y: Math.round(c.y),
                            role: c.role, sp: Math.round(c.speed * 100) / 100 }));
  },
};
