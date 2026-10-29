import { CONFIG } from './config.js';
import { cellKey } from './grid.js';
import { riverCells } from './terrain.js';

export function createState() {
  return {
    time: 0,
    week: 1,
    weekT: 0,
    buildings: new Map(),
    lines: new Map(),
    roadNodes: new Map(),   // phase 2
    roadEdges: new Map(),   // phase 2
    agents: new Map(),
    vehicles: new Map(),
    nextId: 1,
    delivered: 0,
    freightDelivered: 0,
    gameOver: null,
    paused: false,
    pauseMenu: false,
    levelsMenu: false,
    speed: 1,
    upgradePending: false,
    netVersion: 0,          // bumped on any network edit; stale agent paths get recomputed
    unlockedColors: Array.from({ length: CONFIG.colors.startUnlocked }, (_, i) => i),
    colorSeedQueue: [],     // forced spawns after a colour unlocks (home+work pair)
    maxLines: CONFIG.lines.maxStart,
    roadTiles: CONFIG.roads.tilesStart,
    roadCapBonus: 0,
    motorways: 0,           // countable item stock — each span placed spends 1
    motorwayGranted: false, // first one arrives at CONFIG.motorways.unlockWeek
    roundabouts: 0,
    roundaboutGranted: false,
    trafficLights: 0,
    trafficLightGranted: false,
    bridges: 0,            // water cells a road may cross — Map 3's river kit
    bridgesGranted: false,
    camera: { x: 0, y: 0 },   // world-space top-left of the 640-tile viewport
    assignClock: CONFIG.food.assignInterval,
    spawnClock: CONFIG.spawn.intervalStart,
    water: new Set(),        // impassable water cellKeys (oasis etc.), per level
  };
}

// a level's terrain as data — water cell set, colours, grid dims. Used by
// applyLevelFeatures (game boot) and by the levels-screen thumbnails, which
// paint the same water the map will load with
export function levelTerrain(level) {
  const def = CONFIG.levels?.[level];
  const wdef = def?.water;
  const CS = CONFIG.grid.cell;
  const mw = def?.map?.width ?? CONFIG.map.width;
  const mh = def?.map?.height ?? CONFIG.map.height;
  const cols = Math.floor(mw / CS), rows = Math.floor(mh / CS);
  if (!wdef) return { water: new Set(), fill: null, edge: null, cols, rows };
  const list = wdef.river
    ? riverCells(wdef.river, cols, rows)
    : wdef.cells.map(([dx, dy]) => ({ cx: wdef.at.cx + dx, cy: wdef.at.cy + dy }));
  return { water: new Set(list.map(cellKey)), fill: wdef.fill, edge: wdef.edge, cols, rows };
}

// materialise the level's terrain (water defs → absolute cell keys)
export function applyLevelFeatures(state) {
  const t = levelTerrain(state.level);
  state.water = t.water;
  state.waterFill = t.fill;
  state.waterEdge = t.edge;
}

export const nid = (s) => s.nextId++;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
