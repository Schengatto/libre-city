const DAY_DURATION_FRAMES = 25200;
const NIGHT_DURATION_FRAMES = 14400;
const DAY_CYCLE_FRAMES = DAY_DURATION_FRAMES + NIGHT_DURATION_FRAMES;

const DAY_NIGHT_KEYFRAMES = [
  { frame: 0,     r: 255, g: 255, b: 255, light: 0 },
  { frame: 21600, r: 255, g: 255, b: 255, light: 0 },
  { frame: 23400, r: 255, g: 170, b: 120, light: 0.4 },
  { frame: 25200, r: 70,  g: 85,  b: 140, light: 1 },
  { frame: 37800, r: 70,  g: 85,  b: 140, light: 1 },
  { frame: 38700, r: 230, g: 190, b: 200, light: 0.4 },
  { frame: 39600, r: 255, g: 255, b: 255, light: 0 },
];

function dayCycleFrame(elapsedFrames) {
  return Math.floor(elapsedFrames) % DAY_CYCLE_FRAMES;
}

function dayNightAmbient(cycleFrame) {
  let next = 1;
  while (DAY_NIGHT_KEYFRAMES[next].frame < cycleFrame) next++;
  const from = DAY_NIGHT_KEYFRAMES[next - 1], to = DAY_NIGHT_KEYFRAMES[next];
  const t = (cycleFrame - from.frame) / (to.frame - from.frame);
  const mix = (a, b) => a + (b - a) * t;
  return {
    r: Math.round(mix(from.r, to.r)),
    g: Math.round(mix(from.g, to.g)),
    b: Math.round(mix(from.b, to.b)),
    light: mix(from.light, to.light),
  };
}
