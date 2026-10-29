import { CONFIG } from './config.js';
import { nid, dist } from './state.js';
import { addRoadNode, addRoadEdge, removeRoadEdge } from './networks.js';
import { cellOf, cellCenter, cellKey, cellsAlongPolyline, snapPosToCell, polyLen, cumLens, nearestOnPolyline, buildingCells } from './grid.js';
export { polyLen, nearestOnPolyline };

// ---- polyline math ----

export function pointAtLen(pts, d) {
  if (d <= 0) return { ...pts[0] };
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i]);
    if (d <= seg) {
      const t = seg ? d / seg : 0;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
    }
    d -= seg;
  }
  return { ...pts[pts.length - 1] };
}

export function pointAtFrac(pts, f) {
  return pointAtLen(pts, Math.max(0, Math.min(1, f)) * polyLen(pts));
}

// sub-polyline between arclength fractions f0..f1, with interpolated endpoints
export function slicePolyline(pts, f0, f1) {
  const total = polyLen(pts);
  const d0 = f0 * total;
  const d1 = f1 * total;
  const cum = cumLens(pts);
  const out = [pointAtLen(pts, d0)];
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] > d0 && cum[i] < d1) out.push({ ...pts[i] });
  }
  out.push(pointAtLen(pts, d1));
  return out;
}

// segment-segment intersection → {x,y,t(on p1p2),u(on p3p4)} or null
function segInt(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p1.x + d1x * t, y: p1.y + d1y * t, t, u };
}

// all intersections between polylines A and B; tA/tB are arclength fractions
export function polylineIntersections(A, B) {
  const cumA = cumLens(A);
  const cumB = cumLens(B);
  const totA = cumA[cumA.length - 1] || 1;
  const totB = cumB[cumB.length - 1] || 1;
  const hits = [];
  for (let i = 1; i < A.length; i++) {
    for (let j = 1; j < B.length; j++) {
      const h = segInt(A[i - 1], A[i], B[j - 1], B[j]);
      if (!h) continue;
      const lenAi = cumA[i] - cumA[i - 1];
      const lenBj = cumB[j] - cumB[j - 1];
      hits.push({
        x: h.x,
        y: h.y,
        tA: (cumA[i - 1] + h.t * lenAi) / totA,
        tB: (cumB[j - 1] + h.u * lenBj) / totB,
      });
    }
  }
  return hits;
}

// ---- road building ----

export function roadNodeForBuilding(state, b) {
  if (b.roadNodeId != null && state.roadNodes.has(b.roadNodeId)) {
    return state.roadNodes.get(b.roadNodeId);
  }
  const n = addRoadNode(state, b.x, b.y, b.id);
  b.roadNodeId = n.id;
  return n;
}

// nearest existing edge to a point: {edge, t, x, y, d} or null — scans only
// edges whose cells fall within `radius` of p, so pointermove drafts stay O(1)
let nepMark = 0;
export function nearestEdgePoint(state, p, radius = CONFIG.roads.snap) {
  const idx = roadCellIndex(state);
  const c = cellOf(p);
  const n = Math.ceil(radius / CONFIG.grid.cell);
  const mark = ++nepMark;
  let best = null;
  for (let dx = -n; dx <= n; dx++) {
    for (let dy = -n; dy <= n; dy++) {
      for (const ref of idx.get(cellKey({ cx: c.cx + dx, cy: c.cy + dy })) ?? []) {
        const e = state.roadEdges.get(ref.edgeId);
        if (!e || e._nep === mark) continue; // an edge covers many cells
        e._nep = mark;
        const np = nearestOnPolyline(e.pts, p);
        if (!best || np.d < best.d) best = { edge: e, ...np };
      }
    }
  }
  return best;
}

// Map cellKey → [{edgeId}] covering every edge's cells; rebuilt when the
// network changes so shared-cell joins are O(1) per drawn cell.
export function roadCellIndex(state) {
  if (state._cellIdx && state._cellIdxV === state.netVersion) return state._cellIdx;
  const idx = new Map();
  for (const e of state.roadEdges.values()) {
    // motorways are elevated — they occupy no ground cells, so surface roads
    // can pass underneath and drawn paths never try to join them mid-span
    if (e.motorway) continue;
    for (const c of cellsAlongPolyline(e.pts)) {
      const k = cellKey(c);
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k).push({ edgeId: e.id });
    }
  }
  // roundabout islands are part of the road: interior cells point at the
  // ring's arcs so paths ending inside the circle join it, and buildings
  // can't spawn in the middle of one
  for (const e of state.roadEdges.values()) {
    const c = e.roundabout;
    if (!c) continue;
    const R = CONFIG.roundabouts.radius;
    const c0 = cellOf(c);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cc = cellCenter(c0.cx + dx, c0.cy + dy);
        if (Math.hypot(cc.x - c.x, cc.y - c.y) >= R) continue;
        const k = cellKey({ cx: c0.cx + dx, cy: c0.cy + dy });
        if (!idx.has(k)) idx.set(k, []);
        idx.get(k).push({ edgeId: e.id });
      }
    }
  }
  state._cellIdx = idx;
  state._cellIdxV = state.netVersion;
  return idx;
}

// how close a path must pass a building's centre to count as touching it —
// snap distance plus the glyph's own radius (brushing the tile serves it)
const connectRadius = (b) =>
  CONFIG.roads.snap +
  (b.type === 'work' ? CONFIG.buildings.workRadius
    : b.type === 'home' ? CONFIG.buildings.homeRadius
    : CONFIG.buildings.radius);

// tiles a drawn cell path would consume — only cells not already road
export function roadCellCost(state, cells) {
  const idx = roadCellIndex(state);
  const seen = new Set();
  let cost = 0;
  for (const c of cells) {
    const k = cellKey(c);
    if (seen.has(k) || idx.has(k)) continue;
    seen.add(k);
    cost++;
  }
  return cost;
}

// a split landing within snap of an edge endpoint should reuse that node —
// otherwise every draw over the same corridor cuts a ~1px sliver, and the
// slivers get re-split on the next draw: the road graph grows multiplicatively
// per build instead of per new junction
function nearEndpoint(state, e, p) {
  const na = state.roadNodes.get(e.a);
  if (na && dist(na, p) < CONFIG.roads.snap) return na;
  const nb = state.roadNodes.get(e.b);
  if (nb && dist(nb, p) < CONFIG.roads.snap) return nb;
  return null;
}

// resolve a drawn endpoint to a road node: building > split edge > cell-center node
export function anchorAt(state, p) {
  let bBest = null;
  let bD = CONFIG.roads.snap;
  for (const b of state.buildings.values()) {
    if (!b.active || b.type === 'junction') continue; // junctions are rail-only
    const d = dist(b, p);
    if (d < bD) { bD = d; bBest = b; }
  }
  if (bBest) return roadNodeForBuilding(state, bBest);

  const ne = nearestEdgePoint(state, p);
  if (ne && ne.d <= CONFIG.roads.snap) {
    const near = nearEndpoint(state, ne.edge, ne);
    if (near) return near;
    if (ne.t > 0.01 && ne.t < 0.99) {
      return state.roadNodes.get(splitEdgeMulti(state, ne.edge, [ne.t]).nodeIds[1]);
    }
    const n = ne.t <= 0.5 ? ne.edge.a : ne.edge.b;
    return state.roadNodes.get(n);
  }
  const c = snapPosToCell(p);
  return addRoadNode(state, c.x, c.y);
}

// split an edge at arclength fractions ts → interior nodes in sorted order
export function splitEdgeMulti(state, e, ts) {
  const sorted = [...ts].sort((a, b) => a - b);
  const nodeIds = [e.a];
  for (const t of sorted) {
    const pt = pointAtFrac(e.pts, t);
    nodeIds.push(addRoadNode(state, pt.x, pt.y).id);
  }
  nodeIds.push(e.b);
  let prev = 0;
  const chunks = [];
  for (const t of sorted) {
    chunks.push(slicePolyline(e.pts, prev, t));
    prev = t;
  }
  chunks.push(slicePolyline(e.pts, prev, 1));
  removeRoadEdge(state, e);
  const newEdges = [];
  const child = (aId, bId, pts) => {
    const ne = addRoadEdge(state, aId, bId, pts);
    // split chunks inherit the parent's behaviour — a one-way ring arc must
    // stay one-way through every join or circulation breaks
    if (e.oneway) ne.oneway = true;
    if (e.roundabout) ne.roundabout = e.roundabout;
    if (e.motorway) ne.motorway = true;
    return ne;
  };
  for (let i = 0; i < chunks.length; i++) {
    if (nodeIds[i] === nodeIds[i + 1]) continue;
    if (chunks[i].length >= 2 && polyLen(chunks[i]) > 0) {
      newEdges.push(child(nodeIds[i], nodeIds[i + 1], chunks[i]));
      continue;
    }
    // degenerate slice between distinct coincident nodes — stub them together
    // so the split chain stays connected (same fix buildRoad uses for marks)
    const na = state.roadNodes.get(nodeIds[i]);
    const nb = state.roadNodes.get(nodeIds[i + 1]);
    if (na && nb) {
      newEdges.push(child(nodeIds[i], nodeIds[i + 1], [{ x: na.x, y: na.y }, { x: nb.x, y: nb.y }]));
    }
  }
  return { nodeIds, newEdges };
}

// turn a drawn cell sequence into anchored, intersection-split road edges.
// Joins happen at shared cells (O(1) lookup); geometric crossing is the
// fallback for diagonal×diagonal paths that share no cell.
export function buildRoad(state, cells) {
  if (!cells || cells.length < 2) return [];

  // junction cells are rail-only — a drawn path entering one is rejected
  const jCells = new Set();
  for (const b of state.buildings.values()) {
    if (b.type === 'junction') jCells.add(cellKey(cellOf(b)));
  }
  if (cells.some((c) => jCells.has(cellKey(c)))) return [];

  const pts = cells.map((c) => cellCenter(c.cx, c.cy));

  const startN = anchorAt(state, pts[0]);
  const endN = anchorAt(state, pts[pts.length - 1]);
  pts[0] = { x: startN.x, y: startN.y };
  pts[pts.length - 1] = { x: endN.x, y: endN.y };
  const marks = [
    { t: 0, nodeId: startN.id },
    { t: 1, nodeId: endN.id },
  ];

  // arclength fraction of each cell-center vertex along the new path —
  // exact for mixed orthogonal/diagonal cell steps
  const segLens = pts.slice(1).map((p, i) => dist(pts[i], p));
  const totalLen = segLens.reduce((a, x) => a + x, 0) || 1;
  const cellT = [0];
  for (const l of segLens) cellT.push(cellT[cellT.length - 1] + l / totalLen);

  // shared cells with existing edges → split there and join
  const idx = roadCellIndex(state);
  const perEdge = new Map(); // edgeId -> [{tEdge, tNew, cross?}]
  cells.forEach((c, i) => {
    const hits = idx.get(cellKey(c));
    if (!hits) return;
    const center = cellCenter(c.cx, c.cy);
    for (const occ of hits) {
      const e = state.roadEdges.get(occ.edgeId);
      if (!e) continue;
      const np = nearestOnPolyline(e.pts, center);
      if (np.d > CONFIG.grid.cell * 0.6) continue;
      if (np.t < 0.02 || np.t > 0.98) continue; // endpoint-touch → node pass handles
      // a touch right at an existing node joins through it, not by cutting a
      // sliver — without this, redrawing the same corridor re-splits slivers
      if (nearEndpoint(state, e, np)) continue;
      if (!perEdge.has(e.id)) perEdge.set(e.id, []);
      perEdge.get(e.id).push({ tEdge: np.t, tNew: cellT[i] });
    }
  });

  // pass through existing nodes we touch (no duplicate nodes)
  for (const n of state.roadNodes.values()) {
    if (n.id === startN.id || n.id === endN.id) continue;
    const np = nearestOnPolyline(pts, n);
    if (np.d <= CONFIG.roads.snap) marks.push({ t: np.t, nodeId: n.id });
  }

  // buildings whose cell the path enters get connected (Motorways: touching
  // a tile serves it); geometric near-pass within snap+glyph radius too —
  // a road brushing the building counts as reaching it
  const cellSet = new Set(cells.map(cellKey));
  for (const b of state.buildings.values()) {
    if (!b.active || b.roadNodeId != null || b.type === 'junction') continue;
    const np = nearestOnPolyline(pts, b);
    if (np.d <= connectRadius(b) || buildingCells(b).some((c) => cellSet.has(cellKey(c)))) {
      marks.push({ t: np.t, nodeId: roadNodeForBuilding(state, b).id });
    }
  }

  // geometric crossings → fallback for diagonals sharing no cell
  const crosses = [];
  for (const e of [...state.roadEdges.values()]) {
    if (e.motorway) continue; // surface roads pass under the overpass
    for (const h of polylineIntersections(pts, e.pts)) {
      if (h.tA < 0.02 || h.tA > 0.98 || h.tB < 0.02 || h.tB > 0.98) continue;
      const cross = { tNew: h.tA, edgeId: e.id, nodeId: null };
      crosses.push(cross);
      if (!perEdge.has(e.id)) perEdge.set(e.id, []);
      perEdge.get(e.id).push({ tEdge: h.tB, cross });
    }
  }
  for (const [edgeId, arr] of perEdge) {
    const e = state.roadEdges.get(edgeId);
    if (!e) continue;
    arr.sort((a, b) => a.tEdge - b.tEdge);
    // coalesce split marks closer than ~1px — they land on the same node,
    // which keeps coincident junctions single instead of spawning slivers
    const minGap = 1 / Math.max(1, polyLen(e.pts));
    const ts = [];
    for (const x of arr) {
      if (!ts.length || x.tEdge - ts[ts.length - 1] > minGap) ts.push(x.tEdge);
    }
    const { nodeIds } = splitEdgeMulti(state, e, ts);
    for (const x of arr) {
      const ni = ts.findIndex((t) => Math.abs(t - x.tEdge) <= minGap);
      const nodeId = nodeIds[1 + Math.max(0, ni)];
      if (x.cross) x.cross.nodeId = nodeId;
      else marks.push({ t: x.tNew, nodeId });
    }
  }
  for (const c of crosses) {
    if (c.nodeId != null) marks.push({ t: c.tNew, nodeId: c.nodeId });
  }

  marks.sort((a, b) => a.t - b.t);
  const uniq = [];
  for (const m of marks) {
    if (!uniq.length || uniq[uniq.length - 1].nodeId !== m.nodeId) uniq.push(m);
  }
  const edges = [];
  for (let i = 1; i < uniq.length; i++) {
    const aId = uniq[i - 1].nodeId;
    const bId = uniq[i].nodeId;
    if (aId === bId) continue;
    const chunk = slicePolyline(pts, uniq[i - 1].t, uniq[i].t);
    if (chunk.length >= 2 && polyLen(chunk) > 1) {
      edges.push(addRoadEdge(state, aId, bId, chunk));
      continue;
    }
    // two different nodes landed at the same path fraction — a building that
    // brushed the road near an endpoint shadows the anchor mark, and skipping
    // the zero-length chunk would orphan its node. Link them with a stub.
    const na = state.roadNodes.get(aId);
    const nb = state.roadNodes.get(bId);
    if (na && nb) {
      edges.push(addRoadEdge(state, aId, bId, [{ x: na.x, y: na.y }, { x: nb.x, y: nb.y }]));
    }
  }
  return edges;
}

export function roadCost(pts) {
  // unique-cell count for callers with only raw geometry (no reuse discount)
  return new Set(cellsAlongPolyline(pts).map(cellKey)).size;
}

// ---- bulldozer ----

// edges a drawn path would demolish + the tiles that would be freed
function demolishTargets(state, cells) {
  const idx = roadCellIndex(state);
  const cellSet = new Set(cells.map(cellKey));
  const doomed = new Set();
  for (const k of cellSet) {
    for (const occ of idx.get(k) ?? []) doomed.add(occ.edgeId);
  }
  // a roundabout is one piece of kit — touching any arc dooms the whole ring
  for (const id of [...doomed]) {
    const e = state.roadEdges.get(id);
    if (!e?.roundabout) continue;
    for (const o of state.roadEdges.values()) {
      if (
        o.roundabout &&
        o.roundabout.x === e.roundabout.x &&
        o.roundabout.y === e.roundabout.y
      ) {
        doomed.add(o.id);
      }
    }
  }
  const freed = new Set();
  for (const id of doomed) {
    const e = state.roadEdges.get(id);
    // ring cells refund nothing — the roundabout cost an item, not tiles
    if (e && !e.roundabout) {
      for (const c of cellsAlongPolyline(e.pts)) freed.add(cellKey(c));
    }
  }
  // a freed cell stays road if a surviving edge still covers it
  for (const e of state.roadEdges.values()) {
    if (doomed.has(e.id)) continue;
    for (const c of cellsAlongPolyline(e.pts)) freed.delete(cellKey(c));
  }
  return { doomed, freed: freed.size };
}

// tiles a bulldozer drag would return to the inventory
export function demolishRefund(state, cells) {
  return demolishTargets(state, cells).freed;
}

// remove every edge under the drawn path; orphan nodes are swept (building
// nodes stay so homes/works remain re-connectable). Returns freed tiles.
export function demolishRoad(state, cells) {
  const { doomed, freed } = demolishTargets(state, cells);
  for (const id of doomed) {
    const e = state.roadEdges.get(id);
    if (e) removeRoadEdge(state, e);
  }
  // motorways fly over the drag's cells — a touch anywhere kills the whole
  // span and returns the item (MM: deleted motorways go back in your menu)
  for (const id of motorwaysUnder(state, cells)) {
    const e = state.roadEdges.get(id);
    if (e) removeRoadEdge(state, e);
    state.motorways = Math.min(CONFIG.motorways.cap, state.motorways + 1);
  }
  for (const n of [...state.roadNodes.values()]) {
    if (n.bid == null && n.edges.length === 0) {
      // a lit junction that loses all its roads refunds the light
      if (n.light) {
        state.trafficLights = Math.min(CONFIG.trafficLights.cap, state.trafficLights + 1);
      }
      state.roadNodes.delete(n.id);
    }
  }
  return freed;
}

// a building that activates on top of an existing road joins the network via
// a short driveway stub — roads drawn through incoming buildings still serve
// them once they open (buildRoad only sees active buildings)
export function connectBuildingToRoad(state, b) {
  if (b.roadNodeId != null || b.type === 'junction') return;
  const own = new Set(buildingCells(b).map(cellKey));
  let best = null;
  for (const e of state.roadEdges.values()) {
    if (e.motorway) continue; // a building under the overpass isn't served by it
    const touches = cellsAlongPolyline(e.pts).some((c) => own.has(cellKey(c)));
    const np = nearestOnPolyline(e.pts, b);
    if (!touches && np.d > connectRadius(b)) continue;
    if (!best || np.d < best.d) best = { e, ...np };
  }
  if (!best) return;
  const bn = roadNodeForBuilding(state, b);
  let jn;
  if (best.t <= 0.02) jn = state.roadNodes.get(best.e.a);
  else if (best.t >= 0.98) jn = state.roadNodes.get(best.e.b);
  else jn = state.roadNodes.get(splitEdgeMulti(state, best.e, [best.t]).nodeIds[1]);
  if (!jn) return;
  addRoadEdge(state, jn.id, bn.id, [{ x: jn.x, y: jn.y }, { x: bn.x, y: bn.y }]);
}

// ---- motorways (elevated express edges — MM-style overpasses) ----

// a motorway endpoint must land ON the existing network — building > node >
// split edge. Unlike anchorAt there is no free-point fallback: both ends of
// a span need a landing or it can't be built.
export function motorwayAnchor(state, p) {
  let bBest = null;
  let bD = CONFIG.roads.snap;
  for (const b of state.buildings.values()) {
    if (!b.active || b.type === 'junction') continue;
    const d = dist(b, p);
    if (d < bD) { bD = d; bBest = b; }
  }
  if (bBest) return roadNodeForBuilding(state, bBest);

  // any existing node — covers motorway ends, so spans can chain end-to-end
  let nBest = null;
  let nD = CONFIG.roads.snap;
  for (const n of state.roadNodes.values()) {
    const d = dist(n, p);
    if (d < nD) { nD = d; nBest = n; }
  }
  if (nBest) return nBest;

  const ne = nearestEdgePoint(state, p);
  if (ne && ne.d <= CONFIG.roads.snap) {
    const near = nearEndpoint(state, ne.edge, ne);
    if (near) return near;
    if (ne.t > 0.01 && ne.t < 0.99) {
      return state.roadNodes.get(splitEdgeMulti(state, ne.edge, [ne.t]).nodeIds[1]);
    }
    return state.roadNodes.get(ne.t <= 0.5 ? ne.edge.a : ne.edge.b);
  }
  return null;
}

// one elevated edge between two anchored ends — free-form pts, no cells, no
// crossing joins: the span passes OVER the surface network.
export function buildMotorway(state, pts) {
  if (!pts || pts.length < 2) return null;
  const a = motorwayAnchor(state, pts[0]);
  const b = motorwayAnchor(state, pts[pts.length - 1]);
  if (!a || !b || a.id === b.id) return null;
  pts[0] = { x: a.x, y: a.y };
  pts[pts.length - 1] = { x: b.x, y: b.y };
  const e = addRoadEdge(state, a.id, b.id, pts);
  e.motorway = true;
  return e;
}

// motorway edge ids a bulldozer drag touches — the whole span dies at once
export function motorwaysUnder(state, cells) {
  const cellSet = new Set(cells.map(cellKey));
  const hit = new Set();
  for (const e of state.roadEdges.values()) {
    if (!e.motorway) continue;
    if (cellsAlongPolyline(e.pts).some((c) => cellSet.has(cellKey(c)))) hit.add(e.id);
  }
  return hit;
}

// ---- roundabouts (MM-style free-flow junction replacement) ----

// buildings that reject a drop — a roundabout can't sit on top of one
function roundaboutBlockedByBuilding(state, p) {
  const R = CONFIG.roundabouts.radius;
  for (const b of state.buildings.values()) {
    if (!b.active || b.type === 'junction') continue;
    const rad = R +
      (b.type === 'work' ? CONFIG.buildings.workRadius
        : b.type === 'home' ? CONFIG.buildings.homeRadius
        : CONFIG.buildings.radius);
    if (dist(b, p) < rad) return true;
  }
  return false;
}

// a standalone ring on open ground — roads drawn to it later join its arcs
// like any other road (shared cells / endpoint splits)
function stampRing(state, x, y) {
  const R = CONFIG.roundabouts.radius;
  const K = 8;
  const ring = [];
  for (let i = 0; i < K; i++) {
    const t = (i / K) * Math.PI * 2;
    ring.push({ ang: t, node: addRoadNode(state, x + R * Math.cos(t), y + R * Math.sin(t)) });
  }
  const edges = [];
  for (let i = 0; i < K; i++) {
    const a = ring[i];
    const b2 = ring[(i - 1 + K) % K];
    const e = addRoadEdge(state, a.node.id, b2.node.id, arcPts(x, y, R, a.ang, b2.ang));
    e.oneway = true;
    e.roundabout = { x, y };
    edges.push(e);
  }
  return edges;
}

// stamp a roundabout anywhere: dropped on a junction it replaces the node;
// on a road the road splits into the ring; on open ground it's a standalone
// ring that roads connect to as normal. Returns truthy when placed.
export function placeRoundabout(state, p) {
  if (roundaboutBlockedByBuilding(state, p)) return null;
  const R = CONFIG.roundabouts.radius;
  const ne = nearestEdgePoint(state, p, R);
  if (ne?.edge.roundabout) return null; // no stacking roundabouts
  if (ne) {
    const node = ne.t > 0.02 && ne.t < 0.98
      ? state.roadNodes.get(splitEdgeMulti(state, ne.edge, [ne.t]).nodeIds[1])
      : state.roadNodes.get(ne.t <= 0.5 ? ne.edge.a : ne.edge.b);
    return buildRoundabout(state, node);
  }
  const c = snapPosToCell(p); // rings centre on the grid, like MM
  return stampRing(state, c.x, c.y);
}

// ghost preview under the cursor — where the ring would land and whether the
// drop is legal ({x, y, ok})
export function roundaboutGhost(state, p) {
  if (roundaboutBlockedByBuilding(state, p)) return { x: p.x, y: p.y, ok: false };
  const R = CONFIG.roundabouts.radius;
  const ne = nearestEdgePoint(state, p, R);
  if (ne) return { x: ne.x, y: ne.y, ok: !ne.edge.roundabout };
  const c = snapPosToCell(p);
  return { x: c.x, y: c.y, ok: true };
}

// ---- traffic lights (MM-style junction phase controller) ----

// a lightable junction: pure node, ≥3 arms, not part of a roundabout ring
// (lights on a ring would stop circulating traffic — the ring IS the fix)
export function lightableNode(state, p, radius = CONFIG.roads.snap) {
  let best = null;
  for (const n of state.roadNodes.values()) {
    if (n.bid != null || n.edges.length < 3 || n.light) continue;
    if (n.edges.some((id) => state.roadEdges.get(id)?.roundabout)) continue;
    const d = dist(n, p);
    if (d <= radius && (!best || d < best.d)) best = { n, d };
  }
  return best?.n ?? null;
}

// group a node's incident edges into light phases: arms pointing ~opposite
// share a green (N-S together, E-W together) — like the MM junction dots
export function lightGroups(state, node) {
  const arms = [];
  for (const eid of node.edges) {
    const e = state.roadEdges.get(eid);
    if (!e) continue;
    const atA = e.a === node.id;
    const pen = atA ? e.pts[1] : e.pts[e.pts.length - 2];
    if (!pen) continue;
    arms.push({ eid, ang: Math.atan2(pen.y - node.y, pen.x - node.x) });
  }
  arms.sort((a, b) => a.ang - b.ang);
  const groups = [];
  const used = new Set();
  for (const a of arms) {
    if (used.has(a.eid)) continue;
    const g = [a.eid];
    used.add(a.eid);
    for (const b of arms) {
      if (used.has(b.eid)) continue;
      let d = Math.abs(a.ang - b.ang) % (Math.PI * 2);
      if (d > Math.PI) d = Math.PI * 2 - d;
      if (Math.abs(d - Math.PI) < 0.55) { g.push(b.eid); used.add(b.eid); break; }
    }
    groups.push(g);
  }
  return groups;
}

// click a junction → install a light; click a lit junction → remove it.
// `canAdd` gates installs on item stock (removal is always free).
// Returns 'add' | 'remove' | null so the caller can adjust the item count.
export function placeTrafficLight(state, p, canAdd = true) {
  const lit = (() => {
    let best = null;
    for (const n of state.roadNodes.values()) {
      if (!n.light) continue;
      const d = dist(n, p);
      if (d <= CONFIG.roads.snap && (!best || d < best.d)) best = { n, d };
    }
    return best?.n ?? null;
  })();
  if (lit) {
    delete lit.light;
    return 'remove';
  }
  const n = lightableNode(state, p);
  if (!n || !canAdd) return null;
  n.light = {
    groups: lightGroups(state, n),
    idx: 0,
    t: CONFIG.trafficLights.phase,
    edgeCount: n.edges.length,
  };
  return 'add';
}

// ghost preview: {x, y, ok} — snaps to the junction or existing light
export function trafficLightGhost(state, p) {
  for (const n of state.roadNodes.values()) {
    const d = dist(n, p);
    if (d > CONFIG.roads.snap) continue;
    if (n.light) return { x: n.x, y: n.y, ok: true };
    if (
      n.bid == null &&
      n.edges.length >= 3 &&
      !n.edges.some((id) => state.roadEdges.get(id)?.roundabout)
    ) {
      return { x: n.x, y: n.y, ok: true };
    }
    return { x: n.x, y: n.y, ok: false };
  }
  return { x: p.x, y: p.y, ok: false };
}

// arc from angle a0 down to a1 — decreasing angle = counterclockwise on
// screen (y is down), i.e. right-hand traffic circulation
function arcPts(cx, cy, r, a0, a1) {
  let sweep = a0 - a1;
  while (sweep <= 0) sweep += Math.PI * 2;
  const n = Math.max(2, Math.ceil(sweep / (Math.PI / 6)));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 - (sweep * i) / n;
    pts.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
  }
  return pts;
}

// swap a junction node for a one-way ring: each incident edge re-points to a
// ring node along its own approach ray, and the ring circulates
// counterclockwise. Entering cars yield at their entry node; circulating
// cars never stop inside — the MM fix for a congested crossing.
export function buildRoundabout(state, node) {
  if (!node || node.bid != null || node.edges.length < 2) return null;
  const R = CONFIG.roundabouts.radius;

  // direction each incident edge extends AWAY from the junction
  const spokes = [];
  for (const eid of node.edges) {
    const e = state.roadEdges.get(eid);
    if (!e) continue;
    const atA = e.a === node.id;
    const pen = atA ? e.pts[1] : e.pts[e.pts.length - 2];
    if (!pen) continue;
    spokes.push({ e, atA, ang: Math.atan2(pen.y - node.y, pen.x - node.x) });
  }
  spokes.sort((a, b) => a.ang - b.ang);

  // one ring node per spoke; near-parallel arrivals share one
  const ring = [];
  const spokeNode = [];
  for (const s of spokes) {
    const last = ring[ring.length - 1];
    if (last && s.ang - last.ang < 0.35) {
      spokeNode.push(last.node);
      continue;
    }
    const n = addRoadNode(state, node.x + R * Math.cos(s.ang), node.y + R * Math.sin(s.ang));
    ring.push({ ang: s.ang, node: n });
    spokeNode.push(n);
  }
  if (ring.length < 2) return null;

  for (let i = 0; i < spokes.length; i++) {
    const { e, atA } = spokes[i];
    const rn = spokeNode[i];
    if (atA) { e.a = rn.id; e.pts[0] = { x: rn.x, y: rn.y }; }
    else { e.b = rn.id; e.pts[e.pts.length - 1] = { x: rn.x, y: rn.y }; }
    rn.edges.push(e.id);
  }
  node.edges = [];

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b2 = ring[(i - 1 + ring.length) % ring.length];
    const e = addRoadEdge(state, a.node.id, b2.node.id, arcPts(node.x, node.y, R, a.ang, b2.ang));
    e.oneway = true;              // graph only routes a→b — no wrong-way rings
    e.roundabout = { x: node.x, y: node.y }; // island centre for rendering
  }

  // legs routed through the dead node recompute on their next retry
  const dead = `r${node.id}`;
  for (const a of state.agents.values()) {
    if (a.legs?.some((l) => l.nodes?.includes(dead))) {
      a.legs = null;
      a.retryT = 0;
    }
  }
  // a light on the consumed junction goes back to the player's stock
  if (node.light) {
    state.trafficLights = Math.min(CONFIG.trafficLights.cap, state.trafficLights + 1);
  }
  state.roadNodes.delete(node.id);
  state.netVersion++;
  return true;
}
