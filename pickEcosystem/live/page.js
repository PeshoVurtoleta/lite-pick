/**
 * pickEcosystem/live -- the BROWSER page (capstone P3): the live load-balancing system running in this tab.
 *
 * The same `bootKernel` as the terminal (tui.mjs, run.mjs) and the tests, with the browser's I/O: lite-worker-pool's
 * default transport (real Web Workers from Blob URLs, via lite-worker), `performance.now`, real timers. Nothing is
 * simulated: every request is a ~1 ms job on a worker thread, chosen by lite-pick, and every fault happens inside
 * the worker. Pool Scope's browser renderer (demo/pool-scope/web/render.mjs, shared with the simulated page)
 * paints it through LiveDriver; this file adds the live system's own panels -- the fleet, the DECISIONS and
 * REROUTES streams (narrate.js, the terminal's words) -- and its controls (surface.js, the terminal's keys).
 *
 * Every module is a pinned esm.sh URL in index.html's import map (test/web.test.mjs keeps it equal to
 * package.json). The visitor's device is measured first (surface.js): ~1 ms of CPU per job on THIS machine.
 */

import * as lp from '@zakkster/lite-pick';
import * as poolMod from '@zakkster/lite-pick/pool';
import * as wp from '@zakkster/lite-worker-pool';
import { LitePickSnapshot } from '../../demo/pool-scope/snapshot.mjs';
import { Detectors } from '../../demo/pool-scope/detectors.mjs';
import { createWebScope } from '../../demo/pool-scope/web/render.mjs';
import { bootKernel, DEFAULTS, STRATEGIES, ENGINE_A, ENGINE_B, STREAM_CAP } from './kernel.js';
import { LiveDriver } from './driver.js';
import { S_OK, S_FAILED, S_FAILOVER, S_SHED } from './stats.js';
import { workerState, WS_TAG, WS_LONG, WS_TONE, eventText, eventTone } from './narrate.js';
import { calibrateUnitsPerMs, browserScene, FAULT_KEYS, rateUp, rateDown, applyFault } from './surface.js';
import { TourPlayer } from './tour.js';

const N = DEFAULTS.workers;
const FRAME_MS = 80;                       // ~12 Hz, the TUI's cadence
const DECISION_LINES = 6;
const REROUTE_LINES = 3;
const TONE_CLASS = ['ok', 'warn', 'bad', 'info'];   // narrate.js TONE_OK / WARN / BAD / INFO
const ALLOC_A = '<span class="ok">request path 0 B/op</span> (engine A; gated in CI)';
const ALLOC_B = '<span class="warn">engine B ~2.9 KB/request</span> (/pool + promises; measured in CI)';
const now = () => performance.now();

/* ------------------------------------------------------------------------- cached DOM refs ---- */

const $ = (id) => document.getElementById(id);
const $status = $('boot-status');
const $headAlloc = $('head-alloc');
const $backCpu = $('back-cpu');
const $strategySelect = $('strategy-select');
const $btnNext = $('btn-next');
const $btnEngine = $('btn-engine');
const $rate = $('rate');
const $btnRateDown = $('btn-rate-down');
const $btnRateUp = $('btn-rate-up');
const $selLabel = $('sel-label');
const $btnShutdown = $('btn-shutdown');
const $btnReboot = $('btn-reboot');
const $note = $('note');
const $fleetStats = $('fleet-stats');
const $fleet = $('fleet');
const $decisions = $('decisions');
const $rerouteCount = $('reroute-count');
const $reroutes = $('reroutes');
const $faultButtons = Array.from(document.querySelectorAll('button[data-fault]'));
const $tour = $('tour');
const $tourStep = $('tour-step');
const $tourCaption = $('tour-caption');
const $btnTour = $('btn-tour');
const $btnTourStop = $('btn-tour-stop');

/* ------------------------------------------------------------------------------ the system ---- */

let k = null;                 // the running kernel
let t0 = 0;                   // its boot time (event timestamps are relative to it)
let stopping = false;
let exitCode = null;
let savedRate = 0;            // the rate to restore when the tab is visible again
let lastFrame = 0;
let shownEngine = -1;
let shownStructural = -1, shownReroutes = -1;

const snap = new LitePickSnapshot(N);
const det = new Detectors(N);
let drv = null;
let scope = null;
let tour = null;               // the guided tour (tour.js), over the running kernel
let shownCaption = null;
let shownStrategy = null;

function status(text, tone) {
    $status.textContent = text;
    $status.className = 'boot-status ' + (tone || '');
}

function note(text) { $note.textContent = text; }

async function start() {
    status('booting ' + N + ' Web Workers...', 'warn');
    stopping = false;
    exitCode = null;
    const unitsPerMs = calibrateUnitsPerMs(now, 80);
    $backCpu.textContent = (unitsPerMs / 1000).toFixed(0) + 'k loop units/ms';
    const cfg = browserScene(navigator.hardwareConcurrency);
    cfg.unitsPerMs = unitsPerMs;
    k = await bootKernel({ lp, poolMod, wp, now, timers: 'real', config: cfg });
    t0 = now();
    tour = new TourPlayer(k);
    shownStructural = -1;
    shownReroutes = -1;
    if (drv === null) drv = new LiveDriver(k);
    else { drv = new LiveDriver(k); scope.setDriver(drv); det.reset(); }
    $strategySelect.value = k.balancers.name;
    $btnShutdown.hidden = false;
    $btnReboot.hidden = true;
    if (document.hidden) pause(); else running();
}

function running() { status('running: ' + N + ' Web Workers, ' + k.traffic.rate + ' requests/s offered', 'ok'); }

// A hidden tab's timers are throttled (once a second, or slower), so a tick would offer a whole second of
// arrivals at once: offer no traffic while hidden, and resync the generator on return.
function pause() {
    if (k.traffic.rate > 0) { savedRate = k.traffic.rate; k.setRate(0); }
    status('paused while this tab is hidden (the workers stay up)', 'warn');
}

function resume() {
    if (savedRate > 0) {
        k.traffic.resync();
        k.setRate(savedRate);
        savedRate = 0;
    }
    running();
}

/* ----------------------------------------------------------------------- the live panels ---- */

// The fleet chips, built once; a frame only updates their text and attributes.
const chipState = [], chipRestarts = [], chips = [];
for (let i = 0; i < N; i++) {
    const b = document.createElement('button');
    b.className = 'wchip';
    b.setAttribute('data-w', String(i));
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = 'w' + i;
    const dot = document.createElement('span');
    dot.className = 'dot';
    const st = document.createElement('span');
    st.className = 'state';
    const rs = document.createElement('span');
    rs.className = 'restarts';
    b.append(name, dot, st, rs);
    $fleet.appendChild(b);
    chips.push(b);
    chipState.push(st);
    chipRestarts.push(rs);
}

function makeLines(host, n) {
    const out = [];
    for (let j = 0; j < n; j++) { const li = document.createElement('li'); host.appendChild(li); out.push(li); }
    return out;
}
const decisionLines = makeLines($decisions, DECISION_LINES);
const rerouteLines = makeLines($reroutes, REROUTE_LINES);

function paintLane(lane, lines, empty) {
    const m = lane.count < lines.length ? lane.count : lines.length;
    for (let j = 0; j < lines.length; j++) {
        const li = lines[j];
        if (j >= m) {
            li.textContent = j === 0 && lane.count === 0 ? empty : '';
            li.className = 'quiet';
            continue;
        }
        const idx = (lane.head - 1 - j + STREAM_CAP) % STREAM_CAP;
        const type = lane.type[idx], p = lane.payload[idx];
        li.textContent = ((lane.time[idx] - t0) / 1000).toFixed(2) + 's  ' + eventText(type, p);
        li.className = TONE_CLASS[eventTone(type, p)];
    }
}

function paintLive() {
    if (k === null || scope === null) return;     // the renderer's first paint runs inside createWebScope
    const sel = scope.selected();
    for (let i = 0; i < N; i++) {
        const ws = workerState(k, i);
        chips[i].setAttribute('data-tone', TONE_CLASS[WS_TONE[ws]]);
        chips[i].setAttribute('aria-pressed', i === sel ? 'true' : 'false');
        chips[i].title = 'w' + i + ': ' + WS_LONG[ws] + ', restarted ' + k.fleet.restarts[i] + 'x';
        chipState[i].textContent = WS_TAG[ws];
        chipRestarts[i].textContent = 'r' + k.fleet.restarts[i];
    }
    const c = k.stats.c;
    $fleetStats.textContent = 'ok ' + c[S_OK] + '  failed ' + c[S_FAILED] + '  failover ' + c[S_FAILOVER] +
        '  shed ' + c[S_SHED] + '  in flight ' + k.engine.pending();
    $fleetStats.className = c[S_FAILED] > 0 ? 'fleet-stats bad' : 'fleet-stats';
    const st = k.stream.structural, rr = k.stream.reroute;
    if (st.count !== shownStructural) { shownStructural = st.count; paintLane(st, decisionLines, '(quiet -- inject a fault)'); }
    if (rr.count !== shownReroutes) {
        shownReroutes = rr.count;
        $rerouteCount.textContent = rr.count + ' failovers so far';
        paintLane(rr, rerouteLines, '(none yet)');
    }
    $rate.textContent = String(k.traffic.rate);
    $selLabel.textContent = sel >= 0 ? 'w' + sel : '(select a worker)';
    if (k.engine.mode !== shownEngine) {
        shownEngine = k.engine.mode;
        $btnEngine.textContent = shownEngine === ENGINE_A ? 'A  zero-alloc' : 'B  /pool';
        $headAlloc.innerHTML = shownEngine === ENGINE_A ? ALLOC_A : ALLOC_B;
    }
}

/* ------------------------------------------------------------------------------ the loop ---- */

function paintTour() {
    const caption = tour !== null && tour.active ? tour.caption : null;
    if (caption === shownCaption) return;
    shownCaption = caption;
    $tour.hidden = caption === null;
    $btnTour.textContent = '';
    $btnTour.append(caption === null ? 'take the tour ' : 'stop the tour ');
    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = '[t]';
    $btnTour.append(key);
    if (caption !== null) {
        $tourStep.textContent = 'TOUR ' + tour.progress;
        $tourCaption.textContent = caption;
    }
}

function frame() {
    if (drv === null) return;
    const t = now();
    if (tour !== null && !stopping) tour.tick(t);
    paintTour();
    // A strategy change from anywhere (a key, the select, the tour): the detectors restart, the select follows.
    if (k !== null && k.balancers.name !== shownStrategy) {
        if (shownStrategy !== null) det.reset();
        shownStrategy = k.balancers.name;
        $strategySelect.value = shownStrategy;
    }
    drv.beginFrame(lastFrame > 0 ? (t - lastFrame) / 1000 : FRAME_MS / 1000);
    lastFrame = t;
    snap.build(drv);
    det.evaluate(snap);
    scope.render();
}

/* ------------------------------------------------------------------------------ controls ---- */

function setStrategy(name) {
    if (k === null || stopping || STRATEGIES.indexOf(name) < 0) return;
    k.setStrategy(name);
    det.reset();
    $strategySelect.value = name;
    note('strategy -> ' + name);
    scope.repaint();
}

function nextStrategy() { if (k !== null) setStrategy(STRATEGIES[(STRATEGIES.indexOf(k.balancers.name) + 1) % STRATEGIES.length]); }

function toggleEngine() {
    if (k === null || stopping) return;
    k.setEngine(k.engine.mode === ENGINE_A ? ENGINE_B : ENGINE_A);
    note('engine -> ' + (k.engine.mode === ENGINE_A ? 'A (zero-alloc)' : 'B (/pool + promises)'));
    scope.repaint();
}

function setRate(r) {
    if (k === null || stopping) return;
    k.setRate(r);
    note('offered rate -> ' + r + ' requests/s');
    scope.repaint();
}

function fault(kind) {
    if (k === null || stopping) return;
    const w = scope.selected();
    if (w < 0) { note('select a worker first (click it in the fleet, or press w)'); return; }
    const r = applyFault(k, kind, w);
    note(kind + ' -> w' + w + '   (watch DECISIONS)');
    if (r && typeof r.then === 'function') r.then(() => scope.repaint(), (e) => note('reset w' + w + ' failed: ' + e.message));
    scope.repaint();
}

function toggleTour() {
    if (k === null || stopping || tour === null) return;
    if (tour.active) { tour.stop(); note('tour stopped'); }
    else { tour.start(now()); note('the tour drives the same controls you have -- press t to stop it'); }
    paintTour();
}

function selectNext() {
    const s = scope.selected();
    scope.select((s + 1) % N);
}

function shutdown() {
    if (k === null || stopping) return;
    stopping = true;
    if (tour !== null) tour.stop();
    paintTour();
    $btnShutdown.hidden = true;
    note('SHUTTING DOWN: draining, settling in-flight requests, retiring workers...');
    status('shutting down (lite-di-orchestrator)...', 'warn');
    const kernel = k;
    kernel.shutdown({ deadlineMs: 10000 }).then((code) => {
        exitCode = code;
        const c = kernel.stats.c;
        status('shut down: orchestrator exit code ' + code + (code === 0 ? ' (clean)' : '') + '; served ' + c[S_OK] +
            ', failed ' + c[S_FAILED], code === 0 ? 'ok' : 'bad');
        note('every worker retired. Boot a fresh system to continue.');
        $btnReboot.hidden = false;
    });
}

function reboot() {
    if (!stopping || exitCode === null) return;
    $btnReboot.hidden = true;
    start().catch(fail);
}

for (let i = 0; i < STRATEGIES.length; i++) {
    const o = document.createElement('option');
    o.value = STRATEGIES[i];
    o.textContent = (i === 9 ? 0 : i + 1) + '  ' + STRATEGIES[i];
    $strategySelect.appendChild(o);
}
$strategySelect.addEventListener('change', () => setStrategy($strategySelect.value));
$btnNext.addEventListener('click', nextStrategy);
$btnEngine.addEventListener('click', toggleEngine);
$btnRateDown.addEventListener('click', () => { if (k !== null) setRate(rateDown(k.traffic.rate)); });
$btnRateUp.addEventListener('click', () => { if (k !== null) setRate(rateUp(k.traffic.rate)); });
for (const b of $faultButtons) b.addEventListener('click', () => fault(b.getAttribute('data-fault')));
$btnShutdown.addEventListener('click', shutdown);
$btnTour.addEventListener('click', toggleTour);
$btnTourStop.addEventListener('click', toggleTour);
$btnReboot.addEventListener('click', reboot);
$fleet.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-w]');
    if (!b) return;
    scope.select(b.getAttribute('data-w') | 0);
});

// The terminal UI's keys (tui.mjs).
globalThis.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const tag = ev.target && ev.target.tagName;
    if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return;
    const ch = ev.key;
    if (ch >= '1' && ch <= '9') setStrategy(STRATEGIES[ch.charCodeAt(0) - 49]);
    else if (ch === '0') setStrategy(STRATEGIES[9]);
    else if (ch === 'n') nextStrategy();
    else if (ch === 'e') toggleEngine();
    else if (ch === 'w') selectNext();
    else if (ch === '+' || ch === '=') { if (k !== null) setRate(rateUp(k.traffic.rate)); }
    else if (ch === '-') { if (k !== null) setRate(rateDown(k.traffic.rate)); }
    else if (ch === 'q') shutdown();
    else if (ch === 't') toggleTour();
    else if (FAULT_KEYS[ch]) fault(FAULT_KEYS[ch]);
});

document.addEventListener('visibilitychange', () => {
    if (k === null || stopping) return;
    if (document.hidden) pause(); else resume();
});

/* ------------------------------------------------------------------------------- startup ---- */

function fail(e) {
    status('the system failed to boot: ' + ((e && e.message) || e), 'bad');
    throw e;
}

// Every module loaded (index.html's CDN watchdog stands down).
globalThis.__poolScopeReady = true;

status('measuring this device...', 'warn');
await new Promise((r) => setTimeout(r, 0));     // let the status paint first
try {
    await start();
} catch (e) {
    fail(e);
}
scope = createWebScope({
    driver: drv, snapshot: snap, detectors: det, cap: N, keyPrefix: 'rank ',
    allocHtml: ALLOC_A,
    stateLabel: (i) => (k === null ? '-' : WS_LONG[workerState(k, i)]),
    onPaint: paintLive,
});
scope.select(0);
await scope.initCharts();
frame();
setInterval(frame, FRAME_MS);

// The handle the real-browser smoke test (test/browser-smoke.mjs) reads; also handy in the console.
globalThis.__pickLive = {
    get kernel() { return k; },
    get exitCode() { return exitCode; },
    get stopping() { return stopping; },
    get tour() { return tour; },
    /** The structural decisions at or after `since` (page clock, ms), oldest first, as the panel words them. */
    decisions(since) {
        const out = [];
        if (k === null) return out;
        const lane = k.stream.structural;
        const m = lane.count < STREAM_CAP ? lane.count : STREAM_CAP;
        for (let j = m - 1; j >= 0; j--) {
            const idx = (lane.head - 1 - j + STREAM_CAP) % STREAM_CAP;
            if (lane.time[idx] >= since) out.push(eventText(lane.type[idx], lane.payload[idx]));
        }
        return out;
    },
};
