#!/usr/bin/env node
// build.js — genera in dist/ una versione deployabile del gioco.
//
//   node build.js
//
// Cosa fa:
//   1. Copia ogni js/*.js referenziato da index.html in dist/js/ rinominandolo
//      con l'hash del contenuto (es. core.a1b2c3d4e5.js) → cache-friendly:
//      i file possono essere cachati per sempre, un contenuto nuovo = nome nuovo.
//   2. Riscrive i <script src> in dist/index.html mantenendo l'ordine di
//      caricamento (vincolo critico: scope globale condiviso tra gli script).
//   3. index.html resta l'entrypoint col suo nome. Contro la cache dell'HTML:
//      - genera _headers (Netlify/Cloudflare Pages) e .htaccess (Apache) con
//        Cache-Control: no-cache sull'HTML e immutable sugli asset hashati;
//      - inietta nell'HTML un mini-controllo di versione: al load confronta il
//        BUILD_ID incorporato con dist/version.json (fetch no-store); se il
//        server ha una build più nuova ricarica la pagina UNA volta
//        (guardia in sessionStorage → niente loop di reload).
//
// Il sorgente non viene toccato: in dev il gioco continua a girare da file://.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);

// --- 1. dist/ pulita -------------------------------------------------------
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'js'), { recursive: true });

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// --- 2. hash + copia degli script locali (quelli esterni restano intatti) --
const localScripts = [...html.matchAll(/<script src="(js\/[^"]+\.js)"><\/script>/g)].map(m => m[1]);
if (localScripts.length === 0) {
  console.error('Nessuno <script src="js/..."> trovato in index.html: build annullata.');
  process.exit(1);
}

const fileHashes = [];
const hashedRels = []; // per il precache del service worker
for (const rel of localScripts) {
  const buf = fs.readFileSync(path.join(ROOT, rel));
  const h = hash(buf);
  const hashedRel = rel.replace(/\.js$/, `.${h}.js`);
  fs.writeFileSync(path.join(DIST, hashedRel), buf);
  html = html.replace(`src="${rel}"`, `src="${hashedRel}"`);
  fileHashes.push(h);
  hashedRels.push(hashedRel);
  console.log(`  ${rel}  →  ${hashedRel}`);
}

// Sanity check: in dist/js non devono restare riferimenti senza hash.
const leftover = html.match(/src="js\/[^"]*(?<!\.[0-9a-f]{10})\.js"/);
if (leftover) {
  console.error(`Riferimento non riscritto: ${leftover[0]} — build annullata.`);
  process.exit(1);
}

// --- 3. BUILD_ID + controllo versione anti-cache sull'HTML -----------------
// Deterministico: dipende solo dai contenuti (stessi sorgenti → stessa build).
const BUILD_ID = hash(fileHashes.join('|') + hash(html));

const versionCheck = `
<script>
// Anti-cache per index.html: se il server ha una build più nuova di questa,
// ricarica la pagina una sola volta (guardia in sessionStorage → no loop).
(function(){
  var BUILD='${BUILD_ID}';
  fetch('version.json?ts='+Date.now(),{cache:'no-store'})
    .then(function(r){return r.json();})
    .then(function(v){
      if(v.build!==BUILD && sessionStorage.getItem('oc-reload')!==v.build){
        sessionStorage.setItem('oc-reload',v.build);
        location.reload();
      }
    })
    .catch(function(){}); // offline/file://: nessun problema, si gioca comunque
})();
</script>
</head>`;

html = html.replace('</head>', versionCheck);
html = html.replace('<title>', `<!-- build ${BUILD_ID} -->\n<title>`);

fs.writeFileSync(path.join(DIST, 'index.html'), html);
fs.writeFileSync(path.join(DIST, 'version.json'), JSON.stringify({ build: BUILD_ID }) + '\n');

// --- 4. header di cache per gli hosting più comuni -------------------------
// Netlify / Cloudflare Pages leggono _headers; Apache legge .htaccess.
// GitHub Pages non è configurabile ma serve già l'HTML con max-age=600,
// e in ogni caso il controllo di versione qui sopra fa da rete di sicurezza.
// sw.js e manifest devono restare freschi (così gli aggiornamenti arrivano);
// gli asset con hash sono immutabili; le icone cambiano di rado → cache breve.
fs.writeFileSync(path.join(DIST, '_headers'), `/index.html
  Cache-Control: no-cache, must-revalidate
/
  Cache-Control: no-cache, must-revalidate
/version.json
  Cache-Control: no-store
/sw.js
  Cache-Control: no-cache, must-revalidate
/manifest.webmanifest
  Cache-Control: no-cache, must-revalidate
/js/*
  Cache-Control: public, max-age=31536000, immutable
/icons/*
  Cache-Control: public, max-age=86400
`);

fs.writeFileSync(path.join(DIST, '.htaccess'), `AddType application/manifest+json .webmanifest

<IfModule mod_headers.c>
  <FilesMatch "^index\\.html$">
    Header set Cache-Control "no-cache, must-revalidate"
  </FilesMatch>
  <FilesMatch "^version\\.json$">
    Header set Cache-Control "no-store"
  </FilesMatch>
  <FilesMatch "^sw\\.js$">
    Header set Cache-Control "no-cache, must-revalidate"
  </FilesMatch>
  <FilesMatch "^manifest\\.webmanifest$">
    Header set Cache-Control "no-cache, must-revalidate"
  </FilesMatch>
  <FilesMatch "\\.[0-9a-f]{10}\\.js$">
    Header set Cache-Control "public, max-age=31536000, immutable"
  </FilesMatch>
  <FilesMatch "\\.png$">
    Header set Cache-Control "public, max-age=86400"
  </FilesMatch>
</IfModule>
`);

// --- 5. PWA: manifest, icone e service worker ------------------------------
// L'app è installabile dal browser: index.html linka manifest.webmanifest e
// registra sw.js. Il service worker pre-cacha l'app-shell (index + JS con hash
// + icone + manifest) così il gioco parte anche offline; version.json resta
// sempre dalla rete e le risorse cross-origin (PeerJS, font) sono in cache
// runtime "stale-while-revalidate".
fs.copyFileSync(path.join(ROOT, 'manifest.webmanifest'), path.join(DIST, 'manifest.webmanifest'));

const iconsDir = path.join(ROOT, 'icons');
const iconFiles = fs.readdirSync(iconsDir).filter(f => /\.(png|svg)$/.test(f));
fs.mkdirSync(path.join(DIST, 'icons'), { recursive: true });
for (const f of iconFiles) fs.copyFileSync(path.join(iconsDir, f), path.join(DIST, 'icons', f));

// Percorsi RELATIVI (senza slash iniziale): funzionano anche sotto un sottopercorso
// (es. GitHub Pages di progetto). Nel service worker si risolvono rispetto a sw.js.
const precache = ['./', 'index.html', 'manifest.webmanifest',
  ...hashedRels, ...iconFiles.map(f => `icons/${f}`)];

const sw = `// sw.js — generato da build.js (build ${BUILD_ID}). NON modificare a mano.
const CACHE = 'libre-city-${BUILD_ID}';
const RUNTIME = 'libre-city-runtime';
const PRECACHE = ${JSON.stringify(precache)};

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE && k !== RUNTIME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // version.json: sempre dalla rete (controllo build anti-cache), mai in cache.
  if (url.origin === location.origin && url.pathname.endsWith('version.json')) return;

  // Navigazioni (index.html): rete-prima, con fallback alla cache quando offline.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        return await fetch(req);
      } catch (_) {
        const c = await caches.open(CACHE);
        return (await c.match('index.html')) || (await c.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Stessa origine (JS con hash, icone, manifest): cache-prima.
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const net = await fetch(req);
      if (net && net.ok) { const c = await caches.open(CACHE); c.put(req, net.clone()); }
      return net;
    })());
    return;
  }

  // Cross-origin (PeerJS CDN, Google Fonts): stale-while-revalidate.
  e.respondWith((async () => {
    const c = await caches.open(RUNTIME);
    const cached = await c.match(req);
    const network = fetch(req).then((net) => {
      if (net && (net.ok || net.type === 'opaque')) c.put(req, net.clone());
      return net;
    }).catch(() => cached);
    return cached || network;
  })());
});
`;
fs.writeFileSync(path.join(DIST, 'sw.js'), sw);

console.log(`  manifest.webmanifest + ${iconFiles.length} icone → dist/  ·  sw.js (${precache.length} risorse in precache)`);
console.log(`\nBuild ${BUILD_ID} completata: ${localScripts.length} script → dist/`);
console.log('Deploy: carica il CONTENUTO di dist/ nella root del sito.');
