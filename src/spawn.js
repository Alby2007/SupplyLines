import { CONFIG, SHAPES } from './config.js';
import { nid } from './state.js';
import { cellOf, cellCenter, cellKey, buildingCells } from './grid.js';
import { roadCellIndex, connectBuildingToRoad } from './roads.js';
import { lineCellIndex } from './networks.js';

export function seedInitial(state) {
  // opening cluster lands in the middle third of the world — not dead centre,
  // just "middle-ish"
  const CS = CONFIG.grid.cell;
  const m = Math.ceil(CONFIG.map.margin / CS);
  const cols = Math.floor(CONFIG.map.width / CS);
  const rows = Math.floor(CONFIG.map.height / CS);
  const region = {
    cx0: m + Math.floor((cols - 2 * m) / 3),
    cx1: m + Math.floor(2 * (cols - 2 * m) / 3),
    cy0: m + Math.floor((rows - 2 * m) / 3),
    cy1: m + Math.floor(2 * (rows - 2 * m) / 3),
  };
  placeBuilding(state, 'home', true, undefined, region);
  placeBuilding(state, 'work', true, undefined, region);
}

// ---- colours ----

const sameColor = (b, c) => b.color === c;

function countByType(state, type, color) {
  let n = 0;
  for (const b of state.buildings.values()) {
    if (b.type === type && b.active !== false && (color == null || sameColor(b, color))) n++;
  }
  return n;
}

// pick a colour for a new building so it can actually function:
// homes need a same-colour workplace; works want homes; markets want
// uncovered home colours. Fallback: any unlocked colour.
export function pickColor(state, type) {
  const U = state.unlockedColors;
  if (type === 'home') {
    let best = null, bestScore = -Infinity;
    for (const c of U) {
      const works = countByType(state, 'work', c);
      if (!works) continue;
      const score = works - countByType(state, 'home', c);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (best != null) return best;
  } else if (type === 'work') {
    let best = null, bestScore = -Infinity;
    for (const c of U) {
      const homes = countByType(state, 'home', c);
      if (!homes) continue; // a colour with no housing can never staff a work
      const score = homes - countByType(state, 'work', c);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (best != null) return best;
  } else if (type === 'market') {
    let best = null, bestScore = -Infinity;
    for (const c of U) {
      const homes = countByType(state, 'home', c);
      if (!homes) continue;
      const score = homes - countByType(state, 'market', c) * CONFIG.spawn.homesPerMarket;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (best != null) return best;
  }
  return U[Math.floor(Math.random() * U.length)];
}

// live people (waiting + riding) per colour — a colour that sustains a big
// population has "earned" the next one. Ratchet: once unlocked it stays.
function checkColorUnlocks(state) {
  const P = CONFIG.colors.palette;
  if (state.unlockedColors.length >= P.length) return;
  const counts = new Map();
  for (const a of state.agents.values()) {
    if (a.kind === 'person' && a.color != null) {
      counts.set(a.color, (counts.get(a.color) ?? 0) + 1);
    }
  }
  const top = state.unlockedColors[state.unlockedColors.length - 1];
  if ((counts.get(top) ?? 0) >= CONFIG.colors.popToUnlock) {
    const next = top + 1;
    state.unlockedColors.push(next);
    state.colorSeedQueue.push(
      { type: 'home', color: next },
      { type: 'work', color: next },
    );
    if (state.week >= CONFIG.spawn.foodStartWeek) {
      state.colorSeedQueue.push({ type: 'market', color: next });
    }
  }
}

export function placeBuilding(state, type, instant = false, forcedColor = undefined, region = null) {
  const CS = CONFIG.grid.cell;
  const cols = Math.floor(CONFIG.map.width / CS);
  const rows = Math.floor(CONFIG.map.height / CS);
  const m = Math.ceil(CONFIG.map.margin / CS);          // margin in cells
  const minCells = Math.ceil(CONFIG.spawn.minDist / CS); // spacing in cells
  // candidate cell bounds — region constrains seeds to the map's middle
  const R = region ?? { cx0: m, cx1: cols - m - 1, cy0: m, cy1: rows - m - 1 };
  // tiles claimed by roads, transit lines, or water are off-limits
  const blocked = new Set(roadCellIndex(state).keys());
  for (const k of lineCellIndex(state)) blocked.add(k);
  for (const k of state.water ?? []) blocked.add(k);
  let pos = null;
  for (let i = 0; i < CONFIG.spawn.maxTries; i++) {
    // works occupy a 2×2 cell block centred on a grid vertex; other buildings
    // occupy the single cell they're centred on
    const cells = type === 'work' ? (() => {
      const v = {
        cx: R.cx0 + 1 + Math.floor(Math.random() * Math.max(1, R.cx1 - R.cx0)),
        cy: R.cy0 + 1 + Math.floor(Math.random() * Math.max(1, R.cy1 - R.cy0)),
      };
      return [
        { cx: v.cx - 1, cy: v.cy - 1 }, { cx: v.cx, cy: v.cy - 1 },
        { cx: v.cx - 1, cy: v.cy }, v,
      ];
    })() : [{
      cx: R.cx0 + Math.floor(Math.random() * Math.max(1, R.cx1 - R.cx0 + 1)),
      cy: R.cy0 + Math.floor(Math.random() * Math.max(1, R.cy1 - R.cy0 + 1)),
    }];
    if (cells.some((c) => blocked.has(cellKey(c)))) continue;
    // spacing keeps buildings apart; reach keeps them near the city — the map
    // grows as one connected blob so nothing ever lands unlinkable
    const reach = CONFIG.spawn.cityReach;
    let ok = true;
    let near = state.buildings.size === 0;
    for (const b of state.buildings.values()) {
      for (const bc of buildingCells(b)) {
        for (const c of cells) {
          const d = Math.max(Math.abs(bc.cx - c.cx), Math.abs(bc.cy - c.cy));
          if (d < minCells) { ok = false; break; }
          if (d <= reach) near = true;
        }
        if (!ok) break;
      }
      if (!ok) break;
    }
    if (!ok || !near) continue;
    pos = type === 'work'
      ? { x: cells[3].cx * CS, y: cells[3].cy * CS }   // vertex at the block's centre
      : cellCenter(cells[0].cx, cells[0].cy);
    break;
  }
  if (!pos) return null;
  const b = {
    id: nid(state),
    type,
    shape: SHAPES[type],
    color: type === 'farm' ? null : (forcedColor ?? pickColor(state, type)),
    x: pos.x,
    y: pos.y,
    waiting: [],
    capacity: CONFIG.buildings.capacity,
    overflowT: 0,
    active: instant,
    bornAt: state.time,  // spawn-ping arrows show while the building is fresh
    openAt: instant ? 0 : state.time + CONFIG.spawn.warnTime,
    spawnClock: CONFIG.commuters.interval * Math.random(),
    workers: [],       // shift timers — farms/markets operate when staffed
    stock: 0,          // crates held (markets only)
    hungerT: -CONFIG.food.pantryStart, // homes: negative = pantry buffer before hunger ticks
    demandT: type === 'work' ? -CONFIG.demand.grace : 0, // works: negative = grace period
    level: 1,          // works ratchet up as they're served (Motorways-style)
    served: 0,         // arrivals counted toward the next promotion
    produceClock: 0,
    assignedMarket: null,
    marketDist: Infinity,
    trucks: CONFIG.food.marketTrucksStart,
    activeTrucks: 0,
    dispatchT: 0,
    fedAt: 0,
  };
  state.buildings.set(b.id, b);
  return b;
}

export function update(state, dt) {
  if (state.buildings.size === 0) {
    seedInitial(state);
    return;
  }
  checkColorUnlocks(state);
  // a freshly unlocked colour gets its starter pair placed immediately —
  // failed placements retry for a while (crowded map) rather than vanishing,
  // which would leave the colour permanently home-less
  // one attempt per pending seed per tick — re-queued failures retry on the
  // next update (a crowded map may open up), and only give up after a while
  for (const s of state.colorSeedQueue.splice(0)) {
    if (placeBuilding(state, s.type, false, s.color)) continue;
    s.tries = (s.tries ?? 0) + 1;
    if (s.tries < 600) state.colorSeedQueue.push(s);
  }
  for (const b of state.buildings.values()) {
    if (!b.active && state.time >= b.openAt) {
      b.active = true;
      connectBuildingToRoad(state, b); // serve roads drawn through it early
    }
  }
  state.spawnClock -= dt;
  if (state.spawnClock <= 0) {
    state.spawnClock = spawnInterval(state);
    placeBuilding(state, pickType(state));
  }
}

export function spawnInterval(state) {
  return Math.max(
    CONFIG.spawn.intervalMin,
    CONFIG.spawn.intervalStart - (state.week - 1) * CONFIG.spawn.intervalRamp,
  );
}

export function pickType(state) {
  let homes = 0, works = 0, farms = 0, markets = 0;
  for (const b of state.buildings.values()) {
    if (b.type === 'home') homes++;
    else if (b.type === 'work') works++;
    else if (b.type === 'farm') farms++;
    else if (b.type === 'market') markets++;
  }
  // once the food era starts, keep the guaranteed-solvable ratios:
  // ~1 market per N homes, ~1 farm per 2 markets
  if (state.week >= CONFIG.spawn.foodStartWeek && homes >= CONFIG.spawn.homesPerMarket) {
    if (markets < Math.floor(homes / CONFIG.spawn.homesPerMarket)) return 'market';
    if (farms < Math.ceil(markets / CONFIG.spawn.marketsPerFarm)) return 'farm';
  }
  const frac = homes + works ? homes / (homes + works) : 1;
  if (frac < CONFIG.spawn.homeRatio) return 'home';
  // demand-gated workplaces: a work only spawns when the housing base can
  // actually staff it (≈2 commuters per home against its demand meter)
  return works < Math.floor(homes / CONFIG.spawn.homesPerWork) ? 'work' : 'home';
}
