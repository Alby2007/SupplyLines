import { CONFIG } from './config.js';

const CS = () => CONFIG.grid.cell;

export function cellOf(p) {
  return { cx: Math.floor(p.x / CS()), cy: Math.floor(p.y / CS()) };
}

// cells a building's footprint covers — works sit on a grid vertex spanning
// a 2×2 block, everything else occupies just its own cell
export function buildingCells(b) {
  const c = cellOf(b);
  if (b.type !== 'work') return [c];
  return [
    { cx: c.cx - 1, cy: c.cy - 1 }, { cx: c.cx, cy: c.cy - 1 },
    { cx: c.cx - 1, cy: c.cy }, c,
  ];
}

export function cellCenter(cx, cy) {
  return { x: cx * CS() + CS() / 2, y: cy * CS() + CS() / 2 };
}

// pull a cell back inside the world rectangle — drawn paths must not
// leave the map (cells off the edge still cost tiles but can't be seen)
export function clampCell(c) {
  return {
    cx: Math.max(0, Math.min(Math.floor(CONFIG.map.width / CS()) - 1, c.cx)),
    cy: Math.max(0, Math.min(Math.floor(CONFIG.map.height / CS()) - 1, c.cy)),
  };
}

export const cellKey = (c) => `${c.cx},${c.cy}`;

export function snapPosToCell(p) {
  const c = cellOf(p);
  return cellCenter(c.cx, c.cy);
}

// 8-connected contiguous cell path a→b inclusive (Bresenham)
export function cellsBetween(a, b) {
  const cells = [];
  let x = a.cx;
  let y = a.cy;
  const dx = Math.abs(b.cx - x);
  const dy = Math.abs(b.cy - y);
  const sx = x < b.cx ? 1 : -1;
  const sy = y < b.cy ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    cells.push({ cx: x, cy: y });
    if (x === b.cx && y === b.cy) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return cells;
}

// metro-map route: diagonal cells until one axis aligns, then straight (≤1 bend)
export function routeCells(a, b) {
  const cells = [{ cx: a.cx, cy: a.cy }];
  let x = a.cx;
  let y = a.cy;
  const sx = Math.sign(b.cx - x);
  const sy = Math.sign(b.cy - y);
  while (x !== b.cx && y !== b.cy) {
    x += sx;
    y += sy;
    cells.push({ cx: x, cy: y });
  }
  while (x !== b.cx) { x += sx; cells.push({ cx: x, cy: y }); }
  while (y !== b.cy) { y += sy; cells.push({ cx: x, cy: y }); }
  return cells;
}

// contiguous cell cover of a polyline (used to index roads on the grid)
export function cellsAlongPolyline(pts) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    for (const c of cellsBetween(cellOf(pts[i - 1]), cellOf(pts[i]))) {
      if (!out.length || cellKey(out[out.length - 1]) !== cellKey(c)) out.push(c);
    }
  }
  return out;
}

// world-space polyline of a metro-map route between two points (≤1 bend);
// endpoints pinned to the exact positions given
export function routePts(a, b) {
  const cells = routeCells(cellOf(a), cellOf(b));
  if (cells.length < 2) return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
  const pts = cells.map((c) => cellCenter(c.cx, c.cy));
  pts[0] = { x: a.x, y: a.y };
  pts[pts.length - 1] = { x: b.x, y: b.y };
  return pts;
}

export function polyLen(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) {
    L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return L;
}

// arclength prefix sums for a polyline
export const cumLens = (pts) => {
  const c = [0];
  for (let i = 1; i < pts.length; i++) {
    c[i] = c[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return c;
};

// nearest point on a polyline to p: {t (0..1 by length), x, y, d}
export function nearestOnPolyline(pts, p) {
  const cum = cumLens(pts);
  const total = cum[cum.length - 1] || 1;
  let best = { d: Infinity, t: 0, x: pts[0].x, y: pts[0].y };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2)) : 0;
    const x = a.x + vx * t;
    const y = a.y + vy * t;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < best.d) {
      const segLen = Math.sqrt(len2);
      best = { d, t: (cum[i - 1] + t * segLen) / total, x, y };
    }
  }
  return best;
}
