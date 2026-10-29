import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createState } from '../src/state.js';
import { buildRoad, placeTrafficLight, lightGroups, demolishRoad } from '../src/roads.js';
import { cellOf, cellsBetween, polyLen } from '../src/grid.js';
import { update as updateVehicles } from '../src/vehicles.js';
import * as economy from '../src/economy.js';

function b(state, id, type, x, y) {
  const bb = {
    id, type, x, y, active: true, waiting: [], capacity: 6, overflowT: 0, spawnClock: 2,
  };
  state.buildings.set(id, bb);
  return bb;
}

function road(s, a, bPt) {
  return buildRoad(s, cellsBetween(cellOf(a), cellOf(bPt)));
}

function crossJunction(s) {
  const j = { x: 300, y: 300 };
  road(s, j, { x: 100, y: 300 }); // W arm
  road(s, j, { x: 500, y: 300 }); // E arm
  road(s, j, { x: 300, y: 100 }); // N arm
  road(s, j, { x: 300, y: 500 }); // S arm
  return [...s.roadNodes.values()].find((n) => n.edges.length >= 4 && n.bid == null);
}

test('a traffic light groups opposite arms into shared phases', () => {
  const s = createState();
  const j = crossJunction(s);
  assert.equal(placeTrafficLight(s, j), 'add');
  assert.ok(j.light, 'no light installed');
  // a 4-way cross pairs N-S and E-W → exactly 2 phase groups
  assert.equal(j.light.groups.length, 2);
  const flat = j.light.groups.flat();
  assert.equal(new Set(flat).size, 4, 'not all arms grouped');
});

test('red arms hold at the line, green arms enter', () => {
  const s = createState();
  const j = crossJunction(s);
  placeTrafficLight(s, j);
  const L = j.light;
  const [g0, g1] = L.groups;
  const eRed = s.roadEdges.get(g1[0]);
  // heading toward j on eRed — fwd if j is edge.b
  const fwd = eRed.b === j.id;
  const v = {
    id: 901, kind: 'car', color: 0,
    segs: [{ pts: eRed.pts, len: polyLen(eRed.pts), edgeId: eRed.id, fwd }],
    seg: 0, dist: polyLen(eRed.pts) - 8, pax: [],
  };
  s.vehicles.set(v.id, v);
  eRed.vehicles.add(v.id);

  L.idx = 0; // force arm g0 green, g1 red — reset the timer so it holds
  L.t = CONFIG.trafficLights.phase;
  updateVehicles(s, 1 / 60);
  assert.ok(v.dist <= polyLen(eRed.pts) - 1.9, `red arm ran the line (dist ${v.dist})`);
  assert.ok(v.yielding, 'red car not flagged as held');

  L.idx = 1; // its arm goes green
  for (let i = 0; i < 30; i++) updateVehicles(s, 1 / 60);
  assert.ok(v.dist > polyLen(eRed.pts) - 1.9 || v.seg > 0 || !s.vehicles.has(v.id),
    'green arm never proceeded');
});

test('a light cycles its phases', () => {
  const s = createState();
  const j = crossJunction(s);
  placeTrafficLight(s, j);
  const L = j.light;
  assert.equal(L.idx, 0);
  for (let i = 0; i < Math.ceil(CONFIG.trafficLights.phase * 60) + 2; i++) {
    updateVehicles(s, 1 / 60);
  }
  assert.equal(L.idx, 1, 'phase never advanced');
  // a full cycle returns to the first group
  for (let i = 0; i < Math.ceil(CONFIG.trafficLights.phase * 60) + 2; i++) {
    updateVehicles(s, 1 / 60);
  }
  assert.equal(L.idx, 0);
});

test('lights toggle off and refund; demolishing the junction refunds too', () => {
  const s = createState();
  const j = crossJunction(s);
  assert.equal(placeTrafficLight(s, j), 'add');
  assert.equal(placeTrafficLight(s, j), 'remove');
  assert.ok(!j.light, 'light still on the node');

  // again — then bulldoze the whole junction away
  placeTrafficLight(s, j);
  s.trafficLights = 0;
  for (const eid of [...j.edges]) {
    const e = s.roadEdges.get(eid);
    if (!e) continue; // shared junction cells can cascade-kill the other arms
    demolishRoad(s, cellsBetween(cellOf(e.pts[0]), cellOf(e.pts[e.pts.length - 1])));
  }
  assert.equal(s.trafficLights, 1, 'light not refunded when its node died');
});

test('lights only fit real junctions — not bends or buildings', () => {
  const s = createState();
  const h = b(s, 1, 'home', 100, 100);
  const w = b(s, 2, 'work', 500, 100);
  road(s, h, w);
  for (const n of s.roadNodes.values()) {
    assert.equal(placeTrafficLight(s, n), null, 'lit a non-junction');
  }
  assert.equal(placeTrafficLight(s, { x: 700, y: 700 }), null, 'lit empty ground');
});

test('the first traffic light is granted when week 3 ends', () => {
  const s = createState();
  economy.update(s, 1 / 60);
  assert.equal(s.trafficLights, 0);
  s.week = CONFIG.trafficLights.unlockWeek;
  economy.update(s, 1 / 60);
  assert.equal(s.trafficLights, 1);
  economy.update(s, 1 / 60);
  assert.equal(s.trafficLights, 1, 'grant fired twice');
});

test('lightGroups pairs arms and leaves lone arms solo', () => {
  const s = createState();
  const j = { x: 300, y: 300 };
  road(s, j, { x: 100, y: 300 }); // W
  road(s, j, { x: 500, y: 300 }); // E (opposite W)
  road(s, j, { x: 300, y: 500 }); // S (lone)
  const node = [...s.roadNodes.values()].find((n) => n.edges.length >= 3 && n.bid == null);
  const groups = lightGroups(s, node);
  assert.equal(groups.length, 2, `expected 2 groups, got ${groups.length}`);
  const sizes = groups.map((g) => g.length).sort();
  assert.deepEqual(sizes, [1, 2]);
});
