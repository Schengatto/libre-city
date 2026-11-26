const RTC_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
const RTC_FAST_CHANNEL_OPTIONS = { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 };
const RTC_REL_CHANNEL_OPTIONS = { negotiated: true, id: 1, ordered: true };
const RTC_CONNECT_TIMEOUT_MS = 10000;
const RTC_RETRY_BASE_MS = 5000;
const RTC_RETRY_MAX_MS = 60000;
const RTC_MAX_BUFFERED_BYTES = 262144;
const RTC_MAX_INPUT_BYTES = 2048;
const RTC_MAX_SNAPSHOT_BYTES = 256 * 1024;
const RTC_INPUT_NUMBER_FIELDS = ['seq', 'ax', 'ay', 'aim', 'b', 'px', 'py', 'cx', 'cy', 'ca', 'csp', 'w', 'vr', 'lg', 'sa'];
const RTC_DEAD_CONNECTION_STATES = ['failed', 'closed'];

const rtcHostPeers = new Map();
const rtcGuest = { hostId: null, peer: null, usable: false, attempt: 0, retryTimer: null, connectTimer: null, lastTick: -1 };

function rtcEnabled() {
  if (typeof RTCPeerConnection === 'undefined') return false;
  return !(typeof location !== 'undefined' && /(?:^|[?&])rtc=off(?:&|$)/.test(location.search || ''));
}

function rtcRetryDelay(attempt) {
  return Math.min(RTC_RETRY_BASE_MS * 2 ** attempt, RTC_RETRY_MAX_MS);
}

function rtcFreshSnapshot(lastTick, tick) {
  return !Number.isFinite(tick) || tick > lastTick;
}

function rtcInputNeedsReliable(cmd) {
  return (cmd.b & 14) !== 0 || cmd.w != null || cmd.vr != null;
}

function rtcSanitizeInput(m) {
  if (!m || m.t !== 'i') return null;
  const input = {};
  for (const field of RTC_INPUT_NUMBER_FIELDS) if (Number.isFinite(m[field])) input[field] = m[field];
  if (m.drive && typeof m.drive === 'object') {
    input.drive = { active: !!m.drive.active, angle: Number.isFinite(m.drive.angle) ? m.drive.angle : 0 };
  }
  return input;
}

function rtcCreatePeer() {
  const pc = new RTCPeerConnection({ iceServers: RTC_ICE_SERVERS });
  const fast = pc.createDataChannel('fast', RTC_FAST_CHANNEL_OPTIONS);
  const rel = pc.createDataChannel('rel', RTC_REL_CHANNEL_OPTIONS);
  fast.binaryType = 'arraybuffer';
  rel.binaryType = 'arraybuffer';
  return { pc, fast, rel, remoteReady: false, pendingCandidates: [], reportedUsable: false };
}

function rtcPeerUsable(peer) {
  return peer.pc.connectionState === 'connected' && peer.fast.readyState === 'open' && peer.rel.readyState === 'open';
}

function rtcPeerDead(peer) {
  return RTC_DEAD_CONNECTION_STATES.includes(peer.pc.connectionState);
}

function rtcClosePeer(peer) {
  peer.pc.onicecandidate = null;
  peer.pc.onconnectionstatechange = null;
  for (const channel of [peer.fast, peer.rel]) {
    channel.onopen = null;
    channel.onclose = null;
    channel.onmessage = null;
  }
  try { peer.pc.close(); } catch {}
}

function rtcAddRemoteCandidate(peer, candidate) {
  if (!candidate || typeof candidate !== 'object') return;
  if (!peer.remoteReady) { peer.pendingCandidates.push(candidate); return; }
  peer.pc.addIceCandidate(candidate).catch(() => {});
}

function rtcMarkRemoteReady(peer) {
  peer.remoteReady = true;
  const pending = peer.pendingCandidates;
  peer.pendingCandidates = [];
  for (const candidate of pending) peer.pc.addIceCandidate(candidate).catch(() => {});
}

function rtcParseMessage(data) {
  if (data instanceof ArrayBuffer) {
    if (data.byteLength > RTC_MAX_SNAPSHOT_BYTES) return null;
    return typeof netDecodeBinarySnapshot === 'function' ? netDecodeBinarySnapshot(data) : null;
  }
  if (typeof data !== 'string' || data.length > RTC_MAX_SNAPSHOT_BYTES) return null;
  try { return JSON.parse(data); } catch { return null; }
}

function rtcAttachSignaling(peer, remoteId, onStateChange) {
  peer.pc.onicecandidate = event => {
    if (event.candidate) netSend({ t: 'rtc', to: remoteId, k: 'ice', d: event.candidate.toJSON() });
  };
  peer.pc.onconnectionstatechange = onStateChange;
  for (const channel of [peer.fast, peer.rel]) {
    channel.onopen = onStateChange;
    channel.onclose = onStateChange;
  }
}

function rtcHostSync(id, peer) {
  if (rtcHostPeers.get(id) !== peer) return;
  if (rtcPeerDead(peer) || peer.fast.readyState === 'closed' || peer.rel.readyState === 'closed') { rtcHostDrop(id, peer); return; }
  const usable = rtcPeerUsable(peer);
  if (usable === peer.reportedUsable) return;
  peer.reportedUsable = usable;
  simHostSetP2P(id, usable);
}

function rtcHostDrop(id, peer) {
  if (rtcHostPeers.get(id) !== peer) return;
  rtcHostPeers.delete(id);
  rtcClosePeer(peer);
  simHostSetP2P(id, false);
}

function rtcHostOnChannelMessage(id, data) {
  if (typeof data !== 'string' || data.length > RTC_MAX_INPUT_BYTES) return;
  const input = rtcSanitizeInput(rtcParseMessage(data));
  if (input) simHostForwardGuestInput(id, input);
}

function rtcHostOnOffer(from, sdp) {
  rtcHostClose(from);
  const peer = rtcCreatePeer();
  rtcHostPeers.set(from, peer);
  rtcAttachSignaling(peer, from, () => rtcHostSync(from, peer));
  peer.fast.onmessage = event => rtcHostOnChannelMessage(from, event.data);
  peer.rel.onmessage = event => rtcHostOnChannelMessage(from, event.data);
  peer.pc.setRemoteDescription({ type: 'offer', sdp })
    .then(() => { rtcMarkRemoteReady(peer); return peer.pc.createAnswer(); })
    .then(answer => peer.pc.setLocalDescription(answer))
    .then(() => netSend({ t: 'rtc', to: from, k: 'answer', d: peer.pc.localDescription.sdp }))
    .catch(() => rtcHostDrop(from, peer));
}

function rtcHostOnSignal(from, k, d) {
  if (typeof RTCPeerConnection === 'undefined') return;
  if (typeof from !== 'string' || from === net.myId) return;
  if (k === 'offer' && typeof d === 'string') rtcHostOnOffer(from, d);
  else if (k === 'ice') {
    const peer = rtcHostPeers.get(from);
    if (peer) rtcAddRemoteCandidate(peer, d);
  }
}

function rtcHostSendFrame(id, snapshot, events) {
  const peer = rtcHostPeers.get(id);
  if (!peer || !rtcPeerUsable(peer)) { simHostSetP2P(id, false); return; }
  try {
    if (events) peer.rel.send(events);
    if (peer.fast.bufferedAmount <= RTC_MAX_BUFFERED_BYTES) peer.fast.send(snapshot);
  } catch {
    rtcHostDrop(id, peer);
  }
}

function rtcHostClose(id) {
  const peer = rtcHostPeers.get(id);
  if (peer) rtcHostDrop(id, peer);
}

function rtcHostCloseAll() {
  for (const id of [...rtcHostPeers.keys()]) rtcHostClose(id);
}

function rtcGuestTransport() {
  return rtcGuest.usable ? 'P2P' : 'WS';
}

function rtcGuestPublishTransport() {
  if (net.stats) net.stats.transport = rtcGuestTransport();
}

function rtcGuestTeardown() {
  clearTimeout(rtcGuest.connectTimer);
  clearTimeout(rtcGuest.retryTimer);
  rtcGuest.connectTimer = null;
  rtcGuest.retryTimer = null;
  if (rtcGuest.peer) rtcClosePeer(rtcGuest.peer);
  rtcGuest.peer = null;
  rtcGuest.usable = false;
  rtcGuestPublishTransport();
}

function rtcGuestClose() {
  rtcGuestTeardown();
  rtcGuest.hostId = null;
  rtcGuest.attempt = 0;
}

function rtcGuestFail(peer) {
  if (rtcGuest.peer !== peer) return;
  const hostId = rtcGuest.hostId;
  rtcGuestTeardown();
  rtcGuest.retryTimer = setTimeout(() => {
    rtcGuest.retryTimer = null;
    rtcGuestConnect(hostId);
  }, rtcRetryDelay(rtcGuest.attempt++));
}

function rtcGuestSync(peer) {
  if (rtcGuest.peer !== peer) return;
  if (rtcPeerDead(peer) || peer.fast.readyState === 'closed' || peer.rel.readyState === 'closed') { rtcGuestFail(peer); return; }
  const usable = rtcPeerUsable(peer);
  if (usable === rtcGuest.usable) return;
  rtcGuest.usable = usable;
  if (usable) {
    clearTimeout(rtcGuest.connectTimer);
    rtcGuest.connectTimer = null;
    rtcGuest.attempt = 0;
  }
  rtcGuestPublishTransport();
}

function rtcGuestOnFastMessage(data) {
  const message = rtcParseMessage(data);
  if (!message || message.t !== 'w' || !rtcFreshSnapshot(rtcGuest.lastTick, message.tick)) return;
  if (Number.isFinite(message.tick)) rtcGuest.lastTick = message.tick;
  netOnSnapshot(message);
}

function rtcGuestOnReliableMessage(data) {
  const message = rtcParseMessage(data);
  if (message && message.t === 'we') netApplyWorldEvents(message.fx, message.ev);
}

function rtcGuestConnect(hostId) {
  if (!rtcEnabled()) { rtcGuestPublishTransport(); return; }
  if (rtcGuest.hostId === hostId && (rtcGuest.peer || rtcGuest.retryTimer)) return;
  rtcGuestTeardown();
  if (rtcGuest.hostId !== hostId) rtcGuest.attempt = 0;
  rtcGuest.hostId = hostId;
  rtcGuest.lastTick = -1;
  const peer = rtcCreatePeer();
  rtcGuest.peer = peer;
  rtcAttachSignaling(peer, hostId, () => rtcGuestSync(peer));
  peer.fast.onmessage = event => rtcGuestOnFastMessage(event.data);
  peer.rel.onmessage = event => rtcGuestOnReliableMessage(event.data);
  rtcGuest.connectTimer = setTimeout(() => rtcGuestFail(peer), RTC_CONNECT_TIMEOUT_MS);
  peer.pc.createOffer()
    .then(offer => peer.pc.setLocalDescription(offer))
    .then(() => netSend({ t: 'rtc', to: hostId, k: 'offer', d: peer.pc.localDescription.sdp }))
    .catch(() => rtcGuestFail(peer));
}

function rtcGuestOnSignal(from, k, d) {
  const peer = rtcGuest.peer;
  if (!peer || from !== rtcGuest.hostId) return;
  if (k === 'answer' && typeof d === 'string') {
    peer.pc.setRemoteDescription({ type: 'answer', sdp: d })
      .then(() => rtcMarkRemoteReady(peer))
      .catch(() => rtcGuestFail(peer));
  } else if (k === 'ice') rtcAddRemoteCandidate(peer, d);
}

function rtcGuestSendInput(cmd) {
  const peer = rtcGuest.peer;
  if (!rtcGuest.usable || !peer) return false;
  try {
    (rtcInputNeedsReliable(cmd) ? peer.rel : peer.fast).send(JSON.stringify(cmd));
    return true;
  } catch {
    return false;
  }
}
