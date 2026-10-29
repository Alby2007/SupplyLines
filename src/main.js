import { CONFIG } from './config.js';
import { createState } from './state.js';
import * as spawn from './spawn.js';
import * as economy from './economy.js';
import * as agents from './agents.js';
import * as vehicles from './vehicles.js';
import * as food from './food.js';
import { initInput, getDraft, getRoadDraft, getTool, getHover, updateCamera } from './input.js';
import { draw } from './render.js';
import { initUI, updateHUD, showUpgrade, showGameOver } from './ui.js';

const canvas = document.getElementById('game');
const state = createState();

const dpr = window.devicePixelRatio || 1;
canvas.width = CONFIG.view.width * dpr;
canvas.height = CONFIG.view.height * dpr;
fitCanvas();
const ctx = canvas.getContext('2d');
ctx.scale(dpr, dpr);

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

function tick(dt) {
  state.time += dt;
  state.weekT += dt;
  if (state.weekT >= CONFIG.weekSeconds) {
    state.weekT = 0;
    state.week++;
    state.upgradePending = true;
    state.roadTiles = Math.min(CONFIG.roads.tilesCap, state.roadTiles + CONFIG.roads.tilesPerWeek);
  }
  spawn.update(state, dt);
  economy.update(state, dt);
  food.update(state, dt);
  agents.update(state, dt);
  vehicles.update(state, dt);
}

function frame(now) {
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;
  if (!state.paused && !state.gameOver && !state.upgradePending) {
    acc += dt * state.speed * 0.5; // 1x = half-pace, 2x = the original speed
    while (acc >= STEP) {
      tick(STEP);
      acc -= STEP;
    }
  }
  if (state.upgradePending && !upgradeShown) {
    upgradeShown = true;
    showUpgrade(state);
  }
  if (!state.upgradePending) upgradeShown = false;
  if (state.gameOver && !state.gameOver.shown) {
    state.gameOver.shown = true;
    showGameOver(state);
  }
  updateCamera(state, dt); // camera pans even while paused
  // open on the seeded cluster, not the empty corner
  if (!state._camInit && state.buildings.size) {
    state._camInit = true;
    let cx = 0, cy = 0;
    for (const b of state.buildings.values()) { cx += b.x; cy += b.y; }
    cx /= state.buildings.size;
    cy /= state.buildings.size;
    state.camera.x = cx - CONFIG.view.width / 2;
    state.camera.y = cy - CONFIG.view.height / 2;
    updateCamera(state, 0); // just clamps
  }
  draw(ctx, state, getDraft(), getRoadDraft(), getTool(), state.camera, CONFIG.view.width, CONFIG.view.height, getHover());
  updateHUD(state);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
