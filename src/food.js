import { CONFIG } from './config.js';
import { spawnAgent, marketMatch } from './agents.js';
import { spawnMilkTruck } from './vehicles.js';
import { roadDistancesFrom } from './routing.js';

export function update(state, dt) {
  for (const b of state.buildings.values()) {
    if (!b.active) continue;

    // worker shifts decay — buildings need a steady arrival of workers
    for (let i = b.workers.length - 1; i >= 0; i--) {
      b.workers[i] -= dt;
      if (b.workers[i] <= 0) b.workers.splice(i, 1);
    }

    // staffed farms produce crates bound for the nearest market
    if (b.type === 'farm' && b.workers.length >= CONFIG.food.workersNeeded) {
      b.produceClock -= dt;
      if (b.produceClock <= 0) {
        b.produceClock = CONFIG.food.produceInterval;
        spawnAgent(state, b, 'crate', marketMatch);
      }
    }

    // staffed, stocked markets dispatch milkman trucks to hungry homes
    if (b.type === 'market') {
      b.dispatchT -= dt;
      if (b.dispatchT <= 0) {
        b.dispatchT = CONFIG.food.dispatchInterval;
        tryDispatch(state, b);
      }
    }
  }

  state.assignClock -= dt;
  if (state.assignClock <= 0) {
    state.assignClock = CONFIG.food.assignInterval;
    assignHomes(state);
  }
}

// each home is served by its nearest road-reachable SAME-COLOUR market
function assignHomes(state) {
  const byColor = new Map();
  for (const h of state.buildings.values()) {
    if (h.type === 'home' && h.active) {
      if (!byColor.has(h.color)) byColor.set(h.color, []);
      byColor.get(h.color).push(h);
    }
  }
  for (const [color, homes] of byColor) {
    const markets = [...state.buildings.values()].filter(
      (b) => b.type === 'market' && b.active && b.color === color,
    );
    const { dist, src } = markets.length
      ? roadDistancesFrom(state, markets.map((m) => m.id))
      : { dist: new Map(), src: new Map() };
    for (const h of homes) {
      const d = dist.get(`b${h.id}`);
      h.assignedMarket = d != null && d !== Infinity ? src.get(`b${h.id}`) : null;
      h.marketDist = d ?? Infinity;
    }
  }
}

function tryDispatch(state, m) {
  if (m.stock <= 0) return;
  if (m.workers.length < CONFIG.food.workersNeeded) return;
  if ((m.activeTrucks || 0) >= m.trucks) return;
  const targets = hungryAssigned(state, m.id);
  if (!targets.length) return;
  const load = Math.min(m.stock, CONFIG.food.milkCap, targets.length);
  const truck = spawnMilkTruck(state, m, load, targets.slice(0, load));
  if (truck) {
    m.stock -= load;
    m.activeTrucks = (m.activeTrucks || 0) + 1;
  }
}

// assigned homes that are getting hungry, hungriest first
function hungryAssigned(state, mid) {
  const out = [];
  for (const h of state.buildings.values()) {
    if (
      h.type === 'home' &&
      h.active &&
      h.assignedMarket === mid &&
      h.hungerT > CONFIG.food.hungryAt &&
      h.marketDist !== Infinity
    ) {
      out.push(h);
    }
  }
  out.sort((a, b) => b.hungerT - a.hungerT);
  return out.map((h) => h.id);
}
