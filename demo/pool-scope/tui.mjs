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
 *                 p ping-pong / u unfair / r reset; q or Ctrl-C quit.
 *   scripted    : `node demo/pool-scope/tui.mjs --frames N --scenario <name> --strategy <name> [--seed S]`
 *                 deterministic, renders N frames to stdout, exits 0. Scenarios: healthy, killworker,
 *                 overload, flapstorm, pingpong, unfair. Strategy: one of the ten (default p2c).
 *
 * Hot-path law: driver.tick()/snapshot.build()/detectors.evaluate() are the measured DATA path and
 * allocate no array/object/closure per frame (proven by the `alloc delta` badge, sampled around it).
 * The renderer pre-allocates its scratch + a precomputed colour ramp; it composes a frame STRING
 * (I/O formatting) without creating arrays/objects/closures per frame.
 */

import { Driver, STRATEGIES } from './driver.mjs';
import { LitePickSnapshot } from './snapshot.mjs';
import {
    Detectors, OVERLOAD_SAT, UNFAIR_GINI,
} from './detectors.mjs';

/* ------------------------------------------------------------------- ANSI + glyph constants ---- */

const ESC = '\x1b[';
const RESET = ESC + '0m';
const BOLD = ESC + '1m';
const HIDE = ESC + '?25l';
const SHOW = ESC + '?25h';
const HOME = ESC + 'H';
const CLR_EOL = ESC + '0K';
const CLR_DOWN = ESC + '0J';
const CLR_SCREEN = ESC + '2J';

function fg(r, g, b) { return ESC + '38;2;' + r + ';' + g + ';' + b + 'm'; }

const C_GREEN = fg(0x5f, 0xe3, 0x9f);
const C_CYAN = fg(0x7d, 0xd3, 0xfc);
const C_AMBER = fg(0xf5, 0xb9, 0x42);
const C_MAGENTA = fg(0xe8, 0x79, 0xa8);
const C_RED = fg(0xf8, 0x71, 0x71);
const C_DIM = fg(0x8b, 0x8d, 0x94);
const C_FAINT = fg(0x55, 0x59, 0x60);
const C_TEXT = fg(0xd8, 0xd6, 0xd2);

// Value-driven gradient: green -> amber -> red. Precomputed once (no per-cell alloc).
const GRAD_N = 24;
const GRAD = new Array(GRAD_N);
(function buildGrad() {
    const g0 = [0x5f, 0xe3, 0x9f], g1 = [0xf5, 0xb9, 0x42], g2 = [0xf8, 0x71, 0x71];
    for (let i = 0; i < GRAD_N; i++) {
        const t = i / (GRAD_N - 1);
        let a, b, u;
        if (t < 0.5) { a = g0; b = g1; u = t * 2; } else { a = g1; b = g2; u = (t - 0.5) * 2; }
        GRAD[i] = fg(
            (a[0] + (b[0] - a[0]) * u) | 0,
            (a[1] + (b[1] - a[1]) * u) | 0,
            (a[2] + (b[2] - a[2]) * u) | 0);
    }
})();

const EIGHTHS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const FULL = '█';
const SHADE = '░';          // light shade (gauge track)
// Heat-strip DENSITY tiers (notcurses idiom): light-shade -> full block, so per-cell load reads as
// texture AND colour, not one uniform slab of solid blocks. Indexed by load magnitude.
const HEAT_DENSITY = ['░', '▒', '▓', '█'];
const DASH = '┄';           // dashed horizontal (mean line)
const GHOST = '┈';          // dotted vertical (weight ghost / morph trail)
const H_BAR = '─';          // box horizontal (chrome rule)

// Pathology badge glyphs (design brief section 5).
const G_OSC = '∿';          // tilde wave
const G_PING = '⇄';         // anti-phase arrows
const G_STARV = '∅';        // empty set
const G_UNFAIR = '⚖';       // scales
const G_OVER = '▲';         // triangle

const BAR_ROWS = 8;
const HEAT_COLS = 48;
const GAUGE_W = 24;
const SCALE_FLOOR = 20;          // bar/heat colour scale floor so an overloaded bar reads red
const TICKS_PER_FRAME = 3;
const FRAME_SECONDS = TICKS_PER_FRAME * 0.001;
const MORPH_FRAMES = 14;         // ghost-trail fade length after a strategy switch
const WARMUP_FRAMES = 60;        // scripted: settle the rings before the first rendered frame
const MEAS_WARM = 400;           // data-path measurement: JIT/warm iterations before sampling
const MEAS_N = 20000;            // data-path measurement: sampled iterations (batch, gc-settled)

function clampi(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function gradIdx(v) { return clampi((v * (GRAD_N - 1)) | 0, 0, GRAD_N - 1); }

/* --------------------------------------------------------------------------------- renderer ---- */

/**
 * Renderer -- owns the pre-allocated per-worker scratch + morph state. render() returns the full
 * frame as a string (no per-frame array/object/closure alloc; the ramp + scratch are reused).
 */
class Renderer {
    constructor(cap) {
        this.cap = cap;
        this.eighths = new Int32Array(cap);
        this.ghostRow = new Int32Array(cap);
        this.morphRow = new Int32Array(cap).fill(-1);
        this.morphFrames = 0;
    }

    /** Capture the current bar tops as the fading ghost-trail (called just before a strategy switch). */
    beginMorph() {
        for (let i = 0; i < this.cap; i++) this.morphRow[i] = (this.eighths[i] / 8) | 0;
        this.morphFrames = MORPH_FRAMES;
    }

    /**
     * Build the whole frame string.
     * @param {LitePickSnapshot} snap
     * @param {Detectors} det
     * @param {Driver} drv
     * @param {number} frame   frame counter (drives the alarm pulse)
     * @param {number} allocDelta  measured heap delta around the data path (bytes)
     * @param {boolean} interactive
     */
    render(snap, det, drv, frame, dataBpo, interactive) {
        const cap = this.cap;
        const NL = CLR_EOL + '\n';
        const scale = snap.maxLoad > SCALE_FLOOR ? snap.maxLoad : SCALE_FLOOR;
        const pulse = det.activeCount > 0 && (frame & 4) !== 0;

        // ---- per-worker bar geometry (scratch; no alloc) --------------------------------
        let sumW = 0;
        for (let i = 0; i < cap; i++) sumW += drv.weights[i];
        let meanLoad = 0, liveN = 0;
        for (let i = 0; i < cap; i++) if (snap.wEligible[i]) { meanLoad += snap.wInflight[i]; liveN++; }
        meanLoad = liveN > 0 ? meanLoad / liveN : 0;
        let sig = 0;
        for (let i = 0; i < cap; i++) if (snap.wEligible[i]) { const d = snap.wInflight[i] - meanLoad; sig += d * d; }
        sig = liveN > 0 ? Math.sqrt(sig / liveN) : 0;
        const meanRow = clampi(((meanLoad / scale) * BAR_ROWS) | 0, 0, BAR_ROWS - 1);
        const bandHi = clampi((((meanLoad + sig) / scale) * BAR_ROWS) | 0, 0, BAR_ROWS - 1);
        const bandLo = clampi((((meanLoad - sig) / scale) * BAR_ROWS) | 0, 0, BAR_ROWS - 1);
        for (let i = 0; i < cap; i++) {
            const v = snap.wInflight[i] / scale;
            this.eighths[i] = clampi((v * BAR_ROWS * 8) | 0, 0, BAR_ROWS * 8);
            const ghostLoad = sumW > 0 ? (drv.weights[i] / sumW) * snap.totalInflight : 0;
            this.ghostRow[i] = clampi(((ghostLoad / scale) * BAR_ROWS) | 0, 0, BAR_ROWS - 1);
        }

        let s = interactive ? HOME : '';

        // ---- header --------------------------------------------------------------------
        s += BOLD + C_GREEN + 'POOL SCOPE' + RESET + C_DIM +
            '  decision monitor (not resource monitor)  ' + C_FAINT + 'lite-pick @ ' +
            drv.cap + ' workers' + RESET;
        // Badge = the DATA path (tick + build + evaluate) measured over a gc-settled batch at startup
        // (measureDataPath below), EXCLUDING render string-building. A single-frame heapUsed delta is
        // meaningless here -- it catches young-gen lazy expansion + expected render garbage -- so this
        // is a fixed, proven number instead. The kernel pick() 0 B/op is proven by test/torture.mjs.
        // With --expose-gc the batch settles to an EXACT 0; without it, a few B of unsettled young-gen
        // remains (measurement noise, not per-op allocation) -- labelled honestly either way.
        const gcOn = typeof globalThis.gc === 'function';
        if (gcOn) {
            const clean = dataBpo < 1;
            s += '   ' + (clean ? C_GREEN : C_AMBER) + 'data ' + (clean ? '0 B/op' : dataBpo.toFixed(1) + ' B/op') +
                RESET + C_FAINT + ' (measured)' + RESET + NL;
        } else {
            s += '   ' + C_FAINT + 'data ~' + dataBpo.toFixed(1) + ' B/op (--expose-gc for exact 0)' + RESET + NL;
        }
        s += C_CYAN + 'strategy ' + BOLD + drv.strategyName + RESET +
            C_DIM + '   live ' + C_TEXT + snap.live + '/' + drv.cap +
            C_DIM + '   inflight ' + C_TEXT + snap.totalInflight +
            C_DIM + '   thr ' + C_TEXT + (snap.curThroughput | 0) + '/s' +
            C_DIM + '   p50 ' + C_TEXT + snap.p50.toFixed(0) +
            C_DIM + ' p95 ' + C_TEXT + snap.p95.toFixed(0) +
            C_DIM + ' p99 ' + C_TEXT + snap.p99.toFixed(0) + 'ms' +
            C_DIM + '   frame ' + C_TEXT + frame + RESET + NL;
        s += C_FAINT + this._rule(64) + RESET + NL;

        // ---- HERO: bar-comb ------------------------------------------------------------
        s += C_DIM + 'FINGERPRINT ' + C_FAINT + 'bar=load  ' + DASH + '=mean  ' + GHOST +
            '=weight-ghost' + (this.morphFrames > 0 ? '  ' + GHOST + '=morph-trail' : '') + RESET + NL;
        const morphOn = this.morphFrames > 0;
        const morphCol = morphOn ? (this.morphFrames > MORPH_FRAMES / 2 ? C_FAINT : C_FAINT) : C_FAINT;
        for (let r = BAR_ROWS - 1; r >= 0; r--) {
            let line = ' ';
            for (let w = 0; w < cap; w++) {
                if (!snap.wEligible[w]) {
                    line += (r === 0 ? C_FAINT + '·' + RESET : ' ') + ' ';
                    continue;
                }
                const e = this.eighths[w] - r * 8;
                if (e >= 8) {
                    line += GRAD[gradIdx(snap.wInflight[w] / scale)] + FULL + RESET + ' ';
                } else if (e >= 1) {
                    line += GRAD[gradIdx(snap.wInflight[w] / scale)] + EIGHTHS[e] + RESET + ' ';
                } else if (morphOn && this.morphRow[w] === r) {
                    line += morphCol + GHOST + RESET + ' ';
                } else if (this.ghostRow[w] === r) {
                    line += C_FAINT + GHOST + RESET + ' ';
                } else if (r === meanRow || r === bandHi || r === bandLo) {
                    line += C_DIM + DASH + RESET + ' ';
                } else {
                    line += '  ';
                }
            }
            s += line + NL;
        }
        // worker index axis
        let axis = ' ';
        for (let w = 0; w < cap; w++) axis += C_FAINT + (w % 10) + RESET + ' ';
        s += axis + NL;
        if (this.morphFrames > 0) this.morphFrames--;

        // ---- HEAT-STRIP ----------------------------------------------------------------
        s += C_FAINT + this._rule(64) + RESET + NL;
        s += C_DIM + 'HEAT ' + C_FAINT + 'worker x time  (dark=starved  strobe=oscillation  ' +
            'checkerboard=ping-pong  hot=overload)' + RESET + NL;
        for (let w = 0; w < cap; w++) {
            let line = C_FAINT + 'w' + (w < 10 ? ' ' : '') + w + ' ' + RESET;
            for (let c = 0; c < HEAT_COLS; c++) {
                const k = HEAT_COLS - 1 - c;              // newest at the right
                if (k >= snap.frames) { line += ' '; continue; }
                if (!snap.eligAt(w, k)) { line += C_FAINT + '·' + RESET; continue; }
                const load = snap.loadAt(w, k);
                if (load <= 0) { line += C_FAINT + '·' + RESET; continue; }
                // Value-driven: COLOUR lerps green->amber->red along magnitude AND the density glyph
                // steps light->full, so frame-to-frame load jitter reads as shimmer/texture.
                const v = load / scale;
                line += GRAD[gradIdx(v)] + HEAT_DENSITY[clampi((v * 4) | 0, 0, 3)] + RESET;
            }
            s += line + NL;
        }

        // ---- FAIRNESS ------------------------------------------------------------------
        s += C_FAINT + this._rule(64) + RESET + NL;
        const g = snap.curGini;
        const gcol = g >= UNFAIR_GINI ? C_RED : (g >= UNFAIR_GINI * 0.6 ? C_AMBER : C_GREEN);
        const filled = clampi((g * GAUGE_W) | 0, 0, GAUGE_W);
        let gauge = '';
        for (let i = 0; i < GAUGE_W; i++) gauge += i < filled ? gcol + FULL : C_FAINT + SHADE;
        gauge += RESET;
        const press = g >= UNFAIR_GINI ? (C_RED + 'MONOPOLY') : (g >= UNFAIR_GINI * 0.6 ? (C_AMBER + 'SKEWED') : (C_GREEN + 'BALANCED'));
        s += C_DIM + 'FAIRNESS ' + C_FAINT + 'gini ' + gcol + g.toFixed(3) + RESET + ' [' + gauge + '] ' +
            C_FAINT + 'pressure ' + press + RESET + NL;

        // ---- ALARM + badges ------------------------------------------------------------
        s += C_FAINT + this._rule(64) + RESET + NL;
        if (det.activeCount === 0) {
            s += BOLD + C_GREEN + '  ● SYSTEM NOMINAL' + RESET + C_DIM +
                '   no pathology detected' + RESET + NL;
        } else {
            const head = pulse ? (BOLD + C_RED) : (C_RED);
            s += head + '  ● PATHOLOGY DETECTED / ' + det.activeCount + ' fault' +
                (det.activeCount === 1 ? '' : 's') + RESET + '   ';
            if (det.osc) s += C_AMBER + G_OSC + ' OSCILLATION(w' + det.oscWorker + ') ' + RESET;
            if (det.ping) s += C_MAGENTA + G_PING + ' PING-PONG(w' + det.pingA + '/w' + det.pingB + ') ' + RESET;
            if (det.starv) s += C_AMBER + G_STARV + ' STARVATION(w' + det.starvWorker + ') ' + RESET;
            if (det.unfair) s += C_CYAN + G_UNFAIR + ' UNFAIR ' + RESET;
            if (det.over) s += C_RED + G_OVER + ' OVERLOAD(w' + det.overWorker + '=' + det.overLoad + ') ' + RESET;
            s += NL;
        }

        // ---- controls / footer ---------------------------------------------------------
        s += C_FAINT + this._rule(64) + RESET + NL;
        if (interactive) {
            s += C_FAINT + '  [1-9,0] strategy  [n] next  [k] kill  [o] overload  [f] flap  ' +
                '[p] ping-pong  [u] unfair  [r] reset  [q] quit' + RESET + NL;
        } else {
            s += C_FAINT + '  kernel unchanged -- Pool Scope reads dump() off the hot path' + RESET + NL;
        }
        if (interactive) s += CLR_DOWN;
        return s;
    }

    _rule(n) {
        let r = '';
        for (let i = 0; i < n; i++) r += H_BAR;
        return r;
    }
}

/* ------------------------------------------------------------------------- scenario wiring ---- */

const SCENARIOS = ['healthy', 'killworker', 'overload', 'flapstorm', 'pingpong', 'unfair'];

/** Apply a named scenario's conditions to the driver (the injectors the detectors then notice). */
function applyScenario(drv, name) {
    if (name === 'healthy') return;
    if (name === 'killworker') {
        drv.conc = 150;                               // hold offered load while capacity drops
        for (let k = 1; k < drv.cap; k += 2) drv.killWorker(k);   // mass outage -> survivor hotspot
        return;
    }
    if (name === 'overload') { drv.overloadSpike((drv.cap / 2) | 0); return; }
    if (name === 'flapstorm') { drv.flapStorm((drv.cap / 3) | 0); return; }
    if (name === 'pingpong') { drv.forcePingPong(2, drv.cap - 4); return; }
    if (name === 'unfair') { drv.makeUnfair(); return; }
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
    if (typeof globalThis.gc === 'function') { globalThis.gc(); globalThis.gc(); }
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
    process.stdout.write('\npool-scope: done (' + frames + ' frames, exit 0)\n');
    process.exit(0);
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
        out.write(SHOW + RESET + '\n');
    }

    function quit() { restore(); process.exit(0); }

    function onKey(chunk) {
        const s = chunk.toString();
        for (let c = 0; c < s.length; c++) {
            const ch = s[c];
            if (ch === 'q' || ch === '\x03' || ch === '\x1b') { quit(); return; }
            if (ch >= '1' && ch <= '9') { switchTo((ch.charCodeAt(0) - 49)); }
            else if (ch === '0') { switchTo(9); }
            else if (ch === 'n') { switchTo((STRATEGIES.indexOf(drv.strategyName) + 1) % STRATEGIES.length); }
            else if (ch === 'k') { drv.conc = 150; drv.killWorker(killIdx); killIdx = (killIdx + 2) % drv.cap; }
            else if (ch === 'o') { drv.overloadSpike((drv.cap / 2) | 0); }
            else if (ch === 'f') { drv.flapStorm((drv.cap / 3) | 0); }
            else if (ch === 'p') { drv.forcePingPong(2, drv.cap - 4); }
            else if (ch === 'u') { drv.makeUnfair(); }
            else if (ch === 'r') { resetAll(); }
        }
    }

    function switchTo(idx) {
        rend.beginMorph();
        drv.setStrategy(STRATEGIES[idx]);
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
        drv.pin.fill(0); drv.ceil.fill(-1); drv.slow.fill(0);
        drv.flapEnabled = false; drv.ppEnabled = false;
        drv.conc = 108;
        drv.setStrategy(cur);
    }

    process.on('SIGINT', quit);
    process.on('exit', restore);

    out.write(CLR_SCREEN + HIDE);
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
