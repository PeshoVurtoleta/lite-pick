/**
 * Pool Scope -- detectors.mjs : the five pathology detectors (PS1 deliverable 2).
 *
 *     import { Detectors } from './detectors.mjs';
 *
 * INDEPENDENT of the fault injectors (design/pool-scope.md section 5): the driver's scenarios create
 * CONDITIONS; these detectors light on their own by reading the snapshot's ring / per-worker series.
 * That honesty is the whole point -- a detector never asks "which injector is active", it measures.
 *
 *   oscillation  U+223F  eligibility flap-count over the window past a threshold, amber->red by count.
 *   ping-pong    U+21C4  strongest NEGATIVE load correlation between a pair of live rows (anti-phase).
 *   starvation   U+2205  a LIVE worker with ~0 share while pool utilisation is high.
 *   unfair       U+2696  Gini over the live decision-share past a threshold.
 *   overload     U+25B2  a worker's load over saturation (its BoundedLoad cap, or a constant).
 *
 * Plus the alarm tally: activeCount == 0 -> "SYSTEM NOMINAL", else "PATHOLOGY DETECTED / N".
 *
 * THRESHOLDS ARE THE CONSTANTS BELOW -- tune them by eye against the injectors; that is the only
 * knob. evaluate() is zero-alloc (number locals + reads over the snapshot rings only).
 */

import { ADAPTIVE } from './siblings.mjs';

/* ------------------------------------------------------------------ thresholds (tune here) ---- */

/** Oscillation (INLINE fallback): eligibility transitions over the window to fire; full-red count. */
export const OSC_FLAPS_WARN = 6;
export const OSC_FLAPS_CRIT = 12;

/**
 * Oscillation (lite-adaptive ADWIN path). One ADWIN per worker consumes that worker's ELIGIBILITY
 * stream (0/1). The flap signature lives in the eligibility bit, and it is a STATIONARY oscillation:
 * ADWIN2's variance-aware cut can never split a symmetric oscillation (equal sub-window means at every
 * boundary), so a raw drift-fire count is empirically 0 -- the SIGNAL is ADWIN's windowed VARIANCE. A
 * flapping worker's eligibility variance -> 0.25 (Bernoulli), a stable worker's -> 0 (constant up OR
 * constant down: a killed worker reads 0, NOT oscillation). ADWIN earns its place via the ADAPTIVE
 * WINDOW: the eligible->flapping (and flapping->recovered) regime change DOES fire a cut, so the window
 * -- and thus the variance -- stays scoped to the RECENT eligibility, clearing fast on recovery (the
 * recency a fixed 48-frame window lacks). The score is an EMA of that windowed variance for hysteresis.
 * ADWIN_DELTA bounds the stationary false-alarm rate; WARN/CRIT are variance-score thresholds.
 */
export const ADWIN_DELTA = 0.05;
export const OSC_VAR_EMA = 0.6;   // EMA weight on the previous variance score (hysteresis)
export const OSC_DRIFT_WARN = 0.06;
export const OSC_DRIFT_CRIT = 0.15;

/** Ping-pong: fire when a live pair's Pearson load-correlation is at or below this (hard anti-phase) */
export const PINGPONG_CORR = -0.6;
/** ...and BOTH rows swing at least this much (std), so healthy jitter never trips it. */
export const PINGPONG_STD = 3.0;

/** Starvation: a live worker SUSTAINED under this share while the pool is busy (mean inflight > MIN) */
export const STARVE_SHARE = 0.02;
export const STARVE_BUSY_MEAN = 2.0;
/** ...and stably eligible + starved for this many recent frames (excludes flapping / bursty rows). */
export const STARVE_STABLE = 6;

/**
 * Unfair: WEIGHT-AWARE Gini at or above this (design section 5 -- unfair = load NOT proportional to
 * weight, not raw spread). snap.curGini is the Gini over each live worker's share/weight ratio, so a
 * weight-PROPORTIONAL distribution reads ~0 (FAIR) even under a skewed weight set. Tuned to sit ABOVE
 * every healthy strategy under the default mild skew (the weight-blind policies read ~0.24-0.33 -- an
 * honest "they ignore weights" read, not a fault) and BELOW the genuine disproportions: makeUnfair's
 * wide ramp on a weight-blind policy (~0.44-0.52) and the keyed ConsistentHash hotspot (~0.42).
 */
export const UNFAIR_GINI = 0.38;

/** Overload: a worker's inflight over this saturation, SUSTAINED (a transient random spike is not it) */
export const OVERLOAD_SAT = 18;
export const OVERLOAD_STABLE = 4;

/**
 * Detectors -- pre-allocated result holder. evaluate(snapshot) refreshes the flags/severities in
 * place; nothing is allocated per call. Read the public fields after evaluate() to render badges.
 */
export class Detectors {
    constructor(cap) {
        this.cap = cap;
        this.osc = false; this.oscWorker = -1; this.oscFlaps = 0; this.oscSev = 0;   // 0..1 amplitude
        this.ping = false; this.pingA = -1; this.pingB = -1; this.pingCorr = 0;
        this.starv = false; this.starvWorker = -1;
        this.unfair = false; this.unfairGini = 0;
        this.over = false; this.overWorker = -1; this.overLoad = 0;
        this.activeCount = 0;

        // Sibling-backed oscillation: one ADWIN per worker + a per-worker decayed drift-fire score.
        // Absent -> _adwin stays null and evaluate() uses the inline eligibility flap-count. hasAdwin is
        // the on-screen detector backing.
        this.hasAdwin = !!ADAPTIVE;
        this._adwin = null;
        this._driftScore = null;
        if (ADAPTIVE) {
            this._adwin = new Array(cap);
            for (let i = 0; i < cap; i++) this._adwin[i] = new ADAPTIVE.ADWIN(ADWIN_DELTA);
            this._driftScore = new Float64Array(cap);
        }
    }

    /** Reset the sibling detector state (called on a strategy morph so a switch does not blip drift). */
    reset() {
        if (this._adwin) {
            for (let i = 0; i < this.cap; i++) this._adwin[i].clear();
            this._driftScore.fill(0);
        }
    }

    /**
     * Refresh all five detectors + the tally from the snapshot. Zero-alloc.
     * @param {import('./snapshot.mjs').LitePickSnapshot} snap
     */
    evaluate(snap) {
        const cap = this.cap;
        const win = snap.frames < 48 ? snap.frames : 48;   // match snapshot WINDOW ceiling

        // ---- oscillation --------------------------------------------------------------------
        if (this._adwin) {
            // lite-adaptive ADWIN: feed each worker's eligibility (0/1 SMI, add is 0 B/op). The windowed
            // variance is the flap signal (0.25 flapping, 0 stable); the adaptive window keeps it recent.
            // An EMA over frames adds hysteresis. The worst score names the oscillating worker. Blind to
            // the injector -- it measures the eligibility stream, never asks whether flapStorm is active.
            let oscW = -1, best = 0;
            for (let w = 0; w < cap; w++) {
                this._adwin[w].add(snap.wEligible[w]);
                const v = this._adwin[w].variance;
                const sc = this._driftScore[w] * OSC_VAR_EMA + v * (1 - OSC_VAR_EMA);
                this._driftScore[w] = sc;
                if (sc > best) { best = sc; oscW = w; }
            }
            this.oscFlaps = best;          // repurposed: the worst EMA'd eligibility-variance score
            this.oscWorker = oscW;
            this.osc = best >= OSC_DRIFT_WARN;
            this.oscSev = best >= OSC_DRIFT_CRIT ? 1 :
                (best <= OSC_DRIFT_WARN ? 0 : (best - OSC_DRIFT_WARN) / (OSC_DRIFT_CRIT - OSC_DRIFT_WARN));
        } else {
            // Inline fallback: eligibility flap-count per worker over the window.
            let oscW = -1, oscFlaps = 0;
            for (let w = 0; w < cap; w++) {
                let flaps = 0, prev = snap.eligAt(w, 0);
                for (let k = 1; k < win; k++) {
                    const e = snap.eligAt(w, k);
                    if (e !== prev) flaps++;
                    prev = e;
                }
                if (flaps > oscFlaps) { oscFlaps = flaps; oscW = w; }
            }
            this.oscFlaps = oscFlaps;
            this.oscWorker = oscW;
            this.osc = oscFlaps >= OSC_FLAPS_WARN;
            this.oscSev = oscFlaps >= OSC_FLAPS_CRIT ? 1 :
                (oscFlaps <= OSC_FLAPS_WARN ? 0 : (oscFlaps - OSC_FLAPS_WARN) / (OSC_FLAPS_CRIT - OSC_FLAPS_WARN));
        }

        // ---- ping-pong: the most-negative live pair correlation (both rows swinging) ----------
        let bestCorr = 1, pa = -1, pb = -1;
        for (let a = 0; a < cap; a++) {
            if (!snap.wEligible[a] || snap.sdLoad[a] < PINGPONG_STD) continue;
            const ma = snap.mLoad[a], sda = snap.sdLoad[a];
            for (let b = a + 1; b < cap; b++) {
                if (!snap.wEligible[b] || snap.sdLoad[b] < PINGPONG_STD) continue;
                const mb = snap.mLoad[b], sdb = snap.sdLoad[b];
                let cov = 0;
                for (let k = 0; k < win; k++) {
                    cov += (snap.loadAt(a, k) - ma) * (snap.loadAt(b, k) - mb);
                }
                const corr = cov / (win * sda * sdb);
                if (corr < bestCorr) { bestCorr = corr; pa = a; pb = b; }
            }
        }
        this.pingCorr = pa >= 0 ? bestCorr : 0;
        this.pingA = pa; this.pingB = pb;
        this.ping = pa >= 0 && bestCorr <= PINGPONG_CORR;

        // ---- starvation: a live worker SUSTAINED at ~0 share while the pool is busy -----------
        // Sustained + stably-eligible over STARVE_STABLE frames, so a flapping row (down part of the
        // time) and a merely-bursty row (occasional real traffic) are BOTH excluded -- only a worker
        // that is up throughout yet consistently ignored counts. Honest and injector-agnostic.
        const busy = snap.live > 0 && (snap.totalInflight / snap.live) >= STARVE_BUSY_MEAN;
        const look = win < STARVE_STABLE ? win : STARVE_STABLE;
        let starvW = -1;
        if (busy && look >= STARVE_STABLE) {
            for (let w = 0; w < cap; w++) {
                if (!snap.wEligible[w]) continue;
                let starved = true;
                for (let k = 0; k < look; k++) {
                    if (!snap.eligAt(w, k) || snap.shareAt(w, k) >= STARVE_SHARE) { starved = false; break; }
                }
                if (starved) { starvW = w; break; }
            }
        }
        this.starvWorker = starvW;
        this.starv = starvW >= 0;

        // ---- unfair: WEIGHT-AWARE Gini (share/weight ratio spread; snap.curGini) --------------
        this.unfairGini = snap.curGini;
        this.unfair = snap.curGini >= UNFAIR_GINI;

        // ---- overload: a worker SUSTAINED over saturation ------------------------------------
        // Saturation is the constant floor, raised (never lowered) by a known BoundedLoad cap (the
        // CHBL cap is a SOFT ~1.25x-mean preference, must not fire on its own). Sustained over
        // OVERLOAD_STABLE frames, so a random strategy's transient one-frame spike does not trip it.
        const oLook = win < OVERLOAD_STABLE ? win : OVERLOAD_STABLE;
        let overW = -1, overLoad = 0;
        for (let w = 0; w < cap; w++) {
            const cap2 = snap.wCap[w];                      // NaN when no BoundedLoad cap
            const sat = (cap2 === cap2 && cap2 > OVERLOAD_SAT) ? cap2 : OVERLOAD_SAT;
            let hot = oLook >= OVERLOAD_STABLE;
            for (let k = 0; k < oLook && hot; k++) if (snap.loadAt(w, k) <= sat) hot = false;
            if (hot && snap.wInflight[w] > overLoad) { overLoad = snap.wInflight[w]; overW = w; }
        }
        this.overWorker = overW;
        this.overLoad = overLoad;
        this.over = overW >= 0;

        // ---- tally ---------------------------------------------------------------------------
        this.activeCount = (this.osc ? 1 : 0) + (this.ping ? 1 : 0) + (this.starv ? 1 : 0) +
            (this.unfair ? 1 : 0) + (this.over ? 1 : 0);
    }
}
