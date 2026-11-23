const fs = require('node:fs');
const path = require('node:path');

const DEV_ONLY_BLOCK = /[ \t]*\/\/ dev-only:begin[\s\S]*?\/\/ dev-only:end[ \t]*\r?\n?/g;

function buildSimWorkerBundle(rootDir) {
  const { SIM_FILES } = require(path.join(rootDir, 'server', 'sim-runtime.js'));
  const readJs = name => fs.readFileSync(path.join(rootDir, 'js', name), 'utf8');
  const workerBody = readJs('sim-worker.js').replace(DEV_ONLY_BLOCK, '');
  return [readJs('sim-stubs.js'), workerBody, ...SIM_FILES.map(readJs)].join('\n');
}

module.exports = { buildSimWorkerBundle };
