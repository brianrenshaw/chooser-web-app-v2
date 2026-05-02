// Top-level view controller for v2.
//
// Wires the gear button to switch between the chooser and scoring views.
// Phase C: gear toggles between chooser and scoring directly. Phase F
// will replace the gear handler with "open settings modal" and the
// scoring view will be exited via a "Back to Chooser" item in settings.

import * as chooser from './chooser.js';
import * as scoring from './scoring.js';

const chooserStage = document.getElementById('chooser-stage');
const scoringStage = document.getElementById('scoring-stage');
const gearBtn = document.getElementById('gear-button');
const historyBtn = document.getElementById('history-button');

let view = 'chooser';

function showChooser() {
  scoring.unmount();
  scoringStage.hidden = true;
  chooserStage.hidden = false;
  chooser.mount(chooserStage);
  historyBtn.hidden = true;
  view = 'chooser';
}

function showScoring() {
  // Snapshot current chooser rings (if any) so scoring can pre-populate
  // with one player per finger using the same OKLCH hues.
  const rings = chooser.getActiveRings();
  chooser.unmount();
  chooserStage.hidden = true;
  scoringStage.hidden = false;
  scoring.mount(scoringStage, rings.length > 0 ? rings : null);
  historyBtn.hidden = false;
  view = 'scoring';
}

gearBtn.addEventListener('click', () => {
  if (view === 'chooser') showScoring();
  else showChooser();
});

historyBtn.addEventListener('click', () => {
  // Phase F will open the history modal here.
});

document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());

showChooser();
