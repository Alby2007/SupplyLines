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
const understaffedFor = (color) => (b) =>
  b.active &&
  (b.type === 'farm' || (b.type === 'market' && b.color === color)) &&
  b.workers.length < CONFIG.food.workersNeeded + 1;
const officeFor = (color) => (b) =>
  b.active && b.type === 'work' && b.color === color;
export const personDestFor = (color) => [understaffedFor(color), officeFor(color)];

export const marketMatch = (b) => b.type === 'market' && b.active;

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
    if (!a.legs) {
      a.retryT -= dt;
      if (a.retryT <= 0) {
        const matchers = Array.isArray(a.dest) ? a.dest : [a.dest];
        // people may only ride lines of their own colour; crates ride any
        // (colour-locked stops mean they can only alight at matching markets)
        const opts = a.kind === 'person' ? { lineColor: a.color } : {};
        for (const m of matchers) {
          a.legs = findPath(state, a.loc, m, opts);
          if (a.legs) break;
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
        const i = b.waiting.indexOf(a.id);
        if (i >= 0) b.waiting.splice(i, 1);
      } else {
        a.legs = null; // stale path; recompute next retry
      }
    }
  }
}
