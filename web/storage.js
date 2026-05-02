// Thin localStorage wrapper for v2. JSON-serialized values, prefixed keys
// to avoid collisions, and a 300ms debounce on writes so a rapid drag
// doesn't flood storage. iOS Capacitor and Pages have separate origins,
// so each environment has its own store; that's intentional for v2.

const PREFIX = 'chooser_v2:';
const DEFAULT_DEBOUNCE_MS = 300;
const pendingTimers = new Map();
const pendingValues = new Map();

function fullKey(key) {
  return PREFIX + key;
}

function flushImmediate(key) {
  if (!pendingValues.has(key)) return;
  const value = pendingValues.get(key);
  pendingValues.delete(key);
  const t = pendingTimers.get(key);
  if (t) {
    clearTimeout(t);
    pendingTimers.delete(key);
  }
  try {
    localStorage.setItem(fullKey(key), JSON.stringify(value));
  } catch (_) {}
}

export function get(key) {
  try {
    const raw = localStorage.getItem(fullKey(key));
    if (raw === null) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

export function set(key, value, opts = {}) {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  pendingValues.set(key, value);
  if (debounceMs <= 0) {
    flushImmediate(key);
    return;
  }
  if (pendingTimers.has(key)) clearTimeout(pendingTimers.get(key));
  const timer = setTimeout(() => flushImmediate(key), debounceMs);
  pendingTimers.set(key, timer);
}

export function remove(key) {
  try {
    localStorage.removeItem(fullKey(key));
  } catch (_) {}
  pendingValues.delete(key);
  if (pendingTimers.has(key)) {
    clearTimeout(pendingTimers.get(key));
    pendingTimers.delete(key);
  }
}

export function flushAll() {
  for (const key of Array.from(pendingValues.keys())) flushImmediate(key);
}

// Persist any pending writes when the page is hidden or unloaded so a
// quickly-locked phone doesn't lose the last drag.
window.addEventListener('pagehide', flushAll);
window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushAll();
});
