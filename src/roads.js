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

// nearest existing edge to a point: {edge, t, x, y, d} or null
export function nearestEdgePoint(state, p) {
  let best = null;
  for (const e of state.roadEdges.values()) {
    const np = nearestOnPolyline(e.pts, p);
    if (!best || np.d < best.d) best = { edge: e, ...np };
  }
  return best;
}

// Map cellKey → [{edgeId}] covering every edge's cells; rebuilt when the
// network changes so shared-cell joins are O(1) per drawn cell.
export function roadCellIndex(state) {
  if (state._cellIdx && state._cellIdxV === state.netVersion) return state._cellIdx;
  const idx = new Map();
  for (const e of state.roadEdges.values()) {
    for (const c of cellsAlongPolyline(e.pts)) {
      const k = cellKey(c);
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k).push({ edgeId: e.id });
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
  if (ne && ne.d <= CONFIG.roads.snap && ne.t > 0.01 && ne.t < 0.99) {
    return state.roadNodes.get(splitEdgeMulti(state, ne.edge, [ne.t]).nodeIds[1]);
  }
  if (ne && ne.d <= CONFIG.roads.snap) {
    // near an endpoint — reuse it rather than splitting a stub
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
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].length >= 2 && nodeIds[i] !== nodeIds[i + 1]) {
      newEdges.push(addRoadEdge(state, nodeIds[i], nodeIds[i + 1], chunks[i]));
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
    const ts = [];
    for (const x of arr) {
      if (!ts.length || Math.abs(ts[ts.length - 1] - x.tEdge) > 0.001) ts.push(x.tEdge);
    }
    const { nodeIds } = splitEdgeMulti(state, e, ts);
    for (const x of arr) {
      const ni = ts.findIndex((t) => Math.abs(t - x.tEdge) <= 0.001);
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
  const freed = new Set();
  for (const id of doomed) {
    const e = state.roadEdges.get(id);
    if (e) for (const c of cellsAlongPolyline(e.pts)) freed.add(cellKey(c));
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
  for (const n of [...state.roadNodes.values()]) {
    if (n.bid == null && n.edges.length === 0) state.roadNodes.delete(n.id);
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
