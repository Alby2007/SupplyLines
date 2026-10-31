// Headless RL env worker — JSON-lines over stdio.
//   node rl/env_worker.mjs --level=1
// in : {"cmd":"reset","seed":1,"warm":120}  // warm = max seconds of bot pre-play
//      {"cmd":"step","a":3}
//      {"cmd":"close"}
// out: {"obs":{"grid":<b64 f32>,"glob":[..]},"feats":[[..]..],"desc":[..],
//       "reward":r,"done":bool,"info":{..}}
//
// The agent acts at DECISION cadence (0.5s sim): each step applies one action
// then advances the sim to the next decision/upgrade/game-over. Actions are
// enumerated per decision point (masked by construction) and carry feature
// vectors — the policy scores them instead of learning positional ids.

import { CONFIG, applyLevelOverrides } from '../src/config.js';
import { createState, applyLevelFeatures } from '../src/state.js';
import { UPGRADES } from '../src/ui.js';
import { buildRoad, roadCellCost, roadCellIndex, bridgeCost } from '../src/roads.js';
import { placeRoundabout } from '../src/roundabouts.js';
import { placeTrafficLight } from '../src/lights.js';
import { buildMotorway } from '../src/motorways.js';
import { cellOf, cellKey, cellsBetween, buildingCells, cellsAlongPolyline } from '../src/grid.js';
import { roadDistancesFrom } from '../src/routing.js';
import * as readline from 'node:readline';
import {
  srand, tick, served, blockedCells, mainComponentCells, pathToRoad,
  onLine, reachable, junctionPressure, newLine,
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
const CH = 18, GD = 25, AFD = 40, MAXA = 64;

// ---- action enumeration ---------------------------------------------------

const TYPE_IDX = { noop: 0, connect: 1, roadlink: 2, line: 3, motorway: 4, roundabout: 5, light: 6, upgrade: 7 };

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
    if (cells.some((c) => blocked.has(cellKey(c)))) {
      const g = new Map(buildingCells(other).map((c) => [cellKey(c), []]));
      cells = pathToRoad(state, own, g, blocked) ?? cells;
    }
    return cells;
  }
  return pathToRoad(state, own, roadIdx, blocked, goal);
}

// straight cellsBetween with a blocked-detour fallback (for roadlink pairs)
function planPairCells(state, fromB, toB, blocked) {
  let cells = cellsBetween(cellOf(fromB), cellOf(toB));
  if (cells.some((c) => blocked.has(cellKey(c)))) {
    const g = new Map(buildingCells(toB).map((c) => [cellKey(c), []]));
    const alt = pathToRoad(state, buildingCells(fromB), g, blocked);
    if (alt) cells = alt;
  }
  return cells;
}

function lineCandidates(state) {
  if (state.lines.size >= state.maxLines) return [];
  const out = [];
  const onL = (bid) => onLine(state, bid).length > 0;
  const freightStops = new Set();
  for (const l of state.lines.values()) if (l.freight) for (const s of l.stops) freightStops.add(s);
  const farms = [...state.buildings.values()].filter((b) => b.type === 'farm' && b.active);
  const mkts = [...state.buildings.values()].filter((b) => b.type === 'market' && b.active);
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
  for (const h of state.buildings.values()) {
    if (h.type !== 'home' || !h.active || h.color == null || onL(h.id)) continue;
    for (const w of state.buildings.values()) {
      if (w.type !== 'work' || !w.active || w.color !== h.color || onL(w.id)) continue;
      const d = Math.hypot(w.x - h.x, w.y - h.y);
      if (d > 240) pairs.push({ h, w, d });
    }
  }
  pairs.sort((a, b) => b.d - a.d);
  for (const p of pairs.slice(0, 4))
    out.push({ stops: [p.h.id, p.w.id], why: 'corridor', color: p.h.color, dist: p.d });
  const seen = new Set();
  return out.filter((o) => {
    const k = o.stops.join(',');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 10);
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
    acts.length < MAXA && acts.push({ feat: feat(o), apply, desc });

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

  // connect each unserved building (road drawn by the shared pathing)
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
    push(
      { type: 'connect', color: b.color, costFrac: cost / Math.max(1, state.roadTiles),
        bridgeFrac: wet / 12,
        meter: meterOf(b), wait: b.waiting.length / b.capacity, dist: cells.length * CONFIG.grid.cell },
      () => { if (buildRoad(state, cells).length) { state.roadTiles -= cost; return 0.15; } return 0; },
      `connect ${b.type}#${b.id}${b.active ? '' : ' (pending)'}`);
  }
  const nConnects = acts.length - beforeConnects;

  for (const c of lineCandidates(state)) {
    const meters = c.stops.map((id) => meterOf(state.buildings.get(id)));
    push(
      { type: 'line', color: c.color, stops: c.stops.length, dist: c.dist,
        freight: c.freight, rescue: c.rescue, meter: Math.max(...meters) },
      () => { newLine(state, c.stops, noopLog, c.why); return 0.15; },
      `line ${c.why}: ${c.stops.join('→')}`);
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
        if (d > 300) pairs.push({ a: h, b: w, d });
      }
    }
    pairs.sort((x, y) => y.d - x.d);
    for (const p of pairs.slice(0, 3)) {
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
      for (const n of jns.slice(0, 3)) {
        const p = junctionPressure(state, n);
        push({ type: 'roundabout', meter: Math.min(1, p / 20) },
          () => { if (placeRoundabout(state, n)) { state.roundabouts--; return 0.1; } return 0; },
          `roundabout @node${n.id} (pressure ${p})`);
      }
    }
    if (state.trafficLights > 0) {
      for (const n of jns.filter((n2) => !n2.light).slice(0, 3)) {
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

function encodeObs(state) {
  const grid = new Float32Array(CH * ROWS * COLS);
  const at = (c, ch) => { if (c.cx >= 0 && c.cx < COLS && c.cy >= 0 && c.cy < ROWS) grid[ch * ROWS * COLS + c.cy * COLS + c.cx] = 1; };
  const atv = (c, ch, v) => { if (c.cx >= 0 && c.cx < COLS && c.cy >= 0 && c.cy < ROWS) { const i = ch * ROWS * COLS + c.cy * COLS + c.cx; if (v > grid[i]) grid[i] = v; } };
  for (const k of state.water ?? []) {
    const [cx, cy] = k.split(',').map(Number);
    at({ cx, cy }, 0);
  }
  const cap = CONFIG.roads.maxPerEdge + (state.roadCapBonus || 0);
  for (const e of state.roadEdges.values()) {
    const ch = e.motorway ? 2 : 1;
    const dens = Math.min(1, e.vehicles.size / Math.max(1, cap));
    for (const c of cellsAlongPolyline(e.pts)) { at(c, ch); if (!e.motorway) atv(c, 17, dens); }
  }
  const TYPE_CH = { home: 3, work: 4, farm: 5, market: 6, junction: 7 };
  for (const b of state.buildings.values()) {
    const tch = TYPE_CH[b.type];
    for (const c of buildingCells(b)) {
      at(c, tch);
      if (b.color != null && b.color < 6) at(c, 8 + b.color);
      if (!b.active) at(c, 14);
      atv(c, 15, meterOf(b));
      atv(c, 16, Math.min(1, b.waiting.length / Math.max(1, b.capacity)));
    }
  }
  let waitTot = 0, capTot = 0, maxMeter = 0;
  for (const b of state.buildings.values()) {
    waitTot += b.waiting.length; capTot += b.capacity;
    maxMeter = Math.max(maxMeter, meterOf(b));
  }
  const glob = [
    state.week / 12,
    state.weekT / CONFIG.weekSeconds,
    state.roadTiles / CONFIG.roads.tilesCap,
    state.maxLines ? state.lines.size / state.maxLines : 0,
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
    0, 0, 0,
  ];
  return { grid: Buffer.from(grid.buffer).toString('base64'), glob, rows: ROWS, cols: COLS, ch: CH };
}

// ---- env loop ---------------------------------------------------------------

let state = null;
let rng = null;
let steps = 0;
let prevExcess = 0; // worst meter pressure above the danger line — shaping

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
  for (let i = 0; i < 30; i++) tick(state, STEP); // let the seed cluster open
  // reverse-curriculum warm start: the heuristic bot pre-plays a random
  // prefix so episodes reach the states runs actually die in — agent and
  // critic get gradient on week-5+ pressure from iteration 1. A quarter of
  // resets stay cold so opening play doesn't atrophy.
  const warmK = Math.random() < 0.25 ? 0 : Math.random() * warm;
  let t = 0, dt = 0;
  while (t < warmK && !state.gameOver) {
    tick(state, STEP);
    t += STEP;
    dt -= STEP;
    if (state.upgradePending) pickUpgrade(state, noopLog);
    if (dt <= 0) { dt = 0.4; decide(state, noopLog); }
  }
  if (state.gameOver) return doReset(seed, 0); // bot died in warmup — cold retry
  prevExcess = excessPressure(state);
  return respond(0, false);
}

function respond(reward, done) {
  const acts = enumerate(state);
  const info = {
    week: state.week, time: +state.time.toFixed(1),
    delivered: state.delivered, freight: state.freightDelivered,
    buildings: state.buildings.size,
    reason: state.gameOver?.reason ?? null,
    steps,
  };
  return {
    obs: encodeObs(state),
    feats: acts.map((a) => a.feat),
    desc: acts.map((a) => a.desc),
    reward, done, info,
    _acts: acts, // stripped before send
  };
}

function serialize(r) {
  const { _acts, ...rest } = r;
  return rest;
}

let pending = null; // acts from the last respond()

function doStep(aIdx) {
  const acts = pending ?? enumerate(state);
  steps++;
  let bonus = 0;
  if (aIdx >= 0 && aIdx < acts.length) {
    try { bonus = acts[aIdx].apply() || 0; } catch (e) { /* bad apply = wasted action */ }
  }
  const d0 = state.delivered, f0 = state.freightDelivered;
  let t = 0, guard = 0;
  while (t < DECIDE_DT - 1e-9 && !state.gameOver && !state.upgradePending && guard++ < 240) {
    tick(state, STEP);
    t += STEP;
  }
  let reward = 0.02 * t + 0.1 * (state.delivered - d0) +
    0.15 * (state.freightDelivered - f0) + bonus;
  const ex = excessPressure(state);
  reward += 2.0 * (prevExcess - ex); // meter-relief shaping
  prevExcess = ex;
  const done = !!state.gameOver || state.time >= MAX_SECONDS;
  if (state.gameOver) reward -= 2;
  const r = respond(reward, done);
  pending = r._acts;
  return r;
}

const rl = readline.createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ ready: true, ch: CH, gd: GD, afd: AFD, rows: ROWS, cols: COLS }) + '\n');
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  try {
    if (msg.cmd === 'reset') {
      pending = null;
      const r = doReset(msg.seed ?? 1, msg.warm ?? 0);
      pending = r._acts;
      process.stdout.write(JSON.stringify(serialize(r)) + '\n');
    } else if (msg.cmd === 'step') {
      const r = doStep(msg.a ?? 0);
      process.stdout.write(JSON.stringify(serialize(r)) + '\n');
    } else if (msg.cmd === 'close') {
      process.exit(0);
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: String(e?.stack ?? e) }) + '\n');
  }
});
