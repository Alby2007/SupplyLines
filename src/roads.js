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

// tiles a drawn cell path would consume — only cells not already road;
// water cells aren't tiles at all — they're paid in bridges instead
export function roadCellCost(state, cells) {
  const idx = roadCellIndex(state);
  const seen = new Set();
  let cost = 0;
  for (const c of cells) {
    const k = cellKey(c);
    if (seen.has(k) || idx.has(k) || state.water?.has(k)) continue;
    seen.add(k);
    cost++;
  }
  return cost;
}

// bridges a drawn cell path would consume — water cells with no road on them
// yet (MM: each water tile the road spans costs one bridge)
export function bridgeCost(state, cells) {
  if (!state.water?.size) return 0;
  const idx = roadCellIndex(state);
  const seen = new Set();
  let cost = 0;
  for (const c of cells) {
    const k = cellKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    if (state.water.has(k) && !idx.has(k)) cost++;
  }
  return cost;
}

// a split landing within snap of an edge endpoint should reuse that node —
// otherwise every draw over the same corridor cuts a ~1px sliver, and the
// slivers get re-split on the next draw: the road graph grows multiplicatively
// per build instead of per new junction
export function nearEndpoint(state, e, p) {
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
    if (e.bridge) ne.bridge = true;
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

  // junction cells are rail-only — they reject outright; water just costs
  // bridges (MM: roads bridge automatically when the stock covers the span)
  const jCells = new Set();
  for (const b of state.buildings.values()) {
    if (b.type === 'junction') jCells.add(cellKey(cellOf(b)));
  }
  if (cells.some((c) => jCells.has(cellKey(c)))) return [];
  const wet = bridgeCost(state, cells);
  if (wet > (state.bridges ?? 0)) return [];
  state.bridges -= wet;

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
  // edges that land on water cells are bridge decks — flagged so splits keep
  // them and the renderer can rail them
  if (state.water?.size) {
    for (const e of edges) {
      if (cellsAlongPolyline(e.pts).some((c) => state.water.has(cellKey(c)))) {
        e.bridge = true;
      }
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
  const wet = new Set(); // water cells bridge decks sat on — refunded as bridges
  for (const id of doomed) {
    const e = state.roadEdges.get(id);
    // ring cells refund nothing — the roundabout cost an item, not tiles
    if (e && !e.roundabout) {
      for (const c of cellsAlongPolyline(e.pts)) {
        const k = cellKey(c);
        (state.water?.has(k) ? wet : freed).add(k);
      }
    }
  }
  // a freed cell stays road if a surviving edge still covers it
  for (const e of state.roadEdges.values()) {
    if (doomed.has(e.id)) continue;
    for (const c of cellsAlongPolyline(e.pts)) {
      const k = cellKey(c);
      freed.delete(k);
      wet.delete(k);
    }
  }
  return { doomed, freed: freed.size, wet: wet.size };
}

// motorway edge ids a bulldozer drag touches — the whole span dies at once
function motorwaysUnder(state, cells) {
  const cellSet = new Set(cells.map(cellKey));
  const hit = new Set();
  for (const e of state.roadEdges.values()) {
    if (!e.motorway) continue;
    if (cellsAlongPolyline(e.pts).some((c) => cellSet.has(cellKey(c)))) hit.add(e.id);
  }
  return hit;
}

// tiles a bulldozer drag would return to the inventory
export function demolishRefund(state, cells) {
  return demolishTargets(state, cells).freed;
}

// remove every edge under the drawn path; orphan nodes are swept (building
// nodes stay so homes/works remain re-connectable). Returns freed tiles.
export function demolishRoad(state, cells) {
  const { doomed, freed, wet } = demolishTargets(state, cells);
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
  // demolished decks hand their bridges back (MM: bridge stock refunds too)
  if (wet && CONFIG.bridges) {
    state.bridges = Math.min(CONFIG.bridges.cap, state.bridges + wet);
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

