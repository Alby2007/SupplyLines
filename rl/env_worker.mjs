// Headless RL env worker — JSON-lines in, binary frames out, over stdio.
//   node rl/env_worker.mjs --level=1
// in : {"cmd":"reset","seed":1,"warm":120}  // warm = max seconds of bot pre-play
//      {"cmd":"step","a":3}
//      {"cmd":"close"}
// out: one JSON line {"ready":true,...} at startup, then per reset/step a
//      binary frame (see frame()): 5×u32 LE lengths [meta,bin,con,glob,feats]
//      + payloads. meta = JSON {"reward":r,"done":bool,"info":{..}} (or
//      {"error":..}); bin = bitpacked binary channels, con = f16 continuous
//      channels, glob = f32, feats = f16 action features.
// (desc:[..] in meta only when RLDESC=1; RLTIME=1 prints phase timings to stderr)
//
// The agent acts at DECISION cadence (0.5s sim): each step applies one action
// then advances the sim to the next decision/upgrade/game-over. Actions are
// enumerated per decision point (masked by construction) and carry feature
// vectors — the policy scores them instead of learning positional ids.

import { CONFIG, applyLevelOverrides } from '../src/config.js';
import { createState, applyLevelFeatures } from '../src/state.js';
import { UPGRADES } from '../src/ui.js';
import { buildRoad, roadCellCost, roadCellIndex, bridgeCost, demolishRoad } from '../src/roads.js';
import { placeRoundabout } from '../src/roundabouts.js';
import { placeTrafficLight } from '../src/lights.js';
import { buildMotorway } from '../src/motorways.js';
import { cellOf, cellKey, cellsBetween, buildingCells, cellsAlongPolyline, cellCenter, nearestOnPolyline } from '../src/grid.js';
import {
  linePts, extendLine, lineSegCellIndex, lineSegPts, junctionPlacement,
  junctionCanJoin, addJunction, insertJunction, linesThrough, deleteLine,
  removeJunction, removeRoadEdge,
} from '../src/networks.js';
import { roadDistancesFrom } from '../src/routing.js';
import { addBusLine, carPos } from '../src/vehicles.js';
import { rushStatus } from '../src/economy.js';
import * as readline from 'node:readline';
import {
  srand, tick, served, blockedCells, mainComponentCells, pathToRoad,
  onLine, reachable, junctionPressure, newLine, cachedPlan,
  decide, pickUpgrade,
} from '../autoplay.mjs';

const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split('=')[1] : d;
};
const LEVEL = +arg('level', 1);
applyLevelOverrides(LEVEL); // autoplay applies its own too — same level, harmless

// ---- dims -----------------------------------------------------------------
const STEP = 1 / 60;
const DECIDE_DT = 0.5;          // sim-seconds per decision
const MAX_SECONDS = 15 * 60;    // episode cap (truncation, not death)
const COLS = Math.floor(CONFIG.map.width / CONFIG.grid.cell);
const ROWS = Math.floor(CONFIG.map.height / CONFIG.grid.cell);
// obs padded to a fixed canvas so VecEnv can batch mixed levels — Map 1's
// 40-wide grid lands in the left half and the level one-hot in globals tells
// the policy which map it's on
const OBSCOLS = Math.max(COLS, 80), OBSROWS = Math.max(ROWS, 32);
const CH = 25, GD = 30, AFD = 40, MAXA = 80;

// ---- action enumeration ---------------------------------------------------

// type one-hots live at their slot index; 33/34 land in the tail that
// upgrades (22..32) leave free, so checkpoints trained before demolition and
// junctions existed still read every old action identically
const TYPE_IDX = { noop: 0, connect: 1, roadlink: 2, line: 3, motorway: 4, roundabout: 5, light: 6, upgrade: 7, demolish: 33, junction: 34 };

function meterOf(b) {
  if (b.type === 'work') return Math.max(0, b.demandT / CONFIG.demand.limit);
  if (b.type === 'home') return Math.max(0, b.hungerT / CONFIG.food.hungerLimit);
  return Math.max(0, b.overflowT / CONFIG.overflowLimit);
}

function feat(o = {}) {
  const f = new Array(AFD).fill(0);
  f[TYPE_IDX[o.type] ?? 0] = 1;
  if (o.color != null && o.color >= 0 && o.color < 6) f[8 + o.color] = 1;
  f[14] = o.costFrac ?? 0;
  f[15] = Math.min(1.5, o.meter ?? 0);
  f[16] = Math.min(1, o.wait ?? 0);
  f[17] = Math.min(1, (o.dist ?? 0) / 2000);
  f[18] = Math.min(1, (o.stops ?? 0) / 8);
  f[19] = o.freight ? 1 : 0;
  f[20] = o.rescue ? 1 : 0;
  f[21] = Math.min(1, o.bridgeFrac ?? 0); // fraction of a ~12-bridge crossing
  if (o.upgradeIdx != null) f[22 + o.upgradeIdx] = 1;
  // 33/34 are the new-type slots from TYPE_IDX; remaining free tail:
  f[35] = o.alt ? 1 : 0;               // variant action (alt route, via-junction)
  if (o.demo != null) f[36 + o.demo] = 1; // demolish target: 0 line, 1 road, 2 span, 3 junction
  if (o.bus) f[39] = 1; // subtype slot — under type=line it marks a bus route
  return f;
}

// tryConnect's routing, read-only: straight chord when the map is empty,
// cell-Dijkstra onto the main road component otherwise.
function connectPlan(state, b, roadIdx, blocked, goal) {
  const own = buildingCells(b);
  if (!roadIdx.size) {
    let other = null, od = Infinity;
    for (const o of state.buildings.values()) {
      if (o === b || o.type === 'junction') continue;
      const d = Math.hypot(o.x - b.x, o.y - b.y);
      if (d < od) { od = d; other = o; }
    }
    if (!other) return null;
    let cells = cellsBetween(cellOf(b), cellOf(other));
    if (cells.some((c) => blocked.has(cellKey(c)) || state.water?.has(cellKey(c)))) {
      const g = new Map(buildingCells(other).map((c) => [cellKey(c), []]));
      cells = pathToRoad(state, own, g, blocked) ?? cells;
    }
    return cells;
  }
  // connect plans memo on (netVersion, bridges) — a cached path may be
  // suboptimal after edits but never invalid (buildRoad merges shared cells)
  return cachedPlan(state, `connect:${b.id}`, () =>
    pathToRoad(state, own, roadIdx, blocked, goal));
}

// straight cellsBetween with a blocked-detour fallback (for roadlink pairs)
function planPairCells(state, fromB, toB, blocked) {
  let cells = cellsBetween(cellOf(fromB), cellOf(toB));
  if (cells.some((c) => blocked.has(cellKey(c)) || state.water?.has(cellKey(c)))) {
    const g = new Map(buildingCells(toB).map((c) => [cellKey(c), []]));
    const alt = cachedPlan(state, `pair:${fromB.id}>${toB.id}`, () =>
      pathToRoad(state, buildingCells(fromB), g, blocked));
    if (alt) cells = alt;
  }
  return cells;
}

const samePath = (a, b) =>
  a.length === b.length && a.every((c, i) => c.cx === b[i].cx && c.cy === b[i].cy);

// cellKey → worst surface-edge density covering it — the alt-route planner
// pays to cross jammed cells, so relief corridors detour the saturated core
function congestionCellMap(state) {
  const cap = CONFIG.roads.maxPerEdge + (state.roadCapBonus || 0);
  const m = new Map();
  for (const e of state.roadEdges.values()) {
    if (e.motorway) continue;
    const d = Math.min(1, e.vehicles.size / Math.max(1, cap));
    if (d <= 0.01) continue;
    for (const c of cellsAlongPolyline(e.pts)) {
      const k = cellKey(c);
      if (d > (m.get(k) ?? 0)) m.set(k, d);
    }
  }
  return m;
}

// riders on a line's trains plus people queued at its stops — the load proxy
// demolition and interchange candidates are scored against
function lineLoad(state, l) {
  let s = 0;
  for (const vid of l.trains) s += state.vehicles.get(vid)?.pax.length ?? 0;
  for (const sid of l.stops) s += state.buildings.get(sid)?.waiting.length ?? 0;
  return s;
}

// deliberate interchanges: two joinable lines whose tracks share a cell can
// splice one junction into both — same-colour riders transfer (colour-locked
// lines never mix, so different-colour pairs are worthless) and freight
// lines can swap crates across a shared junction
function junctionCandidates(state) {
  const out = [];
  const seenPairs = new Set();
  const segPts = (e) =>
    lineSegPts(state, e.line.stops[e.segIdx], e.line.stops[(e.segIdx + 1) % e.line.stops.length]);
  for (const [k, refs] of lineSegCellIndex(state)) {
    if (out.length >= 4) break;
    const byLine = new Map();
    for (const r of refs) if (!byLine.has(r.line.id)) byLine.set(r.line.id, r);
    if (byLine.size < 2) continue;
    const entries = [...byLine.values()];
    const [cx, cy] = k.split(',').map(Number);
    for (let i = 0; i < entries.length && out.length < 4; i++) {
      for (let j = i + 1; j < entries.length && out.length < 4; j++) {
        const A = entries[i], B = entries[j];
        const passengers = !A.line.freight && !B.line.freight && A.line.color === B.line.color;
        const freights = A.line.freight && B.line.freight;
        if (!passengers && !freights) continue;
        const pk = A.line.id < B.line.id
          ? `${A.line.id}>${B.line.id}` : `${B.line.id}>${A.line.id}`;
        if (seenPairs.has(pk)) continue;
        const spot = junctionPlacement(state, cellCenter(cx, cy));
        if (!spot) continue; // building/road/water claims the cell
        if (![A, B].every((e) => {
          const pts = segPts(e);
          return pts && nearestOnPolyline(pts, spot).d <= CONFIG.grid.cell * 0.75;
        })) continue;
        seenPairs.add(pk);
        out.push({ A, B, x: spot.x, y: spot.y, freight: freights,
          load: lineLoad(state, A.line) + lineLoad(state, B.line) });
      }
    }
  }
  return out;
}

// maxLines budgets rail only — bus routes run under CONFIG.bus.max
const railCount = (state) => [...state.lines.values()].filter((l) => !l.bus).length;
const busCount = (state) => [...state.lines.values()].filter((l) => l.bus).length;

function lineCandidates(state) {
  const out = [];
  const onL = (bid) => onLine(state, bid).length > 0;
  const freightStops = new Set();
  for (const l of state.lines.values()) if (l.freight) for (const s of l.stops) freightStops.add(s);
  const farms = [...state.buildings.values()].filter((b) => b.type === 'farm' && b.active);
  const mkts = [...state.buildings.values()].filter((b) => b.type === 'market' && b.active);
  // extend an existing line to a valuable uncovered stop — the action space
  // shouldn't only imagine building new networks from scratch
  const foodStops = new Set();
  for (const l of state.lines.values()) {
    if (l.freight) for (const s of l.stops) foodStops.add(s);
  }
  for (const l of [...state.lines.values()].filter((x) => !x.loop).slice(0, 3)) {
    if (l.freight) {
      const t = mkts.find((m) => !foodStops.has(m.id))
        ?? farms.find((f) => f.active && !foodStops.has(f.id));
      if (t) out.push({ stops: [...l.stops, t.id], ext: { line: l, stop: t.id },
        why: `extend freight → #${t.id}`, freight: true });
    } else {
      let tw = null;
      for (const w of state.buildings.values()) {
        if (w.type !== 'work' || !w.active || onL(w.id)) continue;
        if (l.color != null && w.color !== l.color) continue;
        if (l.bus && w.roadNodeId == null) continue; // bus stops need frontage
        if ((w.demandT ?? 0) > (tw?.demandT ?? 20)) tw = w;
      }
      if (tw) out.push({ stops: [...l.stops, tw.id], ext: { line: l, stop: tw.id },
        why: `extend → work#${tw.id}`, color: l.color ?? undefined });
    }
  }
  // close-the-loop: a 3+ stop line can circuit back to its first stop —
  // trains circulate instead of deadheading, a whole topology class for free
  for (const l of [...state.lines.values()]
      .filter((x) => !x.loop && x.stops.length >= 3).slice(0, 2)) {
    out.push({ stops: [...l.stops, l.stops[0]], ext: { line: l, stop: l.stops[0] },
      why: 'close loop', color: l.color ?? undefined });
  }
  // new lines need a free slot; extensions above stay legal at maxLines
  if (railCount(state) >= state.maxLines) return out;
  for (const f of farms.slice(0, 2)) {
    if (!freightStops.has(f.id) && mkts.length) {
      const ms = mkts.slice().sort((a, b2) =>
        Math.hypot(a.x - f.x, a.y - f.y) - Math.hypot(b2.x - f.x, b2.y - f.y));
      out.push({ stops: [f.id, ...ms.map((m) => m.id)], why: 'freight-all', freight: true });
      out.push({ stops: [f.id, ms[0].id], why: 'freight-nearest', freight: true });
    } else {
      for (const m of mkts) if (!freightStops.has(m.id))
        out.push({ stops: [f.id, m.id], why: 'freight-hop', freight: true });
    }
  }
  for (const b of state.buildings.values()) {
    if (!b.active || b.type === 'junction' || !b.waiting.length || onL(b.id)) continue;
    const a = state.agents.get(b.waiting[0]);
    if (!a || a.kind !== 'person' || a.color == null) continue;
    if (reachable(state, a, b.id)) continue;
    const dests = (Array.isArray(a.dest) ? a.dest : [a.dest])
      .flatMap((m) => [...state.buildings.values()].filter(m));
    let dBest = null, dd = Infinity;
    for (const d of dests) {
      if (d.id === b.id) continue;
      const t = Math.hypot(d.x - b.x, d.y - b.y);
      if (t < dd) { dd = t; dBest = d; }
    }
    if (dBest) out.push({ stops: [b.id, dBest.id], why: 'rescue', rescue: true, color: a.color });
  }
  const pairs = [];
  const foodEra = farms.some((f) => f.active);
  for (const h of state.buildings.values()) {
    if (h.type !== 'home' || !h.active || h.color == null || onL(h.id)) continue;
    for (const w of state.buildings.values()) {
      if (!w.active || onL(w.id)) continue;
      // commuters ride to offices AND to the food buildings they staff —
      // both corridor shapes are worth offering
      const commuter = w.type === 'work' || (foodEra && (w.type === 'market' || w.type === 'farm'));
      if (!commuter || (w.color != null && w.color !== h.color)) continue;
      const d = Math.hypot(w.x - h.x, w.y - h.y);
      if (d > 180) pairs.push({ h, w, d });
    }
  }
  pairs.sort((a, b) => b.d - a.d);
  for (const p of pairs.slice(0, 6))
    out.push({ stops: [p.h.id, p.w.id], why: 'corridor', color: p.h.color, dist: p.d });
  // via-junction variants: a corridor chord that brushes an existing junction
  // can stop through it — transfers where colours match, and the new line
  // awards every other line through it a free train either way
  const jns = [...state.buildings.values()].filter(
    (b) => b.type === 'junction' && junctionCanJoin(state, b.id));
  if (jns.length) {
    let via = 0;
    for (const p of pairs.slice(0, 6)) {
      if (via >= 3) break;
      const chord = lineSegPts(state, p.h.id, p.w.id);
      if (!chord) continue;
      const hits = jns
        .map((j) => ({ j, np: nearestOnPolyline(chord, j) }))
        .filter((x) => x.np.d <= CONFIG.junctions.snap && x.np.t > 0.08 && x.np.t < 0.92)
        .sort((a, b) => a.np.t - b.np.t)
        .slice(0, 2);
      if (!hits.length) continue;
      via++;
      out.push({ stops: [p.h.id, ...hits.map((x) => x.j.id), p.w.id],
        why: 'via-junction', color: p.h.color, dist: p.d, alt: true });
    }
  }
  const seen = new Set();
  return out.filter((o) => {
    const k = o.stops.join(',');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 14);
}

// materialize the weekly 1-of-2 offer exactly the way the game/bot does
function makeOffers(state) {
  const pool = UPGRADES.filter((u) => u.ok(state));
  const offers = [];
  while (offers.length < 2 && pool.length)
    offers.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  if (!offers.length) { state.upgradePending = false; return null; }
  return offers;
}

const noopLog = () => {};

function enumerate(state) {
  const acts = [];
  const push = (o, apply, desc) =>
    acts.length < MAXA && acts.push({ feat: feat(o), apply, desc, type: o.type });

  if (state.upgradePending) {
    const offers = state._offers ?? makeOffers(state);
    if (!offers) return acts;
    state._offers = offers;
    offers.forEach((u) => push(
      { type: 'upgrade', upgradeIdx: UPGRADES.indexOf(u) },
      () => { u.apply(state); state.upgradePending = false; state._offers = null; return 0.05; },
      `upgrade:${u.name}`));
    return acts;
  }

  const roadIdx = roadCellIndex(state);
  const beforeConnects = acts.length; // noop masked whenever connects exist

  const blocked = blockedCells(state);
  const goal = roadIdx.size ? mainComponentCells(state, roadIdx) : null;

  // connect each unserved building (road drawn by the shared pathing) —
  // capped so a sprawled city can't crowd every other action type off MAXA
  const connCands = [];
  for (const b of state.buildings.values()) {
    if (b.type === 'junction') continue;
    const own = buildingCells(b);
    if (own.some((c) => roadIdx.has(cellKey(c)))) continue;
    const cells = connectPlan(state, b, roadIdx, blocked, goal);
    if (!cells || cells.length < 2) continue;
    const cost = roadCellCost(state, cells);
    if (cost > state.roadTiles) continue;
    const wet = bridgeCost(state, cells);
    if (wet > (state.bridges ?? 0)) continue; // crossing the policy can't pay for
    connCands.push({ b, cells, cost, wet, meter: meterOf(b) });
  }
  connCands.sort((x, y) => y.meter - x.meter || x.cost - y.cost);
  for (const c of connCands.slice(0, 24)) {
    const b = c.b;
    push(
      { type: 'connect', color: b.color, costFrac: c.cost / Math.max(1, state.roadTiles),
        bridgeFrac: c.wet / 12,
        meter: c.meter, wait: b.waiting.length / b.capacity, dist: c.cells.length * CONFIG.grid.cell },
      () => { if (buildRoad(state, c.cells).length) { state.roadTiles -= c.cost; return 0.15; } return 0; },
      `connect ${b.type}#${b.id}${b.active ? '' : ' (pending)'}`);
  }
  const nConnects = acts.length - beforeConnects;

  // alt routes for the hottest connects: a second draw that pays fresh tiles
  // to skirt congested cells and stints on bridges — the policy chooses *how*
  // to reach the building, not just whether. Only materializes under
  // congestion; an idle map makes the weighted Dijkstra return the same path.
  let densCell = null;
  for (const c of connCands.slice(0, 8)) {
    if (!roadIdx.size) break;
    densCell ??= congestionCellMap(state);
    if (!densCell.size) break;
    const alt = cachedPlan(state, `connectAlt:${c.b.id}`, () =>
      pathToRoad(state, buildingCells(c.b), roadIdx, blocked, goal, {
        wetCost: 12,
        penalty: (k) => (densCell.get(k) ?? 0) * 6,
      }));
    if (!alt || alt.length < 2 || samePath(alt, c.cells)) continue;
    const cost = roadCellCost(state, alt);
    const wet = bridgeCost(state, alt);
    if (cost > state.roadTiles || wet > (state.bridges ?? 0)) continue;
    const cells = alt;
    push(
      { type: 'connect', color: c.b.color, costFrac: cost / Math.max(1, state.roadTiles),
        bridgeFrac: wet / 12,
        meter: c.meter, wait: c.b.waiting.length / c.b.capacity,
        dist: cells.length * CONFIG.grid.cell, alt: true },
      () => { if (buildRoad(state, cells).length) { state.roadTiles -= cost; return 0.15; } return 0; },
      `connect(alt) ${c.b.type}#${c.b.id}${c.b.active ? '' : ' (pending)'}`);
  }

  for (const c of lineCandidates(state)) {
    const meters = c.stops.map((id) => meterOf(state.buildings.get(id)));
    push(
      { type: 'line', color: c.color, stops: c.stops.length, dist: c.dist,
        freight: c.freight, rescue: c.rescue, meter: Math.max(...meters), alt: c.alt },
      () => {
        if (c.ext) { extendLine(state, c.ext.line, [c.ext.stop], false); return 0.12; }
        newLine(state, c.stops, noopLog, c.why); return 0.15;
      },
      `line ${c.why}: ${c.stops.join('→')}`);
  }

  // deliberate interchanges: splice a junction into two lines whose tracks
  // cross — the transfer topology newLine only finds by accident
  for (const c of junctionCandidates(state)) {
    push(
      { type: 'junction', color: c.freight ? undefined : c.A.line.color,
        freight: c.freight, wait: Math.min(1, c.load / 30) },
      () => {
        if (!state.lines.has(c.A.line.id) || !state.lines.has(c.B.line.id)) return 0;
        const j = addJunction(state, c.x, c.y, c.A.line.color ?? c.B.line.color);
        insertJunction(state, j, c.A.line, c.A.segIdx);
        insertJunction(state, j, c.B.line, c.B.segIdx);
        return 0.1;
      },
      `junction lines ${c.A.line.id}×${c.B.line.id}`);
  }

  // bus routes: free transit over existing roads — the modal-choice action.
  // Offered alongside rail when slots exist (the policy picks its tradeoff)
  // and left standing alone when rail is full. Stops need frontage both ends.
  if (state.week >= CONFIG.bus.firstWeek && busCount(state) < CONFIG.bus.max) {
    const foodEra = [...state.buildings.values()].some((f) => f.type === 'farm' && f.active);
    const bpairs = [];
    for (const h of state.buildings.values()) {
      if (h.type !== 'home' || !h.active || h.color == null) continue;
      if (h.roadNodeId == null || onLine(state, h.id).length) continue;
      for (const w of state.buildings.values()) {
        if (!w.active || onLine(state, w.id).length || w.roadNodeId == null) continue;
        const commuter = w.type === 'work' || (foodEra && (w.type === 'market' || w.type === 'farm'));
        if (!commuter || (w.color != null && w.color !== h.color)) continue;
        const d = Math.hypot(w.x - h.x, w.y - h.y);
        if (d > 140) bpairs.push({ h, w, d });
      }
    }
    bpairs.sort((a, b) => b.d - a.d);
    const seenBus = new Set();
    for (const p of bpairs.slice(0, 4)) {
      if (!seenBus.add(`${p.h.id}>${p.w.id}`)) continue;
      push(
        { type: 'line', bus: true, color: p.h.color, stops: 2, dist: p.d,
          meter: meterOf(p.w) },
        () => { const l = addBusLine(state, [p.h.id, p.w.id]); return l ? 0.12 : 0; },
        `bus ${p.h.id}→${p.w.id} (${Math.round(p.d)}px road-borne)`);
    }
  }

  // demolition: harvest dead spurs, cut jammed links, reclaim idle spans,
  // drop underused lines, sweep useless junctions — restructuring needs regret
  {
    const capN = CONFIG.roads.maxPerEdge + (state.roadCapBonus || 0);
    const densOf = (e) => Math.min(1, e.vehicles.size / Math.max(1, capN));
    const cellsOf = (e) => cellsAlongPolyline(e.pts);
    const nCells = (e) => new Set(cellsOf(e).map(cellKey)).size;
    // demolishRoad dooms every edge covering the dragged cells, so only offer
    // surgical candidates whose cells no surviving edge shares
    const exclusive = (e) => cellsOf(e).every(
      (c) => !(roadIdx.get(cellKey(c)) ?? []).some((r) => r.edgeId !== e.id));
    // ... and whose cells no motorway span flies over (a touch kills it too)
    const spanOverlap = (e) => {
      const set = new Set(cellsOf(e).map(cellKey));
      return [...state.roadEdges.values()].some(
        (o) => o.motorway && cellsAlongPolyline(o.pts).some((c) => set.has(cellKey(c))));
    };
    // a↔b connected without the edge → nothing downstream disconnects either
    const stillLinked = (e) => {
      const seen = new Set([e.a]);
      const stack = [e.a];
      while (stack.length) {
        const nid = stack.pop();
        for (const eid of state.roadNodes.get(nid)?.edges ?? []) {
          if (eid === e.id) continue;
          const o = state.roadEdges.get(eid);
          if (!o) continue;
          const nx = o.a === nid ? o.b : o.a;
          if (nx === e.b) return true;
          if (!seen.has(nx)) { seen.add(nx); stack.push(nx); }
        }
      }
      return false;
    };
    const demolishEdge = (e) => () => {
      const cur = state.roadEdges.get(e.id);
      if (!cur || cur.motorway) return 0;
      const freed = demolishRoad(state, cellsAlongPolyline(cur.pts));
      state.roadTiles = Math.min(CONFIG.roads.tilesCap, state.roadTiles + freed);
      return 0.05;
    };
    const wetCells = (e) =>
      state.water ? cellsOf(e).filter((c) => state.water.has(cellKey(c))).length : 0;

    // dead-end spurs: a degree-1 building-free endpoint means removal can't
    // disconnect anything — pure inventory harvest (tiles, or bridges)
    const spurs = [];
    for (const e of state.roadEdges.values()) {
      if (e.motorway || e.roundabout || e.oneway) continue;
      const na = state.roadNodes.get(e.a), nb = state.roadNodes.get(e.b);
      if (!na || !nb) continue;
      const leaf = (na.edges.length === 1 && na.bid == null) ||
        (nb.edges.length === 1 && nb.bid == null);
      if (!leaf || !exclusive(e) || spanOverlap(e)) continue;
      spurs.push({ e, n: nCells(e), wet: wetCells(e), dens: densOf(e) });
    }
    spurs.sort((a, b) => b.n - a.n);
    for (const c of spurs.slice(0, 3)) {
      push(
        { type: 'demolish', demo: 1, costFrac: -(c.n - c.wet) / CONFIG.roads.tilesCap,
          bridgeFrac: -c.wet / 12, meter: c.dens },
        demolishEdge(c.e),
        `demolish spur edge#${c.e.id} (+${c.n - c.wet} tiles${c.wet ? `, +${c.wet} bridges` : ''})`);
    }

    // jammed links: the densest surface edges whose ends stay connected
    // without them — removal pushes traffic onto the parallel route
    const orphan = (e) => [e.a, e.b].some((nid) => {
      const n = state.roadNodes.get(nid);
      return n?.bid != null && n.edges.length === 1;
    });
    const jammed = [...state.roadEdges.values()]
      .filter((e) => !e.motorway && !e.roundabout && !e.oneway && !e.bridge &&
        densOf(e) >= 0.5 && !orphan(e) && exclusive(e) && !spanOverlap(e) && stillLinked(e))
      .sort((x, y) => densOf(y) - densOf(x))
      .slice(0, 2);
    for (const e of jammed) {
      push(
        { type: 'demolish', demo: 1, costFrac: -nCells(e) / CONFIG.roads.tilesCap,
          meter: densOf(e) },
        demolishEdge(e),
        `demolish jammed edge#${e.id} (dens ${densOf(e).toFixed(2)})`);
    }

    // idle span: a placed motorway only returns to stock via demolition —
    // worth offering exactly when there's nothing left to place
    if (state.motorways <= 0) {
      const span = [...state.roadEdges.values()]
        .filter((e) => e.motorway)
        .sort((x, y) => x.vehicles.size - y.vehicles.size)[0];
      if (span) {
        push(
          { type: 'demolish', demo: 2, costFrac: -0.05, meter: densOf(span) },
          () => {
            const cur = state.roadEdges.get(span.id);
            if (!cur?.motorway) return 0;
            removeRoadEdge(state, cur);
            for (const nid of [cur.a, cur.b]) {
              const n = state.roadNodes.get(nid);
              if (n && n.bid == null && !n.edges.length) {
                if (n.light) state.trafficLights = Math.min(CONFIG.trafficLights.cap, state.trafficLights + 1);
                state.roadNodes.delete(n.id);
              }
            }
            state.motorways = Math.min(CONFIG.motorways.cap, state.motorways + 1);
            return 0.05;
          },
          `demolish motorway span#${span.id} (+1 stock)`);
      }
    }

    // underused lines: only a live choice while that class's slots are full —
    // a rail deletion frees a maxLines slot, a bus deletion frees its route cap
    {
      const weakest = (ls) => ls
        .map((l) => ({ l, load: lineLoad(state, l) }))
        .sort((x, y) => x.load - y.load)
        .slice(0, 2);
      const offer = railCount(state) >= state.maxLines
        ? weakest([...state.lines.values()].filter((l) => !l.bus))
        : busCount(state) >= CONFIG.bus.max
          ? weakest([...state.lines.values()].filter((l) => l.bus))
          : [];
      for (const c of offer) {
        push(
          { type: 'demolish', demo: 0, color: c.l.color, stops: c.l.stops.length,
            freight: c.l.freight, wait: Math.min(1, c.load / 30) },
          () => { if (state.lines.has(c.l.id)) { deleteLine(state, c.l); return 0.05; } return 0; },
          `demolish ${c.l.bus ? 'bus' : 'line'} ${c.l.id} (load ${c.load}, frees slot)`);
      }
    }

    // dead junctions: on <2 lines they're pure dwell cost, and a jammed one
    // is an overflow threat — removal un-splices the stop, lines keep running
    let swept = 0;
    for (const b of state.buildings.values()) {
      if (swept >= 2) break;
      if (b.type !== 'junction' || !b.active) continue;
      const thru = linesThrough(state, b.id).length;
      const jam = b.waiting.length >= b.capacity - 1 || b.overflowT > 0;
      if (thru >= 2 && !jam) continue;
      swept++;
      push(
        { type: 'demolish', demo: 3, wait: b.waiting.length / Math.max(1, b.capacity) },
        () => { if (state.buildings.get(b.id) === b) { removeJunction(state, b); return 0.05; } return 0; },
        `demolish junction#${b.id} (${thru} line${thru === 1 ? '' : 's'}${jam ? ', jammed' : ''})`);
    }
  }

  // roadlink: direct chord for a hot work's detoured same-colour homes
  if (state.roadTiles >= 10) {
    const cands = [];
    for (const w of state.buildings.values()) {
      if (w.type !== 'work' || !w.active || (w.demandT ?? 0) < 30) continue;
      const { dist } = roadDistancesFrom(state, [w.id]);
      for (const h of state.buildings.values()) {
        if (h.type !== 'home' || h.color !== w.color || !served(h)) continue;
        const rd = dist.get(`b${h.id}`);
        const eu = Math.hypot(h.x - w.x, h.y - w.y);
        if (rd != null && rd !== Infinity && eu > 250 && rd / eu > 1.6)
          cands.push({ w, h, ratio: rd / eu });
      }
    }
    cands.sort((a, b) => b.ratio - a.ratio);
    for (const c of cands.slice(0, 3)) {
      const cells = planPairCells(state, c.h, c.w, blocked);
      const cost = roadCellCost(state, cells);
      if (cost > state.roadTiles - 8) continue;
      if (bridgeCost(state, cells) > 0) continue; // same policy as tryShortcut
      push(
        { type: 'roadlink', color: c.w.color, costFrac: cost / Math.max(1, state.roadTiles),
          meter: meterOf(c.w), dist: cells.length * CONFIG.grid.cell },
        () => { if (buildRoad(state, cells).length) { state.roadTiles -= cost; return 0.15; } return 0; },
        `roadlink home#${c.h.id}→work#${c.w.id} (${c.ratio.toFixed(1)}× detour)`);
    }
  }

  // special items: motorway spans, roundabouts, traffic lights
  if (state.motorways > 0) {
    const pairs = [];
    for (const h of state.buildings.values()) {
      if (h.type !== 'home' || !h.active || h.color == null || !served(h)) continue;
      for (const w of state.buildings.values()) {
        if (w.type !== 'work' || !w.active || w.color !== h.color || !served(w)) continue;
        const d = Math.hypot(w.x - h.x, w.y - h.y);
        if (d > 240) pairs.push({ a: h, b: w, d });
      }
    }
    pairs.sort((x, y) => y.d - x.d);
    for (const p of pairs.slice(0, 5)) {
      const mid = { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 - 30 };
      push(
        { type: 'motorway', color: p.a.color, dist: p.d, meter: meterOf(p.b) },
        () => { if (buildMotorway(state, [{ x: p.a.x, y: p.a.y }, mid, { x: p.b.x, y: p.b.y }])) { state.motorways--; return 0.1; } return 0; },
        `motorway #${p.a.id}→#${p.b.id} (${Math.round(p.d)}px)`);
    }
  }
  if (state.roundabouts > 0 || state.trafficLights > 0) {
    const jns = [...state.roadNodes.values()].filter(
      (n) => n.bid == null && n.edges.length >= 3 &&
        !n.edges.some((id) => state.roadEdges.get(id)?.roundabout));
    jns.sort((a, b) => junctionPressure(state, b) - junctionPressure(state, a));
    if (state.roundabouts > 0) {
      for (const n of jns.slice(0, 5)) {
        const p = junctionPressure(state, n);
        push({ type: 'roundabout', meter: Math.min(1, p / 20) },
          () => { if (placeRoundabout(state, n)) { state.roundabouts--; return 0.1; } return 0; },
          `roundabout @node${n.id} (pressure ${p})`);
      }
    }
    if (state.trafficLights > 0) {
      for (const n of jns.filter((n2) => !n2.light).slice(0, 5)) {
        const p = junctionPressure(state, n);
        push({ type: 'light', meter: Math.min(1, p / 20) },
          () => { if (placeTrafficLight(state, n, true) === 'add') { state.trafficLights--; return 0.1; } return 0; },
          `light @node${n.id} (pressure ${p})`);
      }
    }
  }
  // noop lands last and only when nothing is connectable — an always-legal
  // free action is a PPO attractor that collapses the policy into idling
  if (!nConnects) push({ type: 'noop' }, () => 0, 'noop');
  return acts;
}

// ---- observation encoder ----------------------------------------------------
// channels 0..14 are strictly binary — bitpack them (COLS is byte-aligned on
// every map); 15..17 carry densities/meters — float16. ~250KB f32 → ~25KB.

const BIN_CH = 17; // binary channels are 0..16; 17..19 carry meters/density

// f32 → f16 bits: obs values are 0..1.5, so truncating the mantissa (≤1e-3
// error) beats a full round-to-nearest — and Node <22 has no Float16Array
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
function f16bits(x) {
  _f32[0] = x;
  const v = _u32[0];
  const sign = (v >>> 16) & 0x8000;
  const e = ((v >>> 23) & 0xff) - 112; // rebias 127 → 15
  if (e <= 0) return sign;             // underflow/subnormal → 0
  if (e >= 31) return sign | 0x7bff;   // clamp to max finite
  return sign | (e << 10) | ((v & 0x7fffff) >> 13);
}

function encodeObs(state) {
  const ROWB = OBSCOLS >> 3; // bytes per row per binary channel (padded width)
  const bin = Buffer.alloc(BIN_CH * OBSROWS * ROWB);
  const con = new Uint16Array((CH - BIN_CH) * OBSROWS * OBSCOLS); // f16 bit patterns
  const at = (c, ch) => {
    if (c.cx < 0 || c.cx >= COLS || c.cy < 0 || c.cy >= ROWS) return;
    const i = c.cy * OBSCOLS + c.cx;
    bin[ch * OBSROWS * ROWB + (i >> 3)] |= 0x80 >> (i & 7); // MSB-first == np.unpackbits
  };
  const atv = (c, ch, v) => {
    if (c.cx < 0 || c.cx >= COLS || c.cy < 0 || c.cy >= ROWS) return;
    const i = (ch - BIN_CH) * OBSROWS * OBSCOLS + c.cy * OBSCOLS + c.cx;
    const h = f16bits(v);
    if (h > con[i]) con[i] = h; // positive floats: bit order == value order
  };
  for (const k of state.water ?? []) {
    const [cx, cy] = k.split(',').map(Number);
    at({ cx, cy }, 0);
  }
  const cap = CONFIG.roads.maxPerEdge + (state.roadCapBonus || 0);
  for (const e of state.roadEdges.values()) {
    const ch = e.motorway ? 2 : 1;
    const dens = Math.min(1, e.vehicles.size / Math.max(1, cap));
    for (const c of cellsAlongPolyline(e.pts)) { at(c, ch); if (!e.motorway) atv(c, 19, dens); }
  }
  // transit tracks — the policy can't extend a network it can't see
  for (const l of state.lines.values()) {
    for (const c of cellsAlongPolyline(linePts(state, l))) {
      at(c, 15);
      if (l.freight) at(c, 16);
    }
  }
  const TYPE_CH = { home: 3, work: 4, farm: 5, market: 6, junction: 7 };
  for (const b of state.buildings.values()) {
    const tch = TYPE_CH[b.type];
    for (const c of buildingCells(b)) {
      at(c, tch);
      if (b.color != null && b.color < 6) at(c, 8 + b.color);
      if (!b.active) at(c, 14);
      atv(c, 17, meterOf(b));
      atv(c, 18, Math.min(1, b.waiting.length / Math.max(1, b.capacity)));
    }
  }
  // food chain, which is where games actually die: crates piling at farms
  // (ch20), market reserve (ch21), food-building staffing (ch22), market
  // fleet activity (ch23), and the live road flow of milk/food trucks (ch24)
  let staffedMkts = 0, staffedFarms = 0, mkts = 0, farms = 0;
  for (const b of state.buildings.values()) {
    if (b.type !== 'farm' && b.type !== 'market') continue;
    if (b.type === 'market') { mkts++; if (b.workers.length > 0) staffedMkts++; }
    else { farms++; if (b.workers.length >= CONFIG.food.workersNeeded) staffedFarms++; }
    let crates = 0;
    for (const aid of b.waiting) if (state.agents.get(aid)?.kind === 'crate') crates++;
    const staff = Math.min(1.5, b.workers.length / Math.max(1, CONFIG.food.workersNeeded));
    for (const c of buildingCells(b)) {
      if (crates) atv(c, 20, Math.min(1, crates / Math.max(1, b.capacity)));
      atv(c, 22, staff);
      if (b.type === 'market') {
        atv(c, 21, Math.min(1, b.stock / Math.max(1, CONFIG.food.stockpileCap)));
        atv(c, 23, Math.min(1, (b.activeTrucks || 0) / Math.max(1, b.trucks)));
      }
    }
  }
  let activeTrucks = 0;
  for (const v of state.vehicles.values()) {
    if (v.kind === 'milkTruck') activeTrucks++;
    else if (v.kind !== 'foodTruck') continue;
    const p = carPos(v);
    if (p) atv(cellOf(p), 24, 1);
  }
  let cratesQueued = 0, cratesInTransit = 0;
  for (const a of state.agents.values()) {
    if (a.kind !== 'crate') continue;
    if (a.loc && typeof a.loc === 'object' && a.loc.veh != null) cratesInTransit++;
    else cratesQueued++;
  }
  let waitTot = 0, capTot = 0, maxMeter = 0;
  for (const b of state.buildings.values()) {
    waitTot += b.waiting.length; capTot += b.capacity;
    maxMeter = Math.max(maxMeter, meterOf(b));
  }
  const rush = rushStatus(state);
  const subdivIn = CONFIG.subdivision
    ? Math.max(0, (state.subdivAt ?? Infinity) - state.time) : Infinity;
  const glob = [
    state.week / 12,
    state.weekT / CONFIG.weekSeconds,
    state.roadTiles / CONFIG.roads.tilesCap,
    state.maxLines ? railCount(state) / state.maxLines : 0,
    state.motorways / 9, state.roundabouts / 9, state.trafficLights / 9,
    (state.bridges ?? 0) / 36,
    state.unlockedColors.length / 6,
    Math.log1p(state.delivered) / Math.log1p(600),
    Math.log1p(state.freightDelivered) / Math.log1p(600),
    Math.min(1, state.time / 900),
    state.buildings.size / 80,
    state.agents.size / 200,
    state.vehicles.size / 120,
    [...state.buildings.values()].some((b) => b.type === 'farm' && b.active) ? 1 : 0,
    LEVEL === 1 ? 1 : 0, LEVEL === 2 ? 1 : 0, LEVEL === 3 ? 1 : 0,
    state.upgradePending ? 1 : 0,
    capTot ? waitTot / capTot : 0,
    Math.min(1.5, maxMeter),
    // rush hour is forecastable by design — countdown + active flag; the
    // tract timer too (position stays hidden, so staging is still spatial)
    Math.min(1, rush.in / 90),
    rush.active ? 1 : 0,
    Math.min(1, subdivIn / 120),
    // aggregate freight health — the per-cell channels show *where*, these
    // give the critic the *how much*
    cratesQueued / 40,
    cratesInTransit / 40,
    activeTrucks / 15,
    mkts ? staffedMkts / mkts : 0,
    farms ? staffedFarms / farms : 0,
  ];
  return {
    bin,
    con: Buffer.from(con.buffer, con.byteOffset, con.byteLength),
    glob,
  };
}

// action features → raw f16 bytes (was ~30KB of JSON floats → ~7KB)
function packFeats(acts) {
  const buf = Buffer.alloc(acts.length * AFD * 2);
  for (let i = 0; i < acts.length; i++) {
    const f = acts[i].feat;
    for (let j = 0; j < AFD; j++) buf.writeUInt16LE(f16bits(f[j]), (i * AFD + j) * 2);
  }
  return buf;
}

// ---- env loop ---------------------------------------------------------------

let state = null;
let rng = null;
let steps = 0;
let prevExcess = 0; // worst meter pressure above the danger line — shaping

// RLTIME=1 → per-phase ms totals on stderr at close; hrtime is ~100ns so the
// counters stay on unconditionally and only printing is gated
const RLTIME = !!process.env.RLTIME;
const T = { warm: 0, tick: 0, enum: 0, encode: 0, json: 0, n: 0 };
const t0 = () => process.hrtime.bigint();
const add = (k, s) => { T[k] += Number(process.hrtime.bigint() - s) / 1e6; };

// potential-based shaping: excess = max over buildings of pressure past 50%.
// Reward is -excess moved into the step, so relieving a hot building pays
// and letting one heat up costs — without any reward for meter-fiddling at
// safe levels.
function excessPressure(s) {
  let m = 0;
  for (const b of s.buildings.values()) {
    if (!b.active) continue;
    m = Math.max(m, meterOf(b));
  }
  return Math.max(0, m - 0.5);
}

function doReset(seed, warm = 0) {
  Math.random = srand(seed);
  state = createState();
  state.level = LEVEL;
  applyLevelFeatures(state);
  steps = 0;
  epActs = {}; epTiles = 0; epBridges = 0;
  for (let i = 0; i < 30; i++) tick(state, STEP); // let the seed cluster open
  // reverse-curriculum warm start: the heuristic bot pre-plays a random
  // prefix so episodes reach the states runs actually die in — agent and
  // critic get gradient on week-5+ pressure from iteration 1. A quarter of
  // resets stay cold so opening play doesn't atrophy.
  const warmK = Math.random() < 0.25 ? 0 : Math.random() * warm;
  const sW = t0();
  let t = 0, dt = 0;
  while (t < warmK && !state.gameOver) {
    tick(state, STEP);
    t += STEP;
    dt -= STEP;
    if (state.upgradePending) pickUpgrade(state, noopLog);
    if (dt <= 0) { dt = 0.4; decide(state, noopLog); }
  }
  add('warm', sW);
  if (state.gameOver) return doReset(seed, 0); // bot died in warmup — cold retry
  prevExcess = excessPressure(state);
  return respond(0, false);
}

function respond(reward, done) {
  let s = t0();
  const acts = enumerate(state);
  add('enum', s);
  const info = {
    week: state.week, time: +state.time.toFixed(1),
    delivered: state.delivered, freight: state.freightDelivered,
    buildings: state.buildings.size,
    reason: state.gameOver?.reason ?? null,
    steps,
  };
  s = t0();
  const r = {
    obs: encodeObs(state),
    feats: packFeats(acts),
    reward, done, info,
    _acts: acts, // stripped before send
  };
  if (process.env.RLDESC) r.desc = acts.map((a) => a.desc);
  add('encode', s);
  return r;
}

// wire frame (all little-endian): 5×u32 lengths [meta, bin, con, glob, feats],
// then the payloads back to back. meta is the small JSON part (reward, done,
// info, optional desc/error); bin/con/feats are the raw obs buffers and glob
// is f32. Raw bytes replace base64-in-JSON: no encode/parse of ~50KB strings.
function frame(meta, obs, feats) {
  const m0 = Buffer.from(JSON.stringify(meta));
  const m = Buffer.concat([m0, Buffer.alloc((4 - (m0.length % 4)) % 4, 0x20)]); // 4-byte align payloads
  const bin = obs?.bin ?? Buffer.alloc(0), con = obs?.con ?? Buffer.alloc(0);
  const glob = obs ? Buffer.from(new Float32Array(obs.glob).buffer) : Buffer.alloc(0);
  const fe = feats ?? Buffer.alloc(0);
  const hdr = Buffer.alloc(20);
  [m, bin, con, glob, fe].forEach((b, i) => hdr.writeUInt32LE(b.length, i * 4));
  return Buffer.concat([hdr, m, bin, con, glob, fe]);
}

function serialize(r) {
  const { _acts, obs, feats, ...meta } = r;
  return frame(meta, obs, feats);
}

let pending = null; // acts from the last respond()

// per-episode metrics — feed episodes.jsonl so the action histogram is a
// visible collapse/emergence detector, not a guess
let epActs = {}, epTiles = 0, epBridges = 0;

function doStep(aIdx) {
  const acts = pending ?? enumerate(state);
  steps++;
  let bonus = 0;
  if (aIdx >= 0 && aIdx < acts.length) {
    const rt0 = state.roadTiles, br0 = state.bridges ?? 0;
    try { bonus = acts[aIdx].apply() || 0; } catch (e) { /* bad apply = wasted action */ }
    epActs[acts[aIdx].type] = (epActs[acts[aIdx].type] ?? 0) + 1;
    epTiles += rt0 - state.roadTiles;
    epBridges += br0 - (state.bridges ?? 0);
  }
  const d0 = state.delivered, f0 = state.freightDelivered;
  const sT = t0();
  let t = 0, guard = 0;
  while (t < DECIDE_DT - 1e-9 && !state.gameOver && !state.upgradePending && guard++ < 240) {
    tick(state, STEP);
    t += STEP;
  }
  add('tick', sT);
  let reward = 0.02 * t + 0.1 * (state.delivered - d0) +
    0.15 * (state.freightDelivered - f0) + bonus;
  const ex = excessPressure(state);
  reward += 2.0 * (prevExcess - ex); // meter-relief shaping
  prevExcess = ex;
  const done = !!state.gameOver || state.time >= MAX_SECONDS;
  // the game's actual objective as a terminal bonus — shaped meter relief
  // alone leaves the agent indifferent to crossing star thresholds
  if (done) reward += (CONFIG.win?.stars ?? [5, 8, 11])
    .filter((w) => state.week >= w).length;
  if (state.gameOver) reward -= 2;
  const r = respond(reward, done);
  if (done) {
    r.info.acts = { ...epActs };
    r.info.tilesSpent = epTiles;
    r.info.bridgesSpent = epBridges;
    r.info.lines = state.lines.size;
  }
  pending = r._acts;
  return r;
}

const rl = readline.createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ ready: true, ch: CH, gd: GD, afd: AFD, rows: OBSROWS, cols: OBSCOLS }) + '\n');
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  try {
    if (msg.cmd === 'reset') {
      pending = null;
      const r = doReset(msg.seed ?? 1, msg.warm ?? 0);
      pending = r._acts;
      const s = t0();
      process.stdout.write(serialize(r));
      add('json', s);
    } else if (msg.cmd === 'step') {
      T.n++;
      const r = doStep(msg.a ?? 0);
      const s = t0();
      process.stdout.write(serialize(r));
      add('json', s);
    } else if (msg.cmd === 'close') {
      if (RLTIME) {
        const per = Object.fromEntries(
          Object.entries(T).filter(([k]) => k !== 'n')
            .map(([k, v]) => [k, +(v / Math.max(1, T.n)).toFixed(2)]));
        process.stderr.write(
          `RLTIME total ${JSON.stringify(T)} per-step ${JSON.stringify(per)}\n`);
      }
      process.exit(0);
    }
  } catch (e) {
    process.stdout.write(frame({ error: String(e?.stack ?? e) }));
  }
});
