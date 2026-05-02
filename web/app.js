(() => {
  const stage = document.getElementById('stage');

  const WAIT_MS = 1500;
  const COUNTDOWN_MS = 1000;
  const RESET_LOCKOUT_MS = 400;
  const PULSE_BASE_MS = 1200;
  const PULSE_FAST_MS = 150;

  const GOLDEN_ANGLE = 137.508;
  let lastHue = Math.random() * 360;
  function nextHue() {
    lastHue = (lastHue + GOLDEN_ANGLE) % 360;
    return lastHue;
  }

  const STATE = { IDLE: 'IDLE', WAITING: 'WAITING', COUNTDOWN: 'COUNTDOWN', REVEALED: 'REVEALED' };

  const pointers = new Map();
  let state = STATE.IDLE;
  let waitTimer = null;
  let countdownStart = 0;
  let countdownRaf = null;
  let lastTickAt = 0;
  let revealedAt = 0;

  function setPulseDuration(ms) {
    stage.style.setProperty('--pulse-duration', `${ms}ms`);
  }

  function vibrate(ms) {
    if (navigator.vibrate) {
      try { navigator.vibrate(ms); } catch (_) {}
    }
  }

  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      audioCtx = new Ctor();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function click(opts = {}) {
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

  function nativeHaptics() {
    const cap = window.Capacitor;
    if (!cap?.isNativePlatform?.()) return null;
    return cap.Plugins?.Haptics ?? null;
  }

  function fingerLandHaptic() {
    vibrate(10);
    const haptics = nativeHaptics();
    if (haptics?.impact) {
      haptics.impact({ style: 'LIGHT' }).catch(() => {});
      return;
    }
    click({ freq: 70, dur: 0.04, vol: 0.18 });
  }

  function tick(intensity) {
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

  function revealHaptic() {
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
      // Hold the winner display even after fingers lift.
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

  stage.addEventListener('pointerdown', handlePointerDown);
  stage.addEventListener('pointermove', handlePointerMove);
  stage.addEventListener('pointerup', handlePointerEnd);
  stage.addEventListener('pointercancel', handlePointerEnd);

  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  setPulseDuration(PULSE_BASE_MS);
})();
