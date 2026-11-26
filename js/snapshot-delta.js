const SNAPSHOT_DELTA_HISTORY_SIZE = 32;
const SNAPSHOT_DELTA_MAX_ENTITIES = 4096;
const SNAPSHOT_DELTA_KEYED_LISTS = ['cars', 'peds', 'coins', 'fires'];
const SNAPSHOT_DELTA_FRAME_TYPE = 'w';
const SNAPSHOT_DELTA_ENCODER_OWNED_KEYS = new Set(['t', 'tick', 'ack', 'me', ...SNAPSHOT_DELTA_KEYED_LISTS]);
const SNAPSHOT_DELTA_APPLIER_OWNED_KEYS = new Set(['base', 'rm', 'me', ...SNAPSHOT_DELTA_KEYED_LISTS]);

function snapshotDeltaHas(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function snapshotDeltaIsRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function snapshotDeltaIsWireMember(value) {
  const type = typeof value;
  return type !== 'undefined' && type !== 'function' && type !== 'symbol';
}

function snapshotDeltaIsValidId(id) {
  return (typeof id === 'number' && Number.isFinite(id)) || (typeof id === 'string' && id.length > 0);
}

function snapshotDeltaWireScalar(value) {
  switch (typeof value) {
    case 'number': return Number.isFinite(value) ? value : null;
    case 'string':
    case 'boolean':
    case 'object': return value;
    default: return null;
  }
}

function snapshotDeltaWireKeys(object) {
  return Object.keys(object).filter(key => snapshotDeltaIsWireMember(object[key]));
}

function snapshotDeltaSameValue(a, b) {
  const left = snapshotDeltaWireScalar(a);
  const right = snapshotDeltaWireScalar(b);
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftIsArray = Array.isArray(left);
  if (leftIsArray !== Array.isArray(right)) return false;
  if (leftIsArray) {
    return left.length === right.length && left.every((item, index) => snapshotDeltaSameValue(item, right[index]));
  }
  const leftKeys = snapshotDeltaWireKeys(left);
  if (leftKeys.length !== snapshotDeltaWireKeys(right).length) return false;
  return leftKeys.every(key => snapshotDeltaHas(right, key)
    && snapshotDeltaIsWireMember(right[key])
    && snapshotDeltaSameValue(left[key], right[key]));
}

function snapshotDeltaSplitEvents(frame) {
  const me = snapshotDeltaIsRecord(frame.me) ? frame.me : {};
  return {
    state: { ...frame, fx: [], me: { ...me, ev: null } },
    fx: Array.isArray(frame.fx) ? frame.fx : [],
    ev: Array.isArray(me.ev) ? me.ev : null,
  };
}

function snapshotDeltaWithEvents(value, fx, ev) {
  return { ...value, fx, me: { ...value.me, ev } };
}

function snapshotDeltaRemember(history, state) {
  history.set(state.tick, state);
  while (history.size > SNAPSHOT_DELTA_HISTORY_SIZE) history.delete(history.keys().next().value);
}

function snapshotDeltaChangedKeys(base, current) {
  const changedKeys = [];
  let currentKeyCount = 0;
  for (const key of Object.keys(current)) {
    if (!snapshotDeltaIsWireMember(current[key])) continue;
    currentKeyCount++;
    if (!snapshotDeltaHas(base, key) || !snapshotDeltaIsWireMember(base[key])) return null;
    if (!snapshotDeltaSameValue(base[key], current[key])) changedKeys.push(key);
  }
  return snapshotDeltaWireKeys(base).length === currentKeyCount ? changedKeys : null;
}

function snapshotDeltaIndexById(list) {
  if (!Array.isArray(list) || list.length > SNAPSHOT_DELTA_MAX_ENTITIES) return null;
  const entitiesById = new Map();
  for (const entity of list) {
    if (!snapshotDeltaIsRecord(entity) || !snapshotDeltaIsValidId(entity.id) || entitiesById.has(entity.id)) return null;
    entitiesById.set(entity.id, entity);
  }
  return entitiesById;
}

function snapshotDeltaPickKeys(source, keys) {
  return Object.fromEntries(keys.map(key => [key, source[key]]));
}

function snapshotDeltaDiffList(baseList, currentList) {
  const baseById = snapshotDeltaIndexById(baseList);
  const currentById = snapshotDeltaIndexById(currentList);
  if (!baseById || !currentById) return null;
  const entries = [];
  const removedIds = [];
  for (const [id, entity] of currentById) {
    const known = baseById.get(id);
    if (!known) {
      entries.push(entity);
      continue;
    }
    const changedKeys = snapshotDeltaChangedKeys(known, entity);
    if (!changedKeys) {
      removedIds.push(id);
      entries.push(entity);
    } else if (changedKeys.length > 0) {
      entries.push(snapshotDeltaPickKeys(entity, ['id', ...changedKeys]));
    }
  }
  for (const id of baseById.keys()) if (!currentById.has(id)) removedIds.push(id);
  return { entries, removedIds };
}

function snapshotDeltaEncode(base, current) {
  if (!snapshotDeltaIsRecord(base) || !snapshotDeltaIsRecord(current)) return null;
  if (!snapshotDeltaIsRecord(base.me) || !snapshotDeltaIsRecord(current.me)) return null;
  if (current.t !== SNAPSHOT_DELTA_FRAME_TYPE) return null;
  if (!Number.isFinite(base.tick) || !Number.isFinite(current.tick) || current.tick <= base.tick) return null;
  const changedTopKeys = snapshotDeltaChangedKeys(base, current);
  const changedMeKeys = snapshotDeltaChangedKeys(base.me, current.me);
  if (!changedTopKeys || !changedMeKeys) return null;
  if (changedTopKeys.includes('base') || changedTopKeys.includes('rm')) return null;
  const delta = {
    t: SNAPSHOT_DELTA_FRAME_TYPE,
    tick: current.tick,
    ack: current.ack,
    base: base.tick,
    me: snapshotDeltaPickKeys(current.me, changedMeKeys),
    ...snapshotDeltaPickKeys(current, changedTopKeys.filter(key => !SNAPSHOT_DELTA_ENCODER_OWNED_KEYS.has(key))),
  };
  const removals = {};
  for (const name of SNAPSHOT_DELTA_KEYED_LISTS) {
    const listDiff = snapshotDeltaDiffList(base[name], current[name]);
    if (!listDiff) return null;
    delta[name] = listDiff.entries;
    if (listDiff.removedIds.length > 0) removals[name] = listDiff.removedIds;
  }
  if (Object.keys(removals).length > 0) delta.rm = removals;
  return delta;
}

function snapshotDeltaIsIdList(value) {
  return Array.isArray(value) && value.length <= SNAPSHOT_DELTA_MAX_ENTITIES && value.every(snapshotDeltaIsValidId);
}

function snapshotDeltaReadRemovals(rm) {
  if (rm === undefined) return {};
  if (!snapshotDeltaIsRecord(rm)) return null;
  const valid = Object.keys(rm).every(name => SNAPSHOT_DELTA_KEYED_LISTS.includes(name) && snapshotDeltaIsIdList(rm[name]));
  return valid ? rm : null;
}

function snapshotDeltaApplyList(baseList, entries, removedIds) {
  const entitiesById = snapshotDeltaIndexById(baseList);
  if (!entitiesById || !Array.isArray(entries) || entries.length > SNAPSHOT_DELTA_MAX_ENTITIES) return null;
  for (const id of removedIds) entitiesById.delete(id);
  for (const entry of entries) {
    if (!snapshotDeltaIsRecord(entry) || !snapshotDeltaIsValidId(entry.id)) return null;
    const known = entitiesById.get(entry.id);
    if (known) {
      if (!Object.keys(entry).every(key => snapshotDeltaHas(known, key))) return null;
      entitiesById.set(entry.id, { ...known, ...entry });
    } else {
      if (snapshotDeltaHas(entry, '__proto__')) return null;
      entitiesById.set(entry.id, { ...entry });
    }
  }
  return entitiesById.size > SNAPSHOT_DELTA_MAX_ENTITIES ? null : [...entitiesById.values()];
}

function snapshotDeltaApply(base, delta) {
  if (!snapshotDeltaIsRecord(base) || !snapshotDeltaIsRecord(delta) || !snapshotDeltaIsRecord(base.me)) return null;
  if (delta.t !== SNAPSHOT_DELTA_FRAME_TYPE || delta.base !== base.tick) return null;
  if (!Number.isFinite(delta.tick) || !(delta.tick > base.tick)) return null;
  if (!snapshotDeltaIsRecord(delta.me)) return null;
  const deltaKeys = Object.keys(delta);
  if (!deltaKeys.every(key => key === 'base' || key === 'rm' || snapshotDeltaHas(base, key))) return null;
  if (!Object.keys(delta.me).every(key => snapshotDeltaHas(base.me, key))) return null;
  const removals = snapshotDeltaReadRemovals(delta.rm);
  if (!removals) return null;
  const lists = {};
  for (const name of SNAPSHOT_DELTA_KEYED_LISTS) {
    const list = snapshotDeltaApplyList(base[name], delta[name], removals[name] || []);
    if (!list) return null;
    lists[name] = list;
  }
  const changedTopKeys = deltaKeys.filter(key => !SNAPSHOT_DELTA_APPLIER_OWNED_KEYS.has(key));
  return {
    ...base,
    ...snapshotDeltaPickKeys(delta, changedTopKeys),
    me: { ...base.me, ...delta.me },
    ...lists,
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    SNAPSHOT_DELTA_HISTORY_SIZE,
    SNAPSHOT_DELTA_MAX_ENTITIES,
    SNAPSHOT_DELTA_KEYED_LISTS,
    snapshotDeltaSameValue,
    snapshotDeltaSplitEvents,
    snapshotDeltaWithEvents,
    snapshotDeltaEncode,
    snapshotDeltaApply,
    snapshotDeltaRemember,
  };
}
