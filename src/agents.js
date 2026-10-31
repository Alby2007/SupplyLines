import { CONFIG } from './config.js';
import { nid } from './state.js';
import { findPath } from './routing.js';
import { spawnCar } from './vehicles.js';

// Agents are unified: 'person' seeks an employer, 'crate' seeks a market.
// dest is a predicate(building)→bool evaluated at path time.
// loc: building id (waiting) | {veh: vehicleId} (riding)

// tiered destinations: agents try each matcher in order until a path exists.
// Workers strongly prefer understaffed farms/markets over offices at any
// distance — otherwise remote employers starve systematically.
// Colour rules: markets require a matching colour; neutral farms take anyone.
const understaffedFor = (color) => (b) => {
  if (!b.active) return false;
  // farm staff only produce — it needs exactly the requirement on site
  if (b.type === 'farm') return b.workers.length < CONFIG.food.workersNeeded;
  // market staff are truck drivers — one driver per truck keeps the whole
  // fleet rolling, so it attracts past the farm baseline up to truck count
  if (b.type === 'market' && b.color === color) {
    return b.workers.length < Math.min(b.trucks, CONFIG.food.workersNeeded + 1);
  }
  return false;
};
// triage tier: a same-colour workplace with its demand meter running hot
// beats the plain nearest-office rule — without it workers keep choosing the
// closest job while a burning one starves two streets over
const hotOfficeFor = (color) => (b) =>
  b.active && b.type === 'work' && b.color === color &&
  b.demandT > CONFIG.demand.limit * 0.4;
const officeFor = (color) => (b) =>
  b.active && b.type === 'work' && b.color === color;
export const personDestFor = (color) => [understaffedFor(color), hotOfficeFor(color), officeFor(color)];

export const marketMatch = (b) => b.type === 'market' && b.active;

// a market whose assigned homes are going hungry needs crates first — the
// nearest-market rule funnels every crate into one market, which feeds only
// its own colour and starves all the others. The stock check stops a busy
// market hoarding crates it can't dispatch: below one truckload it still
// pulls, at/above it the next-nearest needy market takes the crates.
const hungryMarketMatch = (state) => (b) => {
  if (b.type !== 'market' || !b.active || b.stock >= CONFIG.food.milkCap) return false;
  for (const h of state.buildings.values()) {
    if (h.type === 'home' && h.assignedMarket === b.id && h.hungerT > CONFIG.food.hungryAt) {
      return true;
    }
  }
  return false;
};

// who is out of which home / on shift at which building — one O(agents) scan
// shared by every building in a step, instead of a scan per building
export function presenceCounts(state) {
  const out = new Map();   // home bid → residents currently out
  const shift = new Map(); // building bid → agents working there
  for (const a of state.agents.values()) {
    if (a.kind === 'person' && a.home != null) out.set(a.home, (out.get(a.home) ?? 0) + 1);
    if (a.workingAt != null) shift.set(a.workingAt, (shift.get(a.workingAt) ?? 0) + 1);
  }
  return { out, shift };
}

// crates on a freight-connected farm target that line's markets first —
// product prefers the railway; any market is the fallback
function crateMatchers(state, locBid) {
  const onLine = new Set();
  for (const l of state.lines.values()) {
    if (!l.freight || !l.stops.includes(locBid)) continue;
    for (const s of l.stops) {
      const b = state.buildings.get(s);
      if (b?.type === 'market') onLine.add(b.id);
    }
  }
  const hungry = hungryMarketMatch(state);
  return onLine.size ? [hungry, (b) => onLine.has(b.id), marketMatch] : [hungry, marketMatch];
}

export function spawnAgent(state, atBuilding, kind, dest) {
  const a = {
    id: nid(state),
    kind,
    color: atBuilding.color ?? null,
    home: kind === 'person' ? atBuilding.id : null, // resident count for the housing cap
    dest,
    loc: atBuilding.id,
    legs: null,
    pathV: -1,
    retryT: 0,
    wait: 0,
  };
  state.agents.set(a.id, a);
  atBuilding.waiting.push(a.id);
  return a;
}

export function update(state, dt) {
  for (const a of state.agents.values()) {
    // on-shift workers aren't travelling — tick down and release them home
    if (a.workingAt != null) {
      a.shiftT -= dt;
      if (a.shiftT > 0) continue;
      a.workingAt = null;
      a.dest = (b) => b.id === a.home; // now they just want to get home
      a.legs = null;
      a.pathV = -1;
      a.retryT = 0;
      a.wait = 0;
      state.buildings.get(a.loc)?.waiting.push(a.id);
    }
    if (typeof a.loc !== 'number') continue; // riding a vehicle
    a.wait += dt;
    if (a.pathV !== state.netVersion) a.legs = null;
    // crates queueing for a freight train while the farm backs up spill onto
    // the road — rail capacity is per-train but trucks are unlimited
    if (a.kind === 'crate' && a.legs?.[0]?.mode === 'line') {
      const b = state.buildings.get(a.loc);
      if (b && b.waiting.length >= b.capacity - 2) { a.legs = null; a.retryT = 0; }
    }
    if (!a.legs) {
      a.retryT -= dt;
      if (a.retryT <= 0) {
        const matchers =
          a.kind === 'crate'
            ? crateMatchers(state, a.loc)
            : Array.isArray(a.dest) ? a.dest : [a.dest];
        // people ride lines of their own colour (never freight); crates
        // only board freight trains — passenger cars won't take them, and a
        // nearly-full farm queue sends crates by road first, falling back to
        // rail only when no market is road-reachable
        const farmQueue =
          a.kind === 'crate'
            ? (state.buildings.get(a.loc)?.waiting.length ?? 0)
            : 0;
        const optList = a.kind === 'person'
          ? [{ lineColor: a.color }]
          : farmQueue >= 4
            ? [{ freight: true, modes: { line: false, road: true } }, { freight: true }]
            : [{ freight: true }];
        outer: for (const opts of optList) {
          for (const m of matchers) {
            a.legs = findPath(state, a.loc, m, opts);
            if (a.legs) break outer;
          }
        }
        a.pathV = state.netVersion;
        a.retryT = 2;
      }
    }
    if (a.legs?.[0]?.mode === 'road') {
      // road trip: depart immediately as a car/truck (Motorways-style)
      const b = state.buildings.get(a.loc);
      const v = spawnCar(state, a, a.legs[0], a.kind === 'crate' ? 'foodTruck' : 'car');
      if (v) {
        // carpool: a household-mate routed to the same building rides along
        if (a.kind === 'person') {
          const dest = a.legs.at(-1).to;
          for (const oid of [...b.waiting]) {
            if (v.pax.length >= CONFIG.homes.residents) break;
            if (oid === a.id) continue;
            const o = state.agents.get(oid);
            if (o?.kind !== 'person' || o.home !== a.home || !o.legs?.length) continue;
            if (o.legs.at(-1).to !== dest) continue;
            o.legs = a.legs.slice(); // same route — they alight together
            o.loc = { veh: v.id };
            v.pax.push(o.id);
            b.waiting.splice(b.waiting.indexOf(oid), 1);
          }
        }
        const i = b.waiting.indexOf(a.id);
        if (i >= 0) b.waiting.splice(i, 1);
      } else {
        a.legs = null; // stale path; recompute next retry
      }
    }
  }
}
