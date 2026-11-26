import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { extractTopLevel } from './render-test-kit.mjs';

const JS_DIR = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'js');
const RTC_SOURCE = fs.readFileSync(path.join(JS_DIR, 'rtc.js'), 'utf8');
const CODEC_SOURCE = fs.readFileSync(path.join(JS_DIR, 'snapshot-codec.js'), 'utf8');
const NET_DECODER_SOURCE = extractTopLevel(fs.readFileSync(path.join(JS_DIR, 'net.js'), 'utf8'), 'netDecodeBinarySnapshot');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const readGlobal = (context, name) => vm.runInContext(name, context);
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

class FakeChannel {
  constructor(label, options) {
    this.label = label; this.options = options; this.readyState = 'connecting'; this.bufferedAmount = 0; this.sent = [];
    this.onopen = null; this.onclose = null; this.onmessage = null;
  }
  send(data) { this.sent.push(data); }
}

function createHarness(search = '') {
  const peers = [];
  const sentSignals = [];
  const snapshots = [];
  const worldEvents = [];
  const p2pChanges = [];
  const forwardedInputs = [];
  const timers = [];
  let now = 0;
  let nextTimerId = 1;

  class FakePeerConnection {
    constructor(config) {
      this.config = config; this.channels = []; this.remoteDescriptions = []; this.iceCandidates = [];
      this.connectionState = 'new'; this.localDescription = null; this.closed = false;
      this.onicecandidate = null; this.onconnectionstatechange = null;
      peers.push(this);
    }
    createDataChannel(label, options) { const channel = new FakeChannel(label, options); this.channels.push(channel); return channel; }
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'local-offer-sdp' }); }
    createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'local-answer-sdp' }); }
    setLocalDescription(description) { this.localDescription = description; return Promise.resolve(); }
    setRemoteDescription(description) { this.remoteDescriptions.push(description); return Promise.resolve(); }
    addIceCandidate(candidate) { this.iceCandidates.push(candidate); return Promise.resolve(); }
    close() { this.closed = true; this.connectionState = 'closed'; }
  }

  const context = vm.createContext({
    RTCPeerConnection: FakePeerConnection,
    location: { search },
    net: { myId: 'p1', stats: { transport: 'WS' } },
    netSend: message => sentSignals.push(message),
    netOnSnapshot: snapshot => snapshots.push(snapshot),
    netApplyWorldEvents: (fx, ev) => worldEvents.push({ fx, ev }),
    simHostSetP2P: (id, open) => p2pChanges.push({ id, open }),
    simHostForwardGuestInput: (id, input) => forwardedInputs.push({ id, input }),
    setTimeout: (fn, ms) => { const id = nextTimerId++; timers.push({ id, fn, at: now + ms }); return id; },
    clearTimeout: id => { const index = timers.findIndex(timer => timer.id === id); if (index >= 0) timers.splice(index, 1); },
    JSON,
    TextEncoder,
    TextDecoder,
  });
  vm.runInContext(CODEC_SOURCE + '\n' + NET_DECODER_SOURCE + '\n' + RTC_SOURCE, context);

  const advance = async ms => {
    const target = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const due = timers.find(timer => timer.at <= target);
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      now = due.at;
      due.fn();
      await flush();
    }
    now = target;
  };

  const connectPeer = peer => {
    peer.connectionState = 'connected';
    for (const channel of peer.channels) { channel.readyState = 'open'; if (channel.onopen) channel.onopen(); }
    if (peer.onconnectionstatechange) peer.onconnectionstatechange();
  };

  return { context, peers, sentSignals, snapshots, worldEvents, p2pChanges, forwardedInputs, advance, connectPeer };
}

console.log('pure helpers');
{
  const { context } = createHarness();
  ok(same(context.rtcSanitizeInput({ t: 'i', seq: 3, ax: 1, evil: 'x', drive: { active: 1, angle: 'a' } }), { seq: 3, ax: 1, drive: { active: true, angle: 0 } }),
    'rtcSanitizeInput keeps only known numeric fields and a normalised drive');
  ok(context.rtcSanitizeInput({ t: 'w' }) === null, 'rtcSanitizeInput rejects non input messages');
  ok(same(context.rtcSanitizeInput({ t: 'i', seq: 'x', ax: NaN, ay: Infinity, lg: 40 }), { lg: 40 }), 'rtcSanitizeInput drops non finite numbers');
  ok(same(context.rtcSanitizeInput({ t: 'i', seq: 3, sa: 120 }), { seq: 3, sa: 120 }), 'rtcSanitizeInput keeps the snapshot ack tick sa');
  ok(same(context.rtcSanitizeInput({ t: 'i', seq: 3, sa: NaN }), { seq: 3 }), 'rtcSanitizeInput drops a non finite sa');
  ok(context.rtcInputNeedsReliable({ sa: 120 }) === false, 'an sa alone goes on the fast channel');
  ok(context.rtcInputNeedsReliable({ b: 1 }) === false, 'fire held alone goes on the fast channel');
  ok(context.rtcInputNeedsReliable({ b: 4 }) === true, 'an edge bit needs the reliable channel');
  ok(context.rtcInputNeedsReliable({ w: 2 }) === true, 'a weapon change needs the reliable channel');
  ok(context.rtcInputNeedsReliable({ vr: 700 }) === true, 'a view radius change needs the reliable channel');
  ok(context.rtcInputNeedsReliable({ ax: 1 }) === false, 'plain movement goes on the fast channel');
  ok(context.rtcFreshSnapshot(10, 10) === false && context.rtcFreshSnapshot(10, 11) === true && context.rtcFreshSnapshot(10, undefined) === true,
    'rtcFreshSnapshot accepts only newer ticks');
  ok(context.rtcRetryDelay(0) === 5000 && context.rtcRetryDelay(1) === 10000 && context.rtcRetryDelay(5) === 60000, 'rtcRetryDelay backs off up to 60 s');
  ok(context.rtcEnabled() === true, 'rtc is enabled by default');
  ok(createHarness('?rtc=off').context.rtcEnabled() === false && createHarness('?a=1&rtc=off').context.rtcEnabled() === false, 'rtc=off disables rtc');
  const withoutPeerConnection = createHarness();
  withoutPeerConnection.context.RTCPeerConnection = undefined;
  ok(withoutPeerConnection.context.rtcEnabled() === false, 'rtc is disabled without RTCPeerConnection');
}

console.log('host role');
{
  const hostWithoutWebRtc = createHarness();
  hostWithoutWebRtc.context.RTCPeerConnection = undefined;
  let threw = false;
  try { hostWithoutWebRtc.context.rtcHostOnSignal('p2', 'offer', 'sdp'); } catch (error) { threw = true; }
  await flush();
  ok(!threw && hostWithoutWebRtc.peers.length === 0 && hostWithoutWebRtc.sentSignals.length === 0, 'a host without RTCPeerConnection ignores signals without throwing');
}
{
  const h = createHarness();
  h.context.rtcHostOnSignal('p2', 'offer', 'remote-offer-sdp');
  h.context.rtcHostOnSignal('p2', 'ice', { candidate: 'early' });
  const peer = h.peers[0];
  ok(h.peers.length === 1 && same(peer.config.iceServers, readGlobal(h.context, 'RTC_ICE_SERVERS')), 'the host creates a peer with the STUN servers');
  const [fast, rel] = peer.channels;
  ok(fast.label === 'fast' && same(fast.options, { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 }), 'host fast channel options');
  ok(rel.label === 'rel' && same(rel.options, { negotiated: true, id: 1, ordered: true }), 'host rel channel options');
  ok(peer.iceCandidates.length === 0, 'a candidate arriving before the remote description is queued');
  await flush();
  ok(same(peer.remoteDescriptions, [{ type: 'offer', sdp: 'remote-offer-sdp' }]), 'the host applies the offer');
  ok(same(h.sentSignals, [{ t: 'rtc', to: 'p2', k: 'answer', d: 'local-answer-sdp' }]), 'the host answers with its local sdp');
  ok(same(peer.iceCandidates, [{ candidate: 'early' }]), 'queued candidates are flushed after the remote description');
  h.context.rtcHostOnSignal('p2', 'ice', { candidate: 'late' });
  ok(peer.iceCandidates.length === 2, 'a later candidate is added directly');
  peer.onicecandidate({ candidate: { toJSON: () => ({ candidate: 'local' }) } });
  ok(same(h.sentSignals[1], { t: 'rtc', to: 'p2', k: 'ice', d: { candidate: 'local' } }), 'a local candidate is relayed to the guest');

  ok(peer.channels.length === 2 && peer.channels.every(channel => channel.binaryType === 'arraybuffer'), 'fast and rel deliver binary messages as ArrayBuffer');
  ok(h.p2pChanges.length === 0, 'no p2p change before the link opens');
  h.connectPeer(peer);
  ok(same(h.p2pChanges, [{ id: 'p2', open: true }]), 'open channels on a connected peer mark the guest p2p');

  fast.onmessage({ data: '{"t":"i","seq":1,"ax":1}' });
  ok(same(h.forwardedInputs, [{ id: 'p2', input: { seq: 1, ax: 1 } }]), 'a guest input is sanitized and forwarded to the sim');
  rel.onmessage({ data: '{"t":"i","seq":2,"b":4,"evil":1}' });
  ok(same(h.forwardedInputs[1], { id: 'p2', input: { seq: 2, b: 4 } }), 'the reliable channel input is forwarded too');
  fast.onmessage({ data: '{"t":"i","seq":3,"pad":"' + 'x'.repeat(2049) + '"}' });
  fast.onmessage({ data: 'not json' });
  fast.onmessage({ data: '{"t":"w"}' });
  ok(h.forwardedInputs.length === 2, 'oversized, malformed and non input messages are dropped');

  h.context.rtcHostSendFrame('p2', 'snapshot-1', 'events-1');
  ok(same(rel.sent, ['events-1']) && same(fast.sent, ['snapshot-1']), 'events go on rel and the snapshot on fast');
  h.context.rtcHostSendFrame('p2', 'snapshot-2', null);
  ok(rel.sent.length === 1 && fast.sent.length === 2, 'null events send nothing on rel');
  fast.bufferedAmount = 262145;
  h.context.rtcHostSendFrame('p2', 'snapshot-3', null);
  ok(fast.sent.length === 2, 'a congested fast channel skips the snapshot');
  fast.bufferedAmount = 0;
  const binarySnapshot = new Uint8Array([0xB5, 0x01, 0x08, 0x01, 0x41]);
  h.context.rtcHostSendFrame('p2', binarySnapshot, null);
  ok(fast.sent[fast.sent.length - 1] === binarySnapshot, 'a binary snapshot reaches fast unchanged');

  peer.connectionState = 'failed';
  peer.onconnectionstatechange();
  ok(same(h.p2pChanges[h.p2pChanges.length - 1], { id: 'p2', open: false }) && peer.closed, 'a failed connection closes the peer and unmarks the guest');
  const changesBefore = h.p2pChanges.length;
  h.context.rtcHostSendFrame('p2', 'snapshot-4', null);
  ok(h.p2pChanges.length === changesBefore + 1 && same(h.p2pChanges[changesBefore], { id: 'p2', open: false }), 'sending to an unknown peer unmarks the guest');
}

{
  const h = createHarness();
  h.context.rtcHostOnSignal('p2', 'offer', 'offer-a');
  h.context.rtcHostOnSignal('p3', 'offer', 'offer-b');
  await flush();
  h.context.rtcHostOnSignal('p2', 'offer', 'offer-c');
  ok(h.peers[0].closed && !h.peers[1].closed, 'a new offer closes the previous peer of the same guest');
  h.context.rtcHostOnSignal('p1', 'offer', 'self');
  ok(h.peers.length === 3, 'an offer from the host itself is ignored');
  h.context.rtcHostCloseAll();
  ok(h.peers.every(peer => peer.closed), 'rtcHostCloseAll closes every peer');
  ok(readGlobal(h.context, 'rtcHostPeers').size === 0, 'rtcHostCloseAll empties the peer map');
}

console.log('guest role');
{
  const h = createHarness();
  h.context.rtcGuestConnect('p1');
  await flush();
  const peer = h.peers[0];
  const [fast, rel] = peer.channels;
  ok(h.peers.length === 1 && same(peer.config.iceServers, readGlobal(h.context, 'RTC_ICE_SERVERS')), 'the guest creates a peer with the STUN servers');
  ok(same(fast.options, { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 }) && same(rel.options, { negotiated: true, id: 1, ordered: true }), 'guest channel options');
  ok(same(h.sentSignals, [{ t: 'rtc', to: 'p1', k: 'offer', d: 'local-offer-sdp' }]), 'the guest sends exactly one offer');
  h.context.rtcGuestConnect('p1');
  ok(h.peers.length === 1 && h.sentSignals.length === 1, 'connecting again to the same host is a no-op');
  ok(h.context.rtcGuestSendInput({ b: 1 }) === false, 'input is not sent before the link is usable');
  h.context.rtcGuestOnSignal('p9', 'ice', { candidate: 'stranger' });
  h.context.rtcGuestOnSignal('p9', 'answer', 'stranger-sdp');
  ok(peer.iceCandidates.length === 0 && peer.remoteDescriptions.length === 0, 'signals from a non host are ignored');
  h.context.rtcGuestOnSignal('p1', 'ice', { candidate: 'early' });
  ok(peer.iceCandidates.length === 0, 'a candidate arriving before the answer is queued');
  h.context.rtcGuestOnSignal('p1', 'answer', 'remote-answer-sdp');
  await flush();
  ok(same(peer.remoteDescriptions, [{ type: 'answer', sdp: 'remote-answer-sdp' }]), 'the guest applies the answer');
  ok(same(peer.iceCandidates, [{ candidate: 'early' }]), 'queued candidates are flushed after the answer');
  h.context.rtcGuestOnSignal('p1', 'ice', { candidate: 'late' });
  ok(peer.iceCandidates.length === 2, 'a later candidate is added directly');
  ok(h.context.rtcGuestTransport() === 'WS' && h.context.net.stats.transport === 'WS', 'transport is WS before connecting');

  h.connectPeer(peer);
  ok(h.context.rtcGuestTransport() === 'P2P' && h.context.net.stats.transport === 'P2P', 'transport is P2P once usable');
  ok(h.context.rtcGuestSendInput({ b: 1 }) === true && same(fast.sent, ['{"b":1}']), 'fire held goes on fast');
  ok(h.context.rtcGuestSendInput({ b: 2 }) === true && same(rel.sent, ['{"b":2}']), 'an edge bit goes on rel');

  fast.onmessage({ data: '{"t":"w","tick":5}' });
  fast.onmessage({ data: '{"t":"w","tick":5}' });
  fast.onmessage({ data: '{"t":"w","tick":4}' });
  fast.onmessage({ data: '{"t":"w","tick":6}' });
  ok(same(h.snapshots.map(snapshot => snapshot.tick), [5, 6]), 'only fresh snapshots reach netOnSnapshot');
  const binaryFast = message => fast.onmessage({ data: h.context.snapshotEncode(message).buffer });
  binaryFast({ t: 'w', tick: 7, cars: [] });
  binaryFast({ t: 'w', tick: 7, cars: [] });
  binaryFast({ t: 'w', tick: 3, cars: [] });
  binaryFast({ t: 'we', tick: 9, ev: [1], fx: [2] });
  binaryFast({ t: 'ok' });
  fast.onmessage({ data: vm.runInContext('new Uint8Array([0xB5, 0x01, 0xFF]).buffer', h.context) });
  fast.onmessage({ data: vm.runInContext('new Uint8Array([1, 2, 3]).buffer', h.context) });
  ok(same(h.snapshots.map(snapshot => snapshot.tick), [5, 6, 7]) && h.snapshots[2].t === 'w', 'a binary snapshot on fast is decoded, deduplicated and ordered like a text one');
  ok(h.worldEvents.length === 0, 'non snapshot and garbage binary frames on fast are dropped');
  const oversizedBinary = vm.runInContext('(() => { const frame = snapshotEncode({ t: "w", tick: 9, pad: "x".repeat(300 * 1024) }); const copy = new Uint8Array(frame.length); copy.set(frame); return copy.buffer; })()', h.context);
  ok(h.context.rtcParseMessage(oversizedBinary) === null, 'an oversized binary message is rejected before decoding');
  ok(h.context.rtcParseMessage(JSON.stringify({ t: 'w', tick: 9, pad: 'x'.repeat(300 * 1024) })) === null, 'an oversized text message is rejected');
  ok(h.context.rtcParseMessage(JSON.stringify({ t: 'w', pad: 'x'.repeat(200 * 1024) })).t === 'w', 'a text snapshot under the cap still parses');
  ok(h.context.rtcParseMessage(h.context.snapshotEncode({ t: 'w', tick: 8 }).buffer).tick === 8, 'a normal binary snapshot still decodes');
  rel.onmessage({ data: '{"t":"we","tick":6,"ev":[1],"fx":[2]}' });
  ok(same(h.worldEvents, [{ fx: [2], ev: [1] }]), 'reliable world events reach netApplyWorldEvents');

  h.context.rtcGuestClose();
  ok(peer.closed && h.context.net.stats.transport === 'WS' && h.context.rtcGuestSendInput({ b: 1 }) === false, 'closing returns to WS and stops sending');
  await h.advance(120000);
  ok(h.peers.length === 1, 'closing cancels any retry');
}

{
  const h = createHarness();
  h.context.rtcGuestConnect('p1');
  await flush();
  await h.advance(9999);
  ok(h.peers.length === 1 && !h.peers[0].closed, 'the guest waits for the connect timeout');
  await h.advance(1);
  ok(h.peers[0].closed && h.context.rtcGuestTransport() === 'WS' && h.context.net.stats.transport === 'WS', 'a connect timeout closes the peer and stays on WS');
  await h.advance(4999);
  ok(h.peers.length === 1, 'no retry before the backoff elapsed');
  await h.advance(1);
  await flush();
  ok(h.peers.length === 2 && h.sentSignals.filter(message => message.k === 'offer').length === 2, 'a new offer follows after 5000 ms');
  await h.advance(10000);
  await h.advance(9999);
  ok(h.peers.length === 2, 'the second retry waits 10000 ms');
  await h.advance(1);
  await flush();
  ok(h.peers.length === 3, 'the second retry backs off to 10000 ms');
  h.connectPeer(h.peers[2]);
  ok(h.context.rtcGuestTransport() === 'P2P', 'a retry that connects is usable');
  h.peers[2].connectionState = 'failed';
  h.peers[2].onconnectionstatechange();
  ok(h.context.net.stats.transport === 'WS' && h.peers[2].closed, 'a failed connection falls back to WS');
  await h.advance(5000);
  await flush();
  ok(h.peers.length === 4, 'success reset the backoff to 5000 ms');
}

{
  const h = createHarness('?rtc=off');
  h.context.rtcGuestConnect('p1');
  await flush();
  ok(h.peers.length === 0 && h.sentSignals.length === 0, 'rtc=off sends no offer');
  ok(h.context.net.stats.transport === 'WS', 'rtc=off keeps the WS transport');
}

{
  const h = createHarness();
  h.context.net.stats = null;
  h.context.rtcGuestConnect('p1');
  await flush();
  h.connectPeer(h.peers[0]);
  ok(h.context.rtcGuestTransport() === 'P2P', 'a missing net.stats does not break the transport switch');
}

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
