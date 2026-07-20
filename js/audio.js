// LIBRE CITY · js/audio.js — audio: sintesi procedurale WebAudio (motori, spari, sirene…).

// =========================================================
//  AUDIO (sintesi procedurale)
// =========================================================
let AC = null, engine = null;
function initAudio() {
  if (AC) { if (AC.state === 'suspended') AC.resume(); return; }
  try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { AC = null; }
}
// uscita audio: diretta, oppure attraverso un panner stereo (suoni "nel mondo")
function dest(pan) {
  if (!pan || !AC.createStereoPanner) return AC.destination;
  const p = AC.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); p.connect(AC.destination);
  return p;
}
function tone(freq, dur, type, vol, sweepTo, when, pan) {
  if (!AC) return;
  const t0 = AC.currentTime + (when || 0);
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t0);
  if (sweepTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, sweepTo), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(dest(pan)); o.start(t0); o.stop(t0 + dur + 0.03);
}
function noise(dur, vol, filter, when, pan) {
  if (!AC) return;
  const t0 = AC.currentTime + (when || 0);
  const n = AC.createBufferSource(), len = Math.max(1, Math.floor(AC.sampleRate * dur));
  const buf = AC.createBuffer(1, len, AC.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  n.buffer = buf;
  const f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filter;
  const g = AC.createGain(); g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  n.connect(f).connect(g).connect(dest(pan)); n.start(t0); n.stop(t0 + dur + 0.02);
}
// suoni emessi nel mondo: volume attenuato con la distanza e pan stereo rispetto al player
function hear(x, y, range) {
  const R = range || 900, d = dist(x, y, player.x, player.y);
  if (d > R) return null;
  const k = 1 - d / R;
  return { v: k * k, pan: clamp((x - player.x) / 520, -0.85, 0.85) };
}
// anti-spam: cooldown (in frame, decrementati in update) per i suoni che scatterebbero a raffica
const sfxCd = { scream: 0, yell: 0, chat: 0, horn: 0, skid: 0, rico: 0, clank: 0, whistle: 0 };
// motore continuo
function engineGain(vol, freq) {
  if (!AC) return;
  if (!engine) { const o = AC.createOscillator(), g = AC.createGain(); o.type = 'sawtooth'; o.frequency.value = 60; g.gain.value = 0; o.connect(g).connect(AC.destination); o.start(); engine = { o, g }; }
  engine.g.gain.setTargetAtTime(vol || 0, AC.currentTime, 0.08);
  if (freq) engine.o.frequency.setTargetAtTime(freq, AC.currentTime, 0.08);
}
// brusio dei motori del traffico: un oscillatore persistente che segue
// l'auto in movimento più "udibile" (vicina e veloce) attorno al player
let trafEng = null;
function updateTrafficEngine() {
  if (!AC) return;
  let vol = 0, freq = 55;
  for (const c of cars) {
    if (c.driver === 'player' || Math.abs(c.speed) < 0.8) continue;
    const h = hear(c.x, c.y, 640);
    if (!h) continue;
    const v = h.v * 0.05 * clamp(Math.abs(c.speed) / 4, 0.35, 1);
    if (v > vol) { vol = v; freq = 48 + Math.abs(c.speed) * 13; }
  }
  if (!trafEng) {
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = 'sawtooth'; o.frequency.value = 55; g.gain.value = 0;
    o.connect(g).connect(AC.destination); o.start(); trafEng = { o, g };
  }
  trafEng.g.gain.setTargetAtTime(vol, AC.currentTime, 0.2);
  trafEng.o.frequency.setTargetAtTime(freq, AC.currentTime, 0.2);
}
const sfx = {
  shoot()    { noise(0.05, 0.25, 1600); tone(420, 0.08, 'square', 0.14, 120); },
  smg()      { noise(0.035, 0.2, 2200); tone(520, 0.05, 'square', 0.11, 160); },
  shotgun()  { noise(0.16, 0.42, 800); tone(150, 0.16, 'square', 0.2, 55);
               tone(200, 0.05, 'square', 0.12, null, 0.28); tone(150, 0.06, 'square', 0.12, null, 0.36); },  // + "ka-chak" della pompa
  copShoot(h){ const v = h ? h.v : 1, pan = h ? h.pan : 0;
               noise(0.05, 0.2 * v, 1400, 0, pan); tone(300, 0.09, 'square', 0.12 * v, 100, 0, pan); },
  ricochet(h){ if (!h || sfxCd.rico) return; sfxCd.rico = 4;
               tone(rnd(1200, 1900), 0.09, 'triangle', 0.12 * h.v, 300, 0, h.pan); noise(0.03, 0.07 * h.v, 3000, 0, h.pan); },
  clank(h)   { if (!h || sfxCd.clank) return; sfxCd.clank = 3;
               tone(rnd(190, 260), 0.07, 'square', 0.16 * h.v, 90, 0, h.pan); noise(0.05, 0.1 * h.v, 1200, 0, h.pan); },
  ignition() { noise(0.14, 0.1, 420, 0.1); tone(46, 0.5, 'sawtooth', 0.18, 130, 0.12); },
  skid(h)    { if (sfxCd.skid) return; sfxCd.skid = 14;
               const v = h ? h.v : 1, pan = h ? h.pan : 0;
               noise(0.26, 0.13 * v, 2600, 0, pan); tone(rnd(820, 980), 0.22, 'sawtooth', 0.05 * v, 620, 0, pan); },
  // clacson: ogni veicolo suona con la propria voce (frequenza e carattere)
  horn(h, c) { if (!h || sfxCd.horn) return; sfxCd.horn = 40;
               const f = (c && c.hornF) || pick([300, 340, 375]);
               const kind = (c && c.hornKind) || 'car';
               if (kind === 'bike') {                                         // bip-bip squillante della moto
                 tone(f, 0.09, 'square', 0.09 * h.v, null, 0, h.pan);
                 tone(f, 0.09, 'square', 0.09 * h.v, null, 0.14, h.pan);
               } else if (kind === 'truck') {                                 // tromba grave e lunga del camion
                 tone(f, 0.55, 'sawtooth', 0.13 * h.v, null, 0, h.pan);
                 tone(f * 1.2, 0.55, 'sawtooth', 0.1 * h.v, null, 0, h.pan);
               } else {
                 tone(f, 0.2, 'square', 0.1 * h.v, null, 0, h.pan); tone(f * 1.26, 0.2, 'square', 0.07 * h.v, null, 0, h.pan);
                 if (Math.random() < 0.4) {                                   // a volte insiste: doppio colpo
                   tone(f, 0.26, 'square', 0.1 * h.v, null, 0.28, h.pan); tone(f * 1.26, 0.26, 'square', 0.07 * h.v, null, 0.28, h.pan);
                 }
               } },
  scream(h)  { if (!h || sfxCd.scream) return; sfxCd.scream = 12;
               const f = rnd(600, 1050);
               tone(f, 0.3, 'sawtooth', 0.11 * h.v, f * 0.5, 0, h.pan); tone(f * 1.5, 0.18, 'square', 0.04 * h.v, f * 0.7, 0.04, h.pan); },
  yell(h)    { if (!h || sfxCd.yell) return; sfxCd.yell = 10;
               const f = rnd(300, 460);
               tone(f, 0.1, 'square', 0.08 * h.v, f * 1.6, 0, h.pan); tone(f * 1.1, 0.12, 'square', 0.06 * h.v, f * 1.7, 0.09, h.pan); },
  chat(h)    { if (!h || sfxCd.chat) return; sfxCd.chat = 50;
               const f = rnd(130, 230);
               for (let i = 0; i < 3; i++) tone(f * rnd(0.85, 1.2), 0.05, 'triangle', 0.045 * h.v, null, i * 0.08, h.pan); },
  whistle(h) { if (!h || sfxCd.whistle) return; sfxCd.whistle = 90;
               tone(2050, 0.09, 'sine', 0.07 * h.v, 2350, 0, h.pan); tone(2050, 0.11, 'sine', 0.07 * h.v, 2400, 0.12, h.pan); },
  thud()     { tone(120, 0.14, 'sine', 0.28, 50); noise(0.1, 0.2, 400); },
  punch()    { noise(0.04, 0.2, 900); tone(170, 0.09, 'sine', 0.24, 70); },
  whoosh()   { noise(0.08, 0.09, 2600); },
  crash()    { noise(0.22, 0.34, 900); tone(90, 0.18, 'square', 0.14, 50); },
  boom()     { noise(0.4, 0.5, 400); tone(70, 0.4, 'sawtooth', 0.28, 35); tone(120, 0.24, 'square', 0.16, 45, 0.02); },
  ouch()     { tone(300, 0.12, 'square', 0.18, 160); },
  door()     { tone(220, 0.06, 'square', 0.14); tone(160, 0.07, 'square', 0.12, null, 0.05); },
  coin()     { tone(880, 0.07, 'triangle', 0.16); tone(1200, 0.1, 'triangle', 0.14, null, 0.06); },
  err()      { tone(150, 0.14, 'sawtooth', 0.12, 90); },
  bust()     { tone(400, 0.5, 'sawtooth', 0.2, 80); },
  siren(hi)  { if (wanted > 0) tone(hi ? 760 : 560, 0.22, 'square', 0.05 + wanted * 0.01); },
  // bitonale del mezzo del player: l'ambulanza è più acuta della volante
  emergency(amb, hi) { tone(amb ? (hi ? 960 : 720) : (hi ? 780 : 580), 0.3, 'square', 0.07); },
  spray()    { noise(0.16, 0.09, 750); },
  // whoosh del razzo del carro armato
  rocket()   { noise(0.22, 0.3, 750); tone(200, 0.4, 'sawtooth', 0.2, 55); tone(95, 0.3, 'square', 0.12, 40, 0.04); },
  // klaxon bitonale della base militare in allarme
  alarm(h)   { const v = h ? h.v : 1, pan = h ? h.pan : 0;
               tone(540, 0.17, 'square', 0.11 * v, null, 0, pan); tone(405, 0.17, 'square', 0.11 * v, null, 0.2, pan); },
};

