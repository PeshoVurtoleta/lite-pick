/**
 * pickEcosystem/live -- host calibration and throughput measurement (capstone P4).
 *
 * `calibrateUnitsPerMs` measures THIS thread's busy-loop speed by running the job's own transform, so a worker
 * does ~1 ms of real CPU per job on any machine (a phone, a CI box, the reference laptop). It is applied ONLY on
 * the real-thread paths (run.mjs, tui.mjs --real, the browser page): the virtual worker scales a job's service
 * time by `unitsPerMs` itself, so the deterministic virtual tests must keep the reference UNITS_PER_MS.
 *
 * `estimateCapacity` is the scene's ideal served rate (no overhead): each worker finishes 1000 / (jobMs x speed)
 * jobs per second. `measureThroughput` offers a fixed rate at a live kernel and reads the completed rate and the
 * shed count over a window -- the smoke probe uses it to find this host's real saturating throughput.
 */

import { jobFn, CTL_LEN, CTL_UNITS, CTL_SLOW, UNITS_PER_MS } from './job.js';
import { S_OK, S_SHED } from './stats.js';

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

/** The scene's ideal served rate (req/s), summed over the workers: each finishes 1000 / (jobMs x speed) per s. */
export function estimateCapacity(cfg) {
    const speeds = cfg.speeds, jobMs = cfg.jobMs;
    let cap = 0;
    for (let i = 0; i < speeds.length; i++) cap += 1000 / (jobMs * speeds[i]);
    return cap;
}

/**
 * Offer `rate` req/s at a live kernel, warm for `warmMs`, then read the completed rate and the shed count over
 * the next `ms`. `wait(ms)` advances the kernel's clock (virtual) or sleeps (real threads). Returns
 * `{ okPerS, shed }`. Cold: called once per probe step, not in the hot path.
 */
export async function measureThroughput(k, opts) {
    const o = opts || {};
    const wait = o.wait;
    const warmMs = o.warmMs === undefined ? 500 : o.warmMs;
    const ms = o.ms === undefined ? 1000 : o.ms;
    if (o.rate !== undefined) k.setRate(o.rate);
    await wait(warmMs);
    const ok0 = k.stats.c[S_OK];
    const shed0 = k.stats.c[S_SHED];
    await wait(ms);
    const ok = k.stats.c[S_OK] - ok0;
    const shed = k.stats.c[S_SHED] - shed0;
    return { okPerS: ok / (ms / 1000), shed };
}
