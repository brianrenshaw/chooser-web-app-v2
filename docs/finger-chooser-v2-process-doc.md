# Finger Chooser v2 Process Doc

[[toc-levels:2]]
[[toc]]

## Why This Exists

v1 of Finger Chooser is shipped and stable at `https://brianrenshaw.github.io/chooser-web-app/`. It does one job: random pick of a finger placed on the screen. After playing actual tabletop games where the chooser decided who went first, the next obvious need was keeping score during the game itself. Reaching for a separate scorekeeping app every time broke the flow.

v2 adds Scoring Mode without putting v1 at risk. v1 keeps shipping unchanged from the original repo. v2 lives in its own repo (`chooser-web-app-v2`) at its own Pages URL, with its own iOS bundle ID so both versions can install side-by-side on the same iPhone. v2 is also a forward port: when v2 stabilizes, the user can decide whether to retire v1 or keep both.

The Scoring Mode interaction is built around a single shared circular ring with one colored puck per player, anchored at evenly-spaced poles. To score, the player drags their puck around the ring; an arc fills behind it; releasing commits the score. Every 30 degrees of rotation is one detent that fires a haptic tick and increments the score by the configured Score Step. The ring is the same one shared by everyone at the table, which works well for tabletop games where the phone is laid flat between players.

## How the Ecosystem Works

Three deployment targets sharing one source tree:

1.  **Plain mobile web** at `https://brianrenshaw.github.io/chooser-web-app-v2/`. Anyone with a phone browser can use it. Hosted on GitHub Pages, deployed via a GitHub Actions workflow on every push to `main`.
2.  **iOS home-screen PWA**. Add to Home Screen from Safari to launch fullscreen with no Safari chrome. Same code, no real haptics on iOS web.
3.  **Native iOS app** via Capacitor. The `web/` folder is bundled into a thin Swift WebKit shell (`ios/App/App.xcworkspace`). On native, the app routes haptic feedback through `@capacitor/haptics` for real Taptic Engine output.

The web bundle is the single source of truth. `npx cap sync ios` copies `web/*` into `ios/App/App/public/` so the native app gets every change. There is no build step, no bundler, no transpiler. Editing files in `web/` in place is the workflow.

The relationship to v1: v1 is a separate repo, separate Pages site, separate iOS bundle ID. v2 is forked from v1 and diverged. There is no shared code between them at the source level, though v2 inherits all of v1's chooser code as its starting point.

## What It Produces

The runtime "outputs" are interactive UI states across two views (chooser and scoring) plus modals.

The following table lists the chooser view's runtime states (unchanged from v1).

| State | Visible result |
|---|---|
| `IDLE` | Black screen, faint "Place fingers to begin." hint |
| `WAITING` | One pulsing neon ring per finger; hint fades |
| `COUNTDOWN` | Pulse rate accelerates from 1200ms period down to 150ms |
| `REVEALED` | One ring scales to 1.5x and brightens; others fade out |

The following table lists the scoring view's elements.

| Element | Behavior |
|---|---|
| Shared ring track | Centered, ~36px stroke, dark grey fill |
| Puck (one per player) | Colored disc anchored at a pole; player drags it around the ring |
| Player name | Player's accent color, positioned at their puck's anchor |
| Score number | Large, colored, tabular-nums; swaps to "+N" delta during a drag |
| Arc trail | Drawn behind the puck during a drag, in the player's color |
| Top-right gear | Always visible; opens settings modal (in scoring) or jumps to scoring (from chooser) |
| Top-left history | Visible only in scoring; opens history modal |

Persisted artifacts in `localStorage` (per-origin):

*   `chooser_v2:activeGame` — current game state (game info, players, ledger, undo/redo stacks)
*   `chooser_v2:settings` — Score Step and Allow Negative Scores
*   `chooser_v2:archive` — past completed games (capped at 20)

## How the Automation Works

One automated cycle: web deploy.

1.  Developer pushes a commit to `main` that touches `web/**` or `.github/workflows/pages.yml`.
2.  GitHub Actions fires the workflow at `.github/workflows/pages.yml`.
3.  Workflow checks out the repo, runs `actions/configure-pages@v5`, uploads `web/` as an artifact, deploys via `actions/deploy-pages@v4`.
4.  GitHub Pages serves the new build at the canonical URL within ~30-60 seconds.

The Pages source is configured to "GitHub Actions" build mode, since the legacy "Deploy from a branch" mode only allows `/` or `/docs` as roots and v2 keeps web sources in `web/`.

The iOS app deploy is fully manual: open Xcode, hit Cmd+R, select the iPhone as run target. There is no CI for the native build.

Management URLs:

*   Workflow runs: `https://github.com/brianrenshaw/chooser-web-app-v2/actions`
*   Pages settings: `https://github.com/brianrenshaw/chooser-web-app-v2/settings/pages`
*   Repo: `https://github.com/brianrenshaw/chooser-web-app-v2`

## How the Core Logic Works

Two views, both gesture-driven, both built on Pointer Events.

### Chooser view (unchanged from v1)

Four-state machine in `web/chooser.js`:

*   `IDLE`: 0-1 fingers down. Two or more land → `WAITING`.
*   `WAITING`: 1500ms timer. Any new pointerdown or pointerup resets the timer. If finger count drops below 2, return to `IDLE`. Timer fires → `COUNTDOWN`.
*   `COUNTDOWN`: 1000ms requestAnimationFrame loop accelerates the pulse and fires escalating haptic ticks. New pointerdown cancels back to `WAITING`. A lift continues the countdown unless the count drops below 2.
*   `REVEALED`: Random winner gets `.winner` class (1.5x scale, brightened). Losers fade out. After a 400ms reset lockout, any pointerdown returns to `IDLE`.

Why the late-joiner wait, why pointer events, why the golden angle, why OKLCH — all carried forward from v1's design and explained in the v1 process doc.

### Scoring view: the shared ring

`web/scoring.js` renders one shared ring with one puck per player. Pucks are anchored at evenly-spaced poles around the ring (every `2π / N` radians, starting from 12 o'clock). Player labels sit at their anchor angles, either above/below the ring (2 players) or radially around the ring (3-8 players).

### The drag gesture

The scoring gesture is a circular drag, deliberately chosen over swipe-up so the player never runs out of room to score.

State per active gesture (one per pointer):

```text
gesture = {
  pointerId, playerId,
  anchorAngle,           // puck's pole, e.g. -π/2 for 12 o'clock
  startAngle,            // atan2 of finger at pointerdown
  lastAngle,             // previous frame's angle, for delta calculation
  cumulativeDeltaRad,    // signed total rotation since pointerdown
  detentsCommitted,      // integer count of detents reached this drag
  sign,                  // +1 (clockwise) or -1 (counter-clockwise)
}
```

Pointer flow:

1.  `pointerdown` near a puck on the ring. Hit-test: finger must be within `HIT_RADIAL_TOLERANCE` (80px) of the ring track and within `HIT_ANGULAR_TOLERANCE` (60 degrees) of an unclaimed puck. The puck visually decouples from its anchor and snaps to follow the finger angle.
2.  `pointermove`: compute current angle from the finger to the ring center; calculate frame delta with `±π` unwrap; accumulate. Reposition the puck along the ring at the cumulative angle. Render an arc trail in the player's color from the anchor to the puck's current angle.
3.  Detent crossing: every `π/6` (30 degrees) of cumulative rotation = one detent = `+SCORE_STEP` (or `-SCORE_STEP` if Allow Negative Scores). Each detent fires `detentHaptic()` (LIGHT impact + click on web fallback). The score number swaps to a "+N" delta preview.
4.  `pointerup`: commit the total delta as a single undo entry. Player score updates; commitHaptic (MEDIUM impact) fires; arc fades; puck snaps back to anchor with a CSS transition.
5.  `pointercancel`: revert all state, snap puck back, no commit.

Multiple players can drag simultaneously since each gesture is keyed by `pointerId`.

### Why a circular drag instead of vertical swipe

Vertical swipe runs out of screen. A knob-style rotation gives unbounded travel; a player can keep cranking through ten or twenty detents without running out of space. The 30 degree detent feels like a real physical knob, especially with haptic feedback. The arc trail behind the puck makes the magnitude visible.

### State and persistence

Single in-memory `state` in `scoring.js`:

```text
state = {
  game: { name, notes, startedAt },
  players: [{ id, index, name, hue, score }],
  ledger: [{ playerId, delta, at }],     // every commit, capped 500
  undoStack: [{ playerId, totalDelta, prevScore, at }],
  redoStack: [...],
}
```

`web/storage.js` writes the active game to `localStorage` with a 300ms debounce after every state change, plus a synchronous flush on `pagehide` and `visibilitychange:hidden`. On boot, the state is hydrated; on parse failure, defaults are used.

`localStorage` is per-origin, so the iOS Capacitor build (`capacitor://localhost`) and the Pages site (`https://brianrenshaw.github.io`) have separate stores. Acceptable for v2.

### Pre-populate from chooser

When the gear is tapped from the chooser view, `chooser.getActiveRings()` returns the OKLCH hues of currently-touching rings. If non-empty, `scoring.mount()` initializes one player per ring with the matching hue. From idle (no rings), default to two players: Brian (blue, hue 214) and Brad (red, hue 25).

## Key Files

The following table lists every file that matters.

| File | Location | Purpose |
|---|---|---|
| `index.html` | `web/` | Entry point. Stages, top-corner buttons, modal root, module script. |
| `style.css` | `web/` | Black background, chooser ring/winner/loser, scoring ring/labels/pucks, modals, toggles. |
| `feedback.js` | `web/` | Shared helpers: vibrate, audio click, Capacitor haptics, plus `tick`, `revealHaptic`, `detentHaptic`, `commitHaptic`. |
| `chooser.js` | `web/` | Chooser state machine and rendering. Exports `mount`, `unmount`, `getActiveRings`. |
| `scoring.js` | `web/` | Scoring view: shared ring, gestures, ledger, undo/redo, settings hooks, player management. |
| `storage.js` | `web/` | Debounced `localStorage` JSON wrapper with prefixed keys and pagehide flush. |
| `main.js` | `web/` | View controller. Wires gear/history buttons, switches views, builds settings/history modals. |
| `icon.svg` | `web/` | SVG favicon. |
| `apple-touch-icon.png` | `web/` | 180x180 PNG for iOS home screen. |
| `.nojekyll` | `web/` | Tells Pages not to run Jekyll. |
| `pages.yml` | `.github/workflows/` | GitHub Actions deploy workflow for Pages. |
| `capacitor.config.json` | repo root | `appId: com.brianrenshaw.chooser.v2`, `appName: Finger Chooser v2`, `webDir: web`. |
| `package.json` | repo root | `chooser-web-app-v2`, Capacitor 7 deps. |
| `App.xcworkspace` | `ios/App/` | Xcode workspace for the v2 native build. |

External dashboards and management URLs:

*   GitHub repo: `https://github.com/brianrenshaw/chooser-web-app-v2`
*   Live site: `https://brianrenshaw.github.io/chooser-web-app-v2/`
*   Pages settings: `https://github.com/brianrenshaw/chooser-web-app-v2/settings/pages`
*   Actions runs: `https://github.com/brianrenshaw/chooser-web-app-v2/actions`
*   v1 reference (do not modify from this repo): `https://github.com/brianrenshaw/chooser-web-app`

## Directory Layout

```text
chooser-web-app-v2/
├── .github/
│   └── workflows/
│       └── pages.yml            GitHub Actions deploy from web/
├── .gitignore                   Excludes node_modules, Pods, build, public/
├── capacitor.config.json        appId com.brianrenshaw.chooser.v2, webDir=web
├── demo-assets/                 Reference screenshots used during design
│   ├── IMG_5550.PNG             2-player main view
│   ├── IMG_5551.PNG             Mid-drag with arc and delta preview
│   ├── IMG_5552.PNG             History modal
│   └── IMG_5553.PNG             Settings modal
├── docs/
│   └── finger-chooser-v2-process-doc.md   This document
├── ios/                         Capacitor-generated Xcode project
│   └── App/
│       ├── App/                 Swift sources, Info.plist, web bundle in public/
│       ├── App.xcodeproj/
│       ├── App.xcworkspace/     Open this in Xcode
│       ├── Podfile
│       └── Pods/                gitignored
├── node_modules/                gitignored
├── package.json
├── package-lock.json
└── web/                         Single source of truth for the app
    ├── .nojekyll
    ├── apple-touch-icon.png
    ├── chooser.js               Chooser state machine module
    ├── feedback.js              Shared haptics/audio module
    ├── icon.svg
    ├── index.html
    ├── main.js                  View controller, modals
    ├── scoring.js               Scoring view, gestures, undo, persistence
    ├── storage.js               localStorage wrapper
    └── style.css
```

## How to Run Operations

### Local development

1.  `cd /Users/brianrenshaw/Projects/chooser-web-app-v2/web`
2.  `python3 -m http.server 8766`
3.  Find Mac's LAN IP: `ipconfig getifaddr en0`
4.  Open `http://<lan-ip>:8766/` on a phone on the same Wi-Fi
5.  Multi-touch test on a real device. Desktop browsers can't reproduce real Pointer Events for multi-finger gestures.

### Deploy to web

1.  Make changes inside `web/`
2.  `git add web/...`
3.  `git commit -m "..."`
4.  `git push`
5.  Watch the run at `https://github.com/brianrenshaw/chooser-web-app-v2/actions`. Workflow finishes in ~30 seconds.
6.  Hard-reload on phone or append `?v=N` to bypass aggressive Mobile Safari caching.

### Build and run the iOS app

1.  After any change to `web/`, run `npx cap sync ios` from the repo root.
2.  Open the Xcode workspace: `npx cap open ios` (or open `ios/App/App.xcworkspace` directly, never the `.xcodeproj`).
3.  In Xcode, select the **App** target. Signing & Capabilities tab. Pick your Personal Team. The bundle ID `com.brianrenshaw.chooser.v2` must be globally unique to your Apple ID; if you get a registration conflict, append a suffix.
4.  Plug in iPhone via USB (Trust This Computer if prompted).
5.  Select the iPhone as the run destination.
6.  Cmd+R.
7.  First launch: Settings > General > VPN & Device Management on the iPhone, trust the developer certificate.

### Manually trigger a Pages deploy

Open `https://github.com/brianrenshaw/chooser-web-app-v2/actions/workflows/pages.yml`, click "Run workflow".

### Inspect the persisted state on a phone

`localStorage` is browser-scoped. Easiest path: open Safari Develop menu attached to a tethered iPhone, run `localStorage.getItem('chooser_v2:activeGame')` in the console.

## How to Modify

### Change Score Step or Allow Negative Scores

These are user-facing. Open the gear in scoring view → Scoring section. Step is a stepper (1, 2, 3, ...); Allow Negative is a toggle. They persist in `chooser_v2:settings` and apply immediately to the next gesture.

### Change the detent rate

In `web/scoring.js`, edit `DETENT_RAD` (currently `Math.PI / 6` = 30 degrees per detent). Lower = finer (more haptics, slower scoring). Higher = coarser.

### Change the chooser timing

In `web/chooser.js`:

*   `WAIT_MS` (1500ms): late-joiner wait.
*   `COUNTDOWN_MS` (1000ms): tension countdown.
*   `RESET_LOCKOUT_MS` (400ms): post-reveal lockout.
*   `PULSE_BASE_MS` / `PULSE_FAST_MS`: pulse animation envelope.

### Change colors

The chooser uses random OKLCH hues stepping by the golden angle. The scoring view uses each player's stored hue. The default 2 players are blue (214) and red (25) in `DEFAULT_PLAYERS` at the top of `scoring.js`. The 24-color picker palette is `HUE_PALETTE` in `main.js`.

### Add a new settings field

1.  Add the field to `state.settings` in `scoring.js` and the `setX/getX` exports.
2.  Persist it in `persistSettings()`.
3.  Hydrate it in `hydrateSettings()`.
4.  Add a row in `buildSettingsContent()` in `main.js` with a toggle/stepper bound to the new exports.

### Add a new player layout breakpoint

In `scoring.js`, edit `render()` to add a branch (e.g., for 6+ players, switch from radial to spoke). Add a corresponding rendering function. Update the layout's CSS in `style.css`.

### Change the haptic pattern

In `web/feedback.js`:

*   `detentHaptic()` — single LIGHT impact during scoring drag detents.
*   `commitHaptic()` — MEDIUM impact when a drag releases with non-zero delta.
*   `tick(intensity)` — chooser countdown ticks (intensity 0-1).
*   `revealHaptic()` — chooser reveal volley.

Capacitor styles: `LIGHT`, `MEDIUM`, `HEAVY`, `SOFT`, `RIGID` (iOS 13+). Notification types: `SUCCESS`, `WARNING`, `ERROR`.

## Known Quirks and Edge Cases

*   **iOS Safari has no Web Vibration API.** Real haptics only work in the Capacitor-wrapped iOS app via `@capacitor/haptics`. Web pages and PWAs on iOS get the audio click fallback.

*   **AudioContext is locked until first user gesture on iOS.** `ensureAudio()` is called on the first pointerdown to unlock it. The very first finger placed in a session may produce no audio; subsequent ones will.

*   **Mobile Safari aggressively caches `app.js` and `style.css`.** Hard reload is unreliable on iOS. Append `?v=N` to the URL, increment N, to bypass cache.

*   **Free Apple ID signing has hard limits.** Sideloaded iOS app expires every 7 days, requires reconnecting the phone to the Mac to refresh, and only installs on your own device. Sharing the v2 iOS app to other people requires the Apple Developer Program ($99/year) and TestFlight or Ad Hoc.

*   **iOS caps simultaneous touches at 5.** Six fingers will not all register in the chooser. For scoring, multi-player simultaneous drags work up to that cap.

*   **9+ players: scoring is read-only.** The shared ring layout doesn't scale past 8 anchors cleanly, so 9+ falls back to a stacked list of player rows with no drag gesture. Add/remove via Settings still works. A future iteration could give each player their own mini-dial.

*   **Radial labels can clip in landscape on small screens.** The label position math uses the ring container's actual bounding rect, but very tight aspect ratios can push labels off-screen. ResizeObserver re-runs on rotation; a deeper fix would scale labels down past a threshold.

*   **Storage is per-origin.** PWA on iOS home screen, the iOS Capacitor app, and Mobile Safari each have their own `localStorage`. Games started in one don't appear in another. v2 deliberately does not migrate from v1.

*   **Pages "Deploy from branch" does not support `/web` as a root.** Only `/` or `/docs`. v2 uses the GitHub Actions deploy mode (`build_type: workflow`); do not flip Pages back to "Deploy from branch" or the URL will start serving the repo root.

*   **CocoaPods is required.** Capacitor 7's iOS template still uses CocoaPods. Install with `brew install cocoapods` before `npx cap add ios`.

*   **Capacitor 7 needs Xcode 16+.** v2 is built and tested with Xcode 26 beta.

## If You Are Setting This Up From Scratch

Prerequisites:

*   macOS with Homebrew
*   Node.js (for `npx`)
*   Xcode 16 or newer with command-line tools pointing at the Xcode app (not just CommandLineTools)
*   CocoaPods (`brew install cocoapods`)
*   GitHub CLI (`gh`) authenticated as the target account
*   A free Apple ID for sideloading, or paid Apple Developer Program for distribution

Step-by-step:

1.  Clone the repo: `git clone https://github.com/brianrenshaw/chooser-web-app-v2.git`
2.  `cd chooser-web-app-v2`
3.  `npm install` to install Capacitor deps.
4.  Verify the web build serves locally: `cd web && python3 -m http.server 8766`, open the LAN URL on a phone.
5.  Point xcode-select at full Xcode (not CommandLineTools): `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` (or `Xcode-beta.app`).
6.  Accept the Xcode license: `sudo xcodebuild -license accept`.
7.  If `ios/` does not exist, run `npx cap add ios`. Otherwise run `npx cap sync ios` to refresh the web bundle and plugin pods.
8.  Open the workspace: `npx cap open ios`.
9.  In Xcode, select the App target. Signing & Capabilities tab. Sign in with your Apple ID. Pick your Personal Team. Edit the bundle ID if you get a registration conflict.
10.  Plug in iPhone, select it as the run destination, hit Cmd+R.
11.  Trust the developer certificate at iPhone Settings > General > VPN & Device Management.

To set up Pages on a fresh fork:

1.  Push to `main`. The workflow will run.
2.  Switch Pages source to GitHub Actions: `gh api -X PUT repos/<user>/<repo>/pages -f 'build_type=workflow'`.
3.  Confirm: `gh api repos/<user>/<repo>/pages` should show `build_type: workflow`.

## History

The following table tracks meaningful changes.

| Date | Change |
|---|---|
| 2026-05-02 | v2 repo created as a fork of v1's source. v2 capacitor config, Pages enabled, identical chooser behavior verified. |
| 2026-05-02 | Refactored chooser into ES modules: `feedback.js`, `chooser.js`, `main.js`. No behavior change. |
| 2026-05-02 | Scoring view scaffolded: gear button, history button, static 2-player ring matching `IMG_5550.PNG`. |
| 2026-05-02 | Drag gesture, persistence, settings/history modals, and 3-8 player radial layout shipped together. Detent haptics fire every 30 degrees of rotation; commit haptic on release; `localStorage` persists active game with debounced writes; settings modal matches `IMG_5553.PNG`; history modal matches `IMG_5552.PNG`. 9+ players fall back to a read-only stack. |
| 2026-05-02 | iOS native scaffolded with `appId com.brianrenshaw.chooser.v2`. Coexists with v1 on the same iPhone since bundle IDs differ. |
| 2026-05-02 | This process documentation written. |
