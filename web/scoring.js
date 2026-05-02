// Scoring Mode view. Renders a shared circular ring with one puck per
// player anchored at evenly-spaced poles around the ring, plus name and
// score labels positioned around the perimeter. Phase C scope: static
// layout matching demo-assets/IMG_5550.PNG. Drag gesture, persistence,
// and modals come in later phases.

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_RADIUS = 100;       // SVG viewBox units; ring is rendered at -RR..+RR
const RING_STROKE = 36;        // ring track thickness
const PUCK_RADIUS = 18;
const VIEWBOX_PAD = 26;        // breathing room outside the ring for puck overflow

let stage = null;
let mounted = false;
let players = [];

// Default players when scoring is opened from idle. Match demo-assets names
// and approximate the OKLCH hues from the screenshots (vibrant blue + red).
const DEFAULT_PLAYERS = [
  { name: 'Brian', hue: 214 },
  { name: 'Brad', hue: 25 },
];

function makePlayerId(i) {
  return `p${i + 1}`;
}

// Compute the anchor angle in radians for player at index i out of n.
// Player 0 is always at 12 o'clock. Subsequent players are spaced evenly
// clockwise around the ring. atan2-style: 0 rad = 3 o'clock, π/2 = 6 o'clock.
function anchorAngleRad(i, n) {
  // 12 o'clock is -π/2; clockwise increment is +2π/n.
  return -Math.PI / 2 + (2 * Math.PI * i) / n;
}

function pointOnRing(angleRad, radius = RING_RADIUS) {
  return {
    x: Math.cos(angleRad) * radius,
    y: Math.sin(angleRad) * radius,
  };
}

function renderRing() {
  const half = RING_RADIUS + VIEWBOX_PAD;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('scoring-ring');
  svg.setAttribute('viewBox', `${-half} ${-half} ${half * 2} ${half * 2}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const track = document.createElementNS(SVG_NS, 'circle');
  track.classList.add('ring-track');
  track.setAttribute('cx', '0');
  track.setAttribute('cy', '0');
  track.setAttribute('r', String(RING_RADIUS));
  track.setAttribute('stroke-width', String(RING_STROKE));
  svg.appendChild(track);

  // One puck per player, anchored at its pole.
  for (const p of players) {
    const angle = anchorAngleRad(p.index, players.length);
    const pos = pointOnRing(angle);
    const puck = document.createElementNS(SVG_NS, 'circle');
    puck.classList.add('puck');
    puck.dataset.playerId = p.id;
    puck.setAttribute('cx', pos.x.toFixed(3));
    puck.setAttribute('cy', pos.y.toFixed(3));
    puck.setAttribute('r', String(PUCK_RADIUS));
    puck.setAttribute('fill', `oklch(70% 0.20 ${p.hue})`);
    svg.appendChild(puck);
  }

  return svg;
}

function renderPlayerLabels() {
  // For 2 players, put labels above and below the ring (no rotation).
  // Three-plus and quadrant layouts come in Phase G.
  const wrap = document.createElement('div');
  wrap.className = 'player-labels';

  for (const p of players) {
    const el = document.createElement('div');
    el.className = 'player-label';
    el.dataset.playerId = p.id;
    el.dataset.anchor = p.index === 0 ? 'top' : 'bottom';
    el.style.color = `oklch(70% 0.20 ${p.hue})`;
    el.innerHTML = `
      <div class="player-name">${p.name}</div>
      <div class="player-score">${p.score}</div>
    `;
    wrap.appendChild(el);
  }

  return wrap;
}

function render() {
  stage.innerHTML = '';

  // 2-player layout: top label, ring, bottom label.
  if (players.length === 2) {
    const labels = renderPlayerLabels();
    const top = labels.querySelector('[data-anchor="top"]');
    const bottom = labels.querySelector('[data-anchor="bottom"]');
    stage.appendChild(top);
    stage.appendChild(renderRing());
    stage.appendChild(bottom);
    return;
  }

  // Fallback for now: render labels above ring stacked. Phase G refines this.
  stage.appendChild(renderPlayerLabels());
  stage.appendChild(renderRing());
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

export function mount(container, initialPlayers = null) {
  if (mounted) return;
  stage = container;
  stage.hidden = false;
  players = buildPlayersFromInitial(initialPlayers);
  render();
  mounted = true;
}

export function unmount() {
  if (!mounted) return;
  stage.innerHTML = '';
  stage.hidden = true;
  stage = null;
  players = [];
  mounted = false;
}

export function isMounted() {
  return mounted;
}

// Phase D will add gesture handlers; Phase E will hook persistence.
// This placeholder exposes the player list for subsequent phases.
export function getPlayers() {
  return players.slice();
}
