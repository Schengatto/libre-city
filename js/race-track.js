const RACE_CITIES = ['PRACE1', 'MRACE1', 'GRACE1'];
const RACES_PER_CITY = 4;
const RACE_CHECKPOINTS_MIN = 8, RACE_CHECKPOINTS_MAX = 12;
const RACE_LEG_MIN = 900, RACE_LEG_MAX = 3500;
const RACE_CHECKPOINT_SPACING = 600;
const RACE_LENGTH_MIN = 12000, RACE_LENGTH_MAX = 30000;
const RACE_ATTEMPTS = 20;
const RACE_PAR_SPEEDS = { gold: 5.0, silver: 4.4, bronze: 3.8 };
const RACE_FPS = 60;

function raceShortestPaths(graph, source) {
  const count = graph.nodes.length;
  const distance = new Float64Array(count).fill(Infinity);
  const previous = new Int32Array(count).fill(-1);
  const settled = new Uint8Array(count);
  distance[source] = 0;
  for (;;) {
    let current = -1;
    for (let i = 0; i < count; i++) {
      if (!settled[i] && distance[i] < Infinity && (current < 0 || distance[i] < distance[current])) current = i;
    }
    if (current < 0) break;
    settled[current] = 1;
    for (const edgeIndex of graph.nodes[current].edges) {
      const edge = graph.edges[edgeIndex];
      const neighbour = edge.a === current ? edge.b : edge.a;
      if (graph.nodes[neighbour].live === false) continue;
      const reached = distance[current] + edge.len;
      if (reached < distance[neighbour]) { distance[neighbour] = reached; previous[neighbour] = current; }
    }
  }
  return { distance, previous };
}

function raceNextNodeToward(previous, source, target) {
  let node = target;
  while (previous[node] !== source) node = previous[node];
  return node;
}

function raceAttempt(graph, candidates, rand) {
  const checkpointCount = RACE_CHECKPOINTS_MIN + Math.floor(rand() * (RACE_CHECKPOINTS_MAX - RACE_CHECKPOINTS_MIN + 1));
  const startNode = candidates[Math.floor(rand() * candidates.length)];
  const checkpointNodes = [];
  let fromNode = startNode, length = 0, startAngle = 0;
  for (let leg = 0; leg < checkpointCount; leg++) {
    const paths = raceShortestPaths(graph, fromNode);
    const eligible = candidates.filter(node => {
      const legLength = paths.distance[node];
      if (legLength < RACE_LEG_MIN || legLength > RACE_LEG_MAX) return false;
      const point = graph.nodes[node];
      return checkpointNodes.every(earlier => Math.hypot(graph.nodes[earlier].x - point.x, graph.nodes[earlier].y - point.y) >= RACE_CHECKPOINT_SPACING);
    });
    if (!eligible.length) return null;
    const chosen = eligible[Math.floor(rand() * eligible.length)];
    if (leg === 0) {
      const towards = graph.nodes[raceNextNodeToward(paths.previous, startNode, chosen)];
      startAngle = Math.atan2(towards.y - graph.nodes[startNode].y, towards.x - graph.nodes[startNode].x);
    }
    length += paths.distance[chosen];
    checkpointNodes.push(chosen);
    fromNode = chosen;
  }
  if (length < RACE_LENGTH_MIN || length > RACE_LENGTH_MAX) return null;
  const start = graph.nodes[startNode];
  return {
    start: { x: start.x, y: start.y, angle: startAngle },
    checkpoints: checkpointNodes.map(node => ({ x: graph.nodes[node].x, y: graph.nodes[node].y })),
    length,
  };
}

function raceParMs(length, speed) {
  return Math.round(length / speed * 1000 / RACE_FPS);
}

function raceTrack(graph, code, index) {
  const candidates = [];
  graph.nodes.forEach((node, nodeIndex) => {
    if (node.live !== false && !graph.inArmyIsland(node.x, node.y)) candidates.push(nodeIndex);
  });
  if (!candidates.length) return null;
  for (let attempt = 0; attempt < RACE_ATTEMPTS; attempt++) {
    const track = raceAttempt(graph, candidates, mulberry32(hashStr(code + ':RACE:' + index + ':' + attempt)));
    if (!track) continue;
    return {
      code, index,
      start: track.start,
      checkpoints: track.checkpoints,
      length: track.length,
      parMs: {
        gold: raceParMs(track.length, RACE_PAR_SPEEDS.gold),
        silver: raceParMs(track.length, RACE_PAR_SPEEDS.silver),
        bronze: raceParMs(track.length, RACE_PAR_SPEEDS.bronze),
      },
    };
  }
  return null;
}

function raceGraphFromCity() {
  return { worldW: WORLD_W, worldH: WORLD_H, nodes, edges, inArmyIsland: (x, y) => inArmyIsland(Math.floor(x / T), Math.floor(y / T)) };
}
