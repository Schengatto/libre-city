(function () {
  // dev-only:begin
  const SIM_SCRIPT_FILES = ['core.js', 'i18n.js', 'city.js', 'train.js', 'entities.js', 'missions.js', 'army.js', 'gameplay.js', 'server-sim-glue.js'];
  // dev-only:end
  const STEP_MS = 1000 / 60;
  const MAX_CATCHUP_MS = 250;
  const TICK_TIMER_MS = 16;
  const SNAPSHOT_EVERY_TICKS = 2;
  const HOST_STATE_INTERVAL_MS = 500;
  const OPEN_SOCKET_STATE = 1;
  const bundled = typeof makeSimStubs === 'function';

  let sim = null;
  let hostId = null;
  let socket = null;
  let tickTimer = null;
  let hostStateTimer = null;
  let accumulatorMs = 0;
  let lastTickAt = 0;
  let tickCount = 0;
  const memberIds = new Set();

  function post(message) { self.postMessage(message); }

  function accumulateSimTime(currentAccumulatorMs, elapsedMs) {
    return currentAccumulatorMs + Math.min(elapsedMs, MAX_CATCHUP_MS);
  }

  function applySimStubs(roomCode) {
    const stubs = makeSimStubs(roomCode, 900, self);
    for (const key in stubs) if (!(key in self)) self[key] = stubs[key];
  }

  // dev-only:begin
  function loadSimScripts(roomCode) {
    importScripts('sim-stubs.js');
    applySimStubs(roomCode);
    importScripts(...SIM_SCRIPT_FILES);
  }
  // dev-only:end

  if (bundled) applySimStubs(self.location.hash.replace(/^#room=/, ''));

  function sendToServer(payload) {
    if (socket && socket.readyState === OPEN_SOCKET_STATE) socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  function addMember(id, name, shirtIdx) {
    if (memberIds.has(id)) return;
    sim.addPlayer(name, shirtIdx, id);
    memberIds.add(id);
  }

  function startRoom(roster, state) {
    const rowById = new Map((Array.isArray(state) ? state : []).filter(row => row && typeof row.id === 'string').map(row => [row.id, row]));
    for (const entry of roster) {
      if (!entry || typeof entry.id !== 'string' || memberIds.has(entry.id)) continue;
      const row = rowById.get(entry.id);
      if (row) {
        sim.restorePlayer(entry.id, entry.name, entry.shirtIdx, row);
        memberIds.add(entry.id);
      } else addMember(entry.id, entry.name, entry.shirtIdx);
    }
  }

  function sendSnapshots() {
    const scores = sim.scores();
    for (const id of memberIds) {
      const snapshot = sim.snapshotFor(id);
      if (!snapshot) continue;
      snapshot.sc = scores;
      if (id === hostId) post({ type: 'snapshot', snapshot });
      else sendToServer('W|' + id + '|' + JSON.stringify(snapshot));
    }
    sim.clearFx();
  }

  function advanceSimulation() {
    const now = performance.now();
    accumulatorMs = accumulateSimTime(accumulatorMs, now - lastTickAt);
    lastTickAt = now;
    let snapshotDue = false;
    try {
      while (accumulatorMs >= STEP_MS) {
        sim.tick();
        accumulatorMs -= STEP_MS;
        if (++tickCount % SNAPSHOT_EVERY_TICKS === 0) snapshotDue = true;
      }
      if (snapshotDue) sendSnapshots();
    } catch (error) {
      stopRoom();
      post({ type: 'error', message: String(error && error.message || error) });
    }
  }

  function sendHostState() {
    sendToServer({ t: 'hst', players: sim.exportPlayers(), scores: sim.scores() });
  }

  function beginTicking() {
    accumulatorMs = 0;
    lastTickAt = performance.now();
    tickTimer = setInterval(advanceSimulation, TICK_TIMER_MS);
    hostStateTimer = setInterval(sendHostState, HOST_STATE_INTERVAL_MS);
  }

  function handleServerMessage(message) {
    switch (message.t) {
      case 'hoststart':
        if (tickTimer) return;
        startRoom(Array.isArray(message.roster) ? message.roster : [], message.state);
        beginTicking();
        post({ type: 'ready' });
        break;
      case 'i':
        if (sim && typeof message.id === 'string') sim.applyInput(message.id, message);
        break;
      case 'join':
        if (sim && typeof message.id === 'string') addMember(message.id, message.name, message.shirtIdx);
        break;
      case 'leave':
        if (sim && memberIds.delete(message.id)) sim.removePlayer(message.id);
        break;
    }
  }

  function openHostLink(url, roomCode, token) {
    socket = new WebSocket(url);
    socket.onopen = () => socket.send(JSON.stringify({ t: 'hostlink', code: roomCode, token }));
    socket.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== 'object') return;
      try { handleServerMessage(message); } catch (error) { post({ type: 'error', message: String(error && error.message || error) }); }
    };
    socket.onclose = () => {
      if (!sim) return;
      stopRoom();
      post({ type: 'error', message: 'hostlink closed' });
    };
  }

  function stopRoom() {
    clearInterval(tickTimer);
    clearInterval(hostStateTimer);
    tickTimer = null;
    hostStateTimer = null;
    sim = null;
    memberIds.clear();
    if (socket) {
      const closingSocket = socket;
      socket = null;
      closingSocket.onclose = null;
      try { closingSocket.close(); } catch {}
    }
  }

  function start(message) {
    if (sim) return;
    try {
      const roomCode = String(message.code || '').toUpperCase();
      // dev-only:begin
      if (!bundled) loadSimScripts(roomCode);
      // dev-only:end
      sim = __sim;
      hostId = message.hostId;
      openHostLink(message.url, roomCode, message.token);
    } catch (error) {
      sim = null;
      post({ type: 'error', message: String(error && error.message || error) });
    }
  }

  self.onmessage = event => {
    const message = event.data;
    if (!message) return;
    if (message.type === 'start') start(message);
    else if (message.type === 'input') { if (sim && message.input) sim.applyInput(hostId, message.input); }
    else if (message.type === 'stop') stopRoom();
  };
})();
