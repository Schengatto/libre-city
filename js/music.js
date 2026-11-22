const MUSIC_BPM = 96;
const MUSIC_STEP_SECONDS = 60 / MUSIC_BPM / 4;
const MUSIC_STEPS_PER_BAR = 16;
const MUSIC_BAR_SECONDS = MUSIC_STEP_SECONDS * MUSIC_STEPS_PER_BAR;
const MUSIC_VOLUME = 0.38;
const MUSIC_LOOKAHEAD_SECONDS = 0.15;
const MUSIC_TICK_MS = 25;

const MENU_SONG_CHORDS = [
  { bass: 40, pad: [55, 59, 62, 66] },
  { bass: 36, pad: [55, 59, 60, 64] },
  { bass: 33, pad: [57, 60, 64, 71] },
  { bass: 38, pad: [54, 57, 62, 64] },
];
const MENU_SONG_BASS_HITS = new Map([[0, 6], [6, 4], [10, 6]]);
const MENU_SONG_KICK_STEPS = new Set([0, 10]);
const MENU_SONG_BELL_PATTERN = [0, 2, 1, 3, 2, 1, 3, 0];
const MENU_SONG_TOM_FILL = [50, 47, 43];
const MENU_SONG_LEAD = [
  [0, 83, 10, true], [10, 81, 2], [12, 79, 4],
  [16, 76, 12], [28, 79, 4],
  [32, 81, 8, true], [40, 79, 4], [44, 76, 4],
  [48, 78, 14],
  [64, 83, 6, true], [70, 86, 2], [72, 88, 8],
  [80, 86, 4], [84, 83, 4], [88, 79, 8],
  [96, 81, 4], [100, 83, 4], [104, 79, 4], [108, 76, 4],
  [112, 78, 6, true], [118, 76, 10],
];
const MENU_SONG_LEAD_BY_STEP = new Map(MENU_SONG_LEAD.map(([step, midi, length, bend = false]) => [step, { midi, length, bend }]));
const MENU_SONG_LEAD_STEPS = 128;
const MENU_SONG_STEPS = MENU_SONG_LEAD_STEPS * 2;

let musicOn = store.get('music', true);
let musicBus = null, musicReverb = null, musicGatedReverb = null, musicDelay = null, musicNoise = null;
let musicTimer = null, musicNextStepTime = 0, musicStepIndex = 0;

function musicMidiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function menuMusicStep(step) {
  const stepInBar = step % MUSIC_STEPS_PER_BAR;
  const chordIndex = Math.floor(step / MUSIC_STEPS_PER_BAR) % MENU_SONG_CHORDS.length;
  const chord = MENU_SONG_CHORDS[chordIndex];
  const phraseEnds = chordIndex === MENU_SONG_CHORDS.length - 1;
  const bassLength = MENU_SONG_BASS_HITS.get(stepInBar);
  const leadStep = step - MENU_SONG_LEAD_STEPS;
  return {
    kick: MENU_SONG_KICK_STEPS.has(stepInBar),
    snare: stepInBar === 4 || stepInBar === 12,
    hat: stepInBar % 2 === 0,
    hatAccent: stepInBar % 4 === 2,
    tom: phraseEnds && stepInBar > 12 ? MENU_SONG_TOM_FILL[stepInBar - 13] : null,
    bass: bassLength ? { midi: chord.bass, length: bassLength } : null,
    pad: stepInBar === 0 ? chord.pad : null,
    bell: stepInBar % 2 === 0 ? chord.pad[MENU_SONG_BELL_PATTERN[stepInBar / 2]] + 12 : null,
    lead: leadStep >= 0 ? MENU_SONG_LEAD_BY_STEP.get(leadStep) || null : null,
  };
}

function createMusicNoiseBuffer(seconds, channels, decayPower) {
  const length = Math.max(1, Math.floor(AC.sampleRate * seconds));
  const buffer = AC.createBuffer(channels, length, AC.sampleRate);
  for (let channel = 0; channel < channels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decayPower;
  }
  return buffer;
}

function buildMenuMusicGraph() {
  musicBus = AC.createGain();
  musicBus.gain.value = 0;
  musicBus.connect(MASTER);
  musicReverb = AC.createConvolver();
  musicReverb.buffer = createMusicNoiseBuffer(3.4, 2, 3);
  musicReverb.connect(musicBus);
  musicGatedReverb = AC.createConvolver();
  musicGatedReverb.buffer = createMusicNoiseBuffer(0.38, 2, 0.25);
  musicGatedReverb.connect(musicBus);
  musicDelay = AC.createDelay(1);
  musicDelay.delayTime.value = MUSIC_STEP_SECONDS * 3;
  const delayTone = AC.createBiquadFilter();
  delayTone.type = 'lowpass';
  delayTone.frequency.value = 2200;
  const delayFeedback = AC.createGain();
  delayFeedback.gain.value = 0.42;
  musicDelay.connect(delayTone);
  delayTone.connect(delayFeedback);
  delayFeedback.connect(musicDelay);
  delayTone.connect(musicBus);
  musicNoise = createMusicNoiseBuffer(1, 1, 0);
}

function connectMusicSend(source, target, amount) {
  if (!amount) return;
  const send = AC.createGain();
  send.gain.value = amount;
  source.connect(send);
  send.connect(target);
}

function routeMusicVoice(source, { reverb = 0, delay = 0, gated = 0 } = {}) {
  source.connect(musicBus);
  connectMusicSend(source, musicReverb, reverb);
  connectMusicSend(source, musicDelay, delay);
  connectMusicSend(source, musicGatedReverb, gated);
}

function addMusicVibrato(oscillator, time, duration) {
  const rate = AC.createOscillator();
  rate.frequency.value = 5.2;
  const depth = AC.createGain();
  depth.gain.setValueAtTime(0, time);
  depth.gain.linearRampToValueAtTime(14, time + Math.min(duration, 0.6));
  rate.connect(depth);
  depth.connect(oscillator.detune);
  rate.start(time);
  rate.stop(time + duration + 0.05);
}

function playMusicOscillator({ type, midi, time, duration, volume, cutoff, detune = 0, attack = 0.005, release = duration, bendFrom = 0, vibrato = false, sends }) {
  const oscillator = AC.createOscillator();
  oscillator.type = type;
  const frequency = musicMidiToFrequency(midi);
  oscillator.frequency.setValueAtTime(bendFrom ? musicMidiToFrequency(midi - bendFrom) : frequency, time);
  if (bendFrom) oscillator.frequency.exponentialRampToValueAtTime(frequency, time + 0.14);
  oscillator.detune.value = detune;
  if (vibrato) addMusicVibrato(oscillator, time, duration);
  const filter = AC.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  const envelope = AC.createGain();
  envelope.gain.setValueAtTime(0.0001, time);
  envelope.gain.exponentialRampToValueAtTime(volume, time + attack);
  envelope.gain.setValueAtTime(volume, time + Math.max(attack, duration - release));
  envelope.gain.exponentialRampToValueAtTime(0.0001, time + duration);
  oscillator.connect(filter);
  filter.connect(envelope);
  routeMusicVoice(envelope, sends);
  oscillator.start(time);
  oscillator.stop(time + duration + 0.05);
}

function playMusicElectricPiano(midi, time) {
  const frequency = musicMidiToFrequency(midi);
  const carrier = AC.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.value = frequency;
  const modulator = AC.createOscillator();
  modulator.type = 'sine';
  modulator.frequency.value = frequency;
  const modulationDepth = AC.createGain();
  modulationDepth.gain.setValueAtTime(frequency * 2.2, time);
  modulationDepth.gain.exponentialRampToValueAtTime(frequency * 0.15, time + 0.35);
  modulator.connect(modulationDepth);
  modulationDepth.connect(carrier.frequency);
  const envelope = AC.createGain();
  envelope.gain.setValueAtTime(0.0001, time);
  envelope.gain.exponentialRampToValueAtTime(0.05, time + 0.004);
  envelope.gain.exponentialRampToValueAtTime(0.0001, time + 1.1);
  carrier.connect(envelope);
  routeMusicVoice(envelope, { reverb: 0.5, delay: 0.45 });
  for (const oscillator of [carrier, modulator]) {
    oscillator.start(time);
    oscillator.stop(time + 1.15);
  }
}

function playMusicNoise({ time, duration, volume, filterType, frequency, sends }) {
  const source = AC.createBufferSource();
  source.buffer = musicNoise;
  const filter = AC.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.value = frequency;
  const envelope = AC.createGain();
  envelope.gain.setValueAtTime(volume, time);
  envelope.gain.exponentialRampToValueAtTime(0.001, time + duration);
  source.connect(filter);
  filter.connect(envelope);
  routeMusicVoice(envelope, sends);
  source.start(time, Math.random() * 0.5, duration + 0.02);
}

function playMusicDrum({ time, fromFrequency, toFrequency, volume, duration, sends }) {
  const oscillator = AC.createOscillator();
  const envelope = AC.createGain();
  oscillator.frequency.setValueAtTime(fromFrequency, time);
  oscillator.frequency.exponentialRampToValueAtTime(toFrequency, time + duration * 0.4);
  envelope.gain.setValueAtTime(volume, time);
  envelope.gain.exponentialRampToValueAtTime(0.001, time + duration);
  oscillator.connect(envelope);
  routeMusicVoice(envelope, sends);
  oscillator.start(time);
  oscillator.stop(time + duration + 0.03);
}

function playMenuMusicStep(events, time) {
  if (events.kick) playMusicDrum({ time, fromFrequency: 130, toFrequency: 42, volume: 0.65, duration: 0.4 });
  if (events.snare) {
    playMusicNoise({ time, duration: 0.18, volume: 0.3, filterType: 'bandpass', frequency: 1700, sends: { gated: 1.1, reverb: 0.2 } });
    playMusicOscillator({ type: 'triangle', midi: 52, time, duration: 0.12, volume: 0.22, cutoff: 3000, sends: { gated: 0.8 } });
  }
  if (events.tom !== null) {
    const frequency = musicMidiToFrequency(events.tom);
    playMusicDrum({ time, fromFrequency: frequency * 1.6, toFrequency: frequency, volume: 0.42, duration: 0.45, sends: { gated: 0.9 } });
  }
  if (events.hat) {
    playMusicNoise({ time, duration: events.hatAccent ? 0.07 : 0.03, volume: events.hatAccent ? 0.06 : 0.035, filterType: 'highpass', frequency: 8000 });
  }
  if (events.bass) {
    const duration = events.bass.length * MUSIC_STEP_SECONDS;
    playMusicOscillator({ type: 'sawtooth', midi: events.bass.midi, time, duration, volume: 0.2, cutoff: 420, attack: 0.01, release: 0.15 });
    playMusicOscillator({ type: 'sine', midi: events.bass.midi - 12, time, duration, volume: 0.14, cutoff: 200, attack: 0.01, release: 0.15 });
  }
  if (events.pad) {
    for (const midi of events.pad) {
      for (const detune of [-11, 11]) {
        playMusicOscillator({ type: 'sawtooth', midi, time, duration: MUSIC_BAR_SECONDS + 0.6, volume: 0.02, cutoff: 1300, detune, attack: 0.9, release: 1, sends: { reverb: 0.9 } });
      }
    }
  }
  if (events.bell !== null) playMusicElectricPiano(events.bell, time);
  if (events.lead) {
    const duration = events.lead.length * MUSIC_STEP_SECONDS;
    const bendFrom = events.lead.bend ? 2 : 0;
    const vibrato = events.lead.length >= 8;
    const sends = { reverb: 0.6, delay: 0.3 };
    playMusicOscillator({ type: 'sawtooth', midi: events.lead.midi, time, duration, volume: 0.045, cutoff: 2600, detune: -4, attack: 0.05, release: 0.3, bendFrom, vibrato, sends });
    playMusicOscillator({ type: 'square', midi: events.lead.midi, time, duration, volume: 0.025, cutoff: 2000, detune: 4, attack: 0.05, release: 0.3, bendFrom, vibrato, sends });
  }
}

function scheduleMenuMusic() {
  if (document.hidden) return;
  if (musicNextStepTime < AC.currentTime) musicNextStepTime = AC.currentTime + 0.02;
  const horizon = AC.currentTime + MUSIC_LOOKAHEAD_SECONDS;
  while (musicNextStepTime < horizon) {
    playMenuMusicStep(menuMusicStep(musicStepIndex), musicNextStepTime);
    musicNextStepTime += MUSIC_STEP_SECONDS;
    musicStepIndex = (musicStepIndex + 1) % MENU_SONG_STEPS;
  }
}

function menuScreenVisible() {
  const startScreen = document.getElementById('start');
  return !!startScreen && startScreen.style.display !== 'none';
}

function startMenuMusic() {
  if (!musicOn || started || musicTimer || !menuScreenVisible()) return;
  initAudio();
  if (!AC) return;
  if (!musicBus) buildMenuMusicGraph();
  musicBus.gain.setTargetAtTime(MUSIC_VOLUME, AC.currentTime, 0.8);
  musicNextStepTime = AC.currentTime + 0.05;
  musicTimer = setInterval(scheduleMenuMusic, MUSIC_TICK_MS);
}

function stopMenuMusic() {
  if (!musicTimer) return;
  clearInterval(musicTimer);
  musicTimer = null;
  musicBus.gain.setTargetAtTime(0, AC.currentTime, 0.15);
}

function updateMusicButton() {
  const button = document.getElementById('musicBtn');
  if (!button) return;
  button.textContent = musicOn ? '♪ ON' : '♪ OFF';
  button.classList.toggle('off', !musicOn);
  button.setAttribute('aria-pressed', String(musicOn));
}

function toggleMenuMusic() {
  musicOn = !musicOn;
  store.set('music', musicOn);
  updateMusicButton();
  if (musicOn) startMenuMusic();
  else stopMenuMusic();
}

const musicButton = document.getElementById('musicBtn');
if (musicButton) musicButton.addEventListener('click', toggleMenuMusic);
for (const gesture of ['pointerdown', 'keydown']) document.addEventListener(gesture, startMenuMusic);
updateMusicButton();
