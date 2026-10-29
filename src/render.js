import { CONFIG } from './config.js';
import { presenceCounts } from './agents.js';
import { trainPos, carPos } from './vehicles.js';
import { congestFactor } from './routing.js';
import { roadCellCost, slicePolyline, polyLen, demolishRefund } from './roads.js';
import { linePts } from './networks.js';
import { cellCenter, routePts } from './grid.js';

const INK = '#3d3a36';
const FAINT = 'rgba(0,0,0,0.05)';
const ROAD_FREE = '#cdc7bc';
const ROAD_BUSY = '#e9a13b';
const VEHICLE_COLORS = { car: '#4a4640', foodTruck: '#2a9d8f', milkTruck: '#f4f1ea' };
const PAL = (i) => (i == null ? null : CONFIG.colors.palette[i]);

export function draw(ctx, state, draft, roadDraft, tool, cam, w, h, hover) {
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(-cam.x, -cam.y);
  const building = tool != null || draft || roadDraft; // any armed tool = build mode
  if (building) drawGrid(ctx, cam, w, h, roadDraft);
  else drawDots(ctx, cam, w, h);
  // world boundary so the map edge reads while panning
  ctx.strokeStyle = 'rgba(60,55,45,0.3)';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, CONFIG.map.width, CONFIG.map.height);
  drawRoads(ctx, state);
  for (const line of state.lines.values()) drawLine(ctx, state, line);
  if (draft) drawDraft(ctx, state, draft);
  if (roadDraft) drawRoadDraft(ctx, state, roadDraft);
  if (tool === 'roundabout' && hover) {
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = hover.ok === false ? '#e63946' : '#457b9d';
    ctx.lineWidth = CONFIG.roads.width - 2;
    ctx.beginPath();
    ctx.arc(hover.x, hover.y, CONFIG.roundabouts.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  if (tool === 'light' && hover) {
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = hover.ok === false ? '#e63946' : '#f5f2ec';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(hover.x, hover.y, 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  for (const v of state.vehicles.values()) {
    if (v.kind === 'train') drawTrain(ctx, state, v);
    else drawCar(ctx, v);
  }
  const counts = presenceCounts(state); // one agent scan shared by all buildings
  for (const b of state.buildings.values()) drawBuilding(ctx, state, b, counts);
  drawMotorways(ctx, state); // overpasses float above buildings and streets
  // vehicles on a motorway get a second paint so the span doesn't cover them
  for (const v of state.vehicles.values()) {
    const seg = v.segs?.[v.seg];
    const e = seg?.edgeId != null ? state.roadEdges.get(seg.edgeId) : null;
    if (e?.motorway && v.kind !== 'train') drawCar(ctx, v);
  }
  ctx.restore();
  drawLegend(ctx, h);
}

// building key, bottom-left — neutral grey matching the waiting glyphs
function drawLegend(ctx, h) {
  const items = [
    ['circle', 'home'],
    ['square', 'work'],
    ['octagon', 'farm'],
    ['triangle', 'market'],
  ];
  ctx.save();
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#6b6560';
  items.forEach(([shape, label], i) => {
    const y = h - 18 - (items.length - 1 - i) * 22;
    shapePath(ctx, shape, 26, y, 7);
    ctx.fill();
    ctx.fillText(label, 42, y + 0.5);
  });
  ctx.restore();
}

function drawDots(ctx, cam, w, h) {
  ctx.fillStyle = FAINT;
  const x0 = 30 + Math.floor((cam.x - 30) / 44) * 44;
  const y0 = 30 + Math.floor((cam.y - 30) / 44) * 44;
  for (let x = x0; x < cam.x + w; x += 44) {
    for (let y = y0; y < cam.y + h; y += 44) {
      ctx.beginPath();
      ctx.arc(x, y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// Mini Motorways-style build grid: visible square cells while building,
// with the draft head cell highlighted as the placement target
function drawGrid(ctx, cam, w, h, roadDraft) {
  const CS = CONFIG.grid.cell;
  const x0 = Math.floor(cam.x / CS) * CS;
  const y0 = Math.floor(cam.y / CS) * CS;

  // square cell field — only the tiles inside the viewport
  ctx.strokeStyle = 'rgba(60,55,45,0.16)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = x0; x <= cam.x + w; x += CS) { ctx.moveTo(x + 0.5, cam.y); ctx.lineTo(x + 0.5, cam.y + h); }
  for (let y = y0; y <= cam.y + h; y += CS) { ctx.moveTo(cam.x, y + 0.5); ctx.lineTo(cam.x + w, y + 0.5); }
  ctx.stroke();

  // cells the current draft occupies — red when bulldozing
  if (roadDraft?.cells?.length) {
    const demo = roadDraft.demolish;
    ctx.fillStyle = demo ? 'rgba(230,57,70,0.10)' : 'rgba(60,55,45,0.08)';
    for (const c of roadDraft.cells) {
      ctx.fillRect(c.cx * CS, c.cy * CS, CS, CS);
    }
    // highlighted head cell — the tile you're about to claim
    const head = roadDraft.cells[roadDraft.cells.length - 1];
    ctx.fillStyle = demo ? 'rgba(230,57,70,0.22)' : 'rgba(60,55,45,0.18)';
    ctx.fillRect(head.cx * CS, head.cy * CS, CS, CS);
    ctx.strokeStyle = demo ? 'rgba(230,57,70,0.5)' : 'rgba(60,55,45,0.4)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(head.cx * CS + 0.5, head.cy * CS + 0.5, CS - 1, CS - 1);
  }
}

function shapePath(ctx, shape, x, y, r) {
  ctx.beginPath();
  if (shape === 'circle') {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  } else if (shape === 'square') {
    ctx.rect(x - r, y - r, r * 2, r * 2);
  } else if (shape === 'triangle') {
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
      const px = x + r * Math.cos(a);
      const py = y + r * Math.sin(a);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();
  } else if (shape === 'hexagon') {
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      const px = x + r * Math.cos(a);
      const py = y + r * Math.sin(a);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();
  } else if (shape === 'octagon') {
    for (let i = 0; i < 8; i++) {
      const a = Math.PI / 8 + (i * Math.PI) / 4;
      const px = x + r * Math.cos(a);
      const py = y + r * Math.sin(a);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();
  }
}

function drawLine(ctx, state, line) {
  const pts = linePts(state, line);
  if (pts.length < 2) return;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = CONFIG.lines.width + 3;
  strokePolyline(ctx, pts);
  ctx.strokeStyle = PAL(line.color) ?? INK;
  ctx.lineWidth = CONFIG.lines.width;
  strokePolyline(ctx, pts);
  for (const id of line.stops) {
    const b = state.buildings.get(id);
    if (!b) continue;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(b.x, b.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function strokePolyline(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

function hexLerp(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

// three passes so junctions merge: every shoulder first (one continuous
// outline), every surface second, then centre dashes trimmed back from
// junctions — like Motorways, where dashes never run through an intersection
function drawRoads(ctx, state) {
  const w = CONFIG.roads.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#b0a99c';
  ctx.lineWidth = w + 2.5;
  for (const e of state.roadEdges.values()) {
    if (!e.motorway) strokePolyline(ctx, e.pts);
  }
  for (const e of state.roadEdges.values()) {
    if (e.motorway) continue;
    const cong = 1 - congestFactor(state, e); // 0 free → ~0.55 full
    const frac = Math.min(1, cong / (1 - CONFIG.roads.congestFactor));
    ctx.strokeStyle = hexLerp(ROAD_FREE, ROAD_BUSY, frac);
    ctx.lineWidth = w;
    strokePolyline(ctx, e.pts);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 5]);
  for (const e of state.roadEdges.values()) {
    if (e.motorway) continue;
    const L = polyLen(e.pts);
    const t = Math.min(w * 0.7, L / 2 - 4);   // pull dashes back from each end
    if (t <= 0) continue;
    strokePolyline(ctx, slicePolyline(e.pts, t / L, 1 - t / L));
  }
  ctx.setLineDash([]);
  // roundabout centres get a raised island — covers the spoke tips and makes
  // the ring read as one piece of kit rather than four little roads
  const islands = new Set();
  for (const e of state.roadEdges.values()) {
    const c = e.roundabout;
    if (!c) continue;
    const k = `${c.x},${c.y}`;
    if (islands.has(k)) continue;
    islands.add(k);
    ctx.fillStyle = '#b0a99c';
    ctx.beginPath();
    ctx.arc(c.x, c.y, CONFIG.roundabouts.radius * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#8f8a7d';
    ctx.beginPath();
    ctx.arc(c.x, c.y, CONFIG.roundabouts.radius * 0.55 - 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // traffic lights: the MM marker — a white ring at the junction plus a
  // green dot on each arm currently holding the green
  for (const n of state.roadNodes.values()) {
    const L = n.light;
    if (!L) continue;
    ctx.fillStyle = '#3a3a38';
    ctx.beginPath();
    ctx.arc(n.x, n.y, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#f5f2ec';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(n.x, n.y, 5.5, 0, Math.PI * 2);
    ctx.stroke();
    for (const eid of L.groups[L.idx] ?? []) {
      const e = state.roadEdges.get(eid);
      if (!e) continue;
      const atA = e.a === n.id;
      const pen = atA ? e.pts[1] : e.pts[e.pts.length - 2];
      if (!pen) continue;
      const ang = Math.atan2(pen.y - n.y, pen.x - n.x);
      ctx.fillStyle = '#2ecc71';
      ctx.beginPath();
      ctx.arc(n.x + Math.cos(ang) * 14, n.y + Math.sin(ang) * 14, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// motorways: a darker, chunkier carriageway painted after the buildings so
// spans read as overpasses — light casing, asphalt fill, white centre dashes
function drawMotorways(ctx, state) {
  const w = CONFIG.motorways.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#a39c8e';
  ctx.lineWidth = w + 3;
  for (const e of state.roadEdges.values()) {
    if (e.motorway) strokePolyline(ctx, e.pts);
  }
  ctx.strokeStyle = '#6f6a61';
  ctx.lineWidth = w;
  for (const e of state.roadEdges.values()) {
    if (e.motorway) strokePolyline(ctx, e.pts);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.65)';
  ctx.lineWidth = 1.4;
  ctx.setLineDash([7, 6]);
  for (const e of state.roadEdges.values()) {
    if (e.motorway) strokePolyline(ctx, e.pts);
  }
  ctx.setLineDash([]);
}

function drawRoadDraft(ctx, state, rd) {
  if (rd.motor) {
    // free-form span preview — dark while it can land, red until it does
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 0.75;
    ctx.setLineDash([10, 7]);
    ctx.strokeStyle = rd.endAnchored ? '#4a453f' : '#e63946';
    ctx.lineWidth = CONFIG.motorways.width - 2;
    strokePolyline(ctx, [...rd.pts, rd.tail]);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    if (rd.cursor) {
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillStyle = rd.endAnchored ? '#555' : '#e63946';
      ctx.fillText(
        rd.endAnchored ? '1 motorway' : 'end on a road or building',
        rd.cursor.x + 12, rd.cursor.y - 8,
      );
    }
    ctx.restore();
    return;
  }
  if (!rd.cells.length) return;
  const pts = rd.cells.map((c) => cellCenter(c.cx, c.cy));
  const demolish = rd.demolish;
  const cost = demolish ? 0 : roadCellCost(state, rd.cells);
  const ok = demolish || cost <= state.roadTiles;
  ctx.save();
  ctx.setLineDash([8, 6]);
  ctx.strokeStyle = demolish ? '#e63946' : ok ? '#8a8a8a' : '#e63946';
  ctx.lineWidth = CONFIG.roads.width - 1;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = 0.7;
  strokePolyline(ctx, pts);
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  if (rd.cursor) {
    ctx.font = '12px system-ui, sans-serif';
    if (demolish) {
      const refund = demolishRefund(state, rd.cells);
      ctx.fillStyle = '#e63946';
      if (refund > 0) ctx.fillText(`+${refund} tiles`, rd.cursor.x + 12, rd.cursor.y - 8);
    } else {
      ctx.fillStyle = ok ? '#555' : '#e63946';
      ctx.fillText(`${cost} tiles`, rd.cursor.x + 12, rd.cursor.y - 8);
    }
  }
  ctx.restore();
}

function drawCar(ctx, v) {
  const pos = carPos(v);
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate(pos.angle);
  ctx.fillStyle = PAL(v.color) ?? VEHICLE_COLORS[v.kind] ?? VEHICLE_COLORS.car;
  ctx.lineWidth = 1.2;
  if (v.kind === 'car') {
    ctx.strokeStyle = '#fff';
    roundRect(ctx, -6, -3.5, 12, 7, 3); // commuter capsule
    ctx.fill();
    ctx.stroke();
  } else {
    // boxy delivery truck: cargo bed + cab nose — reads at a glance vs cars
    ctx.strokeStyle = v.kind === 'milkTruck' ? '#8a857e' : '#fff';
    roundRect(ctx, -8, -4.5, 11, 9, 1.5);   // bed
    ctx.fill();
    ctx.stroke();
    roundRect(ctx, 3, -3.5, 5, 7, 1.5);     // cab
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawDraft(ctx, state, draft) {
  const bs = draft.stops.map((id) => state.buildings.get(id)).filter(Boolean);
  const color = draft.extend ? (PAL(draft.extend.color) ?? '#8a8a8a') : '#8a8a8a';
  const pts = [];
  for (let i = 0; i < bs.length; i++) {
    const seg = i === 0 ? [bs[0]] : routePts(bs[i - 1], bs[i]);
    for (const p of seg) {
      const last = pts[pts.length - 1];
      if (!last || last.x !== p.x || last.y !== p.y) pts.push(p);
    }
  }
  if (draft.cursor && bs.length) {
    for (const p of routePts(bs[bs.length - 1], draft.cursor).slice(1)) pts.push(p);
  }
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = CONFIG.lines.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (pts.length >= 2) strokePolyline(ctx, pts);
  ctx.globalAlpha = 1;
  for (const b of bs) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(b.x, b.y, bRad(b) + 5, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawTrain(ctx, state, v) {
  const line = state.lines.get(v.line);
  const pos = trainPos(state, v);
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate(pos.angle);
  ctx.fillStyle = line ? (PAL(line.color) ?? INK) : INK;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  if (v.freight) {
    // boxcar: plainer slab with crates stacked along the floor
    ctx.fillRect(-9, -4.5, 18, 9);
    ctx.strokeRect(-9, -4.5, 18, 9);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (let i = 0; i < v.pax.length; i++) {
      ctx.fillRect(-7 + i * 3.4, -2, 2.6, 4.5);
    }
  } else {
    // boxy carriage: sharp corners, window slots, pax shown along the bottom
    ctx.fillRect(-9, -5, 18, 10);
    ctx.strokeRect(-9, -5, 18, 10);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (const wx of [-6, -1, 4]) ctx.fillRect(wx, -2.5, 3, 4);
    for (let i = 0; i < v.pax.length; i++) {
      ctx.fillRect(-7 + i * 2.4, 2.2, 1.6, 1.8);
    }
  }
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const bRad = (b) =>
  b.type === 'work' ? CONFIG.buildings.workRadius
    : b.type === 'home' ? CONFIG.buildings.homeRadius
    : b.type === 'junction' ? CONFIG.buildings.junctionRadius
    : CONFIG.buildings.radius;

function drawBuilding(ctx, state, b, counts) {
  const r = bRad(b);
  if (!b.active) {
    // incoming-building warning: dashed pulsing outline
    const pulse = 1 + 0.12 * Math.sin(state.time * 6);
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#999';
    ctx.lineWidth = 2;
    shapePath(ctx, b.shape, b.x, b.y, r * pulse);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (b.type === 'junction') {
    // hollow interchange ring, coloured by the line it sits on
    ctx.strokeStyle = PAL(b.color) ?? INK;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.fillStyle = PAL(b.color) ?? INK;
    ctx.strokeStyle = '#f5f2ec';
    ctx.lineWidth = 2.5;
    shapePath(ctx, b.shape, b.x, b.y, r);
    ctx.fill();
    ctx.stroke();
  }

  drawWaiting(ctx, state, b);
  drawStaff(ctx, state, b);

  // homes: residents currently at home, centered in the circle — an empty
  // circle means everyone's out
  if (b.type === 'home') {
    const inHome = Math.max(0, CONFIG.homes.residents - (counts.out.get(b.id) ?? 0));
    for (let i = 0; i < inHome; i++) {
      const px = b.x + (i - (inHome - 1) / 2) * 11;
      ctx.fillStyle = '#6b6560';
      ctx.fillRect(px - 3.5, b.y - 3.5, 7, 7);
    }
  }

  // workplaces: on-shift workers visible inside the building — the same dark
  // squares as the waiting-people glyphs
  if (b.type === 'work') {
    const onShift = counts.shift.get(b.id) ?? 0;
    const cols = 3;
    for (let i = 0; i < Math.min(onShift, 9); i++) {
      const px = b.x + r - 10 - (i % cols) * 12;
      const py = b.y - r + 10 + Math.floor(i / cols) * 12;
      ctx.fillStyle = '#6b6560';
      ctx.fillRect(px - 3.5, py - 3.5, 7, 7);
    }
  }

  // workplaces: level pips in the bottom-left corner — the building has grown
  // through sustained service and demands proportionally more
  if (b.type === 'work') {
    ctx.fillStyle = 'rgba(245,242,236,0.85)';
    const n = b.level ?? 1;
    for (let i = 0; i < n; i++) {
      const px = b.x - r + 10 + i * 12;
      const py = b.y + r - 10;
      ctx.fillRect(px - 3.5, py - 3.5, 7, 7);
    }
  }

  // workplaces: demand meter — fills while no workers arrive
  if (b.type === 'work' && b.demandT > 0) {
    const frac = Math.min(1, b.demandT / CONFIG.demand.limit);
    ctx.strokeStyle = frac > 0.75 ? '#e63946' : '#6b6560';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(b.x, b.y, r + 9, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.stroke();
  }

  if (b.type === 'home' && b.hungerT > 1) {
    const frac = Math.min(1, b.hungerT / CONFIG.food.hungerLimit);
    ctx.strokeStyle = frac > 0.75 ? 'rgba(230,57,70,0.9)' : 'rgba(42,157,143,0.75)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(b.x, b.y, r + 10.5, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.stroke();
  }

  if (b.overflowT > 0.05) {
    const frac = Math.min(1, b.overflowT / CONFIG.overflowLimit);
    ctx.strokeStyle = '#6b6560'; // same grey as the waiting-people glyphs
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.arc(b.x, b.y, r + 7, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.stroke();
  }
}

// waiting agents rendered as a stack of their destination shapes (Mini Metro style)
function drawWaiting(ctx, state, b) {
  const r = bRad(b);
  const max = Math.min(b.waiting.length, 8);
  for (let i = 0; i < max; i++) {
    const a = state.agents.get(b.waiting[i]);
    if (!a) continue;
    const x = b.x - r - 13 - i * 11;
    const y = b.y + 22;
    let shape = 'circle';
    if (a.kind === 'crate') shape = 'hexagon';
    else {
      const target = a.legs?.[0]?.to != null ? state.buildings.get(a.legs[0].to) : null;
      shape = target?.shape ?? 'square';
    }
    ctx.fillStyle = a.kind === 'crate' ? '#7fb069' : '#6b6560';
    shapePath(ctx, shape, x, y, 4.5);
    ctx.fill();
  }
}

// farms/markets: staff as dark squares inside the glyph (green once the
// building is operational); market stock squares above
function drawStaff(ctx, state, b) {
  if (b.type !== 'farm' && b.type !== 'market') return;
  const r = bRad(b);
  const staffed = b.workers.length >= CONFIG.food.workersNeeded;
  const cols = 3;
  for (let i = 0; i < Math.min(b.workers.length, 6); i++) {
    const px = b.x + r - 7 - (i % cols) * 8;
    const py = b.y - r + 7 + Math.floor(i / cols) * 8;
    ctx.fillStyle = staffed ? '#2a9d8f' : '#6b6560';
    ctx.fillRect(px - 3, py - 3, 6, 6);
  }
  if (b.type === 'market') {
    for (let i = 0; i < Math.min(b.stock, 6); i++) {
      ctx.fillStyle = '#7fb069';
      ctx.fillRect(b.x - r - 5 + i * 7, b.y - r - 13, 5, 5);
    }
  }
}
