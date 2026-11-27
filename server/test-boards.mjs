import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) { pass++; console.log('  OK ', message); } else { fail++; console.log('  XX FAIL:', message); }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-boards-'));
const BOARDS_FILE = path.join(TMP, 'boards.json');
process.env.BOARDS_FILE = BOARDS_FILE;

function loadFresh() {
  const modulePath = require.resolve('./boards.js');
  delete require.cache[modulePath];
  return require(modulePath);
}
const readFile = () => JSON.parse(fs.readFileSync(BOARDS_FILE, 'utf8'));
const DAY = 24 * 60 * 60_000;

let boards = loadFresh();

console.log('# board id grammar and kinds');
{
  ok(boards.submit('shift:taxi:all', { name: 'A', value: 1 }) !== null, 'shift all-time id accepted');
  ok(boards.submit('shift:fire:2026-W48', { name: 'A', value: 1 }) !== null, 'shift weekly id accepted');
  ok(boards.submit('shift:bus:all', { name: 'A', value: 1 }) === null, 'unknown job refused');
  ok(boards.submit('shift:taxi:2026-48', { name: 'A', value: 1 }) === null, 'malformed week refused');
  ok(boards.submit('daily:2026-11-27', { name: 'A', value: 1 }) === null, 'unregistered kind refused on write');
  ok(boards.top('daily:2026-11-27').ok === false, 'unregistered kind refused on read');
  ok(boards.top('nonsense').error === 'bad_board', 'garbage id refused on read');
  ok(boards.submit('shift:taxi:all', { name: '   ', value: 5 }) === null, 'empty name refused');
  ok(boards.submit('shift:taxi:all', { name: 'A', value: NaN }) === null, 'non-finite value refused');
  let threw = false;
  try { boards.defineBoardKind('bogus', { order: 'desc', maxEntries: 10 }); } catch { threw = true; }
  ok(threw, 'kind outside the grammar cannot be defined');
  boards.defineBoardKind('race', { order: 'asc', maxEntries: 3, retainDays: null });
  ok(boards.submit('race:ABCD:1', { name: 'A', value: 1 }) !== null, 'race id accepted once defined');
  ok(boards.submit('race:abcd:1', { name: 'A', value: 1 }) === null, 'race code must be uppercase');
  boards._reset();
}

console.log('# best per name, desc');
{
  const id = 'shift:taxi:all';
  const first = boards.submit(id, { name: 'Fede', value: 100, ms: 300000, at: 1000 });
  ok(first.rank === 1 && first.best === 100 && first.improved, 'first entry ranked 1 and improved');
  const worse = boards.submit(id, { name: 'fede ', value: 80, at: 2000 });
  ok(!worse.improved && worse.best === 100 && worse.rank === 1, 'worse run does not replace a better one');
  const equal = boards.submit(id, { name: 'FEDE', value: 100, at: 3000 });
  ok(!equal.improved && boards.top(id).entries[0].at === 1000, 'equal value keeps the older entry');
  const better = boards.submit(id, { name: 'FEDE', value: 150, at: 4000 });
  ok(better.improved && better.best === 150, 'better run replaces the entry');
  const view = boards.top(id);
  ok(view.total === 1 && view.entries[0].name === 'FEDE', 'one entry per normalized name, last display name');
  boards.submit(id, { name: 'Ann', value: 200, at: 5000 });
  boards.submit(id, { name: 'Bob', value: 150, at: 3500 });
  const ranked = boards.top(id).entries;
  ok(ranked.map(entry => entry.name).join(',') === 'Ann,Bob,FEDE', 'desc order, ties by earlier at');
  ok(ranked.map(entry => entry.rank).join(',') === '1,2,3', 'ranks are 1-based positions');
  ok(boards.top(id, 2).entries.length === 2 && boards.top(id, 2).total === 3, 'limit cuts entries, total stays');
  const withMe = boards.top(id, 1, 'fede');
  ok(withMe.me && withMe.me.rank === 3 && withMe.me.value === 150, 'me carries rank and value');
  ok(!('me' in boards.top(id, 1, 'nobody')), 'no me for an unknown name');
  ok(boards.top('shift:pizza:all').total === 0 && boards.top('shift:pizza:all').ok, 'empty board reads fine');
  ok(boards.top(id).order === 'desc', 'order reported');
  boards._reset();
}

console.log('# asc kind, trim and meta cap');
{
  boards.defineBoardKind('race', { order: 'asc', maxEntries: 3, retainDays: null });
  const id = 'race:ABCD:2';
  boards.submit(id, { name: 'A', value: 50, at: 1 });
  boards.submit(id, { name: 'B', value: 40, at: 2 });
  boards.submit(id, { name: 'C', value: 60, at: 3 });
  ok(boards.top(id).entries.map(entry => entry.name).join(',') === 'B,A,C', 'asc ranks lower value first');
  ok(boards.submit(id, { name: 'A', value: 55 }).improved === false, 'higher time is worse in asc');
  const tooSlow = boards.submit(id, { name: 'D', value: 70 });
  ok(tooSlow.rank === null && !tooSlow.improved && boards.top(id).total === 3, 'run below the cut is dropped');
  const fast = boards.submit(id, { name: 'E', value: 10 });
  ok(fast.rank === 1 && boards.top(id).total === 3, 'maxEntries trims the worst');
  ok(!boards.top(id).entries.some(entry => entry.name === 'C'), 'worst entry trimmed');
  const callerMeta = { jobs: 17 };
  boards.submit(id, { name: 'F', value: 1, meta: callerMeta });
  callerMeta.jobs = 99;
  ok(boards.top(id).entries[0].meta.jobs === 17, 'small meta kept as a copy');
  boards.submit(id, { name: 'G', value: 0, meta: { blob: 'x'.repeat(300) } });
  ok(!('meta' in boards.top(id).entries[0]), 'meta over 256 bytes dropped');
  ok(boards.top(id, 999).entries.length === 3, 'limit clamped to maxEntries');
  boards._reset();
}

console.log('# iso week and day ids');
{
  ok(boards.isoWeekId(Date.UTC(2026, 10, 27)) === '2026-W48', '2026-11-27 is 2026-W48');
  ok(boards.isoWeekId(Date.UTC(2021, 0, 3)) === '2020-W53', '2021-01-03 belongs to 2020-W53');
  ok(boards.isoWeekId(Date.UTC(2024, 11, 30)) === '2025-W01', '2024-12-30 belongs to 2025-W01');
  ok(boards.isoWeekId(Date.UTC(2026, 10, 23, 0, 0)) === '2026-W48', 'Monday 00:00 UTC starts the week');
  ok(boards.isoWeekId(Date.UTC(2026, 10, 22, 23, 59)) === '2026-W47', 'Sunday 23:59 UTC ends the previous week');
  ok(boards.dayId(Date.UTC(2026, 0, 5, 23, 59)) === '2026-01-05', 'dayId is UTC YYYY-MM-DD');
}

console.log('# retention with an injected clock');
{
  boards.submit('shift:taxi:all', { name: 'A', value: 1 });
  boards.submit('shift:taxi:2026-W40', { name: 'A', value: 1 });
  boards.submit('shift:taxi:2026-W48', { name: 'A', value: 1 });
  const week40End = Date.UTC(2026, 9, 5);
  boards.sweep(week40End + 56 * DAY - 1);
  ok(boards.listBoards('shift:taxi:').length === 3, 'weekly board kept within 8 weeks of its end');
  boards.sweep(week40End + 56 * DAY + 1);
  ok(boards.listBoards('shift:taxi:').join(',') === 'shift:taxi:2026-W48,shift:taxi:all', 'expired weekly board deleted');
  boards.sweep(Date.UTC(2040, 0, 1));
  ok(boards.listBoards('shift:taxi:').join(',') === 'shift:taxi:all', 'all-time board kept forever');
  boards.defineBoardKind('daily', { order: 'desc', maxEntries: 100 });
  boards.submit('daily:2020-01-01', { name: 'A', value: 1 });
  boards.sweep(Date.UTC(2040, 0, 1));
  ok(boards.listBoards('daily:').length === 1, 'kind without retainDays is never swept');
  boards._reset();
}

console.log('# 400-board cap');
{
  boards.submit('shift:taxi:all', { name: 'A', value: 1 });
  for (let day = 0; day < boards.MAX_BOARDS + 5; day++) {
    boards.submit(`daily:${boards.dayId(Date.UTC(2026, 0, 1) + day * DAY)}`, { name: 'A', value: 1 });
  }
  boards.sweep(Date.UTC(2026, 0, 1));
  ok(boards.listBoards().length === boards.MAX_BOARDS, 'total boards capped at 400');
  ok(!boards.listBoards('daily:').includes('daily:2026-01-01'), 'oldest dated boards go first');
  ok(boards.listBoards().includes('shift:taxi:all'), 'all-time boards survive the cap');
  boards._reset();
}

console.log('# listBoards and deleteBoard');
{
  boards.submit('shift:taxi:2026-W48', { name: 'A', value: 1 });
  boards.submit('shift:pizza:all', { name: 'A', value: 1 });
  boards.submit('shift:taxi:all', { name: 'A', value: 1 });
  boards.submit('daily:2026-11-27', { name: 'A', value: 1 });
  ok(boards.listBoards('shift:').join(',') === 'shift:pizza:all,shift:taxi:2026-W48,shift:taxi:all', 'prefix filter, sorted ascending');
  ok(boards.listBoards().length === 4, 'empty prefix lists every board');
  ok(boards.listBoards('weekly:').length === 0, 'unknown prefix lists nothing');
  ok(boards.deleteBoard('shift:pizza:all') === true, 'deleteBoard true on an existing board');
  ok(boards.deleteBoard('shift:pizza:all') === false, 'deleteBoard false on a missing board');
  boards.flush();
  ok(!('shift:pizza:all' in readFile().boards), 'deletion persisted by flush');
}

console.log('# nonces');
{
  const future = Date.now() + 60_000;
  ok(boards.consumeNonce('n1', future, { ok: true, value: 7 }) === true, 'first consume succeeds');
  ok(boards.consumeNonce('n1', future, { ok: true, value: 9 }) === false, 'second consume refused');
  ok(boards.lookupNonce('n1').value === 7, 'lookup returns the stored response');
  ok(boards.lookupNonce('missing') === null, 'lookup of unknown nonce is null');
  boards.consumeNonce('expired', Date.now() - 1, { ok: true });
  boards.flush();
  const stored = readFile().usedNonces;
  ok('n1' in stored && !('expired' in stored), 'expired nonces pruned at save');
  ok(boards.lookupNonce('expired') === null, 'pruned nonce gone from memory');
  for (let index = 0; index < boards.MAX_NONCES + 10; index++) boards.consumeNonce(`cap${index}`, future, true);
  ok(boards.lookupNonce('n1') === null && boards.lookupNonce('cap9') === null, 'cap drops the oldest nonces first');
  ok(boards.lookupNonce('cap10') === true, 'newer nonces kept under the cap');
  boards.flush();
  ok(Object.keys(readFile().usedNonces).length === boards.MAX_NONCES, 'nonce map capped at 50 000');
  boards._reset();
}

console.log('# persistence and reload');
{
  boards.submit('shift:taxi:all', { name: 'Fede', value: 4820, ms: 300000, at: 1234, meta: { jobs: 17 } });
  boards.consumeNonce('keep', Date.now() + 60_000, { ok: true, value: 4820 });
  ok(readFile().boards['shift:taxi:all']?.entries[0].name !== 'Fede', 'write is debounced, not immediate');
  boards.flush();
  const data = readFile();
  ok(data.v === 1 && typeof data.savedAt === 'number', 'file has version and savedAt');
  ok(!fs.existsSync(BOARDS_FILE + '.tmp'), 'no temp file left behind');
  boards = loadFresh();
  const reloaded = boards.top('shift:taxi:all', 10, 'fede');
  ok(reloaded.total === 1 && reloaded.entries[0].value === 4820 && reloaded.entries[0].meta.jobs === 17, 'boards survive a reload');
  ok(boards.lookupNonce('keep').value === 4820, 'nonces survive a reload');
}

console.log('# corrupt file recovery');
{
  boards._reset();
  fs.writeFileSync(BOARDS_FILE, '{not json');
  boards = loadFresh();
  const quarantined = fs.readdirSync(TMP).filter(file => file.startsWith('boards.json.bad-'));
  ok(quarantined.length === 1, 'corrupt file renamed to .bad-<ts>');
  ok(!fs.existsSync(BOARDS_FILE), 'original path freed');
  ok(boards.listBoards().length === 0, 'starts empty after a corrupt file');
  ok(boards.submit('shift:taxi:all', { name: 'A', value: 1 }).improved, 'still accepts submissions');
  boards.flush();
  ok(readFile().boards['shift:taxi:all'].entries.length === 1, 'writes a fresh file after recovery');
  boards._reset();
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
