import { CONFIG } from './config.js';
import { dist } from './state.js';
import { lineSegLen } from './networks.js';

// Unified multimodal graph: buildings are b-nodes, road intersections are r-nodes.
// Edges carry {mode:'line'|'road', lineId} so legs compress into rides/drives.
const bkey = (bid) => `b${bid}`;
const rkey = (rid) => `r${rid}`;
export const roadNodeKey = (n) => (n.bid != null ? bkey(n.bid) : rkey(n.id));

export function nodePos(state, key) {
  if (key[0] === 'b') {
    const b = state.buildings.get(Number(key.slice(1)));
    return b ? { x: b.x, y: b.y } : null;
  }
  const n = state.roadNodes.get(Number(key.slice(1)));
  return n ? { x: n.x, y: n.y } : null;
}

// 1.0 = free flow → approaches CONFIG.roads.congestFactor when full
export function congestFactor(state, e) {
  const cap = CONFIG.roads.maxPerEdge + (state.roadCapBonus || 0);
  const over = Math.max(0, e.vehicles.size - CONFIG.roads.congestAt);
  const frac = Math.min(1, over / Math.max(1, cap - CONFIG.roads.congestAt));
  return 1 - frac * (1 - CONFIG.roads.congestFactor);
}

export function edgeLength(e) {
  let len = 0;
  for (let i = 1; i < e.pts.length; i++) len += dist(e.pts[i - 1], e.pts[i]);
  return len;
}

export function buildGraph(state, modes = null) {
  const use = modes ?? { line: true, road: true };
  const nodes = new Map();
  const adj = new Map();
  const ensure = (k) => { if (!adj.has(k)) adj.set(k, []); };

  for (const b of state.buildings.values()) {
    nodes.set(bkey(b.id), { x: b.x, y: b.y, bid: b.id });
    ensure(bkey(b.id));
  }
  for (const n of state.roadNodes.values()) {
    nodes.set(roadNodeKey(n), { x: n.x, y: n.y, bid: n.bid });
    ensure(roadNodeKey(n));
  }

  if (use.line)
  for (const line of state.lines.values()) {
    const n = line.stops.length;
    const segs = line.loop ? n : n - 1;
    // expected wait to board ≈ half the headway: round-trip time ÷ trains ÷ 2.
    // A sparse line is slow to board, so direct drives beat it; adding trains
    // (or congestion slowing cars) is what makes rail worthwhile.
    let lineLen = 0;
    for (let i = 0; i < segs; i++) lineLen += lineSegLen(state, line.stops[i], line.stops[(i + 1) % n]);
    const cycle = (line.loop ? lineLen : 2 * lineLen) / CONFIG.trains.speed +
      (line.loop ? n : 2 * n) * CONFIG.trains.dwell;
    const wait = Math.max(
      CONFIG.costs.boardWait,
      cycle / Math.max(1, line.trains.length) / 2,
    );
    for (let i = 0; i < segs; i++) {
      const a = line.stops[i];
      const b = line.stops[(i + 1) % n];
      const ba = state.buildings.get(a);
      const bb = state.buildings.get(b);
      if (!ba || !bb) continue;
      const cost = lineSegLen(state, a, b) / CONFIG.trains.speed + CONFIG.costs.stopPenalty;
      adj.get(bkey(a)).push({ to: bkey(b), cost, mode: 'line', lineId: line.id, lineColor: line.color, wait, freight: !!line.freight });
      adj.get(bkey(b)).push({ to: bkey(a), cost, mode: 'line', lineId: line.id, lineColor: line.color, wait, freight: !!line.freight });
    }
  }

  if (use.road)
  for (const e of state.roadEdges.values()) {
    const na = state.roadNodes.get(e.a);
    const nb = state.roadNodes.get(e.b);
    if (!na || !nb) continue;
    // motorways are the express option — same congestion model, faster cruise
    const spd = CONFIG.roads.carSpeed * (e.motorway ? CONFIG.motorways.speedFactor : 1);
    const cost = edgeLength(e) / Math.max(10, spd * congestFactor(state, e));
    const ka = roadNodeKey(na);
    const kb = roadNodeKey(nb);
    adj.get(ka).push({ to: kb, cost, mode: 'road', edgeId: e.id });
    // one-way edges (roundabout rings) only route in their built direction
    if (!e.oneway) adj.get(kb).push({ to: ka, cost, mode: 'road', edgeId: e.id });
  }

  return { nodes, adj };
}

// graphs are rebuilt constantly by retries/dispatches — cache per modes slot,
// keyed on netVersion (topology must match exactly: legs reference edge ids)
// plus a sim-time epoch so congestion costs refresh without every-call builds
function graphFor(state, modes) {
  const g = (state._graphs ??= { key: '', slots: {} });
  const key = `${state.netVersion}:${Math.floor(state.time / 0.8)}`;
  if (g.key !== key) { g.key = key; g.slots = {}; }
  const mk = modes == null || (modes.line && modes.road) ? 'a' : modes.line ? 'l' : 'r';
  return (g.slots[mk] ??= buildGraph(state, modes));
}

// Dijkstra over (node, incoming-transport) states so transfers get penalized once.
// dest: building-type string or predicate(building)→bool. opts: {modes:{line,road}}
// Returns legs: [{mode, lineId, from, to, fromNode, toNode, nodes[], edgeIds[]}] or null.
export function findPath(state, fromBid, dest, opts = {}) {
  const match = typeof dest === 'function' ? dest : (b) => b.type === dest;
  const { nodes, adj } = graphFor(state, opts.modes);
  const start = bkey(fromBid);
  if (!nodes.has(start)) return null;

  const skey = (n, m) => `${n}~${m}`;
  const distM = new Map([[skey(start, ''), 0]]);
  const prev = new Map();
  const visited = new Set();
  const pq = [{ d: 0, n: start, m: '' }];
  let goal = null;

  while (pq.length) {
    let bi = 0;
    for (let i = 1; i < pq.length; i++) if (pq[i].d < pq[bi].d) bi = i;
    const cur = pq.splice(bi, 1)[0];
    const sk = skey(cur.n, cur.m);
    if (visited.has(sk)) continue;
    visited.add(sk);

    if (cur.n !== start) {
      const node = nodes.get(cur.n);
      if (node?.bid != null) {
        const b = state.buildings.get(node.bid);
        if (b && b.active && match(b)) { goal = sk; break; }
      }
    }

    for (const e of adj.get(cur.n) ?? []) {
      if (e.mode === 'line') {
        // colour-locked lines: people only board their colour, never freight
        if (opts.lineColor != null && (e.freight || e.lineColor !== opts.lineColor)) continue;
        // crates only ride freight lines — passenger trains won't take them
        if (opts.freight && !e.freight) continue;
      }
      const em = e.mode === 'line' ? `l${e.lineId}` : 'r';
      // boarding a line costs its expected wait (once, on entry, incl. the
      // first leg); switching transport mid-trip adds a transfer penalty
      const pen = cur.m !== em
        ? (e.mode === 'line' ? e.wait ?? CONFIG.costs.boardWait : 0) +
          (cur.m !== '' ? CONFIG.costs.transferPenalty : 0)
        : 0;
      const nd = cur.d + e.cost + pen;
      const nk = skey(e.to, em);
      if (nd < (distM.get(nk) ?? Infinity)) {
        distM.set(nk, nd);
        prev.set(nk, { pk: sk, edge: { ...e, from: cur.n } });
        pq.push({ d: nd, n: e.to, m: em });
      }
    }
  }

  if (!goal) return null;

  const edges = [];
  let k = goal;
  while (prev.has(k)) {
    const p = prev.get(k);
    edges.unshift(p.edge);
    k = p.pk;
  }

  const legs = [];
  for (const e of edges) {
    const last = legs[legs.length - 1];
    const merge =
      last &&
      last.mode === e.mode &&
      (e.mode === 'road' || last.lineId === e.lineId);
    if (merge) {
      last.nodes.push(e.to);
      last.toNode = e.to;
      last.to = nodes.get(e.to).bid ?? last.to;
      if (e.edgeId != null) last.edgeIds.push(e.edgeId);
    } else {
      legs.push({
        mode: e.mode,
        lineId: e.lineId ?? null,
        from: nodes.get(e.from).bid ?? null,
        to: nodes.get(e.to).bid ?? null,
        fromNode: e.from,
        toNode: e.to,
        nodes: [e.from, e.to],
        edgeIds: e.edgeId != null ? [e.edgeId] : [],
      });
    }
  }
  return legs;
}

// path to one specific building
export function findPathTo(state, fromBid, toBid, opts = {}) {
  return findPath(state, fromBid, (b) => b.id === toBid, opts);
}

// multi-source Dijkstra over the road graph only: for every node, the distance
// to and id of its nearest source building. Used for home→market assignment.
export function roadDistancesFrom(state, sourceBids) {
  const { adj } = graphFor(state, { line: false, road: true });
  const distM = new Map();
  const src = new Map();
  const pq = [];
  for (const bid of sourceBids) {
    const k = bkey(bid);
    distM.set(k, 0);
    src.set(k, bid);
    pq.push({ d: 0, n: k });
  }
  while (pq.length) {
    let bi = 0;
    for (let i = 1; i < pq.length; i++) if (pq[i].d < pq[bi].d) bi = i;
    const cur = pq.splice(bi, 1)[0];
    if (cur.d > distM.get(cur.n)) continue;
    for (const e of adj.get(cur.n) ?? []) {
      const nd = cur.d + e.cost;
      if (nd < (distM.get(e.to) ?? Infinity)) {
        distM.set(e.to, nd);
        src.set(e.to, src.get(cur.n));
        pq.push({ d: nd, n: e.to });
      }
    }
  }
  return { dist: distM, src };
}
