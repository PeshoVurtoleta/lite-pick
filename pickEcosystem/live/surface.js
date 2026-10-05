/**
 * pickEcosystem/live -- what the two surfaces share (the terminal UI and the browser page answer to the same
 * keys, step the rate the same way, inject faults the same way), and the browser page's device scene. DOM-free,
 * so the tests run all of it in Node.
 *
 * The terminal scene assumes the reference machine: UNITS_PER_MS busy-loop units are ~1 ms there. A visitor's
 * browser may be a phone, so the page MEASURES the job's own loop on this device before booting (~80 ms, once)
 * -- "~1 ms of real CPU per job" then holds on every machine -- and offers less traffic to a device with fewer
 * cores.
 */

import { jobFn, CTL_LEN, CTL_UNITS, CTL_SLOW, UNITS_PER_MS } from './job.js';

const CAL_STEP = 20000;          // units per timed run (~0.1 ms on the reference machine)
const CAL_WINDOWS = 4;
const CAL_MAX_RUNS = 1000;       // per phase: a frozen or broken clock still ends (~0.1 s each on the reference)

/**
 * Busy-loop units per millisecond of THIS thread, by running the job's own transform: half the budget warms
 * the loop up (V8 optimizes it in tiers; a cold measurement reads ~3-4x slow -- seen in a browser: 57k cold
 * vs ~200k warm), then the best of CAL_WINDOWS timed windows (the optimized speed a worker settles at).
 * Clamped to [UNITS_PER_MS / 20, UNITS_PER_MS x 5], and a clock that does not advance yields UNITS_PER_MS:
 * a coarse or broken clock cannot produce a scene that is absurdly heavy or empty, nor hang the page.
 */
export function calibrateUnitsPerMs(now, budgetMs) {
    const budget = budgetMs > 0 ? budgetMs : 80;
    const ctl = new Float64Array(CTL_LEN);
    ctl[CTL_UNITS] = CAL_STEP;
    ctl[CTL_SLOW] = 1;
    let t = now();
    const warmEnd = t + budget / 2;
    let w = 0;
    while (t < warmEnd && w < CAL_MAX_RUNS) { jobFn(w++ & 1023, ctl); t = now(); }
    const win = budget / 2 / CAL_WINDOWS;
    let best = 0;
    for (let k = 0; k < CAL_WINDOWS; k++) {
        let units = 0, runs = 0;
        const t0 = now();
        t = t0;
        while (t - t0 < win && runs++ < CAL_MAX_RUNS) { jobFn(units & 1023, ctl); units += CAL_STEP; t = now(); }
        const dt = t - t0;
        const per = dt > 0 ? units / dt : 0;
        if (per > best) best = per;
    }
    const lo = UNITS_PER_MS / 20, hi = UNITS_PER_MS * 5;
    return Math.round(!(best > 0) ? UNITS_PER_MS : best < lo ? lo : best > hi ? hi : best);
}

/** The scene's offered rate for a device with `cores` hardware threads (8 workers always). */
export function browserScene(cores) {
    const c = cores > 0 ? cores : 4;
    return { rate: c >= 8 ? 2000 : c >= 6 ? 1500 : 1000 };
}

/** The fault a key injects on the selected worker, or undefined. */
export const FAULT_KEYS = Object.freeze({ k: 'kill', s: 'slow', f: 'flaky', h: 'hang', c: 'crash', l: 'crashloop', x: 'heal', r: 'reset' });

/** The rate keys (+ / -). */
export function rateUp(r) { return Math.round(r * 1.25); }
export function rateDown(r) { return Math.max(100, Math.round(r / 1.25)); }

/** Apply a fault kind (FAULT_KEYS value) to worker w; `reset` returns its promise. */
export function applyFault(kernel, kind, w) {
    if (kind === 'reset') return kernel.reset(w);
    if (kind === 'heal') return kernel.heal(w);
    return kernel.fault(w, kind);
}
