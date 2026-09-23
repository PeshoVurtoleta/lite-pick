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
import { WeightedRandomBalancer, BalancerBase, PICK_NONE } from '../Pick.js';
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
