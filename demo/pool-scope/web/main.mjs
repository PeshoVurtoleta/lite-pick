/**
 * Pool Scope -- web/main.mjs : the SIMULATED browser page (PS3 deliverable 2).
 *
 * The "richer pitch" render target for the SAME decision monitor as the TUI, over the simulation: it reuses
 * the renderer-agnostic bricks unchanged -- driver.mjs (the traffic engine over the real ten lite-pick
 * balancers), snapshot.mjs (the SoA ring scene model), detectors.mjs (the five pathology detectors),
 * siblings.mjs (the optional lite-sketch / lite-adaptive peer layer) -- and paints them with render.mjs, the
 * browser renderer it shares with the LIVE page (pickEcosystem/live/). This file keeps only what is the
 * simulation's own: the driver, the fault injectors, the controls and the frame loop.
 *
 * Same DATA PATH as the TUI: on a throttled ~12 Hz tick it runs driver.tick() x3, snapshot.build(),
 * detectors.evaluate() -- all pre-allocated, zero-alloc (the bricks' discipline).
 */

import {Driver, STRATEGIES} from '../driver.mjs';
import {LitePickSnapshot} from '../snapshot.mjs';
import {Detectors} from '../detectors.mjs';
import {createWebScope} from './render.mjs';

const CAP = 12;
const TICKS_PER_FRAME = 3;
const FRAME_MS = 80;                       // ~12.5 Hz data tick (matches the TUI cadence)
const FRAME_SECONDS = TICKS_PER_FRAME * 0.001;

const $ = (id) => document.getElementById(id);
const $strategySelect = $('strategy-select');
const $btnNext = $('btn-next');
// Control buttons, looked up ONCE: inject kind -> button.
const $injectBtn = new Map();
for (const b of document.querySelectorAll('button.ctl.inject')) $injectBtn.set(b.getAttribute('data-inject'), b);
const $ctlButtons = Array.from(document.querySelectorAll('button.ctl.inject, button.ctl[data-inject]'));

let drv = new Driver(CAP);
drv.setStrategy('p2c');
const snap = new LitePickSnapshot(CAP);
const det = new Detectors(CAP);

// The data path is 0-alloc by construction (pre-allocated typed rings, SMI clock, masked head, in-place
// percentile sort). The browser has no reliable per-op heap probe; the exact 0 is proven by the TUI's
// gc-settled measurement + test/torture.mjs. State it honestly rather than fake a live number.
const scope = createWebScope({
    driver: drv, snapshot: snap, detectors: det, cap: CAP,
    allocHtml: '<span class="ok">data 0 B/op</span> (pre-alloc rings)',
});

const activeInjectors = new Set();         // for the control-button pressed state (display only)
let killIdx = 1;                            // next worker index a `kill` inject marks down (steps +2)

/* ------------------------------------------------------------------------------ the main loop --- */

// Data path (0-alloc, same as the TUI): begin frame -> tick x3 -> build -> evaluate. Then refresh the
// render layer (chart arrays + canvases) and bump the render-version so the effect + chart thunks fire.
function frame() {
    drv.beginFrame(FRAME_SECONDS);
    for (let t = 0; t < TICKS_PER_FRAME; t++) drv.tick();
    snap.build(drv);
    det.evaluate(snap);
    scope.render();
}

/* --------------------------------------------------------------------------------- controls ---- */

function setStrategy(name) {
    if (STRATEGIES.indexOf(name) < 0) return;
    drv.setStrategy(name);
    det.reset();
    $strategySelect.value = name;
    scope.repaint();
}

function inject(kind) {
    if (kind === 'kill') {
        drv.conc = 150;
        drv.killWorker(killIdx);
        killIdx = (killIdx + 2) % CAP;
    } else if (kind === 'overload') drv.overloadSpike((CAP / 2) | 0);
    else if (kind === 'flap') drv.flapStorm((CAP / 3) | 0);
    else if (kind === 'pingpong') drv.forcePingPong(2, CAP - 4);
    else if (kind === 'unfair') drv.makeUnfair();
    else if (kind === 'starve') drv.makeStarve();
    else if (kind === 'hotkeys') drv.makeHotKeys();
    else if (kind === 'reset') {
        const cur = drv.strategyName;
        drv = new Driver(CAP);
        drv.setStrategy(cur);
        scope.setDriver(drv);
        det.reset();
        killIdx = 1;
        activeInjectors.clear();
        for (const b of $injectBtn.values()) b.setAttribute('aria-pressed', 'false');
        return;
    }
    if (kind !== 'reset') {
        activeInjectors.add(kind);
        const b = $injectBtn.get(kind);
        if (b) b.setAttribute('aria-pressed', 'true');
    }
}

// strategy select
for (let i = 0; i < STRATEGIES.length; i++) {
    const o = document.createElement('option');
    o.value = STRATEGIES[i];
    o.textContent = (i === 9 ? 0 : i + 1) + '  ' + STRATEGIES[i];
    $strategySelect.appendChild(o);
}
$strategySelect.value = 'p2c';
$strategySelect.addEventListener('change', () => setStrategy($strategySelect.value));
$btnNext.addEventListener('click', () => setStrategy(STRATEGIES[(STRATEGIES.indexOf(drv.strategyName) + 1) % STRATEGIES.length]));

for (const b of $ctlButtons) {
    b.addEventListener('click', () => inject(b.getAttribute('data-inject')));
}

// keyboard (mirror the TUI)
globalThis.addEventListener('keydown', (ev) => {
    const k = ev.key;
    if (k >= '1' && k <= '9') setStrategy(STRATEGIES[k.charCodeAt(0) - 49]);
    else if (k === '0') setStrategy(STRATEGIES[9]);
    else if (k === 'n') setStrategy(STRATEGIES[(STRATEGIES.indexOf(drv.strategyName) + 1) % STRATEGIES.length]);
    else if (k === 'k') inject('kill');
    else if (k === 'o') inject('overload');
    else if (k === 'f') inject('flap');
    else if (k === 'p') inject('pingpong');
    else if (k === 'u') inject('unfair');
    else if (k === 's') inject('starve');
    else if (k === 'r') inject('reset');
});

/* ----------------------------------------------------------------------------------- startup --- */

// Auto-run the healthy scenario on load (design brief: show the app at rest, calm baseline).
await scope.initCharts();
// Warm the rings so the first painted frame is settled (no short-window transient blips).
for (let f = 0; f < 40; f++) {
    drv.beginFrame(FRAME_SECONDS);
    for (let t = 0; t < TICKS_PER_FRAME; t++) drv.tick();
    snap.build(drv);
    det.evaluate(snap);
}
frame();
setInterval(frame, FRAME_MS);

// Signal a clean start so index.html's CDN-failure watchdog stands down (L25): if this line is never
// reached (a critical module such as lite-signal failed to load), the page shows a visible banner.
globalThis.__poolScopeReady = true;
