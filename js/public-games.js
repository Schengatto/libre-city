const PUBLIC_ROOM_MIN_VISIBLE_SEC = 60;
const PUBLIC_ROOM_LOW_TIME_SEC = 120;

function serverHttpBase(serverUrl) {
  return serverUrl.replace(/^ws/, 'http').replace(/\/+$/, '');
}

function publicRoomsUrl(serverUrl) {
  return serverHttpBase(serverUrl) + '/rooms';
}

function publicGameSizeKey(code) {
  const sizeLetter = code.charAt(0);
  if (sizeLetter === 'M') return 'common.sizeShortM';
  if (sizeLetter === 'G') return 'common.sizeShortL';
  return 'common.sizeShortS';
}

function formatTimeLeft(leftSec) {
  if (leftSec === null) return '∞';
  const minutes = String(Math.floor(leftSec / 60)).padStart(2, '0');
  const seconds = String(leftSec % 60).padStart(2, '0');
  return minutes + ':' + seconds;
}

function isTimeLeftLow(leftSec) {
  return leftSec !== null && leftSec < PUBLIC_ROOM_LOW_TIME_SEC;
}

function visiblePublicRooms(rooms, elapsedSec) {
  const visible = [];
  for (const room of rooms) {
    const leftSec = room.leftSec === null ? null : room.leftSec - elapsedSec;
    if (leftSec === null || leftSec >= PUBLIC_ROOM_MIN_VISIBLE_SEC) visible.push({ ...room, leftSec });
  }
  return visible;
}

function isPublicRoomFull(room) {
  return room.players >= room.max;
}

const PUBLIC_ROOM_RTT_SAMPLES = 3;
const PING_MID_MS = 80;
const PING_BAD_MS = 160;

function recentFetchDurations(durations, sampleMs) {
  if (!Number.isFinite(sampleMs) || sampleMs < 0) return durations.slice();
  return [...durations, sampleMs].slice(-PUBLIC_ROOM_RTT_SAMPLES);
}

function ownRttEstimateMs(durations) {
  return durations.length ? Math.min(...durations) : null;
}

function publicRoomHostRttMs(room) {
  return Number.isFinite(room.hostRttMs) && room.hostRttMs >= 0 ? room.hostRttMs : null;
}

function estimatedHostPingMs(ownRttMs, hostRttMs) {
  if (ownRttMs === null || hostRttMs === null) return null;
  return Math.round(ownRttMs + hostRttMs);
}

function pingBandClass(ms) {
  if (ms === null) return 'off';
  if (ms < PING_MID_MS) return '';
  return ms < PING_BAD_MS ? 'mid' : 'bad';
}

function formatPingEstimate(ms) {
  return ms === null ? '—' : '~' + ms + ' ms';
}
