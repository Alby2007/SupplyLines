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
import { courierTargets, couriersInFlight, sendCourier, understaffed, shuttleSources, shuttlesInFlight, sendShuttle } from '../src/food.js';
import { rushStatus } from '../src/economy.js';
import { mapParams } from '../src/mapgen.js';
import * as readline from 'node:readline';
import {
  srand, tick, served, blockedCells, pathToRoad,
  onLine, reachable, junctionPressure, newLine, cachedPlan,
  decide, pickUpgrade, edgeComponents, componentCells,
  componentNodes, mergeableGoalCells,
} from '../autoplay.mjs';

const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split('=')[1] : d;
};
// --level accepts a pool ("101,105,112" or a single int): each reset samples
// one uniformly so an episode's level is i.i.d. across the distribution
const LEVELS = String(arg('level', 1)).split(',').map((s) => +s.trim());
// overrides merge one-way onto CONFIG, so rotating levels needs a per-episode
// restore or one map's sections bleed into the next. Snapshot taken after
// config.js's GEN_LEVELS merge, so gen defs live in `levels` either way.
const CONFIG_BASE = JSON.parse(JSON.stringify(CONFIG));
let dbgPrinted = false;
function setLevel(lvl) {
  for (const k of Object.keys(CONFIG)) {
    if (!(k in CONFIG_BASE)) delete CONFIG[k];
    else if (CONFIG[k] && typeof CONFIG[k] === 'object')
      CONFIG[k] = JSON.parse(JSON.stringify(CONFIG_BASE[k]));
    else CONFIG[k] = CONFIG_BASE[k];
  }
  applyLevelOverrides(lvl); // autoplay applies its own too — same level, harmless
  applyRLTuning(); // difficulty multipliers ride on top of the level's own sections
  // RL_DEBUG prints once, from inside setLevel — what episodes actually get
  // after the base restore (post-init dumps would miss tuner-table bugs)
  if (process.env.RL_DEBUG && !dbgPrinted) {
    dbgPrinted = true;
    const tuned = Object.keys(TUNERS).filter((k) => process.env[k]);
    console.error(`dbg tune: ${tuned.length ? tuned.map((k) => `${k}=${process.env[k]}`).join(' ') : 'none'} ` +
      `| intervalMin ${CONFIG.spawn.intervalMin} tract ${CONFIG.subdivision?.every} tilesWk ${CONFIG.roads.tilesPerWeek} commuter ${CONFIG.commuters?.interval} courR ${CONFIG.food.courierRadius} shutR ${CONFIG.food.shuttleRadius}`);
  }
}

// difficulty multipliers — applied AFTER level overrides so each map keeps
// its relative structure (tilesPerWeek differs per level; a multiplier
// preserves that spread where an absolute would flatten it). Baseline probes
// reproduce the same shifts via autoplay --tune=path=*factor.
const TUNERS = {
  RL_SPAWNFLOOR: (v) => { CONFIG.spawn.intervalMin *= v; },
  RL_TRACTEVERY: (v) => { CONFIG.subdivision.every *= v; },
  RL_TILESWK: (v) => { CONFIG.roads.tilesPerWeek *= v; },
  RL_DEMANDRATE: (v) => { CONFIG.demand.rate *= v; },
  RL_DEMANDLIMIT: (v) => { CONFIG.demand.limit *= v; },
  RL_HUNGERLIMIT: (v) => { CONFIG.food.hungerLimit *= v; },
  // worker supply rate: <1 shortens the per-home emission interval — tests
  // whether understaffing is rate-bound (bends) or topological (flat)
  RL_COMMUTER: (v) => { CONFIG.commuters.interval *= v; },
  // verb-sweep knobs — absolute px overrides, not multipliers. They must live
  // here: setLevel restores every section from CONFIG_BASE each reset, so any
  // direct CONFIG assignment made after the base snapshot gets wiped
  RL_COURIERR: (v) => { CONFIG.food.courierRadius = v; },
  RL_SHUTTLER: (v) => { CONFIG.food.shuttleRadius = v; },
};
function applyRLTuning() {
  for (const [k, fn] of Object.entries(TUNERS)) if (process.env[k]) fn(+process.env[k]);
}
applyLevelOverrides(LEVELS[0]);
applyRLTuning();

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
const CH = 25, GD = 37, AFD = 45, MAXA = 80; // afd slots 41-44 in use; tail free

// ---- action enumeration ---------------------------------------------------

// type one-hots live at their slot index; 33/34 land in the tail that
// upgrades (22..32) leave free, so checkpoints trained before demolition and
// junctions existed still read every old action identically
const TYPE_IDX = { noop: 0, connect: 1, roadlink: 2, line: 3, motorway: 4, roundabout: 5, light: 6, upgrade: 7, demolish: 33, junction: 34, hire: 40, courier: 41, shuttle: 42, reconnect: 43, densify: 44 };

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
      // pathToRoad never returns blocked cells, so blocked here means the
      // raw chord is still in hand — it crosses a junction, buildRoad
      // rejects, the mask would offer a connect that cannot succeed
      if (cells.some((c) => blocked.has(cellKey(c)))) return null;
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
    if (dBest) {
      // addLine colours by first coloured stop — if that isn't the stranded
      // agent's colour the built line can't board them (agents ride only
      // their own colour, routing.js lineColor filter) → don't offer a
      // doomed rescue
      const lc = [b.color, dBest.color].find((c) => c != null) ?? null;
      if (lc === a.color)
        out.push({ stops: [b.id, dBest.id], why: 'rescue', rescue: true, color: a.color });
    }
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
    offers.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  if (!offers.length) { state.upgradePending = false; return null; }
  epOffers.push(offers.map((u) => u.name)); // what the agent was shown
  return offers;
}

const noopLog = () => {};

function enumerate(state) {
  const acts = [];
  const push = (o, apply, desc, op = null) =>
    acts.length < MAXA && acts.push({ feat: feat(o), apply, desc, type: o.type, op });

  if (state.upgradePending) {
    const offers = state._offers ?? makeOffers(state);
    if (offers) {
      state._offers = offers;
      offers.forEach((u) => push(
        { type: 'upgrade', upgradeIdx: UPGRADES.indexOf(u) },
        () => { epUpgrades.push(u.name); u.apply(state); state.upgradePending = false; state._offers = null; return 0.05; },
        `upgrade:${u.name}`, { kind: 'upgrade', idx: UPGRADES.indexOf(u), name: u.name }));
      return acts;
    }
    // makeOffers cleared upgradePending (nothing eligible) — fall through to
    // normal enumeration: an empty mask crashes eps-greedy upstream and
    // turns the Categorical into a uniform draw over invalid slots
  }

  const roadIdx = roadCellIndex(state);
  const beforeConnects = acts.length; // noop masked whenever connects exist

  const blocked = blockedCells(state);
  // same mergeable-only goal set tryConnect uses — raw component cells let a
  // plan land beside the network and stub the building onto a stranded island
  const { comp, best } = roadIdx.size ? edgeComponents(state) : {};
  const goal = best == null ? null : mergeableGoalCells(
    state, componentCells(roadIdx, comp, best), componentNodes(state, comp, best));

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
      `connect ${b.type}#${b.id}${b.active ? '' : ' (pending)'}`, { kind: 'road', cells: c.cells });
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
      `connect(alt) ${c.b.type}#${c.b.id}${c.b.active ? '' : ' (pending)'}`,
      { kind: 'road', cells });
  }

  // reconnect: the class connect's mask can't see — buildings already on a
  // road yet service-disconnected. Stranded-component homes starve
  // unassigned while touching pavement; understaffed buildings on a
  // component with no eligible worker source have no commute to give.
  // Goal set is the component(s) that can actually serve them, so the
  // Dijkstra draws the cheapest bridge between islands, not just to main.
  if (RECONNECT && roadIdx.size) {
    const compCache = new Map();
    const cellsOfComp = (cid) => {
      if (!compCache.has(cid)) compCache.set(cid, componentCells(roadIdx, comp, cid));
      return compCache.get(cid);
    };
    const mergeCache = new Map();
    const mergeableOfComp = (cid) => {
      // reconnect goals must land where a draw can actually merge into the
      // serving component — same snap-radius check as the main-net goal
      if (!mergeCache.has(cid)) {
        mergeCache.set(cid, mergeableGoalCells(
          state, cellsOfComp(cid), componentNodes(state, comp, cid)));
      }
      return mergeCache.get(cid);
    };
    const compOf = (b) => {
      for (const c of buildingCells(b)) {
        const refs = roadIdx.get(cellKey(c));
        if (refs?.length) return comp.get(refs[0].edgeId) ?? null;
      }
      return null;
    };
    const goalInto = (goal, b, cid) => {
      if (cid != null) for (const [k, v] of mergeableOfComp(cid)) goal.set(k, v);
      for (const c of buildingCells(b)) goal.set(cellKey(c), []); // unroaded target: land adjacent
    };
    const reconCands = [];
    for (const b of state.buildings.values()) {
      if (b.type === 'junction' || !b.active) continue;
      const own = buildingCells(b);
      if (!own.some((c) => roadIdx.has(cellKey(c)))) continue; // roadless is connect's job
      const goalSet = new Map();
      if (b.type === 'home') {
        if (b.assignedMarket != null) continue;
        for (const m of state.buildings.values()) {
          if (m.type !== 'market' || !m.active || m.color !== b.color) continue;
          goalInto(goalSet, m, compOf(m));
        }
      } else {
        if (!understaffed(b)) continue;
        const wantsWorker = (h) => h.type === 'home' && h.active &&
          (b.type === 'farm' || h.color === b.color);
        const myCid = compOf(b);
        let stranded = myCid == null;
        for (const h of state.buildings.values()) {
          if (!wantsWorker(h)) continue;
          const cid = compOf(h);
          if (cid === myCid && myCid != null) { stranded = false; break; }
          goalInto(goalSet, h, cid);
        }
        if (!stranded) continue; // reachable workers exist — gap isn't topology
      }
      if (!goalSet.size) continue;
      const cells = cachedPlan(state, `recon:${b.id}`, () =>
        pathToRoad(state, own, roadIdx, blocked, goalSet));
      if (!cells || cells.length < 2) continue;
      const cost = roadCellCost(state, cells);
      if (cost > state.roadTiles) continue;
      const wet = bridgeCost(state, cells);
      if (wet > (state.bridges ?? 0)) continue;
      reconCands.push({ b, cells, cost, wet, meter: meterOf(b) });
    }
    reconCands.sort((x, y) => y.meter - x.meter || x.cost - y.cost);
    for (const c of reconCands.slice(0, 12)) {
      const b = c.b;
      push(
        { type: 'reconnect', color: b.color,
          costFrac: c.cost / Math.max(1, state.roadTiles), bridgeFrac: c.wet / 12,
          meter: c.meter, wait: (b.waiting?.length ?? 0) / (b.capacity || 1),
          dist: c.cells.length * CONFIG.grid.cell, rescue: b.type === 'home' },
        () => { if (buildRoad(state, c.cells).length) { state.roadTiles -= c.cost; return 0.15; } return 0; },
        `reconnect ${b.type}#${b.id}`, { kind: 'road', cells: c.cells });
    }
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
      `line ${c.why}: ${c.stops.join('→')}`, { kind: 'line', stops: c.stops });
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
      `junction lines ${c.A.line.id}×${c.B.line.id}`, { kind: 'junction', x: c.x, y: c.y });
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
        `bus ${p.h.id}→${p.w.id} (${Math.round(p.d)}px road-borne)`, { kind: 'line', stops: [p.h.id, p.w.id] });
    }
  }

  // hire driver: the on-demand lever on the proven bottleneck — trades road
  // tiles for a shift-long driver on a market whose fleet outruns its staff.
  // Masked to real driver gaps; meter = mean hunger of the homes it serves.
  {
    const cost = CONFIG.food.hireCost;
    if (state.roadTiles >= cost) {
      const hSum = new Map(), hN = new Map();
      for (const b of state.buildings.values()) {
        if (b.type !== 'home' || !b.active || b.assignedMarket == null) continue;
        hSum.set(b.assignedMarket, (hSum.get(b.assignedMarket) ?? 0) + b.hungerT / CONFIG.food.hungerLimit);
        hN.set(b.assignedMarket, (hN.get(b.assignedMarket) ?? 0) + 1);
      }
      const hires = [];
      for (const m of state.buildings.values()) {
        if (m.type !== 'market' || !m.active) continue;
        const hired = (m.hired ?? []).filter((x) => x > state.time).length;
        if (m.workers.length + hired >= m.trucks) continue; // fleet already manned
        hires.push({ m, gap: m.trucks - m.workers.length - hired,
          meter: (hSum.get(m.id) ?? 0) / Math.max(1, hN.get(m.id) ?? 1) });
      }
      hires.sort((a, b) => b.meter - a.meter || b.gap - a.gap);
      for (const h of hires.slice(0, 6)) {
        const m = h.m;
        push(
          { type: 'hire', color: m.color,
            costFrac: cost / Math.max(1, state.roadTiles),
            meter: h.meter, wait: (m.activeTrucks || 0) / Math.max(1, m.trucks) },
          () => {
            if (state.roadTiles < cost) return 0;
            const hired = (m.hired ??= []).filter((x) => x > state.time);
            if (m.workers.length + hired.length >= m.trucks) return 0; // gap closed since enum
            state.roadTiles -= cost;
            m.hired = [...hired, state.time + CONFIG.food.hireLen];
            return 0.15;
          },
          `hire driver market#${m.id} (+${h.gap} driver gap)`);
      }
    }
  }

  // courier: paid walker carrying one crate cross-country to a hungry home no
  // road can reach — the relief valve for the unassigned fraction. Costs
  // tiles per delivery, so it's a scalpel beside roads, not a substitute.
  if (COURIER) {
    const cost = CONFIG.food.courierCost;
    if (state.roadTiles >= cost) {
      const cands = [];
      for (const m of state.buildings.values()) {
        if (m.type !== 'market' || !m.active || (m.stock ?? 0) < 1) continue;
        if (couriersInFlight(state, m.id) >= CONFIG.food.courierCap) continue;
        const tgts = courierTargets(state, m);
        if (!tgts.length) continue;
        cands.push({ m, tgts });
      }
      cands.sort((a, b) => b.tgts[0].h.hungerT - a.tgts[0].h.hungerT);
      for (const c of cands.slice(0, 6)) {
        const m = c.m, top = c.tgts[0];
        push(
          { type: 'courier', color: m.color,
            costFrac: cost / Math.max(1, state.roadTiles),
            meter: top.h.hungerT / CONFIG.food.hungerLimit,
            wait: couriersInFlight(state, m.id) / CONFIG.food.courierCap,
            dist: top.d, stops: Math.min(8, c.tgts.length), rescue: 1 },
          () => {
            if (state.roadTiles < cost) return 0;
            const v = sendCourier(state, m);
            if (!v) return 0;
            state.roadTiles -= cost;
            return 0.15;
          },
          `courier market#${m.id} → home#${top.h.id} (${c.tgts.length} unreachable)`);
      }
    }
  }

  // densify: permanent worker capacity — spend tiles to raise a home's
  // resident cap where understaffed works sit nearby. The capacity verb
  // shuttle's relief couldn't be: each bonus resident emits commuters
  // forever, and the triage rules send them where demand runs hot.
  if (DENSIFY) {
    const cost = CONFIG.homes.densifyCost;
    if (state.roadTiles >= cost) {
      const needy = [];
      for (const b of state.buildings.values())
        if (b.active && understaffed(b)) needy.push(b);
      if (needy.length) {
        const homes = [];
        for (const h of state.buildings.values()) {
          if (h.type !== 'home' || !h.active) continue;
          if ((h.resBonus ?? 0) >= CONFIG.homes.densifyCap) continue;
          let best = Infinity;
          for (const w of needy) {
            const d = Math.hypot(h.x - w.x, h.y - w.y);
            if (d < best) best = d;
          }
          if (best <= CONFIG.homes.densifyRadius) homes.push({ h, best });
        }
        homes.sort((a, b) => a.best - b.best);
        for (const { h, best } of homes.slice(0, 6)) {
          push(
            { type: 'densify', color: h.color,
              costFrac: cost / Math.max(1, state.roadTiles),
              dist: best, stops: (h.resBonus ?? 0) },
            () => {
              if (state.roadTiles < cost) return 0;
              if ((h.resBonus ?? 0) >= CONFIG.homes.densifyCap) return 0;
              const still = [...state.buildings.values()].some((w) =>
                w.active && understaffed(w) &&
                Math.hypot(h.x - w.x, h.y - w.y) <= CONFIG.homes.densifyRadius);
              if (!still) return 0;
              state.roadTiles -= cost;
              h.resBonus = (h.resBonus ?? 0) + CONFIG.homes.densifyBonus;
              return 0.15;
            },
            `densify home#${h.id} +${CONFIG.homes.densifyBonus} residents (${best.toFixed(0)}u to work)`);
        }
      }
    }
  }

  // shuttle: paid escort carrying a worker home→work cross-country — the
  // staffing-side analog of courier for buildings the road can't reach.
  // Masked to genuinely understaffed/hot buildings; the worker arrives as a
  // normal commute (demand relief / staff slot) at walk-speed economics.
  // RETIRED (it ~115): ~92% adoption but understaffed deaths never bent —
  // 24s relief per dispatch is a delay not a save, and it ate courier's
  // tile budget. RL_SHUTTLE=1 re-enables.
  if (SHUTTLE) {
    const cost = CONFIG.food.shuttleCost;
    if (state.roadTiles >= cost) {
      const sMeter = (b) => b.type === 'work' ? b.demandT / CONFIG.demand.limit
        : 1 - b.workers.length / Math.max(1, b.type === 'farm' ? CONFIG.food.workersNeeded
            : Math.min(b.trucks, CONFIG.food.workersNeeded + 1));
      const cands = [];
      for (const b of state.buildings.values()) {
        if (b.type !== 'work' && b.type !== 'farm' && b.type !== 'market') continue;
        if (!b.active || !understaffed(b)) continue;
        if (shuttlesInFlight(state, b.id) >= CONFIG.food.shuttleCap) continue;
        const srcs = shuttleSources(state, b);
        if (!srcs.length) continue;
        cands.push({ b, srcs, sm: sMeter(b) });
      }
      cands.sort((a, z) => z.sm - a.sm);
      for (const c of cands.slice(0, 6)) {
        const b = c.b, src = c.srcs[0];
        push(
          { type: 'shuttle', color: b.color,
            costFrac: cost / Math.max(1, state.roadTiles),
            meter: c.sm, wait: shuttlesInFlight(state, b.id) / CONFIG.food.shuttleCap,
            dist: src.d, stops: Math.min(8, c.srcs.length), rescue: 1 },
          () => {
            if (state.roadTiles < cost) return 0;
            const v = sendShuttle(state, b);
            if (!v) return 0;
            state.roadTiles -= cost;
            return 0.15;
          },
          `shuttle worker → ${b.type}#${b.id} (${c.srcs.length} homes in range)`);
      }
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
        `demolish spur edge#${c.e.id} (+${c.n - c.wet} tiles${c.wet ? `, +${c.wet} bridges` : ''})`, { kind: 'demolish', eid: c.e.id });
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
        `demolish jammed edge#${e.id} (dens ${densOf(e).toFixed(2)})`, { kind: 'demolish', eid: e.id });
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
          `demolish ${c.l.bus ? 'bus' : 'line'} ${c.l.id} (load ${c.load}, frees slot)`, { kind: 'demolish', lid: c.l.id });
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
        `demolish junction#${b.id} (${thru} line${thru === 1 ? '' : 's'}${jam ? ', jammed' : ''})`, { kind: 'demolish', jid: b.id });
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
        `roadlink home#${c.h.id}→work#${c.w.id} (${c.ratio.toFixed(1)}× detour)`, { kind: 'road', cells });
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
        `motorway #${p.a.id}→#${p.b.id} (${Math.round(p.d)}px)`, { kind: 'special', spec: 'motorway', x: mid.x, y: mid.y });
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
          `roundabout @node${n.id} (pressure ${p})`, { kind: 'special', spec: 'roundabout', x: n.x, y: n.y });
      }
    }
    if (state.trafficLights > 0) {
      for (const n of jns.filter((n2) => !n2.light).slice(0, 5)) {
        const p = junctionPressure(state, n);
        push({ type: 'light', meter: Math.min(1, p / 20) },
          () => { if (placeTrafficLight(state, n, true) === 'add') { state.trafficLights--; return 0.1; } return 0; },
          `light @node${n.id} (pressure ${p})`, { kind: 'special', spec: 'light', x: n.x, y: n.y });
      }
    }
  }
  // noop lands last and only when nothing is connectable — an always-legal
  // free action is a PPO attractor that collapses the policy into idling
  if (!nConnects) push({ type: 'noop' }, () => 0, 'noop', { kind: 'noop' });
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
    // the map's own parameters replace the one-hot — a policy trained on a
    // distribution reads terrain/knobs as features instead of memorizing IDs
    ...mapParams(state.level),
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
let rng = Math.random; // per-episode seeded draw (srand) — set by doReset; the
                       // sim ticks, env branching, and offer sampling all draw
                       // from it in order so a seed reproduces an episode
let steps = 0;
let prevExcess = 0; // worst meter pressure above the danger line — shaping
let prevHungerP = 0; // food-specific pressure, tracked separately — see below

// RL_FOODSHAPE=0 disables the food terms (A/B comparisons) without a code change
const FOODSHAPE = process.env.RL_FOODSHAPE !== '0';
// verb retired (verdict: inert at relief-per-dispatch economics) — RL_SHUTTLE=1
// re-enables enumeration for redesigns; the sim-side mechanics stay complete
const SHUTTLE = process.env.RL_SHUTTLE === '1';
// RL_COURIER=0 suppresses courier enumeration — for evaluating pre-courier
// checkpoints whose score head never trained on those candidates
const COURIER = process.env.RL_COURIER !== '0';
// RL_RECONNECT=0 suppresses reconnect (stranded-component bridging) for
// ablation against checkpoints that never saw it
const RECONNECT = process.env.RL_RECONNECT !== '0';
// RL_DENSIFY=0 suppresses densify (permanent home-capacity verb) for ablation
const DENSIFY = process.env.RL_DENSIFY !== '0';

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

// Food-specific pressure, kept out of the shared max(): there, hunger competes
// with work-demand and overflow meters for a single slot, so its gradient only
// arrives when a home is already the hottest thing on the map. Here the worst
// home still anchors the term (first to 1.0 ends the run) but the mean makes
// every hungry home contribute — feeding a merely-warm home pays too. The 0.4
// threshold starts the gradient ~70s before the 120s limit, early enough that
// a dispatched milkrun can still arrive in time.
function hungerPressure(s) {
  let worst = 0, sum = 0, n = 0;
  for (const b of s.buildings.values()) {
    if (!b.active || b.type !== 'home') continue;
    const h = Math.max(0, b.hungerT / CONFIG.food.hungerLimit);
    worst = Math.max(worst, h);
    sum += h; n++;
  }
  return Math.max(0, worst - 0.4) + 0.25 * (n ? sum / n : 0);
}

// milkrun drops stamp home.fedAt = state.time; counting stamps inside the step
// window gives the per-step delivery count — the one event that only fires
// when the whole chain (farm→crate→market→truck→home) holds end to end
function fedThisStep(s, tPrev) {
  let n = 0;
  for (const b of s.buildings.values()) {
    if (b.type === 'home' && b.fedAt != null && b.fedAt > tPrev) n++;
  }
  return n;
}

// coverage pressure — the diagnosed bottleneck: a home with assignedMarket ==
// null has NO road-reachable same-colour market, so it can never be fed and its
// colour's workers can't staff that market either (staffing gated by coverage:
// −0.49 corr, ~26% unassigned flat across 235 iters). Fraction of homes
// uncovered; an assignment pays, losing one costs. RL_COVERSHAPE=0 disables.
const COVERSHAPE = process.env.RL_COVERSHAPE !== '0';
let prevCoverP = 0;
function coveragePressure(s) {
  let homes = 0, un = 0;
  for (const b of s.buildings.values()) {
    if (!b.active || b.type !== 'home') continue;
    homes++;
    if (b.assignedMarket == null) un++;
  }
  return homes ? un / homes : 0;
}

// ---- state archive (Go-Explore-lite) ----------------------------------------
// RL_RESTORE=p — probability that a reset restores an archived snapshot instead
// of a cold/bot warm start. All game state lives inside `state` (id-referenced
// data + a few matcher closures that only capture immutable scalars), so a
// custom deep copy gives an exact restore — structuredClone would throw on the
// agent `dest` functions, which we share by reference instead.
const RESTORE = Math.min(1, Math.max(0, +process.env.RL_RESTORE || 0));
const ARCHIVE_CAP = 48;
const archive = [];   // { snap, week } — one entry per week boundary per worker
let lastSnapWeek = 0;
let epRestored = 0;   // week the current episode branched from (0 = fresh start)

function deepClone(v) {
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [deepClone(k), deepClone(x)]));
  if (v instanceof Set) return new Set([...v].map(deepClone));
  if (Array.isArray(v)) return v.map(deepClone);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k in v) o[k] = deepClone(v[k]);
    return o;
  }
  return v; // scalars and functions — shared by reference
}

// weight ∝ week: the frontier (deep states the policy rarely reaches) is what
// the archive is for, but early states stay available for diversity
function pickSnapshot() {
  let sum = 0;
  for (const s of archive) sum += s.week;
  let r = rng() * sum;
  for (const s of archive) { r -= s.week; if (r <= 0) return s; }
  return archive[archive.length - 1];
}

function doReset(seed, warm = 0) {
  rng = srand(seed);
  // restore branch: resume from a frontier snapshot instead of building a new
  // world — the agent explores onward from states it actually reached. The
  // stream keeps running off this seed, so each branch diverges on its own
  // draws; `restored` is stamped on the episode record for analysis.
  if (RESTORE > 0 && archive.length && rng() < RESTORE) {
    const snap = pickSnapshot();
    setLevel(snap.snap.level); // the episode continues on the snapshot's map
    state = deepClone(snap.snap);
    steps = 0;
    epActs = {}; epActsFail = {};
    epTiles = 0; epBridges = 0; epUpgrades = []; epOffers = [];
    epRestored = snap.week;
    lastSnapWeek = state.week;
    prevExcess = excessPressure(state);
    prevHungerP = hungerPressure(state);
    prevCoverP = coveragePressure(state);
    return respond(0, false);
  }
  epRestored = 0;
  const lvl = LEVELS[Math.floor(rng() * LEVELS.length)];
  setLevel(lvl); // restore base sections, then this map's overrides
  state = createState();
  state.level = lvl;
  applyLevelFeatures(state);
  steps = 0;
  epActs = {}; epActsFail = {};
  epTiles = 0; epBridges = 0; epUpgrades = []; epOffers = [];
  for (let i = 0; i < 30; i++) tick(state, STEP, rng); // let the seed cluster open
  // reverse-curriculum warm start: the heuristic bot pre-plays a random
  // prefix so episodes reach the states runs actually die in — agent and
  // critic get gradient on week-5+ pressure from iteration 1. A quarter of
  // resets stay cold so opening play doesn't atrophy.
  const warmK = rng() < 0.25 ? 0 : rng() * warm;
  const sW = t0();
  let t = 0, dt = 0;
  while (t < warmK && !state.gameOver) {
    tick(state, STEP, rng);
    t += STEP;
    dt -= STEP;
    if (state.upgradePending) pickUpgrade(state, noopLog, rng);
    if (dt <= 0) { dt = 0.4; decide(state, noopLog); }
  }
  add('warm', sW);
  if (state.gameOver) return doReset(seed, 0); // bot died in warmup — cold retry
  prevExcess = excessPressure(state);
  prevHungerP = hungerPressure(state);
  prevCoverP = coveragePressure(state);
  lastSnapWeek = state.week;
  return respond(0, false);
}

function respond(reward, done) {
  let s = t0();
  const acts = done ? [] : enumerate(state); // terminal obs is discarded client-side
  add('enum', s);
  const info = {
    week: state.week, time: +state.time.toFixed(1),
    delivered: state.delivered, freight: state.freightDelivered,
    buildings: state.buildings.size,
    reason: state.gameOver?.reason ?? null,
    steps, level: state.level,
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
let epActs = {}, epActsFail = {},
    epTiles = 0, epBridges = 0, epUpgrades = [], epOffers = [];

function doStep(aIdx) {
  if (!pending) throw new Error(
    'step with no live action frame (pre-reset or post-bcstep) — reset first');
  const acts = pending;
  steps++;
  let bonus = 0;
  if (aIdx >= 0 && aIdx < acts.length) {
    const rt0 = state.roadTiles, br0 = state.bridges ?? 0;
    try { bonus = acts[aIdx].apply() || 0; } catch (e) { /* bad apply = wasted action */ }
    epActs[acts[aIdx].type] = (epActs[acts[aIdx].type] ?? 0) + 1;
    // a zero-returning apply did nothing (buildRoad rejected, slot race) —
    // count it apart so "actions taken" doesn't read as "actions succeeded"
    if (!bonus && acts[aIdx].type !== 'noop')
      epActsFail[acts[aIdx].type] = (epActsFail[acts[aIdx].type] ?? 0) + 1;
    epTiles += rt0 - state.roadTiles;
    epBridges += br0 - (state.bridges ?? 0);
  }
  const d0 = state.delivered, f0 = state.freightDelivered;
  const tPrev = state.time;
  const sT = t0();
  let t = 0, guard = 0;
  while (t < DECIDE_DT - 1e-9 && !state.gameOver && !state.upgradePending && guard++ < 240) {
    tick(state, STEP, rng);
    t += STEP;
  }
  add('tick', sT);
  let reward = 0.02 * t + 0.1 * (state.delivered - d0) +
    0.15 * (state.freightDelivered - f0) + bonus;
  const ex = excessPressure(state);
  reward += 2.0 * (prevExcess - ex); // meter-relief shaping
  prevExcess = ex;
  if (FOODSHAPE) {
    const hp = hungerPressure(state);
    reward += 3.0 * (prevHungerP - hp);   // hunger relief pays more than the mixed meter
    reward += 0.3 * fedThisStep(state, tPrev); // chain worked end-to-end
    prevHungerP = hp;
  }
  if (COVERSHAPE) {
    const cp = coveragePressure(state);
    reward += 2.5 * (prevCoverP - cp); // a home gaining market coverage pays
    prevCoverP = cp;
  }
  // archive at each week boundary — one deep clone per env per week (~ms),
  // bounded; when full a random slot is replaced so all eras stay represented
  if (RESTORE > 0 && !state.gameOver && state.week !== lastSnapWeek) {
    lastSnapWeek = state.week;
    const entry = { snap: deepClone(state), week: state.week };
    if (archive.length < ARCHIVE_CAP) archive.push(entry);
    else archive[Math.floor(rng() * archive.length)] = entry;
  }
  const done = !!state.gameOver || state.time >= MAX_SECONDS;
  // the game's actual objective as a terminal bonus — shaped meter relief
  // alone leaves the agent indifferent to crossing star thresholds
  const stars = (CONFIG.win?.stars ?? [5, 8, 11])
    .filter((w) => state.week >= w).length;
  if (done) reward += stars;
  if (state.gameOver) reward -= 2;
  const r = respond(reward, done);
  if (done) {
    r.info.stars = stars;
    r.info.mapp = mapParams(state.level).map((v) => +v.toFixed(4));
    r.info.acts = { ...epActs };
    if (Object.keys(epActsFail).length) r.info.actsFailed = { ...epActsFail };
    r.info.tilesSpent = epTiles;
    r.info.bridgesSpent = epBridges;
    r.info.lines = state.lines.size;
    if (epRestored) r.info.restored = epRestored; // week the branch started from
    // food-chain postmortem: which link was broken when the episode ended —
    // unassigned homes can't be reached by any same-colour staffed market,
    // unstaffed farms make no crates, empty markets dispatch no trucks
    let homes = 0, hungry = 0, unassigned = 0, markets = 0, mktStaffed = 0,
        mktStock = 0, farms = 0, farmStaffed = 0, trucks = 0, fleet = 0, hiredDrv = 0,
        couriersFly = 0, shuttlesFly = 0;
    for (const b of state.buildings.values()) {
      if (!b.active) continue;
      if (b.type === 'home') {
        homes++;
        if (b.hungerT > CONFIG.food.hungryAt) hungry++;
        if (b.assignedMarket == null) unassigned++;
      } else if (b.type === 'market') {
        markets++;
        mktStock += b.stock || 0;
        fleet += b.trucks || 0;
        if (b.workers.length > 0 || (b.hired ?? []).some((x) => x > state.time)) mktStaffed++;
        hiredDrv += (b.hired ?? []).filter((x) => x > state.time).length;
        trucks += b.activeTrucks || 0;
      } else if (b.type === 'farm') {
        farms++;
        if (b.workers.length >= CONFIG.food.workersNeeded) farmStaffed++;
      }
    }
    for (const v of state.vehicles.values()) {
      if (v.kind === 'courier') couriersFly++;
      else if (v.kind === 'shuttle') shuttlesFly++;
    }
    r.info.food = { homes, hungry, unassigned, markets, mktStaffed, mktStock,
                    farms, farmStaffed, trucks, fleet, hiredDrv,
                    courierFed: state.courierFed || 0, couriersFly,
                    shuttleArr: state.shuttleArr || 0, shuttlesFly };
    r.info.upgrades = epUpgrades;
    r.info.upgradeOffers = epOffers;
  }
  pending = r._acts;
  return r;
}

// ---- BC collection ---------------------------------------------------------
// bcstep: enumerate + encode the pre-decision obs, let the heuristic bot
// decide, map its ops back to enum indices via state-diff, then tick forward
// one decision window. Returns the PRE-decide frame + meta.info.choices so
// (obs, feats, aIdx) tuples stream straight into BC training.

function botOps(snapE, snapL, snapJ, snapLight, snapMoto, snapRa, logBuf) {
  // snapE: Map(edgeId → Set(cellKey)) — needed to tell a true demolish
  // (its cells are left bare) from a merge/split (cells still covered by
  // the new edge buildRoad produced). Phantom demolishes otherwise fire
  // on every merged build.
  const ops = [];
  const newCells = new Set();
  const covered = new Set();
  for (const e of state.roadEdges.values())
    for (const c of cellsAlongPolyline(e.pts ?? [])) covered.add(cellKey(c));
  const goneL = new Set(snapL.keys()), goneJ = new Set(snapJ);
  for (const e of state.roadEdges.values()) {
    if (!snapE.has(e.id)) {
      // motorway/roundabout edges are 'special' ops, not road draws
      if (!e.motorway && !e.roundabout)
        for (const c of cellsAlongPolyline(e.pts ?? [])) newCells.add(cellKey(c));
    }
    if (e.motorway && !snapMoto.has(e.id)) ops.push({ kind: 'special', spec: 'motorway', x: e.pts?.[0]?.x ?? 0, y: e.pts?.[0]?.y ?? 0 });
    if (e.roundabout && !snapRa.has(e.id)) ops.push({ kind: 'special', spec: 'roundabout', x: e.pts?.[0]?.x ?? 0, y: e.pts?.[0]?.y ?? 0 });
    snapE.delete(e.id); // survivors drop out of the gone-tracking
  }
  for (const [id, cells] of snapE) {
    let bare = false;
    for (const k of cells) if (!covered.has(k)) { bare = true; break; }
    if (bare) ops.push({ kind: 'demolish', eid: id });
  }
  for (const l of state.lines.values()) {
    if (!snapL.has(l.id) || l.stops.length > snapL.get(l.id))
      ops.push({ kind: 'line', stops: l.stops });
    goneL.delete(l.id);
  }
  for (const b of state.buildings.values()) {
    if (b.type === 'junction') {
      if (!snapJ.has(b.id)) ops.push({ kind: 'junction', x: b.x, y: b.y });
      goneJ.delete(b.id);
    }
  }
  for (const n of state.roadNodes.values())
    if (n.light && !snapLight.has(n.id)) ops.push({ kind: 'special', spec: 'light', x: n.x, y: n.y });
  if (newCells.size) ops.push({ kind: 'road', cells: newCells });
  for (const id of goneL) ops.push({ kind: 'demolish', lid: id });
  for (const id of goneJ) ops.push({ kind: 'demolish', jid: id });
  for (const s of logBuf) {
    const m = /^upgrade: "(.+?)"/.exec(s);
    if (m) ops.push({ kind: 'upgradeName', name: m[1] });
  }
  return ops;
}

function matchOps(acts, ops) {
  const used = new Set(), choices = [], unmappedKinds = [];
  let unmapped = 0;
  for (const op of ops) {
    let bestI = -1, bestScore = 0;
    for (let i = 0; i < acts.length; i++) {
      const co = acts[i].op;
      if (!co || used.has(i)) continue;
      let sc = 0;
      if (op.kind === 'road' && co.kind === 'road') {
        let hit = 0;
        for (const c of co.cells) if (op.cells.has(cellKey(c))) hit++;
        sc = hit / Math.max(1, co.cells.length);
        if (sc < 0.4) sc = 0;
      } else if (op.kind === 'line' && co.kind === 'line') {
        const a = op.stops, b = co.stops;
        sc = a.length === b.length && a.every((s, i) => s === b[i]) ? 1 :
             (a[0] === b[0] && a[a.length - 1] === b[b.length - 1] ? 0.5 : 0);
      } else if (op.kind === 'demolish' && co.kind === 'demolish') {
        sc = (op.eid != null && co.eid === op.eid) || (op.lid != null && co.lid === op.lid) ||
             (op.jid != null && co.jid === op.jid) ? 1 : 0;
      } else if (op.kind === 'junction' && co.kind === 'junction') {
        sc = Math.hypot(co.x - op.x, co.y - op.y) <= 40 ? 1 : 0;
      } else if (op.kind === 'special' && co.kind === 'special' && co.spec === op.spec) {
        sc = Math.hypot(co.x - op.x, co.y - op.y) <= 120 ? 1 : 0;
      } else if (op.kind === 'upgradeName' && co.kind === 'upgrade') {
        sc = co.name === op.name ? 1 : 0;
      }
      if (sc > bestScore) { bestScore = sc; bestI = i; }
    }
    if (bestI >= 0) { used.add(bestI); choices.push(bestI); }
    else { unmapped++; unmappedKinds.push(op.kind + (op.spec ? ':' + op.spec : '')); }
  }
  if (!ops.length) {
    const i = acts.findIndex((a) => a.op?.kind === 'noop');
    if (i >= 0) choices.push(i);
  }
  return { choices, unmapped, unmappedKinds };
}

function doBcStep() {
  const acts = enumerate(state);
  const obs = encodeObs(state), feats = packFeats(acts);
  const snapE = new Map();
  for (const e of state.roadEdges.values()) {
    const cs = new Set();
    for (const c of cellsAlongPolyline(e.pts ?? [])) cs.add(cellKey(c));
    snapE.set(e.id, cs);
  }
  const snapL = new Map([...state.lines.values()].map((l) => [l.id, l.stops.length]));
  const snapJ = new Set([...state.buildings.values()].filter((b) => b.type === 'junction').map((b) => b.id));
  const snapLight = new Set([...state.roadNodes.values()].filter((n) => n.light).map((n) => n.id));
  const snapMoto = new Set([...state.roadEdges.values()].filter((e) => e.motorway).map((e) => e.id));
  const snapRa = new Set([...state.roadEdges.values()].filter((e) => e.roundabout).map((e) => e.id));
  const logBuf = [];
  const lg = (s) => logBuf.push(s);
  if (state.upgradePending) pickUpgrade(state, lg, rng, state._offers);
  else decide(state, lg);
  const ops = botOps(snapE, snapL, snapJ, snapLight, snapMoto, snapRa, logBuf);
  const { choices, unmapped, unmappedKinds } = matchOps(acts, ops);
  const sT = t0();
  let t = 0, guard = 0;
  while (t < DECIDE_DT - 1e-9 && !state.gameOver && !state.upgradePending && guard++ < 240) {
    tick(state, STEP, rng); t += STEP;
  }
  add('tick', sT);
  const done = !!state.gameOver || state.time >= MAX_SECONDS;
  pending = null;
  return {
    obs, feats, reward: 0, done,
    info: {
      week: state.week, time: +state.time.toFixed(1),
      reason: state.gameOver?.reason ?? null,
      steps, level: state.level,
      choices, unmapped, unmappedKinds, ops: ops.map((o) => o.kind),
    },
  };
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
    } else if (msg.cmd === 'bcstep') {
      T.n++;
      const r = doBcStep();
      process.stdout.write(serialize(r));
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
