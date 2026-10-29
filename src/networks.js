import { CONFIG } from './config.js';
import { nid, dist } from './state.js';
import { routePts, polyLen, cellsAlongPolyline, cellKey, cellOf, cellCenter, buildingCells, nearestOnPolyline } from './grid.js';
import { roadCellIndex } from './roads.js';

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
    // locked to its first coloured stop — farm-anchored lines may stay neutral
    color: stopIds.map((id) => state.buildings.get(id)?.color).find((c) => c != null) ?? null,
    stops: [...stopIds],
    loop: false,
    trains: [],
    wagons: 0,
    // freight lines haul crates between farms and markets — never people
    freight: stopIds.some((id) => state.buildings.get(id)?.type === 'farm'),
  };
  state.lines.set(line.id, line);
  state.netVersion++;
  return line;
}

// stopIds = new stops to attach (not including the anchor endpoint), in drag
// order — the first is the anchor's neighbour, the last is the new terminus.
// Prepending must therefore reverse them, and shift every train's `from` so it
// stays on its stop instead of teleporting to the new head.
export function extendLine(state, line, stopIds, prepend) {
  line.stops = prepend ? [...stopIds].reverse().concat(line.stops) : [...line.stops, ...stopIds];
  if (prepend) {
    for (const vid of line.trains) {
      const t = state.vehicles.get(vid);
      if (t) t.from += stopIds.length;
    }
  }
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

// cellKey → [{line, segIdx}] for every line segment's cells — lets hit tests
// scan only track near the pointer instead of every segment of every line
export function lineSegCellIndex(state) {
  if (state._lineSegIdx && state._lineSegV === state.netVersion) return state._lineSegIdx;
  const idx = new Map();
  for (const line of state.lines.values()) {
    const n = line.stops.length;
    const segs = line.loop ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const pts = lineSegPts(state, line.stops[i], line.stops[(i + 1) % n]);
      if (!pts) continue;
      for (const c of cellsAlongPolyline(pts)) {
        const k = cellKey(c);
        let arr = idx.get(k);
        if (!arr) idx.set(k, (arr = []));
        arr.push({ line, segIdx: i });
      }
    }
  }
  state._lineSegIdx = idx;
  state._lineSegV = state.netVersion;
  return idx;
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

// nearest point on any line's routed segments within `radius` of p →
// {line, segIdx, x, y, d} or null. segIdx is the stop index the segment
// starts at — a junction inserts at segIdx+1.
export function nearestLineHit(state, p, radius = CONFIG.junctions.snap) {
  const idx = lineSegCellIndex(state);
  const c = cellOf(p);
  const n = Math.ceil(radius / CONFIG.grid.cell);
  const seen = new Set();
  let best = null;
  for (let dx = -n; dx <= n; dx++) {
    for (let dy = -n; dy <= n; dy++) {
      for (const ref of idx.get(cellKey({ cx: c.cx + dx, cy: c.cy + dy })) ?? []) {
        const sk = `${ref.line.id}:${ref.segIdx}`; // a segment covers many cells
        if (seen.has(sk)) continue;
        seen.add(sk);
        const stops = ref.line.stops;
        const pts = lineSegPts(state, stops[ref.segIdx], stops[(ref.segIdx + 1) % stops.length]);
        if (!pts || pts.length < 2) continue;
        const np = nearestOnPolyline(pts, p);
        if (!best || np.d < best.d) best = { line: ref.line, segIdx: ref.segIdx, ...np };
      }
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
  if (roadCellIndex(state).has(k) || state.water?.has(k)) return null; // not on roads or water
  const cc = cellCenter(c.cx, c.cy);
  return { line: hit.line, segIdx: hit.segIdx, x: cc.x, y: cc.y };
}

// ---- demolition ----

// riders displaced when their stop/line vanishes get moved to the nearest
// active non-junction building and repath from there
function relocateAgents(state, j) {
  let best = null;
  let bd = Infinity;
  for (const b of state.buildings.values()) {
    if (b === j || !b.active || b.type === 'junction') continue;
    const d = dist(b, j);
    if (d < bd) { bd = d; best = b; }
  }
  for (const aid of j.waiting) {
    const a = state.agents.get(aid);
    if (!a) continue;
    a.legs = null;
    a.pathV = -1;
    a.retryT = 0;
    if (best) {
      a.loc = best.id;
      best.waiting.push(a.id);
    } else {
      state.agents.delete(a.id);
    }
  }
  j.waiting = [];
}

// un-splice a junction from every line and remove it — riders whose leg
// targeted it get their legs nulled so they alight at the next stop
export function removeJunction(state, j) {
  for (const line of state.lines.values()) {
    for (let i = line.stops.length - 1; i >= 0; i--) {
      if (line.stops[i] !== j.id) continue;
      line.stops.splice(i, 1);
      for (const vid of line.trains) {
        const t = state.vehicles.get(vid);
        if (!t) continue;
        if (t.from > i) t.from--;
        for (const aid of t.pax) {
          const a = state.agents.get(aid);
          if (a?.legs?.[0]?.to === j.id) { a.legs = null; a.retryT = 0; }
        }
      }
    }
  }
  relocateAgents(state, j);
  state.buildings.delete(j.id);
  state.netVersion++;
}

// delete a whole line: trains despawn (passengers are dumped at the train's
// current stop to repath), and junctions left with no service get swept
export function deleteLine(state, line) {
  for (const vid of line.trains) {
    const t = state.vehicles.get(vid);
    if (!t) continue;
    const stopBid = line.stops[t.from];
    const at = state.buildings.get(stopBid);
    for (const aid of t.pax) {
      const a = state.agents.get(aid);
      if (!a) continue;
      a.legs = null;
      a.pathV = -1;
      a.retryT = 0;
      if (at) {
        a.loc = at.id;
        at.waiting.push(a.id);
      } else {
        state.agents.delete(a.id);
      }
    }
    state.vehicles.delete(vid);
  }
  state.lines.delete(line.id);
  state.netVersion++;
  for (const sid of line.stops) {
    const b = state.buildings.get(sid);
    if (b?.type === 'junction' && linesThrough(state, sid).length === 0) {
      removeJunction(state, b);
    }
  }
}

// bulldozer support: a line dies if the dragged cells touch its routed track;
// junctions sitting in the drag get spliced out of surviving lines
export function demolishLines(state, cells) {
  const cellSet = new Set(cells.map(cellKey));
  for (const line of [...state.lines.values()]) {
    const n = line.stops.length;
    const segs = line.loop ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const pts = lineSegPts(state, line.stops[i], line.stops[(i + 1) % n]);
      if (pts && cellsAlongPolyline(pts).some((c) => cellSet.has(cellKey(c)))) {
        deleteLine(state, line);
        break;
      }
    }
  }
  for (const b of [...state.buildings.values()]) {
    if (b.type === 'junction' && cellSet.has(cellKey(cellOf(b)))) {
      removeJunction(state, b);
    }
  }
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
