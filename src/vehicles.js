import { CONFIG } from './config.js';
import { nid, dist } from './state.js';
import { roadNodeKey, nodePos, congestFactor, findPathTo } from './routing.js';
import { polyLen, pointAtLen } from './roads.js';
import { lightGroups } from './lights.js';
import { lineSegPts, lineSegLen, linesThrough, addLine } from './networks.js';

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
  // farm/market staff work a shift like office workers — keep the agent so it
  // commutes home when the shift ends; its home's resident slot stays taken
  // until they're actually back (otherwise homes could over-produce workers)
  if (b && (b.type === 'farm' || b.type === 'market') &&
      b.workers.length < CONFIG.food.workersNeeded * 2) {
    b.workers.push(CONFIG.food.shiftLen);
    a.shiftT = CONFIG.food.shiftLen;
    a.workingAt = bid;
    a.loc = bid;
    a.legs = null;
    return;
  }
  state.agents.delete(a.id);
}

// ---- trains ----

export function addTrain(state, line, tOffset = 0) {
  const t = {
    id: nid(state),
    kind: 'train',
    line: line.id,
    freight: !!line.freight,
    from: 0,
    dir: 1,
    t: tOffset,
    dwellT: CONFIG.trains.dwell,
    pax: [],
    cap: CONFIG.trains.capacity,
  };
  state.vehicles.set(t.id, t);
  line.trains.push(t.id);
  return t;
}

// ---- buses: train-shaped service on car-shaped legs ----
// A bus is a road vehicle that loops its line's stops: it dwells + exchanges
// like a train, but each hop drives real road edges — it yields, queues,
// waits at lights, and slows under congestion like every other road user.
// `line.trains` holds its ids so deleteLine/lineLoad/etc. work unchanged.

export function addBus(state, line, tOffset = 0) {
  const home = state.buildings.get(line.stops[0]);
  const v = {
    id: nid(state),
    kind: 'bus',
    color: line.color ?? null,
    line: line.id,
    freight: false,
    from: 0,          // index of the stop it's dwelling at / last reached
    dir: 1,
    nextIdx: null,    // stop index it's driving toward while en route
    dwellT: CONFIG.trains.dwell + tOffset,
    pax: [],
    cap: CONFIG.bus.capacity,
    segs: null, seg: 0, dist: 0,
    // where carPos puts it while dwelling (no segs exist until it departs)
    parkedAt: home ? { x: home.x, y: home.y, angle: 0 } : null,
  };
  state.vehicles.set(v.id, v);
  line.trains.push(v.id);
  return v;
}

function updateBus(state, v, dt) {
  const line = state.lines.get(v.line);
  if (!line || line.stops.length < 2) { v.dwellT = 1; return; }
  if (v.dwellT > 0) { v.dwellT -= dt; return; }
  if (!v.segs) {
    // plan the hop to the next stop over the live road network
    const n = line.stops.length;
    const nextIdx = (v.from + v.dir + n) % n;
    const legs = findPathTo(state, line.stops[v.from], line.stops[nextIdx],
      { modes: { line: false, road: true } });
    const leg = legs?.find((l) => l.mode === 'road');
    const segs = leg && segsForLeg(state, leg);
    if (!segs?.length) {
      // road access demolished — the route is broken; keep retrying
      v.dwellT = 1.5;
      return;
    }
    v.nextIdx = nextIdx;
    v.segs = segs;
    v.seg = 0;
    v.dist = 0;
    registerOnEdge(state, v);
  }
  updateRoadVeh(state, v, dt); // drives; calls busArrive when segs run out
}

function busArrive(state, v) {
  const line = state.lines.get(v.line);
  v.segs = null;
  v.seg = 0;
  v.dist = 0;
  if (!line) { v.dwellT = 1; return; }
  if (v.nextIdx != null) v.from = v.nextIdx;
  const at = state.buildings.get(line.stops[v.from]);
  if (at) v.parkedAt = { x: at.x, y: at.y, angle: 0 };
  const n = line.stops.length;
  if (!line.loop) {
    if (v.from === n - 1) v.dir = -1;
    else if (v.from === 0) v.dir = 1;
  }
  exchange(state, v, line, line.stops[v.from]);
  v.dwellT = CONFIG.trains.dwell;
}

// bus routes need every stop road-connected — no track, no frontage, no stop
export function addBusLine(state, stopIds) {
  const ids = [...stopIds];
  if (ids.length < 2) return null;
  const stops = ids.map((id) => state.buildings.get(id));
  if (stops.some((b) => !b || !b.active || b.type === 'junction' ||
      b.type === 'farm' || b.roadNodeId == null)) return null;
  // every hop must be road-reachable at creation — a route planned over
  // missing asphalt would strand its only bus on the first trip
  for (let i = 0; i < ids.length - 1; i++) {
    const legs = findPathTo(state, ids[i], ids[i + 1], { modes: { line: false, road: true } });
    if (!legs?.some((l) => l.mode === 'road')) return null;
  }
  const line = addLine(state, ids);
  line.bus = true;
  // staggered pair — a lone bus's headway (half the round trip) can't compete
  for (let i = 0; i < CONFIG.bus.buses; i++) addBus(state, line, i * 4);
  return line;
}

// when a new line joins the network at a junction, every existing line it
// touches earns one extra single-carriage train
export function awardConnectionTrains(state, line) {
  const awarded = new Set();
  for (const sid of line.stops) {
    if (state.buildings.get(sid)?.type !== 'junction') continue;
    for (const other of linesThrough(state, sid)) {
      if (other.id !== line.id && !awarded.has(other.id)) {
        awarded.add(other.id);
        addTrain(state, other, 0.5); // stagger so it doesn't shadow the first
      }
    }
  }
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

// quadratic bezier between two cut points around a corner vertex
function arcPts(p0, c, p1, k = 5) {
  const out = [p0];
  for (let i = 1; i < k; i++) {
    const t = i / k, mt = 1 - t;
    out.push({
      x: mt * mt * p0.x + 2 * mt * t * c.x + t * t * p1.x,
      y: mt * mt * p0.y + 2 * mt * t * c.y + t * t * p1.y,
    });
  }
  out.push(p1);
  return out;
}

// replace each interior vertex with a small arc so cars sweep corners instead
// of snapping direction at the cell grid's hard 90-degree vertices
function fillet(pts, r) {
  if (pts.length < 3) return pts;
  const out = [{ ...pts[0] }];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], p = pts[i], b = pts[i + 1];
    const da = dist(a, p), db = dist(p, b);
    const rr = Math.min(r, da * 0.5, db * 0.5);
    if (rr < 1.5) { out.push({ ...p }); continue; } // too tight — keep the vertex
    const t0 = { x: p.x + ((a.x - p.x) / da) * rr, y: p.y + ((a.y - p.y) / da) * rr };
    const t1 = { x: p.x + ((b.x - p.x) / db) * rr, y: p.y + ((b.y - p.y) / db) * rr };
    out.push(...arcPts(t0, p, t1));
  }
  out.push({ ...pts[pts.length - 1] });
  return out;
}

// bridge seg boundaries (nodes) where the path turns sharply — the same arc
// treatment, inserted as a tiny edgeless seg so the turn sweeps through the
// junction rather than pivoting on the node point
function joinArcs(segs) {
  if (segs.length < 2) return segs;
  const R = CONFIG.roads.turnRadius;
  const out = [segs[0]];
  for (let i = 1; i < segs.length; i++) {
    const prev = out[out.length - 1], next = segs[i];
    const aPts = prev.pts, bPts = next.pts;
    let arc = null;
    if (aPts.length >= 2 && bPts.length >= 2) {
      const p0 = aPts[aPts.length - 1];
      const a1 = aPts[aPts.length - 2], b1 = bPts[1];
      const da = dist(a1, p0), db = dist(p0, b1);
      const ux = (p0.x - a1.x) / da, uy = (p0.y - a1.y) / da;
      const vx = (b1.x - p0.x) / db, vy = (b1.y - p0.y) / db;
      const cosA = ux * vx + uy * vy;
      // fillet real turns only: nearly-straight pass-throughs and hairpin
      // reversals keep the node point
      if (cosA < 0.9 && cosA > -0.4 && da > 2 && db > 2) {
        const rr = Math.min(R, da * 0.5, db * 0.5);
        const t0 = { x: p0.x - ux * rr, y: p0.y - uy * rr };
        const t1 = { x: p0.x + vx * rr, y: p0.y + vy * rr };
        prev.pts = [...aPts.slice(0, -1), t0];
        prev.len = Math.max(1, polyLen(prev.pts));
        next.pts = [t1, ...bPts.slice(1)];
        next.len = Math.max(1, polyLen(next.pts));
        const pts = arcPts(t0, p0, t1);
        arc = { pts, len: Math.max(1, polyLen(pts)), edgeId: null, fwd: true };
      }
    }
    if (arc) out.push(arc);
    out.push(next);
  }
  return out;
}

export function segsForLeg(state, leg) {
  const segs = [];
  for (let i = 0; i < leg.nodes.length - 1; i++) {
    const edgeId = leg.edgeIds[i];
    const e = edgeId != null ? state.roadEdges.get(edgeId) : null;
    let pts;
    let fwd = true;
    if (e) {
      fwd = roadNodeKey(state.roadNodes.get(e.a)) === leg.nodes[i];
      pts = fwd ? e.pts : [...e.pts].reverse();
    } else {
      const a = nodePos(state, leg.nodes[i]);
      const b = nodePos(state, leg.nodes[i + 1]);
      if (!a || !b) continue;
      pts = [a, b];
    }
    pts = fillet(pts, CONFIG.roads.turnRadius);
    segs.push({ pts, len: Math.max(1, polyLen(pts)), edgeId: e ? e.id : null, fwd });
  }
  return joinArcs(segs);
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
    const reroute = (from, to) => {
      const legs = findPathTo(state, from, to, { modes: { line: false, road: true } });
      const leg = legs?.find((l) => l.mode === 'road');
      const segs = leg && segsForLeg(state, leg);
      if (!segs?.length) return false;
      leaveEdge(state, v); // drop the old edge before swapping segs
      v.segs = segs;
      v.seg = 0;
      v.dist = 0;
      registerOnEdge(state, v);
      return true;
    };
    if (v.load > 0 && v.targets.length) {
      // continue to next hungry home from wherever we are
      if (reroute(home.id, v.targets[0])) return;
    }
    // out of load or targets → head home
    v.phase = 'return';
    if (home && market && reroute(home.id, market.id)) return;
  }
  // arrived back at market (or can't get home) → despawn
  leaveEdge(state, v);
  state.vehicles.delete(v.id);
  if (market) market.activeTrucks = Math.max(0, (market.activeTrucks || 0) - 1);
}

// ---- shared update ----

export function update(state, dt) {
  state._tick = (state._tick ?? 0) + 1;
  // traffic lights cycle their arm groups; a regroup covers roads drawn
  // into the junction after installation
  for (const n of state.roadNodes.values()) {
    const L = n.light;
    if (!L) continue;
    if (n.edges.length !== L.edgeCount) {
      L.groups = lightGroups(state, n);
      L.edgeCount = n.edges.length;
      L.idx %= Math.max(1, L.groups.length);
    }
    L.t -= dt;
    if (L.t <= 0) {
      L.idx = (L.idx + 1) % L.groups.length;
      L.t = CONFIG.trafficLights.phase;
    }
  }
  for (const v of [...state.vehicles.values()]) {
    if (v.kind === 'train') updateTrain(state, v, dt);
    else if (v.kind === 'bus') updateBus(state, v, dt);
    else updateRoadVeh(state, v, dt);
  }
}

// a car's approach edge has the green when its group is the live phase —
// arms added after installation (not yet grouped) count as green so a new
// spoke can never be red forever
function armGreen(L, eid) {
  const g = L.groups.findIndex((gr) => gr.includes(eid));
  return g === -1 || g === L.idx;
}

// per-tick spatial buckets for junction-yield queries — positions are a
// snapshot per tick (drift ≤ speed·dt ≈ 1.5px, negligible vs the 16px box),
// so each approaching car checks 9 buckets instead of every vehicle
function yieldIndex(state) {
  if (state._yieldV === state._tick) return state._yieldIdx;
  const B = CONFIG.roads.junctionBox;
  const idx = new Map();
  for (const w of state.vehicles.values()) {
    // walkers cut across open ground — they don't occupy the junction box;
    // a dwelling bus is parked at its stop, not inside the junction either
    if (w.kind === 'train' || w.kind === 'walker' || (w.kind === 'bus' && !w.segs)) continue;
    const p = carPos(w);
    const k = `${Math.floor(p.x / B)}:${Math.floor(p.y / B)}`;
    let arr = idx.get(k);
    if (!arr) idx.set(k, (arr = []));
    arr.push({ w, p });
  }
  state._yieldIdx = idx;
  state._yieldV = state._tick;
  return idx;
}

function updateRoadVeh(state, v, dt) {
  const seg = v.segs[v.seg];
  const e = seg?.edgeId != null ? state.roadEdges.get(seg.edgeId) : null;
  const base = v.kind === 'walker' ? CONFIG.walk.speed
    : v.kind === 'car' ? CONFIG.roads.carSpeed : CONFIG.roads.truckSpeed;
  let d = base * (e ? congestFactor(state, e) : 1) * (e?.motorway ? CONFIG.motorways.speedFactor : 1) * dt;

  // ---- traffic: keep a gap behind the car ahead, yield at junctions ----
  v.yielding = false;
  if (e && seg) {
    const T = CONFIG.roads;
    // each car's position along the edge's own arclength (segs may run reversed)
    const pe = seg.fwd ? v.dist : seg.len - v.dist;
    for (const wid of e.vehicles) {
      if (wid === v.id) continue;
      const w = state.vehicles.get(wid);
      const ws = w?.segs[w.seg];
      if (!ws || ws.edgeId !== e.id || ws.fwd !== seg.fwd) continue;
      const pw = ws.fwd ? w.dist : ws.len - w.dist;
      // lead gap measured in TRAVEL direction: forward cars chase larger pe,
      // reversed cars chase smaller pe — otherwise a follower reads as "ahead"
      const gap = seg.fwd ? pw - pe : pe - pw;
      if (gap > 0) d = Math.min(d, Math.max(0, gap - T.followGap));
    }
    // junction yield: hold short of the node while another vehicle is inside.
    // Patience cap: a yielded car eventually noses in — without it a stopped
    // car parked in the box (follow-blocked, non-yielding) deadlocks everyone.
    const rem = seg.len - v.dist;
    // circulating ring edges never yield — only entry approaches do
    if (rem < T.yieldLookahead && !e.roundabout) {
      // a lit junction overrides the generic yield: green arms enter freely,
      // red arms hold the stop line until their phase (or a full cycle of
      // gridlock, same safety role as yieldPatience)
      const endN = state.roadNodes.get(seg.fwd ? e.b : e.a);
      const L = endN?.light;
      if (L) {
        if (armGreen(L, e.id)) {
          v.yieldT = 0;
        } else {
          v.yielding = true;
          v.yieldT = (v.yieldT || 0) + dt;
          const waitCap = L.groups.length * CONFIG.trafficLights.phase + 1;
          if (v.yieldT < waitCap) d = Math.min(d, Math.max(0, rem - 2));
        }
      } else {
      const node = seg.pts[seg.pts.length - 1];
      const B = T.junctionBox;
      const idx = yieldIndex(state);
      const bx = Math.floor(node.x / B);
      const by = Math.floor(node.y / B);
      let blocked = false;
      for (let dx = -1; dx <= 1 && !blocked; dx++) {
        for (let dy = -1; dy <= 1 && !blocked; dy++) {
          for (const c of idx.get(`${bx + dx}:${by + dy}`) ?? []) {
            if (c.w === v || c.w.yielding || !state.vehicles.has(c.w.id)) continue;
            if (Math.hypot(c.p.x - node.x, c.p.y - node.y) < B) { blocked = true; break; }
          }
        }
      }
      if (blocked) {
        v.yielding = true;
        v.yieldT = (v.yieldT || 0) + dt;
        if (v.yieldT < T.yieldPatience) d = Math.min(d, Math.max(0, rem - 2));
      } else {
        v.yieldT = 0;
      }
      }
    } else {
      v.yieldT = 0;
    }
  }

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
        else if (v.kind === 'bus') busArrive(state, v);
        else arriveCar(state, v);
        return;
      }
      v.dist = 0;
      registerOnEdge(state, v);
    }
  }
}

export function carPos(v) {
  const seg = v.segs?.[v.seg];
  // a dwelling bus has no segs — it's parked at its current stop
  if (!seg) return v.parkedAt ?? { x: 0, y: 0, angle: 0 };
  const p = pointAtLen(seg.pts, v.dist);
  const p2 = pointAtLen(seg.pts, Math.min(seg.len, v.dist + 2));
  const angle = Math.atan2(p2.y - p.y, p2.x - p.x);
  // keep right: offset perpendicular to travel (screen-y is down, so right
  // of the direction vector is (-sin, cos))
  const L = CONFIG.roads.laneOffset;
  return {
    x: p.x - Math.sin(angle) * L,
    y: p.y + Math.cos(angle) * L,
    angle,
  };
}

function arriveCar(state, v) {
  state.vehicles.delete(v.id);
  // where the car physically ended — a building node when the route ends at a
  // stop, a plain junction otherwise (riders who lost their legs mid-ride
  // alight there and re-path from scratch)
  const end = v.segs[v.segs.length - 1];
  const ee = end?.edgeId != null ? state.roadEdges.get(end.edgeId) : null;
  const endNode = ee ? state.roadNodes.get(end.fwd ? ee.b : ee.a) : null;
  const endBid = endNode?.bid;
  // every passenger resolves their own leg — carpools alight together
  for (const aid of v.pax) {
    const a = state.agents.get(aid);
    if (!a) continue;
    const leg = a.legs?.shift();
    if (!leg) {
      // legs cleared mid-ride (a roundabout replaced a node on the route) —
      // alight here and re-plan, never crash on the missing leg
      a.loc = endBid ?? a.home;
      a.retryT = 0;
      a.pathV = -1;
      state.buildings.get(a.loc)?.waiting.push(a.id);
      continue;
    }
    a.loc = leg.to;
    if (!a.legs.length) arrive(state, a, leg.to);
    else state.buildings.get(leg.to)?.waiting.push(a.id);
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
    if (!a) continue;
    const leg = a.legs?.[0];
    const stranded = !leg; // their stop or line vanished mid-ride — get off here
    if (!stranded && !(leg.mode === 'line' && leg.lineId === line.id && leg.to === bid)) continue;
    v.pax.splice(i, 1);
    a.legs?.shift();
    a.loc = bid;
    if (stranded) {
      a.legs = null; // forces a fresh path compute at this stop
      a.retryT = 0;
      b.waiting.push(a.id);
    } else if (a.legs.length === 0) {
      arrive(state, a, bid);
    } else {
      b.waiting.push(a.id);
    }
  }

  // one carriage, one cargo: freight trains haul only crates, people trains
  // only people — a crate will never board a passenger carriage and vice versa
  let crateRoom = 0;
  let seatRoom = 0;
  if (v.freight) {
    let crates = 0;
    for (const aid of v.pax) {
      if (state.agents.get(aid)?.kind === 'crate') crates++;
    }
    crateRoom = Math.max(0, CONFIG.food.crateCap * (1 + (line.wagons || 0)) - crates);
  } else {
    seatRoom = Math.max(0, v.cap - v.pax.length);
  }

  for (let i = b.waiting.length - 1; i >= 0; i--) {
    const a = state.agents.get(b.waiting[i]);
    const leg = a?.legs?.[0];
    if (!leg || leg.mode !== 'line' || leg.lineId !== line.id) continue;
    if (!dirOk(line, v, leg)) continue;
    if (a.kind === 'crate') {
      if (crateRoom <= 0) continue;
      crateRoom--;
    } else {
      if (seatRoom <= 0) continue;
      seatRoom--;
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
