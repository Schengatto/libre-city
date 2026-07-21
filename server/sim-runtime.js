'use strict';
// LIBRE CITY · server/sim-runtime.js — harness HEADLESS della simulazione (Fase 2).
//
// Esegue la STESSA simulazione del client (core → city → entities → missions →
// army → gameplay) su Node, senza browser, così il server può possedere il mondo
// (traffico, pedoni, polizia) ed eliminare il disallineamento tra i giocatori.
//
// I file del gioco sono <script> classici che condividono UN unico scope globale:
// in Node li riproduciamo concatenandoli in UN solo bundle ed eseguendolo come UN
// unico `vm.Script` per stanza (così i const/let top-level di un file restano
// visibili agli altri). La glue headless (js/server-sim-glue.js) è in coda: fornisce
// gli shim di input (input.js è escluso) ed espone l'API `__sim`. Tutto ciò che è
// presentazione/IO (render/audio/ui/net) è assente e viene STUBBATO a no-op sul
// global del contesto.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// I sorgenti sim vivono in ../js in sviluppo; il deploy li copia in ./sim (vedi
// deploy-vps.sh / Dockerfile), quindi proviamo prima ./sim e poi ../js.
const SIM_DIRS = [path.resolve(__dirname, 'sim'), path.resolve(__dirname, '..', 'js')];
const JS_DIR = SIM_DIRS.find(d => fs.existsSync(path.join(d, 'gameplay.js')));
if (!JS_DIR) throw new Error('sim-runtime: sorgenti della simulazione non trovati in ' + SIM_DIRS.join(' | '));

// ordine di caricamento del browser meno input/render/audio/ui/net, + la glue
const SIM_FILES = ['core.js', 'city.js', 'train.js', 'entities.js', 'missions.js', 'army.js', 'gameplay.js', 'server-sim-glue.js'];
const BUNDLE = SIM_FILES
  .map(f => `\n//# ${f} ------------------------------------------------------------\n` + fs.readFileSync(path.join(JS_DIR, f), 'utf8'))
  .join('\n');
// compilato UNA volta e riusato per ogni stanza (ammortizza il parse)
const SCRIPT = new vm.Script(BUNDLE, { filename: 'libre-sim-bundle.js' });

const NOOP = () => {};

// il "browser finto" su cui gira la sim: DOM/finestra inerti + tutto lo strato di
// presentazione/rete stubbato a no-op. `view` è il raggio di simulazione fisso
// (rimpiazza la dimensione della finestra: sul server il mondo non dipende da uno schermo).
function makeBrowserStub(code, view) {
  const fakeEl = {
    width: 0, height: 0, style: {}, textContent: '', value: '',
    getContext: () => new Proxy({}, { get: () => NOOP }),
    addEventListener: NOOP, removeEventListener: NOOP, appendChild: NOOP,
    classList: { add: NOOP, remove: NOOP, toggle: NOOP, contains: () => false },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: view, height: view }),
    focus: NOOP, select: NOOP, setAttribute: NOOP,
  };
  const sfx = new Proxy({}, { get: () => NOOP });
  const stub = {
    // ---- ambiente browser inerte ----
    document: { getElementById: () => fakeEl, querySelector: () => fakeEl, querySelectorAll: () => [],
                createElement: () => fakeEl, body: fakeEl, addEventListener: NOOP },
    window: {}, navigator: {}, location: { hash: '#room=' + code, search: '', href: '' },
    localStorage: { getItem: () => null, setItem: NOOP, removeItem: NOOP },
    innerWidth: view, innerHeight: view,
    addEventListener: NOOP, removeEventListener: NOOP, requestAnimationFrame: NOOP,
    setTimeout, clearTimeout, setInterval, clearInterval,
    matchMedia: () => ({ matches: false, addEventListener: NOOP }),
    visualViewport: undefined, AudioContext: undefined, webkitAudioContext: undefined,
    console,
    // ---- presentazione assente (render/audio/ui): no-op ----
    sfx, sfxCd: {}, hear: () => null, initAudio: NOOP, engineGain: NOOP, updateTrafficEngine: NOOP,
    playerSirenOn: () => false,           // la sirena è audio del client: niente logica lato server
    toast: NOOP, $: () => fakeEl,
    updateHealth: NOOP, updateCash: NOOP, updateStars: NOOP, updateWeapon: NOOP,
    updateTimer: NOOP, updateGear: NOOP, updateWpnBar: NOOP, updateToast: NOOP,
    endGame: NOOP, renderLadder: NOOP,
    // ---- rete (net.js) assente: il server È l'autorità, quindi no-op ----
    netActive: () => false, netTick: NOOP, netSolidCars: out => out || [],
    netAssignCarId: NOOP, netAbandonCar: NOOP, netDestroyCar: NOOP,
    netShotFired: NOOP, netPunched: NOOP, netRocketFired: NOOP,
    netReportDown: NOOP, netRegisterHit: NOOP, netCopPayloads: () => null,
    netParkCar: NOOP, netApplyCops: NOOP, netScoreKill: NOOP,
  };
  return stub;
}

// crea la simulazione di una stanza: contesto isolato, seme = codice stanza.
// Ritorna l'API __sim esposta dalla glue.
function createRoomSim(code, opts = {}) {
  const view = opts.view || 900;                 // raggio di simulazione fisso
  const ctx = makeBrowserStub(String(code).toUpperCase(), view);
  vm.createContext(ctx);
  SCRIPT.runInContext(ctx, { timeout: 5000 });   // qui girano city gen + seedWorld()
  if (!ctx.__sim) throw new Error('sim-runtime: la glue non ha esposto __sim');
  return ctx.__sim;
}

module.exports = { createRoomSim, BUNDLE, SIM_FILES, JS_DIR };
