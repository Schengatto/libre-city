/* VIBE CITY — top-down city driving game.
   Split into 10 classic scripts sharing the global scope (no modules, so it also
   runs from file://). Load order (see index.html): core → city → entities → input
   → missions → army → gameplay → render → audio → ui. Files call into each other
   freely; the order only matters for code that runs at load time. */

// ---------- Canvas ----------
const canvas = document.getElementById('game');
// `ctx` is usually the on-screen canvas context, but static-world rendering
// temporarily redirects it to an offscreen canvas (chunk baking, see render.js) —
// hence `let` rather than `const`.
let ctx = canvas.getContext('2d');
let vw = 0, vh = 0;
function resize() { vw = canvas.width = innerWidth; vh = canvas.height = innerHeight; }
addEventListener('resize', resize);
// On mobile the address bar shows/hides: realign the canvas afterwards.
addEventListener('orientationchange', () => setTimeout(resize, 150));
if (window.visualViewport) visualViewport.addEventListener('resize', resize);
resize();

// ---------- Utils ----------
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);

// ---------- Seedable RNG: the city is generated from the room code ----------
// In multiplayer everyone must see the SAME city, so rnd/rndi draw from a
// generator seeded with the room code (ROOM_CODE): generation in city.js (roads,
// landmarks, military base) is then identical for host and guests. The code comes
// from the invite link (#room=XXXXXX) or is minted here.
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const ROOM_FROM_URL = (() => {
  const m = /room=([a-z0-9]{4,12})/i.exec(location.hash || '');
  return m ? m[1].toUpperCase() : null;
})();
const ROOM_CODE = ROOM_FROM_URL || (() => {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';        // no ambiguous glyphs (0/O, 1/I/L)
  // The 1st letter encodes map size (P/M/G, see city.js). Anonymous rooms
  // (single-player, no host) skip those letters so they stay Small.
  const A1 = A.replace(/[PMG]/g, '');
  let c = A1[Math.floor(Math.random() * A1.length)];
  for (let i = 1; i < 6; i++) c += A[Math.floor(Math.random() * A.length)];
  return c;
})();
const random = mulberry32(hashStr(ROOM_CODE));

// ---------- Violence filter: needed BEFORE the city is generated ----------
// With violence off (SINGLE-PLAYER only) the city is peaceful and has NO military
// zone: no barracks, no tanks, ordinary blocks where the base would be (see
// pickArmyIsland in city.js). The choice must therefore be read BEFORE generating,
// and city.js already runs at load time — so we pull it from localStorage, where the
// new-game panel just wrote it alongside the map code (spIntent in ui.js), or from
// the save, which remembers its own game's filter (save.js). Comparing against the
// URL code is essential: in MULTIPLAYER violence is always on, so guests and host
// generate the same city even if they have peaceful games saved locally.
// (localStorage may be missing or blocked — e.g. the server's headless sim — in
//  which case the city stays "normal", barracks included.)
const PEACE_CITY = (() => {
  try {
    const read = k => { const v = localStorage.getItem('vibeCity.' + k); return v === null ? null : JSON.parse(v); };
    const sp = read('spIntent');
    if (sp && sp.code === ROOM_FROM_URL) return sp.violence === false;
    const sv = read('save');
    if (sv && sv.code === ROOM_FROM_URL) return sv.violence === false;
  } catch {}
  return false;
})();

const rnd  = (a, b) => a + random() * (b - a);
const rndi = (a, b) => Math.floor(rnd(a, b + 1));
const pick = arr => arr[rndi(0, arr.length - 1)];
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const TAU = Math.PI * 2;
// Angular difference normalised to [-PI, PI].
function angDiff(a, b) { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; }
function steerToward(a, target, rate) { const d = angDiff(a, target); return a + clamp(d, -rate, rate); }
