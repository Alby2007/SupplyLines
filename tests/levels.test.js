import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, applyLevelOverrides } from '../src/config.js';
import { createState, applyLevelFeatures } from '../src/state.js';
import { starsEarned } from '../src/economy.js';

// the browser boot path: overrides merge onto base CONFIG, then terrain
// materialises — a level-only section (water) must not break the merge

test('level 1 boot: no overrides applied, no water', () => {
  applyLevelOverrides(1);
  assert.equal(CONFIG.map.width, 1600);
  const s = createState();
  s.level = 1;
  applyLevelFeatures(s);
  assert.equal(s.water.size, 0);
});

test('level 2 boot: doubles tiles, keeps base fields, materialises oasis', () => {
  applyLevelOverrides(2);
  assert.equal(CONFIG.map.width, 3200);
  assert.equal(CONFIG.map.height, 1280);
  assert.equal(CONFIG.map.margin, 90);          // untouched base keys survive
  assert.ok(CONFIG.water);                       // level-only section created, not crashed

  const s = createState();
  s.level = 2;
  applyLevelFeatures(s);
  assert.equal(s.water.size, 16);
  assert.ok(s.waterFill && s.waterEdge);
});

test('oasis shape is irregular — 16 unique cells, not a solid rectangle', () => {
  const { at, cells } = CONFIG.levels[2].water;
  const keys = new Set(cells.map(([dx, dy]) => `${at.cx + dx},${at.cy + dy}`));
  assert.equal(keys.size, cells.length);         // no duplicate offsets
  const xs = cells.map(([dx]) => dx), ys = cells.map(([, dy]) => dy);
  const w = Math.max(...xs) - Math.min(...xs) + 1;
  const h = Math.max(...ys) - Math.min(...ys) + 1;
  assert.ok(w * h > cells.length);               // bbox has holes — not a filled rect
  assert.ok(!(w === 4 && h === 4));              // explicitly not the perfect square
});

test('level 3 boot: river materialises — ≥6 thick, middle-third, deterministic', () => {
  applyLevelOverrides(3);
  assert.equal(CONFIG.map.width, 3200);
  assert.equal(CONFIG.spawn.seedBias, 'right');

  const boot = () => {
    const s = createState();
    s.level = 3;
    applyLevelFeatures(s);
    return s;
  };
  const s = boot();
  assert.ok(s.water.size > 150);                 // a real river, not a pond

  // group cells by row: every row is a contiguous ≥6-cell band
  const byRow = new Map();
  for (const k of s.water) {
    const [cx, cy] = k.split(',').map(Number);
    (byRow.get(cy) ?? byRow.set(cy, []).get(cy)).push(cx);
  }
  assert.equal(byRow.size, 32);                  // spans the map top to bottom
  let minW = Infinity, maxCx = -Infinity, minCx = Infinity;
  for (const xs of byRow.values()) {
    xs.sort((a, b) => a - b);
    assert.equal(xs[xs.length - 1] - xs[0] + 1, xs.length); // no gaps mid-river
    minW = Math.min(minW, xs.length);
    minCx = Math.min(minCx, xs[0]);
    maxCx = Math.max(maxCx, xs[xs.length - 1]);
  }
  assert.ok(minW >= 6, `thinnest point ${minW} < 6 tiles`);
  // middle third of 80 columns ≈ 26.7–53.3
  assert.ok(minCx >= 27 && maxCx <= 53, `river strays outside middle third: ${minCx}–${maxCx}`);

  const again = boot();
  assert.deepEqual([...again.water].sort(), [...s.water].sort()); // same river every game
});

test('stars: the week you reach counts; per-level thresholds apply', () => {
  // level-3 overrides are live from the test above — targets [4, 7, 10]
  assert.deepEqual(CONFIG.win.stars, [4, 7, 10]);
  assert.equal(starsEarned({ week: 3 }), 0);
  assert.equal(starsEarned({ week: 4 }), 1);   // died during week 4 — still earns it
  assert.equal(starsEarned({ week: 7 }), 2);
  assert.equal(starsEarned({ week: 10 }), 3);
  assert.equal(starsEarned({ week: 20 }), 3);  // clamps at three
});
