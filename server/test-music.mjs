import fs from 'node:fs';
import path from 'node:path';
import { readSource } from './render-test-kit.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const MUSIC_SOURCE = readSource('music.js');
const D_HARMONIC_MINOR = new Set([2, 4, 5, 7, 9, 10, 1]);

let pass = 0, fail = 0;
const ok = (condition, message) => { if (condition) { pass++; console.log('  OK ', message); } else { fail++; console.log('  XX FAIL:', message); } };

function createFakeAudioContext() {
  const startTimes = [];
  const createParam = () => ({ value: 0, target: null, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime(value) { this.target = value; } });
  const createNode = () => ({
    connect() {}, stop() {}, start(time) { startTimes.push(time); },
    gain: createParam(), frequency: createParam(), detune: createParam(), delayTime: createParam(), pan: createParam(),
  });
  return {
    currentTime: 0, sampleRate: 100, startTimes,
    createGain: createNode, createOscillator: createNode, createBiquadFilter: createNode,
    createConvolver: createNode, createDelay: createNode, createBufferSource: createNode, createStereoPanner: createNode,
    createBuffer: (channels, length) => ({ getChannelData: () => new Float32Array(length) }),
  };
}

function loadMusic({ started = false, storedMusic, startDisplay = '' } = {}) {
  const saved = {};
  const store = { get: (key, fallback) => storedMusic === undefined ? fallback : storedMusic, set: (key, value) => { saved[key] = value; } };
  const listeners = {};
  const classes = new Set();
  const attributes = {};
  const button = {
    textContent: '', classes, attributes,
    classList: { toggle: (name, enabled) => { if (enabled) classes.add(name); else classes.delete(name); } },
    setAttribute: (name, value) => { attributes[name] = value; },
    addEventListener: (type, handler) => { listeners['button:' + type] = handler; },
  };
  const startScreen = { style: { display: startDisplay } };
  const elements = { musicBtn: button, start: startScreen };
  const fakeDocument = { hidden: false, getElementById: id => elements[id] || null, addEventListener: (type, handler) => { listeners[type] = handler; } };
  const activeTimers = new Set();
  let nextTimerId = 1;
  const fakeSetInterval = () => { const id = nextTimerId++; activeTimers.add(id); return id; };
  const fakeClearInterval = id => { activeTimers.delete(id); };
  const audio = createFakeAudioContext();
  const exportedNames = ['menuMusicStep', 'playMenuMusicStep', 'scheduleMenuMusic', 'startMenuMusic', 'stopMenuMusic', 'MENU_SONG_CHORDS',
    'MENU_SONG_LEAD', 'MENU_SONG_LEAD_STEPS', 'MENU_SONG_STEPS', 'MUSIC_STEP_SECONDS', 'MUSIC_LOOKAHEAD_SECONDS', 'MUSIC_VOLUME'];
  const api = new Function('store', 'document', 'setInterval', 'clearInterval', 'AC', 'MASTER', 'initAudio', 'started',
    `${MUSIC_SOURCE}\n;return { ${exportedNames.join(', ')}, bus: () => musicBus };`)(
    store, fakeDocument, fakeSetInterval, fakeClearInterval, audio, {}, () => {}, started);
  return { api, saved, listeners, button, startScreen, fakeDocument, activeTimers, audio };
}

console.log('1) song pattern');
{
  const { api } = loadMusic();
  const bar = Array.from({ length: 16 }, (_, step) => api.menuMusicStep(step));
  const stepsWhere = predicate => bar.flatMap((e, step) => predicate(e) ? [step] : []);
  ok(JSON.stringify(stepsWhere(e => e.kick)) === '[0,3,8,10]', 'driving kick pattern');
  ok(JSON.stringify(stepsWhere(e => e.snare)) === '[4,12]', 'snare on beats 2 and 4');
  ok(JSON.stringify(stepsWhere(e => e.hatAccent)) === '[2,6,10,14]', 'hat accents on the offbeats');
  ok(JSON.stringify(bar.map(e => e.bass - 38)) === '[0,0,12,0,0,12,0,0,0,0,12,0,0,12,7,12]', 'bass runs the sixteenth-note ostinato');
  ok(JSON.stringify(stepsWhere(e => e.stab)) === '[0,10]' && bar[0].stab === api.MENU_SONG_CHORDS[0].pad, 'chord stabs hit on 1 and the pushed 3');
  ok(bar[0].pad && bar.slice(1).every(e => e.pad === null), 'pad chord only on the downbeat');
  const roots = [0, 1, 2, 3].map(barIndex => api.menuMusicStep(barIndex * 16).bass % 12);
  ok(JSON.stringify(roots) === JSON.stringify([2, 10, 0, 9]), 'progression is Dm Bb C A');
  const tomSteps = Array.from({ length: 64 }, (_, step) => step).filter(step => api.menuMusicStep(step).tom !== null);
  ok(JSON.stringify(tomSteps) === JSON.stringify([60, 61, 62, 63]), 'tom fill closes each four-bar phrase');
  const effects = Array.from({ length: api.MENU_SONG_STEPS }, (_, step) => [step, api.menuMusicStep(step).effect]).filter(([, effect]) => effect);
  ok(JSON.stringify(effects) === '[[48,"car"],[124,"shot"],[126,"shot"],[192,"siren"]]', 'car, gunshots and siren once per loop');
  const intro = Array.from({ length: api.MENU_SONG_LEAD_STEPS }, (_, step) => api.menuMusicStep(step));
  ok(intro.every(e => e.lead === null), 'no lead during the intro half');
  const firstLead = api.menuMusicStep(api.MENU_SONG_LEAD_STEPS).lead;
  ok(firstLead?.midi === 81 && firstLead.bend === true, 'lead enters on the second half with a bend');
  ok(api.MENU_SONG_STEPS === api.MENU_SONG_LEAD_STEPS * 2, 'song loops after intro plus lead');
  ok(api.MENU_SONG_LEAD.every(([, midi]) => D_HARMONIC_MINOR.has(midi % 12)), 'lead stays in D harmonic minor');
  ok(api.MENU_SONG_LEAD.every(([step, , length]) => step + length <= api.MENU_SONG_LEAD_STEPS), 'lead notes end inside the loop');
}

console.log('2) start, stop and toggle');
{
  const music = loadMusic();
  ok(music.button.textContent === '♪ ON' && music.button.attributes['aria-pressed'] === 'true', 'button shows ON by default');
  music.listeners.pointerdown();
  ok(music.activeTimers.size === 1, 'first gesture starts the music');
  ok(music.api.bus().gain.target === music.api.MUSIC_VOLUME, 'bus fades in to the music volume');
  music.listeners.keydown();
  ok(music.activeTimers.size === 1, 'further gestures do not start a second sequencer');
  music.listeners['button:click']();
  ok(music.activeTimers.size === 0 && music.saved.music === false, 'button stops the music and saves the choice');
  ok(music.button.textContent === '♪ OFF' && music.button.classes.has('off'), 'button shows OFF');
  ok(music.api.bus().gain.target === 0, 'bus fades out');
  music.listeners.pointerdown();
  ok(music.activeTimers.size === 0, 'gestures do not restart music turned off');
  music.listeners['button:click']();
  ok(music.activeTimers.size === 1 && music.saved.music === true, 'button turns the music back on');
  music.api.stopMenuMusic();
  ok(music.activeTimers.size === 0, 'stopMenuMusic stops the sequencer');
}
{
  const music = loadMusic({ storedMusic: false });
  music.listeners.pointerdown();
  ok(music.activeTimers.size === 0 && music.button.textContent === '♪ OFF', 'saved OFF preference is respected');
}
{
  const music = loadMusic({ started: true });
  music.listeners.pointerdown();
  ok(music.activeTimers.size === 0, 'no menu music during a match');
}
{
  const music = loadMusic({ startDisplay: 'none' });
  music.listeners.pointerdown();
  ok(music.activeTimers.size === 0, 'no menu music when the start screen is hidden');
}

console.log('3) scheduler');
{
  const music = loadMusic();
  music.listeners.pointerdown();
  music.audio.currentTime = 10;
  music.api.scheduleMenuMusic();
  const scheduled = music.audio.startTimes;
  ok(scheduled.length > 0, 'schedules notes within the lookahead');
  ok(scheduled.every(time => time >= 10 && time < 10 + music.api.MUSIC_LOOKAHEAD_SECONDS), 'never schedules in the past after a stall');
  const count = scheduled.length;
  music.fakeDocument.hidden = true;
  music.audio.currentTime = 20;
  music.api.scheduleMenuMusic();
  ok(scheduled.length === count, 'schedules nothing while the tab is hidden');
}

{
  const music = loadMusic();
  music.listeners.pointerdown();
  for (const step of [48, 124, 192]) {
    const before = music.audio.startTimes.length;
    let error = null;
    try { music.api.playMenuMusicStep(music.api.menuMusicStep(step), 5); } catch (caught) { error = caught; }
    const effect = music.api.menuMusicStep(step).effect;
    ok(!error && music.audio.startTimes.length > before, `${effect} effect plays without errors`);
  }
}

console.log('4) wiring');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const ui = readSource('ui.js');
  const scripts = [...html.matchAll(/<script src="js\/([a-z-]+\.js)"><\/script>/g)].map(m => m[1]);
  ok(scripts.indexOf('music.js') > scripts.indexOf('audio.js') && scripts.indexOf('music.js') < scripts.indexOf('ui.js'), 'music.js loads after audio.js and before ui.js');
  const startScreen = html.slice(html.indexOf('<div id="start">'), html.indexOf('<div id="credits"'));
  ok(startScreen.includes('id="musicBtn"'), 'music button lives on the start screen');
  ok(html.includes(':not(#musicBtn)'), 'music button is excluded from the in-flow rule so it stays fixed');
  const startMatch = ui.slice(ui.indexOf('function startMatch('), ui.indexOf('\n}\n', ui.indexOf('function startMatch(')));
  ok(startMatch.includes('stopMenuMusic();'), 'startMatch stops the menu music');
}

console.log(fail === 0 ? `\n✅  ${pass} ok, 0 fail` : `\n❌  ${pass} ok, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
