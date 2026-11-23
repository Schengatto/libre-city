function makeSimStubs(roomCode, viewSize, timers) {
  const NOOP = () => {};
  const fakeEl = {
    width: 0, height: 0, style: {}, textContent: '', value: '',
    getContext: () => new Proxy({}, { get: () => NOOP }),
    addEventListener: NOOP, removeEventListener: NOOP, appendChild: NOOP,
    classList: { add: NOOP, remove: NOOP, toggle: NOOP, contains: () => false },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: viewSize, height: viewSize }),
    focus: NOOP, select: NOOP, setAttribute: NOOP,
  };
  const sfx = new Proxy({}, { get: () => NOOP });
  return {
    document: { getElementById: () => fakeEl, querySelector: () => fakeEl, querySelectorAll: () => [],
                createElement: () => fakeEl, body: fakeEl, addEventListener: NOOP },
    window: {}, navigator: {}, location: { hash: '#room=' + roomCode, search: '', href: '' },
    localStorage: { getItem: () => null, setItem: NOOP, removeItem: NOOP },
    innerWidth: viewSize, innerHeight: viewSize,
    addEventListener: NOOP, removeEventListener: NOOP, requestAnimationFrame: NOOP,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    matchMedia: () => ({ matches: false, addEventListener: NOOP }),
    visualViewport: undefined, AudioContext: undefined, webkitAudioContext: undefined,
    console,
    sfx, sfxCd: {}, hear: () => null, initAudio: NOOP, engineGain: NOOP, updateTrafficEngine: NOOP,
    playerSirenOn: () => false,
    toast: NOOP, $: () => fakeEl,
    updateHealth: NOOP, updateCash: NOOP, updateStars: NOOP, updateWeapon: NOOP,
    updateTimer: NOOP, updateGear: NOOP, updateWpnBar: NOOP, updateToast: NOOP,
    endGame: NOOP, renderLadder: NOOP,
    netActive: () => false, netTick: NOOP, netSolidCars: out => out || [],
    netAssignCarId: NOOP, netAbandonCar: NOOP, netDestroyCar: NOOP,
    netShotFired: NOOP, netPunched: NOOP, netRocketFired: NOOP,
    netReportDown: NOOP, netRegisterHit: NOOP, netCopPayloads: () => null,
    netParkCar: NOOP, netApplyCops: NOOP, netScoreKill: NOOP,
  };
}

if (typeof module !== 'undefined') module.exports = { makeSimStubs };
