/**
 * @zakkster/lite-pick -- the PURE helpers of the Pool.run cost gate (test/perf/PoolCost.test.mjs).
 *
 * Not a suite: no node:test, no lanes, no GC flags. PoolCost.test.mjs imports these to decide its L9
 * gate, and test/PoolCostGate.test.js imports the SAME functions to prove each fail-closed path throws
 * (fake lane results, no real lanes). Every helper input -- the child flags, N, the spawnSync result -- is a
 * parameter, never a module global, so a test can inject a fake. CHILD_FLAGS and N below are the single
 * source of the real values; the callers pass them in.
 */

import assert from 'node:assert/strict';

// runLane (PoolCost.test.mjs) spawns every lane child with exactly these V8 flags and this run count.
export const CHILD_FLAGS = ['--expose-gc', '--min-semi-space-size=1', '--max-semi-space-size=1'];
export const N = 200000;

/**
 * ONE scavenge quantum in B/run, derived from runLane's own measurement configuration -- never typed in.
 * pool-cost-lanes.mjs counts minor GCs over a window of N runs and one of 8N runs (its main(): lo = N,
 * hi = 8 * N) under the young generation pinned by CHILD_FLAGS, and converts the count difference as
 *     B/run = (S_8N - S_N) x semiBytes / ((8 - 1) x N)
 * so one scavenge more or less moves B/run by semiBytes / (7 N) (~0.75 B/run at 1 MiB, N = 200000).
 * `checkQuantum` proves this is the lane's real conversion: each lane's reported bytesPerRun must equal
 * its own scavenge counts times Q (rounded to 0.1 as the lane rounds); if the lane formula, the windows
 * or the pin ever change, that check fails closed instead of the quantum silently going stale.
 */
export const LANE_WIN_LO = 1;   // countWindow(drive, lane, N, ...)      -- pool-cost-lanes.mjs main()
export const LANE_WIN_HI = 8;   // countWindow(drive, lane, 8 * N, ...)  -- pool-cost-lanes.mjs main()
// The ONE L9 tolerance, in scavenges (Q each): exactly one quantum (ADR 0007, +/-1 scavenge). Three checks
// hold it, none of them by itself: (a) the gate and the fresh-message control share l9Within, which proves
// the gate trips on the mutant (that mutant clears the bound by ~185-200 scavenges, so it alone does NOT bound
// the tolerance); (b) PL_BOX (L3 + one boxed double per run: measured 23 scavenges above L3 on v22.23.3, the
// pinned CI perf job, and 61 on v26.8.2) must ALSO fall outside
// l9Within, so any tolerance wide enough to hide one boxed double fails; (c) the literal is pinned to 1 in the
// L9 test, which catches every other change. NEVER raise it to pass.
export const L9_TOL = 1;
export function l9Within(d9, d3) { return d9 <= d3 + L9_TOL; }
// `flags` = the child's V8 flags (CHILD_FLAGS above). Only the `--flag=value` form is read; any
// other form leaves the value NaN, which fails closed below.
export function childSemiBytes(flags) {
    let max = NaN, min = NaN;
    for (const f of flags) {
        if (f.startsWith('--max-semi-space-size=')) max = Number(f.slice('--max-semi-space-size='.length));
        if (f.startsWith('--min-semi-space-size=')) min = Number(f.slice('--min-semi-space-size='.length));
    }
    assert.ok(max > 0 && min === max, 'CHILD_FLAGS must pin min == max semi-space (got min ' + min + ', max ' + max +
        ') -- without both, one scavenge is not a fixed number of bytes and the quantum is undefined');
    return max * 1048576;
}
// `N` = the run count runLane passes to every lane (N above).
export function quantumOf(d, N, flags) {
    assert.equal(d.N, N, 'lane ' + d.lane + ' measured N = ' + d.N + ', expected ' + N);
    return childSemiBytes(flags) / ((LANE_WIN_HI - LANE_WIN_LO) * d.N);
}
export function checkQuantum(d, q, N, flags) {
    assert.equal(quantumOf(d, N, flags), q, 'lane ' + d.lane + ' does not share the measurement configuration of Q');
    // null / missing / NaN / fractional / string counts must not reach the arithmetic below: null coerces to 0
    // and a string to its number, so a coerced count can still reproduce the reported bytesPerRun.
    assert.ok(Number.isInteger(d.sN) && Number.isInteger(d.s8N), 'lane ' + d.lane +
        ' scavenge counts must be integers (got sN ' + d.sN + ', s8N ' + d.s8N + ')');
    // Same operation order as the lane (count x semiBytes / (span x N), then 0.1 rounding), so an equal
    // formula can never differ here by a float ulp.
    const fromCounts = Math.round(((d.s8N - d.sN) * childSemiBytes(flags)) / ((LANE_WIN_HI - LANE_WIN_LO) * d.N) * 10) / 10;
    assert.equal(d.bytesPerRun, fromCounts,
        'lane ' + d.lane + ' reported ' + d.bytesPerRun + ' B/run but its scavenge counts (' + d.sN + ', ' + d.s8N +
        ') x Q = ' + fromCounts + ' -- pool-cost-lanes.mjs no longer converts counts the way Q assumes; re-derive Q.');
}

/**
 * runLane's result parse: `r` is the spawnSync result of one pinned lane child. A non-zero exit -- including
 * a signal kill, where status is null -- fails with the child's stderr; otherwise the LAST stdout line is the
 * lane's JSON (an empty or non-JSON line throws JSON.parse's SyntaxError).
 */
export function parseLaneResult(r, id) {
    assert.equal(r.status, 0, 'lane ' + id + ' exited ' + r.status + '\n' + (r.stderr || ''));
    return JSON.parse(r.stdout.trim().split('\n').pop());
}
