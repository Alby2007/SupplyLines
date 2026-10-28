import { CONFIG } from './config.js';
import { addLine, extendLine, endpointLines, addJunction, insertJunction, junctionPlacement, junctionCanJoin } from './networks.js';
import { addTrain } from './vehicles.js';
import { buildRoad, roadCellCost, nearestEdgePoint } from './roads.js';
import { dist } from './state.js';
import { cellOf, cellsBetween, cellKey } from './grid.js';

const HIT_RADIUS = 22;

let draft = null;      // line draft
let roadDraft = null;  // road draft
let tool = 'line';
let canvasEl = null;
let panDrag = null;    // {x, y} last client position while panning
const camKeys = new Set();

const clampCam = (state) => {
  state.camera.x = Math.max(0, Math.min(CONFIG.map.width - CONFIG.view.width, state.camera.x));
  state.camera.y = Math.max(0, Math.min(CONFIG.map.height - CONFIG.view.height, state.camera.y));
};

// smooth pan — WASD/arrows held down; called per frame (works while paused)
export function updateCamera(state, dt) {
  const sp = 620 * dt;
  if (camKeys.has('a') || camKeys.has('arrowleft')) state.camera.x -= sp;
  if (camKeys.has('d') || camKeys.has('arrowright')) state.camera.x += sp;
  if (camKeys.has('w') || camKeys.has('arrowup')) state.camera.y -= sp;
  if (camKeys.has('s') || camKeys.has('arrowdown')) state.camera.y += sp;
  clampCam(state);
}

export const getDraft = () => draft;
export const getRoadDraft = () => roadDraft;
export const getTool = () => tool;
export function setTool(t) {
  tool = tool === t ? null : t; // re-clicking the armed tool disarms it
  draft = null;
  roadDraft = null;
  if (canvasEl) canvasEl.style.cursor = tool == null ? 'grab' : 'crosshair';
}

export function hitBuilding(state, p) {
  let best = null;
  let bestD = Infinity;
  for (const b of state.buildings.values()) {
    const d = dist(b, p);
    const rad = b.type === 'work' ? CONFIG.buildings.workRadius + 8 : HIT_RADIUS;
    if (d < rad && d < bestD) { bestD = d; best = b; }
  }
  return best;
}

// read-only endpoint snap: building > existing road > free point
function snapPoint(state, p) {
  const b = hitBuilding(state, p);
  if (b && b.active && b.type !== 'junction') return { x: b.x, y: b.y, anchored: true };
  const ne = nearestEdgePoint(state, p);
  if (ne && ne.d <= CONFIG.roads.snap) return { x: ne.x, y: ne.y, anchored: true };
  return { x: p.x, y: p.y, anchored: false };
}

// append contiguous cells from the draft's last cell to `to` (exclusive of last)
function extendCells(cells, to) {
  const last = cells[cells.length - 1];
  if (cellKey(last) === cellKey(to)) return;
  for (const c of cellsBetween(last, to).slice(1)) cells.push(c);
}

export function initInput(canvas, state, toWorld) {
  canvasEl = canvas;
  canvas.addEventListener('pointerdown', (e) => {
    if (state.gameOver || state.upgradePending) return;
    const p = toWorld(e);

    // grab-pan: middle button always, left button when no tool is armed
    if (e.button === 1 || tool == null) {
      panDrag = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
      return;
    }

    if (tool === 'junction') {
      const pl = junctionPlacement(state, p);
      if (pl) {
        const j = addJunction(state, pl.x, pl.y, pl.line.color);
        insertJunction(state, j, pl.line, pl.segIdx);
      }
      return;
    }

    if (tool === 'road') {
      const s = snapPoint(state, p);
      roadDraft = {
        cells: [cellOf(s)],
        startAnchored: s.anchored,
        endAnchored: s.anchored,
        cursor: p,
      };
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (tool !== 'line') return; // no tool armed → click does nothing
    const b = hitBuilding(state, p);
    if (!b || !b.active || b.color == null) return; // neutral buildings can't be stops
    const ends = endpointLines(state, b.id);
    const extend = ends.length === 1 ? ends[0] : null;
    if (!extend && state.lines.size >= state.maxLines) return;
    draft = {
      stops: [b.id],
      color: extend ? extend.color : b.color,
      cursor: p,
      extend,
      prepend: extend ? extend.stops[0] === b.id : false,
    };
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (panDrag) {
      const r = canvas.getBoundingClientRect();
      const k = CONFIG.view.width / r.width; // world px per screen px
      state.camera.x -= (e.clientX - panDrag.x) * k;
      state.camera.y -= (e.clientY - panDrag.y) * k;
      panDrag = { x: e.clientX, y: e.clientY };
      clampCam(state);
      return;
    }
    const p = toWorld(e);

    if (roadDraft) {
      roadDraft.cursor = p;
      const s = snapPoint(state, p);
      extendCells(roadDraft.cells, cellOf(s));
      roadDraft.endAnchored = s.anchored;
      return;
    }
    if (!draft) return;
    draft.cursor = p;
    const b = hitBuilding(state, p);
    if (!b || !b.active) return;
    const s = draft.stops;
    if (b.id === s[s.length - 2]) { s.pop(); return; }
    if (b.id === s[s.length - 1] || s.includes(b.id)) return;
    if (b.color !== draft.color) return; // lines are colour-locked
    if (b.color == null) return;
    if (b.type === 'junction' && !junctionCanJoin(state, b.id)) return;
    // extending: only allow re-touching the line's far endpoint (closes a loop)
    if (draft.extend && draft.extend.stops.includes(b.id)) {
      const far = draft.prepend
        ? draft.extend.stops[draft.extend.stops.length - 1]
        : draft.extend.stops[0];
      if (b.id !== far) return;
    }
    s.push(b.id);
  });

  const finish = () => {
    if (panDrag) {
      panDrag = null;
      canvas.style.cursor = tool == null ? 'grab' : 'crosshair';
      return;
    }
    if (roadDraft) {
      const rd = roadDraft;
      roadDraft = null;
      const s = snapPoint(state, rd.cursor);
      extendCells(rd.cells, cellOf(s));
      const anchored = rd.startAnchored || s.anchored;
      if (anchored && rd.cells.length >= 2) {
        const cost = roadCellCost(state, rd.cells);
        if (cost <= state.roadTiles) {
          // only pay for tiles actually laid — blocked paths (junction cells) refund
          if (buildRoad(state, rd.cells).length) state.roadTiles -= cost;
        }
      }
      return;
    }
    if (!draft) return;
    const d = draft;
    draft = null;
    if (d.extend) {
      const added = d.stops.slice(1);
      if (added.length) extendLine(state, d.extend, added, d.prepend);
    } else if (d.stops.length >= 2) {
      addTrain(state, addLine(state, d.stops));
    }
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', () => { draft = null; roadDraft = null; panDrag = null; });

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd'].includes(k) || k.startsWith('arrow')) {
      camKeys.add(k);
      e.preventDefault();
      return;
    }
    if (e.key === ' ') { state.paused = !state.paused; e.preventDefault(); }
    else if (e.key === '1') state.speed = 1;
    else if (e.key === '2') state.speed = 2;
    else if (k === 'l') setTool('line');
    else if (k === 'j') setTool('junction');
    else if (k === 'r') setTool('road');
    else if (e.key === 'Escape') { draft = null; roadDraft = null; }
  });
  window.addEventListener('keyup', (e) => camKeys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => camKeys.clear());
}
