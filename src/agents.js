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
  return onLine.size ? [(b) => onLine.has(b.id), marketMatch] : [marketMatch];
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
    if (!a.legs) {
      a.retryT -= dt;
      if (a.retryT <= 0) {
        const matchers =
          a.kind === 'crate'
            ? crateMatchers(state, a.loc)
            : Array.isArray(a.dest) ? a.dest : [a.dest];
        // people ride lines of their own colour (never freight); crates
        // only board freight trains — passenger cars won't take them
        const opts = a.kind === 'person' ? { lineColor: a.color } : { freight: true };
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
