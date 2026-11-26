// VIBE CITY · js/storage-move.js — storage prefix migration and legacy-host handoff.
const STORAGE_PREFIX = 'vibeCity.';
const LEGACY_STORAGE_PREFIX = 'libreCity.';
const LEGACY_HOST = 'libre-city.schengatto.com';
const CANONICAL_ORIGIN = 'https://vibecity.schengatto.com';
const IMPORT_FRAGMENT_KEY = 'vc-import';
const IMPORT_MAX_ENCODED_LENGTH = 200000;
const IMPORT_NAME_MAX_LENGTH = 14;
const IMPORT_SCORES_MAX_ENTRIES = 10;
const IMPORT_LANGUAGES = ['it', 'en'];

function listStorageKeys(storage, prefix) {
  const keys = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null && key.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

function migrateStoragePrefix(storage) {
  let moved = 0;
  for (const legacyKey of listStorageKeys(storage, LEGACY_STORAGE_PREFIX)) {
    const key = STORAGE_PREFIX + legacyKey.slice(LEGACY_STORAGE_PREFIX.length);
    if (storage.getItem(key) === null) { storage.setItem(key, storage.getItem(legacyKey)); moved++; }
    storage.removeItem(legacyKey);
  }
  return moved;
}

function textToBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToText(encoded) {
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function encodeStorageExport(storage) {
  try {
    const entries = {};
    for (const key of listStorageKeys(storage, STORAGE_PREFIX)) entries[key] = storage.getItem(key);
    if (!Object.keys(entries).length) return '';
    const encoded = textToBase64Url(JSON.stringify(entries));
    return encoded.length > IMPORT_MAX_ENCODED_LENGTH ? '' : encoded;
  } catch { return ''; }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isImportedName(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= IMPORT_NAME_MAX_LENGTH && value.trim() === value;
}

function isImportedScore(value) {
  return isPlainObject(value)
    && isImportedName(value.name)
    && Number.isFinite(value.score)
    && (value.min === undefined || Number.isFinite(value.min))
    && (value.date === undefined || Number.isFinite(value.date));
}

const IMPORT_VALIDATORS = {
  [STORAGE_PREFIX + 'name']: isImportedName,
  [STORAGE_PREFIX + 'minutes']: value => [0, 5, 10, 15, 30, 60].includes(value),
  [STORAGE_PREFIX + 'audio']: value => typeof value === 'boolean',
  [STORAGE_PREFIX + 'music']: value => typeof value === 'boolean',
  [STORAGE_PREFIX + 'lang']: value => IMPORT_LANGUAGES.includes(value),
  [STORAGE_PREFIX + 'scores']: value => Array.isArray(value) && value.length <= IMPORT_SCORES_MAX_ENTRIES && value.every(isImportedScore),
  [STORAGE_PREFIX + 'save']: value => isPlainObject(value) && typeof value.code === 'string' && (value.name === undefined || typeof value.name === 'string'),
};

function validatedImportText(key, text) {
  if (typeof text !== 'string' || !Object.prototype.hasOwnProperty.call(IMPORT_VALIDATORS, key)) return null;
  try {
    const value = JSON.parse(text);
    if (!IMPORT_VALIDATORS[key](value)) return null;
    if (key === STORAGE_PREFIX + 'scores') {
      return JSON.stringify(value.map(({ name, score, min, date }) => ({ name, score, min, date })));
    }
    return text;
  } catch { return null; }
}

function decodeStorageImport(encoded) {
  try {
    if (typeof encoded !== 'string' || encoded.length > IMPORT_MAX_ENCODED_LENGTH || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    const parsed = JSON.parse(base64UrlToText(encoded));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const entries = {};
    for (const key of Object.keys(parsed)) {
      const text = validatedImportText(key, parsed[key]);
      if (text !== null) entries[key] = text;
    }
    return entries;
  } catch { return null; }
}

function importStorage(storage, entries) {
  try {
    if (listStorageKeys(storage, STORAGE_PREFIX).length) return false;
    const keys = Object.keys(entries).filter(key => key.startsWith(STORAGE_PREFIX));
    for (const key of keys) storage.setItem(key, entries[key]);
    return keys.length > 0;
  } catch { return false; }
}

function legacyHostRedirectUrl(locationLike, storage) {
  if (locationLike.hostname !== LEGACY_HOST) return null;
  const encoded = encodeStorageExport(storage);
  return `${CANONICAL_ORIGIN}/${locationLike.search}${encoded ? `#${IMPORT_FRAGMENT_KEY}=${encoded}` : ''}`;
}

function bootStorageMove(storage, locationLike, historyLike) {
  const onLegacyHost = locationLike.hostname === LEGACY_HOST;
  if (!onLegacyHost) {
    try {
      const hash = locationLike.hash || '';
      const separator = hash.indexOf('=');
      if (separator > 0 && hash.slice(1, separator) === IMPORT_FRAGMENT_KEY) {
        const entries = decodeStorageImport(hash.slice(separator + 1));
        if (entries) importStorage(storage, entries);
        historyLike.replaceState(null, '', locationLike.pathname + locationLike.search);
      }
    } catch {}
  }
  try { migrateStoragePrefix(storage); } catch {}
  if (onLegacyHost) locationLike.replace(legacyHostRedirectUrl(locationLike, storage));
}

try {
  if (typeof location !== 'undefined') {
    let browserStorage = null;
    try { browserStorage = localStorage; } catch {}
    bootStorageMove(browserStorage, location, history);
  }
} catch {}
