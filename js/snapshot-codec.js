const SNAPSHOT_CODEC_MAGIC = 0xB5;
const SNAPSHOT_CODEC_VERSION = 0x01;
const SNAPSHOT_CODEC_MAX_DEPTH = 32;
const SNAPSHOT_CODEC_SMALL_INTEGER_BASE = 0x40;
const SNAPSHOT_CODEC_SMALL_INTEGER_MAX = 0xFF - SNAPSHOT_CODEC_SMALL_INTEGER_BASE;
const SNAPSHOT_CODEC_INTEGER_MIN = -(2 ** 52);
const SNAPSHOT_CODEC_INTEGER_MAX = 2 ** 52 - 1;
const SNAPSHOT_CODEC_CENTI_LIMIT = 1e13;
const SNAPSHOT_CODEC_MAX_VARINT_BYTES = 8;
const SNAPSHOT_CODEC_LAST_VARINT_BYTE_MAX = 0x0F;
const SNAPSHOT_CODEC_NUL = '\u0000';
const SNAPSHOT_CODEC_TAG = Object.freeze({
  NULL: 0x00,
  FALSE: 0x01,
  TRUE: 0x02,
  INTEGER: 0x03,
  CENTI: 0x04,
  FLOAT64: 0x05,
  NEW_STRING: 0x06,
  STRING_REF: 0x07,
  ARRAY: 0x08,
  NEW_SHAPE: 0x09,
  SHAPE_REF: 0x0A,
});
const SNAPSHOT_CODEC_REJECT = Object.freeze({ rejected: true });

let snapshotCodecTextEncoder = null;
let snapshotCodecTextDecoder = null;

let snapshotCodecBuffer = new Uint8Array(16384);
let snapshotCodecView = new DataView(snapshotCodecBuffer.buffer);
let snapshotCodecLength = 0;
let snapshotCodecShapeCount = 0;
const snapshotCodecStringIndexes = new Map();
const snapshotCodecShapeIndexes = new Map();

function snapshotCodecReserve(extraBytes) {
  const needed = snapshotCodecLength + extraBytes;
  if (needed <= snapshotCodecBuffer.length) return;
  let capacity = snapshotCodecBuffer.length * 2;
  while (capacity < needed) capacity *= 2;
  const grown = new Uint8Array(capacity);
  grown.set(snapshotCodecBuffer.subarray(0, snapshotCodecLength));
  snapshotCodecBuffer = grown;
  snapshotCodecView = new DataView(grown.buffer);
}

function snapshotCodecWriteByte(byte) {
  snapshotCodecReserve(1);
  snapshotCodecBuffer[snapshotCodecLength++] = byte;
}

function snapshotCodecWriteVarint(value) {
  while (value >= 0x80) {
    snapshotCodecWriteByte((value % 0x80) | 0x80);
    value = Math.floor(value / 0x80);
  }
  snapshotCodecWriteByte(value);
}

function snapshotCodecZigzag(value) {
  return value >= 0 ? value * 2 : -value * 2 - 1;
}

function snapshotCodecUnzigzag(value) {
  return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}

function snapshotCodecWriteFloat64(value) {
  snapshotCodecReserve(9);
  snapshotCodecBuffer[snapshotCodecLength++] = SNAPSHOT_CODEC_TAG.FLOAT64;
  snapshotCodecView.setFloat64(snapshotCodecLength, value, true);
  snapshotCodecLength += 8;
}

function snapshotCodecWriteString(text) {
  const knownIndex = snapshotCodecStringIndexes.get(text);
  if (knownIndex !== undefined) {
    snapshotCodecWriteByte(SNAPSHOT_CODEC_TAG.STRING_REF);
    snapshotCodecWriteVarint(knownIndex);
    return;
  }
  snapshotCodecStringIndexes.set(text, snapshotCodecStringIndexes.size);
  if (snapshotCodecTextEncoder === null) snapshotCodecTextEncoder = new TextEncoder();
  const utf8 = snapshotCodecTextEncoder.encode(text);
  snapshotCodecWriteByte(SNAPSHOT_CODEC_TAG.NEW_STRING);
  snapshotCodecWriteVarint(utf8.length);
  snapshotCodecReserve(utf8.length);
  snapshotCodecBuffer.set(utf8, snapshotCodecLength);
  snapshotCodecLength += utf8.length;
}

function snapshotCodecWriteNumber(value) {
  if (!Number.isFinite(value)) {
    snapshotCodecWriteByte(SNAPSHOT_CODEC_TAG.NULL);
    return;
  }
  if (Number.isSafeInteger(value)) {
    if (value >= 0 && value <= SNAPSHOT_CODEC_SMALL_INTEGER_MAX) {
      snapshotCodecWriteByte(SNAPSHOT_CODEC_SMALL_INTEGER_BASE + value);
    } else if (value >= SNAPSHOT_CODEC_INTEGER_MIN && value <= SNAPSHOT_CODEC_INTEGER_MAX) {
      snapshotCodecWriteByte(SNAPSHOT_CODEC_TAG.INTEGER);
      snapshotCodecWriteVarint(snapshotCodecZigzag(value));
    } else {
      snapshotCodecWriteFloat64(value);
    }
    return;
  }
  if (Math.abs(value) < SNAPSHOT_CODEC_CENTI_LIMIT) {
    const centi = Math.round(value * 100);
    if (centi / 100 === value) {
      snapshotCodecWriteByte(SNAPSHOT_CODEC_TAG.CENTI);
      snapshotCodecWriteVarint(snapshotCodecZigzag(centi));
      return;
    }
  }
  snapshotCodecWriteFloat64(value);
}

function snapshotCodecIsSkippedMember(member) {
  const type = typeof member;
  return type === 'undefined' || type === 'function' || type === 'symbol';
}

function snapshotCodecWriteObject(object) {
  const keys = [];
  let keysContainNul = false;
  for (const key of Object.keys(object)) {
    if (snapshotCodecIsSkippedMember(object[key])) continue;
    if (key.indexOf(SNAPSHOT_CODEC_NUL) !== -1) keysContainNul = true;
    keys.push(key);
  }
  const shapeId = keysContainNul ? undefined : keys.length + ':' + keys.join(SNAPSHOT_CODEC_NUL);
  const knownShape = shapeId === undefined ? undefined : snapshotCodecShapeIndexes.get(shapeId);
  if (knownShape !== undefined) {
    snapshotCodecWriteByte(SNAPSHOT_CODEC_TAG.SHAPE_REF);
    snapshotCodecWriteVarint(knownShape);
  } else {
    if (shapeId !== undefined) snapshotCodecShapeIndexes.set(shapeId, snapshotCodecShapeCount);
    snapshotCodecShapeCount++;
    snapshotCodecWriteByte(SNAPSHOT_CODEC_TAG.NEW_SHAPE);
    snapshotCodecWriteVarint(keys.length);
    for (const key of keys) snapshotCodecWriteString(key);
  }
  for (const key of keys) snapshotCodecWriteValue(object[key]);
}

function snapshotCodecWriteValue(value) {
  switch (typeof value) {
    case 'number':
      snapshotCodecWriteNumber(value);
      return;
    case 'string':
      snapshotCodecWriteString(value);
      return;
    case 'boolean':
      snapshotCodecWriteByte(value ? SNAPSHOT_CODEC_TAG.TRUE : SNAPSHOT_CODEC_TAG.FALSE);
      return;
    case 'object':
      if (value === null) {
        snapshotCodecWriteByte(SNAPSHOT_CODEC_TAG.NULL);
      } else if (Array.isArray(value)) {
        snapshotCodecWriteByte(SNAPSHOT_CODEC_TAG.ARRAY);
        snapshotCodecWriteVarint(value.length);
        for (let index = 0; index < value.length; index++) snapshotCodecWriteValue(value[index]);
      } else {
        snapshotCodecWriteObject(value);
      }
      return;
    default:
      snapshotCodecWriteByte(SNAPSHOT_CODEC_TAG.NULL);
  }
}

function snapshotEncode(value) {
  snapshotCodecLength = 0;
  snapshotCodecShapeCount = 0;
  snapshotCodecStringIndexes.clear();
  snapshotCodecShapeIndexes.clear();
  snapshotCodecWriteByte(SNAPSHOT_CODEC_MAGIC);
  snapshotCodecWriteByte(SNAPSHOT_CODEC_VERSION);
  snapshotCodecWriteValue(value);
  const frame = snapshotCodecBuffer.slice(0, snapshotCodecLength);
  snapshotCodecStringIndexes.clear();
  snapshotCodecShapeIndexes.clear();
  return frame;
}

let snapshotCodecInput = null;
let snapshotCodecInputView = null;
let snapshotCodecPosition = 0;
let snapshotCodecDecodedStrings = [];
let snapshotCodecDecodedShapes = [];

function snapshotCodecReject() {
  throw SNAPSHOT_CODEC_REJECT;
}

function snapshotCodecBytesLeft() {
  return snapshotCodecInput.length - snapshotCodecPosition;
}

function snapshotCodecReadByte() {
  if (snapshotCodecPosition >= snapshotCodecInput.length) snapshotCodecReject();
  return snapshotCodecInput[snapshotCodecPosition++];
}

function snapshotCodecReadVarint() {
  let value = 0;
  let multiplier = 1;
  for (let byteIndex = 0; byteIndex < SNAPSHOT_CODEC_MAX_VARINT_BYTES; byteIndex++) {
    const byte = snapshotCodecReadByte();
    const isLast = byteIndex === SNAPSHOT_CODEC_MAX_VARINT_BYTES - 1;
    if (isLast && byte > SNAPSHOT_CODEC_LAST_VARINT_BYTE_MAX) snapshotCodecReject();
    value += (byte & 0x7F) * multiplier;
    if (byte < 0x80) return value;
    multiplier *= 0x80;
  }
  return snapshotCodecReject();
}

function snapshotCodecReadCount() {
  const count = snapshotCodecReadVarint();
  if (count > snapshotCodecBytesLeft()) snapshotCodecReject();
  return count;
}

function snapshotCodecReadNewString() {
  const byteLength = snapshotCodecReadVarint();
  if (byteLength > snapshotCodecBytesLeft()) snapshotCodecReject();
  const start = snapshotCodecPosition;
  snapshotCodecPosition += byteLength;
  if (snapshotCodecTextDecoder === null) snapshotCodecTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const text = snapshotCodecTextDecoder.decode(snapshotCodecInput.subarray(start, snapshotCodecPosition));
  snapshotCodecDecodedStrings.push(text);
  return text;
}

function snapshotCodecReadStringRef() {
  const index = snapshotCodecReadVarint();
  if (index >= snapshotCodecDecodedStrings.length) snapshotCodecReject();
  return snapshotCodecDecodedStrings[index];
}

function snapshotCodecReadKey() {
  const tag = snapshotCodecReadByte();
  if (tag === SNAPSHOT_CODEC_TAG.NEW_STRING) return snapshotCodecReadNewString();
  if (tag === SNAPSHOT_CODEC_TAG.STRING_REF) return snapshotCodecReadStringRef();
  return snapshotCodecReject();
}

function snapshotCodecReadFloat64() {
  if (snapshotCodecBytesLeft() < 8) snapshotCodecReject();
  const value = snapshotCodecInputView.getFloat64(snapshotCodecPosition, true);
  snapshotCodecPosition += 8;
  if (!Number.isFinite(value)) snapshotCodecReject();
  return value;
}

function snapshotCodecReadObjectValues(keys, depth) {
  const object = {};
  for (let index = 0; index < keys.length; index++) {
    const value = snapshotCodecReadValue(depth + 1);
    if (keys[index] !== '__proto__') object[keys[index]] = value;
  }
  return object;
}

function snapshotCodecReadValue(depth) {
  const tag = snapshotCodecReadByte();
  if (tag >= SNAPSHOT_CODEC_SMALL_INTEGER_BASE) return tag - SNAPSHOT_CODEC_SMALL_INTEGER_BASE;
  switch (tag) {
    case SNAPSHOT_CODEC_TAG.NULL:
      return null;
    case SNAPSHOT_CODEC_TAG.FALSE:
      return false;
    case SNAPSHOT_CODEC_TAG.TRUE:
      return true;
    case SNAPSHOT_CODEC_TAG.INTEGER:
      return snapshotCodecUnzigzag(snapshotCodecReadVarint());
    case SNAPSHOT_CODEC_TAG.CENTI:
      return snapshotCodecUnzigzag(snapshotCodecReadVarint()) / 100;
    case SNAPSHOT_CODEC_TAG.FLOAT64:
      return snapshotCodecReadFloat64();
    case SNAPSHOT_CODEC_TAG.NEW_STRING:
      return snapshotCodecReadNewString();
    case SNAPSHOT_CODEC_TAG.STRING_REF:
      return snapshotCodecReadStringRef();
    case SNAPSHOT_CODEC_TAG.ARRAY: {
      if (depth >= SNAPSHOT_CODEC_MAX_DEPTH) snapshotCodecReject();
      const count = snapshotCodecReadCount();
      const items = [];
      for (let index = 0; index < count; index++) items.push(snapshotCodecReadValue(depth + 1));
      return items;
    }
    case SNAPSHOT_CODEC_TAG.NEW_SHAPE: {
      if (depth >= SNAPSHOT_CODEC_MAX_DEPTH) snapshotCodecReject();
      const keyCount = snapshotCodecReadCount();
      const keys = [];
      for (let index = 0; index < keyCount; index++) keys.push(snapshotCodecReadKey());
      snapshotCodecDecodedShapes.push(keys);
      return snapshotCodecReadObjectValues(keys, depth);
    }
    case SNAPSHOT_CODEC_TAG.SHAPE_REF: {
      if (depth >= SNAPSHOT_CODEC_MAX_DEPTH) snapshotCodecReject();
      const shapeIndex = snapshotCodecReadVarint();
      if (shapeIndex >= snapshotCodecDecodedShapes.length) snapshotCodecReject();
      return snapshotCodecReadObjectValues(snapshotCodecDecodedShapes[shapeIndex], depth);
    }
    default:
      return snapshotCodecReject();
  }
}

function snapshotDecode(bytes) {
  if (!ArrayBuffer.isView(bytes)) return null;
  try {
    snapshotCodecInput = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    snapshotCodecInputView = new DataView(snapshotCodecInput.buffer, snapshotCodecInput.byteOffset, snapshotCodecInput.byteLength);
    snapshotCodecPosition = 0;
    snapshotCodecDecodedStrings = [];
    snapshotCodecDecodedShapes = [];
    if (snapshotCodecReadByte() !== SNAPSHOT_CODEC_MAGIC || snapshotCodecReadByte() !== SNAPSHOT_CODEC_VERSION) return null;
    const value = snapshotCodecReadValue(0);
    return snapshotCodecBytesLeft() === 0 ? value : null;
  } catch {
    return null;
  } finally {
    snapshotCodecInput = null;
    snapshotCodecInputView = null;
    snapshotCodecDecodedStrings = [];
    snapshotCodecDecodedShapes = [];
  }
}

if (typeof module !== 'undefined') module.exports = { snapshotEncode, snapshotDecode, SNAPSHOT_CODEC_MAGIC, SNAPSHOT_CODEC_VERSION };
