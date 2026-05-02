// Top-level view controller for v2. Currently mounts the chooser into
// #chooser-stage. Scoring view, gear button, and history button get wired
// in here in subsequent phases.

import * as chooser from './chooser.js';

const chooserStage = document.getElementById('chooser-stage');

document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());

chooser.mount(chooserStage);
