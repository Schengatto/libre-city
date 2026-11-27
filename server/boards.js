'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILE = process.env.BOARDS_FILE || path.join(__dirname, 'data', 'boards.json');
const SAVE_DEBOUNCE_MS = 5_000;
const SWEEP_INTERVAL_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const WEEK_MS = 7 * DAY_MS;
const MAX_BOARDS = 400;
const MAX_NONCES = 50_000;
const MAX_META_BYTES = 256;
const DEFAULT_LIMIT = 20;

const BOARD_ID_PATTERNS = {
  shift: /^shift:(taxi|pizza|ambulance|patrol|fire):(all|\d{4}-W\d{2})$/,
  daily: /^daily:\d{4}-\d{2}-\d{2}$/,
  weekly: /^weekly:\d{4}-W\d{2}$/,
  survival: /^survival:all$/,
  race: /^race:[A-Z0-9]{4,12}:\d{1,2}$/,
};
const WEEK_PERIOD = /^(\d{4})-W(\d{2})$/;
const DAY_PERIOD = /^(\d{4})-(\d{2})-(\d{2})$/;

const log = (...parts) => console.log(new Date().toISOString(), '[boards]', ...parts);

const kinds = new Map();
const boards = new Map();
const usedNonces = new Map();
let dirty = false, saveTimer = null, ioBroken = false;

function keyOf(name) { return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
function displayName(name) { return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 14); }
function kindPrefixOf(boardId) { return String(boardId).split(':')[0]; }
function matchesGrammar(boardId) {
  const pattern = BOARD_ID_PATTERNS[kindPrefixOf(boardId)];
  return Boolean(pattern) && pattern.test(boardId);
}
function kindOf(boardId) {
  if (typeof boardId !== 'string' || !matchesGrammar(boardId)) return null;
  return kinds.get(kindPrefixOf(boardId)) || null;
}

function defineBoardKind(prefix, { order, maxEntries, retainDays = null }) {
  if (!BOARD_ID_PATTERNS[prefix]) throw new Error(`unknown board kind ${prefix}`);
  if (order !== 'desc' && order !== 'asc') throw new Error(`bad order ${order}`);
  if (!(maxEntries > 0)) throw new Error(`bad maxEntries ${maxEntries}`);
  kinds.set(prefix, { prefix, order, maxEntries, retainDays });
}

function pad2(number) { return String(number).padStart(2, '0'); }
function dayId(ms) {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}
function isoWeekId(ms) {
  const date = new Date(ms);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const weekdayFromMonday = (date.getUTCDay() + 6) % 7;
  const thursday = midnight + (3 - weekdayFromMonday) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / WEEK_MS);
  return `${year}-W${pad2(week)}`;
}
function periodEndOf(boardId) {
  const period = String(boardId).split(':').pop();
  const week = WEEK_PERIOD.exec(period);
  if (week) {
    const january4 = Date.UTC(Number(week[1]), 0, 4);
    const firstMonday = january4 - ((new Date(january4).getUTCDay() + 6) % 7) * DAY_MS;
    return firstMonday + Number(week[2]) * WEEK_MS;
  }
  const day = DAY_PERIOD.exec(period);
  if (day) return Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])) + DAY_MS;
  return null;
}

function cleanMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  try {
    const serialized = JSON.stringify(meta);
    return Buffer.byteLength(serialized) <= MAX_META_BYTES ? JSON.parse(serialized) : undefined;
  } catch {
    return undefined;
  }
}
function compareEntries(order) {
  const direction = order === 'asc' ? 1 : -1;
  return (first, second) => direction * (first.value - second.value) || first.at - second.at;
}
function isBetter(order, value, previous) { return order === 'asc' ? value < previous : value > previous; }
function rankEntries(board, kind) {
  board.entries.sort(compareEntries(kind.order));
  if (board.entries.length > kind.maxEntries) board.entries.length = kind.maxEntries;
}
function findEntryIndex(board, key) { return board.entries.findIndex(entry => keyOf(entry.name) === key); }

function submit(boardId, { name, value, ms = 0, at = Date.now(), meta } = {}) {
  const kind = kindOf(boardId);
  const key = keyOf(name);
  if (!kind || !key || !Number.isFinite(value)) return null;
  let board = boards.get(boardId);
  if (!board) { board = { updatedAt: 0, entries: [] }; boards.set(boardId, board); }
  const previousIndex = findEntryIndex(board, key);
  const previous = previousIndex >= 0 ? board.entries[previousIndex] : null;
  if (previous && !isBetter(kind.order, value, previous.value)) {
    return { rank: previousIndex + 1, best: previous.value, improved: false };
  }
  const entry = { name: displayName(name), value, ms: Number(ms) || 0, at: Number(at) || Date.now() };
  const cleanedMeta = cleanMeta(meta);
  if (cleanedMeta) entry.meta = cleanedMeta;
  if (previous) board.entries[previousIndex] = entry;
  else board.entries.push(entry);
  rankEntries(board, kind);
  const index = board.entries.indexOf(entry);
  if (index < 0) {
    if (!board.entries.length) boards.delete(boardId);
    return { rank: null, best: null, improved: false };
  }
  board.updatedAt = Date.now();
  touch();
  return { rank: index + 1, best: value, improved: true };
}

function top(boardId, limit = DEFAULT_LIMIT, name) {
  const kind = kindOf(boardId);
  if (!kind) return { ok: false, error: 'bad_board' };
  const board = boards.get(boardId) || { updatedAt: null, entries: [] };
  const count = Math.max(1, Math.min(kind.maxEntries, limit | 0 || DEFAULT_LIMIT));
  const result = {
    ok: true, id: boardId, order: kind.order, total: board.entries.length, updatedAt: board.updatedAt,
    entries: board.entries.slice(0, count).map((entry, index) => ({ rank: index + 1, ...entry })),
  };
  const key = keyOf(name);
  const meIndex = key ? findEntryIndex(board, key) : -1;
  if (meIndex >= 0) result.me = { rank: meIndex + 1, value: board.entries[meIndex].value };
  return result;
}

function listBoards(prefix = '') {
  return [...boards.keys()].filter(boardId => boardId.startsWith(prefix)).sort();
}
function deleteBoard(boardId) {
  if (!boards.delete(boardId)) return false;
  touch();
  return true;
}

function consumeNonce(nonce, expiresAt, response) {
  if (usedNonces.has(nonce)) return false;
  usedNonces.set(nonce, { exp: expiresAt, res: response });
  if (usedNonces.size > MAX_NONCES) usedNonces.delete(usedNonces.keys().next().value);
  touch();
  return true;
}
function lookupNonce(nonce) {
  const used = usedNonces.get(nonce);
  return used ? used.res : null;
}
function pruneNonces(nowMs) {
  for (const [nonce, used] of usedNonces) if (used.exp < nowMs) usedNonces.delete(nonce);
}

function evictionOrder() {
  const dated = [], undated = [];
  for (const [boardId, board] of boards) {
    const end = periodEndOf(boardId);
    if (end !== null) dated.push({ boardId, sortKey: end });
    else if (!boardId.endsWith(':all')) undated.push({ boardId, sortKey: board.updatedAt });
  }
  const byOldest = (first, second) => first.sortKey - second.sortKey;
  return [...dated.sort(byOldest), ...undated.sort(byOldest)].map(candidate => candidate.boardId);
}
function sweep(nowMs = Date.now()) {
  const sizeBefore = boards.size;
  for (const boardId of boards.keys()) {
    const retainDays = kinds.get(kindPrefixOf(boardId))?.retainDays;
    const end = periodEndOf(boardId);
    if (retainDays != null && end !== null && nowMs > end + retainDays * DAY_MS) boards.delete(boardId);
  }
  if (boards.size > MAX_BOARDS) {
    for (const boardId of evictionOrder().slice(0, boards.size - MAX_BOARDS)) boards.delete(boardId);
  }
  if (boards.size !== sizeBefore) touch();
}

function touch() {
  dirty = true;
  if (saveTimer || ioBroken) return;
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}
function save() {
  if (!dirty || ioBroken) return;
  pruneNonces(Date.now());
  const data = {
    v: 1, savedAt: Date.now(),
    boards: Object.fromEntries(boards), usedNonces: Object.fromEntries(usedNonces),
  };
  const tmp = FILE + '.tmp';
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, FILE);
    dirty = false;
  } catch (error) {
    ioBroken = true;
    log('save failed on', FILE, '-', error.message, '(boards stay in RAM)');
    try { fs.unlinkSync(tmp); } catch {}
  }
}
function quarantineCorruptFile(reason) {
  const quarantined = `${FILE}.bad-${Date.now()}`;
  log('unreadable file', FILE, '-', reason, '(moved to', quarantined, ', starting empty)');
  try { fs.renameSync(FILE, quarantined); } catch {}
}
function restoreBoard(boardId, stored) {
  if (!matchesGrammar(boardId) || !stored || !Array.isArray(stored.entries)) return;
  const entries = stored.entries.filter(entry => entry && keyOf(entry.name) && Number.isFinite(entry.value));
  if (!entries.length) return;
  const board = { updatedAt: Number(stored.updatedAt) || 0, entries };
  const kind = kinds.get(kindPrefixOf(boardId));
  if (kind) rankEntries(board, kind);
  boards.set(boardId, board);
}
function load() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') quarantineCorruptFile(error.message);
    return;
  }
  if (!data || typeof data !== 'object' || !data.boards || typeof data.boards !== 'object') {
    quarantineCorruptFile('unexpected shape');
    return;
  }
  for (const [boardId, stored] of Object.entries(data.boards)) restoreBoard(boardId, stored);
  for (const [nonce, used] of Object.entries(data.usedNonces || {})) {
    if (used && Number.isFinite(used.exp)) usedNonces.set(nonce, { exp: used.exp, res: used.res ?? null });
  }
  log(boards.size, 'boards loaded from', FILE);
}

function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  save();
}
function _reset() {
  boards.clear(); usedNonces.clear();
  dirty = false; ioBroken = false;
  clearTimeout(saveTimer); saveTimer = null;
}

defineBoardKind('shift', { order: 'desc', maxEntries: 100, retainDays: 56 });
load();
sweep();
setInterval(() => sweep(), SWEEP_INTERVAL_MS).unref?.();

module.exports = {
  defineBoardKind, submit, top, isoWeekId, dayId, listBoards, deleteBoard,
  consumeNonce, lookupNonce, sweep, flush, save, _reset,
  FILE, MAX_BOARDS, MAX_NONCES, MAX_META_BYTES,
};
