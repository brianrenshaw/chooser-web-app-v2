// Scoring Mode view. Renders a shared circular ring with one puck per
// player anchored at evenly-spaced poles around the ring. The score
// gesture is a circular drag: put a finger near your puck, rotate
// around the ring center, every 30° of cumulative rotation = one
// detent (=+SCORE_STEP, or -SCORE_STEP if Allow Negative Scores is on).
// Releasing commits the total delta as one undoable action.
//
// Rendering: the ring, arcs, and pucks are drawn on a single <canvas>
// element. SVG was tried first but its arc command becomes ambiguous
// near 2π span and z-order has to be managed by reordering DOM nodes;
// canvas's ctx.arc takes start/end angles directly and z-order is
// just draw order.

import { detentHaptic, commitHaptic, ensureAudio } from './feedback.js';
import * as storage from './storage.js';

const RING_RADIUS = 100;                  // logical units; scales to canvas
const RING_STROKE = 36;
const PUCK_RADIUS = 18;
const VIEWBOX_PAD = 26;                   // breathing room around the ring
const DETENT_RAD = Math.PI / 6;           // 30° per detent
const HIT_ANGULAR_TOLERANCE = Math.PI / 3;
const HIT_RADIAL_TOLERANCE = 80;
const ARC_VISUAL_CLAMP = 2 * Math.PI - 0.001;

let SCORE_STEP = 1;
let ALLOW_NEGATIVE = false;

let stage = null;
let canvas = null;                        // the <canvas> ring element
let ctx = null;
let canvasResizeObserver = null;
let drawScheduled = false;
let mounted = false;
let players = [];
let game = defaultGame();
const ledger = [];
const undoStack = [];
const redoStack = [];
const playerAngles = new Map();           // playerId -> current visual angle (rad)
const gestures = new Map();               // pointerId -> gesture state
let listeners = [];

const LEDGER_CAP = 500;
const ARCHIVE_CAP = 20;

function defaultGame() {
  return { name: '', notes: '', startedAt: Date.now() };
}

const DEFAULT_PLAYERS = [
  { name: 'Brian', hue: 214 },
  { name: 'Brad', hue: 25 },
];

function makePlayerId(i) {
  return `p${i + 1}`;
}

function anchorAngleRad(i, n) {
  return -Math.PI / 2 + (2 * Math.PI * i) / n;
}

function getPlayer(id) {
  return players.find((p) => p.id === id) ?? null;
}

function isPlayerInGesture(playerId) {
  for (const g of gestures.values()) if (g.playerId === playerId) return true;
  return false;
}

// ---- Canvas setup and drawing ----

function setupCanvas(parent) {
  canvas = document.createElement('canvas');
  canvas.className = 'scoring-ring';
  parent.appendChild(canvas);
  ctx = canvas.getContext('2d');
  resizeCanvas();
  if (window.ResizeObserver) {
    canvasResizeObserver = new ResizeObserver(() => resizeCanvas());
    canvasResizeObserver.observe(canvas);
  }
}

function teardownCanvas() {
  if (canvasResizeObserver) {
    try { canvasResizeObserver.disconnect(); } catch (_) {}
    canvasResizeObserver = null;
  }
  canvas = null;
  ctx = null;
}

function resizeCanvas() {
  if (!canvas || !ctx) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

// Compute the visible ring radius (in CSS pixels) for the current canvas size.
function ringPixelRadius(cssWidth, cssHeight) {
  const half = Math.min(cssWidth, cssHeight) / 2;
  return half * (RING_RADIUS / (RING_RADIUS + VIEWBOX_PAD));
}

function scheduleDraw() {
  if (drawScheduled) return;
  drawScheduled = true;
  requestAnimationFrame(() => {
    drawScheduled = false;
    draw();
  });
}

function draw() {
  if (!ctx || !canvas) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  const cx = w / 2;
  const cy = h / 2;
  const r = ringPixelRadius(w, h);
  const stroke = r * (RING_STROKE / RING_RADIUS);
  const puckR = r * (PUCK_RADIUS / RING_RADIUS);

  ctx.clearRect(0, 0, w, h);

  // 1) Ring track (full circle, dark grey)
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.lineWidth = stroke;
  ctx.strokeStyle = '#1c1c1e';
  ctx.lineCap = 'butt';
  ctx.stroke();

  const activeIds = new Set();
  for (const g of gestures.values()) activeIds.add(g.playerId);

  // 2) Idle pucks (rendered behind any active arc that sweeps past them)
  for (const p of players) {
    if (activeIds.has(p.id)) continue;
    const angle = playerAngles.get(p.id) ?? anchorAngleRad(p.index, players.length);
    drawPuck(cx, cy, r, puckR, angle, p.hue);
  }

  // 3) Active arcs (cover idle pucks they overlap)
  for (const g of gestures.values()) {
    drawArc(cx, cy, r, stroke, g);
  }

  // 4) Active pucks (on top of arcs)
  for (const p of players) {
    if (!activeIds.has(p.id)) continue;
    const angle = playerAngles.get(p.id) ?? anchorAngleRad(p.index, players.length);
    drawPuck(cx, cy, r, puckR, angle, p.hue);
  }
}

function drawPuck(cx, cy, ringR, puckR, angleRad, hue) {
  const px = cx + Math.cos(angleRad) * ringR;
  const py = cy + Math.sin(angleRad) * ringR;
  ctx.beginPath();
  ctx.arc(px, py, puckR, 0, 2 * Math.PI);
  ctx.fillStyle = `oklch(70% 0.20 ${hue})`;
  ctx.fill();
}

function drawArc(cx, cy, r, stroke, gesture) {
  const cum = gesture.cumulativeDeltaRad;
  if (Math.abs(cum) < 0.001) return;
  const clamped = Math.max(-ARC_VISUAL_CLAMP, Math.min(ARC_VISUAL_CLAMP, cum));
  const start = gesture.anchorAngle;
  const end = start + clamped;
  const anticlockwise = clamped < 0;
  ctx.beginPath();
  ctx.arc(cx, cy, r, start, end, anticlockwise);
  ctx.lineWidth = stroke;
  ctx.strokeStyle = `oklch(70% 0.20 ${gesture.hue})`;
  ctx.lineCap = 'butt';
  ctx.stroke();
}

// ---- Hit testing ----

function getRingScreenGeometry() {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const screenRadius = ringPixelRadius(rect.width, rect.height);
  return { cx, cy, screenRadius };
}

function angleFromScreen(x, y, geom) {
  return Math.atan2(y - geom.cy, x - geom.cx);
}

function angularDistance(a, b) {
  let d = ((a - b) + Math.PI) % (2 * Math.PI) - Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

function hitTestPuck(screenX, screenY) {
  const geom = getRingScreenGeometry();
  if (!geom) return null;
  const dx = screenX - geom.cx;
  const dy = screenY - geom.cy;
  const distFromCenter = Math.hypot(dx, dy);
  if (Math.abs(distFromCenter - geom.screenRadius) > HIT_RADIAL_TOLERANCE) return null;
  const fingerAngle = Math.atan2(dy, dx);
  let best = null;
  let bestDelta = Infinity;
  for (const p of players) {
    if (isPlayerInGesture(p.id)) continue;
    const puckAngle = playerAngles.get(p.id) ?? anchorAngleRad(p.index, players.length);
    const delta = angularDistance(fingerAngle, puckAngle);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = p;
    }
  }
  if (!best || bestDelta > HIT_ANGULAR_TOLERANCE) return null;
  return best;
}

function setPuckAngle(playerId, angleRad) {
  playerAngles.set(playerId, angleRad);
  scheduleDraw();
}

// ---- Score label updates (HTML, separate from canvas) ----

function setScoreText(player, text, isDelta) {
  const labelEl = stage.querySelector(`.player-label[data-player-id="${player.id}"]`);
  if (!labelEl) return;
  labelEl.classList.toggle('dragging', !!isDelta);
  const scoreEl = labelEl.querySelector('.player-score');
  if (scoreEl) scoreEl.textContent = text;
}

function refreshScoreText(player) {
  setScoreText(player, String(player.score), false);
}

function formatDelta(n) {
  if (n > 0) return `+${n}`;
  if (n < 0) return String(n);
  return '+0';
}

function unwrapAngleDelta(prev, curr) {
  let d = curr - prev;
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// ---- Gesture handlers ----

function startGesture(e, player) {
  const geom = getRingScreenGeometry();
  if (!geom) return;
  const startAngle = angleFromScreen(e.clientX, e.clientY, geom);
  const anchorAngle = anchorAngleRad(player.index, players.length);
  const gesture = {
    pointerId: e.pointerId,
    playerId: player.id,
    hue: player.hue,
    anchorAngle,
    startAngle,
    lastAngle: startAngle,
    cumulativeDeltaRad: 0,
    detentsCommitted: 0,
    sign: 0,
    initialPuckAngle: playerAngles.get(player.id) ?? anchorAngle,
  };
  gestures.set(e.pointerId, gesture);
  // Decouple puck from anchor; it now follows the finger.
  setPuckAngle(player.id, startAngle);
  setScoreText(player, formatDelta(0), true);
  scheduleDraw();
}

function updateGesture(e) {
  const gesture = gestures.get(e.pointerId);
  if (!gesture) return;
  const player = getPlayer(gesture.playerId);
  if (!player) return;
  const geom = getRingScreenGeometry();
  if (!geom) return;
  const currAngle = angleFromScreen(e.clientX, e.clientY, geom);
  const frameDelta = unwrapAngleDelta(gesture.lastAngle, currAngle);
  gesture.cumulativeDeltaRad += frameDelta;
  gesture.lastAngle = currAngle;

  const cum = gesture.cumulativeDeltaRad;
  const targetDetents = Math.floor(Math.abs(cum) / DETENT_RAD);
  const sign = cum >= 0 ? 1 : -1;

  if (sign !== gesture.sign && targetDetents === 0) {
    gesture.sign = 0;
    gesture.detentsCommitted = 0;
  } else if (targetDetents !== gesture.detentsCommitted || sign !== gesture.sign) {
    const crossings = targetDetents - gesture.detentsCommitted;
    if (crossings > 0 && targetDetents > 0) {
      if (!ALLOW_NEGATIVE && sign < 0) {
        gesture.sign = -1;
        gesture.detentsCommitted = targetDetents;
      } else {
        gesture.sign = sign;
        gesture.detentsCommitted = targetDetents;
        for (let i = 0; i < crossings; i++) detentHaptic();
      }
    } else {
      gesture.sign = sign;
      gesture.detentsCommitted = targetDetents;
    }
  }

  let liveDelta = gesture.sign * gesture.detentsCommitted * SCORE_STEP;
  if (!ALLOW_NEGATIVE && (player.score + liveDelta) < 0) {
    liveDelta = -player.score;
  }
  setScoreText(player, formatDelta(liveDelta), true);

  setPuckAngle(player.id, currAngle);
}

function commitGesture(e) {
  const gesture = gestures.get(e.pointerId);
  if (!gesture) return;
  const player = getPlayer(gesture.playerId);
  gestures.delete(e.pointerId);
  if (!player) {
    scheduleDraw();
    return;
  }

  let totalDelta = gesture.sign * gesture.detentsCommitted * SCORE_STEP;
  if (!ALLOW_NEGATIVE && (player.score + totalDelta) < 0) {
    totalDelta = -player.score;
  }

  if (totalDelta !== 0) {
    const at = Date.now();
    const prevScore = player.score;
    player.score += totalDelta;
    commitHaptic();
    ledger.push({ playerId: player.id, delta: totalDelta, at });
    if (ledger.length > LEDGER_CAP) ledger.shift();
    undoStack.push({ playerId: player.id, totalDelta, prevScore, at });
    redoStack.length = 0;
    persistActiveGame();
    notifyChange();
  }

  refreshScoreText(player);
  // Snap puck back to anchor (instantaneous teleport on canvas).
  const anchor = anchorAngleRad(player.index, players.length);
  setPuckAngle(player.id, anchor);
}

function cancelGesture(e) {
  const gesture = gestures.get(e.pointerId);
  if (!gesture) return;
  const player = getPlayer(gesture.playerId);
  gestures.delete(e.pointerId);
  if (!player) {
    scheduleDraw();
    return;
  }
  refreshScoreText(player);
  const anchor = anchorAngleRad(player.index, players.length);
  setPuckAngle(player.id, anchor);
}

function onPointerDown(e) {
  ensureAudio();
  const player = hitTestPuck(e.clientX, e.clientY);
  if (!player) return;
  e.preventDefault();
  startGesture(e, player);
  try { stage.setPointerCapture?.(e.pointerId); } catch (_) {}
}

function onPointerMove(e) {
  if (!gestures.has(e.pointerId)) return;
  e.preventDefault();
  updateGesture(e);
}

function onPointerUp(e) {
  if (!gestures.has(e.pointerId)) return;
  e.preventDefault();
  commitGesture(e);
}

function onPointerCancel(e) {
  if (!gestures.has(e.pointerId)) return;
  e.preventDefault();
  cancelGesture(e);
}

function on(target, type, fn) {
  target.addEventListener(type, fn);
  listeners.push({ target, type, fn });
}

// ---- Layout (HTML labels + canvas placement) ----

function makePlayerLabelEl(p, extraClass = '') {
  const el = document.createElement('div');
  el.className = 'player-label' + (extraClass ? ' ' + extraClass : '');
  el.dataset.playerId = p.id;
  el.style.color = `oklch(70% 0.20 ${p.hue})`;
  el.innerHTML = `
    <div class="player-name">${escapeHtml(p.name)}</div>
    <div class="player-score">${p.score}</div>
  `;
  return el;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

let labelResizeObserver = null;

function disconnectLabelObserver() {
  if (labelResizeObserver) {
    try { labelResizeObserver.disconnect(); } catch (_) {}
    labelResizeObserver = null;
  }
}

function positionRadialLabels(container) {
  const rect = container.getBoundingClientRect();
  if (rect.width === 0) return;
  const halfW = rect.width / 2;
  const ringR = halfW * (RING_RADIUS / (RING_RADIUS + VIEWBOX_PAD));
  const labelR = ringR + Math.min(56, halfW * 0.22);
  for (const p of players) {
    const angle = anchorAngleRad(p.index, players.length);
    const x = Math.cos(angle) * labelR;
    const y = Math.sin(angle) * labelR;
    const rotDeg = angle * 180 / Math.PI + 90;
    const label = container.querySelector(
      `.player-label.radial[data-player-id="${p.id}"]`
    );
    if (!label) continue;
    label.style.transform =
      `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${rotDeg.toFixed(1)}deg)`;
  }
}

function ensureAnglesInitialized() {
  for (const p of players) {
    if (!playerAngles.has(p.id)) {
      playerAngles.set(p.id, anchorAngleRad(p.index, players.length));
    }
  }
}

function renderTwoPlayerLayout() {
  const top = makePlayerLabelEl(players[0]);
  top.dataset.anchor = 'top';
  const bottom = makePlayerLabelEl(players[1]);
  bottom.dataset.anchor = 'bottom';
  stage.appendChild(top);
  setupCanvas(stage);                 // appends the canvas to stage
  stage.appendChild(bottom);          // bottom label comes after the canvas
}

function renderRadialLayout() {
  const container = document.createElement('div');
  container.className = 'ring-container radial';
  setupCanvas(container);
  stage.appendChild(container);
  for (const p of players) {
    const label = makePlayerLabelEl(p, 'radial');
    container.appendChild(label);
  }
  requestAnimationFrame(() => {
    positionRadialLabels(container);
    resizeCanvas();
  });
  if (window.ResizeObserver) {
    disconnectLabelObserver();
    labelResizeObserver = new ResizeObserver(() => positionRadialLabels(container));
    labelResizeObserver.observe(container);
  } else {
    window.addEventListener('resize', () => positionRadialLabels(container));
  }
}

function renderStackLayout() {
  const wrap = document.createElement('div');
  wrap.className = 'players-stack';
  const note = document.createElement('div');
  note.className = 'stack-note';
  note.textContent = 'Scoring with 9+ players is read-only for now. Use the chooser or remove players in Settings.';
  wrap.appendChild(note);
  for (const p of players) {
    const row = document.createElement('div');
    row.className = 'player-row-stack';
    row.dataset.playerId = p.id;
    row.style.color = `oklch(70% 0.20 ${p.hue})`;
    row.innerHTML = `
      <div class="player-name">${escapeHtml(p.name)}</div>
      <div class="player-score">${p.score}</div>
    `;
    wrap.appendChild(row);
  }
  stage.appendChild(wrap);
  // No canvas in stack mode → drag gestures cannot start.
  teardownCanvas();
}

function render() {
  disconnectLabelObserver();
  teardownCanvas();
  stage.innerHTML = '';
  ensureAnglesInitialized();
  if (players.length <= 2) {
    renderTwoPlayerLayout();
  } else if (players.length <= 8) {
    renderRadialLayout();
  } else {
    renderStackLayout();
  }
  scheduleDraw();
}

function buildPlayersFromInitial(initial) {
  const source = (initial && initial.length > 0) ? initial : DEFAULT_PLAYERS;
  return source.map((p, i) => ({
    id: makePlayerId(i),
    index: i,
    name: p.name ?? `Player ${i + 1}`,
    hue: p.hue ?? 214,
    score: p.score ?? 0,
  }));
}

let changeListeners = [];

function notifyChange() {
  for (const fn of changeListeners) {
    try { fn(); } catch (_) {}
  }
}

export function onChange(fn) {
  changeListeners.push(fn);
  return () => {
    changeListeners = changeListeners.filter((f) => f !== fn);
  };
}

// ---- Storage / state lifecycle ----

function snapshotForStorage() {
  return {
    game,
    players: players.map((p) => ({
      id: p.id, index: p.index, name: p.name, hue: p.hue, score: p.score,
    })),
    ledger,
    undoStack,
    redoStack,
  };
}

function persistActiveGame() {
  storage.set('activeGame', snapshotForStorage());
}

function persistSettings() {
  storage.set('settings', {
    scoreStep: SCORE_STEP,
    allowNegative: ALLOW_NEGATIVE,
  }, { debounceMs: 0 });
}

function hydrateFromStorage() {
  const saved = storage.get('activeGame');
  if (!saved || !Array.isArray(saved.players) || saved.players.length === 0) {
    return false;
  }
  game = saved.game ?? defaultGame();
  players = saved.players.map((p, i) => ({
    id: p.id ?? makePlayerId(i),
    index: typeof p.index === 'number' ? p.index : i,
    name: p.name ?? `Player ${i + 1}`,
    hue: typeof p.hue === 'number' ? p.hue : 214,
    score: typeof p.score === 'number' ? p.score : 0,
  }));
  ledger.length = 0;
  for (const entry of (saved.ledger ?? [])) ledger.push(entry);
  undoStack.length = 0;
  for (const entry of (saved.undoStack ?? [])) undoStack.push(entry);
  redoStack.length = 0;
  for (const entry of (saved.redoStack ?? [])) redoStack.push(entry);
  return true;
}

function hydrateSettings() {
  const s = storage.get('settings');
  if (!s) return;
  if (typeof s.scoreStep === 'number' && s.scoreStep >= 1) SCORE_STEP = Math.floor(s.scoreStep);
  if (typeof s.allowNegative === 'boolean') ALLOW_NEGATIVE = s.allowNegative;
}

function findLedgerIndex(playerId, at) {
  for (let i = ledger.length - 1; i >= 0; i--) {
    if (ledger[i].playerId === playerId && ledger[i].at === at) return i;
  }
  return -1;
}

export function undo() {
  if (undoStack.length === 0) return false;
  const entry = undoStack.pop();
  const player = getPlayer(entry.playerId);
  if (!player) {
    redoStack.push(entry);
    persistActiveGame();
    notifyChange();
    return true;
  }
  player.score = entry.prevScore;
  const i = findLedgerIndex(entry.playerId, entry.at);
  if (i !== -1) ledger.splice(i, 1);
  redoStack.push(entry);
  refreshScoreText(player);
  persistActiveGame();
  notifyChange();
  commitHaptic();
  return true;
}

export function redo() {
  if (redoStack.length === 0) return false;
  const entry = redoStack.pop();
  const player = getPlayer(entry.playerId);
  if (!player) {
    undoStack.push(entry);
    persistActiveGame();
    notifyChange();
    return true;
  }
  player.score += entry.totalDelta;
  ledger.push({ playerId: entry.playerId, delta: entry.totalDelta, at: entry.at });
  if (ledger.length > LEDGER_CAP) ledger.shift();
  undoStack.push(entry);
  refreshScoreText(player);
  persistActiveGame();
  notifyChange();
  commitHaptic();
  return true;
}

export function canUndo() { return undoStack.length > 0; }
export function canRedo() { return redoStack.length > 0; }

export function getLedger() { return ledger.slice(); }
export function getGame() { return { ...game }; }

export function setGameName(name) {
  game.name = String(name ?? '');
  persistActiveGame();
  notifyChange();
}

export function setGameNotes(notes) {
  game.notes = String(notes ?? '');
  persistActiveGame();
  notifyChange();
}

export function startNewGame(initialPlayers = null) {
  if (ledger.length > 0 || players.some((p) => p.score !== 0)) {
    const archive = storage.get('archive') ?? [];
    archive.unshift({
      name: game.name,
      notes: game.notes,
      startedAt: game.startedAt,
      finishedAt: Date.now(),
      players: players.map((p) => ({ name: p.name, hue: p.hue, score: p.score })),
      ledger: ledger.slice(),
    });
    if (archive.length > ARCHIVE_CAP) archive.length = ARCHIVE_CAP;
    storage.set('archive', archive, { debounceMs: 0 });
  }
  game = defaultGame();
  if (initialPlayers && initialPlayers.length > 0) {
    players = buildPlayersFromInitial(initialPlayers);
  } else {
    players = players.map((p) => ({ ...p, score: 0 }));
    if (players.length === 0) players = buildPlayersFromInitial(null);
  }
  ledger.length = 0;
  undoStack.length = 0;
  redoStack.length = 0;
  playerAngles.clear();
  gestures.clear();
  if (mounted) render();
  persistActiveGame();
  notifyChange();
}

export function getArchive() {
  return storage.get('archive') ?? [];
}

export function renamePlayer(id, newName) {
  const p = getPlayer(id);
  if (!p) return;
  p.name = String(newName ?? '').trim() || p.name;
  if (mounted) render();
  persistActiveGame();
  notifyChange();
}

export function setPlayerHue(id, hue) {
  const p = getPlayer(id);
  if (!p) return;
  p.hue = Number(hue);
  if (mounted) render();
  persistActiveGame();
  notifyChange();
}

export function addPlayer() {
  if (players.length >= 8) return;
  const i = players.length;
  const usedHues = new Set(players.map((p) => Math.round(p.hue)));
  const palette = [214, 25, 145, 280, 50, 320, 175, 0];
  let hue = palette[i % palette.length];
  for (const h of palette) {
    if (!usedHues.has(h)) { hue = h; break; }
  }
  const newPlayer = {
    id: makePlayerId(Date.now() % 100000) + '_' + i,
    index: i,
    name: `Player ${i + 1}`,
    hue,
    score: 0,
  };
  players.push(newPlayer);
  players.forEach((p, idx) => { p.index = idx; });
  playerAngles.clear();
  if (mounted) render();
  persistActiveGame();
  notifyChange();
}

export function removePlayer(id) {
  if (players.length <= 1) return;
  const idx = players.findIndex((p) => p.id === id);
  if (idx === -1) return;
  players.splice(idx, 1);
  players.forEach((p, i) => { p.index = i; });
  for (let i = undoStack.length - 1; i >= 0; i--) {
    if (undoStack[i].playerId === id) undoStack.splice(i, 1);
  }
  for (let i = redoStack.length - 1; i >= 0; i--) {
    if (redoStack[i].playerId === id) redoStack.splice(i, 1);
  }
  for (let i = ledger.length - 1; i >= 0; i--) {
    if (ledger[i].playerId === id) ledger.splice(i, 1);
  }
  playerAngles.clear();
  if (mounted) render();
  persistActiveGame();
  notifyChange();
}

export function mount(container, initialPlayers = null) {
  if (mounted) return;
  stage = container;
  stage.hidden = false;
  hydrateSettings();
  const hadSaved = hydrateFromStorage();
  if (!hadSaved) {
    players = buildPlayersFromInitial(initialPlayers);
    game = defaultGame();
  }
  playerAngles.clear();
  gestures.clear();
  render();
  on(stage, 'pointerdown', onPointerDown);
  on(stage, 'pointermove', onPointerMove);
  on(stage, 'pointerup', onPointerUp);
  on(stage, 'pointercancel', onPointerCancel);
  mounted = true;
  notifyChange();
}

export function unmount() {
  if (!mounted) return;
  for (const { target, type, fn } of listeners) target.removeEventListener(type, fn);
  listeners = [];
  disconnectLabelObserver();
  teardownCanvas();
  stage.innerHTML = '';
  stage.hidden = true;
  stage = null;
  players = [];
  playerAngles.clear();
  gestures.clear();
  mounted = false;
}

export function isMounted() {
  return mounted;
}

export function getPlayers() {
  return players.slice();
}

export function setScoreStep(n) {
  SCORE_STEP = Math.max(1, Math.floor(Number(n) || 1));
  persistSettings();
  notifyChange();
}

export function setAllowNegative(v) {
  ALLOW_NEGATIVE = !!v;
  persistSettings();
  notifyChange();
}

export function getScoreStep() { return SCORE_STEP; }
export function getAllowNegative() { return ALLOW_NEGATIVE; }
