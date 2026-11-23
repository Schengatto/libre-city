#!/usr/bin/env node
// build.js — produces a deployable version of the game in dist/.
//
//   node build.js
//
// What it does:
//   1. Copies every js/*.js referenced by index.html into dist/js/, renaming it with the
//      hash of its content (e.g. core.a1b2c3d4e5.js) → cache-friendly: files can be cached
//      forever, and new content means a new name.
//   2. Rewrites the <script src> tags in dist/index.html, preserving the load order (a
//      critical constraint: the scripts share a global scope).
//   3. index.html keeps its name as the entry point. Against HTML caching it:
//      - generates _headers (Netlify/Cloudflare Pages) and .htaccess (Apache) with
//        Cache-Control: no-cache on the HTML and immutable on the hashed assets;
//      - injects a small version check into the HTML: on load it compares the embedded
//        BUILD_ID with dist/version.json (fetched no-store); if the server has a newer
//        build it reloads the page ONCE (guarded in sessionStorage → no reload loop).
//
// The source tree is left untouched: in development the game still runs from file://.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DIST = process.env.LC_DIST_DIR ? path.resolve(process.env.LC_DIST_DIR) : path.join(ROOT, 'dist');

const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);

// --- 0. Multiplayer server URL to inject into <meta name="lc-server"> ---------
// Folds the configuration into the build: no more hand-editing index.html.
//   node build.js --server=wss://libre-city.fly.dev
//   node build.js wss://libre-city.fly.dev
//   LC_SERVER=wss://libre-city.fly.dev node build.js
// Empty = local development only (the client falls back to ws://localhost:8787).
function resolveServerUrl() {
  const args = process.argv.slice(2);
  const flag = args.find(a => a.startsWith('--server='));
  if (flag) return flag.slice('--server='.length).trim();
  const pos = args.find(a => /^wss?:\/\//i.test(a));
  if (pos) return pos.trim();
  return (process.env.LC_SERVER || process.env.LIBRE_CITY_SERVER || '').trim();
}
const SERVER_URL = resolveServerUrl();
if (SERVER_URL && !/^wss?:\/\//i.test(SERVER_URL)) {
  console.error(`URL server non valido: "${SERVER_URL}" (atteso ws:// o wss://) — build annullata.`);
  process.exit(1);
}
if (SERVER_URL.startsWith('ws://')) {
  console.warn('⚠  Server in ws:// (non cifrato): un sito https lo bloccherà. In produzione usa wss://.');
}

// --- 1. A clean dist/ ------------------------------------------------------
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'js'), { recursive: true });

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// Injects the server URL into the meta tag (adding it if absent). Changing the URL changes
// the content → a new BUILD_ID → clients update themselves.
const metaRe = /<meta name="lc-server" content="[^"]*">/;
if (metaRe.test(html)) html = html.replace(metaRe, `<meta name="lc-server" content="${SERVER_URL}">`);
else if (SERVER_URL) html = html.replace('</head>', `  <meta name="lc-server" content="${SERVER_URL}">\n</head>`);
console.log(SERVER_URL ? `  server multigiocatore: ${SERVER_URL}`
                       : '  server multigiocatore: (non impostato → solo sviluppo locale)');

// --- 2. Hash + copy the local scripts (external ones are left untouched) ---
const localScripts = [...html.matchAll(/<script src="(js\/[^"]+\.js)"><\/script>/g)].map(m => m[1]);
if (localScripts.length === 0) {
  console.error('Nessuno <script src="js/..."> trovato in index.html: build annullata.');
  process.exit(1);
}

const fileHashes = [];
const hashedRels = []; // for the service worker's precache
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

// Sanity check: no unhashed references may remain in dist/js.
const leftover = html.match(/src="js\/[^"]*(?<!\.[0-9a-f]{10})\.js"/);
if (leftover) {
  console.error(`Riferimento non riscritto: ${leftover[0]} — build annullata.`);
  process.exit(1);
}

const { buildSimWorkerBundle } = require('./build-sim-worker.js');
const simWorkerBundle = buildSimWorkerBundle(ROOT);
const simWorkerRel = `js/sim-worker.${hash(simWorkerBundle)}.js`;
fs.writeFileSync(path.join(DIST, simWorkerRel), simWorkerBundle);
const simWorkerMetaRe = /<meta name="lc-sim-worker" content="[^"]*">/;
if (!simWorkerMetaRe.test(html)) {
  console.error('Meta lc-sim-worker mancante in index.html: build annullata.');
  process.exit(1);
}
html = html.replace(simWorkerMetaRe, `<meta name="lc-sim-worker" content="${simWorkerRel}">`);
hashedRels.push(simWorkerRel);
console.log(`  js/sim-worker.js  →  ${simWorkerRel}`);

// --- 3. BUILD_ID + anti-cache version check on the HTML --------------------
// Deterministic: it depends only on the contents (same sources → same build).
const BUILD_ID = hash(fileHashes.join('|') + hash(html));

const versionCheck = `
<script>
// Anti-cache for index.html: if the server has a newer build than this one, reload the page
// exactly once (guarded in sessionStorage → no loop).
(function(){
  var BUILD='${BUILD_ID}';
  window.LC_BUILD=BUILD;   // used by net.js for the "update" notice on a mismatch with the server
  fetch('version.json?ts='+Date.now(),{cache:'no-store'})
    .then(function(r){return r.json();})
    .then(function(v){
      if(v.build!==BUILD && sessionStorage.getItem('oc-reload')!==v.build){
        sessionStorage.setItem('oc-reload',v.build);
        location.reload();
      }
    })
    .catch(function(){}); // offline/file://: no problem, the game still runs
})();
</script>
</head>`;

html = html.replace('</head>', versionCheck);
html = html.replace('<title>', `<!-- build ${BUILD_ID} -->\n<title>`);

fs.writeFileSync(path.join(DIST, 'index.html'), html);
fs.writeFileSync(path.join(DIST, 'version.json'), JSON.stringify({ build: BUILD_ID }) + '\n');

// --- 4. Cache headers for the most common hosts ----------------------------
// Netlify / Cloudflare Pages read _headers; Apache reads .htaccess. GitHub Pages is not
// configurable but already serves HTML with max-age=600, and in any case the version check
// above acts as a safety net. sw.js and the manifests must stay fresh (so updates arrive);
// hashed assets are immutable; icons change rarely → a short cache.
fs.writeFileSync(path.join(DIST, '_headers'), `/index.html
  Cache-Control: no-cache, must-revalidate
/
  Cache-Control: no-cache, must-revalidate
/version.json
  Cache-Control: no-store
/sw.js
  Cache-Control: no-cache, must-revalidate
/*.webmanifest
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
  <FilesMatch "\\.webmanifest$">
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

// --- 5. PWA: manifests, icons and service worker ---------------------------
// The app is installable from the browser: index.html links manifest.webmanifest and
// registers sw.js. The service worker precaches the app shell (index + hashed JS + icons +
// manifests) so the game starts offline too; version.json always comes from the network, and
// cross-origin resources (fonts) live in a "stale-while-revalidate" runtime cache.
// Multiplayer uses a WebSocket to the server (see server/): it bypasses the service worker
// and needs the network.
// Two manifests, one per language: js/i18n.js hooks the right one onto <link rel="manifest">.
const manifests = ['manifest.webmanifest', 'manifest.en.webmanifest'];
for (const f of manifests) fs.copyFileSync(path.join(ROOT, f), path.join(DIST, f));

const iconsDir = path.join(ROOT, 'icons');
const iconFiles = fs.readdirSync(iconsDir).filter(f => /\.(png|svg)$/.test(f));
fs.mkdirSync(path.join(DIST, 'icons'), { recursive: true });
for (const f of iconFiles) fs.copyFileSync(path.join(iconsDir, f), path.join(DIST, 'icons', f));

// RELATIVE paths (no leading slash): they work under a sub-path too (e.g. a GitHub Pages
// project site). Inside the service worker they resolve relative to sw.js.
const precache = ['./', 'index.html', ...manifests,
  ...hashedRels, ...iconFiles.map(f => `icons/${f}`)];

const sw = `// sw.js — generated by build.js (build ${BUILD_ID}). Do NOT edit by hand.
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

  // version.json: always from the network (the anti-cache build check), never cached.
  if (url.origin === location.origin && url.pathname.endsWith('version.json')) return;

  // Navigations (index.html): network-first, falling back to the cache when offline.
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

  // Same origin (hashed JS, icons, manifests): cache-first.
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

  // Cross-origin (Google Fonts, etc.): stale-while-revalidate.
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

console.log(`  ${manifests.length} manifest + ${iconFiles.length} icone → dist/  ·  sw.js (${precache.length} risorse in precache)`);
console.log(`\nBuild ${BUILD_ID} completata: ${localScripts.length} script → dist/`);
console.log('Deploy: carica il CONTENUTO di dist/ nella root del sito.');
