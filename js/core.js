/* =========================================================
   LIBRE CITY — mini gioco di guida in città con vista dall'alto
   Cammina · Ruba auto · Guida per la città · Spara
   Missioni taxi 🚕 · Pizza delivery in moto 🍕🏍️
   Soccorsi in ambulanza 🚑 · Caccia ai ladri in volante 🚔
   Si parte a mani nude: i pugni 👊 stendono in 3 colpi
   Armeria 🛒: compra pistola, mitra, fucile a pompa e magnum
   Ogni struttura ha i suoi mezzi parcheggiati davanti
   Caserma dell'esercito 🪖: area recintata con jeep e carri
   armati (razzi!) — ma le guardie sparano a vista agli intrusi!
   Investi i passanti e la polizia ti darà la caccia! ⭐
   ========================================================= */

/* Il gioco è diviso in 10 script classici che condividono lo scope globale
   (niente moduli: funziona anche aperto da file://). Ordine di caricamento
   (vedi index.html): core → city → entities → input → missions → army →
   gameplay → render → audio → ui. Le funzioni si chiamano liberamente tra
   file; l'ordine conta solo per il codice eseguito subito al caricamento. */
// ---------- Canvas ----------
const canvas = document.getElementById('game');
// `ctx` è quasi sempre il contesto del canvas a schermo, ma il rendering del
// mondo statico lo reindirizza temporaneamente su un canvas offscreen (bake dei
// chunk, vedi render.js): per questo è `let` e non `const`.
let ctx = canvas.getContext('2d');
let vw = 0, vh = 0;
function resize() { vw = canvas.width = innerWidth; vh = canvas.height = innerHeight; }
addEventListener('resize', resize);
// su mobile la barra degli indirizzi appare/scompare: riallinea il canvas
addEventListener('orientationchange', () => setTimeout(resize, 150));
if (window.visualViewport) visualViewport.addEventListener('resize', resize);
resize();

// ---------- Utils ----------
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);

// ---------- RNG seedabile: la città è generata dal codice stanza ----------
// In multigiocatore tutti devono vedere la STESSA città: rnd/rndi pescano da un
// generatore seedato col codice stanza (ROOM_CODE), così la generazione in
// city.js (strade, landmark, base militare) è identica per host e ospiti.
// Il codice arriva dal link d'invito (#room=XXXXXX) oppure viene creato adesso.
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
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';        // niente caratteri ambigui (0/O, 1/I/L)
  let c = '';
  for (let i = 0; i < 6; i++) c += A[Math.floor(Math.random() * A.length)];
  return c;
})();
const random = mulberry32(hashStr(ROOM_CODE));

const rnd  = (a, b) => a + random() * (b - a);
const rndi = (a, b) => Math.floor(rnd(a, b + 1));
const pick = arr => arr[rndi(0, arr.length - 1)];
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const TAU = Math.PI * 2;
// differenza angolare normalizzata in [-PI, PI]
function angDiff(a, b) { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; }
function steerToward(a, target, rate) { const d = angDiff(a, target); return a + clamp(d, -rate, rate); }

