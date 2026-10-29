import { CONFIG } from './config.js';
import { dist } from './state.js';
import { addRoadNode, addRoadEdge } from './networks.js';
import { cellOf, cellKey, snapPosToCell } from './grid.js';
import { nearestEdgePoint, splitEdgeMulti } from './roads.js';

// ---- roundabouts (MM-style free-flow junction replacement) ----

// a stamped ring can't overlap water — check the 8 node cells + centre cell
function roundaboutBlockedByWater(state, x, y) {
  if (!state.water?.size) return false;
  const R = CONFIG.roundabouts.radius;
  if (state.water.has(cellKey(cellOf({ x, y })))) return true;
  for (let i = 0; i < 8; i++) {
    const t = (i / 8) * Math.PI * 2;
    if (state.water.has(cellKey(cellOf({ x: x + R * Math.cos(t), y: y + R * Math.sin(t) })))) return true;
  }
  return false;
}

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
    if (roundaboutBlockedByWater(state, node.x, node.y)) return null;
    return buildRoundabout(state, node);
  }
  const c = snapPosToCell(p); // rings centre on the grid, like MM
  if (roundaboutBlockedByWater(state, c.x, c.y)) return null;
  return stampRing(state, c.x, c.y);
}

// ghost preview under the cursor — where the ring would land and whether the
// drop is legal ({x, y, ok})
export function roundaboutGhost(state, p) {
  if (roundaboutBlockedByBuilding(state, p)) return { x: p.x, y: p.y, ok: false };
  const R = CONFIG.roundabouts.radius;
  const ne = nearestEdgePoint(state, p, R);
  if (ne) return { x: ne.x, y: ne.y, ok: !ne.edge.roundabout && !roundaboutBlockedByWater(state, ne.x, ne.y) };
  const c = snapPosToCell(p);
  return { x: c.x, y: c.y, ok: !roundaboutBlockedByWater(state, c.x, c.y) };
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
