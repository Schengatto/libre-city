// LIBRE CITY · server/test-i18n.mjs — translation tests (it/en).
//   Usage:  node server/test-i18n.mjs   (included in `npm test`)
//
// Covers the two things that break on their own:
//   1. the KEYS used in the code and in index.html exist in BOTH languages (and the two
//      catalogues hold exactly the same keys);
//   2. the match events the server sends to clients are keys + parameters, NOT
//      pre-translated text: every player reads them in their own language.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import runtime from './sim-runtime.js';
const { createRoomSim } = runtime;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

// ---- 1. Catalogues --------------------------------------------------------
// The client sources are absent from the container (only server/sim/ is there): skipped.
const I18N = path.join(ROOT, 'js', 'i18n.js');
const HTML = path.join(ROOT, 'index.html');
if (!fs.existsSync(I18N) || !fs.existsSync(HTML)) {
  console.log('1) cataloghi: sorgenti del client assenti — salto');
} else {
  console.log('1) le chiavi usate esistono in italiano e in inglese');
  // i18n.js runs without a DOM/localStorage too: execute it as-is and take STR from it.
  const STR = new Function('localStorage', 'navigator', 'document',
    fs.readFileSync(I18N, 'utf8') + '\n;return STR;')({ getItem: () => null, setItem() {} }, { language: 'it' }, undefined);
  const it = new Set(Object.keys(STR.it)), en = new Set(Object.keys(STR.en));

  // Keys in use: every string shaped like 'group.name' in the sources (keys also travel
  // inside ternaries and as arguments, e.g. cancelTaxi('taxi.lost')).
  const used = new Set();
  for (const f of fs.readdirSync(path.join(ROOT, 'js'))) {
    if (!f.endsWith('.js')) continue;
    const s = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
    for (const m of s.matchAll(/'([a-z]+\.[A-Za-z0-9_]+)'/g)) used.add(m[1]);
  }
  for (const m of fs.readFileSync(HTML, 'utf8').matchAll(/data-i18n(?:-html|-ph|-title|-aria)?="([^"]+)"/g)) used.add(m[1]);
  // Keys composed at runtime ('net.err.' + err, 'weapon.' + w.k, STREAK_KEY).
  const RUNTIME = ['net.err.other', 'weapon.fists', 'weapon.pistol', 'weapon.smg', 'weapon.shotgun',
                   'weapon.grenade', 'weapon.flamer', 'weapon.rocket'];
  for (const k of RUNTIME) used.add(k);

  // Only strings whose GROUP exists in the catalogue count as keys, so that a
  // 'manifest.webmanifest' (a file name) is not mistaken for a translation.
  const groups = new Set([...it].map(k => k.split('.')[0]));
  const isKey = k => /^[a-z]+\.[A-Za-z0-9_]+$/.test(k) && !k.endsWith('.js') && groups.has(k.split('.')[0]);
  const missIt = [...used].filter(k => isKey(k) && !it.has(k));
  const missEn = [...used].filter(k => isKey(k) && !en.has(k));
  const onlyIt = [...it].filter(k => !en.has(k));
  const onlyEn = [...en].filter(k => !it.has(k));
  if (missIt.length) console.log('   mancanti in it:', missIt);
  if (missEn.length) console.log('   mancanti in en:', missEn);
  if (onlyIt.length) console.log('   solo in it:', onlyIt);
  if (onlyEn.length) console.log('   solo in en:', onlyEn);
  console.log(`   chiavi: ${it.size} it · ${en.size} en · ${used.size} usate`);
  ok(!missIt.length, 'nessuna chiave usata manca dal catalogo italiano');
  ok(!missEn.length, 'nessuna chiave usata manca dal catalogo inglese');
  ok(!onlyIt.length && !onlyEn.length, 'i due cataloghi hanno le stesse chiavi');
}

// ---- 2. Match events that are language-neutral ----------------------------
console.log('2) gli eventi PvP dello snapshot sono chiavi + parametri, non testo');
{
  const sim = createRoomSim('I18NEV');
  const X = sim.addPlayer('Alice', 0), Y = sim.addPlayer('Bob', 1);
  const px = sim._player(X), py = sim._player(Y);
  px.owned[1] = true; px.weaponIdx = 1;            // pistol
  py.health = 6; py.downT = 0;
  for (let i = 0; i < 40 && py.downT === 0; i++) {
    py.x = px.x + 22; py.y = px.y;                 // keep them in range
    sim.applyInput(X, { aim: 0, b: 2 });
    sim.tick();
  }
  const evK = sim.snapshotFor(X).me.ev, evV = sim.snapshotFor(Y).me.ev;
  console.log('   killer:', JSON.stringify(evK), '· vittima:', JSON.stringify(evV));
  ok(Array.isArray(evK) && evK.length === 1 && evK[0].k === 'pvp.killed',
     'al killer arriva la chiave pvp.killed');
  ok(evK && evK[0].p && evK[0].p.name === 'Bob', 'col nome della vittima come parametro');
  ok(Array.isArray(evV) && evV.length === 1 && evV[0].k === 'pvp.down' && evV[0].p.name === 'Alice',
     'alla vittima arriva pvp.down col nome del killer');
  ok(JSON.stringify(evK).indexOf('Hai steso') < 0, 'nessun testo italiano nel payload di rete');
}

console.log(fail === 0 ? `\n✅  ${pass} ok, 0 fail` : `\n❌  ${pass} ok, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
