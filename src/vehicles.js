import { CONFIG } from './config.js';
import { nid } from './state.js';
import { roadNodeKey, nodePos, congestFactor, findPathTo } from './routing.js';
import { polyLen, pointAtLen } from './roads.js';
import { lineSegPts, lineSegLen } from './networks.js';

// Arrival resolution: crates stock markets; farm/market arrivals staff shifts;
// office workers take a shift then commute home (Motorways round trips) — the
// home's resident slot only frees when they're back.
export function arrive(state, a, bid) {
  const b = bid != null ? state.buildings.get(bid) : null;
  if (a.kind === 'crate') {
    state.agents.delete(a.id);
    state.freightDelivered++;
    if (b && b.type === 'market') b.stock++;
    return;
  }
  if (b && b.type === 'home' && a.home === bid) {
    state.agents.delete(a.id); // resident back home — round trip complete
    return;
  }
  state.delivered++;
  if (b && b.type === 'work') {
    // each arriving worker buys the workplace more time
    b.demandT = Math.max(-CONFIG.demand.grace, b.demandT - CONFIG.demand.relief);
    // sustained service grows the workplace: more arrivals per level, faster meter
    b.served = (b.served ?? 0) + 1;
    const lvl = b.level ?? 1;
    if (lvl < CONFIG.demand.maxLevel && b.served >= lvl * CONFIG.demand.promoteEvery) {
      b.level = lvl + 1;
      b.demandT = Math.min(b.demandT, 0); // promotion clears accrued demand
    }
    // they stay for a shift — not deleted, just parked at the workplace
    a.shiftT = CONFIG.work.shiftLen;
    a.workingAt = bid;
    a.loc = bid;
    a.legs = null;
    return;
  }
  state.agents.delete(a.id);
  if (b && (b.type === 'farm' || b.type === 'market') &&
      b.workers.length < CONFIG.food.workersNeeded * 2) {
    b.workers.push(CONFIG.food.shiftLen);
  }
}

// ---- trains ----

export function addTrain(state, line) {
  const t = {
    id: nid(state),
    kind: 'train',
    line: line.id,
    from: 0,
    dir: 1,
    t: 0,
    dwellT: CONFIG.trains.dwell,
    pax: [],
    cap: CONFIG.trains.capacity,
  };
  state.vehicles.set(t.id, t);
  line.trains.push(t.id);
  return t;
}

export function trainPos(state, v) {
  const line = state.lines.get(v.line);
  if (!line) return { x: 0, y: 0, angle: 0 };
  const n = line.stops.length;
  const a = state.buildings.get(line.stops[v.from]);
  if (!a) return { x: 0, y: 0, angle: 0 };
  // canonical segment in line order — the same polyline that's drawn.
  // dir=-1 travels it backwards, so fraction = 1 - t.
  const segIdx = v.dir === 1 ? v.from : (v.from - 1 + n) % n;
  const pts = lineSegPts(state, line.stops[segIdx], line.stops[(segIdx + 1) % n]);
  if (!pts || v.dwellT > 0) return { x: a.x, y: a.y, angle: 0 };
  const len = polyLen(pts);
  const d = (v.dir === 1 ? v.t : 1 - v.t) * len;
  const p = pointAtLen(pts, d);
  const p2 = pointAtLen(pts, Math.max(0, Math.min(len, d + 2 * v.dir)));
  return { x: p.x, y: p.y, angle: Math.atan2(p2.y - p.y, p2.x - p.x) };
}

// ---- road legs → vehicle geometry ----
// segs[i] = {pts, len, edgeId}; geometry survives edge splits (edgeId may go stale).

export function segsForLeg(state, leg) {
  const segs = [];
  for (let i = 0; i < leg.nodes.length - 1; i++) {
    const edgeId = leg.edgeIds[i];
    const e = edgeId != null ? state.roadEdges.get(edgeId) : null;
    let pts;
    if (e) {
      const fwd = roadNodeKey(state.roadNodes.get(e.a)) === leg.nodes[i];
      pts = fwd ? e.pts : [...e.pts].reverse();
    } else {
      const a = nodePos(state, leg.nodes[i]);
      const b = nodePos(state, leg.nodes[i + 1]);
      if (!a || !b) continue;
      pts = [a, b];
    }
    segs.push({ pts, len: Math.max(1, polyLen(pts)), edgeId: e ? e.id : null });
  }
  return segs;
}

function registerOnEdge(state, v) {
  const id = v.segs[v.seg]?.edgeId;
  if (id != null) state.roadEdges.get(id)?.vehicles.add(v.id);
}
function leaveEdge(state, v) {
  const id = v.segs[v.seg]?.edgeId;
  if (id != null) state.roadEdges.get(id)?.vehicles.delete(v.id);
}

export function spawnCar(state, agent, leg, kind = 'car') {
  const segs = segsForLeg(state, leg);
  if (!segs.length) return null;
  const v = { id: nid(state), kind, color: agent.color ?? null, segs, seg: 0, dist: 0, pax: [agent.id] };
  state.vehicles.set(v.id, v);
  registerOnEdge(state, v);
  agent.loc = { veh: v.id };
  return v;
}

// ---- milkman trucks: market-owned delivery vehicles ----
// phase 'deliver' → visit hungry assigned homes until load=0 → 'return' to market.

export function spawnMilkTruck(state, market, load, targets) {
  const legs = findPathTo(state, market.id, targets[0], { modes: { line: false, road: true } });
  const leg = legs?.find((l) => l.mode === 'road');
  if (!leg) return null;
  const segs = segsForLeg(state, leg);
  if (!segs.length) return null;
  const v = {
    id: nid(state),
    kind: 'milkTruck',
    color: market.color ?? null,
    segs,
    seg: 0,
    dist: 0,
    market: market.id,
    load,
    phase: 'deliver',
    targets,          // candidate home bids, hungriest first
  };
  state.vehicles.set(v.id, v);
  registerOnEdge(state, v);
  return v;
}

function milkArrive(state, v) {
  const market = state.buildings.get(v.market);

  if (v.phase === 'deliver') {
    const home = v.targets[0] != null ? state.buildings.get(v.targets[0]) : null;
    if (home && v.load > 0) {
      v.load--;
      home.hungerT = 0;
      home.fedAt = state.time;
    }
    v.targets.shift();
    if (v.load > 0 && v.targets.length) {
      // continue to next hungry home from wherever we are
      const legs = findPathTo(state, home.id, v.targets[0], { modes: { line: false, road: true } });
      const leg = legs?.find((l) => l.mode === 'road');
      const segs = leg && segsForLeg(state, leg);
      if (segs?.length) {
        v.segs = segs;
        v.seg = 0;
        v.dist = 0;
        registerOnEdge(state, v);
        return;
      }
    }
    // out of load or targets → head home
    v.phase = 'return';
    if (home && market) {
      const legs = findPathTo(state, home.id, market.id, { modes: { line: false, road: true } });
      const leg = legs?.find((l) => l.mode === 'road');
      const segs = leg && segsForLeg(state, leg);
      if (segs?.length) {
        v.segs = segs;
        v.seg = 0;
        v.dist = 0;
        registerOnEdge(state, v);
        return;
      }
    }
  }
  // arrived back at market (or can't get home) → despawn
  leaveEdge(state, v);
  state.vehicles.delete(v.id);
  if (market) market.activeTrucks = Math.max(0, (market.activeTrucks || 0) - 1);
}

// ---- shared update ----

export function update(state, dt) {
  for (const v of [...state.vehicles.values()]) {
    if (v.kind === 'train') updateTrain(state, v, dt);
    else updateRoadVeh(state, v, dt);
  }
}

function updateRoadVeh(state, v, dt) {
  const seg = v.segs[v.seg];
  const e = seg?.edgeId != null ? state.roadEdges.get(seg.edgeId) : null;
  const base = v.kind === 'car' ? CONFIG.roads.carSpeed : CONFIG.roads.truckSpeed;
  let d = base * (e ? congestFactor(state, e) : 1) * dt;

  while (d > 0) {
    const s = v.segs[v.seg];
    const rem = s.len - v.dist;
    if (d < rem) {
      v.dist += d;
      d = 0;
    } else {
      d -= rem;
      leaveEdge(state, v);
      v.seg++;
      if (v.seg >= v.segs.length) {
        if (v.kind === 'milkTruck') milkArrive(state, v);
        else arriveCar(state, v);
        return;
      }
      v.dist = 0;
      registerOnEdge(state, v);
    }
  }
}

export function carPos(v) {
  const seg = v.segs[v.seg];
  if (!seg) return { x: 0, y: 0, angle: 0 };
  const p = pointAtLen(seg.pts, v.dist);
  const p2 = pointAtLen(seg.pts, Math.min(seg.len, v.dist + 2));
  return { x: p.x, y: p.y, angle: Math.atan2(p2.y - p.y, p2.x - p.x) };
}

function arriveCar(state, v) {
  const a = state.agents.get(v.pax[0]);
  state.vehicles.delete(v.id);
  if (!a) return;
  const leg = a.legs.shift();
  a.loc = leg.to;
  if (!a.legs.length) {
    arrive(state, a, leg.to);
  } else {
    state.buildings.get(leg.to)?.waiting.push(a.id);
  }
}

// ---- trains internals ----

function updateTrain(state, v, dt) {
  const line = state.lines.get(v.line);
  if (!line || line.stops.length < 2) return;
  if (v.dwellT > 0) {
    v.dwellT -= dt;
    return;
  }
  const n = line.stops.length;
  const aId = line.stops[v.from];
  const bId = line.stops[(v.from + v.dir + n) % n];
  if (!state.buildings.get(aId) || !state.buildings.get(bId)) return;
  v.t += (CONFIG.trains.speed * dt) / lineSegLen(state, aId, bId);
  if (v.t < 1) return;

  v.t = 0;
  v.from = (v.from + v.dir + n) % n;
  if (!line.loop) {
    if (v.from === n - 1) v.dir = -1;
    else if (v.from === 0) v.dir = 1;
  }
  exchange(state, v, line, line.stops[v.from]);
  v.dwellT = CONFIG.trains.dwell;
}

function exchange(state, v, line, bid) {
  const b = state.buildings.get(bid);
  if (!b) return;

  for (let i = v.pax.length - 1; i >= 0; i--) {
    const a = state.agents.get(v.pax[i]);
    const leg = a?.legs?.[0];
    if (a && leg && leg.mode === 'line' && leg.lineId === line.id && leg.to === bid) {
      v.pax.splice(i, 1);
      a.legs.shift();
      a.loc = bid;
      if (a.legs.length === 0) arrive(state, a, bid);
      else b.waiting.push(a.id);
    }
  }

  let crates = 0;
  for (const aid of v.pax) {
    if (state.agents.get(aid)?.kind === 'crate') crates++;
  }
  const crateRoom = Math.max(0, line.wagons * CONFIG.food.crateCap - crates);

  let boardedCrates = 0;
  for (let i = b.waiting.length - 1; i >= 0; i--) {
    const a = state.agents.get(b.waiting[i]);
    const leg = a?.legs?.[0];
    if (!leg || leg.mode !== 'line' || leg.lineId !== line.id) continue;
    if (!dirOk(line, v, leg)) continue;
    if (a.kind === 'crate') {
      if (boardedCrates >= crateRoom) continue;
      boardedCrates++;
    } else if (v.pax.length - crates >= v.cap) {
      continue; // passenger section full (crates ride the wagon)
    }
    b.waiting.splice(i, 1);
    v.pax.push(a.id);
    a.loc = { veh: v.id };
  }
}

// only board trains actually heading toward the leg's target stop
function dirOk(line, v, leg) {
  const ix = line.stops.indexOf(leg.to);
  if (ix < 0 || ix === v.from) return false;
  if (line.loop) return true;
  const eff = v.from === 0 ? 1 : v.from === line.stops.length - 1 ? -1 : v.dir;
  return Math.sign(ix - v.from) === eff;
}
