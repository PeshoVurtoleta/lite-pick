/**
 * Pool Scope -- tui.mjs : the terminal renderer + main loop (PS1 deliverable 4).
 *
 * A live oscilloscope-styled TUI that visualises a load-balancing DECISION (not machine resources)
 * for @zakkster/lite-pick. It reads the driver's state off the hot path via the renderer-agnostic
 * LitePickSnapshot, runs the five independent pathology detectors, and paints -- following the design
 * brief's INVERTED colour budget: calm monochrome-green at baseline, warm colour + motion reserved
 * for pathologies only. The kernel (Pick.js) is UNCHANGED and UNTOUCHED -- Pool Scope is a pure
 * consumer that reads dump()-style getters, never perturbs pick().
 *
 * TWO MODES (design DUAL MODE):
 *   interactive : `node demo/pool-scope/tui.mjs`
 *                 raw-mode TTY, live keys, ~12 Hz cursor-home repaint. Hides the cursor, restores on
 *                 exit. Keys: 1-9,0 switch strategy, n cycles; k kill / o overload / f flap /
 *                 p ping-pong / u unfair / s starve / r reset; q or Ctrl-C quit.
 *   scripted    : `node demo/pool-scope/tui.mjs --frames N --scenario <name> --strategy <name> [--seed S]`
 *                 deterministic, renders N frames to stdout, exits 0. Scenarios: healthy, killworker,
 *                 overload, flapstorm, pingpong, unfair, starve, hotkeys. Strategy: one of the ten (default p2c).
 *
 * Hot-path law: driver.tick()/snapshot.build()/detectors.evaluate() are the measured DATA path and
 * allocate no array/object/closure per frame (proven by the `alloc delta` badge, sampled around it).
 * The renderer pre-allocates its scratch + a precomputed colour ramp; it composes a frame STRING
 * (I/O formatting) without creating arrays/objects/closures per frame.
 */

import {Driver, STRATEGIES, DEFAULT_CONC} from './driver.mjs';
import {LitePickSnapshot} from './snapshot.mjs';
import {
    Detectors, OVERLOAD_SAT,
} from './detectors.mjs';

import {
    RESET, SHOW, HIDE, ALT_ON, ALT_OFF, CLR_SCREEN, C_FAINT, TICKS_PER_FRAME, FRAME_SECONDS, WARMUP_FRAMES, MEAS_WARM, MEAS_N, Renderer,
} from './tui-render.mjs';

/* ------------------------------------------------------------------------- scenario wiring ---- */

const SCENARIOS = ['healthy', 'killworker', 'overload', 'flapstorm', 'pingpong', 'unfair', 'starve', 'hotkeys'];

/** The weight-aware strategies: they route proportional to weight, so a weight-0 node is starved. */
const WEIGHT_AWARE = new Set(['smoothwrr', 'sed', 'nq', 'weightedrandom', 'consistenthash', 'boundedload']);

/** Apply a named scenario's conditions to the driver (the injectors the detectors then notice). */
function applyScenario(drv, name) {
    if (name === 'healthy') return;
    if (name === 'killworker') {
        drv.conc = 150;                               // hold offered load while capacity drops
        for (let k = 1; k < drv.cap; k += 2) drv.killWorker(k);   // mass outage -> survivor hotspot
        return;
    }
    if (name === 'overload') {
        drv.overloadSpike((drv.cap / 2) | 0);
        return;
    }
    if (name === 'flapstorm') {
        drv.flapStorm((drv.cap / 3) | 0);
        return;
    }
    if (name === 'pingpong') {
        drv.forcePingPong(2, drv.cap - 4);
        return;
    }
    if (name === 'unfair') {
        drv.makeUnfair();
        return;
    }
    if (name === 'starve') {
        // Genuine POLICY starvation: a weight-aware strategy correctly never routes to a weight-0 but UP
        // node. Ensure a weight-aware strategy is active (under a weight-blind one a weight-0 node is still
        // picked, so starvation would honestly not show), then zero one eligible worker's weight.
        if (!WEIGHT_AWARE.has(drv.strategyName)) drv.setStrategy('smoothwrr');
        drv.makeStarve();
        return;
    }
    if (name === 'hotkeys') {
        drv.makeHotKeys();
        return;
    }   // zipfian keys -> a keyed-strategy hotspot
    throw new Error('[pool-scope] unknown scenario: ' + name + ' (one of ' + SCENARIOS.join(', ') + ')');
}

/* ----------------------------------------------------------------- data-path 0-alloc probe ---- */

/**
 * Measure the DATA path (driver.tick x TICKS_PER_FRAME + snapshot.build + detectors.evaluate) in
 * bytes-per-iteration over a gc-settled batch, EXCLUDING render string-building. Runs on THROWAWAY
 * instances so the displayed simulation is not perturbed. This is the honest proof behind the badge:
 * it must read ~0. (Zero-dep: uses process.memoryUsage + the optional --expose-gc, not a profiler.)
 * @param {string} strategy
 * @param {number} seed
 * @returns {number} bytes/op (clamped at 0; a value >= 1 would flag a real per-frame allocation)
 */
function measureDataPath(strategy, seed) {
    const d = new Driver(12, seed);
    d.setStrategy(strategy);
    const sn = new LitePickSnapshot(d.cap);
    const dt = new Detectors(d.cap);
    for (let i = 0; i < MEAS_WARM; i++) {
        d.beginFrame(FRAME_SECONDS);
        for (let t = 0; t < TICKS_PER_FRAME; t++) d.tick();
        sn.build(d);
        dt.evaluate(sn);
    }
    if (typeof globalThis.gc === 'function') {
        globalThis.gc();
        globalThis.gc();
    }
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < MEAS_N; i++) {
        d.beginFrame(FRAME_SECONDS);
        for (let t = 0; t < TICKS_PER_FRAME; t++) d.tick();
        sn.build(d);
        dt.evaluate(sn);
    }
    if (typeof globalThis.gc === 'function') globalThis.gc();
    const per = (process.memoryUsage().heapUsed - before) / MEAS_N;
    return per > 0 ? per : 0;
}

/* ----------------------------------------------------------------------------- arg parsing ---- */

function argVal(argv, name, def) {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] != null ? argv[i + 1] : def;
}

/* ---------------------------------------------------------------------- scripted (headless) ---- */

function runScripted(argv) {
    const frames = (argVal(argv, '--frames', '40') | 0) || 40;
    const scenario = argVal(argv, '--scenario', 'healthy');
    const strategy = argVal(argv, '--strategy', 'p2c');
    const seed = (argVal(argv, '--seed', '305441741') >>> 0) || 0x1234abcd;
    if (STRATEGIES.indexOf(strategy) < 0) {
        process.stderr.write('pool-scope: unknown strategy ' + strategy +
            ' (one of ' + STRATEGIES.join(', ') + ')\n');
        process.exit(2);
    }
    if (SCENARIOS.indexOf(scenario) < 0) {
        process.stderr.write('pool-scope: unknown scenario ' + scenario +
            ' (one of ' + SCENARIOS.join(', ') + ')\n');
        process.exit(2);
    }
    // Prove the data path is 0-alloc BEFORE running the scenario (throwaway instances, gc-settled).
    const dataBpo = measureDataPath(strategy, seed);

    const drv = new Driver(12, seed);
    drv.setStrategy(strategy);
    applyScenario(drv, scenario);
    const snap = new LitePickSnapshot(drv.cap);
    const det = new Detectors(drv.cap);
    const rend = new Renderer(drv.cap);

    // Warm up so the rolling rings/metrics are settled before the first RENDERED frame: the detectors
    // read steady state (short-window transients during warmup would otherwise blip a secondary badge).
    for (let f = 0; f < WARMUP_FRAMES; f++) {
        drv.beginFrame(FRAME_SECONDS);
        for (let t = 0; t < TICKS_PER_FRAME; t++) drv.tick();
        snap.build(drv);
        det.evaluate(snap);
    }

    process.stdout.write('pool-scope scripted -- scenario=' + scenario + ' strategy=' + strategy +
        ' seed=' + seed + ' frames=' + frames + '  data-path=' + dataBpo.toFixed(2) + ' B/op\n');
    for (let f = 0; f < frames; f++) {
        drv.beginFrame(FRAME_SECONDS);
        for (let t = 0; t < TICKS_PER_FRAME; t++) drv.tick();
        snap.build(drv);
        det.evaluate(snap);
        process.stdout.write('\n' + C_FAINT + '=== frame ' + f + ' ===' + RESET + '\n');
        process.stdout.write(rend.render(snap, det, drv, f, dataBpo, false));
    }
    // Exit in the write callback: a bare process.exit() right after large writes into a PIPE drops the tail.
    process.stdout.write('\npool-scope: done (' + frames + ' frames, exit 0)\n', () => process.exit(0));
}

/* -------------------------------------------------------------------------- interactive TTY ---- */

function runInteractive(argv) {
    const strategy = argVal(argv, '--strategy', 'p2c');
    const seed = (argVal(argv, '--seed', '305441741') >>> 0) || 0x1234abcd;
    const startStrat = STRATEGIES.indexOf(strategy) >= 0 ? strategy : 'p2c';
    const drv = new Driver(12, seed);
    drv.setStrategy(startStrat);
    const snap = new LitePickSnapshot(drv.cap);
    const det = new Detectors(drv.cap);
    const rend = new Renderer(drv.cap);
    let frame = 0;
    let killIdx = 1;
    let timer = null;
    let done = false;
    let dataBpo = measureDataPath(startStrat, seed);   // proven at startup; re-measured on switch

    const out = process.stdout;
    const stdin = process.stdin;

    function restore() {
        if (done) return;
        done = true;
        if (timer) clearInterval(timer);
        if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(false);
        stdin.pause();
        // Show the cursor, reset attributes, and LEAVE the alternate screen so the user's terminal
        // (scrollback + prior content) is restored exactly, not wiped (L23).
        out.write(RESET + SHOW + ALT_OFF);
    }

    /** Restore the terminal, then exit: 0 for a user quit (q / ESC), 128 + signal number for a signal
     *  (the shell convention, audit 2026-09-29 info: SIGINT 130, SIGTERM 143, SIGHUP 129). */
    function quit(code = 0) {
        restore();
        process.exit(code);
    }

    function onKey(chunk) {
        const s = chunk.toString();
        // Escape sequences: an arrow / function key arrives as ESC '[' ... (or ESC 'O' ...). Ignore the
        // whole sequence rather than quitting on the bare ESC prefix (L23). A lone ESC still quits.
        if (s.charCodeAt(0) === 0x1b) {
            if (s.length === 1) {
                quit();
            }
            return;
        }
        for (let c = 0; c < s.length; c++) {
            const ch = s[c];
            if (ch === 'q' || ch === '\x03') {
                quit();
                return;
            }
            if (ch >= '1' && ch <= '9') {
                switchTo((ch.charCodeAt(0) - 49));
            } else if (ch === '0') {
                switchTo(9);
            } else if (ch === 'n') {
                switchTo((STRATEGIES.indexOf(drv.strategyName) + 1) % STRATEGIES.length);
            } else if (ch === 'k') {
                drv.conc = 150;
                drv.killWorker(killIdx);
                killIdx = (killIdx + 2) % drv.cap;
            } else if (ch === 'o') {
                drv.overloadSpike((drv.cap / 2) | 0);
            } else if (ch === 'f') {
                drv.flapStorm((drv.cap / 3) | 0);
            } else if (ch === 'p') {
                drv.forcePingPong(2, drv.cap - 4);
            } else if (ch === 'u') {
                drv.makeUnfair();
            } else if (ch === 's') {
                drv.makeStarve();
            } else if (ch === 'r') {
                resetAll();
            }
        }
    }

    function switchTo(idx) {
        rend.beginMorph();
        drv.setStrategy(STRATEGIES[idx]);
        det.reset();   // clear the sibling detector state so a morph does not blip the ADWIN oscillation
        dataBpo = measureDataPath(STRATEGIES[idx], seed);   // re-prove the new strategy's data path
    }

    function resetAll() {
        const cur = drv.strategyName;
        // clear injector state by rebuilding the driver, keep the current strategy
        const fresh = new Driver(drv.cap, seed);
        fresh.setStrategy(cur);
        // copy the new driver's fields over the old reference targets
        drv.eligible.set(fresh.eligible);
        drv.inflight.set(fresh.inflight);
        drv.weights.set(fresh.weights);
        drv.pin.fill(0);
        drv.ceil.fill(-1);
        drv.slow.fill(0);
        drv.flapEnabled = false;
        drv.ppEnabled = false;
        drv.keyDist = 'uniform';
        drv.conc = DEFAULT_CONC;   // M-D4: match the driver default (and the web reset), not a stale 108
        drv.setStrategy(cur);
        det.reset();
    }

    // A listener receives the signal NAME as its first argument -- so wrap, never pass `quit` directly.
    process.on('SIGINT', () => quit(130));
    process.on('SIGTERM', () => quit(143));   // L23: restore the terminal on a kill / hangup too, not only Ctrl-C
    process.on('SIGHUP', () => quit(129));
    process.on('exit', restore);

    out.write(ALT_ON + CLR_SCREEN + HIDE);
    if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onKey);

    timer = setInterval(() => {
        drv.beginFrame(FRAME_SECONDS);
        for (let t = 0; t < TICKS_PER_FRAME; t++) drv.tick();
        snap.build(drv);
        det.evaluate(snap);
        out.write(rend.render(snap, det, drv, frame, dataBpo, true));
        frame++;
    }, 80);
}

/* ----------------------------------------------------------------------------------- entry ---- */

const argv = process.argv.slice(2);
if (argv.indexOf('--frames') >= 0 || !process.stdout.isTTY) {
    runScripted(argv);
} else {
    runInteractive(argv);
}

void OVERLOAD_SAT;
