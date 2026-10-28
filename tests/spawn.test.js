import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, dist } from '../src/state.js';
import { placeBuilding, seedInitial, pickType, spawnInterval } from '../src/spawn.js';
import { CONFIG } from '../src/config.js';
import { buildingCells } from '../src/grid.js';

test('seeded buildings respect minimum spacing', () => {
  const s = createState();
  seedInitial(s);
  assert.equal(s.buildings.size, 3);
  const list = [...s.buildings.values()];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      assert.ok(dist(list[i], list[j]) >= CONFIG.spawn.minDist);
    }
  }
});

test('seeded buildings start in the middle third of the map', () => {
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
  for (let run = 0; run < 5; run++) {
    const s = createState();
    seedInitial(s);
    for (const b of s.buildings.values()) {
      const c = { cx: Math.floor(b.x / CS), cy: Math.floor(b.y / CS) };
      assert.ok(
        c.cx >= region.cx0 && c.cx <= region.cx1 &&
        c.cy >= region.cy0 && c.cy <= region.cy1,
        `seed at cell ${c.cx},${c.cy} outside middle third`,
      );
    }
  }
});

test('placed buildings stay inside margins', () => {
  const s = createState();
  for (let i = 0; i < 15; i++) placeBuilding(s, i % 2 ? 'home' : 'work');
  for (const b of s.buildings.values()) {
    assert.ok(b.x >= CONFIG.map.margin && b.x <= CONFIG.map.width - CONFIG.map.margin);
    assert.ok(b.y >= CONFIG.map.margin && b.y <= CONFIG.map.height - CONFIG.map.margin);
  }
});

test('new buildings always spawn within reach of the existing city', () => {
  const s = createState();
  seedInitial(s);
  const CS = CONFIG.grid.cell;
  for (let i = 0; i < 20; i++) {
    const prior = [...s.buildings.values()].map((b) => buildingCells(b));
    const b = placeBuilding(s, pickType(s));
    if (!b) continue; // placement can legitimately fail — just don't check it
    const cells = buildingCells(b);
    const near = prior.some((pcs) =>
      pcs.some((pc) =>
        cells.some((c) =>
          Math.max(Math.abs(pc.cx - c.cx), Math.abs(pc.cy - c.cy)) <= CONFIG.spawn.cityReach,
        ),
      ),
    );
    assert.ok(near, `${b.type} spawned beyond ${CONFIG.spawn.cityReach} cells of the city`);
  }
});

test('pickType maintains approximate home ratio before food era', () => {
  const s = createState();
  let homes = 0;
  let total = 0;
  for (let i = 0; i < 30; i++) {
    const t = pickType(s);
    const b = placeBuilding(s, t, true) ?? { type: t };
    if (!s.buildings.has(b.id)) s.buildings.set(b.id, b);
    if (b.type === 'home') homes++;
    total++;
  }
  const frac = homes / total;
  assert.ok(frac >= 0.65 && frac <= 0.85, `home fraction ${frac} outside 0.65-0.85`);
});

test('workplaces stay gated to the housing base', () => {
  const s = createState();
  for (let i = 0; i < 30; i++) {
    const t = pickType(s);
    const b = placeBuilding(s, t, true) ?? { type: t };
    if (!s.buildings.has(b.id)) s.buildings.set(b.id, b);
    const homes = [...s.buildings.values()].filter((x) => x.type === 'home').length;
    const works = [...s.buildings.values()].filter((x) => x.type === 'work').length;
    assert.ok(
      works <= Math.floor(homes / CONFIG.spawn.homesPerWork),
      `${works} works on only ${homes} homes`,
    );
  }
});

test('food era enforces market and farm ratios', () => {
  const s = createState();
  s.week = CONFIG.spawn.foodStartWeek;
  for (let i = 0; i < 8; i++) {
    const b = placeBuilding(s, 'home', true) ?? { type: 'home' };
    if (!s.buildings.has(b.id)) s.buildings.set(b.id, b);
  }
  assert.equal(pickType(s), 'market');
  s.buildings.set(999, { id: 999, type: 'market' });
  s.buildings.set(998, { id: 998, type: 'market' });
  assert.equal(pickType(s), 'farm');
});

test('spawn interval ramps down but never below minimum', () => {
  const s = createState();
  s.week = 1;
  assert.equal(spawnInterval(s), CONFIG.spawn.intervalStart);
  s.week = 50;
  assert.equal(spawnInterval(s), CONFIG.spawn.intervalMin);
});
