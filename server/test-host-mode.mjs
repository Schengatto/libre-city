import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import NodeWebSocket from 'ws';

const PORT = Number(process.env.TEST_PORT) || 8796;
const SERVER_MODE_PORT = PORT + 1;
const GRACE_MS = 1500;
const BUILD = 'test-build';
const CONNECT_TIMEOUT_MS = 60_000;
const MESSAGE_TIMEOUT_MS = 5_000;
const SILENCE_MS = 400;
const HOST_STATE_INTERVAL_MS = 400;
const HEALTHY_HOST_MS = 3000;
const STALL_ELECTION_DEADLINE_MS = 2600;
const OVERSIZED_PAYLOAD_BYTES = 80_000;
const HOST_STALL_MS = 2000;
const HOST_BIND_MS = 5000;
const HOST_CHECK_SLACK_MS = 1500;
const FIRST_FRAME_BEFORE_BIND_DEADLINE_MS = 800;
const HOST_LINK_PATH = '/hostlink';
const BINARY_SNAPSHOT_FRAME_BYTE = 0x57;
const BACKLOG_FRAME_COUNT = 96;
const BACKLOG_FRAME_BYTES = 200_000;
const HOST_LINK_HELLO_MS = 1000;
const HOST_LINK_PING_MS = 300;
const HOST_PING_ECHO_DELAY_MS = 150;
const HOST_PING_REPLAY_COUNT = 20;
const ROOM_ROW_POLL_MS = 100;
const ABNORMAL_CLOSE_CODE = 1006;
const HOST_LINK_FLOOD_COUNT = 2000;
const HOST_LINK_LEGIT_BURST = 300;
const INPUT_FLOOD_COUNT = 60_000;
const HOST_INPUT_SEQ = 4241;
const GUEST_INPUT_SEQ = 4242;
const TEST_MAX_PPM = 60_000_000;
const TEST_MAX_KILLS_PER_MINUTE = 6_000_000;
const IMPLAUSIBLE_SCORE = 1e15;
const BACKLOG_SETTLE_MS = 1500;
const OLD_BUILD = 'old';
const SHORT_MATCH_MINUTES = 0.05;
const MATCH_END_TIMEOUT_MS = 8000;
const HOST_SCORE = 300;
const GUEST_SCORE = 40;
const PUNCH_TIMEOUT_MS = 30_000;
const PUNCH_INPUT_MS = 50;
const PUNCH_OFFSET_PX = 10;
const PUNCH_BUTTONS = 3;
const POLICE_OFF_KNOCKOUTS = 3;
const LEADERBOARD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-host-lb-'));

function startServer(port, simMode, label) {
  const child = spawn('node', ['index.js'], {
    cwd: import.meta.dirname,
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', STATIC_DIR: '',
      LC_BUILD: BUILD, SIM_MODE: simMode, GRACE_MS: String(GRACE_MS), HOST_BIND_MS: String(HOST_BIND_MS),
      LEADERBOARD_FILE: path.join(LEADERBOARD_DIR, `${label}.json`),
      LEADERBOARD_QUALIFY_MS: '200', LEADERBOARD_MIN_SESSION_MS: '50',
      LEADERBOARD_MAX_PPM: String(TEST_MAX_PPM), LEADERBOARD_MAX_KILLS_PER_MINUTE: String(TEST_MAX_KILLS_PER_MINUTE),
      HOST_LINK_HELLO_MS: String(HOST_LINK_HELLO_MS), HOST_LINK_PING_MS: String(HOST_LINK_PING_MS),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', chunk => process.stdout.write(`  [${label}:err] ` + chunk));
  return child;
}

const hostServer = startServer(PORT, 'host', 'host');
const serverModeServer = startServer(SERVER_MODE_PORT, 'server', 'server');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let failures = 0;
const check = (condition, label) => { console.log('  ' + (condition ? 'OK ' : 'FAIL ') + label); if (!condition) failures++; };

async function waitFor(readValue, timeoutMs = MESSAGE_TIMEOUT_MS) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = readValue();
    if (value || performance.now() > deadline) return value;
    await wait(20);
  }
}

function openOnce(port, path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.inbox = [];
    ws.binaryInbox = [];
    ws.binaryType = 'arraybuffer';
    ws.closed = false;
    ws.addEventListener('message', event => {
      if (typeof event.data !== 'string') { ws.binaryInbox.push(Buffer.from(event.data)); return; }
      try { ws.inbox.push(JSON.parse(event.data)); } catch {}
    });
    ws.addEventListener('close', event => { ws.closed = true; ws.closeCode = event.code; });
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', reject);
  });
}

async function open(port = PORT, path = '') {
  const deadline = performance.now() + CONNECT_TIMEOUT_MS;
  for (;;) {
    try { return await openOnce(port, path); }
    catch (error) { if (performance.now() > deadline) throw error; }
    await wait(100);
  }
}

const send = (ws, message) => ws.send(JSON.stringify(message));
const findMessage = (ws, predicate) => ws.inbox.find(predicate);
const findType = (ws, type) => findMessage(ws, message => message.t === type);

async function enter(port, hello) {
  const ws = await open(port);
  send(ws, { build: BUILD, dev: 'desktop', ...hello });
  const ok = await waitFor(() => findType(ws, 'ok') || findType(ws, 'no'));
  return { ws, ok, id: ok && ok.id, token: ok && ok.token };
}
const createRoom = (code, name, dev = 'desktop') => enter(PORT, { t: 'create', code, name, dev, max: 8, minutes: 0 });
const joinRoom = (code, name, dev = 'desktop', build = BUILD) => enter(PORT, { t: 'join', code, name, dev, build });

async function openHostLink(code, token) {
  const ws = await open(PORT, HOST_LINK_PATH);
  send(ws, { t: 'hostlink', code, token });
  return ws;
}

function connectionOutcome(port, path) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.addEventListener('open', () => { resolve('open'); ws.close(); });
    ws.addEventListener('error', () => resolve('refused'));
  });
}

async function joinPausedReader(code, name) {
  const ws = new NodeWebSocket(`ws://127.0.0.1:${PORT}`, { perMessageDeflate: false });
  ws.inbox = [];
  ws.on('message', data => { try { ws.inbox.push(JSON.parse(data)); } catch {} });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ t: 'join', code, name, dev: 'touch', build: BUILD }));
  const ok = await waitFor(() => findType(ws, 'ok'));
  ws.pause();
  return { ws, id: ok && ok.id };
}

async function openPausedHostLink(code, token) {
  const ws = new NodeWebSocket(`ws://127.0.0.1:${PORT}${HOST_LINK_PATH}`, { perMessageDeflate: false });
  ws.inbox = [];
  ws.on('message', data => { try { ws.inbox.push(JSON.parse(data)); } catch {} });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ t: 'hostlink', code, token }));
  await waitFor(() => findType(ws, 'hoststart'));
  ws.pause();
  return ws;
}

async function punchPedestrians(ws, isDone) {
  const deadline = performance.now() + PUNCH_TIMEOUT_MS;
  const result = { done: false, maxWanted: 0, maxCops: 0, knockedPeds: 0 };
  const knockedPedIds = new Set();
  let seq = 0;
  let checkedSnapshots = 0;
  while (performance.now() < deadline) {
    const snapshots = ws.inbox.filter(message => message.t === 'w');
    for (const snapshot of snapshots.slice(checkedSnapshots)) {
      result.maxWanted = Math.max(result.maxWanted, snapshot.me.wanted);
      result.maxCops = Math.max(result.maxCops, snapshot.peds.filter(p => p.role === 'cop').length);
      for (const ped of snapshot.peds) if (ped.role === 'civ' && ped.ko) knockedPedIds.add(ped.id);
      result.knockedPeds = knockedPedIds.size;
      if (isDone(snapshot, result)) result.done = true;
    }
    checkedSnapshots = snapshots.length;
    if (result.done) return result;
    const snapshot = snapshots[snapshots.length - 1];
    if (snapshot) {
      let target = null, bestDistance = Infinity;
      for (const ped of snapshot.peds) {
        if (ped.role !== 'civ' || ped.ko) continue;
        const distance = Math.hypot(ped.x - snapshot.me.x, ped.y - snapshot.me.y);
        if (distance < bestDistance) { bestDistance = distance; target = ped; }
      }
      const input = { t: 'i', seq: ++seq, ax: 0, ay: 0, aim: 0, b: 0, px: snapshot.me.x, py: snapshot.me.y };
      if (target) { input.px = target.x - PUNCH_OFFSET_PX; input.py = target.y; input.b = PUNCH_BUTTONS; }
      send(ws, input);
    }
    await wait(PUNCH_INPUT_MS);
  }
  return result;
}

const closeAll = sockets =>{ for (const ws of sockets) { try { ws.close(); } catch {} } };

async function publicRoomRow(code) {
  const response = await fetch(`http://127.0.0.1:${PORT}/rooms`);
  return (await response.json()).rooms.find(row => row.code === code);
}

async function waitForRoomRow(code, predicate, timeoutMs = MESSAGE_TIMEOUT_MS) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const row = await publicRoomRow(code);
    if ((row && predicate(row)) || performance.now() > deadline) return row;
    await wait(ROOM_ROW_POLL_MS);
  }
}

function echoHostPings(link, echoState) {
  link.addEventListener('message', event => {
    if (typeof event.data !== 'string') return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.t !== 'hp' || echoState.mode === 'none') return;
    const reply = () => { echoState.lastAnsweredC = message.c; send(link, { t: 'hpo', c: message.c }); };
    if (echoState.mode === 'delayed') setTimeout(reply, HOST_PING_ECHO_DELAY_MS);
    else reply();
  });
}

try {
  console.log('creator is host');
  const playerA = await createRoom('HOSTA1', 'Alice');
  check(playerA.ok && playerA.ok.host === playerA.id, 'ok.host is the creator id');
  check(playerA.ok && playerA.ok.sim === true, 'ok.sim is true');
  const hostLinkA = await openHostLink('HOSTA1', playerA.token);
  const startA = await waitFor(() => findType(hostLinkA, 'hoststart'));
  check(startA && startA.roster.some(entry => entry.id === playerA.id) && Array.isArray(startA.state) && startA.state.length === 0,
    'hostlink bound: hoststart carries the roster and an empty state');
  const playerB = await joinRoom('HOSTA1', 'Bob');
  check(playerB.ok && playerB.ok.host === playerA.id, 'a joiner sees the current host in ok');
  check(await waitFor(() => findMessage(hostLinkA, message => message.t === 'join' && message.id === playerB.id)),
    'join is forwarded to the hostlink');

  console.log('input forwarded to host with id');
  send(playerA.ws, { t: 'i', seq: HOST_INPUT_SEQ });
  send(playerB.ws, { t: 'i', seq: GUEST_INPUT_SEQ, ax: 1, aim: 'x', id: 'p99', junk: 'x', drive: { active: 1, angle: 0.5, extra: 1 } });
  const forwardedInput = await waitFor(() => findMessage(hostLinkA, message => message.t === 'i' && message.seq === GUEST_INPUT_SEQ));
  check(forwardedInput && forwardedInput.id === playerB.id, 'the guest input reaches the hostlink signed with the sender id');
  check(forwardedInput && forwardedInput.ax === 1 && !('aim' in forwardedInput) && !('junk' in forwardedInput) &&
    JSON.stringify(forwardedInput.drive) === '{"active":true,"angle":0.5}', 'only the known numeric input fields are forwarded');
  check(!findMessage(hostLinkA, message => message.t === 'i' && message.seq === HOST_INPUT_SEQ), 'the host own input is not echoed to its hostlink');
  send(playerB.ws, { t: 'i', seq: GUEST_INPUT_SEQ + 1, sa: 42 });
  send(playerB.ws, { t: 'i', seq: GUEST_INPUT_SEQ + 2, sa: 'x' });
  const forwardedAck = await waitFor(() => findMessage(hostLinkA, message => message.t === 'i' && message.seq === GUEST_INPUT_SEQ + 1));
  check(forwardedAck && forwardedAck.sa === 42, 'the snapshot ack tick sa is forwarded to the hostlink');
  const forwardedBadAck = await waitFor(() => findMessage(hostLinkA, message => message.t === 'i' && message.seq === GUEST_INPUT_SEQ + 2));
  check(forwardedBadAck && !('sa' in forwardedBadAck), 'a non numeric sa is not forwarded');

  console.log('W frame routed to target only');
  hostLinkA.send('W|' + playerB.id + '|{"t":"w","x":1}');
  hostLinkA.send('W|p99|{"t":"w","x":2}');
  playerA.ws.send('W|' + playerB.id + '|{"t":"w","x":3}');
  hostLinkA.send('W|' + playerB.id + '|' + JSON.stringify({ t: 'w', x: 4, pad: 'a'.repeat(OVERSIZED_PAYLOAD_BYTES) }));
  check(await waitFor(() => findMessage(playerB.ws, message => message.t === 'w' && message.x === 1)), 'B receives the parsed snapshot');
  check(await waitFor(() => findMessage(playerB.ws, message => message.t === 'w' && message.x === 4)), 'a snapshot larger than the client payload cap still reaches B');
  await wait(SILENCE_MS);
  check(!findType(playerA.ws, 'w'), 'A receives no snapshot');
  check(!findMessage(playerB.ws, message => message.t === 'w' && (message.x === 2 || message.x === 3)),
    'W to an unknown id and W from a player socket are dropped');
  check(!hostLinkA.closed, 'the hostlink survives the large frame');
  const oversizedSender = await open();
  oversizedSender.send(JSON.stringify({ t: 'ping', pad: 'a'.repeat(OVERSIZED_PAYLOAD_BYTES) }));
  check(await waitFor(() => oversizedSender.closed), 'the game socket rejects a frame over 64 KB in host mode');
  const intruder = await openHostLink('HOSTA1', 'not-a-token');
  check(await waitFor(() => intruder.closed), 'a hostlink with an unknown token is closed');
  check(intruder.closeCode === ABNORMAL_CLOSE_CODE, 'a bad hello terminates the hostlink without a close handshake');

  console.log('election on host close carries state');
  hostLinkA.send(JSON.stringify({
    t: 'hst',
    players: [{ id: playerA.id, x: 10, y: 20, s: 250, cash: 99 }, { id: playerB.id, x: 1, y: 2, s: 0 }],
    scores: [{ id: playerA.id, s: 250 }],
  }));
  await wait(200);
  playerA.ws.close();
  const hostMessage = await waitFor(() => findType(playerB.ws, 'host'));
  check(hostMessage && hostMessage.id === playerB.id && hostMessage.name === 'Bob', 'B is elected and told with id and name');
  check(await waitFor(() => hostLinkA.closed), 'the old hostlink is closed by the server');
  const hostLinkB = await openHostLink('HOSTA1', playerB.token);
  const startB = await waitFor(() => findType(hostLinkB, 'hoststart'));
  const carriedRow = startB && startB.state.find(row => row.id === playerA.id);
  check(carriedRow && carriedRow.s === 250, 'hoststart state carries the last hst score of A');
  check(startB && startB.roster.some(entry => entry.id === playerA.id), 'the roster includes A while in grace');

  console.log('stale hostlink refused');
  const resumedA = await enter(PORT, { t: 'join', code: 'HOSTA1', token: playerA.token, dev: 'desktop' });
  check(resumedA.ok && resumedA.ok.resumed && resumedA.ok.host === playerB.id, 'A resumes and ok.host is B');
  const staleLink = await openHostLink('HOSTA1', playerA.token);
  staleLink.send('W|' + playerB.id + '|{"t":"w","x":5}');
  check(await waitFor(() => staleLink.closed), 'the hostlink of the former host is closed');
  await wait(SILENCE_MS);
  check(!findType(staleLink, 'hoststart'), 'the former host gets no hoststart');
  check(!findMessage(playerB.ws, message => message.t === 'w' && message.x === 5), 'W frames from the stale hostlink are not forwarded');

  console.log('stall election only when hostlink silent');
  for (const ws of [resumedA.ws, playerB.ws]) ws.inbox.length = 0;
  const healthyUntil = performance.now() + HEALTHY_HOST_MS;
  while (performance.now() < healthyUntil) {
    hostLinkB.send(JSON.stringify({ t: 'hst', players: [], scores: [] }));
    await wait(HOST_STATE_INTERVAL_MS);
  }
  check(!findType(resumedA.ws, 'host') && !findType(playerB.ws, 'host'), 'no election while the hostlink keeps sending hst');
  const stallElection = await waitFor(() => findType(resumedA.ws, 'host'), STALL_ELECTION_DEADLINE_MS);
  check(stallElection && stallElection.id === playerA.id, 'a silent hostlink triggers an election within 2.6 s');
  check(await waitFor(() => hostLinkB.closed), 'the stalled hostlink is closed');
  closeAll([resumedA.ws, playerB.ws, hostLinkB]);

  console.log('desktop preferred');
  const touchHost = await createRoom('HOSTC1', 'Tina', 'touch');
  const outdatedDesktop = await joinRoom('HOSTC1', 'Olga', 'desktop', 'old-build');
  const touchGuest = await joinRoom('HOSTC1', 'Tom', 'touch');
  const desktopGuest = await joinRoom('HOSTC1', 'Dora', 'desktop');
  check(touchHost.ok && touchHost.ok.host === touchHost.id, 'the touch creator is host while alone');
  touchHost.ws.close();
  const desktopElection = await waitFor(() => findType(touchGuest.ws, 'host'));
  check(desktopElection && desktopElection.id === desktopGuest.id, 'the eligible desktop player is elected over a lower touch id and an outdated build');
  closeAll([outdatedDesktop.ws, touchGuest.ws, desktopGuest.ws]);

  console.log('join during migration lands in roster');
  const lonelyHost = await createRoom('HOSTD1', 'Ann');
  const lonelyLink = await openHostLink('HOSTD1', lonelyHost.token);
  await waitFor(() => findType(lonelyLink, 'hoststart'));
  const graceGuest = await joinRoom('HOSTD1', 'Ben');
  graceGuest.ws.close();
  await wait(100);
  lonelyHost.ws.close();
  await wait(100);
  const newcomer = await joinRoom('HOSTD1', 'Dan');
  check(newcomer.ok && newcomer.ok.host === newcomer.id, 'the newcomer is elected host');
  const newcomerLink = await openHostLink('HOSTD1', newcomer.token);
  const newcomerStart = await waitFor(() => findType(newcomerLink, 'hoststart'));
  const rosterIds = newcomerStart ? newcomerStart.roster.map(entry => entry.id) : [];
  check([lonelyHost.id, graceGuest.id, newcomer.id].every(id => rosterIds.includes(id)), 'hoststart roster contains A, B and D');
  const leaves = await waitFor(() => {
    const leftIds = newcomerLink.inbox.filter(message => message.t === 'leave').map(message => message.id);
    return leftIds.includes(lonelyHost.id) && leftIds.includes(graceGuest.id);
  }, GRACE_MS + MESSAGE_TIMEOUT_MS);
  check(leaves, 'leave is forwarded to the hostlink when the grace expires');
  closeAll([newcomer.ws, newcomerLink, lonelyLink]);

  console.log('lone host leaving ends room');
  const loneHost = await createRoom('HOSTE1', 'Eve');
  loneHost.ws.close();
  await wait(GRACE_MS + 500);
  const lateJoiner = await joinRoom('HOSTE1', 'Late');
  check(lateJoiner.ok && lateJoiner.ok.t === 'no' && lateJoiner.ok.r === 'notfound', 'the room is gone after the grace');
  closeAll([lateJoiner.ws]);

  console.log('hostlink hardening');
  const hardenedHost = await createRoom('HOSTF1', 'Fay');
  const hardenedLink = await openHostLink('HOSTF1', hardenedHost.token);
  check(await waitFor(() => findType(hardenedLink, 'hoststart')), `the hostlink binds on ${HOST_LINK_PATH}`);
  const gameSocketLink = await open();
  send(gameSocketLink, { t: 'hostlink', code: 'HOSTF1', token: hardenedHost.token });
  send(gameSocketLink, { t: 'ping' });
  check(await waitFor(() => findType(gameSocketLink, 'pong')) && !gameSocketLink.closed, 'a hostlink sent on a game socket is ignored');
  check(!findType(gameSocketLink, 'hoststart') && !hardenedLink.closed, 'the game socket does not bind and the real hostlink stays');
  closeAll([gameSocketLink]);
  hardenedLink.send(JSON.stringify({ t: 'hst', players: [{ id: hardenedHost.id, s: 111 }], scores: [] }));
  hardenedLink.send(JSON.stringify({ t: 'hst', players: [{ id: hardenedHost.id, s: 999 }], scores: [], pad: 'a'.repeat(OVERSIZED_PAYLOAD_BYTES) }));
  hardenedLink.send('W|' + hardenedHost.id + '|{"t":"end"}');
  hardenedLink.send('W|' + hardenedHost.id + '|{"x":6,"t":"w"}');
  hardenedLink.send('W|' + hardenedHost.id + '|{"t":"w","x":7}');
  check(await waitFor(() => findMessage(hardenedHost.ws, message => message.t === 'w' && message.x === 7)), 'a W frame after the rejected ones is still relayed');
  await wait(SILENCE_MS);
  check(!findType(hardenedHost.ws, 'end') && !findMessage(hardenedHost.ws, message => message.x === 6),
    'W payloads not starting with {"t":"w" are dropped');
  check(!hardenedLink.closed && !hardenedHost.ws.closed, 'an oversized non-W hostlink frame is dropped without closing the room');
  const relink = await openHostLink('HOSTF1', hardenedHost.token);
  const relinkStart = await waitFor(() => findType(relink, 'hoststart'));
  const keptRow = relinkStart && relinkStart.state.find(row => row.id === hardenedHost.id);
  check(keptRow && keptRow.s === 111, 'the oversized hst is ignored and the last valid hst is kept');
  closeAll([hardenedHost.ws, hardenedLink, relink]);

  console.log('host rebind broadcast');
  {
  const rebindHost = await createRoom('HOSTR1', 'Ray');
  const rebindGuest = await joinRoom('HOSTR1', 'Sue');
  const countHostMessages = () => rebindGuest.ws.inbox.filter(message => message.t === 'host').length;
  const hostMessagesBeforeFirstBind = countHostMessages();
  const firstLink = await openHostLink('HOSTR1', rebindHost.token);
  check(await waitFor(() => findType(firstLink, 'hoststart')), 'the first hostlink binds');
  await wait(SILENCE_MS);
  check(countHostMessages() === hostMessagesBeforeFirstBind, 'the first bind after the election does not broadcast host again');
  const secondLink = await openHostLink('HOSTR1', rebindHost.token);
  check(await waitFor(() => findType(secondLink, 'hoststart')), 'the same host binds a second hostlink');
  check(await waitFor(() => countHostMessages() === hostMessagesBeforeFirstBind + 1), 'rebinding the host link broadcasts host to the guest');
  const rebindBroadcast = rebindGuest.ws.inbox.filter(message => message.t === 'host').pop();
  check(rebindBroadcast.id === rebindHost.id && rebindBroadcast.name === 'Ray', 'the rebind broadcast names the same host');
  await wait(SILENCE_MS);
  check(countHostMessages() === hostMessagesBeforeFirstBind + 1, 'the rebind broadcasts host exactly once');
  closeAll([rebindHost.ws, rebindGuest.ws, firstLink, secondLink]);
  }

  console.log('host reload rebind broadcast');
  {
  const reloadHost = await createRoom('HOSTR2', 'Rex');
  const reloadGuest = await joinRoom('HOSTR2', 'Sia', 'desktop', OLD_BUILD);
  const countReloadHostMessages = () => reloadGuest.ws.inbox.filter(message => message.t === 'host').length;
  const hostMessagesBeforeReload = countReloadHostMessages();
  const linkBeforeReload = await openHostLink('HOSTR2', reloadHost.token);
  check(await waitFor(() => findType(linkBeforeReload, 'hoststart')), 'the host link binds before the reload');
  closeAll([linkBeforeReload]);
  check(await waitFor(() => linkBeforeReload.closed), 'the host link closes with no eligible migrant');
  await wait(SILENCE_MS);
  check(countReloadHostMessages() === hostMessagesBeforeReload, 'closing the host link without a migrant broadcasts nothing');
  const linkAfterReload = await openHostLink('HOSTR2', reloadHost.token);
  check(await waitFor(() => findType(linkAfterReload, 'hoststart')), 'the reloaded host binds a new link');
  check(await waitFor(() => countReloadHostMessages() === hostMessagesBeforeReload + 1), 'the reloaded host link broadcasts host to the guest');
  const reloadBroadcast = reloadGuest.ws.inbox.filter(message => message.t === 'host').pop();
  check(reloadBroadcast.id === reloadHost.id && reloadBroadcast.name === 'Rex', 'the reload broadcast names the same host');
  await wait(SILENCE_MS);
  check(countReloadHostMessages() === hostMessagesBeforeReload + 1, 'the reload broadcasts host exactly once');
  closeAll([reloadHost.ws, reloadGuest.ws, linkAfterReload]);
  }

  console.log('first bind after a re-election');
  {
  const resigningOwner = await createRoom('HOSTR3', 'Ria');
  const electedGuest = await joinRoom('HOSTR3', 'Sol');
  const countElectionHostMessages = () => electedGuest.ws.inbox.filter(message => message.t === 'host').length;
  const ownerLink = await openHostLink('HOSTR3', resigningOwner.token);
  check(await waitFor(() => findType(ownerLink, 'hoststart')), 'the first host link binds before the resign');
  const hostMessagesBeforeResign = countElectionHostMessages();
  send(resigningOwner.ws, { t: 'resign' });
  check(await waitFor(() => countElectionHostMessages() === hostMessagesBeforeResign + 1), 'the resign elects the guest with one host message');
  const electedLink = await openHostLink('HOSTR3', electedGuest.token);
  check(await waitFor(() => findType(electedLink, 'hoststart')), 'the elected host binds its first link');
  await wait(SILENCE_MS);
  check(countElectionHostMessages() === hostMessagesBeforeResign + 1, 'the first bind after the re-election adds no host message');
  closeAll([resigningOwner.ws, electedGuest.ws, ownerLink, electedLink]);
  }

  console.log('binary snapshot relay');
  {
  const binaryHost = await createRoom('HOSTJ1', 'Joe');
  const binaryLink = await openHostLink('HOSTJ1', binaryHost.token);
  check(await waitFor(() => findType(binaryLink, 'hoststart')), 'the binary test hostlink binds');
  const binaryGuest = await joinRoom('HOSTJ1', 'Kim');
  const binaryFrame = (guestId, payload) => {
    const idBytes = Buffer.from(guestId);
    return Buffer.concat([Buffer.from([BINARY_SNAPSHOT_FRAME_BYTE, idBytes.length]), idBytes, Buffer.from(payload)]);
  };
  const firstCodecBytes = [0xB5, 0x01, 0x08, 0x01, 0x41];
  const secondCodecBytes = [0xB5, 0x01, 0x08, 0x01, 0x42];
  binaryLink.send(binaryFrame(binaryGuest.id, firstCodecBytes));
  binaryLink.send(binaryFrame('p99', [0xB5, 0x01, 0x08, 0x01, 0x43]));
  binaryLink.send(binaryFrame(binaryGuest.id, [0xB4, 0x01, 0x08, 0x01, 0x44]));
  binaryLink.send(binaryFrame(binaryGuest.id, [0xB5, 0x01]));
  binaryLink.send(Buffer.from([BINARY_SNAPSHOT_FRAME_BYTE, 0]));
  binaryLink.send(Buffer.from([BINARY_SNAPSHOT_FRAME_BYTE, 200, 0x61]));
  binaryLink.send(binaryFrame(binaryGuest.id, secondCodecBytes));
  check(await waitFor(() => binaryGuest.ws.binaryInbox.length >= 2), 'the guest receives binary snapshots');
  await wait(SILENCE_MS);
  check(binaryGuest.ws.binaryInbox.length === 2 && binaryGuest.ws.binaryInbox[0].equals(Buffer.from(firstCodecBytes)) && binaryGuest.ws.binaryInbox[1].equals(Buffer.from(secondCodecBytes)),
    'the guest gets exactly the codec bytes, without the W and id prefix');
  check(!binaryHost.ws.binaryInbox.length, 'the host game socket receives no binary snapshot');
  check(!binaryLink.closed, 'unknown ids, bad codec headers and short frames are dropped without closing the hostlink');
  const rawCodecProbe = binaryGuest.ws.binaryInbox.some(frame => frame[0] === BINARY_SNAPSHOT_FRAME_BYTE);
  check(!rawCodecProbe, 'no relayed frame keeps the hostlink prefix');
  closeAll([binaryHost.ws, binaryGuest.ws, binaryLink]);

  console.log('binary frames that are not snapshots terminate the hostlink');
  const foreignHost = await createRoom('HOSTK1', 'Lia');
  const foreignLink = await openHostLink('HOSTK1', foreignHost.token);
  check(await waitFor(() => findType(foreignLink, 'hoststart')), 'the foreign-binary test hostlink binds');
  foreignLink.send(Buffer.from([0x58, 1, 0x61, 0xB5, 0x01, 0x00]));
  check(await waitFor(() => foreignLink.closed) && foreignLink.closeCode === ABNORMAL_CLOSE_CODE, 'a binary frame not starting with 0x57 terminates the hostlink');
  const earlyBinaryLink = await open(PORT, HOST_LINK_PATH);
  const earlyBinarySentAt = Date.now();
  earlyBinaryLink.send(Buffer.from([BINARY_SNAPSHOT_FRAME_BYTE, 1, 0x61, 0xB5, 0x01, 0x00]));
  check(await waitFor(() => earlyBinaryLink.closed) && earlyBinaryLink.closeCode === ABNORMAL_CLOSE_CODE, 'a binary frame before the hostlink hello terminates it');
  check(Date.now() - earlyBinarySentAt < HOST_LINK_HELLO_MS / 2, 'the early binary frame is rejected before the hello timeout');
  closeAll([foreignHost.ws]);
  }

  console.log('hostlink keeps the deflate context');
  const deflateHost = await createRoom('HOSTH1', 'Ida');
  const openWithNegotiatedExtensions = async url => {
    const ws = new NodeWebSocket(url);
    ws.inbox = [];
    ws.on('message', data => { try { ws.inbox.push(JSON.parse(data)); } catch {} });
    ws.once('upgrade', response => { ws.negotiatedExtensions = response.headers['sec-websocket-extensions'] || ''; });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return ws;
  };
  const deflateLink = await openWithNegotiatedExtensions(`ws://127.0.0.1:${PORT}${HOST_LINK_PATH}`);
  const gameSocketDeflate = await openWithNegotiatedExtensions(`ws://127.0.0.1:${PORT}`);
  check(deflateLink.negotiatedExtensions.includes('permessage-deflate') && !deflateLink.negotiatedExtensions.includes('client_no_context_takeover'),
    `the hostlink negotiates client context takeover (${deflateLink.negotiatedExtensions})`);
  check(gameSocketDeflate.negotiatedExtensions.includes('client_no_context_takeover'),
    `the game socket keeps client_no_context_takeover (${gameSocketDeflate.negotiatedExtensions})`);
  deflateLink.send(JSON.stringify({ t: 'hostlink', code: 'HOSTH1', token: deflateHost.token }));
  await waitFor(() => findType(deflateLink, 'hoststart'));
  const repeatedSnapshot = { t: 'w', pad: 'car,'.repeat(500) };
  for (let frameIndex = 0; frameIndex < 3; frameIndex++) {
    deflateLink.send('W|' + deflateHost.id + '|' + JSON.stringify({ ...repeatedSnapshot, x: frameIndex }));
  }
  check(await waitFor(() => deflateHost.ws.inbox.filter(message => message.t === 'w').length === 3),
    'consecutive W frames compressed with a shared context are all relayed');
  closeAll([deflateHost.ws, deflateLink, gameSocketDeflate]);

  console.log('relay skips a reader over the buffer cap');
  const busyHost = await createRoom('HOSTG1', 'Gil');
  const busyLink = await openHostLink('HOSTG1', busyHost.token);
  await waitFor(() => findType(busyLink, 'hoststart'));
  const pausedReader = await joinPausedReader('HOSTG1', 'Sid');
  const backlogPad = 'a'.repeat(BACKLOG_FRAME_BYTES);
  for (let frameIndex = 0; frameIndex < BACKLOG_FRAME_COUNT; frameIndex++) {
    busyLink.send('W|' + pausedReader.id + '|' + JSON.stringify({ t: 'w', x: frameIndex, pad: backlogPad }));
  }
  await waitFor(() => busyLink.bufferedAmount === 0, CONNECT_TIMEOUT_MS);
  await wait(BACKLOG_SETTLE_MS);
  pausedReader.ws.resume();
  await wait(BACKLOG_SETTLE_MS);
  const relayedFrameCount = pausedReader.ws.inbox.filter(message => message.t === 'w').length;
  check(relayedFrameCount > 0 && relayedFrameCount < BACKLOG_FRAME_COUNT,
    `W frames are skipped while the reader is over the buffer cap (${relayedFrameCount}/${BACKLOG_FRAME_COUNT} relayed)`);
  closeAll([busyHost.ws, busyLink, pausedReader.ws]);

  console.log('stall check skips a lone player');
  check(/room\.players\.size > 1 && hostStalled\(room\)/.test(fs.readFileSync(path.join(import.meta.dirname, 'index.js'), 'utf8')),
    'the stall check runs pickHost only with more than one player');
  const serverSource = fs.readFileSync(path.join(import.meta.dirname, 'index.js'), 'utf8');
  const hostLinkMessageStart = serverSource.indexOf('function onHostLinkMessage(');
  const hostLinkMessageSource = serverSource.slice(hostLinkMessageStart, serverSource.indexOf('\nfunction ', hostLinkMessageStart + 1));
  const snapshotLineEnd = hostLinkMessageSource.indexOf('\n', hostLinkMessageSource.indexOf('if (isSnapshot)'));
  const frameClockIndex = hostLinkMessageSource.indexOf('room.hostLastFrameAt = now();', snapshotLineEnd);
  const hostPingEchoIndex = hostLinkMessageSource.indexOf("'hpo'");
  check(hostPingEchoIndex > 0 && frameClockIndex > hostPingEchoIndex, 'hpo is handled before the frame clock');

  console.log('bind deadline before the first frame');
  const slowHost = await createRoom('HOSTB1', 'Hal');
  const slowHostElectedAt = performance.now();
  const slowGuest = await joinRoom('HOSTB1', 'Gus');
  const slowLink = await openHostLink('HOSTB1', slowHost.token);
  echoHostPings(slowLink, { mode: 'instant' });
  await waitFor(() => findType(slowLink, 'hoststart'));
  await wait(HOST_STALL_MS + 1000 - (performance.now() - slowHostElectedAt));
  check(!findType(slowGuest.ws, 'host'), 'a host without its first frame is not replaced after the stall time');
  const bindElection = await waitFor(() => findType(slowGuest.ws, 'host'), HOST_BIND_MS + HOST_CHECK_SLACK_MS);
  const guestElectedAt = performance.now();
  const bindElectionMs = guestElectedAt - slowHostElectedAt;
  check(bindElection && bindElection.id === slowGuest.id && bindElectionMs >= HOST_BIND_MS - 200,
    `it is replaced once the bind deadline expires (${Math.round(bindElectionMs)} ms)`);
  check(await waitFor(() => slowLink.closed), 'the hostlink that never sent a frame is closed');

  console.log('stall clock starts at the first frame');
  for (const ws of [slowHost.ws, slowGuest.ws]) ws.inbox.length = 0;
  const guestLink = await openHostLink('HOSTB1', slowGuest.token);
  await waitFor(() => findType(guestLink, 'hoststart'));
  await wait(HOST_BIND_MS - FIRST_FRAME_BEFORE_BIND_DEADLINE_MS - (performance.now() - guestElectedAt));
  check(!findType(slowHost.ws, 'host'), 'no election before the first frame while the bind deadline runs');
  guestLink.send(JSON.stringify({ t: 'hst', players: [], scores: [] }));
  const firstFrameAt = performance.now();
  const firstFrameElection = await waitFor(() => findType(slowHost.ws, 'host'), HOST_STALL_MS + HOST_CHECK_SLACK_MS);
  const silenceAfterFirstFrameMs = performance.now() - firstFrameAt;
  check(firstFrameElection && firstFrameElection.id === slowHost.id && silenceAfterFirstFrameMs >= HOST_STALL_MS - 200,
    `the stall election comes HOST_STALL_MS after the first frame (${Math.round(silenceAfterFirstFrameMs)} ms)`);
  closeAll([slowHost.ws, slowGuest.ws, guestLink]);

  console.log('leaderboard from hst');
  const scoringHost = await enter(PORT, { t: 'create', code: 'LBHST1', name: 'Lena', max: 8, minutes: SHORT_MATCH_MINUTES });
  const scoringLink = await openHostLink('LBHST1', scoringHost.token);
  await waitFor(() => findType(scoringLink, 'hoststart'));
  scoringLink.send(JSON.stringify({
    t: 'hst',
    players: [{ id: scoringHost.id, s: HOST_SCORE }],
    scores: [{ id: scoringHost.id, s: HOST_SCORE, k: 3, d: 1 }, null, { id: 7, s: 1e9 }],
  }));
  check(await waitFor(() => findType(scoringHost.ws, 'end'), MATCH_END_TIMEOUT_MS), 'the short match ends');
  const board = await (await fetch(`http://127.0.0.1:${PORT}/leaderboard?limit=100`)).json();
  const lenaRow = board.top.find(row => row.name === 'Lena');
  check(lenaRow && lenaRow.score === HOST_SCORE && lenaRow.kills === 3 && lenaRow.deaths === 1,
    'the leaderboard records the hst score of the host');
  closeAll([scoringHost.ws, scoringLink]);

  console.log('host scores are bounded');
  const boundedCreatedAt = performance.now();
  const boundedHost = await enter(PORT, { t: 'create', code: 'LBHST2', name: 'Max', max: 8, minutes: SHORT_MATCH_MINUTES });
  const boundedLink = await openHostLink('LBHST2', boundedHost.token);
  await waitFor(() => findType(boundedLink, 'hoststart'));
  const futureGuestId = 'p' + (Number(boundedHost.id.slice(1)) + 1);
  boundedLink.send(JSON.stringify({
    t: 'hst',
    players: [{ id: boundedHost.id, s: IMPLAUSIBLE_SCORE, k: -4, d: 2.7 }, { id: futureGuestId, s: IMPLAUSIBLE_SCORE }],
    scores: [{ id: boundedHost.id, s: IMPLAUSIBLE_SCORE, k: -4, d: 2.7 }, { id: futureGuestId, s: GUEST_SCORE, k: 1, d: 0 }],
  }));
  await wait(200);
  const boundedScoreCap = Math.ceil((TEST_MAX_PPM * (performance.now() - boundedCreatedAt)) / 60_000);
  const lateGuest = await joinRoom('LBHST2', 'Gina');
  check(lateGuest.id === futureGuestId, 'the late guest gets the id the host reported early');
  const boundedRelink = await openHostLink('LBHST2', boundedHost.token);
  const boundedStart = await waitFor(() => findType(boundedRelink, 'hoststart'));
  const boundedRow = boundedStart && boundedStart.state.find(row => row.id === boundedHost.id);
  check(boundedRow && boundedRow.s > 0 && boundedRow.s <= boundedScoreCap && boundedRow.k === 0 && boundedRow.d === 2,
    `hst rows are clamped to non-negative integers within the elapsed-time cap (${boundedRow && boundedRow.s} <= ${boundedScoreCap})`);
  check(boundedStart && !boundedStart.state.some(row => row.id === futureGuestId), 'hst rows for ids not in the room are dropped');
  check(await waitFor(() => findType(boundedHost.ws, 'end'), MATCH_END_TIMEOUT_MS), 'the bounded match ends');
  const boundedBoard = await (await fetch(`http://127.0.0.1:${PORT}/leaderboard?limit=100`)).json();
  const recordedScoreCap = Math.ceil((TEST_MAX_PPM * (performance.now() - boundedCreatedAt)) / 60_000);
  const maxRow = boundedBoard.top.find(row => row.name === 'Max');
  check(maxRow && boundedRow && maxRow.score >= boundedRow.s && maxRow.score <= recordedScoreCap
    && maxRow.kills === 0 && maxRow.deaths === 2,
    `the leaderboard records the clamped host score (${boundedRow && boundedRow.s} <= ${maxRow && maxRow.score} <= ${recordedScoreCap})`);
  check(!boundedBoard.top.some(row => row.name === 'Gina'), 'a score reported for an id not yet in the room is never recorded');
  closeAll([boundedHost.ws, boundedLink, boundedRelink, lateGuest.ws]);

  console.log('hostlink hello timeout');
  const silentLinkOpenedAt = performance.now();
  const silentLink = await open(PORT, HOST_LINK_PATH);
  check(await waitFor(() => silentLink.closed, HOST_LINK_HELLO_MS + HOST_CHECK_SLACK_MS), 'a hostlink that never says hello is dropped');
  const silentLinkMs = performance.now() - silentLinkOpenedAt;
  check(silentLink.closeCode === ABNORMAL_CLOSE_CODE && silentLinkMs >= HOST_LINK_HELLO_MS - 200,
    `it is terminated once the hello timeout expires (${Math.round(silentLinkMs)} ms)`);

  console.log('hostlink abuse terminates the link');
  const abusedHost = await createRoom('HOSTR1', 'Rex');
  const binaryLink = await openHostLink('HOSTR1', abusedHost.token);
  await waitFor(() => findType(binaryLink, 'hoststart'));
  binaryLink.send(new Uint8Array([1, 2, 3]));
  check(await waitFor(() => binaryLink.closed) && binaryLink.closeCode === ABNORMAL_CLOSE_CODE, 'a binary frame terminates the hostlink');
  const burstLink = await openHostLink('HOSTR1', abusedHost.token);
  await waitFor(() => findType(burstLink, 'hoststart'));
  for (let messageIndex = 0; messageIndex < HOST_LINK_LEGIT_BURST; messageIndex++) {
    burstLink.send(JSON.stringify({ t: 'hst', players: [], scores: [] }));
  }
  await wait(SILENCE_MS);
  check(!burstLink.closed, `a burst of ${HOST_LINK_LEGIT_BURST} frames stays within the rate limit`);
  for (let messageIndex = 0; messageIndex < HOST_LINK_FLOOD_COUNT; messageIndex++) {
    burstLink.send(JSON.stringify({ t: 'hst', players: [], scores: [] }));
  }
  check(await waitFor(() => burstLink.closed) && burstLink.closeCode === ABNORMAL_CLOSE_CODE,
    `a flood of ${HOST_LINK_FLOOD_COUNT} frames terminates the hostlink`);
  check(!abusedHost.ws.closed, 'the host game socket survives the terminated hostlink');
  closeAll([abusedHost.ws]);

  console.log('guest input skips a host link over the buffer cap');
  const inputHost = await createRoom('HOSTI1', 'Ivo');
  const pausedHostLink = await openPausedHostLink('HOSTI1', inputHost.token);
  const floodingGuest = await joinRoom('HOSTI1', 'Flo');
  const floodInput = { t: 'i', ax: 1, ay: -1, aim: -3.14453125, b: 15, px: 12345, py: 12345, cx: 12345, cy: 12345,
    ca: -3.14453125, csp: -12.34, w: 3, vr: 1250, drive: { active: true, angle: -3.14453125 } };
  for (let inputIndex = 0; inputIndex < INPUT_FLOOD_COUNT; inputIndex++) send(floodingGuest.ws, { ...floodInput, seq: inputIndex });
  send(floodingGuest.ws, { t: 'ping' });
  await waitFor(() => findType(floodingGuest.ws, 'pong'), CONNECT_TIMEOUT_MS);
  pausedHostLink.resume();
  await wait(BACKLOG_SETTLE_MS);
  const forwardedInputCount = pausedHostLink.inbox.filter(message => message.t === 'i').length;
  check(forwardedInputCount > 0 && forwardedInputCount < INPUT_FLOOD_COUNT,
    `guest inputs are skipped while the host link is over the buffer cap (${forwardedInputCount}/${INPUT_FLOOD_COUNT} forwarded)`);
  closeAll([inputHost.ws, pausedHostLink, floodingGuest.ws]);

  console.log('fallback when nobody eligible');
  const oldCreator = await enter(PORT, { t: 'create', code: 'FALL01', name: 'Olga', max: 8, minutes: 0, build: OLD_BUILD });
  check(oldCreator.ok && oldCreator.ok.host === null && oldCreator.ok.sim === true, 'ok.host is null when no player has the server build');
  const oldGuest = await joinRoom('FALL01', 'Otto', 'desktop', OLD_BUILD);
  check(oldGuest.ok && oldGuest.ok.host === null, 'a later old-build guest also gets ok.host null');
  check(await waitFor(() => findType(oldCreator.ws, 'w')) && await waitFor(() => findType(oldGuest.ws, 'w')),
    'both players receive w snapshots from the server sim');
  const guestSnapshot = findType(oldGuest.ws, 'w');
  check(guestSnapshot && guestSnapshot.me && guestSnapshot.me.sco === 0 && guestSnapshot.sc.length === 2,
    'the fallback sim tracks both players once');
  closeAll([oldCreator.ws, oldGuest.ws]);
  const publicOldCreator = await enter(PORT, { t: 'create', code: 'FALL03', name: 'Fay', max: 8, minutes: 5, build: OLD_BUILD, public: true, title: 'Fallback' });
  check(publicOldCreator.ok && publicOldCreator.ok.sim === true && publicOldCreator.ok.host === null, 'a public old-build room falls back to the server sim');
  const fallbackRow = await publicRoomRow('FALL03');
  check(fallbackRow && fallbackRow.hostRttMs === 0, `a HOST_MODE room on the server-sim fallback reports hostRttMs 0 (${fallbackRow && fallbackRow.hostRttMs})`);
  closeAll([publicOldCreator.ws]);

  console.log('fallback restores the hst state');
  const resigningHost = await createRoom('FALL02', 'Rita');
  const oldPeer = await joinRoom('FALL02', 'Pete', 'desktop', OLD_BUILD);
  const resigningLink = await openHostLink('FALL02', resigningHost.token);
  await waitFor(() => findType(resigningLink, 'hoststart'));
  resigningLink.send(JSON.stringify({
    t: 'hst',
    players: [{ id: resigningHost.id, s: HOST_SCORE, cash: 777 }, { id: oldPeer.id, s: GUEST_SCORE }],
    scores: [{ id: resigningHost.id, s: HOST_SCORE }, { id: oldPeer.id, s: GUEST_SCORE }],
  }));
  await wait(200);
  send(resigningHost.ws, { t: 'resign' });
  const fallbackNotice = await waitFor(() => findType(oldPeer.ws, 'host'));
  check(fallbackNotice && fallbackNotice.id === null, 'the peer is told there is no host any more');
  check(await waitFor(() => resigningLink.closed), 'the resigned host link is closed');
  const hostSnapshot = await waitFor(() => findType(resigningHost.ws, 'w'));
  check(hostSnapshot && hostSnapshot.me.sco === HOST_SCORE && hostSnapshot.me.cash === 777,
    'the fallback sim restores the host from the last hst');
  const peerSnapshot = await waitFor(() => findType(oldPeer.ws, 'w'));
  check(peerSnapshot && peerSnapshot.me.sco === GUEST_SCORE, 'the fallback sim restores the peer from the last hst');
  check(peerSnapshot && Array.isArray(peerSnapshot.sc) && peerSnapshot.sc.length === 2, 'each player is in the fallback sim exactly once');
  closeAll([resigningHost.ws, oldPeer.ws, resigningLink]);

  console.log('resign elects another');
  const quittingHost = await createRoom('RESG01', 'Quinn');
  const nextHost = await joinRoom('RESG01', 'Nora', 'touch');
  send(quittingHost.ws, { t: 'resign' });
  const resignElection = await waitFor(() => findType(nextHost.ws, 'host'));
  check(resignElection && resignElection.id === nextHost.id, 'resign elects the other eligible player');
  closeAll([quittingHost.ws, nextHost.ws]);

  console.log('resign from a non-host is ignored');
  const stayingHost = await createRoom('RESG02', 'Hank');
  const staleResigner = await joinRoom('RESG02', 'Gail', 'touch');
  send(staleResigner.ws, { t: 'resign' });
  await wait(SILENCE_MS);
  check(!findType(stayingHost.ws, 'host') && !findType(staleResigner.ws, 'host'), 'a non-host resign triggers no election');
  send(stayingHost.ws, { t: 'resign' });
  const laterElection = await waitFor(() => findType(staleResigner.ws, 'host'));
  check(laterElection && laterElection.id === staleResigner.id, 'a later election can still pick the player whose resign was ignored');
  closeAll([stayingHost.ws, staleResigner.ws]);

  console.log('host link ping and hostRttMs');
  const pingHost = await enter(PORT, { t: 'create', code: 'HPING1', name: 'Pia', dev: 'desktop', max: 4, minutes: 5, public: true, title: 'Ping' });
  const unmeasuredRow = await publicRoomRow('HPING1');
  check(unmeasuredRow && unmeasuredRow.hostRttMs === null, 'hostRttMs is null until measured');
  const pingLink = await openHostLink('HPING1', pingHost.token);
  const pingEcho = { mode: 'none', lastAnsweredC: null };
  echoHostPings(pingLink, pingEcho);
  const firstHostPing = await waitFor(() => findType(pingLink, 'hp'));
  check(firstHostPing && Number.isFinite(firstHostPing.c), 'the server pings the hostlink right after binding');
  send(pingLink, { t: 'hpo', c: 1 });
  await wait(2 * HOST_LINK_PING_MS);
  const forgedEchoRow = await publicRoomRow('HPING1');
  check(forgedEchoRow && forgedEchoRow.hostRttMs === null, 'an hpo with an unknown c is ignored');
  pingEcho.mode = 'delayed';
  const delayedRow = await waitForRoomRow('HPING1', row => row.hostRttMs !== null);
  check(delayedRow && delayedRow.hostRttMs >= HOST_PING_ECHO_DELAY_MS && delayedRow.hostRttMs < HOST_PING_ECHO_DELAY_MS + HOST_CHECK_SLACK_MS,
    `hostRttMs reflects the echo delay (${delayedRow && delayedRow.hostRttMs})`);
  pingEcho.mode = 'instant';
  await wait(6 * HOST_LINK_PING_MS);
  const smoothedRow = await publicRoomRow('HPING1');
  check(smoothedRow && delayedRow && smoothedRow.hostRttMs < delayedRow.hostRttMs && smoothedRow.hostRttMs > 0,
    `hostRttMs is smoothed towards faster samples (${smoothedRow && smoothedRow.hostRttMs})`);
  pingEcho.mode = 'none';
  await wait(HOST_LINK_PING_MS);
  const settledRow = await publicRoomRow('HPING1');
  for (let replayIndex = 0; replayIndex < HOST_PING_REPLAY_COUNT; replayIndex++) send(pingLink, { t: 'hpo', c: pingEcho.lastAnsweredC });
  await wait(2 * HOST_LINK_PING_MS);
  const replayedRow = await publicRoomRow('HPING1');
  check(settledRow && replayedRow && Math.abs(replayedRow.hostRttMs - settledRow.hostRttMs) <= 1,
    `a replayed hpo adds no sample (${settledRow && settledRow.hostRttMs} -> ${replayedRow && replayedRow.hostRttMs})`);
  const pingGuest = await joinRoom('HPING1', 'Gil');
  send(pingHost.ws, { t: 'resign' });
  const pingElection = await waitFor(() => findType(pingGuest.ws, 'host'));
  const newHostRow = await publicRoomRow('HPING1');
  check(pingElection && pingElection.id === pingGuest.id && newHostRow && newHostRow.hostRttMs === null, 'a new host starts unmeasured');
  closeAll([pingHost.ws, pingLink, pingGuest.ws]);

  console.log('server mode keeps the old handshake');
  const serverModePlayer = await enter(SERVER_MODE_PORT, { t: 'create', code: 'SRVM01', name: 'Sam', max: 8, minutes: 0 });
  check(serverModePlayer.ok && serverModePlayer.ok.sim === true && !('host' in serverModePlayer.ok), 'ok has sim true and no host field');
  check(await connectionOutcome(SERVER_MODE_PORT, HOST_LINK_PATH) === 'refused', `a ${HOST_LINK_PATH} connection is refused in server mode`);
  const serverModeLink = await open(SERVER_MODE_PORT);
  send(serverModeLink, { t: 'hostlink', code: 'SRVM01', token: serverModePlayer.token });
  send(serverModeLink, { t: 'ping' });
  check(await waitFor(() => findType(serverModeLink, 'pong')) && !serverModeLink.closed, 'a hostlink sent on a game socket is ignored in server mode');
  check(!findType(serverModeLink, 'hoststart'), 'no hoststart in server mode');
  closeAll([serverModePlayer.ws, serverModeLink]);

  console.log('police room option');
  const defaultPoliceHost = await createRoom('POLD01', 'Dora');
  check(defaultPoliceHost.ok && defaultPoliceHost.ok.police === true, 'ok.police defaults to true');
  const junkPoliceHost = await enter(PORT, { t: 'create', code: 'POLJ01', name: 'Jim', max: 8, minutes: 0, police: 'off' });
  check(junkPoliceHost.ok && junkPoliceHost.ok.police === true, 'a non-boolean police value falls back to true');
  const policeOffHost = await enter(PORT, { t: 'create', code: 'POLF01', name: 'Fred', max: 8, minutes: 0, police: false });
  check(policeOffHost.ok && policeOffHost.ok.police === false, 'ok.police is false for a police-off room');
  const policeOffGuest = await joinRoom('POLF01', 'Gina');
  check(policeOffGuest.ok && policeOffGuest.ok.police === false, 'a joining guest gets ok.police false');
  const policeOffLink = await openHostLink('POLF01', policeOffHost.token);
  const policeOffStart = await waitFor(() => findType(policeOffLink, 'hoststart'));
  check(policeOffStart && policeOffStart.police === false, 'hoststart carries police false');
  send(policeOffHost.ws, { t: 'resign' });
  const policeOffNewHost = await waitFor(() => findType(policeOffGuest.ws, 'host'));
  check(policeOffNewHost && policeOffNewHost.id === policeOffGuest.id, 'the guest becomes host after the resign');
  const migratedLink = await openHostLink('POLF01', policeOffGuest.token);
  const migratedStart = await waitFor(() => findType(migratedLink, 'hoststart'));
  check(migratedStart && migratedStart.police === false, 'after migration hoststart still carries police false');
  closeAll([defaultPoliceHost.ws, junkPoliceHost.ws, policeOffHost.ws, policeOffGuest.ws, policeOffLink, migratedLink]);

  console.log('police room option in server mode');
  const serverPoliceOn = await enter(SERVER_MODE_PORT, { t: 'create', code: 'SPON01', name: 'Olly', max: 8, minutes: 0 });
  const policeOnResult = await punchPedestrians(serverPoliceOn.ws, snapshot => snapshot.me.wanted >= 1 && snapshot.peds.some(p => p.role === 'cop'));
  console.log('  ', JSON.stringify(policeOnResult));
  check(policeOnResult.done, 'server sim: punching pedestrians brings stars and cops');
  const serverPoliceOff = await enter(SERVER_MODE_PORT, { t: 'create', code: 'SPOF01', name: 'Ophelia', max: 8, minutes: 0, police: false });
  check(serverPoliceOff.ok && serverPoliceOff.ok.police === false, 'server mode ok.police is false for a police-off room');
  const policeOffResult = await punchPedestrians(serverPoliceOff.ws, (snapshot, progress) => progress.knockedPeds >= POLICE_OFF_KNOCKOUTS);
  console.log('  ', JSON.stringify(policeOffResult));
  check(policeOffResult.done && policeOffResult.maxWanted === 0 && policeOffResult.maxCops === 0,
    'server sim with the police off: knockouts bring no stars and no cops');
  closeAll([serverPoliceOn.ws, serverPoliceOff.ws]);

  console.log('day/night room option');
  const dayNightDefaultHost = await createRoom('DNDF01', 'Dina');
  check(dayNightDefaultHost.ok && dayNightDefaultHost.ok.dayNight === true, 'an old client create without dayNight gives ok.dayNight true');
  const dayNightJunkHost = await enter(PORT, { t: 'create', code: 'DNJK01', name: 'Jack', max: 8, minutes: 0, dayNight: 'off' });
  check(dayNightJunkHost.ok && dayNightJunkHost.ok.dayNight === true, 'a non-boolean dayNight falls back to true');
  const dayNightOffHost = await enter(PORT, { t: 'create', code: 'DNOF01', name: 'Nora', max: 8, minutes: 5, dayNight: false });
  check(dayNightOffHost.ok && dayNightOffHost.ok.dayNight === false, 'ok.dayNight is false for a day/night-off room');
  const dayNightOffGuest = await joinRoom('DNOF01', 'Gus');
  check(dayNightOffGuest.ok && dayNightOffGuest.ok.dayNight === false, 'a late joiner gets the host choice in ok.dayNight');
  dayNightOffGuest.ws.close();
  const dayNightResumed = await enter(PORT, { t: 'join', code: 'DNOF01', token: dayNightOffGuest.token });
  check(dayNightResumed.ok && dayNightResumed.ok.resumed === true && dayNightResumed.ok.dayNight === false, 'a reconnect ok carries dayNight false');
  closeAll([dayNightDefaultHost.ws, dayNightJunkHost.ws, dayNightOffHost.ws, dayNightResumed.ws]);

  console.log('webrtc signaling relay');
  const rtcHost = await createRoom('RTC001', 'Rita');
  const rtcGuestB = await joinRoom('RTC001', 'Bob');
  const rtcGuestC = await joinRoom('RTC001', 'Cleo');
  const isRtcFrom = (senderId, kind) => message => message.t === 'rtc' && message.from === senderId && message.k === kind;
  send(rtcGuestB.ws, { t: 'rtc', to: rtcHost.id, k: 'offer', d: 'v=0 offer' });
  const relayedOffer = await waitFor(() => findMessage(rtcHost.ws, isRtcFrom(rtcGuestB.id, 'offer')));
  check(relayedOffer && relayedOffer.d === 'v=0 offer', 'the host receives the guest offer signed with the sender id');
  send(rtcHost.ws, { t: 'rtc', to: rtcGuestB.id, k: 'ice', d: { candidate: 'c', sdpMid: '0' } });
  const relayedIce = await waitFor(() => findMessage(rtcGuestB.ws, isRtcFrom(rtcHost.id, 'ice')));
  check(relayedIce && relayedIce.d.candidate === 'c' && relayedIce.d.sdpMid === '0', 'the guest receives the host ICE candidate signed with the host id');
  send(rtcGuestB.ws, { t: 'rtc', to: rtcGuestC.id, k: 'offer', d: 'v=0 guest to guest' });
  send(rtcGuestB.ws, { t: 'rtc', to: rtcGuestB.id, k: 'offer', d: 'v=0 to self' });
  send(rtcHost.ws, { t: 'rtc', to: 'p99', k: 'offer', d: 'v=0 unknown target' });
  await wait(SILENCE_MS);
  check(!findType(rtcGuestC.ws, 'rtc'), 'a guest to guest signal is dropped');
  check(!findMessage(rtcGuestB.ws, message => message.t === 'rtc' && message.k === 'offer'), 'a signal addressed to the sender is dropped');
  const rtcHostInboxBefore = rtcHost.ws.inbox.filter(message => message.t === 'rtc').length;
  send(rtcGuestB.ws, { t: 'rtc', to: rtcHost.id, k: 'bogus', d: 'v=0' });
  send(rtcGuestB.ws, { t: 'rtc', to: rtcHost.id, k: 'offer', d: 'x'.repeat(16385) });
  send(rtcGuestB.ws, { t: 'rtc', to: rtcHost.id, k: 'ice', d: { candidate: 'x'.repeat(2048) } });
  send(rtcGuestB.ws, { t: 'rtc', to: rtcHost.id, k: 'ice', d: 'not an object' });
  await wait(SILENCE_MS);
  check(rtcHost.ws.inbox.filter(message => message.t === 'rtc').length === rtcHostInboxBefore, 'unknown kinds and oversized or malformed payloads are dropped');
  closeAll([rtcHost.ws, rtcGuestB.ws, rtcGuestC.ws]);

  console.log('webrtc signaling budget');
  const budgetHost = await createRoom('RTC002', 'Hana');
  const budgetGuest = await joinRoom('RTC002', 'Ben');
  const relayedFromGuest = kind => budgetHost.ws.inbox.filter(isRtcFrom(budgetGuest.id, kind)).length;
  send(budgetGuest.ws, { t: 'rtc', to: budgetHost.id, k: 'offer', d: 'v=0 first' });
  send(budgetGuest.ws, { t: 'rtc', to: budgetHost.id, k: 'offer', d: 'v=0 second' });
  await wait(SILENCE_MS);
  check(relayedFromGuest('offer') === 1 && findMessage(budgetHost.ws, isRtcFrom(budgetGuest.id, 'offer')).d === 'v=0 first',
    'two offers within 1000 ms: only the first is relayed');
  for (let n = 0; n < 33; n++) send(budgetGuest.ws, { t: 'rtc', to: budgetHost.id, k: 'ice', d: { candidate: 'c' + n } });
  await wait(SILENCE_MS);
  check(relayedFromGuest('ice') === 32, '33 ICE candidates after one offer: 32 are relayed');
  for (let n = 0; n < 32; n++) send(budgetHost.ws, { t: 'rtc', to: budgetGuest.id, k: 'ice', d: { candidate: 'h' + n } });
  send(budgetHost.ws, { t: 'rtc', to: budgetGuest.id, k: 'answer', d: 'v=0 answer' });
  send(budgetHost.ws, { t: 'rtc', to: budgetGuest.id, k: 'ice', d: { candidate: 'after-answer' } });
  await wait(SILENCE_MS);
  check(budgetGuest.ws.inbox.some(message => message.t === 'rtc' && message.k === 'ice' && message.d.candidate === 'after-answer'),
    'the host ICE after its answer is still relayed');
  closeAll([budgetHost.ws, budgetGuest.ws]);

  await wait(200);
  console.log(failures ? `\n${failures} host-mode checks FAILED` : '\nall host-mode checks passed');
} catch (error) {
  console.error('test error:', error);
  failures++;
} finally {
  hostServer.kill('SIGTERM');
  serverModeServer.kill('SIGTERM');
  await wait(200);
  try { fs.rmSync(LEADERBOARD_DIR, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}
