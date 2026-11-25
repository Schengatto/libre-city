const SIM_HOST_LINK_PATH = '/hostlink';

let simHostWorker = null;

function simHostWorkerUrl() {
  return document.querySelector('meta[name="lc-sim-worker"]').content;
}

function simHostLinkUrl() {
  return new URL(SIM_HOST_LINK_PATH, net.url).href;
}

function simHostResign() {
  netSend({ t: 'resign' });
  simHostStop();
}

function simHostStart() {
  simHostStop();
  let worker, startMessage;
  try {
    startMessage = { type: 'start', code: ROOM_CODE, hostId: net.myId, url: simHostLinkUrl(), token: net.token };
    worker = new Worker(simHostWorkerUrl(), { name: ROOM_CODE });
  } catch {
    simHostResign();
    return;
  }
  simHostWorker = worker;
  worker.onmessage = event => {
    if (worker !== simHostWorker) return;
    const message = event.data;
    if (!message) return;
    if (message.type === 'snapshot') netOnSnapshot(message.snapshot);
    else if (message.type === 'guestFrame') rtcHostSendFrame(message.id, message.snapshot, message.events);
    else if (message.type === 'error') simHostResign();
  };
  worker.onerror = () => { if (worker === simHostWorker) simHostResign(); };
  worker.postMessage(startMessage);
}

function simHostSetP2P(id, open) {
  if (simHostWorker) simHostWorker.postMessage({ type: 'p2p', id, open });
}

function simHostForwardGuestInput(id, input) {
  if (simHostWorker) simHostWorker.postMessage({ type: 'guestInput', id, input });
}

function simHostStop() {
  rtcHostCloseAll();
  const worker = simHostWorker;
  if (!worker) return;
  simHostWorker = null;
  worker.onmessage = null;
  worker.onerror = null;
  worker.terminate();
}

function simHostSendInput(payload) {
  if (simHostWorker) simHostWorker.postMessage({ type: 'input', input: payload });
}

function simHostActive() {
  return simHostWorker !== null;
}
