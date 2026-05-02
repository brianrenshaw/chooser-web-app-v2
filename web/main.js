// Top-level view controller for v2.
//
// Wires the gear button, history button, and modals (settings + history).
// View transitions:
//   chooser idle  -- gear --> scoring view
//   scoring view  -- gear --> settings modal
//   scoring view  -- history button --> history modal
//   settings has "Use the Chooser" row to return to chooser

import * as chooser from './chooser.js';
import * as scoring from './scoring.js';

const chooserStage = document.getElementById('chooser-stage');
const scoringStage = document.getElementById('scoring-stage');
const gearBtn = document.getElementById('gear-button');
const historyBtn = document.getElementById('history-button');
const modalRoot = document.getElementById('modal-root');

let view = 'chooser';

function showChooser() {
  closeModal();
  scoring.unmount();
  scoringStage.hidden = true;
  chooserStage.hidden = false;
  chooser.mount(chooserStage);
  historyBtn.hidden = true;
  view = 'chooser';
}

function showScoring(initialPlayers = null) {
  const rings = chooser.getActiveRings();
  chooser.unmount();
  chooserStage.hidden = true;
  scoringStage.hidden = false;
  scoring.mount(scoringStage, initialPlayers ?? (rings.length > 0 ? rings : null));
  historyBtn.hidden = false;
  view = 'scoring';
}

gearBtn.addEventListener('click', () => {
  if (view === 'chooser') {
    showScoring();
  } else {
    openSettings();
  }
});

historyBtn.addEventListener('click', () => {
  openHistory();
});

document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());

scoring.onChange(() => {
  // If a settings or history modal is open, re-render their dynamic bits.
  const open = modalRoot.querySelector('.modal');
  if (!open) return;
  if (open.dataset.modal === 'history') refreshHistoryModal();
  if (open.dataset.modal === 'settings') refreshSettingsModal();
});

showChooser();

// ---- Modal helpers ----

function closeModal() {
  modalRoot.innerHTML = '';
}

function el(tag, className, content) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (content !== undefined) {
    if (content instanceof Node) e.appendChild(content);
    else e.innerHTML = content;
  }
  return e;
}

function makeModalShell(modalId, title) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.dataset.modal = modalId;

  const header = document.createElement('div');
  header.className = 'modal-header';
  const h2 = document.createElement('h2');
  h2.textContent = title;
  header.appendChild(h2);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'modal-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.addEventListener('click', closeModal);
  header.appendChild(close);

  const body = document.createElement('div');
  body.className = 'modal-body';

  modal.appendChild(header);
  modal.appendChild(body);
  return { modal, body };
}

// ---- Settings modal ----

const HUE_PALETTE = [
  214, 25, 145, 280, 50, 320, 175, 0,
  240, 60, 300, 110, 195, 350, 80, 260,
  200, 30, 130, 290, 70, 340, 160, 220,
];

function openSettings() {
  closeModal();
  const { modal, body } = makeModalShell('settings', 'Settings');
  body.innerHTML = '';
  body.appendChild(buildSettingsContent());
  modalRoot.appendChild(modal);
}

function refreshSettingsModal() {
  const open = modalRoot.querySelector('.modal[data-modal="settings"]');
  if (!open) return;
  const body = open.querySelector('.modal-body');
  body.innerHTML = '';
  body.appendChild(buildSettingsContent());
}

function buildSettingsContent() {
  const root = document.createDocumentFragment();
  const game = scoring.getGame();
  const players = scoring.getPlayers();
  const step = scoring.getScoreStep();
  const allowNeg = scoring.getAllowNegative();

  // Scoreboard card
  const sbHeader = el('div', 'settings-section-header', 'Scoreboard');
  root.appendChild(sbHeader);
  const sbCard = el('div', 'settings-card');

  const nameRow = el('div', 'settings-row');
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Game name';
  nameInput.value = game.name || '';
  nameInput.addEventListener('change', () => scoring.setGameName(nameInput.value));
  nameRow.appendChild(nameInput);
  sbCard.appendChild(nameRow);

  const notesRow = el('div', 'settings-row notes-row');
  const notes = document.createElement('textarea');
  notes.placeholder = 'Notes';
  notes.rows = 2;
  notes.value = game.notes || '';
  notes.addEventListener('change', () => scoring.setGameNotes(notes.value));
  notesRow.appendChild(notes);
  sbCard.appendChild(notesRow);

  const histRow = el('div', 'settings-row tappable');
  histRow.appendChild(el('div', 'row-label', 'Game History'));
  histRow.appendChild(el('div', 'chevron', '›'));
  histRow.addEventListener('click', () => {
    closeModal();
    openHistory();
  });
  sbCard.appendChild(histRow);

  root.appendChild(sbCard);

  // Start a New Game
  const startCard = el('div', 'action-card');
  const startBtn = document.createElement('button');
  startBtn.type = 'button';
  startBtn.textContent = 'Start a New Game';
  startBtn.addEventListener('click', () => {
    if (!confirm('Archive current game and reset scores?')) return;
    scoring.startNewGame();
  });
  startCard.appendChild(startBtn);
  root.appendChild(startCard);

  // Players card (inline list with rename + add/remove + color picker)
  const playersHeader = el('div', 'settings-section-header', 'Players');
  root.appendChild(playersHeader);
  const playersCard = el('div', 'settings-card players-list');
  for (const p of players) {
    const row = el('div', 'settings-row');
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'swatch';
    swatch.style.background = `oklch(70% 0.20 ${p.hue})`;
    swatch.setAttribute('aria-label', 'Change color');
    swatch.addEventListener('click', () => openColorPicker(p.id));
    row.appendChild(swatch);

    const name = document.createElement('input');
    name.className = 'name-input';
    name.type = 'text';
    name.value = p.name;
    name.addEventListener('change', () => scoring.renamePlayer(p.id, name.value));
    row.appendChild(name);

    if (players.length > 1) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'remove-btn';
      rm.textContent = '−';
      rm.setAttribute('aria-label', 'Remove player');
      rm.addEventListener('click', () => {
        if (!confirm(`Remove ${p.name}?`)) return;
        scoring.removePlayer(p.id);
      });
      row.appendChild(rm);
    }
    playersCard.appendChild(row);
  }
  // Add Player row
  if (players.length < 8) {
    const addRow = el('div', 'settings-row tappable');
    addRow.appendChild(el('div', 'row-label', '+ Add Player'));
    addRow.style.color = '#2196f3';
    addRow.addEventListener('click', () => scoring.addPlayer());
    playersCard.appendChild(addRow);
  }
  root.appendChild(playersCard);

  // Scoring card
  const scoringHeader = el('div', 'settings-section-header', 'Scoring');
  root.appendChild(scoringHeader);
  const scoringCard = el('div', 'settings-card');

  // Allow Negative Scores
  const negRow = el('div', 'settings-row');
  negRow.appendChild(el('div', 'row-label', 'Allow Negative Scores'));
  const negToggle = document.createElement('input');
  negToggle.type = 'checkbox';
  negToggle.className = 'toggle';
  negToggle.checked = allowNeg;
  negToggle.addEventListener('change', () => scoring.setAllowNegative(negToggle.checked));
  negRow.appendChild(negToggle);
  scoringCard.appendChild(negRow);

  // Score Step stepper
  const stepRow = el('div', 'settings-row');
  stepRow.appendChild(el('div', 'row-label', 'Score Step'));
  const stepper = el('div', 'stepper');
  const minus = document.createElement('button');
  minus.type = 'button';
  minus.textContent = '−';
  const value = el('span', 'stepper-value', String(step));
  const plus = document.createElement('button');
  plus.type = 'button';
  plus.textContent = '+';
  minus.disabled = step <= 1;
  minus.addEventListener('click', () => scoring.setScoreStep(Math.max(1, step - 1)));
  plus.addEventListener('click', () => scoring.setScoreStep(step + 1));
  stepper.appendChild(minus);
  stepper.appendChild(value);
  stepper.appendChild(plus);
  stepRow.appendChild(stepper);
  scoringCard.appendChild(stepRow);

  root.appendChild(scoringCard);

  // Use the Chooser
  const navCard = el('div', 'action-card');
  const navBtn = document.createElement('button');
  navBtn.type = 'button';
  navBtn.textContent = 'Use the Chooser';
  navBtn.addEventListener('click', () => showChooser());
  navCard.appendChild(navBtn);
  root.appendChild(navCard);

  return root;
}

function openColorPicker(playerId) {
  const player = scoring.getPlayers().find((p) => p.id === playerId);
  if (!player) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.dataset.modal = 'color-picker';

  const header = el('div', 'modal-header');
  const h2 = el('h2', null, 'Choose color');
  header.appendChild(h2);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'modal-close';
  close.textContent = '×';
  close.addEventListener('click', () => {
    overlay.remove();
  });
  header.appendChild(close);
  overlay.appendChild(header);

  const body = el('div', 'modal-body');
  const grid = el('div', 'color-picker');
  for (const hue of HUE_PALETTE) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'swatch' + (Math.abs(hue - player.hue) < 1 ? ' selected' : '');
    sw.style.background = `oklch(70% 0.20 ${hue})`;
    sw.addEventListener('click', () => {
      scoring.setPlayerHue(playerId, hue);
      overlay.remove();
    });
    grid.appendChild(sw);
  }
  body.appendChild(grid);
  overlay.appendChild(body);

  modalRoot.appendChild(overlay);
}

// ---- History modal ----

function openHistory() {
  closeModal();
  const { modal, body } = makeModalShell('history', 'History');
  modal.classList.add('history-modal');
  body.innerHTML = '';
  body.appendChild(buildHistoryContent());
  modalRoot.appendChild(modal);
}

function refreshHistoryModal() {
  const open = modalRoot.querySelector('.modal[data-modal="history"]');
  if (!open) return;
  const body = open.querySelector('.modal-body');
  body.innerHTML = '';
  body.appendChild(buildHistoryContent());
}

function buildHistoryContent() {
  const root = document.createDocumentFragment();
  const players = scoring.getPlayers();
  const ledger = scoring.getLedger();

  const totals = el('div', 'history-totals');
  for (const p of players) {
    const col = document.createElement('div');
    col.className = 'col';
    col.style.color = `oklch(70% 0.20 ${p.hue})`;
    const name = el('div', 'col-name', p.name);
    const total = el('div', 'col-total', String(p.score));
    col.appendChild(name);
    col.appendChild(total);
    totals.appendChild(col);
  }
  root.appendChild(totals);

  const rows = el('div', 'history-rows');
  if (ledger.length === 0) {
    rows.appendChild(el('div', 'history-row empty', 'No score changes yet.'));
  } else {
    // Newest at top
    for (let i = ledger.length - 1; i >= 0; i--) {
      const entry = ledger[i];
      const row = el('div', 'history-row');
      for (const p of players) {
        const col = document.createElement('div');
        col.className = 'col';
        if (p.id === entry.playerId) {
          col.style.color = `oklch(70% 0.20 ${p.hue})`;
          col.textContent = entry.delta > 0 ? `+${entry.delta}` : String(entry.delta);
        }
        row.appendChild(col);
      }
      rows.appendChild(row);
    }
  }
  root.appendChild(rows);

  const actions = el('div', 'history-actions');
  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.innerHTML = `<span>↶</span> Undo`;
  undoBtn.disabled = !scoring.canUndo();
  undoBtn.addEventListener('click', () => scoring.undo());
  actions.appendChild(undoBtn);

  const redoBtn = document.createElement('button');
  redoBtn.type = 'button';
  redoBtn.innerHTML = `<span>↷</span> Redo`;
  redoBtn.disabled = !scoring.canRedo();
  redoBtn.addEventListener('click', () => scoring.redo());
  actions.appendChild(redoBtn);

  root.appendChild(actions);

  return root;
}
