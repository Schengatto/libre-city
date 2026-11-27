const gameEvents = {
  enabled: false,
  handlers: {},
  on(type, handler) {
    (this.handlers[type] || (this.handlers[type] = [])).push(handler);
  },
  off(type, handler) {
    const list = this.handlers[type];
    if (!list) return;
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  },
  emit(type, payload) {
    if (!this.enabled) return;
    const list = this.handlers[type];
    if (!list || !list.length) return;
    const event = Object.assign({}, payload, { frame: matchElapsedFrames });
    for (const handler of list.slice()) {
      try { handler(event); } catch (error) { console.error('gameEvents handler failed for ' + type, error); }
    }
  },
  clear() {
    this.handlers = {};
  },
};

function vehicleKindOf(car) {
  if (car.isTank) return 'tank';
  if (car.livery === 'army') return 'jeep';
  if (car.isDelivery) return 'delivery';
  if (car.isBike) return 'bike';
  if (car.isTaxi) return 'taxi';
  if (car.livery === 'ambulance') return 'ambulance';
  if (car.livery === 'fire') return 'fire';
  if (car.livery === 'armored') return 'armored';
  if (car.livery === 'market') return 'market';
  if (car.wasPolice || car.role === 'police') return 'police';
  return 'car';
}

function victimKindOf(ped) {
  if (ped.role === 'cop') return 'cop';
  if (ped.role === 'soldier') return 'soldier';
  return 'civ';
}
