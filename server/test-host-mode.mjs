import { spawn } from 'node:child_process';

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

function startServer(port, simMode, label) {
  const child = spawn('node', ['index.js'], {
    cwd: import.meta.dirname,
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', STATIC_DIR: '',
      LC_BUILD: BUILD, SIM_MODE: simMode, GRACE_MS: String(GRACE_MS),
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

function openOnce(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.inbox = [];
    ws.closed = false;
    ws.addEventListener('message', event => { try { ws.inbox.push(JSON.parse(event.data)); } catch {} });
    ws.addEventListener('close', () => { ws.closed = true; });
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', reject);
  });
}

async function open(port = PORT) {
  const deadline = performance.now() + CONNECT_TIMEOUT_MS;
  for (;;) {
    try { return await openOnce(port); }
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
  const ws = await open();
  send(ws, { t: 'hostlink', code, token });
  return ws;
}

const closeAll = sockets => { for (const ws of sockets) { try { ws.close(); } catch {} } };

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
  check(await waitFor(() => oversizedSender.closed), 'an oversized frame from a non-hostlink socket closes it');
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

  console.log('server mode keeps the old handshake');
  const serverModePlayer = await enter(SERVER_MODE_PORT, { t: 'create', code: 'SRVM01', name: 'Sam', max: 8, minutes: 0 });
  check(serverModePlayer.ok && serverModePlayer.ok.sim === true && !('host' in serverModePlayer.ok), 'ok has sim true and no host field');
  const serverModeLink = await open(SERVER_MODE_PORT);
  send(serverModeLink, { t: 'hostlink', code: 'SRVM01', token: serverModePlayer.token });
  check(await waitFor(() => serverModeLink.closed), 'hostlink is refused in server mode');
  check(!findType(serverModeLink, 'hoststart'), 'no hoststart in server mode');
  closeAll([serverModePlayer.ws]);

  await wait(200);
  console.log(failures ? `\n${failures} host-mode checks FAILED` : '\nall host-mode checks passed');
} catch (error) {
  console.error('test error:', error);
  failures++;
} finally {
  hostServer.kill('SIGTERM');
  serverModeServer.kill('SIGTERM');
  await wait(200);
  process.exit(failures ? 1 : 0);
}
