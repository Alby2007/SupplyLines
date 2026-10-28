import { CONFIG } from './config.js';

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
    speed: 1,
    upgradePending: false,
    netVersion: 0,          // bumped on any network edit; stale agent paths get recomputed
    unlockedColors: Array.from({ length: CONFIG.colors.startUnlocked }, (_, i) => i),
    colorSeedQueue: [],     // forced spawns after a colour unlocks (home+work pair)
    maxLines: CONFIG.lines.maxStart,
    roadTiles: CONFIG.roads.tilesStart,
    roadCapBonus: 0,
    camera: { x: 0, y: 0 },   // world-space top-left of the 640-tile viewport
    assignClock: CONFIG.food.assignInterval,
    spawnClock: CONFIG.spawn.intervalStart,
  };
}

export const nid = (s) => s.nextId++;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
