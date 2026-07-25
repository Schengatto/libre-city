'use strict';
// LIBRE CITY · server/sim-runtime.js — HEADLESS harness for the simulation (Phase 2).
//
// Runs the SAME simulation as the client (core → city → entities → missions → army →
// gameplay) on Node, without a browser, so the server can own the world (traffic,
// pedestrians, police) and remove the divergence between players.
//
// The game's files are classic <script> tags sharing ONE single global scope: in Node we
// reproduce that by concatenating them into ONE bundle and running it as a SINGLE
// `vm.Script` per room (so one file's top-level const/let stay visible to the others). The
// headless glue (js/server-sim-glue.js) goes last: it supplies the input shims (input.js is
// excluded) and exposes the `__sim` API. Everything presentational or IO-bound
// (render/audio/ui/net) is absent and STUBBED to no-ops on the context's global.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The sim sources live in ../js during development; the deploy copies them into ./sim (see
// deploy-vps.sh / Dockerfile), so we try ./sim first and then ../js.
const SIM_DIRS = [path.resolve(__dirname, 'sim'), path.resolve(__dirname, '..', 'js')];
const JS_DIR = SIM_DIRS.find(d => fs.existsSync(path.join(d, 'gameplay.js')));
if (!JS_DIR) throw new Error('sim-runtime: sorgenti della simulazione non trovati in ' + SIM_DIRS.join(' | '));

// The browser's load order minus input/render/audio/ui/net, plus the glue. i18n.js is needed
// because the sim calls t()/tList() (pedestrian speech bubbles, and messages that locally end
// up in toasts): without it the bundle does not run.
const SIM_FILES = ['core.js', 'i18n.js', 'city.js', 'train.js', 'entities.js', 'missions.js', 'army.js', 'gameplay.js', 'server-sim-glue.js'];
const BUNDLE = SIM_FILES
  .map(f => `\n//# ${f} ------------------------------------------------------------\n` + fs.readFileSync(path.join(JS_DIR, f), 'utf8'))
  .join('\n');
// Compiled ONCE and reused for every room (amortises the parse).
const SCRIPT = new vm.Script(BUNDLE, { filename: 'libre-sim-bundle.js' });

const NOOP = () => {};

// The "fake browser" the sim runs on: an inert DOM/window plus the whole
// presentation/network layer stubbed to no-ops. `view` is the fixed simulation radius (it
// replaces the window size: on the server the world does not depend on a screen).
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
    // ---- Inert browser environment ----
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
    // ---- No presentation layer (render/audio/ui): no-ops ----
    sfx, sfxCd: {}, hear: () => null, initAudio: NOOP, engineGain: NOOP, updateTrafficEngine: NOOP,
    playerSirenOn: () => false,           // the siren is client-side audio: no server-side logic
    toast: NOOP, $: () => fakeEl,
    updateHealth: NOOP, updateCash: NOOP, updateStars: NOOP, updateWeapon: NOOP,
    updateTimer: NOOP, updateGear: NOOP, updateWpnBar: NOOP, updateToast: NOOP,
    endGame: NOOP, renderLadder: NOOP,
    // ---- No networking (net.js): the server IS the authority, so no-ops ----
    netActive: () => false, netTick: NOOP, netSolidCars: out => out || [],
    netAssignCarId: NOOP, netAbandonCar: NOOP, netDestroyCar: NOOP,
    netShotFired: NOOP, netPunched: NOOP, netRocketFired: NOOP,
    netReportDown: NOOP, netRegisterHit: NOOP, netCopPayloads: () => null,
    netParkCar: NOOP, netApplyCops: NOOP, netScoreKill: NOOP,
  };
  return stub;
}

// Creates a room's simulation: isolated context, seed = room code. Returns the __sim API
// exposed by the glue.
function createRoomSim(code, opts = {}) {
  const view = opts.view || 900;                 // fixed simulation radius
  const ctx = makeBrowserStub(String(code).toUpperCase(), view);
  vm.createContext(ctx);
  SCRIPT.runInContext(ctx, { timeout: 5000 });   // city gen + seedWorld() run here
  if (!ctx.__sim) throw new Error('sim-runtime: la glue non ha esposto __sim');
  return ctx.__sim;
}

module.exports = { createRoomSim, BUNDLE, SIM_FILES, JS_DIR };
