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
const BACKLOG_FRAME_COUNT = 24;
const BACKLOG_FRAME_BYTES = 900_000;
const BACKLOG_SETTLE_MS = 1500;
const OLD_BUILD = 'old';
const SHORT_MATCH_MINUTES = 0.05;
const MATCH_END_TIMEOUT_MS = 8000;
const HOST_SCORE = 300;
const GUEST_SCORE = 40;
const LEADERBOARD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-host-lb-'));

function startServer(port, simMode, label) {
  const child = spawn('node', ['index.js'], {
    cwd: import.meta.dirname,
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', STATIC_DIR: '',
      LC_BUILD: BUILD, SIM_MODE: simMode, GRACE_MS: String(GRACE_MS), HOST_BIND_MS: String(HOST_BIND_MS),
      LEADERBOARD_FILE: path.join(LEADERBOARD_DIR, `${label}.json`),
      LEADERBOARD_QUALIFY_MS: '200', LEADERBOARD_MIN_SESSION_MS: '50',
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
    ws.closed = false;
    ws.addEventListener('message', event => { try { ws.inbox.push(JSON.parse(event.data)); } catch {} });
    ws.addEventListener('close', () => { ws.closed = true; });
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

const closeAll = sockets =>{ for (const ws of sockets) { try { ws.close(); } catch {} } };

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
  send(playerA.ws, { t: 'i', marker: 'from-host' });
  send(playerB.ws, { t: 'i', marker: 'from-guest', id: 'p99' });
  const forwardedInput = await waitFor(() => findMessage(hostLinkA, message => message.t === 'i' && message.marker === 'from-guest'));
  check(forwardedInput && forwardedInput.id === playerB.id, 'the guest input reaches the hostlink signed with the sender id');
  check(!findMessage(hostLinkA, message => message.t === 'i' && message.marker === 'from-host'), 'the host own input is not echoed to its hostlink');

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

  console.log('bind deadline before the first frame');
  const slowHost = await createRoom('HOSTB1', 'Hal');
  const slowHostElectedAt = performance.now();
  const slowGuest = await joinRoom('HOSTB1', 'Gus');
  const slowLink = await openHostLink('HOSTB1', slowHost.token);
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
