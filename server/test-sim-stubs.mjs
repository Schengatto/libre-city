import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const stubsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'js', 'sim-stubs.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const { makeSimStubs } = require(stubsPath);
const timers = { setTimeout, clearTimeout, setInterval, clearInterval };
const stubs = makeSimStubs('ABCD', 900, timers);

const EXPECTED_KEYS = [
  'document', 'window', 'navigator', 'location', 'localStorage', 'innerWidth', 'innerHeight',
  'addEventListener', 'removeEventListener', 'requestAnimationFrame',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'matchMedia', 'visualViewport', 'AudioContext', 'webkitAudioContext', 'console',
  'sfx', 'sfxCd', 'hear', 'initAudio', 'engineGain', 'updateTrafficEngine', 'playerSirenOn',
  'toast', '$', 'updateHealth', 'updateCash', 'updateStars', 'updateWeapon',
  'updateTimer', 'updateGear', 'updateWpnBar', 'updateToast', 'endGame', 'renderLadder',
  'netActive', 'netTick', 'netSolidCars', 'netAssignCarId', 'netAbandonCar', 'netDestroyCar',
  'netShotFired', 'netPunched', 'netRocketFired', 'netReportDown', 'netRegisterHit',
  'netCopPayloads', 'netParkCar', 'netApplyCops', 'netScoreKill',
];

console.log('sim stubs');
ok(stubs.location.hash === '#room=ABCD', 'location.hash carries the room code');
ok(stubs.innerWidth === 900 && stubs.innerHeight === 900, 'view size drives the window size');
ok(stubs.netActive() === false, 'netActive is false');
ok(typeof stubs.sfx.anything === 'function', 'sfx answers any sound with a function');
ok(stubs.document.getElementById('x').getBoundingClientRect().width === 900, 'fake element uses the view size');
ok(stubs.setTimeout === timers.setTimeout && stubs.clearInterval === timers.clearInterval, 'timers come from the argument');
ok(stubs.netSolidCars(null).length === 0 && stubs.netSolidCars([1])[0] === 1, 'netSolidCars passes the output list through');
ok(stubs.playerSirenOn() === false, 'playerSirenOn is false');
const missingKeys = EXPECTED_KEYS.filter(key => !(key in stubs));
ok(missingKeys.length === 0, 'every stub key is present' + (missingKeys.length ? ': ' + missingKeys.join(', ') : ''));

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
