// Finger-chooser state machine and rendering, extracted from v1's app.js
// into an ES module so v2 can host both the chooser and scoring modes.
// Behavior is identical to v1; the only changes are module exports and
// the container being passed in via mount() rather than queried by ID.

import {
  ensureAudio,
  fingerLandHaptic,
  tick,
  revealHaptic,
} from './feedback.js';

const WAIT_MS = 1500;
const COUNTDOWN_MS = 1000;
const RESET_LOCKOUT_MS = 400;
const PULSE_BASE_MS = 1200;
const PULSE_FAST_MS = 150;
const GOLDEN_ANGLE = 137.508;
const STATE = { IDLE: 'IDLE', WAITING: 'WAITING', COUNTDOWN: 'COUNTDOWN', REVEALED: 'REVEALED' };

let stage = null;
let lastHue = Math.random() * 360;
const pointers = new Map();
let state = STATE.IDLE;
let waitTimer = null;
let countdownStart = 0;
let countdownRaf = null;
let lastTickAt = 0;
let revealedAt = 0;
let mounted = false;
let listeners = [];

function nextHue() {
  lastHue = (lastHue + GOLDEN_ANGLE) % 360;
  return lastHue;
}

function setPulseDuration(ms) {
  if (!stage) return;
  stage.style.setProperty('--pulse-duration', `${ms}ms`);
}

function addRing(id, x, y) {
  const el = document.createElement('div');
  el.className = 'ring';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  const hue = nextHue();
  el.style.setProperty('--ring-color', `oklch(72% 0.28 ${hue})`);
  el.style.setProperty('--ring-glow', `oklch(82% 0.22 ${hue})`);
  stage.appendChild(el);
  pointers.set(id, { el, x, y, hue });
  stage.classList.add('has-fingers');
  fingerLandHaptic();
}

function moveRing(id, x, y) {
  const p = pointers.get(id);
  if (!p) return;
  p.x = x;
  p.y = y;
  p.el.style.left = `${x}px`;
  p.el.style.top = `${y}px`;
}

function removeRing(id) {
  const p = pointers.get(id);
  if (!p) return;
  p.el.remove();
  pointers.delete(id);
  if (pointers.size === 0) stage.classList.remove('has-fingers');
}

function clearAllRings() {
  for (const p of pointers.values()) p.el.remove();
  pointers.clear();
  stage.classList.remove('has-fingers');
}

function cancelTimers() {
  if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
  if (countdownRaf) { cancelAnimationFrame(countdownRaf); countdownRaf = null; }
}

function enterIdle() {
  cancelTimers();
  state = STATE.IDLE;
  setPulseDuration(PULSE_BASE_MS);
}

function enterWaiting() {
  cancelTimers();
  state = STATE.WAITING;
  setPulseDuration(PULSE_BASE_MS);
  waitTimer = setTimeout(() => {
    if (state === STATE.WAITING && pointers.size >= 2) enterCountdown();
  }, WAIT_MS);
}

function enterCountdown() {
  cancelTimers();
  state = STATE.COUNTDOWN;
  countdownStart = performance.now();
  lastTickAt = 0;
  const step = (now) => {
    if (state !== STATE.COUNTDOWN) return;
    const t = Math.min(1, (now - countdownStart) / COUNTDOWN_MS);
    const eased = t * t;
    const dur = PULSE_BASE_MS + (PULSE_FAST_MS - PULSE_BASE_MS) * eased;
    setPulseDuration(dur);
    const tickInterval = Math.max(60, dur);
    if (now - lastTickAt >= tickInterval) {
      lastTickAt = now;
      tick(eased);
    }
    if (t >= 1) {
      revealWinner();
      return;
    }
    countdownRaf = requestAnimationFrame(step);
  };
  countdownRaf = requestAnimationFrame(step);
}

function revealWinner() {
  cancelTimers();
  state = STATE.REVEALED;
  revealedAt = performance.now();
  const entries = Array.from(pointers.values());
  if (entries.length === 0) {
    enterIdle();
    return;
  }
  const winner = entries[Math.floor(Math.random() * entries.length)];
  for (const p of entries) {
    if (p === winner) p.el.classList.add('winner');
    else p.el.classList.add('loser');
  }
  revealHaptic();
}

function handlePointerDown(e) {
  e.preventDefault();
  ensureAudio();
  if (state === STATE.REVEALED) {
    if (performance.now() - revealedAt < RESET_LOCKOUT_MS) return;
    clearAllRings();
    enterIdle();
    return;
  }
  addRing(e.pointerId, e.clientX, e.clientY);

  if (state === STATE.IDLE) {
    if (pointers.size >= 2) enterWaiting();
  } else if (state === STATE.WAITING) {
    enterWaiting();
  } else if (state === STATE.COUNTDOWN) {
    enterWaiting();
  }
}

function handlePointerMove(e) {
  if (!pointers.has(e.pointerId)) return;
  e.preventDefault();
  moveRing(e.pointerId, e.clientX, e.clientY);
}

function handlePointerEnd(e) {
  if (!pointers.has(e.pointerId)) return;
  e.preventDefault();

  if (state === STATE.REVEALED) {
    return;
  }

  removeRing(e.pointerId);

  if (state === STATE.WAITING) {
    if (pointers.size < 2) enterIdle();
    else enterWaiting();
  } else if (state === STATE.COUNTDOWN) {
    if (pointers.size < 2) enterIdle();
  }
}

function on(target, type, fn) {
  target.addEventListener(type, fn);
  listeners.push({ target, type, fn });
}

export function mount(container) {
  if (mounted) return;
  stage = container;
  mounted = true;
  on(stage, 'pointerdown', handlePointerDown);
  on(stage, 'pointermove', handlePointerMove);
  on(stage, 'pointerup', handlePointerEnd);
  on(stage, 'pointercancel', handlePointerEnd);
  setPulseDuration(PULSE_BASE_MS);
}

export function unmount() {
  if (!mounted) return;
  cancelTimers();
  clearAllRings();
  for (const { target, type, fn } of listeners) target.removeEventListener(type, fn);
  listeners = [];
  stage = null;
  state = STATE.IDLE;
  mounted = false;
}

// Returns a snapshot of currently active rings for handoff to scoring.
// Each entry has the OKLCH hue used by that ring so scoring can match colors.
export function getActiveRings() {
  return Array.from(pointers.values()).map((p) => ({ hue: p.hue }));
}
