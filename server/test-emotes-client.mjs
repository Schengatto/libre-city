import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { readSource } from './render-test-kit.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ', msg); } else { fail++; console.log('  XX FAIL:', msg); } };

const sentMessages = [];
const toasts = [];
const fillTextCalls = [];
const ctxStateStack = [];
let saveCalls = 0, restoreCalls = 0;
const ctxStateKeys = ['globalAlpha', 'textAlign', 'textBaseline', 'font', 'fillStyle'];
let fakeNow = 10_000;

const context = {
  net: { mode: 'client', myId: 'me-id', players: new Map(), sock: { readyState: 1 } },
  netSend: message => sentMessages.push(message),
  toast: message => toasts.push(message),
  t: key => key,
  player: { x: 400, y: 300, car: null },
  playerName: 'Me',
  camX: 0, camY: 0, vw: 800, vh: 600,
  performance: { now: () => fakeNow },
  document: { getElementById: () => null, querySelector: () => null },
  setTimeout: () => 1,
  clearTimeout: () => {},
  ctx: {
    globalAlpha: 1, textAlign: 'left', textBaseline: 'alphabetic', font: '10px serif',
    beginPath() {}, arc() {}, moveTo() {}, lineTo() {}, fill() {}, stroke() {},
    fillText(text, x, y) { fillTextCalls.push({ text, x, y }); },
    save() { saveCalls++; ctxStateStack.push(Object.fromEntries(ctxStateKeys.map(key => [key, context.ctx[key]]))); },
    restore() { restoreCalls++; Object.assign(context.ctx, ctxStateStack.pop()); },
  },
};
vm.createContext(context);
const emotes = vm.runInContext(
  readSource('emotes.js') +
  '\n({ EMOTES, emoteState, emoteCooldownLeft, emoteBubbleLook, sendEmote, onRemoteEmote, drawEmoteBubbles, toggleEmoteBar, closeEmoteBar });',
  context
);

const resetScene = () => {
  sentMessages.length = 0; toasts.length = 0; fillTextCalls.length = 0;
  ctxStateStack.length = 0; saveCalls = 0; restoreCalls = 0;
  context.net.sock = { readyState: 1 };
  emotes.emoteState.bubbles.clear();
  emotes.emoteState.lastSentAt = -Infinity;
  emotes.emoteState.barOpen = false;
  context.net.players.clear();
  context.net.mode = 'client';
  context.camX = 0; context.camY = 0;
  context.player.car = null;
};

console.log('1) cooldown left');
ok(emotes.emoteCooldownLeft(1000, 3000) === 3000, 'cooldown running: 3000 ms left');
ok(emotes.emoteCooldownLeft(1000, 7000) === 0, 'cooldown elapsed: 0');
ok(emotes.emoteCooldownLeft(-Infinity, 0) === 0, 'never sent: 0');

console.log('2) bubble look');
ok(Math.abs(emotes.emoteBubbleLook(0).scale - 0.6) < 0.01, 'starts at scale about 0.6');
ok(emotes.emoteBubbleLook(1500).alpha === 1, 'fully opaque mid-life');
ok(emotes.emoteBubbleLook(3001) === null, 'null after 3000 ms');
ok(emotes.emoteBubbleLook(2900).alpha < 1, 'fades out near the end');

console.log('3) sendEmote');
resetScene();
ok(emotes.sendEmote(2) === true, 'valid send in multiplayer');
ok(sentMessages.length === 1 && sentMessages[0].t === 'emo' && sentMessages[0].e === 2, 'netSend got {t:emo, e:2}');
ok(emotes.emoteState.bubbles.get('me')?.index === 2, 'local bubble stored under me');
ok(emotes.sendEmote(1) === false && sentMessages.length === 1, 'second send inside the cooldown is refused');
resetScene();
ok(emotes.sendEmote(8) === false && emotes.sendEmote(-1) === false && emotes.sendEmote(1.5) === false, 'out of range indexes refused');
ok(sentMessages.length === 0, 'nothing sent for invalid indexes');
context.net.mode = null;
ok(emotes.sendEmote(1) === false && sentMessages.length === 0, 'single player: refused and nothing sent');
resetScene();
emotes.toggleEmoteBar();
ok(emotes.emoteState.barOpen === true, 'toggle opens the bar');
emotes.sendEmote(0);
ok(emotes.emoteState.barOpen === false, 'sending closes the bar');
resetScene();
context.net.sock = { readyState: 0 };
ok(emotes.sendEmote(1) === false && sentMessages.length === 0, 'socket not open: refused and nothing sent');
ok(emotes.emoteState.bubbles.size === 0 && emotes.emoteState.lastSentAt === -Infinity, 'socket not open: no local bubble, cooldown not started');
context.net.sock = null;
ok(emotes.sendEmote(1) === false && sentMessages.length === 0, 'no socket: refused and nothing sent');
context.net.sock = { readyState: 1 };
ok(emotes.sendEmote(1) === true, 'open socket: send accepted after a refused attempt');

console.log('3b) local bubble anchor');
resetScene();
context.camX = 20; context.camY = 30;
emotes.sendEmote(3);
fakeNow += 500;
emotes.drawEmoteBubbles();
const footBubbleY = fillTextCalls[0].y;
const footLook = emotes.emoteBubbleLook(500);
ok(fillTextCalls.length === 1 && fillTextCalls[0].x === context.player.x - 20 && Math.abs(footBubbleY - (context.player.y - 30 - 56 - footLook.rise + 1)) < 1e-9, `on foot: bubble anchored at body y - 56 (${footBubbleY})`);
resetScene();
context.camX = 20; context.camY = 30;
context.player.car = { x: 300, y: 250, h: 40 };
emotes.sendEmote(3);
emotes.drawEmoteBubbles();
const drivingBubbleY = fillTextCalls[0].y;
const drivingLook = emotes.emoteBubbleLook(0);
ok(fillTextCalls[0].x === 300 - 20 && Math.abs(drivingBubbleY - (250 - 30 - 40 / 2 - 12 - drivingLook.rise + 1)) < 1e-9, `driving: bubble anchored on player.car (${drivingBubbleY})`);
context.player.car = null;

console.log('4) onRemoteEmote');
resetScene();
emotes.onRemoteEmote('ghost-unknown', 1);
ok(emotes.emoteState.bubbles.size === 0 && toasts.length === 0, 'unknown id ignored without throwing');
context.net.players.set('g1', { name: 'Zed', x: 100, y: 100, car: null });
emotes.onRemoteEmote('g1', 1);
ok(emotes.emoteState.bubbles.get('g1')?.index === 1 && toasts.length === 0, 'on-screen ghost: stored, no toast');
context.net.players.set('g2', { name: 'Zed', x: 5000, y: 100, car: null });
emotes.onRemoteEmote('g2', 1);
ok(toasts.length === 1 && toasts[0] === 'Zed: 👍', `off-screen ghost: toast (${toasts[0]})`);
emotes.emoteState.bubbles.clear();
emotes.onRemoteEmote('g1', 9);
ok(emotes.emoteState.bubbles.size === 0, 'invalid index stores nothing');

console.log('5) drawEmoteBubbles');
resetScene();
context.net.players.set('g1', { name: 'Zed', x: 100, y: 100, car: null });
emotes.emoteState.bubbles.set('g1', { index: 1, at: fakeNow - 4000 });
emotes.drawEmoteBubbles();
ok(emotes.emoteState.bubbles.size === 0, 'expired bubble removed');
const car = { x: 300, y: 250, h: 40 };
context.net.players.set('g3', { name: 'Drv', x: 300, y: 250, car });
context.camX = 20; context.camY = 30;
emotes.emoteState.bubbles.set('g3', { index: 5, at: fakeNow - 500 });
emotes.drawEmoteBubbles();
const carTop = car.y - context.camY - car.h / 2;
ok(fillTextCalls.length === 1 && fillTextCalls[0].text === '😱' && fillTextCalls[0].y < carTop, `driving ghost: bubble above the car top (${fillTextCalls[0]?.y} < ${carTop})`);
fillTextCalls.length = 0;
emotes.emoteState.bubbles.set('gone', { index: 1, at: fakeNow });
emotes.drawEmoteBubbles();
ok(!emotes.emoteState.bubbles.has('gone'), 'bubble of a player who left is dropped');
ok(context.ctx.globalAlpha === 1 && context.ctx.textAlign === 'left' && context.ctx.textBaseline === 'alphabetic', 'ctx state restored');
ok(saveCalls > 0 && saveCalls === restoreCalls && ctxStateStack.length === 0, `ctx save/restore balanced (${saveCalls}/${restoreCalls})`);

console.log('6) single player skips the cooldown ui refresh');
resetScene();
let domLookups = 0;
context.document.getElementById = () => { domLookups++; return null; };
context.net.mode = null;
emotes.drawEmoteBubbles();
ok(domLookups === 0, 'no dom lookups outside multiplayer');
context.net.mode = 'client';
emotes.drawEmoteBubbles();
ok(domLookups > 0, 'dom refreshed in multiplayer');
context.document.getElementById = () => null;

console.log('7) wiring guards (source text)');
const renderSource = readSource('render.js');
const inputSource = readSource('input.js');
const netSource = readSource('net.js');
const htmlSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const before = (source, first, second) => source.indexOf(first) >= 0 && source.indexOf(first) < source.indexOf(second);
ok(before(renderSource, 'drawDayNight();', 'drawEmoteBubbles();') && before(renderSource, 'drawEmoteBubbles();', 'drawPops();'), 'bubbles drawn after the night overlay and before the pops');
ok(before(inputSource, "e.code === 'Escape' && emoteState.barOpen", 'togglePause()'), 'Escape closes the emoji bar before toggling pause');
ok(before(inputSource, 'if (paused) return;', "e.code === 'KeyT'"), 'T is ignored while paused');
ok(before(inputSource, 'emoteState.barOpen && /^Digit[1-8]$/', "e.code.startsWith('Digit')"), 'emoji digits take precedence over weapon digits');
ok(inputSource.includes("bindBtn('btnEmote', toggleEmoteBar);"), 'touch button toggles the bar');
const netShutdownBody = netSource.slice(netSource.indexOf('function netShutdown()')).split('\n}')[0];
ok(netShutdownBody.includes('closeEmoteBar();'), 'netShutdown closes the emoji bar');
ok(netSource.includes("case 'emo': onRemoteEmote(m.id, m.e)"), 'network routes emo to onRemoteEmote');
ok(before(htmlSource, 'id="emoteBar"', 'js/emotes.js') && before(htmlSource, 'js/emotes.js', 'js/input.js'), 'emotes.js loads after the bar element and before input.js');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
