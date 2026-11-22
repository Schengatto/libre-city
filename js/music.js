const MUSIC_BPM = 132;
const MUSIC_STEP_SECONDS = 60 / MUSIC_BPM / 4;
const MUSIC_STEPS_PER_BAR = 16;
const MUSIC_BAR_SECONDS = MUSIC_STEP_SECONDS * MUSIC_STEPS_PER_BAR;
const MUSIC_VOLUME = 0.35;
const MUSIC_LOOKAHEAD_SECONDS = 0.15;
const MUSIC_TICK_MS = 25;

const MENU_SONG_CHORDS = [
  { bass: 38, pad: [62, 66, 69] },
  { bass: 33, pad: [61, 64, 69] },
  { bass: 35, pad: [62, 66, 71] },
  { bass: 31, pad: [62, 67, 71] },
];
const MENU_SONG_ARP_PATTERN = [0, 1, 2, 1];
const MENU_SONG_STAB_STEPS = new Set([2, 6, 10, 14]);
const MENU_SONG_TOM_FILL = [55, 50, 45];
const MENU_SONG_LEAD = [
  [0, 74, 2], [2, 74, 2], [4, 76, 2], [6, 78, 4], [10, 76, 2], [12, 74, 4],
  [16, 73, 2], [18, 73, 2], [20, 74, 2], [22, 76, 6], [28, 69, 4],
  [32, 78, 2], [34, 78, 2], [36, 79, 2], [38, 81, 4], [42, 79, 2], [44, 78, 4],
  [48, 79, 4], [52, 78, 2], [54, 76, 2], [56, 74, 8],
  [64, 74, 2], [66, 74, 2], [68, 76, 2], [70, 78, 4], [74, 76, 2], [76, 74, 4],
  [80, 73, 2], [82, 76, 2], [84, 81, 4], [88, 78, 2], [90, 76, 6],
  [96, 78, 2], [98, 81, 2], [100, 83, 4], [104, 81, 2], [106, 78, 2], [108, 76, 4],
  [112, 74, 4], [116, 76, 4], [120, 74, 8],
];
const MENU_SONG_LEAD_BY_STEP = new Map(MENU_SONG_LEAD.map(([step, midi, length]) => [step, { midi, length }]));
const MENU_SONG_LEAD_STEPS = 128;
const MENU_SONG_STEPS = MENU_SONG_LEAD_STEPS * 2;

let musicOn = store.get('music', true);
let musicBus = null, musicReverb = null, musicDelay = null, musicNoise = null;
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
    kick: stepInBar % 4 === 0,
    snare: stepInBar === 4 || stepInBar === 12,
    hatAccent: stepInBar % 4 === 2,
    tom: phraseEnds && stepInBar > 12 ? MENU_SONG_TOM_FILL[stepInBar - 13] : null,
    bass: stepInBar % 2 === 0 ? chord.bass + (stepInBar % 8 === 6 ? 12 : 0) : null,
    stab: MENU_SONG_STAB_STEPS.has(stepInBar) ? chord.pad : null,
    pad: stepInBar === 0 ? chord.pad : null,
    arp: chord.pad[MENU_SONG_ARP_PATTERN[stepInBar % MENU_SONG_ARP_PATTERN.length]] + 12,
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
  musicReverb.buffer = createMusicNoiseBuffer(2.4, 2, 3);
  musicReverb.connect(musicBus);
  musicDelay = AC.createDelay(1);
  musicDelay.delayTime.value = MUSIC_STEP_SECONDS * 3;
  const delayTone = AC.createBiquadFilter();
  delayTone.type = 'lowpass';
  delayTone.frequency.value = 2600;
  const delayFeedback = AC.createGain();
  delayFeedback.gain.value = 0.38;
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

function routeMusicVoice(source, reverbAmount, delayAmount) {
  source.connect(musicBus);
  connectMusicSend(source, musicReverb, reverbAmount);
  connectMusicSend(source, musicDelay, delayAmount);
}

function playMusicOscillator({ type, midi, time, duration, volume, cutoff, detune = 0, attack = 0.005, release = duration, reverb = 0, delay = 0 }) {
  const oscillator = AC.createOscillator();
  oscillator.type = type;
  oscillator.frequency.value = musicMidiToFrequency(midi);
  oscillator.detune.value = detune;
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
  routeMusicVoice(envelope, reverb, delay);
  oscillator.start(time);
  oscillator.stop(time + duration + 0.05);
}

function playMusicNoise({ time, duration, volume, filterType, frequency, reverb = 0 }) {
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
  routeMusicVoice(envelope, reverb, 0);
  source.start(time, Math.random() * 0.5, duration + 0.02);
}

function playMusicDrum({ time, fromFrequency, toFrequency, volume, duration, reverb = 0 }) {
  const oscillator = AC.createOscillator();
  const envelope = AC.createGain();
  oscillator.frequency.setValueAtTime(fromFrequency, time);
  oscillator.frequency.exponentialRampToValueAtTime(toFrequency, time + duration * 0.4);
  envelope.gain.setValueAtTime(volume, time);
  envelope.gain.exponentialRampToValueAtTime(0.001, time + duration);
  oscillator.connect(envelope);
  routeMusicVoice(envelope, reverb, 0);
  oscillator.start(time);
  oscillator.stop(time + duration + 0.03);
}

function playMusicClap(time) {
  for (const offset of [0, 0.011, 0.022]) {
    playMusicNoise({ time: time + offset, duration: 0.03, volume: 0.22, filterType: 'bandpass', frequency: 1200 });
  }
  playMusicNoise({ time: time + 0.033, duration: 0.16, volume: 0.16, filterType: 'bandpass', frequency: 1200, reverb: 0.6 });
}

function playMenuMusicStep(events, time) {
  if (events.kick) playMusicDrum({ time, fromFrequency: 150, toFrequency: 45, volume: 0.6, duration: 0.3 });
  if (events.snare) {
    playMusicNoise({ time, duration: 0.2, volume: 0.26, filterType: 'bandpass', frequency: 2100, reverb: 0.8 });
    playMusicOscillator({ type: 'triangle', midi: 55, time, duration: 0.1, volume: 0.18, cutoff: 4000, reverb: 0.4 });
    playMusicClap(time);
  }
  if (events.tom !== null) {
    const frequency = musicMidiToFrequency(events.tom);
    playMusicDrum({ time, fromFrequency: frequency * 1.5, toFrequency: frequency, volume: 0.4, duration: 0.35, reverb: 0.8 });
  }
  playMusicNoise({ time, duration: events.hatAccent ? 0.09 : 0.03, volume: events.hatAccent ? 0.09 : 0.05, filterType: 'highpass', frequency: 7500 });
  if (events.bass !== null) {
    playMusicOscillator({ type: 'sawtooth', midi: events.bass, time, duration: MUSIC_STEP_SECONDS * 1.1, volume: 0.2, cutoff: 950 });
  }
  if (events.pad) {
    for (const midi of events.pad) {
      playMusicOscillator({ type: 'triangle', midi: midi - 12, time, duration: MUSIC_BAR_SECONDS + 0.2, volume: 0.03, cutoff: 1200, attack: 0.3, release: 0.5, reverb: 0.6 });
    }
  }
  if (events.stab) {
    for (const midi of events.stab) {
      for (const detune of [-7, 7]) {
        playMusicOscillator({ type: 'sawtooth', midi, time, duration: MUSIC_STEP_SECONDS * 1.2, volume: 0.028, cutoff: 3200, detune, reverb: 0.35 });
      }
    }
  }
  playMusicOscillator({ type: 'square', midi: events.arp, time, duration: MUSIC_STEP_SECONDS * 0.7, volume: 0.018, cutoff: 2600, reverb: 0.15, delay: 0.4 });
  if (events.lead) {
    const duration = events.lead.length * MUSIC_STEP_SECONDS;
    playMusicOscillator({ type: 'square', midi: events.lead.midi, time, duration, volume: 0.04, cutoff: 4200, attack: 0.01, release: 0.12, reverb: 0.25, delay: 0.2 });
    playMusicOscillator({ type: 'sawtooth', midi: events.lead.midi + 12, time, duration, volume: 0.015, cutoff: 5000, detune: 5, attack: 0.01, release: 0.12, reverb: 0.25 });
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
