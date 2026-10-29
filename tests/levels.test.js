import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, applyLevelOverrides } from '../src/config.js';
import { createState, applyLevelFeatures } from '../src/state.js';

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
