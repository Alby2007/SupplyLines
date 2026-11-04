// Headless OPTIMAL autoplayer: plays the game as well as the mechanics allow
// — connects everything, triages by time-to-death, uses lines to rescue
// unroutable buildings, spends every special item — then writes a postmortem
// explaining why it died and whether the death was fair:
//   fair   = warned in time AND avoidable (resources existed) → player error
//   unfair = no warning window, physically impossible demand, or a game bug
//
//   node autoplay.mjs --seed=1            one run, full postmortem + timeline
//   node autoplay.mjs --runs=20           N seeds, aggregate table
//   node autoplay.mjs --seed=1 --verbose  every decision logged
//
// The sim is the real thing — same modules, same tick order as main.js —
// so whatever kills the bot is what would kill a player.

import { CONFIG, applyLevelOverrides } from './src/config.js';
import { createState, applyLevelFeatures } from './src/state.js';
import * as spawn from './src/spawn.js';
import * as economy from './src/economy.js';
import * as food from './src/food.js';
import * as agents from './src/agents.js';
import * as vehicles from './src/vehicles.js';
import { UPGRADES } from './src/ui.js';
import { buildRoad, roadCellCost, roadCellIndex, bridgeCost } from './src/roads.js';
import { placeRoundabout } from './src/roundabouts.js';
import { placeTrafficLight } from './src/lights.js';
import { buildMotorway } from './src/motorways.js';
import {
  addLine, addJunction, insertJunction, junctionPlacement,
} from './src/networks.js';
import { addTrain, awardConnectionTrains, addBusLine } from './src/vehicles.js';
import {
  cellOf, cellCenter, cellKey, cellsBetween, buildingCells, nearestOnPolyline,
} from './src/grid.js';
import { findPath, roadDistancesFrom } from './src/routing.js';
import { pathToFileURL } from 'node:url';

// ---- args ---------------------------------------------------------------
const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split('=')[1] : d;
};
const RUNS = +arg('runs', 0);
const SEED = +arg('seed', 1);
const LEVEL = +arg('level', 1);
const VERBOSE = process.argv.includes('--verbose');
applyLevelOverrides(LEVEL); // same merge the browser boot does
const MAX_SECONDS = +arg('maxWeeks', 25) * CONFIG.weekSeconds;

// --tune=demand.growth=0.35,demand.promoteEvery=14 — config overrides for
// balance experiments; applied before the sim starts so everything sees them
for (const m of process.argv.filter((a) => a.startsWith('--tune='))) {
  for (const kv of m.slice(7).split(',')) {
    const [path, val] = kv.split('=');
    const parts = path.split('.');
    let o = CONFIG;
    while (parts.length > 1) o = o[parts.shift()];
    // `path=*1.3` multiplies the current (post-level-override) value — the
    // same semantics as the worker's RL_* difficulty multipliers, so bot
    // baselines can be probed under identical difficulty
    if (val.startsWith('*')) o[parts[0]] *= +val.slice(1);
    else o[parts[0]] = JSON.parse(val);
  }
}

// ---- seeded RNG (mulberry32) — deterministic runs ------------------------
function srand(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STEP = 1 / 60;

// the real game tick — mirrors main.js tick() exactly (1× pace)
function tick(state, dt) {
  state.time += dt;
  state.weekT += dt;
  if (state.weekT >= CONFIG.weekSeconds) {
    state.weekT = 0;
    state.week++;
    state.upgradePending = true;
    // freight-linked budget (T1): weekly crates earn bonus tiles —
    // RL_FREIGHTTILES overrides the rate for probes / 0 ablates the
    // mechanic for pre-mechanic checkpoint evaluation
    const frate = process.env.RL_FREIGHTTILES != null
      ? +process.env.RL_FREIGHTTILES : (CONFIG.roads.freightTiles ?? 0);
    const fDelta = state.freightDelivered - (state.freightWeek0 ?? 0);
    state.roadTiles = Math.min(CONFIG.roads.tilesCap,
      state.roadTiles + CONFIG.roads.tilesPerWeek + frate * fDelta);
    state.freightWeek0 = state.freightDelivered;
  }
  const PH = process.env.BOTPHASE
    ? (name) => { if (name) console.log(`t=${state.time.toFixed(2)} phase=${name}`); }
    : () => {};
  if (!process.env.BOTNOSPAWN) { PH('spawn'); spawn.update(state, dt); }
  if (!process.env.BOTNOECON) { PH('economy'); economy.update(state, dt); }
  if (!process.env.BOTNOFOOD) { PH('food'); food.update(state, dt); }
  if (!process.env.BOTNOAGENTS) { PH('agents'); agents.update(state, dt); }
  if (!process.env.BOTNOVEH) { PH('vehicles'); vehicles.update(state, dt); }
}

// ---- grid / roads ---------------------------------------------------------

// read at call time — applyLevelOverrides changes CONFIG.map per level, so a
// fixed const baked at module load would be wrong when imported as a library
const gridCols = () => Math.floor(CONFIG.map.width / CONFIG.grid.cell);
const gridRows = () => Math.floor(CONFIG.map.height / CONFIG.grid.cell);

const served = (b) => b.roadNodeId != null;

// cells a road must not cross — junction cells reject the whole draw. Water
// is NOT blocked: pathToRoad treats it as a bridge spend, not a wall
function blockedCells(state) {
  const s = new Set();
  for (const b of state.buildings.values()) {
    if (b.type === 'junction') for (const c of buildingCells(b)) s.add(cellKey(c));
  }
  return s;
}

// edge → component map plus the component id holding the most building
// anchors — the "main network" every draw should land on
function edgeComponents(state) {
  const comp = new Map(); // edgeId → component id
  let ncomp = 0;
  for (const e of state.roadEdges.values()) {
    if (comp.has(e.id)) continue;
    const cid = ++ncomp;
    const stack = [e.id];
    comp.set(e.id, cid);
    while (stack.length) {
      const cur = state.roadEdges.get(stack.pop());
      for (const nid of [cur.a, cur.b]) {
        for (const eid of state.roadNodes.get(nid)?.edges ?? []) {
          if (!comp.has(eid)) { comp.set(eid, cid); stack.push(eid); }
        }
      }
    }
  }
  const score = new Map(); // comp → building-attached nodes
  for (const n of state.roadNodes.values()) {
    if (n.bid == null || !n.edges.length) continue;
    const cid = comp.get(n.edges[0]);
    if (cid != null) score.set(cid, (score.get(cid) ?? 0) + 1);
  }
  let best = null, n = 0;
  for (const [cid, s] of score) if (s > n) { n = s; best = cid; }
  return { comp, best };
}

function componentCells(roadIdx, comp, best) {
  const goal = new Map();
  for (const [k, refs] of roadIdx) {
    if (refs.some((r) => comp.get(r.edgeId) === best)) goal.set(k, refs);
  }
  return goal;
}

// cells of the largest building-anchored road component. Connecting anywhere
// else just grows an island detached from the city — roadDistancesFrom can't
// cross components, so an islanded home reads "connected" but starves with
// no market assignment. Null when no component has buildings yet.
function mainComponentCells(state, roadIdx) {
  const { comp, best } = edgeComponents(state);
  if (best == null) return null;
  return componentCells(roadIdx, comp, best);
}

// node ids on the main component — served() only checks roadNodeId, so a
// building anchored to a stub still reads "connected" when the stub is an
// island the planner mistook for the network
function mainComponentNodes(state, comp, best) {
  if (best == null) return null;
  const out = new Set();
  for (const n of state.roadNodes.values()) {
    if (n.edges.length && comp.get(n.edges[0]) === best) out.add(n.id);
  }
  return out;
}

// endpoint anchors are geometric (26px) while the planner thinks in cells —
// a goal cell whose centre sits >snap from every node/edge lands the draw
// beside the network instead of on it, orphaning the building on a stub that
// reads "connected". Keep only goal cells a draw can actually merge into.
function mergeableGoalCells(state, goal, mainNodes) {
  if (!goal) return goal;
  const nodeCells = new Map();
  for (const n of state.roadNodes.values()) {
    if (!mainNodes.has(n.id)) continue;
    const k = cellKey(cellOf(n));
    (nodeCells.get(k) ?? nodeCells.set(k, []).get(k)).push(n);
  }
  const out = new Map();
  for (const [k, refs] of goal) {
    const [cx, cy] = k.split(',').map(Number);
    const c = cellCenter(cx, cy);
    let ok = (nodeCells.get(k) ?? []).some(
      (n) => Math.hypot(n.x - c.x, n.y - c.y) <= CONFIG.roads.snap);
    for (const r of refs) {
      if (ok) break;
      const e = state.roadEdges.get(r.edgeId);
      if (e && !e.motorway && nearestOnPolyline(e.pts, c).d <= CONFIG.roads.snap) ok = true;
    }
    if (ok) out.set(k, refs);
  }
  return out;
}

// tiny binary heap keyed by .d
function heap() {
  const a = [];
  const up = (i) => { while (i && a[(i - 1) >> 1].d > a[i].d) { const j = (i - 1) >> 1;[a[i], a[j]] = [a[j], a[i]]; i = j; } };
  return {
    push(n) { a.push(n); up(a.length - 1); },
    get size() { return a.length; },
    pop() {
      const top = a[0], last = a.pop();
      if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l].d < a[m].d) m = l; if (r < a.length && a[r].d < a[m].d) m = r; if (m === i) break;[a[i], a[m]] = [a[m], a[i]]; i = m; } }
      return top;
    },
  };
}

// dijkstra over grid cells: reusing existing road costs ~0 — it spends tiles
// the way a good player would, consolidating onto established streets.
// goalIdx narrows which road cells count as landings (default: any).
// Water cells are traversable at a steep step cost — each uncovered one is a
// bridge spend, so crossings win only when the land route is worse (river
// spans the whole map height: crossing IS the route). If the cheapest plan
// needs more bridges than we hold, retry land-only before giving up.
// opts.wetCost replaces the water step cost; opts.penalty(k) is a multiplicative
// per-cell surcharge (>=0) — the RL env uses it to plan congestion-shy alternates.
// Returns a cell path (building → road), or null.
function pathToRoad(state, fromCells, roadIdx, blocked, goalIdx = null, opts = null) {
  const goal = goalIdx ?? roadIdx;
  const water = state.water;
  const wetCost = opts?.wetCost ?? 4;
  const penalty = opts?.penalty ?? null;
  const run = (wetOk) => {
    const dist = new Map();
    const prev = new Map();
    const pq = heap();
    for (const c of fromCells) {
      const k = cellKey(c);
      dist.set(k, 0);
      pq.push({ k, cx: c.cx, cy: c.cy, d: 0 });
    }
    let found = null;
    while (pq.size) {
      const cur = pq.pop();
      if (cur.d > (dist.get(cur.k) ?? Infinity)) continue;
      if (goal.has(cur.k)) { found = cur; break; }
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          const nx = cur.cx + dx, ny = cur.cy + dy;
          if (nx < 0 || ny < 0 || nx >= gridCols() || ny >= gridRows()) continue;
          const nk = cellKey({ cx: nx, cy: ny });
          if (blocked.has(nk)) continue;
          const wet = water?.has(nk) && !roadIdx.has(nk);
          if (wet && !wetOk) continue;
          const step = Math.hypot(dx, dy) *
            (roadIdx.has(nk) ? 0.2 : wet ? wetCost : 1) *
            (1 + (penalty ? penalty(nk) : 0));
          const nd = cur.d + step;
          if (nd < (dist.get(nk) ?? Infinity)) {
            dist.set(nk, nd);
            prev.set(nk, cur.k);
            pq.push({ k: nk, cx: nx, cy: ny, d: nd });
          }
        }
      }
    }
    if (!found) return null;
    const cells = [];
    let k = found.k;
    while (k) {
      const [cx, cy] = k.split(',').map(Number); // cellKey is "cx,cy"
      cells.unshift({ cx, cy });
      k = prev.get(k);
    }
    return cells;
  };
  const cells = run((state.bridges ?? 0) > 0);
  // bridge-winning but unaffordable — a dry route may still connect (or the
  // goal genuinely lives across the river and this draw must wait)
  if (cells && bridgeCost(state, cells) > (state.bridges ?? 0)) return run(false);
  return cells;
}

// connect-plan memo — a building's path to the network is a pure function of
// topology (netVersion bumps on every edge/line/junction edit) and bridge
// stock (a wet plan is only valid while affordable). A stale entry can only
// be suboptimal, never invalid: shared cells still merge when buildRoad runs.
const _planCache = new Map();
let _planState = null, _planKey = '';
function cachedPlan(state, tag, fn) {
  const key = `${state.netVersion}:${state.bridges ?? 0}`;
  if (state !== _planState || key !== _planKey) {
    _planCache.clear(); _planState = state; _planKey = key;
  }
  if (!_planCache.has(tag)) _planCache.set(tag, fn());
  return _planCache.get(tag);
}

// seconds until this building kills you (Infinity when safe)
function ettl(state, b, foodEra) {
  let t = Infinity;
  if (b.waiting.length >= b.capacity) t = Math.min(t, CONFIG.overflowLimit - b.overflowT);
  if (b.type === 'work') t = Math.min(t, (CONFIG.demand.limit - b.demandT) / CONFIG.demand.rate);
  if (b.type === 'home' && foodEra) t = Math.min(t, CONFIG.food.hungerLimit - b.hungerT);
  if (!served(b) && b.active) t = Math.min(t, 60); // unserved is always urgent
  return t;
}

function tryConnect(state, b, log) {
  const own = buildingCells(b);
  const roadIdx = roadCellIndex(state);
  // cells already road → served (active) or served at activation (pending);
  // without this guard we'd pile duplicate roads on the same cells forever
  if (own.some((c) => roadIdx.has(cellKey(c))) || b._botRouted) return false;
  let cells;
  if (!roadIdx.size) {
    let other = null, od = Infinity;
    for (const o of state.buildings.values()) {
      if (o === b || o.type === 'junction') continue;
      const d = Math.hypot(o.x - b.x, o.y - b.y);
      if (d < od) { od = d; other = o; }
    }
    if (!other) return false;
    cells = cellsBetween(cellOf(b), cellOf(other));
    // the straight draw may cross junctions (buildRoad rejects) or water
    // (spends bridges — pick the cheap crossing with the grid Dijkstra)
    const blk = blockedCells(state);
    if (cells.some((c) => blk.has(cellKey(c)) || state.water?.has(cellKey(c)))) {
      const goal = new Map(buildingCells(other).map((c) => [cellKey(c), []]));
      cells = pathToRoad(state, own, goal, blk) ?? cells;
    }
  } else {
    if (process.env.BOTTRACE) console.log(`pathToRoad start ${b.type}#${b.id}`);
    // land on the main network — and only on cells a draw can actually merge
    // into, so the endpoint never stubs out a few px short of the edge
    cells = cachedPlan(state, `connect:${b.id}`, () => {
      const { comp, best } = edgeComponents(state);
      const goal = mergeableGoalCells(
        state, componentCells(roadIdx, comp, best), mainComponentNodes(state, comp, best));
      return pathToRoad(state, own, roadIdx, blockedCells(state), goal);
    });
    if (process.env.BOTTRACE) console.log(`pathToRoad done ${b.type}#${b.id} cells=${cells?.length}`);
  }
  if (!cells || cells.length < 2) return false;
  const cost = roadCellCost(state, cells);
  if (cost > state.roadTiles) {
    b._botWantedRoad = true; // postmortem: connection wanted but unaffordable
    return false;
  }
  const wet = bridgeCost(state, cells);
  if (wet > (state.bridges ?? 0)) {
    b._botWantedBridge = true; // postmortem: river crossing out of stock
    return false;
  }
  if (process.env.BOTTRACE) {
    console.log(`build: ${b.type}#${b.id} cells=${cells.length} cost=${cost} tiles=${state.roadTiles} edges=${state.roadEdges.size}`);
  }
  const edges = buildRoad(state, cells);
  if (process.env.BOTTRACE) console.log(`  → edges=${edges.length} total=${state.roadEdges.size}`);
  if (process.env.BOTTRACE) {
    for (const e of state.roadEdges.values()) {
      for (const p of e.pts) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
          console.log(`POISON edge#${e.id} a=${e.a} b=${e.b}`, JSON.stringify(e.pts));
          break;
        }
      }
      if (e.pts.some((p) => !p || !Number.isFinite(p.x))) {
        console.log(`BADPT edge#${e.id}`, JSON.stringify(e.pts));
      }
    }
    for (const n of state.roadNodes.values()) {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
        console.log(`POISON node#${n.id}`, JSON.stringify(n));
      }
    }
  }
  if (!edges.length) return false;
  state.roadTiles -= cost;
  b._botRouted = true; // one draw per building — the network keeps it served
  log(`road: ${b.type}#${b.id} (${edges.length} edges, -${cost} tiles → ${state.roadTiles}` +
    `${wet ? `, -${wet} bridges → ${state.bridges}` : ''})`);
  return true;
}

// joining a new line through an existing one at a junction earns the older
// line a free train — always splice an interchange when the paths cross
function junctionJoin(state, stops) {
  const a = state.buildings.get(stops[0]);
  const b = state.buildings.get(stops[stops.length - 1]);
  if (!a || !b) return null;
  // sample the chord for a spot on another line's track in a free cell
  for (const f of [0.3, 0.5, 0.7, 0.4, 0.6]) {
    const p = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    const hit = junctionPlacement(state, p);
    if (hit) return hit;
  }
  return null;
}

// insert a junction stop where it adds the least travel distance
function insertStop(state, stops, jid) {
  const dist = (x, y) =>
    Math.hypot(state.buildings.get(x).x - state.buildings.get(y).x,
               state.buildings.get(x).y - state.buildings.get(y).y);
  let best = null, bd = Infinity;
  for (let i = 1; i <= stops.length; i++) {
    const s = [...stops.slice(0, i), jid, ...stops.slice(i)];
    const d = s.slice(1).reduce((sum, id, k) => sum + dist(s[k], id), 0);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

function newLine(state, stops, log, why) {
  const lineColor =
    stops.map((id) => state.buildings.get(id)?.color).find((c) => c != null) ?? null;
  if (stops.length === 2) {
    const hit = junctionJoin(state, stops);
    if (hit) {
      const j = addJunction(state, hit.x, hit.y, lineColor);
      insertJunction(state, j, hit.line, hit.segIdx);
      stops = insertStop(state, stops, j.id);
      log(`junction interchange onto line ${hit.line.id} (free train)`);
    }
  }
  const line = addLine(state, stops);
  addTrain(state, line);
  awardConnectionTrains(state, line);
  log(`line${line.freight ? ' (freight)' : ''}: ${stops.join('→')} — ${why}`);
  return line;
}

const onLine = (state, bid) =>
  [...state.lines.values()].filter((l) => l.stops.includes(bid));

// maxLines budgets RAIL — bus routes ride the road network under their own cap
const railCount = (state) =>
  [...state.lines.values()].filter((l) => !l.bus).length;
const busCount = (state) =>
  [...state.lines.values()].filter((l) => l.bus).length;

const avgDist = (b, list) =>
  list.length
    ? list.reduce((s, h) => s + Math.abs(h.x - b.x) + Math.abs(h.y - b.y), 0) / list.length
    : 0;

// the minimal food backbone: one connected market per home colour plus one
// farm. Every extra connected food building claims its nearest homes AND
// draws workers into shift-lock — over-connecting starves offices of
// commuters while splitting the same home coverage across more staff.
function backboneWanted(state) {
  const wanted = new Set();
  const all = [...state.buildings.values()];
  const homes = all.filter((b) => b.type === 'home');
  const markets = all.filter((b) => b.type === 'market');
  for (const c of new Set(homes.map((h) => h.color))) {
    const cHomes = homes.filter((h) => h.color === c);
    const cMarkets = markets.filter((m) => m.color === c);
    if (!cMarkets.length) continue;
    const connected = cMarkets.filter(served);
    // more markets are worth their staffing drain once the colour outgrows
    // what one market's trucks can cover (~8 homes), or when staffed markets
    // are starving homes — truck-throughput problems, not coverage problems.
    // Never expand while current markets can't even hold staff.
    const starving = cHomes.filter((h) => h.hungerT > CONFIG.food.hungryAt).length;
    const allStaffed = connected.length > 0 &&
      connected.every((m) => m.workers.length >= CONFIG.food.workersNeeded);
    const byHomes = Math.max(1, Math.ceil(cHomes.length / 8));
    const target = connected.length === 0
      ? 1
      : Math.min(cMarkets.length,
          allStaffed
            ? Math.max(byHomes, starving >= 2 ? connected.length + 1 : connected.length)
            : connected.length);
    // prefer already-connected markets (no churn), then closest to the homes
    cMarkets.sort((a, b) => (served(b) - served(a)) || (avgDist(a, cHomes) - avgDist(b, cHomes)));
    for (const m of cMarkets.slice(0, target)) wanted.add(m.id);
  }
  if (wanted.size) {
    const farms = all.filter((b) => b.type === 'farm');
    // one farm tops out at ~10 crates/min — about a dozen homes' worth of
    // food. Scale the backbone so production always has headroom.
    const farmTarget = Math.min(farms.length, Math.max(1, Math.ceil(homes.length / 12)));
    farms.sort((a, b) => (served(b) - served(a)) || (avgDist(a, homes) - avgDist(b, homes)));
    for (const f of farms.slice(0, farmTarget)) wanted.add(f.id);
  }
  return wanted;
}

// can the agent's needs be met at all right now?
function reachable(state, a, fromBid) {
  const matchers = a.kind === 'crate'
    ? [(b) => b.type === 'market' && b.active]
    : Array.isArray(a.dest) ? a.dest : [a.dest];
  const opts = a.kind === 'person' ? { lineColor: a.color } : { freight: true };
  return matchers.some((m) => findPath(state, fromBid, m, opts));
}

function tryLines(state, log) {
  if (railCount(state) >= state.maxLines) return;
  const wanted = backboneWanted(state);

  // 1) freight: crates only ever flow to markets on the freight network —
  //    a staffed market off the rail starves its homes just the same. One
  //    line must route the farm through EVERY backbone market.
  const backboneFarm = (f) => f.type === 'farm' && (wanted.has(f.id) || served(f));
  const backboneMkt = (m) => m.type === 'market' && (wanted.has(m.id) || served(m));
  const freightStops = new Set();
  for (const l of state.lines.values()) {
    if (l.freight) for (const s of l.stops) freightStops.add(s);
  }
  const farm = [...state.buildings.values()].find((f) => backboneFarm(f) && f.active);
  const mkts = () =>
    [...state.buildings.values()]
      .filter((m) => backboneMkt(m) && m.active)
      .sort((a, b) =>
        Math.hypot(a.x - farm.x, a.y - farm.y) - Math.hypot(b.x - farm.x, b.y - farm.y));
  if (farm && !freightStops.has(farm.id)) {
    const ms = mkts();
    if (ms.length) {
      newLine(state, [farm.id, ...ms.map((m) => m.id)], log, `farm rail (${ms.length} markets)`);
      return;
    }
  }
  // a backbone market left off the freight net needs its own hop
  if (farm && freightStops.has(farm.id)) {
    const ms = mkts().filter((m) => !freightStops.has(m.id));
    if (ms.length) {
      newLine(state, [farm.id, ms[0].id], log, `farm rail → market#${ms[0].id}`);
      return;
    }
  }

  // passenger lines must leave one slot for farm rail while it's still owed
  const railOwed =
    farm != null && mkts().length > 0 &&
    (!freightStops.has(farm.id) || mkts().some((m) => !freightStops.has(m.id)));
  const passengerBudget = state.maxLines - railCount(state) - (railOwed ? 1 : 0);
  if (passengerBudget <= 0) return;

  // 2) rescue: a building queueing unroutable agents gets a direct line to a
  //    valid destination — transit needs no road at the stops
  for (const b of state.buildings.values()) {
    if (!b.active || b.type === 'junction' || !b.waiting.length) continue;
    const a = state.agents.get(b.waiting[0]);
    if (!a || a.kind !== 'person' || a.color == null) continue;
    if (onLine(state, b.id).length) continue; // already rescued — let it work
    if (reachable(state, a, b.id)) continue; // routable — queue is a capacity
    // find its wanted destination type and build a stop there
    const dests = (Array.isArray(a.dest) ? a.dest : [a.dest])
      .flatMap((m) => [...state.buildings.values()].filter(m));
    if (!dests.length) continue;
    let dBest = null, dd = Infinity;
    for (const d of dests) {
      if (d.id === b.id) continue; // already there — a self-line rescues nothing
      const dist = Math.hypot(d.x - b.x, d.y - b.y);
      if (dist < dd) { dd = dist; dBest = d; }
    }
    if (!dBest) continue;
    newLine(state, [b.id, dBest.id], log, `rescue unroutable queue at ${b.type}#${b.id}`);
    return;
  }

  // 3) lifeline: a work whose meter is climbing needs commuter throughput
  //    NOW — a same-colour shuttle from its farthest connected home beats
  //    every car making that trip under congestion
  let hot = null;
  for (const w of state.buildings.values()) {
    if (w.type !== 'work' || !w.active || (w.demandT ?? 0) < 30) continue;
    if (onLine(state, w.id).length) continue;
    let bh = null, bd = 180;
    for (const h of state.buildings.values()) {
      if (h.type !== 'home' || !h.active || h.color !== w.color) continue;
      if (!served(h) || onLine(state, h.id).length) continue;
      const d = Math.hypot(h.x - w.x, h.y - w.y);
      if (d > bd) { bd = d; bh = h; }
    }
    if (bh && w.demandT > (hot?.w.demandT ?? -1)) hot = { w, h: bh };
  }
  if (hot) {
    newLine(state, [hot.h.id, hot.w.id], log,
      `lifeline work#${hot.w.id} d${Math.round(hot.w.demandT)}`);
    return;
  }

  // 4) passenger line for the longest same-colour commute — cheap capacity
  let best = null;
  for (const h of state.buildings.values()) {
    if (h.type !== 'home' || !h.active || h.color == null) continue;
    if (onLine(state, h.id).length) continue;
    for (const w of state.buildings.values()) {
      if (w.type !== 'work' || !w.active || w.color !== h.color) continue;
      if (onLine(state, w.id).length) continue;
      const d = Math.hypot(w.x - h.x, w.y - h.y);
      if (d > 240 && (!best || d > best.d)) best = { h, w, d };
    }
  }
  if (best) {
    newLine(state, [best.h.id, best.w.id], log,
      `color${best.h.color} corridor ${Math.round(best.d)}px`);
  }
}

// buses are the fallback transit: they ride existing roads for free but pay
// for it in congestion exposure — the demonstrated answer when rail slots
// are gone and a same-colour corridor still needs capacity. Best on MEDIUM
// corridors: too short and walking beats the wait, too long and the bus's
// own road trip is the problem it was meant to solve
function tryBus(state, log) {
  if (state.week < CONFIG.bus.firstWeek) return;
  if (busCount(state) >= CONFIG.bus.max) return;
  if (railCount(state) < state.maxLines) return; // rail first — it's traffic-immune
  let best = null;
  for (const h of state.buildings.values()) {
    if (h.type !== 'home' || !h.active || h.color == null || !served(h)) continue;
    if (onLine(state, h.id).length) continue;
    for (const w of state.buildings.values()) {
      if (w.type !== 'work' || !w.active || w.color !== h.color || !served(w)) continue;
      if (onLine(state, w.id).length) continue;
      const d = Math.hypot(w.x - h.x, w.y - h.y);
      if (d < 200 || d > 640) continue;
      // prefer the corridor whose direct drive hurts most — jammed frontage
      // at either end is where a shared ride pays for itself
      const s = economy.servingStress(state, h) + economy.servingStress(state, w);
      if (!best || s > best.s) best = { h, w, d, s };
    }
  }
  if (best && addBusLine(state, [best.h.id, best.w.id])) {
    log(`bus route home#${best.h.id}→work#${best.w.id} (${Math.round(best.d)}px, rail slots full)`);
  }
}

// what the player would pick from a two-offer weekly choice
function pickUpgrade(state, log) {
  const valid = UPGRADES.filter((u) => u.ok(state));
  const offers = [];
  while (offers.length < 2 && valid.length) {
    offers.push(valid.splice(Math.floor(Math.random() * valid.length), 1)[0]);
  }
  if (!offers.length) { state.upgradePending = false; return; }
  const homesHungry = [...state.buildings.values()].some(
    (b) => b.type === 'home' && b.hungerT > CONFIG.food.hungryAt);
  const overflowing = [...state.buildings.values()].some(
    (b) => b.waiting.length >= b.capacity - 1);
  const congested = [...state.roadEdges.values()].some(
    (e) => e.vehicles.size > CONFIG.roads.congestAt);
  // crates backing up at a farm = freight throughput is the bottleneck —
  // wagons and extra freight trains are the direct fix
  const cratesQueued = [...state.buildings.values()].some(
    (b) => b.type === 'farm' && b.waiting.length > 2);
  const freightLine = [...state.lines.values()].some((l) => l.freight);
  const score = (u) => {
    const n = u.name;
    if (n.includes('road tiles')) return state.roadTiles < 18 ? 100 : 35;
    // ~6–10 bridges per river crossing — below that the next cross-river
    // spawn is a hard wall, which outranks even an empty tile bank
    if (n.includes('Bridges')) return state.bridges < 6 ? 105 : (state.bridges < 14 ? 55 : 15);
    if (n.includes('transit line')) return railCount(state) >= state.maxLines ? 90 : 5;
    if (n.includes('market delivery truck')) return homesHungry ? 85 : 40;
    if (n.includes('Add a train')) {
      if (cratesQueued && freightLine) return 80;
      // worth it when a line queues people at stops
      return [...state.buildings.values()].some((b) => onLine(state, b.id).length && b.waiting.length > 2) ? 70 : 30;
    }
    if (n.includes('Larger buildings')) return overflowing ? 80 : 20;
    if (n.includes('Wider roads')) return congested ? 60 : 25;
    if (n.includes('Motorway')) return state.motorways < 2 ? 55 : 15;
    if (n.includes('Roundabout')) return state.roundabouts < 2 ? 55 : 15;
    if (n.includes('Traffic light')) return state.trafficLights < 2 ? 45 : 12;
    if (n.includes('Cargo wagon')) return cratesQueued ? 85 : (freightLine ? 55 : 20);
    return 10;
  };
  offers.sort((a, b) => score(b) - score(a));
  offers[0].apply(state);
  state.upgradePending = false;
  log(`upgrade: "${offers[0].name}" over "${offers[1]?.name ?? '—'}"`);
}

function junctionPressure(state, n) {
  // cars slowed/yielding near the node — what the structure is FOR
  let p = 0;
  for (const v of state.vehicles.values()) {
    if (v.kind === 'train') continue;
    const pos = vehicles.carPos(v);
    if (pos && Math.hypot(pos.x - n.x, pos.y - n.y) < 80) {
      p += v.yielding ? 2 : 1;
    }
  }
  return p + n.edges.length;
}

// a hot work on a meandering route gets a direct road — round-trip time is
// the only dial that raises commuter throughput once supply is the ceiling
function tryShortcut(state, log) {
  if (state.roadTiles < 10) return false;
  const w = [...state.buildings.values()]
    .filter((b) => b.type === 'work' && b.active)
    .sort((a, b) => (b.demandT ?? 0) - (a.demandT ?? 0))[0];
  if (!w || (w.demandT ?? 0) < 55) return false;
  const { dist } = roadDistancesFrom(state, [w.id]);
  let best = null;
  for (const h of state.buildings.values()) {
    if (h.type !== 'home' || h.color !== w.color || !served(h)) continue;
    const rd = dist.get(`b${h.id}`);
    const eu = Math.hypot(h.x - w.x, h.y - w.y);
    if (rd != null && rd !== Infinity && eu > 250 && rd / eu > 1.6 &&
        (!best || rd / eu > best.ratio)) best = { h, w, ratio: rd / eu };
  }
  if (!best) return false;
  const cells = cellsBetween(cellOf(best.h), cellOf(best.w));
  const cost = roadCellCost(state, cells);
  if (cost > state.roadTiles - 8) return false;
  // bridges are for reaching the unreachable — never burn the stock on an
  // express duplicate of a route that already exists
  if (bridgeCost(state, cells) > 0) return false;
  const edges = buildRoad(state, cells);
  if (!edges.length) return false;
  state.roadTiles -= cost;
  log(`shortcut road: home#${best.h.id}→work#${best.w.id} (${best.ratio.toFixed(1)}× detour, -${cost} tiles)`);
  return true;
}

function trySpecials(state, log) {
  const junctions = [...state.roadNodes.values()].filter(
    (n) => n.bid == null && n.edges.length >= 3 &&
      !n.edges.some((id) => state.roadEdges.get(id)?.roundabout));
  if (state.roundabouts > 0 && junctions.length) {
    const best = junctions.reduce((a, b) =>
      junctionPressure(state, a) >= junctionPressure(state, b) ? a : b);
    if (junctionPressure(state, best) >= 6 && placeRoundabout(state, best)) {
      state.roundabouts--;
      log(`roundabout on junction ${best.id} (pressure ${junctionPressure(state, best)})`);
    }
  }
  if (state.trafficLights > 0 && junctions.length) {
    const lit = junctions.filter((n) => !n.light);
    if (lit.length) {
      const best = lit.reduce((a, b) =>
        junctionPressure(state, a) >= junctionPressure(state, b) ? a : b);
      if (placeTrafficLight(state, best, true) === 'add') {
        state.trafficLights--;
        log(`traffic light on junction ${best.id}`);
      }
    }
  }
  if (state.motorways > 0) {
    // prefer an express hop for the hottest work's longest same-colour
    // commute — that's where round-trip time is actually killing us
    let pair = null;
    let hotWork = null;
    for (const w of state.buildings.values()) {
      if (w.type === 'work' && w.active && served(w) &&
          (w.demandT ?? 0) > (hotWork?.demandT ?? 40)) hotWork = w;
    }
    if (hotWork) {
      let bh = null, bd = 350;
      for (const h of state.buildings.values()) {
        if (h.type !== 'home' || !h.active || h.color !== hotWork.color || !served(h)) continue;
        const d = Math.hypot(h.x - hotWork.x, h.y - hotWork.y);
        if (d > bd) { bd = d; bh = h; }
      }
      if (bh) pair = [bh, hotWork];
    }
    if (!pair) {
      const conn = [...state.buildings.values()].filter(
        (b) => b.active && b.type !== 'junction' && served(b));
      let pd = 500;
      for (let i = 0; i < conn.length; i++) {
        for (let j = i + 1; j < conn.length; j++) {
          const d = Math.hypot(conn[j].x - conn[i].x, conn[j].y - conn[i].y);
          if (d > pd) { pd = d; pair = [conn[i], conn[j]]; }
        }
      }
    }
    if (pair) {
      const mid = {
        x: (pair[0].x + pair[1].x) / 2,
        y: (pair[0].y + pair[1].y) / 2 - 30,
      };
      if (buildMotorway(state, [pair[0], mid, pair[1]])) {
        state.motorways--;
        log(`motorway ${pair[0].id}→${pair[1].id} (${Math.round(Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y))}px)`);
      }
    }
  }
}

function decide(state, log) {
  const foodEra = [...state.buildings.values()].some((b) => b.type === 'farm' && b.active);
  const wanted = backboneWanted(state);
  // triage: serve the building closest to killing us first
  const bs = [...state.buildings.values()].filter((b) => b.type !== 'junction');
  bs.sort((a, b) => ettl(state, a, foodEra) - ettl(state, b, foodEra));
  if (!process.env.BOTNORD) {
    // repair stubs: a draw that ended just outside the merge radius leaves a
    // building "connected" to an island — it starves while reading served
    const roadIdx = roadCellIndex(state);
    if (roadIdx.size) {
      const { comp, best } = edgeComponents(state);
      const mainNodes = mainComponentNodes(state, comp, best);
      const safeGoal = mainNodes &&
        mergeableGoalCells(state, componentCells(roadIdx, comp, best), mainNodes);
      if (safeGoal) {
        const blocked = blockedCells(state);
        for (const b of bs) {
          if (!served(b) || mainNodes.has(b.roadNodeId)) continue;
          const cells = cachedPlan(state, `rejoin:${b.id}`, () =>
            pathToRoad(state, buildingCells(b), roadIdx, blocked, safeGoal));
          if (!cells || cells.length < 2) continue;
          const cost = roadCellCost(state, cells);
          if (cost > state.roadTiles) continue;
          if (bridgeCost(state, cells) > (state.bridges ?? 0)) continue;
          if (buildRoad(state, cells).length) {
            state.roadTiles -= cost;
            log(`rejoin: ${b.type}#${b.id} — stub was an island`);
          }
        }
      }
    }
    // keep a bank for the next colour's market — a new colour's homes starve
    // on a fixed clock and its market must connect the moment it spawns
    const RESERVE = 14;
    for (const b of bs) {
      if (served(b)) continue;
      // surplus food buildings stay unconnected on purpose — an inert market
      // claims no homes and drains no commuters
      if ((b.type === 'farm' || b.type === 'market') && !wanted.has(b.id)) continue;
      // pending buildings can wait; active ones and wanted food cannot
      if (!b.active && state.roadTiles < RESERVE && !wanted.has(b.id)) continue;
      tryConnect(state, b, log);
    }
  }
  if (!process.env.BOTNOLN) tryLines(state, log);
  if (!process.env.BOTNOBUS) tryBus(state, log);
  if (!process.env.BOTNOSP) { tryShortcut(state, log); trySpecials(state, log); }
}

// ---- postmortem ----------------------------------------------------------

function postmortem(state, warn, arrivals) {
  const go = state.gameOver;
  const out = {
    seed: null, weeks: state.week, time: Math.round(state.time),
    delivered: state.delivered, food: state.freightDelivered,
    buildings: state.buildings.size,
    tilesHeld: state.roadTiles,
    linesUsed: state.lines.size, linesMax: state.maxLines,
    items: { motorways: state.motorways, roundabouts: state.roundabouts, lights: state.trafficLights },
    reason: go.reason, at: { x: go.x, y: go.y },
  };
  let victim = null, vd = Infinity;
  for (const b of state.buildings.values()) {
    const d = Math.hypot(b.x - go.x, b.y - go.y);
    if (d < vd) { vd = d; victim = b; }
  }
  if (victim) {
    const stuck = victim.waiting.length;
    let unroutable = 0;
    for (const aid of victim.waiting.slice(0, 8)) {
      const a = state.agents.get(aid);
      if (a && !reachable(state, a, victim.id)) unroutable++;
    }
    out.victim = {
      id: victim.id, type: victim.type, color: victim.color,
      connected: served(victim),
      waiting: stuck, capacity: victim.capacity,
      unroutable,
      hungerT: Math.round(victim.hungerT), demandT: Math.round(victim.demandT),
      overflowT: +victim.overflowT.toFixed(1),
      wantedRoad: !!victim._botWantedRoad,
      wantedBridge: !!victim._botWantedBridge,
      warnSec: warn.get(victim.id) != null ? +(state.time - warn.get(victim.id)).toFixed(1) : null,
    };
    if (go.reason.includes('starved')) {
      const am = victim.assignedMarket != null ? state.buildings.get(victim.assignedMarket) : null;
      out.victimMarket = am
        ? { id: am.id, color: am.color, staffed: am.workers.length, stock: am.stock,
            trucks: am.trucks, activeTrucks: am.activeTrucks, marketDist: Math.round(victim.marketDist) }
        : { none: true, victimColor: victim.color };
      out.foodChain = [...state.buildings.values()]
        .filter((b) => b.type === 'market' && b.active)
        .map((m) => ({
          id: m.id, staffed: m.workers.length, stock: m.stock,
          trucks: m.trucks, activeTrucks: m.activeTrucks,
          connected: served(m),
          distToVictim: Math.round(Math.hypot(m.x - victim.x, m.y - victim.y)),
        }));
      out.farms = [...state.buildings.values()]
        .filter((b) => b.type === 'farm' && b.active)
        .map((f) => ({
          id: f.id, staffed: f.workers.length, connected: served(f),
          railed: [...state.lines.values()].some((l) => l.freight && l.stops.includes(f.id)),
        }));
      out.crates = [...state.agents.values()]
        .filter((a) => a.kind === 'crate')
        .map((a) => ({
          loc: typeof a.loc === 'number' ? `b${a.loc}` : 'veh',
          routed: !!a.legs?.length, wait: Math.round(a.wait),
        }));
    }
    if (go.reason.includes('understaffed')) {
      // could same-colour homes physically supply it?
      const homes = [...state.buildings.values()].filter(
        (b) => b.type === 'home' && b.active && b.color === victim.color);
      const times = (arrivals?.get(victim.id) ?? []);
      const windowS = Math.min(60, Math.max(1, state.time - (warn.get(victim.id) ?? state.time - 60)));
      const recent = times.filter((t) => t >= state.time - windowS);
      out.supply = {
        sameColorHomes: homes.length,
        connectedHomes: homes.filter(served).length,
        residentsEach: CONFIG.homes.residents,
        level: victim.level ?? 1,
        servedTotal: times.length,
        arrivalsLastMin: recent.length,
        arrivalsPerSecNeeded: +(
          CONFIG.demand.rate * (1 + ((victim.level ?? 1) - 1) * CONFIG.demand.growth) /
          CONFIG.demand.relief).toFixed(3),
        workersAtVictim: state.agents.size
          ? [...state.agents.values()].filter((a) => a.workingAt === victim.id).length
          : 0,
        agentsWorking: [...state.agents.values()].filter((a) => a.workingAt != null).length,
        agentsTotal: state.agents.size,
        // where is the victim's colour actually going? unrouted = no path
        sameColorAgents: (() => {
          const c = { total: 0, onShift: 0, riding: 0, waiting: 0, unrouted: 0, toVictim: 0 };
          for (const a of state.agents.values()) {
            if (a.color !== victim.color) continue;
            c.total++;
            if (a.workingAt != null) c.onShift++;
            else if (typeof a.loc !== 'number') c.riding++;
            else c.waiting++;
            if (a.workingAt == null && !a.legs?.length) c.unrouted++;
            if (a.legs?.at(-1)?.to === victim.id || a.workingAt === victim.id) c.toVictim++;
          }
          return c;
        })(),
      };
    }
  }
  const v = out.victim ?? {};
  const verdicts = [];
  if (v.warnSec != null && v.warnSec < 8) {
    verdicts.push(`UNFAIR: ${v.warnSec}s warning — under any human reaction window`);
  }
  if (!v.connected) {
    verdicts.push(v.wantedBridge
      ? 'RESOURCE-STARVED: river crossing wanted but bridge stock ran out — grant/pick pacing'
      : v.wantedRoad
      ? 'RESOURCE-STARVED: connection was wanted but tiles ran out — tilesPerWeek vs spawn rate tuning'
      : 'FAIR (player error): building was connectable and never linked');
  } else if (go.reason.includes('starved')) {
    const ok = (out.foodChain ?? []).some((m) => m.staffed >= 1 && m.connected);
    verdicts.push(ok
      ? 'SYSTEMIC: staffed connected market existed but trucks could not keep pace'
      : 'CHAIN-BROKEN: no staffed+connected market — food pacing may outrun what roads can build');
  } else if (go.reason.includes('understaffed')) {
    verdicts.push(out.supply && out.supply.connectedHomes === 0
      ? 'UNFAIR: no connected same-colour homes existed to supply it'
      : 'DEMAND-PRESSURE: supply existed but demand meter outran arrivals — level/spawn tuning');
  } else if (v.unroutable > 0) {
    verdicts.push('CONNECTIVITY: waiting agents had no valid destination — destination shortage, not congestion');
  } else {
    verdicts.push('CONGESTION/CAPACITY: routable agents piled up faster than transport drained them');
  }
  out.verdict = verdicts;
  return out;
}

// ---- run -----------------------------------------------------------------

function run(seed, verbose) {
  Math.random = srand(seed);
  const state = createState();
  state.level = LEVEL;
  applyLevelFeatures(state);
  const events = [];
  const log = (s) => {
    events.push({ t: +state.time.toFixed(1), week: state.week, s });
    if (verbose) console.log(`[w${state.week} ${state.time.toFixed(1)}s] ${s}`);
  };
  const warn = new Map();
  let decideT = 0;
  let lastWeek = state.week;
  // per-work arrival timeline: id → [arrival timestamps], rebuilt each second
  const arrivals = new Map();
  const lastServed = new Map();
  let arrivalSampleT = 0;
  const maxTicks = Math.ceil(MAX_SECONDS / STEP);

  for (let i = 0; i < maxTicks && !state.gameOver; i++) {
    if (state.upgradePending) {
      pickUpgrade(state, log); // sim pauses while the player chooses
      continue;
    }
    tick(state, STEP);
    arrivalSampleT -= STEP;
    if (arrivalSampleT <= 0) {
      arrivalSampleT = 1;
      for (const b of state.buildings.values()) {
        if (b.type !== 'work' || !b.active) continue;
        const prev = lastServed.get(b.id) ?? 0;
        const cur = b.served ?? 0;
        for (let k = prev; k < cur; k++) (arrivals.get(b.id) ?? arrivals.set(b.id, []).get(b.id)).push(state.time);
        lastServed.set(b.id, cur);
      }
    }
    if (state.week !== lastWeek) {
      const ws = [...state.buildings.values()].filter((b) => b.type === 'work')
        .map((b) => `#${b.id} L${b.level ?? 1} d${Math.round(b.demandT)} s${b.served ?? 0}`)
        .join(' ');
      const fs = [...state.buildings.values()].filter((b) => b.type === 'farm' || b.type === 'market')
        .map((b) => `${b.type[0]}#${b.id} w${b.workers.length}`)
        .join(' ');
      log(`── week ${state.week} · tiles=${state.roadTiles} blds=${state.buildings.size} agents=${state.agents.size} edges=${state.roadEdges.size} | works ${ws} | food ${fs}`);
      lastWeek = state.week;
    }
    for (const b of state.buildings.values()) {
      if (warn.has(b.id)) continue;
      const danger =
        b.overflowT > 0 ||
        (b.type === 'work' && b.demandT > CONFIG.demand.limit * 0.5) ||
        (b.type === 'home' && b.hungerT > CONFIG.food.hungryAt);
      if (danger) {
        warn.set(b.id, state.time);
        log(`warning: ${b.type}#${b.id} (${b.waiting.length}/${b.capacity} waiting)`);
      }
    }
    decideT -= STEP;
    if (decideT <= 0) {
      decideT = 0.4;
      if (process.env.BOTPHASE) console.log(`t=${state.time.toFixed(2)} phase=decide`);
      if (!process.env.BOTNODESIDE) decide(state, log);
    }
    if (process.env.BOTPROFILE && i % 60 === 0) {
      console.log(
        `t=${state.time.toFixed(0)} heap=${Math.round(process.memoryUsage().heapUsed / 1e6)}MB ` +
        `edges=${state.roadEdges.size} nodes=${state.roadNodes.size} ` +
        `agents=${state.agents.size} veh=${state.vehicles.size} ev=${events.length} ` +
        `lines=${state.lines.size} blds=${state.buildings.size}`,
      );
    }
  }
  const pm = state.gameOver
    ? postmortem(state, warn, arrivals)
    : { seed, weeks: state.week, time: Math.round(state.time), delivered: state.delivered,
        food: state.freightDelivered, buildings: state.buildings.size,
        tilesHeld: state.roadTiles, reason: 'SURVIVED (cap reached)',
        verdict: ['no death inside the window'] };
  pm.seed = seed;
  return { state, pm, events };
}

// exported for rl/env_worker.mjs (and anything else driving the sim
// programmatically) — the block below only runs when invoked directly
export {
  srand, tick, gridCols, gridRows, heap,
  served, blockedCells, mainComponentCells, pathToRoad, ettl, tryConnect,
  junctionJoin, insertStop, newLine, onLine, avgDist, backboneWanted,
  reachable, tryLines, pickUpgrade, junctionPressure, tryShortcut,
  trySpecials, decide, postmortem, run, cachedPlan,
  edgeComponents, componentCells,
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && RUNS > 0) {
  const rows = [];
  for (let s = SEED; s < SEED + RUNS; s++) rows.push(run(s, false).pm);
  console.log('seed | weeks | died by                        | conn | warn s | tiles | verdict');
  console.log('-----|-------|--------------------------------|------|--------|-------|-----------------------------');
  for (const r of rows) {
    const v = r.victim ?? {};
    console.log(
      `${String(r.seed).padEnd(4)} | ${String(r.weeks).padEnd(5)} | ${r.reason.padEnd(30)} | ${String(v.connected ?? '—').padEnd(4)} | ${String(v.warnSec ?? '—').padEnd(6)} | ${String(r.tilesHeld).padEnd(5)} | ${r.verdict[0]}`,
    );
  }
  const causes = {};
  for (const r of rows) causes[r.reason] = (causes[r.reason] ?? 0) + 1;
  console.log('\ndeath causes:', causes);
  const ws = rows.map((r) => r.weeks).sort((a, b) => a - b);
  console.log('weeks survived: min', ws[0], 'median', ws[Math.floor(ws.length / 2)], 'max', ws[ws.length - 1]);
} else if (isMain) {
  const { pm, events } = run(SEED, VERBOSE);
  console.log('\n=== POSTMORTEM ===');
  console.log(JSON.stringify(pm, null, 2));
  console.log('\n=== last 15 events ===');
  for (const e of events.slice(-15)) console.log(`  [${e.t}s w${e.week}] ${e.s}`);
}
