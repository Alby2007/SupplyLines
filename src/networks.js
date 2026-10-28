import { CONFIG } from './config.js';
import { nid } from './state.js';
import { routePts, polyLen, cellsAlongPolyline, cellKey, cellOf, cellCenter, buildingCells, nearestOnPolyline } from './grid.js';

// ---- transit lines ----

// grid-routed polyline for one stop→stop segment (diagonal-then-straight, ≤1 bend)
export function lineSegPts(state, aId, bId) {
  const a = state.buildings.get(aId);
  const b = state.buildings.get(bId);
  if (!a || !b) return null;
  return routePts(a, b);
}

export function lineSegLen(state, aId, bId) {
  const pts = lineSegPts(state, aId, bId);
  return pts ? Math.max(1, polyLen(pts)) : 1;
}

// concatenated routed geometry for a whole line (for drawing)
export function linePts(state, line) {
  const out = [];
  const n = line.stops.length;
  const segs = line.loop ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const pts = lineSegPts(state, line.stops[i], line.stops[(i + 1) % n]);
    if (!pts) continue;
    for (const p of pts) {
      const last = out[out.length - 1];
      if (!last || last.x !== p.x || last.y !== p.y) out.push(p);
    }
  }
  return out;
}

export function addLine(state, stopIds) {
  const line = {
    id: nid(state),
    color: state.buildings.get(stopIds[0])?.color ?? 0, // locked to its first stop
    stops: [...stopIds],
    loop: false,
    trains: [],
    wagons: 0,
  };
  state.lines.set(line.id, line);
  state.netVersion++;
  return line;
}

// stopIds = new stops to attach (not including the anchor endpoint)
export function extendLine(state, line, stopIds, prepend) {
  line.stops = prepend ? [...stopIds, ...line.stops] : [...line.stops, ...stopIds];
  if (!line.loop && line.stops.length > 2 && line.stops[0] === line.stops[line.stops.length - 1]) {
    line.loop = true;
    line.stops.pop();
    for (const vid of line.trains) {
      const t = state.vehicles.get(vid);
      if (t) { t.dir = 1; t.from = t.from % line.stops.length; }
    }
  }
  state.netVersion++;
}

// Set of cellKeys every transit line's routed geometry occupies —
// used to keep new buildings from spawning on top of tracks
export function lineCellIndex(state) {
  if (state._lineCellIdx && state._lineCellV === state.netVersion) {
    return state._lineCellIdx;
  }
  const set = new Set();
  for (const line of state.lines.values()) {
    const n = line.stops.length;
    const segs = line.loop ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const pts = lineSegPts(state, line.stops[i], line.stops[(i + 1) % n]);
      if (!pts) continue;
      for (const c of cellsAlongPolyline(pts)) set.add(cellKey(c));
    }
  }
  state._lineCellIdx = set;
  state._lineCellV = state.netVersion;
  return set;
}

export function linesThrough(state, bid) {
  return [...state.lines.values()].filter((l) => l.stops.includes(bid));
}

// lines for which bid is an endpoint (non-loop)
export function endpointLines(state, bid) {
  return [...state.lines.values()].filter(
    (l) => !l.loop && (l.stops[0] === bid || l.stops[l.stops.length - 1] === bid),
  );
}

// ---- junctions (interchange stops placed on a line's track) ----

// nearest point across every line's routed segments → {line, segIdx, x, y, d} or null.
// segIdx is the stop index the segment starts at — a junction inserts at segIdx+1.
export function nearestLineHit(state, p) {
  let best = null;
  for (const line of state.lines.values()) {
    const n = line.stops.length;
    const segs = line.loop ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const pts = lineSegPts(state, line.stops[i], line.stops[(i + 1) % n]);
      if (!pts || pts.length < 2) continue;
      const np = nearestOnPolyline(pts, p);
      if (!best || np.d < best.d) best = { line, segIdx: i, ...np };
    }
  }
  return best;
}

// a junction is a building-like stop node: passengers can wait there, lines
// can route through it, but it produces nothing and takes no road
export function addJunction(state, x, y, color) {
  const j = {
    id: nid(state),
    type: 'junction',
    x, y,
    color,
    active: true,
    spawnClock: Infinity,
    waiting: [],
    capacity: CONFIG.buildings.capacity,
    overflowT: 0,
    workers: [],
  };
  state.buildings.set(j.id, j);
  return j;
}

// splice a junction into a line's stop order inside segment segIdx
export function insertJunction(state, junction, line, segIdx) {
  line.stops.splice(segIdx + 1, 0, junction.id);
  // train `from` indexes shift for stops after the insert point
  for (const vid of line.trains) {
    const t = state.vehicles.get(vid);
    if (t && t.from >= segIdx + 1) t.from++;
  }
  state.netVersion++;
}

// junctions cap at maxLines total — the track it sits on plus connecting lines
export function junctionCanJoin(state, jid) {
  return linesThrough(state, jid).length < CONFIG.junctions.maxLines;
}

// snap a world point onto a junction placement: must hit a line's track
// in a free cell — junctions claim their tile, so occupied cells reject
export function junctionPlacement(state, p, snapPx = CONFIG.junctions.snap) {
  const hit = nearestLineHit(state, p);
  if (!hit || hit.d > snapPx) return null;
  const c = cellOf(hit);
  const k = cellKey(c);
  for (const b of state.buildings.values()) {
    if (buildingCells(b).some((bc) => cellKey(bc) === k)) return null;
  }
  const cc = cellCenter(c.cx, c.cy);
  return { line: hit.line, segIdx: hit.segIdx, x: cc.x, y: cc.y };
}

// ---- roads (phase 2 uses these) ----

export function addRoadNode(state, x, y, bid = null) {
  const n = { id: nid(state), x, y, bid, edges: [] };
  state.roadNodes.set(n.id, n);
  return n;
}

export function addRoadEdge(state, aId, bId, pts) {
  const e = { id: nid(state), a: aId, b: bId, pts, vehicles: new Set() };
  state.roadEdges.set(e.id, e);
  state.roadNodes.get(aId)?.edges.push(e.id);
  state.roadNodes.get(bId)?.edges.push(e.id);
  state.netVersion++;
  return e;
}

export function removeRoadEdge(state, e) {
  state.roadEdges.delete(e.id);
  for (const nid2 of [e.a, e.b]) {
    const n = state.roadNodes.get(nid2);
    if (n) n.edges = n.edges.filter((id) => id !== e.id);
  }
  state.netVersion++;
}
