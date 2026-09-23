/**
 * @zakkster/lite-pick -- ConsistentHashBalancer boundary + behaviour suite (M8).
 *
 *     node --test test/ConsistentHash.test.js
 *
 * Falsifiable assertions (the planner contract for M8):
 *   A1. BUILD CORRECTNESS: the lookup table is fully populated with only in-range backend
 *       indices, and every membership backend appears (unweighted -> ~equal slot share).
 *   A2. STICKINESS: at fixed membership the same keyHash returns the same backend over 1e4 repeats.
 *   A3. MINIMAL DISRUPTION: removing 1 of N backends remaps only ~1/N of keys (<= 2/N).
 *   A4. ELIGIBILITY PROBE: an ineligible hashed backend probes forward to the next eligible one
 *       (never returns a down / out-of-range index).
 *   A5. FAIL CLOSED: PICK_NONE when the whole pool is down; and when the probe window is exhausted.
 *   A6. WEIGHTED DISTRIBUTION: slot share is ~proportional to weight.
 *   A7. KEY COERCION: keyHash is coerced `>>> 0` -- NaN/undefined -> 0, negatives wrap, never throws.
 *   A8. VALIDATION: the constructor throws typeof-first (M non-number, non-prime, capacity > M,
 *       bad weights) BEFORE building the table.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConsistentHashBalancer, BalancerBase, PICK_NONE, CH_DEFAULT_M, CH_PROBE_LIMIT } from '../Pick.js';

const up = (n) => { const e = new Uint8Array(n); e.fill(1); return e; };
const M = 8191; // a prime table size, large enough for smooth distribution at n<=64

/** A seeded key set (an LCG, independent of the balancer's internal mix). */
function makeKeys(count, seed) {
    const keys = new Uint32Array(count);
    let x = seed >>> 0;
    for (let i = 0; i < count; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; keys[i] = x; }
    return keys;
}

test('ConsistentHashBalancer is a BalancerBase', () => {
    const b = new ConsistentHashBalancer(4, up(4), null, M);
    assert.ok(b instanceof BalancerBase);
    assert.equal(b.capacity, 4);
    assert.equal(b.tableSize, M);
});

test('exports the default M and probe limit', () => {
    assert.equal(CH_DEFAULT_M, 65537);
    assert.equal(CH_PROBE_LIMIT, 64);
});

test('A1: build correctness -- table fully in-range, every backend represented (~equal)', () => {
    const N = 64;
    const b = new ConsistentHashBalancer(N, up(N), null, M);
    const counts = new Uint32Array(N);
    for (let s = 0; s < M; s++) {
        const i = b._lookup[s];
        assert.ok(i >= 0 && i < N, 'lookup slot ' + s + ' out of range: ' + i);
        counts[i]++;
    }
    let min = Infinity, max = 0, sum = 0;
    for (let i = 0; i < N; i++) { if (counts[i] < min) min = counts[i]; if (counts[i] > max) max = counts[i]; sum += counts[i]; }
    assert.equal(sum, M, 'every slot assigned');
    assert.ok(min > 0, 'every backend appears in the table');
    // Unweighted Maglev is near-balanced: max/min slot share within a small factor.
    assert.ok(max - min <= 2, 'unweighted slot share is ~equal (max-min=' + (max - min) + ')');
});

test('A2: stickiness -- same keyHash -> same backend at fixed membership (1e4 repeats)', () => {
    const b = new ConsistentHashBalancer(32, up(32), null, M, 0xABCDEF);
    const keys = makeKeys(500, 0x1234);
    for (let k = 0; k < keys.length; k++) {
        const first = b.pick(keys[k]);
        for (let r = 0; r < 20; r++) assert.equal(b.pick(keys[k]), first);
    }
    // A single key repeated 1e4 times stays put.
    const anchor = b.pick(0xDEADBEEF);
    for (let i = 0; i < 10000; i++) assert.equal(b.pick(0xDEADBEEF), anchor);
});

test('A3: minimal disruption -- remove 1 of 64 remaps <= 2/N of keys', () => {
    const N = 64;
    const b = new ConsistentHashBalancer(N, up(N), null, M);
    const keys = makeKeys(100000, 0xBEEF);
    const before = new Int32Array(keys.length);
    for (let i = 0; i < keys.length; i++) before[i] = b.pick(keys[i]);
    b.setEligible(7, false); // remove a backend: NO rebuild, just mark it down
    let moved = 0;
    for (let i = 0; i < keys.length; i++) if (b.pick(keys[i]) !== before[i]) moved++;
    const frac = moved / keys.length;
    assert.ok(frac <= 2 / N, 'remap ' + (frac * 100).toFixed(3) + '% <= ' + (2 / N * 100).toFixed(2) + '%');
    // Keys NOT on the removed backend keep their EXACT backend (0 remap for them).
    for (let i = 0; i < keys.length; i++) {
        if (before[i] !== 7) assert.equal(b.pick(keys[i]), before[i], 'untouched key moved');
    }
});

test('A4: eligibility probe -- an ineligible hashed backend probes to an eligible one', () => {
    const N = 16;
    const b = new ConsistentHashBalancer(N, up(N), null, M);
    const keys = makeKeys(2000, 0xF00D);
    // Take down a handful of backends; every pick must still return an ELIGIBLE, in-range index.
    for (const d of [0, 3, 9, 14]) b.setEligible(d, false);
    for (let i = 0; i < keys.length; i++) {
        const p = b.pick(keys[i]);
        assert.ok(p !== PICK_NONE, 'live pool must resolve');
        assert.ok(p >= 0 && p < N, 'in range');
        assert.ok(b.isEligible(p), 'never returns a down index: ' + p);
    }
});

test('A5: fail closed -- whole pool down -> PICK_NONE; single eligible always returned', () => {
    const N = 8;
    const el = up(N);
    const b = new ConsistentHashBalancer(N, el, null, M);
    for (let i = 0; i < N; i++) b.setEligible(i, false);
    assert.equal(b.live, 0);
    for (const k of [0, 1, 42, 0xFFFFFFFF]) assert.equal(b.pick(k), PICK_NONE);
    // Bring exactly one back: every key resolves to it (the probe finds the sole eligible slot).
    b.setEligible(5, true);
    for (let k = 0; k < 5000; k++) assert.equal(b.pick(k * 2654435761), 5);
});

test('A5b: probe-bound fail-closed -- PICK_NONE past the window under a mass outage', () => {
    // A degenerate tiny table where a whole contiguous window can be down: force the bound.
    const N = 3, m = 127;
    const el = up(N);
    const b = new ConsistentHashBalancer(N, el, null, m);
    // Down two of three so long down-runs exist in the table; still, any pick is eligible or NONE.
    b.setEligible(0, false); b.setEligible(1, false);
    for (let k = 0; k < 2000; k++) {
        const p = b.pick(k);
        assert.ok(p === 2 || p === PICK_NONE, 'only the eligible backend or fail-closed: ' + p);
    }
});

test('A6: weighted distribution -- slot share ~proportional to weight', () => {
    const w = Uint32Array.from([1, 1, 1, 5]); // node 3 gets ~5x the slots
    const b = new ConsistentHashBalancer(4, up(4), w, M);
    const counts = new Uint32Array(4);
    for (let s = 0; s < M; s++) counts[b._lookup[s]]++;
    const total = M, wsum = 8;
    for (let i = 0; i < 4; i++) {
        const share = counts[i] / total, target = w[i] / wsum;
        assert.ok(Math.abs(share - target) < 0.02, 'node ' + i + ' share ' + share.toFixed(3) + ' ~ ' + target.toFixed(3));
    }
    // setWeight rebuilds and re-proportions (cold).
    b.setWeight(0, 5);
    const c2 = new Uint32Array(4);
    for (let s = 0; s < M; s++) c2[b._lookup[s]]++;
    assert.ok(Math.abs(c2[0] / M - 5 / 12) < 0.02, 'reweighted node 0 to ~5/12');
});

test('A7: key coercion -- >>> 0 (NaN/undefined -> 0, negatives wrap), never throws', () => {
    const b = new ConsistentHashBalancer(8, up(8), null, M);
    const at0 = b.pick(0);
    assert.equal(b.pick(NaN), at0, 'NaN >>> 0 == 0');
    assert.equal(b.pick(undefined), at0, 'undefined >>> 0 == 0');
    // -1 >>> 0 === 0xFFFFFFFF; a large float coerces the same both ways.
    assert.equal(b.pick(-1), b.pick(0xFFFFFFFF));
    assert.doesNotThrow(() => b.pick('not a number'));
    assert.doesNotThrow(() => b.pick());
});

test('A8: constructor validates typeof-first (before building the table)', () => {
    const el = up(4);
    assert.throws(() => new ConsistentHashBalancer(4, el, null, 'nope'), TypeError);   // M non-number
    assert.throws(() => new ConsistentHashBalancer(4, el, null, 100), RangeError);      // M not prime
    assert.throws(() => new ConsistentHashBalancer(4, el, null, 1), RangeError);        // M <= 1
    assert.throws(() => new ConsistentHashBalancer(4, el, null, 3.5), RangeError);      // M not integer
    assert.throws(() => new ConsistentHashBalancer(200, up(200), null, 131), RangeError); // capacity > M
    assert.throws(() => new ConsistentHashBalancer(4, el, [1, 1, 1, 1], M), RangeError);  // weights not Uint32Array
    assert.throws(() => new ConsistentHashBalancer(4, el, new Uint32Array(2), M), RangeError); // weights too short
    assert.throws(() => new ConsistentHashBalancer(0, new Uint8Array(1), null, M), RangeError); // base: bad capacity
});

test('all-zero weights -> equal-quota fallback (valid, fully populated table)', () => {
    const w = new Uint32Array(4); // all zero
    const b = new ConsistentHashBalancer(4, up(4), w, M);
    const counts = new Uint32Array(4);
    for (let s = 0; s < M; s++) { assert.ok(b._lookup[s] < 4); counts[b._lookup[s]]++; }
    for (let i = 0; i < 4; i++) assert.ok(counts[i] > 0, 'backend ' + i + ' still represented');
});
