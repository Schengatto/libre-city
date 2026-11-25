import vm from 'node:vm';
import runtime from './sim-runtime.js';
import stubs from '../js/sim-stubs.js';
const { BUNDLE } = runtime;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const context = vm.createContext(stubs.makeSimStubs('PROB0', 900, { setTimeout, clearTimeout, setInterval, clearInterval }));
vm.runInContext(BUNDLE, context, { timeout: 5000 });
const run = expr => vm.runInContext(expr, context);

const BOUNCE_OFF_WALL = hitAxis => `(() => {
  const realMoveBox = moveBox;
  const sharedDir = DIRS[${hitAxis === 'x' ? 0 : 2}];
  const before = DIRS.map(d => ({ x: d.x, y: d.y }));
  const robber = makePed(player.x + 200, player.y, 'robber');
  robber.dir = sharedDir;
  robber.thinkCd = 50;
  moveBox = entity => { entity.hitX = ${hitAxis === 'x'}; entity.hitY = ${hitAxis === 'y'}; };
  try { updateRobber(robber); } finally { moveBox = realMoveBox; }
  return {
    dirsIntact: DIRS.every((d, i) => d.x === before[i].x && d.y === before[i].y),
    robberDir: { x: robber.dir.x, y: robber.dir.y },
    sharedDirKept: robber.dir !== sharedDir,
    thinkCd: robber.thinkCd,
  };
})()`;

console.log('1) a robber bouncing off a wall leaves the shared DIRS vectors untouched');
const xBounce = run(BOUNCE_OFF_WALL('x'));
ok(xBounce.dirsIntact, 'DIRS unchanged after a horizontal wall bounce');
ok(xBounce.robberDir.x === -1 && xBounce.robberDir.y === 0, `robber reverses on X (dir ${JSON.stringify(xBounce.robberDir)})`);
ok(xBounce.sharedDirKept, 'robber gets a new direction object');
ok(xBounce.thinkCd <= 10, `robber rethinks soon after the bounce (thinkCd ${xBounce.thinkCd})`);

const yBounce = run(BOUNCE_OFF_WALL('y'));
ok(yBounce.dirsIntact, 'DIRS unchanged after a vertical wall bounce');
ok(yBounce.robberDir.x === 0 && yBounce.robberDir.y === -1, `robber reverses on Y (dir ${JSON.stringify(yBounce.robberDir)})`);

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
