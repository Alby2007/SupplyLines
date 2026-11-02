// procedural level-def generator — emits the same def shape the hand maps use
// (sections merged onto base CONFIG by applyLevelOverrides), so a generated map
// is an ordinary level once registered. Defs are concrete data: water cells and
// river params are resolved at generation time, no runtime RNG inside a def.
import { CONFIG } from './config.js';
import { levelTerrain } from './state.js';

// own PRNG — def generation must not consume the game's episode seed stream
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const irange = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const frange = (r, lo, hi) => lo + r() * (hi - lo);

const CS = 40, ROWS = 32; // grid.cell, map.height are base-CONFIG constants

// compact water blob as explicit offset cells — same shape Map 2's oasis uses
function blobCells(r, size) {
  const cells = new Set(['0,0']);
  const open = [[0, 0]];
  while (cells.size < size && open.length) {
    const [x, y] = open.splice(Math.floor(r() * open.length), 1)[0];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (r() < 0.55) continue;
      const k = `${x + dx},${y + dy}`;
      if (!cells.has(k)) { cells.add(k); open.push([x + dx, y + dy]); }
    }
  }
  let mnx = 0, mny = 0;
  for (const k of cells) { const [x, y] = k.split(',').map(Number); mnx = Math.min(mnx, x); mny = Math.min(mny, y); }
  return [...cells].map((k) => { const [x, y] = k.split(',').map(Number); return [x - mnx, y - mny]; });
}

export function levelDefForSeed(seed) {
  const r = prng(seed ^ 0x9e3779b9);
  const cols = pick(r, [40, 40, 56, 80, 80]);           // 40/80 anchored on the hand maps
  const wide = cols > 40;
  const waterKind = pick(r, ['none', 'none', 'blob', 'blob', 'blob', 'river', 'river']);
  const bias = pick(r, [null, 'left', 'right']);
  const def = {
    map: { width: cols * CS, height: ROWS * CS },
    // the wide-canvas package compensates travel distance — map-size, not theme
    ...(wide ? { roads: { carSpeed: 110, truckSpeed: 85, tilesStart: 50, tilesPerWeek: 22 } } : {}),
    ...(bias ? { spawn: { seedBias: bias } } : {}),
  };
  const hard = [];
  if (waterKind === 'blob') {
    const cells = blobCells(r, irange(r, 5, 15));
    const bw = Math.max(...cells.map(([x]) => x)) + 1, bh = Math.max(...cells.map(([, y]) => y)) + 1;
    def.water = {
      at: { cx: irange(r, 4, cols - 4 - bw), cy: irange(r, 3, ROWS - 3 - bh) },
      cells, fill: '#9fcbe0', edge: '#7cb2c7',
    };
  } else if (waterKind === 'river') {
    def.water = {
      river: {
        center: Math.round(cols * frange(r, 0.35, 0.65)),
        meander: frange(r, 3, 6), minHalf: frange(r, 2, 3.5),
        wobble: frange(r, 1.5, 3), seed: irange(r, 1, 9999),
      },
      fill: '#71b3d6', edge: '#5398bf',
    };
    // crossings must exist — a river without the bridge kit is unsolvable
    def.bridges = { unlockWeek: 2, grant: irange(r, 10, 16), pick: 8, cap: 36 };
    hard.push('river');
  }
  const intervalStart = Math.round(frange(r, 11, 14) * 10) / 10;
  const hungerLimit = Math.round(frange(r, 100, 140));
  const demandRate = Math.round(frange(r, 0.9, 1.15) * 100) / 100;
  if (intervalStart !== 14) (def.spawn ??= {}).intervalStart = intervalStart;
  if (hungerLimit !== 120) def.food = { hungerLimit };
  if (demandRate !== 1) def.demand = { rate: demandRate };
  if (intervalStart <= 11.5) hard.push('fastspawn');
  if (hungerLimit <= 108) hard.push('shortfuse');
  if (demandRate >= 1.08) hard.push('demand');
  // the river tax is real — the hardest combos may keep Map 3's softer targets
  if (hard.length && r() < 0.5) def.win = { stars: [4, 7, 10] };
  return def;
}

// ~10 normalized descriptors — the obs features that replace the level
// one-hot. Read from the def first, merged CONFIG second, so it works both
// per-episode (post-override) and standalone for calibration metadata.
export function mapParams(level) {
  const def = CONFIG.levels?.[level] ?? {};
  const t = levelTerrain(level);
  const wdef = def.water;
  return [
    t.cols / 80,
    t.water.size / (t.cols * t.rows),
    wdef && !wdef.river ? 1 : 0,
    wdef?.river ? 1 : 0,
    def.spawn?.seedBias === 'left' ? 1 : 0,
    def.spawn?.seedBias === 'right' ? 1 : 0,
    def.bridges ? 1 : 0,
    (def.spawn?.intervalStart ?? CONFIG.spawn.intervalStart) / 14,
    (def.food?.hungerLimit ?? CONFIG.food.hungerLimit) / 140,
    def.demand?.rate ?? CONFIG.demand.rate,
  ];
}
export const MAP_PARAM_DIM = 10;
