const TUNING_DEFAULTS = Object.freeze({
  civilianCap: 26,
  civilianSpawnEvery: 8,
  trafficCap: 14,
  trafficSpawnEvery: 12,
  copRange: 330,
  copFireCdMin: 42,
  copFireCdMax: 66,
  copsPerStar: 1,
  crimeHeatScale: 1,
  heatDecay: 0.0016,
  carDamageScale: 1,
  jobTimerScale: 1,
  forceNight: false,
});
const TUNING = { ...TUNING_DEFAULTS };
