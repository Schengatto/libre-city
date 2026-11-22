const MUSIC_BPM = 100;
const MUSIC_STEP_SECONDS = 60 / MUSIC_BPM / 4;
const MUSIC_STEPS_PER_BAR = 16;
const MUSIC_BAR_SECONDS = MUSIC_STEP_SECONDS * MUSIC_STEPS_PER_BAR;
const MUSIC_VOLUME = 0.35;
const MUSIC_LOOKAHEAD_SECONDS = 0.15;
const MUSIC_TICK_MS = 25;

const MENU_SONG_CHORDS = [
  { bass: 33, pad: [57, 60, 64, 71] },
  { bass: 29, pad: [53, 57, 60, 64] },
  { bass: 36, pad: [55, 60, 64, 67] },
  { bass: 31, pad: [55, 59, 62, 67] },
];
const MENU_SONG_ARP_PATTERN = [0, 1, 2, 3, 2, 3, 1, 2];
const MENU_SONG_LEAD = [
  [0, 76, 6], [6, 74, 2], [8, 72, 4], [12, 69, 4],
  [16, 72, 6], [22, 69, 2], [24, 67, 8],
  [32, 76, 4], [36, 79, 4], [40, 76, 4], [44, 74, 4],
  [48, 74, 8], [56, 71, 4],
  [64, 81, 6], [70, 79, 2], [72, 76, 8],
  [80, 77, 4], [84, 76, 4], [88, 72, 8],
  [96, 79, 4], [100, 76, 4], [104, 72, 4], [108, 76, 4],
  [112, 74, 12],
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
  const chord = MENU_SONG_CHORDS[Math.floor(step / MUSIC_STEPS_PER_BAR) % MENU_SONG_CHORDS.length];
  const leadStep = step - MENU_SONG_LEAD_STEPS;
  return {
    kick: stepInBar % 4 === 0,
    snare: stepInBar === 4 || stepInBar === 12,
    hatAccent: stepInBar % 4 === 2,
    bass: stepInBar % 2 === 0 ? chord.bass + (stepInBar % 4 === 2 ? 12 : 0) : null,
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

function playMusicKick(time) {
  const oscillator = AC.createOscillator();
  const envelope = AC.createGain();
  oscillator.frequency.setValueAtTime(150, time);
  oscillator.frequency.exponentialRampToValueAtTime(45, time + 0.12);
  envelope.gain.setValueAtTime(0.6, time);
  envelope.gain.exponentialRampToValueAtTime(0.001, time + 0.32);
  oscillator.connect(envelope);
  routeMusicVoice(envelope, 0, 0);
  oscillator.start(time);
  oscillator.stop(time + 0.35);
}

function playMenuMusicStep(events, time) {
  if (events.kick) playMusicKick(time);
  if (events.snare) {
    playMusicNoise({ time, duration: 0.22, volume: 0.3, filterType: 'bandpass', frequency: 1900, reverb: 0.9 });
    playMusicOscillator({ type: 'triangle', midi: 55, time, duration: 0.1, volume: 0.2, cutoff: 4000, reverb: 0.5 });
  }
  playMusicNoise({ time, duration: events.hatAccent ? 0.06 : 0.03, volume: events.hatAccent ? 0.1 : 0.05, filterType: 'highpass', frequency: 7500 });
  if (events.bass !== null) {
    playMusicOscillator({ type: 'sawtooth', midi: events.bass, time, duration: MUSIC_STEP_SECONDS * 1.8, volume: 0.18, cutoff: 700 });
  }
  if (events.pad) {
    for (const midi of events.pad) {
      for (const detune of [-9, 9]) {
        playMusicOscillator({ type: 'sawtooth', midi, time, duration: MUSIC_BAR_SECONDS + 0.3, volume: 0.022, cutoff: 1500, detune, attack: 0.6, release: 0.8, reverb: 0.7 });
      }
    }
  }
  playMusicOscillator({ type: 'square', midi: events.arp, time, duration: MUSIC_STEP_SECONDS * 0.9, volume: 0.03, cutoff: 2200, reverb: 0.2, delay: 0.5 });
  if (events.lead) {
    for (const detune of [-6, 6]) {
      playMusicOscillator({ type: 'sawtooth', midi: events.lead.midi, time, duration: events.lead.length * MUSIC_STEP_SECONDS, volume: 0.04, cutoff: 3200, detune, attack: 0.03, release: 0.25, reverb: 0.4, delay: 0.35 });
    }
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
