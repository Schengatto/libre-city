'use strict';
// VIBE CITY · server/sim-runtime.js — HEADLESS harness for the simulation (Phase 2).
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
const SIM_FILES = ['core.js', 'mutators.js', 'i18n.js', 'city.js', 'race-track.js', 'train.js', 'entities.js', 'game-events.js', 'missions.js', 'army.js', 'gameplay.js', 'snapshot-codec.js', 'snapshot-delta.js', 'server-sim-glue.js'];
const BUNDLE = SIM_FILES
  .map(f => `\n//# ${f} ------------------------------------------------------------\n` + fs.readFileSync(path.join(JS_DIR, f), 'utf8'))
  .join('\n');
// Compiled ONCE and reused for every room (amortises the parse).
const SCRIPT = new vm.Script(BUNDLE, { filename: 'vibe-sim-bundle.js' });

const { makeSimStubs } = require(path.join(JS_DIR, 'sim-stubs.js'));

// Creates a room's simulation: isolated context, seed = room code. Returns the __sim API
// exposed by the glue.
function createRoomSim(code, opts = {}) {
  const view = opts.view || 900;                 // fixed simulation radius
  const ctx = makeSimStubs(String(code).toUpperCase(), view, { setTimeout, clearTimeout, setInterval, clearInterval });
  vm.createContext(ctx);
  SCRIPT.runInContext(ctx, { timeout: 5000 });   // city gen + seedWorld() run here
  if (!ctx.__sim) throw new Error('sim-runtime: la glue non ha esposto __sim');
  return ctx.__sim;
}

const MAX_CATCHUP_MS = 250;

function accumulateSimTime(accumulatorMs, elapsedMs) {
  return accumulatorMs + Math.min(elapsedMs, MAX_CATCHUP_MS);
}

module.exports = { createRoomSim, accumulateSimTime, MAX_CATCHUP_MS, BUNDLE, SIM_FILES, JS_DIR };
