const EMOTES = ['👋', '👍', '👎', '😂', '😡', '😱', '🔥', '🚓'];
const EMOTE_COOLDOWN_MS = 5000;
const EMOTE_BUBBLE_MS = 3000;
const EMOTE_BAR_AUTOCLOSE_MS = 4000;
const EMOTE_RING_CIRCUMFERENCE = 169.6;
const EMOTE_BODY_ANCHOR_OFFSET = 56;
const EMOTE_CAR_ANCHOR_OFFSET = 12;
const EMOTE_OFFSCREEN_MARGIN = 60;
const EMOTE_FONT_FAMILY = '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';

const emoteState = { barOpen: false, lastSentAt: -Infinity, bubbles: new Map() };
let emoteAutoCloseTimer = null;
let emoteHintRendered = '';

function isValidEmoteIndex(index) {
  return Number.isInteger(index) && index >= 0 && index < EMOTES.length;
}

function emoteCooldownLeft(lastSentAt, nowMs) {
  return Math.max(0, EMOTE_COOLDOWN_MS - (nowMs - lastSentAt));
}

function emoteBubbleLook(ageMs) {
  if (ageMs > EMOTE_BUBBLE_MS) return null;
  const age = Math.max(0, ageMs);
  const popIn = Math.min(1, age / 140);
  const fadeOut = Math.min(1, (EMOTE_BUBBLE_MS - age) / 400);
  const scale = popIn < 1 ? 0.6 + 0.5 * popIn : 1 + 0.06 * Math.sin(age / 120) * fadeOut;
  return { alpha: fadeOut, scale, rise: Math.min(10, age / 60) };
}

function sendEmote(index) {
  const nowMs = performance.now();
  if (!net.mode || !isValidEmoteIndex(index) || emoteCooldownLeft(emoteState.lastSentAt, nowMs) > 0) return false;
  netSend({ t: 'emo', e: index });
  emoteState.bubbles.set('me', { index, at: nowMs });
  emoteState.lastSentAt = nowMs;
  closeEmoteBar();
  return true;
}

function onRemoteEmote(id, index) {
  const ghost = net.players.get(id);
  if (!ghost || !isValidEmoteIndex(index)) return;
  emoteState.bubbles.set(id, { index, at: performance.now() });
  const body = ghost.car || ghost;
  const screenX = body.x - camX, screenY = body.y - camY;
  const isOffScreen = screenX < -EMOTE_OFFSCREEN_MARGIN || screenY < -EMOTE_OFFSCREEN_MARGIN
    || screenX > vw + EMOTE_OFFSCREEN_MARGIN || screenY > vh + EMOTE_OFFSCREEN_MARGIN;
  if (isOffScreen) toast(ghost.name + ': ' + EMOTES[index]);
}

function setEmoteBarOpen(isOpen) {
  emoteState.barOpen = isOpen;
  clearTimeout(emoteAutoCloseTimer);
  emoteAutoCloseTimer = isOpen ? setTimeout(closeEmoteBar, EMOTE_BAR_AUTOCLOSE_MS) : null;
  const bar = document.getElementById('emoteBar');
  if (bar) bar.classList.toggle('open', isOpen);
}
function openEmoteBar() { setEmoteBarOpen(true); }
function closeEmoteBar() { setEmoteBarOpen(false); }
function toggleEmoteBar() { setEmoteBarOpen(!emoteState.barOpen); }

function buildEmoteBar() {
  const bar = document.getElementById('emoteBar');
  if (!bar) return;
  bar.textContent = '';
  EMOTES.forEach((emoji, index) => {
    const button = document.createElement('button');
    button.className = 'emo';
    button.innerHTML = emoji + '<kbd>' + (index + 1) + '</kbd>';
    button.addEventListener('click', () => sendEmote(index));
    bar.appendChild(button);
  });
}

function emoteAnchor(ghostOrPlayer) {
  const car = ghostOrPlayer.car;
  if (car) return { x: car.x - camX, y: car.y - camY - car.h / 2 - EMOTE_CAR_ANCHOR_OFFSET };
  return { x: ghostOrPlayer.x - camX, y: ghostOrPlayer.y - camY - EMOTE_BODY_ANCHOR_OFFSET };
}

function drawEmoteBubble(emoji, anchor, look) {
  const centerX = anchor.x, centerY = anchor.y - look.rise, radius = 19 * look.scale;
  ctx.globalAlpha = look.alpha;
  ctx.fillStyle = 'rgba(15,15,22,.85)'; ctx.strokeStyle = '#ffd23a'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.moveTo(centerX - 5, centerY + radius - 2); ctx.lineTo(centerX, centerY + radius + 7); ctx.lineTo(centerX + 5, centerY + radius - 2);
  ctx.fill(); ctx.stroke();
  ctx.font = Math.round(22 * look.scale) + 'px ' + EMOTE_FONT_FAMILY;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
  ctx.fillText(emoji, centerX, centerY + 1);
}

function drawEmoteBubbles() {
  if (!net.mode && !emoteState.bubbles.size) return;
  refreshEmoteCooldownUi();
  if (!emoteState.bubbles.size) return;
  const nowMs = performance.now();
  const previousAlign = ctx.textAlign, previousBaseline = ctx.textBaseline, previousFont = ctx.font;
  for (const [id, bubble] of emoteState.bubbles) {
    const look = emoteBubbleLook(nowMs - bubble.at);
    const owner = id === 'me' ? player : net.players.get(id);
    if (!look || !owner) { emoteState.bubbles.delete(id); continue; }
    drawEmoteBubble(EMOTES[bubble.index], emoteAnchor(owner), look);
  }
  ctx.globalAlpha = 1; ctx.textAlign = previousAlign; ctx.textBaseline = previousBaseline; ctx.font = previousFont;
}

function refreshEmoteCooldownUi() {
  const remaining = emoteCooldownLeft(emoteState.lastSentAt, performance.now());
  const isCooling = remaining > 0;
  const bar = document.getElementById('emoteBar');
  if (bar) bar.classList.toggle('cooling', isCooling);
  const hint = document.getElementById('emoteHint');
  if (hint) {
    hint.classList.toggle('cooling', isCooling);
    const hintHtml = isCooling ? t('emote.cooldown', { s: Math.ceil(remaining / 1000) }) : t('emote.hint');
    if (hintHtml !== emoteHintRendered) { hint.innerHTML = hintHtml; emoteHintRendered = hintHtml; }
  }
  const ringCircle = document.querySelector('#btnEmote circle');
  if (ringCircle) ringCircle.setAttribute('stroke-dashoffset', isCooling ? (EMOTE_RING_CIRCUMFERENCE * (1 - remaining / EMOTE_COOLDOWN_MS)).toFixed(1) : String(EMOTE_RING_CIRCUMFERENCE));
}

buildEmoteBar();
