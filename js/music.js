const MUSIC_BPM = 112;
const MUSIC_STEP_SECONDS = 60 / MUSIC_BPM / 4;
const MUSIC_STEPS_PER_BAR = 16;
const MUSIC_BAR_SECONDS = MUSIC_STEP_SECONDS * MUSIC_STEPS_PER_BAR;
const MUSIC_VOLUME = 0.2;
const MUSIC_LOOKAHEAD_SECONDS = 0.15;
const MUSIC_TICK_MS = 25;

const MENU_SONG_CHORDS = [
  { bass: 38, pad: [62, 65, 69] },
  { bass: 34, pad: [58, 62, 65] },
  { bass: 36, pad: [60, 64, 67] },
  { bass: 33, pad: [61, 64, 69] },
];
const MENU_SONG_BASS_OSTINATO = [0, 0, 12, 0, 0, 12, 0, 0, 0, 0, 12, 0, 0, 12, 7, 12];
const MENU_SONG_KICK_STEPS = new Set([0, 3, 8, 10]);
const MENU_SONG_STAB_STEPS = new Set([0, 10]);
const MENU_SONG_TOM_FILL = [55, 50, 47, 43];
const MENU_SONG_LEAD = [
  [0, 81, 6, true], [6, 82, 2], [8, 81, 4], [12, 77, 4],
  [16, 74, 8], [24, 77, 4], [28, 79, 4],
  [32, 79, 6, true], [38, 77, 2], [40, 76, 8],
  [48, 73, 4], [52, 76, 4], [56, 81, 8],
  [64, 86, 6, true], [70, 85, 2], [72, 86, 4], [76, 81, 4],
  [80, 82, 8], [88, 81, 4], [92, 77, 4],
  [96, 79, 4], [100, 76, 4], [104, 79, 4], [108, 82, 4],
  [112, 81, 4, true], [116, 85, 4], [120, 88, 8],
];
const MENU_SONG_LEAD_BY_STEP = new Map(MENU_SONG_LEAD.map(([step, midi, length, bend = false]) => [step, { midi, length, bend }]));
const MENU_SONG_LEAD_STEPS = 128;
const MENU_SONG_STEPS = MENU_SONG_LEAD_STEPS * 2;
const MENU_SONG_EFFECTS = new Map([[48, 'car'], [124, 'shot'], [126, 'shot'], [192, 'siren']]);

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
  const leadStep = step - MENU_SONG_LEAD_STEPS;
  return {
    kick: MENU_SONG_KICK_STEPS.has(stepInBar),
    snare: stepInBar === 4 || stepInBar === 12,
    hatAccent: stepInBar % 4 === 2,
    tom: phraseEnds && stepInBar >= 12 ? MENU_SONG_TOM_FILL[stepInBar - 12] : null,
    bass: chord.bass + MENU_SONG_BASS_OSTINATO[stepInBar],
    stab: MENU_SONG_STAB_STEPS.has(stepInBar) ? chord.pad : null,
    pad: stepInBar === 0 ? chord.pad : null,
    lead: leadStep >= 0 ? MENU_SONG_LEAD_BY_STEP.get(leadStep) || null : null,
    effect: MENU_SONG_EFFECTS.get(step) || null,
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
  delayFeedback.gain.value = 0.4;
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

function createMusicPanSweep(time, duration, from, to) {
  if (!AC.createStereoPanner) return musicBus;
  const panner = AC.createStereoPanner();
  panner.pan.setValueAtTime(from, time);
  panner.pan.linearRampToValueAtTime(to, time + duration);
  panner.connect(musicBus);
  return panner;
}

function playMusicGunshot(time) {
  playMusicNoise({ time, duration: 0.12, volume: 0.32, filterType: 'highpass', frequency: 700, sends: { reverb: 1.2 } });
  playMusicDrum({ time, fromFrequency: 110, toFrequency: 40, volume: 0.35, duration: 0.25, sends: { reverb: 0.6 } });
}

function playMusicCarPass(time) {
  const duration = 2.4;
  const output = createMusicPanSweep(time, duration, -0.9, 0.9);
  const swell = AC.createGain();
  swell.gain.setValueAtTime(0.0001, time);
  swell.gain.exponentialRampToValueAtTime(0.16, time + duration / 2);
  swell.gain.exponentialRampToValueAtTime(0.0001, time + duration);
  swell.connect(output);
  connectMusicSend(swell, musicReverb, 0.4);
  const engine = AC.createOscillator();
  engine.type = 'sawtooth';
  engine.frequency.setValueAtTime(70, time);
  engine.frequency.linearRampToValueAtTime(95, time + duration / 2);
  engine.frequency.linearRampToValueAtTime(58, time + duration);
  const engineTone = AC.createBiquadFilter();
  engineTone.type = 'lowpass';
  engineTone.frequency.value = 500;
  engine.connect(engineTone);
  engineTone.connect(swell);
  const road = AC.createBufferSource();
  road.buffer = musicNoise;
  road.loop = true;
  const roadTone = AC.createBiquadFilter();
  roadTone.type = 'bandpass';
  roadTone.frequency.setValueAtTime(400, time);
  roadTone.frequency.linearRampToValueAtTime(1500, time + duration / 2);
  roadTone.frequency.linearRampToValueAtTime(350, time + duration);
  const roadLevel = AC.createGain();
  roadLevel.gain.value = 0.5;
  road.connect(roadTone);
  roadTone.connect(roadLevel);
  roadLevel.connect(swell);
  for (const source of [engine, road]) {
    source.start(time);
    source.stop(time + duration + 0.05);
  }
}

function playMusicSiren(time) {
  const wailSeconds = 1.3, wails = 3, duration = wailSeconds * wails;
  const siren = AC.createOscillator();
  siren.type = 'square';
  siren.frequency.setValueAtTime(620, time);
  for (let wail = 0; wail < wails; wail++) {
    const start = time + wail * wailSeconds;
    siren.frequency.linearRampToValueAtTime(1250, start + wailSeconds * 0.55);
    siren.frequency.linearRampToValueAtTime(620, start + wailSeconds);
  }
  const distance = AC.createBiquadFilter();
  distance.type = 'lowpass';
  distance.frequency.value = 1600;
  const envelope = AC.createGain();
  envelope.gain.setValueAtTime(0.0001, time);
  envelope.gain.exponentialRampToValueAtTime(0.025, time + duration * 0.4);
  envelope.gain.exponentialRampToValueAtTime(0.0001, time + duration);
  siren.connect(distance);
  distance.connect(envelope);
  envelope.connect(createMusicPanSweep(time, duration, 0.6, -0.4));
  connectMusicSend(envelope, musicReverb, 1.2);
  siren.start(time);
  siren.stop(time + duration + 0.05);
}

const MENU_SONG_EFFECT_PLAYERS = { car: playMusicCarPass, shot: playMusicGunshot, siren: playMusicSiren };

function playMenuMusicStep(events, time) {
  if (events.kick) playMusicDrum({ time, fromFrequency: 130, toFrequency: 42, volume: 0.6, duration: 0.35 });
  if (events.snare) {
    playMusicNoise({ time, duration: 0.18, volume: 0.3, filterType: 'bandpass', frequency: 1700, sends: { gated: 1.1, reverb: 0.2 } });
    playMusicOscillator({ type: 'triangle', midi: 52, time, duration: 0.12, volume: 0.22, cutoff: 3000, sends: { gated: 0.8 } });
  }
  if (events.tom !== null) {
    const frequency = musicMidiToFrequency(events.tom);
    playMusicDrum({ time, fromFrequency: frequency * 1.6, toFrequency: frequency, volume: 0.45, duration: 0.4, sends: { gated: 0.9 } });
  }
  playMusicNoise({ time, duration: events.hatAccent ? 0.06 : 0.025, volume: events.hatAccent ? 0.06 : 0.03, filterType: 'highpass', frequency: 8000 });
  playMusicOscillator({ type: 'sawtooth', midi: events.bass, time, duration: MUSIC_STEP_SECONDS * 0.8, volume: 0.16, cutoff: 750 });
  if (events.pad) {
    for (const midi of events.pad) {
      for (const detune of [-10, 10]) {
        playMusicOscillator({ type: 'sawtooth', midi: midi - 12, time, duration: MUSIC_BAR_SECONDS + 0.4, volume: 0.016, cutoff: 900, detune, attack: 0.7, release: 0.8, sends: { reverb: 0.8 } });
      }
    }
  }
  if (events.stab) {
    for (const midi of events.stab) {
      for (const detune of [-8, 8]) {
        playMusicOscillator({ type: 'sawtooth', midi, time, duration: 0.35, volume: 0.035, cutoff: 2400, detune, release: 0.3, sends: { reverb: 0.7 } });
      }
      playMusicOscillator({ type: 'square', midi: midi - 12, time, duration: 0.3, volume: 0.025, cutoff: 1500, release: 0.25, sends: { reverb: 0.5 } });
    }
  }
  if (events.lead) {
    const duration = events.lead.length * MUSIC_STEP_SECONDS;
    const bendFrom = events.lead.bend ? 2 : 0;
    const vibrato = events.lead.length >= 8;
    const sends = { reverb: 0.6, delay: 0.3 };
    playMusicOscillator({ type: 'sawtooth', midi: events.lead.midi, time, duration, volume: 0.045, cutoff: 3000, detune: -4, attack: 0.03, release: 0.25, bendFrom, vibrato, sends });
    playMusicOscillator({ type: 'square', midi: events.lead.midi, time, duration, volume: 0.025, cutoff: 2200, detune: 4, attack: 0.03, release: 0.25, bendFrom, vibrato, sends });
  }
  if (events.effect) MENU_SONG_EFFECT_PLAYERS[events.effect](time);
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
