# Vibe City Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the game to "Vibe City", serve it at `https://vibecity.schengatto.com`, and carry every player's local data from the old host to the new one.

**Architecture:** One build serves both hosts. A new classic script `js/storage-move.js`, loaded before every other script, renames the storage prefix in place and, on the legacy host, hands all keys to the new origin through the URL fragment; on the new host it imports them once. The rest is a mechanical rename of names, identifiers, config and docs.

**Tech Stack:** Vanilla browser JS (classic scripts sharing global scope), Node test scripts under `server/` run in `node:vm`, GitHub Actions deploy, nginx in front of a Docker container.

**Spec:** board task LIBRE-22 (description, Decisions 1-7, DoD). Branch `feat/libre-22-vibe-city` from `origin/main` 76793b0.

## Global Constraints

- Display name: `Vibe City`; uppercase heading form `VIBE CITY`.
- New host: `vibecity.schengatto.com` (HTTPS + WSS same host). Legacy host: `libre-city.schengatto.com`.
- Storage prefix: `vibeCity.` (legacy `libreCity.`).
- npm names: `vibe-city`, `vibe-city-server`. SW caches: `vibe-city-${BUILD_ID}`, `vibe-city-runtime`.
- Server URL override: `window.VIBE_CITY_SERVER`; build env `VC_SERVER` or `VIBE_CITY_SERVER`; meta `<meta name="vc-server">`. No legacy aliases.
- Unchanged on purpose: `server/docker-compose.yml` (container `libre-city`, project `libre-city`), `DEPLOY_PATH /root/libre-city` in deploy.yml, nginx upstream name `libre-city`, everything under `docs/superpowers/`, GitHub repo URLs in README (`Schengatto/libre-city`).
- No code comments except the file header line already present in each file (rename its text only). English identifiers.
- Client files are classic scripts in one global scope: every new top-level name must be unique across `js/` (`git grep` before adding).

## Review Focus

1. Old invite link `https://libre-city.schengatto.com/?room=ABCD` opened by a player with a save: lands on `https://vibecity.schengatto.com/?room=ABCD` with save and language intact. Test in Task 1 (`legacyHostRedirectUrl` keeps `search`).
2. Player who already has data on the new host follows the redirect again: existing data untouched, fragment still stripped. Test in Task 1 (`importStorage` refuses on non-empty origin).
3. Hostile or broken fragment (bad base64, non-JSON, foreign keys like `token`, non-JSON values): ignored, nothing written, game boots. Test in Task 1 (`decodeStorageImport`).
4. Both `libreCity.lang` and `vibeCity.lang` present: `vibeCity.lang` wins, `libreCity.lang` removed. Test in Task 1.
5. `localStorage` throws (Safari private mode, quota): no exception escapes `storage-move.js`, legacy host still redirects (without data). Test in Task 1 (`bootStorageMove` with a throwing storage).

---

### Task 1: Storage move (prefix migration + legacy-host bridge)

**Files:**
- Create: `js/storage-move.js`
- Create: `server/test-storage-move.mjs`
- Modify: `index.html:786` (add `<script src="js/storage-move.js"></script>` as the FIRST script, before `js/core.js`)
- Modify: `js/core.js:70`, `js/entities.js:67-68`, `js/i18n.js:15,26,41`, `js/save.js` (every `libreCity.` literal → `vibeCity.`; keep literals, these files also run in the server sim bundle where `storage-move.js` is absent)
- Modify: `server/package.json` `scripts.test` (append `&& node test-storage-move.mjs`)

**Interfaces:**
- Produces (global functions/constants in `js/storage-move.js`):
  - `STORAGE_PREFIX = 'vibeCity.'`, `LEGACY_STORAGE_PREFIX = 'libreCity.'`
  - `LEGACY_HOST = 'libre-city.schengatto.com'`, `CANONICAL_ORIGIN = 'https://vibecity.schengatto.com'`, `IMPORT_FRAGMENT_KEY = 'vc-import'`
  - `migrateStoragePrefix(storage) -> number` (keys moved)
  - `encodeStorageExport(storage) -> string` (base64url of JSON `{key: rawStringValue}` for `vibeCity.*` keys; `''` when none)
  - `decodeStorageImport(encoded: string) -> Object<string,string> | null`
  - `importStorage(storage, entries) -> boolean`
  - `legacyHostRedirectUrl(locationLike, storage) -> string | null` (`locationLike` = `{ hostname, search }`)
  - `bootStorageMove(storage, locationLike, historyLike) -> void` (`locationLike` adds `hash`, `pathname`, `replace(url)`)

- [ ] **Step 1: Write `server/test-storage-move.mjs`**

Load `js/storage-move.js` into a `vm` context (pattern: `server/test-save.mjs:11-14`, `ok()` helper as there, exit code 1 on any fail). The context provides no `localStorage`/`location`, so the file's auto-boot must not run. Helper `makeStorage(entries)` returns a Map-backed object with `getItem` (null when missing), `setItem`, `removeItem`, `key(i)`, `length`. Assertions:

```js
// prefix migration
s = makeStorage({ 'libreCity.lang': '"en"', 'libreCity.save': '{"v":3}', 'other': '1' });
ok(migrateStoragePrefix(s) === 2 && s.getItem('vibeCity.lang') === '"en"' && s.getItem('libreCity.lang') === null && s.getItem('other') === '1', 'moves libreCity.* to vibeCity.*');
s = makeStorage({ 'libreCity.lang': '"it"', 'vibeCity.lang': '"en"' });
migrateStoragePrefix(s); ok(s.getItem('vibeCity.lang') === '"en"' && s.getItem('libreCity.lang') === null, 'existing vibeCity key wins, legacy key removed');
// round trip
s = makeStorage({ 'vibeCity.lang': '"en"', 'vibeCity.save': '{"v":3,"name":"Zoë"}', 'other': '1' });
const encoded = encodeStorageExport(s);
ok(/^[A-Za-z0-9_-]+$/.test(encoded), 'export is base64url');
ok(JSON.stringify(decodeStorageImport(encoded)) === JSON.stringify({ 'vibeCity.lang': '"en"', 'vibeCity.save': '{"v":3,"name":"Zoë"}' }), 'round trip keeps only vibeCity keys, unicode intact');
ok(encodeStorageExport(makeStorage({})) === '', 'empty export when no keys');
// hostile input
ok(decodeStorageImport('%%%') === null, 'bad base64 rejected');
ok(decodeStorageImport(b64url('not json')) === null, 'non-JSON payload rejected');
ok(JSON.stringify(decodeStorageImport(b64url(JSON.stringify({ token: '"x"', 'vibeCity.a': 'not json', 'vibeCity.b': 5, 'vibeCity.c': '1' })))) === '{"vibeCity.c":"1"}', 'foreign keys, non-JSON and non-string values dropped');
// import guard
s = makeStorage({}); ok(importStorage(s, { 'vibeCity.lang': '"en"' }) && s.getItem('vibeCity.lang') === '"en"', 'imports into empty origin');
s = makeStorage({ 'vibeCity.lang': '"it"' }); ok(!importStorage(s, { 'vibeCity.lang': '"en"' }) && s.getItem('vibeCity.lang') === '"it"', 'refuses when origin already has data');
// redirect url
s = makeStorage({ 'vibeCity.lang': '"en"' });
ok(legacyHostRedirectUrl({ hostname: 'libre-city.schengatto.com', search: '?room=ABCD' }, s) === `https://vibecity.schengatto.com/?room=ABCD#vc-import=${encodeStorageExport(s)}`, 'legacy host redirects with query and data');
ok(legacyHostRedirectUrl({ hostname: 'libre-city.schengatto.com', search: '' }, makeStorage({})) === 'https://vibecity.schengatto.com/', 'legacy host without data redirects without fragment');
ok(legacyHostRedirectUrl({ hostname: 'vibecity.schengatto.com', search: '' }, s) === null, 'new host never redirects');
// boot
// new host + fragment: imports, then historyLike.replaceState(null, '', pathname + search) strips the fragment
// new host + fragment + existing data: data untouched, fragment still stripped
// legacy host: migrates prefix first, then calls locationLike.replace with the redirect url
// throwing storage (every method throws) on legacy host: no exception, replace called with 'https://vibecity.schengatto.com/'
```

`b64url(text)` in the test: `Buffer.from(text, 'utf8').toString('base64url')`.

- [ ] **Step 2: Run it, expect failure**

Run: `node server/test-storage-move.mjs`
Expected: FAIL (`migrateStoragePrefix is not defined` or ENOENT).

- [ ] **Step 3: Implement `js/storage-move.js`**

Header line `// VIBE CITY · js/storage-move.js — storage prefix migration and legacy-host handoff.` Base64url via `TextEncoder`/`TextDecoder` + `btoa`/`atob` (all present in browsers and Node 22). `decodeStorageImport` wraps everything in try/catch and returns `null` on any failure. `bootStorageMove` wraps each storage access in try/catch so a throwing storage still yields the redirect. Iterate keys by collecting `storage.key(i)` for `i < storage.length` into an array before mutating. Auto-boot at file end: `if (typeof localStorage !== 'undefined' && typeof location !== 'undefined') bootStorageMove(localStorage, location, history);` wrapped in try/catch. The fragment is read as `location.hash.slice(1)` split on the first `=`; only `vc-import` is acted on.

- [ ] **Step 4: Switch the storage prefix in core/entities/i18n/save and wire the script**

Replace every `libreCity.` literal listed under Files; add the script tag; append the test to `scripts.test`.

- [ ] **Step 5: Run tests**

Run: `node server/test-storage-move.mjs && node server/test-save.mjs && node server/test-i18n.mjs`
Expected: all `OK`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add js/storage-move.js server/test-storage-move.mjs index.html js/core.js js/entities.js js/i18n.js js/save.js server/package.json
git commit -m "feat(storage): vibeCity prefix and legacy-host data handoff"
```

### Task 2: Rename sweep (name, identifiers, deploy config, docs)

**Files:**
- Modify: `index.html:9,10,17,496,780,782` (names; meta `lc-server` → `vc-server`; comment example host)
- Modify: `manifest.webmanifest`, `manifest.en.webmanifest` (`name`, `short_name`)
- Modify: `js/i18n.js` (`invite.shareTitle`, `invite.shareText`, `game.welcome`, `game.welcomeBack` in both `it` and `en`)
- Modify: `js/net.js:53-62` (`lc-server` → `vc-server`, `LIBRE_CITY_SERVER` → `VIBE_CITY_SERVER`)
- Modify: `build.js:30-42,61-63,204-205` (env `VC_SERVER || VIBE_CITY_SERVER`, meta `vc-server`, SW cache names, usage examples)
- Modify: `package.json`, `package-lock.json`, `server/package.json` (name, description in English: "Vibe City multiplayer server"), `server/package-lock.json` (name fields only)
- Modify: `server/index.js:3,967`, `server/fly.toml`, `server/Dockerfile` (name text; fly app `vibe-city`)
- Rename: `server/nginx-libre-city.conf` → `server/nginx-vibe-city.conf` (`git mv`)
- Modify: `.github/workflows/deploy.yml:18-19,41` (`PUBLIC_URL: https://vibecity.schengatto.com`, `SERVER_URL: wss://vibecity.schengatto.com`, `VC_SERVER`)
- Modify: `README.md` (title, play link `https://vibecity.schengatto.com/`), `MULTIPLAYER.md` (name, env/override names, example hosts)
- Modify: every remaining `LIBRE CITY ·` / `Libre City` header line in `js/*.js`, `server/*.js`, `server/test-*.mjs`

**Interfaces:**
- Consumes: Task 1 done (`libreCity.` storage literals already gone).
- Produces: nothing code-level.

- [ ] **Step 1: Rewrite `server/nginx-vibe-city.conf`**

Two host pairs, both proxying to the existing container: `vibecity.schengatto.com` (80 → acme + 301, 443 with `/etc/letsencrypt/live/vibecity.schengatto.com/`) and `libre-city.schengatto.com` (same, with its own cert path). Keep `set $upstream_libre libre-city;` and every proxy/WebSocket directive of the current file. Header comment lines translated to English, stating both hosts are served and the legacy one stays until the 301 follow-up.

- [ ] **Step 2: Apply the rest of the rename** (files above)

- [ ] **Step 3: Grep proof**

Run: `git grep -n -i -E "libre[ -]?city|librecity|LIBRE_CITY|lc-server|LC_SERVER" -- . ":!docs/superpowers" ":!server/docker-compose.yml"`
Expected: only hits are `/root/libre-city` (deploy.yml `DEPLOY_PATH`), `set $upstream_libre libre-city`, the `libre-city.schengatto.com` legacy server block and its cert path, `LEGACY_HOST`/`LEGACY_STORAGE_PREFIX` in `js/storage-move.js` and its test, `Schengatto/libre-city` repo URLs in README. Anything else is a miss.

- [ ] **Step 4: Run tests and build**

Run: `node server/test-i18n.mjs && node server/test-storage-move.mjs && node server/test.mjs && VC_SERVER=wss://vibecity.schengatto.com node build.js`
Expected: tests exit 0; `dist/index.html` contains `<meta name="vc-server" content="wss://vibecity.schengatto.com">` and `<title>Vibe City</title>`; `dist/sw.js` contains `vibe-city-`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: rename the game to Vibe City on vibecity.schengatto.com"
```

## After the tasks (main session)

1. Security review of `js/storage-move.js` (fragment is user-controlled input).
2. Push branch, open PR, CI must be green.
3. Merge only after the merge gate: `curl -fsS https://vibecity.schengatto.com/health` returns 200 (owner's VPS steps on LIBRE-22).
4. After deploy: browser check through the `browser` agent (old host with a seeded `vibeCity.lang` → redirected, language kept; room creation on the new host).
