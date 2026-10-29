import { CONFIG } from './config.js';
import { dist } from './state.js';

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
