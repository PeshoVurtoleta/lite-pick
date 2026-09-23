/**
 * @zakkster/lite-pick -- the shared, reusable per-strategy invariant checker.
 *
 * NOT a test file (not *.test.js): a library imported by test/fuzz.mjs (the seeded
 * state-machine attack) and by the boundary suites where a strong post-condition helps.
 *
 * The distinction this file exists to enforce (RESEARCH section 3): the churn test proves
 * "pick() never returns a down index"; these invariants prove STATE SYNCHRONISATION --
 * every aggregate a balancer maintains stays EXACT versus a manual recompute from the
 * shared arrays, owned Float64 state stays finite, and PICK_NONE holds IFF the pickable
 * mass is 0. A balancer that silently desyncs `_totalEligibleWeight` or `_live` still
 * "never picks a down node" yet is corrupt; that is the class of bug this catches.
 *
 * Every checker is PURE (no allocation beyond a returned error string) and returns null on
 * success or a human-readable reason on the first violated invariant, so the fuzzer can
 * print the seed + step for a byte-for-byte replay.
 */

import { PICK_NONE } from '../Pick.js';

/** Count of set eligibility bits in [0, cap) -- the manual `_live` recompute. */
export function recomputeLive(eligible, cap) {
    let n = 0;
    for (let i = 0; i < cap; i++) if (eligible[i]) n++;
    return n;
}

/** Sum of weights over eligible endpoints -- the manual `_totalEligibleWeight` recompute. */
export function recomputeEligibleWeight(eligible, weights, cap) {
    let t = 0;
    for (let i = 0; i < cap; i++) if (eligible[i]) t += weights[i];
    return t;
}

/** Count of eligible endpoints with weight > 0 -- the SED/NQ pickable-mass recompute. */
export function recomputeEligibleWeighted(eligible, weights, cap) {
    let n = 0;
    for (let i = 0; i < cap; i++) if (eligible[i] && weights[i] > 0) n++;
    return n;
}

/** True iff every cell of f[0..cap) is a finite number (no NaN / +-Infinity crept in). */
export function allFinite(f, cap) {
    for (let i = 0; i < cap; i++) if (!Number.isFinite(f[i])) return false;
    return true;
}

/**
 * The universal invariants every strategy must satisfy after any op.
 *   1. `live` is EXACT: b.live === count of eligible bits.
 *   2. The pick is VALID: PICK_NONE, or an in-range eligible index.
 *   3. FAIL-CLOSED IFF: pick === PICK_NONE exactly when the pickable mass is 0.
 * `mass` is the strategy's pickable mass (live for most; eligible-weight-sum for weighted).
 * Returns null, or the first violated invariant as a string.
 */
export function checkBase(b, eligible, cap, lastPick, mass) {
    const live = recomputeLive(eligible, cap);
    if (b.live !== live) return 'live ' + b.live + ' != recomputed ' + live;
    if (lastPick !== PICK_NONE) {
        if (lastPick < 0 || lastPick >= cap) return 'pick ' + lastPick + ' out of range';
        if (!eligible[lastPick]) return 'pick ' + lastPick + ' is a DOWN index';
    }
    const noneExpected = mass === 0;
    const noneGot = lastPick === PICK_NONE;
    if (noneExpected !== noneGot) {
        return 'fail-closed desync: mass=' + mass + ' pick=' + lastPick +
            ' (expected PICK_NONE ' + noneExpected + ', got ' + noneGot + ')';
    }
    return null;
}

/** The exact minimum of scoreFn(i) over eligible i (candidateFn gates candidacy). Infinity if none. */
export function minEligibleScore(eligible, cap, scoreFn, candidateFn) {
    let best = Infinity;
    for (let i = 0; i < cap; i++) {
        if (eligible[i] && (candidateFn === undefined || candidateFn(i))) {
            const s = scoreFn(i);
            if (s < best) best = s;
        }
    }
    return best;
}
