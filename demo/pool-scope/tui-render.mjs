/**
 * Pool Scope -- tui-render.mjs : the terminal RENDERER, shared by the simulated TUI (tui.mjs) and the capstone's
 * live TUI (pickEcosystem/live/tui.mjs). Split out of tui.mjs unchanged (capstone P2); the scripted frames of
 * the simulated TUI are byte-identical before and after.
 *
 * A driver feeds it through LitePickSnapshot + Detectors; the renderer itself reads only: `cap`, `weights`,
 * `strategyName`, `hasLatSketch`, `keyed`, `hotKeys(out)`, `keyMass()`, `keyFreq`, `keyWorker` -- and two
 * OPTIONAL hooks a live driver may define: `extraPanel(rule)` (a string of extra lines, painted above the
 * footer) and `controlsHelp` (the interactive footer text). The simulated driver defines neither.
 */

import {UNFAIR_GINI} from './detectors.mjs';
import {LATENCY_BACKING, DETECTOR_BACKING, HOTKEY_BACKING} from './siblings.mjs';

/* ------------------------------------------------------------------- ANSI + glyph constants ---- */

export const ESC = '\x1b[';
export const RESET = ESC + '0m';
export const BOLD = ESC + '1m';
export const HIDE = ESC + '?25l';
export const SHOW = ESC + '?25h';
export const ALT_ON = ESC + '?1049h';   // enter the alternate screen buffer (the user's scrollback is untouched)
export const ALT_OFF = ESC + '?1049l';  // leave it -> restores the terminal exactly as it was before launch
export const HOME = ESC + 'H';
export const CLR_EOL = ESC + '0K';
export const CLR_DOWN = ESC + '0J';
export const CLR_SCREEN = ESC + '2J';

export function fg(r, g, b) {
    return ESC + '38;2;' + r + ';' + g + ';' + b + 'm';
}

export const C_GREEN = fg(0x5f, 0xe3, 0x9f);
export const C_CYAN = fg(0x7d, 0xd3, 0xfc);
export const C_AMBER = fg(0xf5, 0xb9, 0x42);
export const C_MAGENTA = fg(0xe8, 0x79, 0xa8);
export const C_RED = fg(0xf8, 0x71, 0x71);
// Readability-first ramp (btop model: keep ALL text bright, do hierarchy with COLOR + BOLD, not dimming).
// btop's main_fg is #c5c8c6 (~197); earlier grey-dimming (faint 0x55/0x83, dim 0x8b/0xa6) sat too low-contrast
// on the dark bg. These tiers are all comfortably readable; faint is merely the least-bright, not "dim".
export const C_TEXT = fg(0xea, 0xe8, 0xe4);  // primary values -- near white
export const C_DIM = fg(0xc6, 0xc9, 0xd0);   // labels -- btop main_fg brightness, clearly readable
export const C_FAINT = fg(0x9c, 0xa2, 0xae); // structural/decoration (axis, rules, empty cells) -- still clearly legible

// Sibling-backing indicator colours (computed once): green when a witnessed peer is live, amber on the
// inline (fallback) path. The header prints which backing is live so the lego-thesis wiring is visible.
export const DET_COL = DETECTOR_BACKING === 'lite-adaptive' ? C_GREEN : C_AMBER;
export const LAT_COL = LATENCY_BACKING === 'lite-sketch' ? C_GREEN : C_AMBER;
export const HK_COL = HOTKEY_BACKING === 'lite-adaptive' ? C_GREEN : C_AMBER;

// Value-driven gradient: green -> amber -> red. Precomputed once (no per-cell alloc).
export const GRAD_N = 24;
export const GRAD = new Array(GRAD_N);
(function buildGrad() {
    const g0 = [0x5f, 0xe3, 0x9f], g1 = [0xf5, 0xb9, 0x42], g2 = [0xf8, 0x71, 0x71];
    for (let i = 0; i < GRAD_N; i++) {
        const t = i / (GRAD_N - 1);
        let a, b, u;
        if (t < 0.5) {
            a = g0;
            b = g1;
            u = t * 2;
        } else {
            a = g1;
            b = g2;
            u = (t - 0.5) * 2;
        }
        GRAD[i] = fg(
            (a[0] + (b[0] - a[0]) * u) | 0,
            (a[1] + (b[1] - a[1]) * u) | 0,
            (a[2] + (b[2] - a[2]) * u) | 0);
    }
})();

export const EIGHTHS = [' ', '\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];
export const FULL = '\u2588';
export const SHADE = '\u2591';          // light shade (gauge track)
// Heat-strip DENSITY tiers (notcurses idiom): light-shade -> full block, so per-cell load reads as
// texture AND colour, not one uniform slab of solid blocks. Indexed by load magnitude.
export const HEAT_DENSITY = ['\u2591', '\u2592', '\u2593', '\u2588'];
export const DASH = '\u2504';           // dashed horizontal (mean line)
export const GHOST = '\u2508';          // dotted vertical (weight ghost / morph trail)
export const H_BAR = '\u2500';          // box horizontal (chrome rule)

// Pathology badge glyphs (design brief section 5).
export const G_OSC = '\u223f';          // tilde wave
export const G_PING = '\u21c4';         // anti-phase arrows
export const G_STARV = '\u2205';        // empty set
export const G_UNFAIR = '\u2696';       // scales
export const G_OVER = '\u25b2';         // triangle

export const BAR_ROWS = 8;
export const HEAT_COLS = 48;
export const GAUGE_W = 24;
export const SCALE_FLOOR = 20;          // heat colour scale floor so an overloaded cell reads red
// FINGERPRINT vertical scale. The hero's job is to make each policy's SHAPE read, not to show absolute
// load -- absolute inflight saturates every bar near the panel top, crushing the characteristic shapes
// into 1-2 rows of jitter. So the comb is scaled to a small MULTIPLE OF THE LIVE MEAN: the mean line
// lands low-mid (~1/FP_MEAN_MULT of the panel), a tight band sits around it, a weighted staircase steps
// across it, and an overload spikes clean to the top. Sub-cell eighth-blocks keep within-band deltas
// visible. Colour tracks the same normalised height (green low -> amber mean -> red overshoot).
export const FP_MEAN_MULT = 2.3;        // fingerprint full-scale = live-mean load x this (mean sits ~43% up)
export const FP_SCALE_FLOOR = 4;        // fingerprint scale floor (avoid a divide-by-tiny on an idle pool)
export const TICKS_PER_FRAME = 3;
export const FRAME_SECONDS = TICKS_PER_FRAME * 0.001;
export const MORPH_FRAMES = 14;         // ghost-trail fade length after a strategy switch
export const WARMUP_FRAMES = 60;        // scripted: settle the rings before the first rendered frame
export const MEAS_WARM = 400;           // data-path measurement: JIT/warm iterations before sampling
export const MEAS_N = 20000;            // data-path measurement: sampled iterations (batch, gc-settled)

export function clampi(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

export function gradIdx(v) {
    return clampi((v * (GRAD_N - 1)) | 0, 0, GRAD_N - 1);
}

/* --------------------------------------------------------------------------------- renderer ---- */

/**
 * Renderer -- owns the pre-allocated per-worker scratch + morph state. render() returns the full
 * frame as a string (no per-frame array/object/closure alloc; the ramp + scratch are reused).
 */
export class Renderer {
    constructor(cap) {
        this.cap = cap;
        this.eighths = new Int32Array(cap);
        this.ghostRow = new Int32Array(cap);
        this.morphRow = new Int32Array(cap).fill(-1);
        this.morphFrames = 0;
        this.hotKeyBuf = new Int32Array(5);   // top-5 hot-key scratch (keyed strategies only)
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
        const scale = snap.maxLoad > SCALE_FLOOR ? snap.maxLoad : SCALE_FLOOR;   // HEAT-strip colour scale
        const pulse = det.activeCount > 0 && (frame & 4) !== 0;

        // ---- per-worker bar geometry (scratch; no alloc) --------------------------------
        // Live weight sum + mean/std of the live inflight, then a MEAN-RELATIVE fingerprint scale so the
        // shape reads instead of saturating (see FP_MEAN_MULT). fpScale maps the mean to ~1/FP_MEAN_MULT
        // of the panel; deviations from the mean -- the whole signal -- fill the rest with headroom above.
        let sumW = 0;
        for (let i = 0; i < cap; i++) if (snap.wEligible[i]) sumW += drv.weights[i];
        let meanLoad = 0, liveN = 0;
        for (let i = 0; i < cap; i++) if (snap.wEligible[i]) {
            meanLoad += snap.wInflight[i];
            liveN++;
        }
        meanLoad = liveN > 0 ? meanLoad / liveN : 0;
        let sig = 0;
        for (let i = 0; i < cap; i++) if (snap.wEligible[i]) {
            const d = snap.wInflight[i] - meanLoad;
            sig += d * d;
        }
        sig = liveN > 0 ? Math.sqrt(sig / liveN) : 0;
        let fpScale = meanLoad * FP_MEAN_MULT;
        if (fpScale < FP_SCALE_FLOOR) fpScale = FP_SCALE_FLOOR;
        const meanRow = clampi(((meanLoad / fpScale) * BAR_ROWS) | 0, 0, BAR_ROWS - 1);
        const bandHi = clampi((((meanLoad + sig) / fpScale) * BAR_ROWS) | 0, 0, BAR_ROWS - 1);
        const bandLo = clampi((((meanLoad - sig) / fpScale) * BAR_ROWS) | 0, 0, BAR_ROWS - 1);
        for (let i = 0; i < cap; i++) {
            const v = snap.wInflight[i] / fpScale;
            this.eighths[i] = clampi((v * BAR_ROWS * 8) | 0, 0, BAR_ROWS * 8);
            // Weight-GHOST: where a weight-PROPORTIONAL load would sit (target share x live inflight),
            // on the SAME mean-relative scale -- so a weighted staircase's bars land ON their ghost and a
            // weight-blind flat comb visibly does NOT match the skewed ghost (the honest actual-vs-weight).
            const ghostLoad = sumW > 0 ? (drv.weights[i] / sumW) * (meanLoad * liveN) : 0;
            this.ghostRow[i] = clampi(((ghostLoad / fpScale) * BAR_ROWS) | 0, 0, BAR_ROWS - 1);
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
            (drv.hasLatSketch ? C_FAINT + ' (+-1%)' : '') +
            C_DIM + '   frame ' + C_TEXT + frame + RESET + NL;
        // Sibling-backing indicator: which witnessed peer (or the inline fallback) backs each layer.
        s += C_FAINT + 'backing  ' + C_DIM + 'detectors ' + DET_COL + DETECTOR_BACKING + C_FAINT +
            ' \u00b7 ' + C_DIM + 'latency ' + LAT_COL + LATENCY_BACKING + C_FAINT +
            ' \u00b7 ' + C_DIM + 'hot-keys ' + HK_COL + HOTKEY_BACKING + RESET + NL;
        s += C_FAINT + this._rule(64) + RESET + NL;

        // ---- HERO: bar-comb ------------------------------------------------------------
        s += BOLD + C_DIM + 'FINGERPRINT ' + RESET + C_FAINT + 'bar=load  ' + DASH + '=mean  ' + GHOST +
            '=weight-ghost' + (this.morphFrames > 0 ? '  ' + GHOST + '=morph-trail' : '') + RESET + NL;
        const morphOn = this.morphFrames > 0;
        const morphCol = morphOn ? (this.morphFrames > MORPH_FRAMES / 2 ? C_FAINT : C_FAINT) : C_FAINT;
        for (let r = BAR_ROWS - 1; r >= 0; r--) {
            let line = ' ';
            for (let w = 0; w < cap; w++) {
                if (!snap.wEligible[w]) {
                    line += (r === 0 ? C_FAINT + '\u00b7' + RESET : ' ') + ' ';
                    continue;
                }
                const e = this.eighths[w] - r * 8;
                if (e >= 8) {
                    line += GRAD[gradIdx(snap.wInflight[w] / fpScale)] + FULL + RESET + ' ';
                } else if (e >= 1) {
                    line += GRAD[gradIdx(snap.wInflight[w] / fpScale)] + EIGHTHS[e] + RESET + ' ';
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
        s += BOLD + C_DIM + 'HEAT ' + RESET + C_FAINT + 'worker x time  (dark=starved  strobe=oscillation  ' +
            'checkerboard=ping-pong  hot=overload)' + RESET + NL;
        for (let w = 0; w < cap; w++) {
            let line = C_FAINT + 'w' + (w < 10 ? ' ' : '') + w + ' ' + RESET;
            for (let c = 0; c < HEAT_COLS; c++) {
                const k = HEAT_COLS - 1 - c;              // newest at the right
                if (k >= snap.frames) {
                    line += ' ';
                    continue;
                }
                if (!snap.eligAt(w, k)) {
                    line += C_FAINT + '\u00b7' + RESET;
                    continue;
                }
                const load = snap.loadAt(w, k);
                if (load <= 0) {
                    line += C_FAINT + '\u00b7' + RESET;
                    continue;
                }
                // Value-driven: COLOUR lerps green->amber->red along magnitude AND the density glyph
                // steps light->full, so frame-to-frame load jitter reads as shimmer/texture.
                const v = load / scale;
                line += GRAD[gradIdx(v)] + HEAT_DENSITY[clampi((v * 4) | 0, 0, 3)] + RESET;
            }
            s += line + NL;
        }

        // ---- HOT KEYS (keyed strategies only) ------------------------------------------
        // The payoff visual for the keyed roster (#8 ConsistentHash, #9 BoundedLoad): the top keys by
        // RECENT share and the worker each maps to. Under the `hotkeys` (zipfian) scenario a few keys
        // dominate -- ConsistentHash piles them on one backend (a hotspot: UNFAIR + OVERLOAD), while
        // BoundedLoad caps the hot backend and OVERFLOWS to neighbours (fairer). Backed by HeavyKeeper
        // (decayed top-k = "hot right now") when lite-adaptive is present, else the inline decayed freq.
        if (drv.keyed) {
            s += C_FAINT + this._rule(64) + RESET + NL;
            s += BOLD + C_DIM + 'HOT KEYS ' + RESET + C_FAINT + '(' + HOTKEY_BACKING + ')  top keys by recent share ' +
                DASH + '> mapped worker' + RESET + NL;
            const n = drv.hotKeys(this.hotKeyBuf);
            const mass = drv.keyMass();
            if (n === 0 || mass <= 0) {
                s += C_FAINT + '  (warming up)' + RESET + NL;
            } else {
                for (let e = 0; e < n; e++) {
                    const key = this.hotKeyBuf[e];
                    const share = mass > 0 ? drv.keyFreq[key] / mass : 0;
                    const w = drv.keyWorker[key];
                    const barW = clampi((share * GAUGE_W) | 0, 0, GAUGE_W);
                    let bar = '';
                    for (let i = 0; i < GAUGE_W; i++) bar += i < barW ? (GRAD[gradIdx(share * 3)] + FULL) : (C_FAINT + SHADE);
                    bar += RESET;
                    s += '  ' + C_CYAN + 'key ' + C_TEXT + ('' + key).padStart(4) + RESET + ' [' + bar + '] ' +
                        C_TEXT + (share * 100).toFixed(1) + '%' + C_DIM + ' ' + DASH + '> ' +
                        C_FAINT + 'w' + (w >= 0 ? w : '?') + RESET + NL;
                }
            }
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
        s += BOLD + C_DIM + 'FAIRNESS ' + RESET + C_FAINT + 'gini ' + gcol + g.toFixed(3) + RESET + ' [' + gauge + '] ' +
            C_FAINT + 'pressure ' + press + RESET + NL;

        // ---- ALARM + badges ------------------------------------------------------------
        s += C_FAINT + this._rule(64) + RESET + NL;
        if (det.activeCount === 0) {
            s += BOLD + C_GREEN + '  \u25cf SYSTEM NOMINAL' + RESET + C_DIM +
                '   no pathology detected' + RESET + NL;
        } else {
            const head = pulse ? (BOLD + C_RED) : (C_RED);
            s += head + '  \u25cf PATHOLOGY DETECTED / ' + det.activeCount + ' fault' +
                (det.activeCount === 1 ? '' : 's') + RESET + '   ';
            if (det.osc) s += C_AMBER + G_OSC + ' OSCILLATION(w' + det.oscWorker + ') ' + RESET;
            if (det.ping) s += C_MAGENTA + G_PING + ' PING-PONG(w' + det.pingA + '/w' + det.pingB + ') ' + RESET;
            if (det.starv) s += C_AMBER + G_STARV + ' STARVATION(w' + det.starvWorker + ') ' + RESET;
            if (det.unfair) s += C_CYAN + G_UNFAIR + ' UNFAIR ' + RESET;
            if (det.over) s += C_RED + G_OVER + ' OVERLOAD(w' + det.overWorker + '=' + det.overLoad + ') ' + RESET;
            s += NL;
        }

        // ---- optional driver panel (the live system's fleet + decision stream) ----------------
        if (typeof drv.extraPanel === 'function') s += drv.extraPanel(C_FAINT + this._rule(64) + RESET, NL);

        // ---- controls / footer ---------------------------------------------------------
        s += C_FAINT + this._rule(64) + RESET + NL;
        if (interactive && typeof drv.controlsHelp === 'string') {
            s += C_FAINT + drv.controlsHelp + RESET + NL;
        } else if (interactive) {
            s += C_FAINT + '  [1-9,0] strategy  [n] next  [k] kill  [o] overload  [f] flap  ' +
                '[p] ping-pong  [u] unfair  [s] starve  [r] reset  [q] quit' + RESET + NL;
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

