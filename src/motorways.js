import { CONFIG } from './config.js';
import { dist } from './state.js';
import { addRoadEdge } from './networks.js';
import { roadNodeForBuilding, nearestEdgePoint, nearEndpoint, splitEdgeMulti } from './roads.js';

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
