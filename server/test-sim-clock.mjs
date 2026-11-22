import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { accumulateSimTime, MAX_CATCHUP_MS } = require('./sim-runtime.js');

const STEP = 1000 / 60;
let ok = 0, fail = 0;
const check = (cond, msg, extra) => {
  if (cond) { ok++; console.log('  OK  ' + msg); }
  else { fail++; console.log('  ✗   ' + msg + (extra ? ' → ' + extra : '')); }
};

check(MAX_CATCHUP_MS === 250, 'catch-up limit is 250 ms', MAX_CATCHUP_MS);
check(accumulateSimTime(5, 17) === 22, 'a normal interval is added in full');

const hypervisorPauseMs = 170;
const ticksAfterPause = Math.floor(accumulateSimTime(0, hypervisorPauseMs) / STEP);
check(ticksAfterPause === 10, 'a 170 ms vCPU pause is fully recovered (10 ticks)', ticksAfterPause);

check(accumulateSimTime(0, 5000) === MAX_CATCHUP_MS, 'a long stall is clamped to the catch-up limit');
check(accumulateSimTime(3, 5000) === 3 + MAX_CATCHUP_MS, 'the clamp applies to the elapsed time, not the leftover');

console.log(`\n${ok} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
