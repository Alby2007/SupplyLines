import { CONFIG, applyLevelOverrides } from './config.js';
import { createState, applyLevelFeatures } from './state.js';
import { tick } from './tick.js';
import { initInput, getDraft, getRoadDraft, getTool, getHover, updateCamera } from './input.js';
import { draw, drawMinimap } from './render.js';
import { initUI, updateHUD, showUpgrade, showGameOver } from './ui.js';

const canvas = document.getElementById('game');
// ?level=N picks the map — per-level CONFIG overrides must apply before
// createState(), which reads CONFIG fields for initial values
const params = new URLSearchParams(location.search);
const level = parseInt(params.get('level') ?? '1', 10) || 1;
applyLevelOverrides(level);
const state = createState();
state.level = level;
applyLevelFeatures(state);
// ?debug — live-state inspection for "why is X happening" (off by default)
if (params.has('debug')) window.__state = state;
const SURFACES = { 1: '#dce9cf', 2: '#f0dcae', 3: '#8fbe7d' }; // per-map ground
canvas.style.background = SURFACES[state.level] ?? SURFACES[1];

const dpr = window.devicePixelRatio || 1;
canvas.width = CONFIG.view.width * dpr;
canvas.height = CONFIG.view.height * dpr;
fitCanvas();
const ctx = canvas.getContext('2d');
ctx.scale(dpr, dpr);

// corner minimap — ~110px tall regardless of the map's aspect
const minimap = document.getElementById('minimap');
const MW = CONFIG.map.width * (110 / CONFIG.map.height);
const MH = 110;
minimap.width = MW * dpr;
minimap.height = MH * dpr;
minimap.style.width = `${MW}px`;
minimap.style.height = `${MH}px`;
minimap.style.background = SURFACES[state.level] ?? SURFACES[1];
const mctx = minimap.getContext('2d');
mctx.scale(dpr, dpr);

function fitCanvas() {
  const availW = window.innerWidth - 32;
  const availH = window.innerHeight - 76;
  const s = Math.min(1, availW / CONFIG.view.width, availH / CONFIG.view.height);
  canvas.style.width = `${CONFIG.view.width * s}px`;
  canvas.style.height = `${CONFIG.view.height * s}px`;
}
window.addEventListener('resize', fitCanvas);

const toWorld = (e) => {
  const r = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * CONFIG.view.width + state.camera.x,
    y: ((e.clientY - r.top) / r.height) * CONFIG.view.height + state.camera.y,
  };
};

initInput(canvas, state, toWorld);
initUI(state);

const STEP = 1 / 60;
let last = performance.now();
let acc = 0;
let upgradeShown = false;
let gameOverShown = false;
let camInit = false;

function frame(now) {
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;
  if (!state.paused && !state.gameOver && !state.upgradePending) {
    acc += dt * state.speed * 0.5; // 1x = half-pace, 2x = the original speed
    while (acc >= STEP) {
      tick(state, STEP);
      acc -= STEP;
    }
  }
  if (state.upgradePending && !upgradeShown) {
    upgradeShown = true;
    showUpgrade(state);
  }
  if (!state.upgradePending) upgradeShown = false;
  if (state.gameOver && !gameOverShown) {
    gameOverShown = true;
    showGameOver(state);
  }
  updateCamera(state, dt); // camera pans even while paused
  // open on the seeded cluster, not the empty corner
  if (!camInit && state.buildings.size) {
    camInit = true;
    let cx = 0, cy = 0;
    for (const b of state.buildings.values()) { cx += b.x; cy += b.y; }
    cx /= state.buildings.size;
    cy /= state.buildings.size;
    state.camera.x = cx - CONFIG.view.width / 2;
    state.camera.y = cy - CONFIG.view.height / 2;
    updateCamera(state, 0); // just clamps
  }
  draw(ctx, state, getDraft(), getRoadDraft(), getTool(), state.camera, CONFIG.view.width, CONFIG.view.height, getHover());
  drawMinimap(mctx, state, state.camera, MW, MH);
  updateHUD(state);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
