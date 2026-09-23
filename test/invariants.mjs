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

/**
 * ConsistentHash structural invariants (M8): the lookup table maps ONLY to in-range backend
 * indices, and the last pick is PICK_NONE or an in-range ELIGIBLE index (never a down / oob one).
 * Returns null or the first violated invariant as a string.
 */
export function checkConsistentHash(b, eligible, cap, lastPick) {
    const lookup = b._lookup, M = b._m;
    for (let s = 0; s < M; s++) {
        const i = lookup[s];
        if (i < 0 || i >= cap) return 'lookup[' + s + '] out of range: ' + i;
    }
    if (lastPick !== PICK_NONE) {
        if (lastPick < 0 || lastPick >= cap) return 'pick ' + lastPick + ' out of range';
        if (!eligible[lastPick]) return 'pick ' + lastPick + ' is a DOWN index';
    }
    return null;
}

/**
 * The independent reachability oracle for ConsistentHash's fail-closed IFF: is an eligible backend
 * reachable from `keyHash`'s slot within the bounded forward-probe (initial slot + `bound` probes)?
 * Reads the table + eligibility exactly as pick() does, so a mismatch flags an off-by-one / stale
 * table. Returns 1 (reachable) or 0 (fail-closed within the bound).
 */
export function reachableWithinBound(b, eligible, keyHash, bound) {
    const M = b._m, lookup = b._lookup;
    let slot = (keyHash >>> 0) % M;
    if (eligible[lookup[slot]]) return 1;
    for (let p = 0; p < bound; p++) {
        slot++; if (slot >= M) slot = 0;
        if (eligible[lookup[slot]]) return 1;
    }
    return 0;
}

/** Sum of inflight over ALL endpoints [0, cap) -- the manual BoundedLoad `_total` recompute. */
export function recomputeInflightSum(inflight, cap) {
    let t = 0;
    for (let i = 0; i < cap; i++) t += inflight[i];
    return t;
}

/**
 * BoundedLoad state invariant (M9): the balancer-owned `_total` (its `totalInflight`) is EXACTLY the
 * sum of inflight over ALL endpoints [0, cap). This holds ONLY while the mirrored counter is driven
 * solely through note() (dispatch +1 / settle -1) -- the documented contract; the fuzzer routes every
 * inflight change through note() so a desync here flags a note()/_total bug, not caller UB. Returns
 * null or the first violated invariant as a string.
 */
export function checkBoundedLoad(b, inflight, cap) {
    const want = recomputeInflightSum(inflight, cap);
    if (b.totalInflight !== want) {
        return 'totalInflight ' + b.totalInflight + ' != recomputed sum(inflight) ' + want;
    }
    if (!Number.isFinite(b.totalInflight) || b.totalInflight < 0) {
        return 'totalInflight is not a finite non-negative number: ' + b.totalInflight;
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
