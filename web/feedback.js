// Shared feedback helpers used by both chooser and scoring modes.
// Three layers: navigator.vibrate (Android Chrome), Capacitor Haptics
// (native iOS Taptic Engine), and a WebAudio click as the iOS web fallback.

export function vibrate(ms) {
  if (navigator.vibrate) {
    try { navigator.vibrate(ms); } catch (_) {}
  }
}

let audioCtx = null;

export function ensureAudio() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

export function click(opts = {}) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const freq = opts.freq ?? 90;
  const dur = opts.dur ?? 0.05;
  const vol = opts.vol ?? 0.35;
  const type = opts.type ?? 'sine';
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq * 1.6, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq), t0 + dur);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(vol, t0 + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export function nativeHaptics() {
  const cap = window.Capacitor;
  if (!cap?.isNativePlatform?.()) return null;
  return cap.Plugins?.Haptics ?? null;
}

export function fingerLandHaptic() {
  vibrate(10);
  const haptics = nativeHaptics();
  if (haptics?.impact) {
    haptics.impact({ style: 'LIGHT' }).catch(() => {});
    return;
  }
  click({ freq: 70, dur: 0.04, vol: 0.18 });
}

export function tick(intensity) {
  vibrate(Math.round(15 + 45 * intensity));
  const haptics = nativeHaptics();
  if (haptics?.impact) {
    const style = intensity < 0.2 ? 'MEDIUM' : 'HEAVY';
    haptics.impact({ style }).catch(() => {});
    return;
  }
  click({
    freq: 70 + 180 * intensity,
    dur: 0.04 + 0.03 * intensity,
    vol: 0.18 + 0.35 * intensity,
  });
}

export function revealHaptic() {
  vibrate([0, 60, 70, 60, 70, 60, 240]);
  const haptics = nativeHaptics();
  if (haptics?.impact) {
    [0, 70, 140, 210, 290, 380].forEach((t) =>
      setTimeout(() => haptics.impact({ style: 'HEAVY' }).catch(() => {}), t)
    );
    if (haptics.vibrate) {
      setTimeout(() => haptics.vibrate({ duration: 300 }).catch(() => {}), 420);
    }
    if (haptics.notification) {
      setTimeout(() => haptics.notification({ type: 'SUCCESS' }).catch(() => {}), 760);
    }
    return;
  }
  const ctx = ensureAudio();
  if (!ctx) return;
  click({ freq: 220, dur: 0.18, vol: 0.55, type: 'triangle' });
  setTimeout(() => click({ freq: 440, dur: 0.25, vol: 0.4, type: 'triangle' }), 60);
  setTimeout(() => click({ freq: 660, dur: 0.35, vol: 0.3, type: 'triangle' }), 140);
}

// Used by Scoring Mode: a single detent click as the user rotates a puck
// around the shared ring. Light, short, repeats fast without overlap.
export function detentHaptic() {
  vibrate(8);
  const haptics = nativeHaptics();
  if (haptics?.impact) {
    haptics.impact({ style: 'LIGHT' }).catch(() => {});
    return;
  }
  click({ freq: 280, dur: 0.025, vol: 0.22, type: 'square' });
}

// Stronger commit haptic when a drag is released and a score is recorded.
export function commitHaptic() {
  vibrate(28);
  const haptics = nativeHaptics();
  if (haptics?.impact) {
    haptics.impact({ style: 'MEDIUM' }).catch(() => {});
    return;
  }
  click({ freq: 160, dur: 0.06, vol: 0.4, type: 'triangle' });
}
