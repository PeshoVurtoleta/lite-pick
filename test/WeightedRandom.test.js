/**
 * @zakkster/lite-pick -- WeightedRandomBalancer boundary + behaviour suite (M10).
 *
 *     node --test test/WeightedRandom.test.js
 *
 * WeightedRandom is O(1) weighted-random selection via a Vose/Walker alias table with
 * rejection-sampling eligibility. The alias table is built COLD over the eligible-independent
 * weights (a weight-0 node is never a column); rejection over the shared bitmap renormalizes the
 * weight distribution across the surviving eligible mass.
 *
 * Falsifiable assertions (the planner contract for M10):
 *   A1. VALIDATION: the constructor validates capacity/eligible/weights typeof-first.
 *   A2. WEIGHT-0 is NEVER returned; PICK_NONE when all eligible weights are 0.
 *   A3. FAIL CLOSED: whole pool down -> PICK_NONE; single node returned while up.
 *   A4. NEVER an ineligible / out-of-range index (adversarial flapping).
 *   A5. setWeight rebuilds the table and CHANGES the distribution; rebuild() is cold.
 *   A6. DETERMINISM under a fixed seed (same seed -> same pick stream).
 *   A7. PARTIAL-POOL renormalization: survivor shares track weight[i]/sum(eligible weights).
 *   A8. FULL-POOL fairness: observed shares track weight[i]/sum within a tight relative band.
 *   A9. ANTI-FLAP: an eligibility flap NEVER rebuilds the alias table.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WeightedRandomBalancer, BalancerBase, PICK_NONE, STAT_REBUILDS, STAT_COUNT } from '../Pick.js';
import { checkWeightedRandom } from './invariants.mjs';

const up = (n) => { const e = new Uint8Array(n); e.fill(1); return e; };
const w = (arr) => Uint32Array.from(arr);

test('WeightedRandomBalancer is a BalancerBase', () => {
    const b = new WeightedRandomBalancer(4, up(4), w([1, 2, 3, 4]));
    assert.ok(b instanceof BalancerBase);
    assert.equal(b.capacity, 4);
    assert.equal(b.live, 4);
});

test('A1: constructor validates capacity, eligible, and weights (typeof-first)', () => {
    assert.throws(() => new WeightedRandomBalancer(0, new Uint8Array(1), w([1])), RangeError);   // capacity
    assert.throws(() => new WeightedRandomBalancer(3, new Uint8Array(2), w([1, 1, 1])), RangeError); // short eligible
    assert.throws(() => new WeightedRandomBalancer(3, up(3), new Uint32Array(2)), RangeError);   // short weights
    assert.throws(() => new WeightedRandomBalancer(3, up(3), [1, 1, 1]), RangeError);            // not a Uint32Array
    // @ts-ignore -- a valid construction does not throw.
    assert.ok(new WeightedRandomBalancer(3, up(3), w([1, 2, 3])));
});

test('A2: a weight-0 node is NEVER returned', () => {
    const n = 6;
    const b = new WeightedRandomBalancer(n, up(n), w([0, 5, 0, 7, 0, 3]));
    for (let i = 0; i < 200000; i++) {
        const p = b.pick();
        assert.ok(p === 1 || p === 3 || p === 5, 'weight-0 node returned: ' + p);
    }
});

test('A2: all eligible weights 0 -> PICK_NONE (even with live > 0)', () => {
    const n = 4;
    const b = new WeightedRandomBalancer(n, up(n), new Uint32Array(n)); // all-zero weights
    assert.equal(b.live, 4);
    for (let i = 0; i < 1000; i++) assert.equal(b.pick(), PICK_NONE);
    // Only ineligible nodes have positive weight -> still PICK_NONE (nothing eligible + positive).
    const el = Uint8Array.from([1, 0, 1, 0]);
    const b2 = new WeightedRandomBalancer(n, el, w([0, 9, 0, 9]));
    for (let i = 0; i < 1000; i++) assert.equal(b2.pick(), PICK_NONE);
});

test('A3: fail closed when the whole pool is down; single node returned while up', () => {
    const n = 4;
    const b = new WeightedRandomBalancer(n, new Uint8Array(n), w([1, 2, 3, 4])); // all down
    assert.equal(b.pick(), PICK_NONE);
    const one = new WeightedRandomBalancer(n, Uint8Array.from([0, 1, 0, 0]), w([1, 2, 3, 4]));
    for (let i = 0; i < 1000; i++) assert.equal(one.pick(), 1);
    // Bring it down -> PICK_NONE.
    one.setEligible(1, false);
    assert.equal(one.pick(), PICK_NONE);
});

test('A4: never returns an ineligible / out-of-range index under adversarial flapping', () => {
    const n = 32;
    const el = up(n);
    const weights = new Uint32Array(n);
    for (let i = 0; i < n; i++) weights[i] = 1 + (i & 7);
    const b = new WeightedRandomBalancer(n, el, weights, 0x1234abcd);
    let s = 0xBEEF1234 >>> 0;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
    for (let step = 0; step < 200000; step++) {
        if ((step & 3) === 0) b.setEligible(rnd() % n, (rnd() & 1) === 0);
        const p = b.pick();
        if (p === PICK_NONE) continue;
        assert.ok(p >= 0 && p < n, 'in range at step ' + step);
        assert.equal(el[p], 1, 'down index at step ' + step);
        assert.ok(weights[p] > 0, 'weight-0 index at step ' + step);
    }
});

test('A5: setWeight rebuilds the table and shifts the distribution; the invariant holds', () => {
    const n = 4;
    const weights = w([1, 1, 1, 1]);
    const b = new WeightedRandomBalancer(n, up(n), weights, 0xC0FFEE);
    assert.equal(checkWeightedRandom(b, weights, n), null);
    const before = new Uint32Array(n);
    for (let i = 0; i < 400000; i++) before[b.pick()]++;
    // Heavily favour node 0.
    b.setWeight(0, 100);
    assert.equal(weights[0], 100, 'setWeight is the sole writer of the caller weights');
    assert.equal(checkWeightedRandom(b, weights, n), null);
    const after = new Uint32Array(n);
    for (let i = 0; i < 400000; i++) after[b.pick()]++;
    assert.ok(after[0] > before[0] * 3, 'node 0 now dominates after the reweight');
    // rebuild() is a cold no-op re-derivation from the current weights (invariant still holds).
    b.rebuild();
    assert.equal(checkWeightedRandom(b, weights, n), null);
    // setWeight validates.
    assert.throws(() => b.setWeight(-1, 1), RangeError);
    assert.throws(() => b.setWeight(4, 1), RangeError);
    assert.throws(() => b.setWeight(0, -1), RangeError);
    assert.throws(() => b.setWeight(0, 1.5), RangeError);
});

test('A6: determinism -- the same seed yields the same pick stream', () => {
    const n = 16;
    const weights = new Uint32Array(n);
    for (let i = 0; i < n; i++) weights[i] = 1 + (i & 7);
    const a = new WeightedRandomBalancer(n, up(n), weights.slice(), 0xABCDEF);
    const b = new WeightedRandomBalancer(n, up(n), weights.slice(), 0xABCDEF);
    for (let i = 0; i < 100000; i++) assert.equal(a.pick(), b.pick());
    // A different seed diverges (astronomically unlikely to match every draw).
    const c = new WeightedRandomBalancer(n, up(n), weights.slice(), 0x12345678);
    let diverged = false;
    const a2 = new WeightedRandomBalancer(n, up(n), weights.slice(), 0xABCDEF);
    for (let i = 0; i < 1000 && !diverged; i++) if (a2.pick() !== c.pick()) diverged = true;
    assert.ok(diverged, 'a different seed must produce a different stream');
});

test('A7: partial-pool renormalization -- survivor shares track weight/sum(eligible)', () => {
    const n = 64;
    const el = new Uint8Array(n);
    for (let i = 0; i < n; i++) el[i] = (i % 2 === 0) ? 1 : 0; // half eligible
    const weights = new Uint32Array(n);
    for (let i = 0; i < n; i++) weights[i] = 1 + (i & 15); // 1..16
    let esum = 0; for (let i = 0; i < n; i++) if (el[i]) esum += weights[i];
    const b = new WeightedRandomBalancer(n, el, weights, 0xABCDEF);
    const counts = new Uint32Array(n);
    const N = 2_000_000;
    let ineligible = 0, zero = 0;
    for (let i = 0; i < N; i++) {
        const p = b.pick();
        if (p < 0 || p >= n || !el[p]) { ineligible++; continue; }
        if (weights[p] === 0) zero++;
        counts[p]++;
    }
    assert.equal(ineligible, 0, 'zero ineligible returns over ' + N + ' picks');
    assert.equal(zero, 0, 'zero weight-0 returns');
    let worst = 0;
    for (let i = 0; i < n; i++) if (el[i]) {
        const rel = Math.abs(counts[i] / N - weights[i] / esum) / (weights[i] / esum);
        if (rel > worst) worst = rel;
    }
    assert.ok(worst < 0.03, 'survivor shares within 3% relative (worst ' + (worst * 100).toFixed(2) + '%)');
});

test('A8: full-pool fairness -- observed shares track weight/sum within 2% relative', () => {
    const n = 64;
    const el = up(n);
    const weights = new Uint32Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) { weights[i] = 1 + (i & 15); sum += weights[i]; }
    const b = new WeightedRandomBalancer(n, el, weights, 0xABCDEF);
    const counts = new Uint32Array(n);
    // N sized from a correct run: the lightest (weight-1) nodes carry the most relative variance, so
    // 2% RELATIVE on EVERY node needs ~8e6 draws to hold with margin (band is NEVER widened to pass).
    const N = 8_000_000;
    for (let i = 0; i < N; i++) counts[b.pick()]++;
    let worst = 0;
    for (let i = 0; i < n; i++) {
        const rel = Math.abs(counts[i] / N - weights[i] / sum) / (weights[i] / sum);
        if (rel > worst) worst = rel;
    }
    assert.ok(worst < 0.02, 'shares within 2% relative of weight (worst ' + (worst * 100).toFixed(2) + '%)');
});

test('A10: heavy-outage fallback -- a lone eligible node in a LARGE pool is ALWAYS found', () => {
    // Exactly ONE eligible positive-weight node among 4096 (all others down): the 64-try rejection loop
    // exhausts ~every pick, so this exercises the rotated linear-scan FALLBACK. The scan is EXHAUSTIVE
    // (not bounded-and-give-up), so it must find the lone survivor on every draw -- never PICK_NONE.
    const n = 4096;
    const el = new Uint8Array(n);            // all down...
    const survivor = 2903;
    el[survivor] = 1;                        // ...except one eligible node
    const weights = new Uint32Array(n);
    for (let i = 0; i < n; i++) weights[i] = 1 + (i & 15); // every node positive-weight
    const b = new WeightedRandomBalancer(n, el, weights, 0xFACEFEED);
    for (let i = 0; i < 200000; i++) {
        assert.equal(b.pick(), survivor, 'the fallback must always find the lone eligible node');
    }
    // When that last node also goes down -> PICK_NONE (nothing eligible + positive).
    b.setEligible(survivor, false);
    for (let i = 0; i < 1000; i++) assert.equal(b.pick(), PICK_NONE);
    // A lone eligible node whose WEIGHT is 0 (others down) is not a candidate -> PICK_NONE.
    const el2 = new Uint8Array(n);
    el2[7] = 1;
    const weights2 = new Uint32Array(n);
    for (let i = 0; i < n; i++) weights2[i] = 1 + (i & 15);
    weights2[7] = 0;                         // the only eligible node has weight 0
    const b2 = new WeightedRandomBalancer(n, el2, weights2, 0xFACEFEED);
    for (let i = 0; i < 1000; i++) assert.equal(b2.pick(), PICK_NONE);
});

test('boundary: oversized weights array (length > capacity) is tolerated', () => {
    // The ctor guard is `weights.length < capacity` (Pick.js): only UNDERSIZED is rejected. A caller
    // array with trailing slots beyond capacity (e.g. a shared over-allocated buffer) must construct
    // and pick correctly, reading only the first `capacity` slots.
    const n = 4;
    const wOver = w([1, 2, 3, 4, 999]); // length 5 > capacity 4; index 4 must never be read
    const b = new WeightedRandomBalancer(n, up(n), wOver);
    assert.equal(b.live, 4);
    for (let i = 0; i < 5000; i++) {
        const p = b.pick();
        assert.ok(p >= 0 && p < n, 'oversized-weights pick stayed in range: ' + p);
    }
});

test('boundary: NaN and negative seeds are coerced, never throw, and stay deterministic', () => {
    const n = 4;
    const weights = w([1, 1, 1, 1]);
    // NaN >>> 0 === 0 -> remapped to the documented default seed (xorshift stuck at 0 stays 0).
    const nA = new WeightedRandomBalancer(n, up(n), weights.slice(), NaN);
    const nB = new WeightedRandomBalancer(n, up(n), weights.slice(), NaN);
    for (let i = 0; i < 1000; i++) assert.equal(nA.pick(), nB.pick(), 'NaN seed is deterministic at step ' + i);
    // -1 >>> 0 === 0xFFFFFFFF (non-zero) -> kept as-is, still deterministic.
    const negA = new WeightedRandomBalancer(n, up(n), weights.slice(), -1);
    const negB = new WeightedRandomBalancer(n, up(n), weights.slice(), -1);
    for (let i = 0; i < 1000; i++) assert.equal(negA.pick(), negB.pick(), 'negative seed is deterministic at step ' + i);
});

test('A9: an eligibility flap NEVER rebuilds the alias table (anti-flap)', () => {
    const n = 8;
    const b = new WeightedRandomBalancer(n, up(n), w([1, 2, 3, 4, 5, 6, 7, 8]));
    const buildsAfterCtor = b._builds;                 // exactly 1 cold build in the ctor
    assert.equal(buildsAfterCtor, 1);
    for (let k = 0; k < 1000; k++) { b.setEligible(k & 7, (k & 1) === 0); b.pick(); }
    assert.equal(b._builds, buildsAfterCtor, 'no rebuild on any eligibility flap');
    b.setWeight(0, 42);                                 // a reweight DOES rebuild (sole writer)
    assert.equal(b._builds, buildsAfterCtor + 1);
});

test('M1: setWeight rejects a non-integer/out-of-range index; no rebuild, caller weights unchanged', () => {
    const weights = Uint32Array.from([1, 2, 3, 4]);
    const b = new WeightedRandomBalancer(4, up(4), weights);
    const builds = b._builds;
    const before = Uint32Array.from(weights);
    for (const bad of [1.5, NaN, -1, '2', 4]) {
        assert.throws(() => b.setWeight(bad, 9), RangeError, 'setWeight(' + String(bad) + ')');
    }
    assert.equal(b._builds, builds, 'a rejected setWeight must not rebuild the alias table');
    assert.deepEqual(Uint32Array.from(weights), before, 'caller weights unchanged after a rejected setWeight');
});

test('L2 (1.1.0): the sparse-pool fallback is WEIGHT-PROPORTIONAL over the eligible nodes', () => {
    // Nodes 0 (weight 1) and 1 (weight 3) of 100 eligible, the rest weight 1 and down: most draws miss and
    // reach the fallback, which must keep the 1:3 ratio (1.0.x: first eligible after a random start).
    const weights = new Uint32Array(100).fill(1); weights[1] = 3;
    const el = new Uint8Array(100); el[0] = 1; el[1] = 1;
    const b = new WeightedRandomBalancer(100, el, weights, 11);
    const c = [0, 0];
    for (let i = 0; i < 200000; i++) c[b.pick()]++;
    const share = c[1] / 200000;
    assert.ok(Math.abs(share - 0.75) < 0.01, 'node 1 share ' + share.toFixed(4) + ' (want 0.75 +- 0.01)');
});

test('setWeights (1.1.0): one rebuild, copies into the caller array, a bad array changes nothing', () => {
    const weights = w([1, 2, 3, 4]);
    const b = new WeightedRandomBalancer(4, new Uint8Array(4).fill(1), weights);
    const builds = b._builds;
    const next = w([4, 3, 2, 1]);
    b.setWeights(next);
    assert.equal(b._builds, builds + 1, 'exactly one rebuild');
    assert.deepEqual(Uint32Array.from(weights), next, 'copied into the weights array the balancer was built with');
    assert.equal(checkWeightedRandom(b, weights, 4), null);
    for (const bad of [null, [1, 2, 3, 4], w([1, 2, 3]), new Float64Array(4)]) assert.throws(() => b.setWeights(bad), RangeError);
    assert.equal(b._builds, builds + 1, 'a rejected setWeights does not rebuild');
    assert.deepEqual(Uint32Array.from(weights), next);
});

test('K4: a direct weights SWAP (sum preserved) is caught by assertConsistent, naming the index', () => {
    // assertConsistent compares the live weights to the BUILT snapshot element-wise, not by sum. A swap
    // of two weights keeps the sum, so the 1.1.0 sum check missed it (the alias table is then stale).
    const weights = w([1, 2, 3, 4]);
    const b = new WeightedRandomBalancer(4, up(4), weights);
    b.assertConsistent();                              // clean after the ctor build
    const t = weights[0]; weights[0] = weights[1]; weights[1] = t;   // [2,1,3,4], sum still 10
    assert.throws(() => b.assertConsistent(),
        (e) => e.code === 'LITE_PICK_INCONSISTENT' && /weights\[0\]/.test(e.message),
        'a swap that preserves the sum must still be caught, naming weights[0]');
    b.rebuild();                                       // re-snapshots -> consistent again
    b.assertConsistent();
});

test('K5: setWeights snapshots a source that OVERLAPS the balancer array (no forward-copy smear)', () => {
    // The balancer's weights are a VIEW into a shared buffer, and setWeights is handed an overlapping
    // view of the SAME buffer whose slots start one BELOW the owned slots. A forward element copy smears
    // buf[0] across every slot ([9,9,9,9]); TypedArray.set snapshots first, so the slots become [9,1,2,3].
    const buf = Uint32Array.from([9, 1, 2, 3, 99]);
    const owned = buf.subarray(1, 5);                  // the balancer's weights: buf[1..4] = [1,2,3,99]
    const b = new WeightedRandomBalancer(4, up(4), owned);
    b.setWeights(buf.subarray(0, 4));                  // overlaps `owned`, offset one below: [9,1,2,3]
    assert.deepEqual(Array.from(owned), [9, 1, 2, 3], 'overlapping setWeights must snapshot, not smear');
    // The other direction: owned slots start ABOVE the source. A forward copy is accidentally safe here,
    // but .set must still agree (both-ways coverage).
    const buf2 = Uint32Array.from([5, 6, 7, 8, 42]);
    const owned2 = buf2.subarray(0, 4);                // buf2[0..3] = [5,6,7,8]
    const b2 = new WeightedRandomBalancer(4, up(4), owned2);
    b2.setWeights(buf2.subarray(1, 5));                // [6,7,8,42]
    assert.deepEqual(Array.from(owned2), [6, 7, 8, 42], 'the non-smearing overlap direction must also match');
});

test('K5/no-op: setWeights with the SAME values still rebuilds (+1 STAT_REBUILDS; no short-circuit)', () => {
    const slab = new Float64Array(STAT_COUNT);
    const b = new WeightedRandomBalancer(4, up(4), w([1, 2, 3, 4]));
    b.attachStats(slab);
    const before = slab[STAT_REBUILDS], builds = b._builds;
    b.setWeights(w([1, 2, 3, 4]));                     // identical values -- no-op short-circuit is 1.2.0
    assert.equal(slab[STAT_REBUILDS], before + 1, 'setWeights always rebuilds, even with unchanged values');
    assert.equal(b._builds, builds + 1);
});

test('K2: a direct eligible[] SWAP (live preserved) is caught by the _ew recount in assertConsistent', () => {
    // Swapping an UP node with a DOWN node of a DIFFERENT weight keeps _live, so the base live-count
    // check still passes, but the cached eligible-weight sum (_ew) is now wrong -- the recount catches it.
    const el = Uint8Array.from([1, 0, 1, 1]);          // nodes 0,2,3 up; node 1 down -> live 3
    const b = new WeightedRandomBalancer(4, el, w([10, 20, 30, 40]));
    b.assertConsistent();
    el[0] = 0; el[1] = 1;                              // direct swap: live still 3, eligible weight changed
    assert.throws(() => b.assertConsistent(),
        (e) => e.code === 'LITE_PICK_INCONSISTENT' && /eligible-weight sum/.test(e.message),
        'a direct eligibility swap must be caught via the _ew recount');
});

test('K2: setEligible keeps _ew exact -- assertConsistent clean across a flap sequence', () => {
    // The supported path (never a direct eligible[] write): every flap goes through setEligible, which
    // maintains _ew from the built snapshot, so the recount always agrees.
    const b = new WeightedRandomBalancer(4, up(4), w([10, 20, 30, 40]));
    for (const [i, u] of [[1, false], [3, false], [1, true], [0, false], [3, true], [0, true]]) {
        b.setEligible(i, u);
        b.assertConsistent();
    }
});

test('finding 1: past 2^53 total weight, setEligible recounts _ew so assertConsistent stays clean', () => {
    // `_ew` is exact via the running +=/-= only while the TOTAL weight sum < 2^53. Capacity is uncapped,
    // so near-max uint32 weights past ~cap 2^21 overflow that: a single flap's += would drift from a fresh
    // sum, the sparse fallback would scale its uniform by a wrong eligible-weight sum, and assertConsistent
    // would FALSE-POSITIVE. The drift-regime branch recounts ASCENDING over the built snapshot -- bit-
    // identical to the fallback's own per-call sum in every regime. An incremental-only `_ew` (the unshipped
    // B1 draft that maintained `_ew` with the running +=/-= ALONE -- NOT git HEAD, which has no `_ew`) throws here.
    const cap = 3 * (1 << 20);                 // 3145728: total ~1.35e16, comfortably above 2^53
    const el = up(cap);
    const weights = new Uint32Array(cap);
    for (let i = 0; i < cap; i++) weights[i] = 4294967295 - (i % 7);
    const b = new WeightedRandomBalancer(cap, el, weights);
    assert.ok(b._psum > 2 ** 53, 'precondition: total weight sum exceeds 2^53 (got ' + b._psum + ')');
    assert.doesNotThrow(() => b.assertConsistent(), 'clean immediately after build');
    for (let k = 0; k < 8; k++) {
        b.setEligible((k * 977) % cap, false);
        b.setEligible((k * 977) % cap, true);
        b.setEligible((k * 131) % cap, false);
        assert.doesNotThrow(() => b.assertConsistent(),
            'flap ' + k + ': _ew must equal a fresh ascending recount (HEAD drifts and throws)');
    }
});

test('regime switch MID-SEQUENCE: setWeight crosses 2^53 total weight up and back; _ew stays exact through flaps', () => {
    // finding 1 BUILDS above 2^53; this one starts below it and crosses it with ONE setWeight on a live
    // balancer, then crosses back. The regime is a property of the CURRENT built weights, re-read on every
    // flap: a kernel that decided "exact running sum" once (at construction) would keep the +=/-= path
    // after the crossing, drift, and false-positive here. Below 2^53 the cached sum must equal the TRUE
    // (BigInt) eligible-weight sum exactly, not merely agree with assertConsistent's own recount.
    const MAXW = 4294967295;
    const cap = (1 << 21) + 1;                 // 2^21 near-max weights + one zero weight at the end
    const weights = new Uint32Array(cap);
    weights.fill(MAXW, 0, cap - 1);            // total = 2^21 * (2^32 - 1) = 2^53 - 2^21  (< 2^53)
    const el = up(cap);
    const b = new WeightedRandomBalancer(cap, el, weights);
    const trueEw = () => {                     // the definition: exact integer sum over eligible built weights
        let s = 0n;
        for (let i = 0; i < cap; i++) if (el[i]) s += BigInt(b._built[i]);
        return s;
    };
    // Each round takes two nodes down and brings them back, so EVERY round starts from the full pool: the
    // crossing below happens with the whole eligible sum at the total (an eligible sum left under 2^53 by
    // earlier flaps would be exact under any regime rule, and the crossing would prove nothing).
    const flaps = (tag) => {
        for (let k = 1; k <= 6; k++) {
            const x = (k * 977) % (cap - 1), y = (k * 131) % (cap - 1);
            b.setEligible(x, false);
            b.setEligible(y, false);
            b.setEligible(x, true);
            assert.doesNotThrow(() => b.assertConsistent(), tag + ' flap ' + k + ': _ew must equal a fresh recount');
            b.setEligible(y, true);
            assert.doesNotThrow(() => b.assertConsistent(), tag + ' flap ' + k + ' (restored): _ew must equal a fresh recount');
        }
        assert.equal(b.live, cap, tag + ': every round restored the full pool');
    };
    assert.ok(b._psum < 2 ** 53, 'precondition: built below 2^53 (got ' + b._psum + ')');
    flaps('below');
    assert.equal(BigInt(b._ew[0]), trueEw(), 'below 2^53: _ew is the exact eligible-weight sum');

    b.setWeight(cap - 1, MAXW);                // ONE weight pushes the total past 2^53
    assert.ok(b._psum > 2 ** 53, 'precondition: crossed 2^53 (got ' + b._psum + ')');
    flaps('above');

    b.setWeight(cap - 1, 0);                   // and back below
    assert.ok(b._psum < 2 ** 53, 'precondition: back below 2^53 (got ' + b._psum + ')');
    flaps('back below');
    assert.equal(BigInt(b._ew[0]), trueEw(), 'back below 2^53: _ew is exact again');
});
