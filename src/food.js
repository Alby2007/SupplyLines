import { CONFIG } from './config.js';
import { spawnAgent, marketMatch } from './agents.js';
import { spawnMilkTruck, spawnCourier } from './vehicles.js';
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

// each home is served by its nearest road-reachable SAME-COLOUR market —
// preferring markets that can actually roll trucks. An unstaffed market
// dispatches nothing (workers are the drivers), so homes near a dead market
// get reassigned to the next-nearest staffed one; unstaffed only wins when
// nothing staffed can reach.
function assignHomes(state) {
  const byColor = new Map();
  for (const h of state.buildings.values()) {
    if (h.type === 'home' && h.active) {
      if (!byColor.has(h.color)) byColor.set(h.color, []);
      byColor.get(h.color).push(h);
    }
  }
  for (const [color, homes] of byColor) {
    const all = [...state.buildings.values()].filter(
      (b) => b.type === 'market' && b.active && b.color === color,
    );
    const staffed = all.filter((m) => driversOf(state, m) > 0);
    const reach = (ms) => (ms.length ? roadDistancesFrom(state, ms.map((m) => m.id)) : null);
    const prim = reach(staffed);
    const back = staffed.length === all.length ? null : reach(all);
    const pick = (rs, bid) => {
      const d = rs?.dist.get(`b${bid}`);
      return d != null && d !== Infinity ? { m: rs.src.get(`b${bid}`), d } : null;
    };
    for (const h of homes) {
      const r = pick(prim, h.id) ?? pick(back, h.id);
      h.assignedMarket = r?.m ?? null;
      h.marketDist = r?.d ?? Infinity;
    }
  }
}

// drivers = commuter staff + hired drivers (m.hired is a list of expiry
// timestamps, filtered lazily on read — entries are few and short-lived)
function driversOf(state, m) {
  const h = m.hired?.length ? m.hired.filter((x) => x > state.time) : [];
  if (h.length !== (m.hired?.length ?? 0)) m.hired = h;
  return m.workers.length + h.length;
}

function tryDispatch(state, m) {
  if (m.stock <= 0) return;
  // market staff are the truck drivers — each worker means one more truck
  // that can be on the road, so a short-staffed market still delivers, slower.
  // hired drivers lift the same cap — the on-demand lever the agent can pull.
  if ((m.activeTrucks || 0) >= Math.min(m.trucks, driversOf(state, m))) return;
  // homes already on a truck's route are covered — the next truck spreads to
  // whoever is left, so multiple trucks take distinct routes
  const covered = new Set();
  for (const v of state.vehicles.values()) {
    if (v.kind === 'milkTruck' && v.market === m.id) {
      for (const t of v.targets) covered.add(t);
    }
  }
  const targets = hungryAssigned(state, m.id).filter((id) => !covered.has(id));
  if (!targets.length) return;
  const load = Math.min(m.stock, CONFIG.food.milkCap, targets.length);
  const truck = spawnMilkTruck(state, m, load, routeOrder(state, m, targets.slice(0, load)));
  if (truck) {
    m.stock -= load;
    m.activeTrucks = (m.activeTrucks || 0) + 1;
  }
}

// greedy nearest-neighbour ordering of a truck's drops from the market —
// hunger order zigzags, proximity keeps each run short so it covers more
function routeOrder(state, market, bids) {
  const out = [];
  const left = [...bids];
  let from = market;
  while (left.length) {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < left.length; i++) {
      const h = state.buildings.get(left[i]);
      const d = h ? Math.abs(h.x - from.x) + Math.abs(h.y - from.y) : Infinity;
      if (d < bd) { bd = d; bi = i; }
    }
    const h = state.buildings.get(left.splice(bi, 1)[0]);
    if (!h) continue;
    out.push(h.id);
    from = h;
  }
  return out;
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

// ---- couriers: the RL lever for homes no road can reach ---------------------
// Eligible targets = same-colour homes with NO assigned market (assignedMarket
// is null precisely when no same-colour market is road-reachable) inside the
// courier's walking radius — trucks handle the rest. Hungriest first, nearer
// breaking ties so a dispatch spends less time walking.
export function courierTargets(state, m) {
  const out = [];
  for (const h of state.buildings.values()) {
    if (h.type !== 'home' || !h.active || h.assignedMarket != null || h.color !== m.color) continue;
    const d = Math.hypot(h.x - m.x, h.y - m.y);
    if (d <= CONFIG.food.courierRadius) out.push({ h, d });
  }
  out.sort((a, b) => b.h.hungerT - a.h.hungerT || a.d - b.d);
  return out;
}

export function couriersInFlight(state, mid) {
  let n = 0;
  for (const v of state.vehicles.values()) {
    if (v.kind === 'courier' && v.market === mid) n++;
  }
  return n;
}

// one dispatch = one paid walker = one crate to one home. Consumes stock so
// couriers stay downstream of the real chain; tiles are charged by the caller.
export function sendCourier(state, m) {
  if ((m.stock ?? 0) < 1) return null;
  if (couriersInFlight(state, m.id) >= CONFIG.food.courierCap) return null;
  const t = courierTargets(state, m)[0];
  if (!t) return null;
  const v = spawnCourier(state, m, t.h);
  if (v) m.stock--;
  return v;
}
