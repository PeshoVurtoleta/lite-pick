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

/* ------------------------------------------------------------------ thresholds (tune here) ---- */

/** Oscillation: eligibility transitions over the window to fire; and the count that reads full red. */
export const OSC_FLAPS_WARN = 6;
export const OSC_FLAPS_CRIT = 12;

/** Ping-pong: fire when a live pair's Pearson load-correlation is at or below this (hard anti-phase) */
export const PINGPONG_CORR = -0.6;
/** ...and BOTH rows swing at least this much (std), so healthy jitter never trips it. */
export const PINGPONG_STD = 3.0;

/** Starvation: a live worker SUSTAINED under this share while the pool is busy (mean inflight > MIN) */
export const STARVE_SHARE = 0.02;
export const STARVE_BUSY_MEAN = 2.0;
/** ...and stably eligible + starved for this many recent frames (excludes flapping / bursty rows). */
export const STARVE_STABLE = 6;

/** Unfair: Gini over the live decision-share at or above this. */
export const UNFAIR_GINI = 0.40;

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
    }

    /**
     * Refresh all five detectors + the tally from the snapshot. Zero-alloc.
     * @param {import('./snapshot.mjs').LitePickSnapshot} snap
     */
    evaluate(snap) {
        const cap = this.cap;
        const win = snap.frames < 48 ? snap.frames : 48;   // match snapshot WINDOW ceiling

        // ---- oscillation: eligibility flap-count per worker over the window -----------------
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

        // ---- unfair: Gini over the live decision-share ---------------------------------------
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
