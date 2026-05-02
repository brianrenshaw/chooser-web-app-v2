// Scoring Mode view. Renders a shared circular ring with one puck per
// player anchored at evenly-spaced poles around the ring. The score
// gesture is a circular drag: put a finger near your puck, rotate
// around the ring center, every 30° of cumulative rotation = one
// detent (=+SCORE_STEP, or -SCORE_STEP if Allow Negative Scores is on).
// Releasing commits the total delta as one undoable action.

import { detentHaptic, commitHaptic, ensureAudio } from './feedback.js';
import * as storage from './storage.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_RADIUS = 100;
const RING_STROKE = 36;
const PUCK_RADIUS = 18;
const VIEWBOX_PAD = 26;
const DETENT_RAD = Math.PI / 6;            // 30° per detent
const HIT_ANGULAR_TOLERANCE = Math.PI / 3;  // 60° max from puck for hit-test
const HIT_RADIAL_TOLERANCE = 80;            // pixels from ring track for hit-test
const ARC_VISUAL_CLAMP = 2 * Math.PI - 0.001;

// Phase D: hardcoded gameplay constants. Phase F's settings modal will
// route the user-chosen values into these.
let SCORE_STEP = 1;
let ALLOW_NEGATIVE = false;

let stage = null;
let svg = null;                  // the SVG ring element
let mounted = false;
let players = [];
let game = defaultGame();
const ledger = [];               // chronological record of every commit
const undoStack = [];
const redoStack = [];
const playerAngles = new Map();  // playerId -> current visual angle (rad)
const gestures = new Map();      // pointerId -> gesture state
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

function pointOnRing(angleRad, radius = RING_RADIUS) {
  return {
    x: Math.cos(angleRad) * radius,
    y: Math.sin(angleRad) * radius,
  };
}

function getPlayer(id) {
  return players.find((p) => p.id === id) ?? null;
}

function isPlayerInGesture(playerId) {
  for (const g of gestures.values()) if (g.playerId === playerId) return true;
  return false;
}

function getRingScreenGeometry() {
  if (!svg) return null;
  const rect = svg.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  // SVG viewBox spans 2*(RING_RADIUS + VIEWBOX_PAD); ring radius in screen px
  const screenRadius = (rect.width / 2) * (RING_RADIUS / (RING_RADIUS + VIEWBOX_PAD));
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

// Find the closest puck to the given screen point that is not currently
// being dragged. Returns the player or null.
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
    const puckAngle = playerAngles.get(p.id) ?? 0;
    const delta = angularDistance(fingerAngle, puckAngle);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = p;
    }
  }
  if (!best || bestDelta > HIT_ANGULAR_TOLERANCE) return null;
  return best;
}

function setPuckPosition(player, angleRad) {
  playerAngles.set(player.id, angleRad);
  const puck = svg.querySelector(`circle.puck[data-player-id="${player.id}"]`);
  if (!puck) return;
  const pos = pointOnRing(angleRad);
  puck.setAttribute('cx', pos.x.toFixed(3));
  puck.setAttribute('cy', pos.y.toFixed(3));
}

function arcPathFromTo(fromAngle, toAngle) {
  // Render the arc as a chain of <= 90 degree segments. A single SVG
  // arc command becomes ambiguous as the span approaches 2pi (start and
  // end nearly identical, largeArc/sweepFlag combinations behave
  // inconsistently across browsers). Splitting into 90-degree pieces
  // sidesteps the issue and always draws a clean continuous arc.
  const span = toAngle - fromAngle;
  const clamped = Math.max(-ARC_VISUAL_CLAMP, Math.min(ARC_VISUAL_CLAMP, span));
  if (Math.abs(clamped) < 0.001) return '';
  const sign = clamped >= 0 ? 1 : -1;
  const absSpan = Math.abs(clamped);
  const SEG_MAX = Math.PI / 2;
  const segments = Math.max(1, Math.ceil(absSpan / SEG_MAX));
  const segSpan = absSpan / segments;
  const start = pointOnRing(fromAngle);
  let d = `M ${start.x.toFixed(3)} ${start.y.toFixed(3)}`;
  for (let i = 1; i <= segments; i++) {
    const a = fromAngle + sign * i * segSpan;
    const p = pointOnRing(a);
    d += ` A ${RING_RADIUS} ${RING_RADIUS} 0 0 ${sign > 0 ? 1 : 0} ${p.x.toFixed(3)} ${p.y.toFixed(3)}`;
  }
  return d;
}

function setArc(gesture) {
  let arc = svg.querySelector(`path.arc-trail[data-player-id="${gesture.playerId}"]`);
  if (!arc) {
    arc = document.createElementNS(SVG_NS, 'path');
    arc.classList.add('arc-trail');
    arc.dataset.playerId = gesture.playerId;
    arc.setAttribute('stroke-width', String(RING_STROKE));
    arc.setAttribute('stroke', `oklch(70% 0.20 ${gesture.hue})`);
    // Insert immediately before this player's own puck so the puck
    // remains on top of its own arc, but the arc covers any other
    // pucks (idle anchors) it sweeps past during the rotation.
    const ownPuck = svg.querySelector(
      `circle.puck[data-player-id="${gesture.playerId}"]`
    );
    if (ownPuck) svg.insertBefore(arc, ownPuck);
    else svg.appendChild(arc);
  }
  // Use cumulative rotation, not the puck's atan2 angle. atan2 wraps at
  // +/-pi, which would make the arc visually jump backward when the
  // finger crosses the left side of the ring. cumulativeDeltaRad keeps
  // monotonically growing in the drag direction.
  const endAngle = gesture.anchorAngle + gesture.cumulativeDeltaRad;
  arc.setAttribute('d', arcPathFromTo(gesture.anchorAngle, endAngle));
}

function removeArc(playerId) {
  const arc = svg.querySelector(`path.arc-trail[data-player-id="${playerId}"]`);
  if (arc) arc.remove();
}

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
  if (n < 0) return String(n); // already has minus
  return '+0';
}

function unwrapAngleDelta(prev, curr) {
  let d = curr - prev;
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

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
  // Move this player's puck to the end of the SVG so it renders on top.
  // The arc (created by setArc) is then inserted immediately before it,
  // which puts the arc above all other (idle) pucks while keeping the
  // active puck on top of its own arc.
  const ownPuck = svg.querySelector(
    `circle.puck[data-player-id="${player.id}"]`
  );
  if (ownPuck) svg.appendChild(ownPuck);
  // Decouple puck from anchor; it now follows the finger.
  setPuckPosition(player, startAngle);
  setScoreText(player, formatDelta(0), true);
  setArc(gesture);
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

  // If the user reverses direction, retract committed detents accordingly.
  // Simplest model: detentsCommitted always reflects current absolute count
  // matching the cumulative sign.
  if (sign !== gesture.sign && targetDetents === 0) {
    gesture.sign = 0;
    gesture.detentsCommitted = 0;
  } else if (targetDetents !== gesture.detentsCommitted || sign !== gesture.sign) {
    // Fire haptic for each newly crossed detent (only when moving away from 0).
    const crossings = targetDetents - gesture.detentsCommitted;
    if (crossings > 0 && targetDetents > 0) {
      // Suppress negative direction if not allowed; clamp to 0 detent count.
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

  // Compute live delta for preview (zero-clamped if negative is disallowed).
  let liveDelta = gesture.sign * gesture.detentsCommitted * SCORE_STEP;
  if (!ALLOW_NEGATIVE && (player.score + liveDelta) < 0) {
    liveDelta = -player.score;
  }

  setScoreText(player, formatDelta(liveDelta), true);

  // Reposition puck to current finger angle along the ring.
  setPuckPosition(player, currAngle);
  setArc(gesture);
}

function commitGesture(e) {
  const gesture = gestures.get(e.pointerId);
  if (!gesture) return;
  const player = getPlayer(gesture.playerId);
  gestures.delete(e.pointerId);
  if (!player) return;

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
  removeArc(player.id);
  // Snap puck back to anchor with CSS transition.
  const anchor = anchorAngleRad(player.index, players.length);
  setPuckPosition(player, anchor);
}

function cancelGesture(e) {
  const gesture = gestures.get(e.pointerId);
  if (!gesture) return;
  const player = getPlayer(gesture.playerId);
  gestures.delete(e.pointerId);
  if (!player) return;
  removeArc(player.id);
  refreshScoreText(player);
  const anchor = anchorAngleRad(player.index, players.length);
  setPuckPosition(player, anchor);
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

function renderRing() {
  const half = RING_RADIUS + VIEWBOX_PAD;
  const el = document.createElementNS(SVG_NS, 'svg');
  el.classList.add('scoring-ring');
  el.setAttribute('viewBox', `${-half} ${-half} ${half * 2} ${half * 2}`);
  el.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const track = document.createElementNS(SVG_NS, 'circle');
  track.classList.add('ring-track');
  track.setAttribute('cx', '0');
  track.setAttribute('cy', '0');
  track.setAttribute('r', String(RING_RADIUS));
  track.setAttribute('stroke-width', String(RING_STROKE));
  el.appendChild(track);

  for (const p of players) {
    const angle = playerAngles.get(p.id) ?? anchorAngleRad(p.index, players.length);
    playerAngles.set(p.id, angle);
    const pos = pointOnRing(angle);
    const puck = document.createElementNS(SVG_NS, 'circle');
    puck.classList.add('puck');
    puck.dataset.playerId = p.id;
    puck.setAttribute('cx', pos.x.toFixed(3));
    puck.setAttribute('cy', pos.y.toFixed(3));
    puck.setAttribute('r', String(PUCK_RADIUS));
    puck.setAttribute('fill', `oklch(70% 0.20 ${p.hue})`);
    el.appendChild(puck);
  }

  return el;
}

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
  // SVG fills container 100%. Visible ring radius in container px:
  const ringR = halfW * (RING_RADIUS / (RING_RADIUS + VIEWBOX_PAD));
  // Place label center just outside the ring + puck, with a dynamic gap.
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

function renderTwoPlayerLayout() {
  const top = makePlayerLabelEl(players[0]);
  top.dataset.anchor = 'top';
  const bottom = makePlayerLabelEl(players[1]);
  bottom.dataset.anchor = 'bottom';
  stage.appendChild(top);
  svg = renderRing();
  stage.appendChild(svg);
  stage.appendChild(bottom);
}

function renderRadialLayout() {
  const container = document.createElement('div');
  container.className = 'ring-container radial';
  svg = renderRing();
  container.appendChild(svg);
  for (const p of players) {
    const label = makePlayerLabelEl(p, 'radial');
    container.appendChild(label);
  }
  stage.appendChild(container);
  // Position labels after the container has its computed size.
  requestAnimationFrame(() => positionRadialLabels(container));
  if (window.ResizeObserver) {
    disconnectLabelObserver();
    labelResizeObserver = new ResizeObserver(() => positionRadialLabels(container));
    labelResizeObserver.observe(container);
  } else {
    window.addEventListener('resize', () => positionRadialLabels(container));
  }
}

function renderStackLayout() {
  // 9+ players: vertical scroll of one row per player. Drag gesture is
  // not supported in this fallback layout; players can still see scores
  // but must use Settings to add/remove or adjust the game. A future
  // iteration could give each player their own mini-dial here.
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
  svg = null; // no ring → drag gestures cannot start
}

function render() {
  disconnectLabelObserver();
  stage.innerHTML = '';
  if (players.length <= 2) {
    renderTwoPlayerLayout();
  } else if (players.length <= 8) {
    renderRadialLayout();
  } else {
    renderStackLayout();
  }
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
  // Archive the current game if it has any plays.
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
  // Reset state.
  game = defaultGame();
  if (initialPlayers && initialPlayers.length > 0) {
    players = buildPlayersFromInitial(initialPlayers);
  } else {
    // Keep existing players but reset their scores.
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
  // Pick a hue that's far from existing player hues.
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
  // Re-index so anchor angles stay clean.
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
  // Drop pending undo/redo entries pointing at the removed player.
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
  stage.innerHTML = '';
  stage.hidden = true;
  stage = null;
  svg = null;
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

// Phase F will call these to apply settings.
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
