import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import runtime from './sim-runtime.js';
const { JS_DIR } = runtime;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const context = vm.createContext({ TextEncoder, TextDecoder, btoa, atob, Uint8Array, JSON, Object, Array, String, Math });
vm.runInContext(fs.readFileSync(path.join(JS_DIR, 'storage-move.js'), 'utf8'), context, { filename: 'storage-move.js' });
const run = source => vm.runInContext(source, context);
const migrateStoragePrefix = storage => { context.__s = storage; return run('migrateStoragePrefix(__s)'); };
const encodeStorageExport = storage => { context.__s = storage; return run('encodeStorageExport(__s)'); };
const decodeStorageImport = encoded => { context.__e = encoded; return run('decodeStorageImport(__e)'); };
const importStorage = (storage, entries) => { context.__s = storage; context.__e = entries; return run('importStorage(__s, __e)'); };
const legacyHostRedirectUrl = (locationLike, storage) => { context.__l = locationLike; context.__s = storage; return run('legacyHostRedirectUrl(__l, __s)'); };
const bootStorageMove = (storage, locationLike, historyLike) => { context.__s = storage; context.__l = locationLike; context.__h = historyLike; run('bootStorageMove(__s, __l, __h)'); };

const b64url = text => Buffer.from(text, 'utf8').toString('base64url');
const makeStorage = entries => {
  const map = new Map(Object.entries(entries));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
    key: index => [...map.keys()][index] ?? null,
    get length() { return map.size; },
  };
};
const makeThrowingStorage = () => {
  const boom = () => { throw new Error('storage blocked'); };
  return { getItem: boom, setItem: boom, removeItem: boom, key: boom, get length() { return boom(); } };
};
const makeLocation = (hostname, search, hash) => {
  const location = { hostname, search, hash, pathname: '/', replaced: null, replace(url) { location.replaced = url; } };
  return location;
};
const makeHistory = () => {
  const history = { calls: [], replaceState(...args) { history.calls.push(args); } };
  return history;
};

console.log('prefix migration');
let s = makeStorage({ 'libreCity.lang': '"en"', 'libreCity.save': '{"v":3}', 'other': '1' });
ok(migrateStoragePrefix(s) === 2 && s.getItem('vibeCity.lang') === '"en"' && s.getItem('vibeCity.save') === '{"v":3}' && s.getItem('libreCity.lang') === null && s.getItem('other') === '1', 'moves libreCity.* to vibeCity.*');
s = makeStorage({ 'libreCity.lang': '"it"', 'vibeCity.lang': '"en"' });
migrateStoragePrefix(s);
ok(s.getItem('vibeCity.lang') === '"en"' && s.getItem('libreCity.lang') === null, 'existing vibeCity key wins, legacy key removed');

console.log('export and import');
s = makeStorage({ 'vibeCity.lang': '"en"', 'vibeCity.save': '{"v":3,"code":"ABCD","name":"Zoë"}', 'other': '1' });
const encoded = encodeStorageExport(s);
ok(/^[A-Za-z0-9_-]+$/.test(encoded), 'export is base64url');
ok(JSON.stringify(decodeStorageImport(encoded)) === JSON.stringify({ 'vibeCity.lang': '"en"', 'vibeCity.save': '{"v":3,"code":"ABCD","name":"Zoë"}' }), 'round trip keeps only vibeCity keys, unicode intact');
ok(encodeStorageExport(makeStorage({})) === '', 'empty export when no keys');

console.log('hostile input');
ok(decodeStorageImport('%%%') === null, 'bad base64 rejected');
ok(decodeStorageImport(b64url('not json')) === null, 'non-JSON payload rejected');
ok(JSON.stringify(decodeStorageImport(b64url(JSON.stringify({ token: '"x"', 'vibeCity.a': 'not json', 'vibeCity.b': 5, 'vibeCity.minutes': '5' })))) === '{"vibeCity.minutes":"5"}', 'foreign keys, non-JSON and non-string values dropped');

console.log('import whitelist');
const decodeEntries = entries => decodeStorageImport(b64url(JSON.stringify(entries)));
const validScore = { name: 'ANNA', score: 120, min: 5, date: 1700000000000 };
ok(decodeEntries({ 'vibeCity.scores': 'null' })['vibeCity.scores'] === undefined, 'scores null dropped');
ok(decodeEntries({ 'vibeCity.scores': '{}' })['vibeCity.scores'] === undefined, 'scores object dropped');
ok(decodeEntries({ 'vibeCity.scores': '[null]' })['vibeCity.scores'] === undefined, 'scores with null entry dropped');
ok(decodeEntries({ 'vibeCity.scores': JSON.stringify([{ name: 'A', score: 'x' }]) })['vibeCity.scores'] === undefined, 'scores with non-numeric score dropped');
ok(decodeEntries({ 'vibeCity.scores': JSON.stringify(Array(11).fill(validScore)) })['vibeCity.scores'] === undefined, 'scores over 10 entries dropped');
ok(decodeEntries({ 'vibeCity.name': JSON.stringify('x'.repeat(15)) })['vibeCity.name'] === undefined, 'oversized name dropped');
ok(decodeEntries({ 'vibeCity.name': '""' })['vibeCity.name'] === undefined, 'empty name dropped');
ok(decodeEntries({ 'vibeCity.lang': '"fr"' })['vibeCity.lang'] === undefined, 'unknown language dropped');
ok(decodeEntries({ 'vibeCity.minutes': '"5"' })['vibeCity.minutes'] === undefined, 'non-numeric minutes dropped');
ok(decodeEntries({ 'vibeCity.audio': '1' })['vibeCity.audio'] === undefined, 'non-boolean audio dropped');
ok(decodeEntries({ 'vibeCity.save': '[1]' })['vibeCity.save'] === undefined && decodeEntries({ 'vibeCity.save': 'null' })['vibeCity.save'] === undefined, 'save must be a plain object');
const intents = decodeEntries({ 'vibeCity.hostIntent': '{"code":"X"}', 'vibeCity.spIntent': '{"code":"X"}', 'vibeCity.loadIntent': '{}', 'vibeCity.joinIntent': '{}' });
ok(Object.keys(intents).length === 0, 'one-shot intent keys dropped');
ok(Object.keys(decodeStorageImport(b64url('{"__proto__":"{}","constructor":"{}","vibeCity.name":"\\"Zed\\""}'))).join() === 'vibeCity.name', '__proto__ and constructor keys dropped');
const validEntries = { 'vibeCity.name': '"Anna"', 'vibeCity.lang': '"it"', 'vibeCity.scores': JSON.stringify([validScore]), 'vibeCity.save': '{"v":3,"code":"ABCD"}', 'vibeCity.minutes': '5', 'vibeCity.audio': 'true', 'vibeCity.music': 'false' };
ok(JSON.stringify(decodeEntries(validEntries)) === JSON.stringify(validEntries), 'valid entries import together');
ok(Object.keys(decodeEntries({ 'vibeCity.name': '"   "' })).length === 0, 'whitespace-only name dropped');
ok(Object.keys(decodeEntries({ 'vibeCity.name': '" Anna"' })).length === 0, 'padded name dropped');
ok(Object.keys(decodeEntries({ 'vibeCity.minutes': '7' })).length === 0, 'unsupported duration dropped');
ok([0, 5, 10, 15, 30, 60].every(minutes => decodeEntries({ 'vibeCity.minutes': String(minutes) })['vibeCity.minutes'] === String(minutes)), 'all UI durations accepted');
ok(Object.keys(decodeEntries({ 'vibeCity.save': '{"v":3}' })).length === 0, 'save without a string code dropped');
ok(Object.keys(decodeEntries({ 'vibeCity.save': '{"code":"ABCD","name":42}' })).length === 0, 'save with non-string name dropped');
ok(decodeEntries({ 'vibeCity.scores': JSON.stringify([{ ...validScore, extra: 'discard' }]) })['vibeCity.scores'] === JSON.stringify([validScore]), 'extra score fields dropped');
const capPayload = JSON.stringify({ 'vibeCity.minutes': '5' });
const paddedPayload = byteLength => b64url(capPayload.padEnd(byteLength));
ok(decodeStorageImport(paddedPayload(149999))['vibeCity.minutes'] === '5', 'valid payload just under the cap accepted');
ok(decodeStorageImport(paddedPayload(150001)) === null, 'valid payload just over the cap rejected');
s = makeStorage({ 'vibeCity.save': JSON.stringify({ v: 3, pad: 'x'.repeat(200000) }) });
ok(encodeStorageExport(s) === '', 'oversize export is empty');
ok(legacyHostRedirectUrl({ hostname: 'libre-city.schengatto.com', search: '?room=ABCD' }, s) === 'https://vibecity.schengatto.com/?room=ABCD', 'oversize export redirects without data');

console.log('import guard');
s = makeStorage({});
ok(importStorage(s, { 'vibeCity.lang': '"en"' }) && s.getItem('vibeCity.lang') === '"en"', 'imports into empty origin');
s = makeStorage({ 'vibeCity.lang': '"it"' });
ok(!importStorage(s, { 'vibeCity.lang': '"en"' }) && s.getItem('vibeCity.lang') === '"it"', 'refuses when origin already has data');

console.log('redirect url');
s = makeStorage({ 'vibeCity.lang': '"en"' });
ok(legacyHostRedirectUrl({ hostname: 'libre-city.schengatto.com', search: '?room=ABCD' }, s) === `https://vibecity.schengatto.com/?room=ABCD#vc-import=${encodeStorageExport(s)}`, 'legacy host redirects with query and data');
ok(legacyHostRedirectUrl({ hostname: 'libre-city.schengatto.com', search: '' }, makeStorage({})) === 'https://vibecity.schengatto.com/', 'legacy host without data redirects without fragment');
ok(legacyHostRedirectUrl({ hostname: 'vibecity.schengatto.com', search: '' }, s) === null, 'new host never redirects');

console.log('boot');
const fragment = `#vc-import=${encodeStorageExport(makeStorage({ 'vibeCity.lang': '"en"' }))}`;
s = makeStorage({});
let location = makeLocation('vibecity.schengatto.com', '?room=ABCD', fragment);
let history = makeHistory();
bootStorageMove(s, location, history);
ok(s.getItem('vibeCity.lang') === '"en"', 'new host imports the fragment');
ok(history.calls.length === 1 && history.calls[0][0] === null && history.calls[0][1] === '' && history.calls[0][2] === '/?room=ABCD', 'fragment stripped through replaceState');
ok(location.replaced === null, 'new host does not redirect');

s = makeStorage({ 'vibeCity.lang': '"it"' });
location = makeLocation('vibecity.schengatto.com', '', fragment);
history = makeHistory();
bootStorageMove(s, location, history);
ok(s.getItem('vibeCity.lang') === '"it"' && history.calls.length === 1, 'existing data untouched, fragment still stripped');

s = makeStorage({});
location = makeLocation('vibecity.schengatto.com', '', '#other=1');
history = makeHistory();
bootStorageMove(s, location, history);
ok(history.calls.length === 0 && s.length === 0, 'foreign fragment ignored');

s = makeStorage({ 'libreCity.lang': '"en"' });
location = makeLocation('libre-city.schengatto.com', '?room=ABCD', '');
history = makeHistory();
bootStorageMove(s, location, history);
ok(s.getItem('vibeCity.lang') === '"en"' && s.getItem('libreCity.lang') === null, 'legacy host migrates prefix first');
ok(location.replaced === `https://vibecity.schengatto.com/?room=ABCD#vc-import=${encodeStorageExport(s)}`, 'legacy host redirects with migrated data');

location = makeLocation('libre-city.schengatto.com', '', '');
history = makeHistory();
let threw = false;
try { bootStorageMove(makeThrowingStorage(), location, history); } catch { threw = true; }
ok(!threw && location.replaced === 'https://vibecity.schengatto.com/', 'throwing storage on legacy host still redirects');

console.log('auto-boot');
const autoBootSource = fs.readFileSync(path.join(JS_DIR, 'storage-move.js'), 'utf8');
const blockedStorageLocation = makeLocation('libre-city.schengatto.com', '', '');
const blockedStorageContext = vm.createContext({ TextEncoder, TextDecoder, btoa, atob, Uint8Array, location: blockedStorageLocation, history: makeHistory() });
Object.defineProperty(blockedStorageContext, 'localStorage', { get() { throw new Error('SecurityError'); } });
vm.runInContext(autoBootSource, blockedStorageContext, { filename: 'storage-move.js' });
ok(blockedStorageLocation.replaced === 'https://vibecity.schengatto.com/', 'auto-boot redirects the legacy host when localStorage access throws');

const throwingHistoryStorage = makeStorage({ 'libreCity.lang': '"en"' });
location = makeLocation('vibecity.schengatto.com', '', fragment);
bootStorageMove(throwingHistoryStorage, location, { replaceState() { throw new Error('history blocked'); } });
ok(throwingHistoryStorage.getItem('vibeCity.lang') === '"en"' && throwingHistoryStorage.getItem('libreCity.lang') === null, 'prefix migration still runs when replaceState throws');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
