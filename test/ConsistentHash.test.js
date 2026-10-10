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
 *   A5. FAIL CLOSED: PICK_NONE when the whole pool is down -- and (1.1.0, L3) ONLY when no eligible backend
 *       owns a table slot: past the probe window a full-table sweep finds a far one.
 *   A6. WEIGHTED DISTRIBUTION: slot share is ~proportional to weight.
 *   A7. KEY COERCION: keyHash is coerced `>>> 0` -- NaN/undefined -> 0, negatives wrap, never throws.
 *   A8. VALIDATION: the constructor throws typeof-first (M non-number, non-prime, capacity > M,
 *       bad weights) BEFORE building the table.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import {
    ConsistentHashBalancer, BoundedLoadBalancer, BalancerBase, PICK_NONE, CH_DEFAULT_M, CH_PROBE_LIMIT,
    STAT_COUNT, STAT_REBUILDS, STAT_DISPLACED, STAT_FALLBACK_SCANS,
} from '../Pick.js';
import { Pool } from '../Pool.js';

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

test('A5b (1.1.0, L3): past the probe window a full-table sweep -- never PICK_NONE while a backend is up', () => {
    // 100 backends, M = 101: each owns ~1 slot, so with ONLY backend 99 up most keys face > 64 consecutive
    // down slots. 1.0.x returned PICK_NONE for them; the L3 sweep (IPVS mh-fallback idea) finds 99.
    const N = 100, m = 101;
    const b = new ConsistentHashBalancer(N, up(N), null, m);
    for (let i = 0; i < 99; i++) b.setEligible(i, false);
    for (let k = 0; k < 2000; k++) assert.equal(b.pick(k), 99, 'key ' + k);
    // A backend with weight 0 owns no slot: up but unreachable -> PICK_NONE is the honest answer.
    const w = new Uint32Array(N).fill(1); w[99] = 0;
    const z = new ConsistentHashBalancer(N, up(N), w, m);
    for (let i = 0; i < 99; i++) z.setEligible(i, false);
    for (let k = 0; k < 200; k++) assert.equal(z.pick(k), PICK_NONE);
});

test('L7 (1.1.0): additive Maglev stepping builds the IDENTICAL table (golden fingerprints from 1.0.2)', () => {
    // FNV-1a over the uint16 halves of every lookup slot, recorded from the 1.0.2 multiply build. Equal
    // tables mean an upgrade moves no key; the additive build is 7.8x faster at the default M = 65537.
    const fnv = (a) => {
        let h = 0x811c9dc5;
        for (let i = 0; i < a.length; i++) {
            h ^= a[i] & 0xff; h = Math.imul(h, 0x01000193);
            h ^= (a[i] >>> 8) & 0xff; h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16).padStart(8, '0');
    };
    const grad = (n) => Uint32Array.from({ length: n }, (_, i) => 1 + (i & 7));
    const cases = [
        [3, 7, null, 1, '240ae81d'],
        [8, 101, null, 0x9e3779b9, 'c7e090e9'],
        [256, 4099, grad(256), 0x9e3779b9, '4ca1b5e6'],
        [256, 65537, grad(256), 0x9e3779b9, 'e1a7633d'],
        [100, 65537, null, 42, '9dfb7821'],
        [10, 257, Uint32Array.from({ length: 10 }, (_, i) => (i === 3 ? 0 : 1 + i)), 7, '28f4545c'],
    ];
    for (const [cap, m, w, seed, want] of cases) {
        assert.equal(fnv(new ConsistentHashBalancer(cap, up(cap), w, m, seed)._lookup), want, 'cap ' + cap + ' M ' + m);
    }
});

test('setWeights (1.1.0): one rebuild, same table as per-backend setWeight, a bad array changes nothing', () => {
    const N = 16, w = Uint32Array.from({ length: N }, (_, i) => 1 + (i % 5));
    const a = new ConsistentHashBalancer(N, up(N), null, 1031);
    const b = new ConsistentHashBalancer(N, up(N), null, 1031);
    for (let i = 0; i < N; i++) a.setWeight(i, w[i]);
    let builds = 0;
    const orig = b._build.bind(b);
    b._build = () => { builds++; orig(); };
    b.setWeights(w);
    assert.equal(builds, 1, 'exactly one rebuild');
    assert.deepEqual(b._lookup, a._lookup);
    w[0] = 99;
    assert.equal(b._weights[0], 1, 'the weights are COPIED, not aliased');
    const before = Uint32Array.from(b._lookup);
    for (const bad of [null, [1, 2], new Uint32Array(N - 1), new Float64Array(N)]) {
        assert.throws(() => b.setWeights(bad), RangeError);
    }
    assert.equal(builds, 1, 'a rejected setWeights does not rebuild');
    assert.deepEqual(b._lookup, before);
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

test('M1: setWeight rejects a non-integer/out-of-range index; owned weights unchanged', () => {
    const w = Uint32Array.from([1, 2, 3, 4]);
    const b = new ConsistentHashBalancer(4, up(4), w, M);
    const before = Uint32Array.from(b._weights);
    for (const bad of [1.5, NaN, -1, '2', 4]) {
        assert.throws(() => b.setWeight(bad, 9), RangeError, 'setWeight(' + String(bad) + ')');
    }
    assert.deepEqual(Uint32Array.from(b._weights), before, 'owned weights unchanged after a rejected setWeight');
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

test('K8 (1.2.0): all-zero weights -> PICK_NONE for pick and pickFrom (ctor AND setWeights), never throws; re-weight = a fresh table (CH + BL)', async () => {
    // 1.1.x fell back to EQUAL quotas on all-zero weights and routed every key (HEAD: 0/1000 PICK_NONE).
    // 1.2.0: weight 0 = removed, so all-zero = every backend removed = PICK_NONE, answered by the O(1)
    // `_live & _wmask` guard -- never the probe (STAT_DISPLACED +0) nor the O(M) sweep (STAT_FALLBACK_SCANS +0).
    const N = 8, m = 257;
    const makers = [
        ['ConsistentHash', (w) => { const inf = new Uint32Array(N); return { b: new ConsistentHashBalancer(N, up(N), w, m, 7), inf }; }],
        ['BoundedLoad', (w) => { const inf = new Uint32Array(N); return { b: new BoundedLoadBalancer(N, up(N), inf, 0.25, w, m, 7), inf }; }],
    ];
    const keys = makeKeys(1000, 0xBEEF);
    const ones = new Uint32Array(N).fill(1);
    for (const [name, make] of makers) {
        const viaCtor = make(new Uint32Array(N));
        const viaSet = make(null);
        viaSet.b.setWeights(new Uint32Array(N));
        const viaSetWeight = make(ones);
        for (let i = 0; i < N; i++) viaSetWeight.b.setWeight(i, 0);   // the per-backend path to all-zero
        for (const [how, { b, inf }] of [['ctor', viaCtor], ['setWeights', viaSet], ['setWeight', viaSetWeight]]) {
            const tag = name + ' via ' + how + ': ';
            const slab = new Float64Array(STAT_COUNT);
            b.attachStats(slab);
            const buf = new Uint32Array(1);
            let none = 0;
            for (let k = 0; k < keys.length; k++) {
                if (b.pick(keys[k]) === PICK_NONE) none++;
                buf[0] = keys[k];
                assert.equal(b.pickFrom(buf, 0), PICK_NONE, tag + 'pickFrom key ' + keys[k]);
            }
            assert.equal(none, 1000, tag + '1000/1000 keys -> PICK_NONE');
            for (const k of [NaN, undefined, -1, 0, 0xFFFFFFFF, 1.5]) assert.equal(b.pick(k), PICK_NONE, tag + 'pick(' + k + ')');
            assert.equal(slab[STAT_DISPLACED], 0, tag + 'the O(1) guard answers: no probe (STAT_DISPLACED +0)');
            assert.equal(slab[STAT_FALLBACK_SCANS], 0, tag + 'the O(1) guard answers: no O(M) sweep (STAT_FALLBACK_SCANS +0)');
            for (let s2 = 0; s2 < m; s2++) assert.ok(b._lookup[s2] < N, tag + 'the zeroed table stays in range');
            b.assertConsistent();
            // Pool rejects with LITE_PICK_NONE and never calls fn.
            const pool = new Pool(b, inf);
            let called = 0;
            await assert.rejects(pool.run(async () => { called++; }, { key: 0xABCD }), (e) => e.code === 'LITE_PICK_NONE');
            assert.equal(called, 0, tag + 'fn never runs');
            // Re-weight: the table equals a fresh ctor's on the same weights, and keys route again.
            b.setWeights(ones);
            assert.deepEqual(b._lookup, make(ones).b._lookup, tag + 're-weighted table == a fresh constructor table');
            for (let k = 0; k < 100; k++) assert.notEqual(b.pick(keys[k]), PICK_NONE, tag + 're-weighted key routes');
        }
        // A single positive weight brings back exactly that backend (the mask is per-build, not sticky).
        const one = make(new Uint32Array(N)).b;
        one.setWeight(5, 3);
        for (let k = 0; k < 200; k++) assert.equal(one.pick(keys[k]), 5, name + ': lone positive weight owns every key');
    }
});

test('setWeights (1.2.0): weights equal to the built snapshot skip the rebuild; the last index alone, and rebuild(), still build (CH + BL)', () => {
    const N = 6, m = 101;
    const cases = [
        ['ConsistentHash', () => new ConsistentHashBalancer(N, up(N), Uint32Array.from([1, 2, 3, 4, 5, 6]), m)],
        ['BoundedLoad', () => new BoundedLoadBalancer(N, up(N), new Uint32Array(N), 0.25, Uint32Array.from([1, 2, 3, 4, 5, 6]), m)],
    ];
    for (const [name, make] of cases) {
        const b = make(), slab = new Float64Array(STAT_COUNT);
        b.attachStats(slab);
        const table = Uint32Array.from(b._lookup);
        b.setWeights(Uint32Array.from([1, 2, 3, 4, 5, 6]));
        assert.equal(slab[STAT_REBUILDS], 0, name + ': setWeights(same) -> STAT_REBUILDS +0');
        assert.deepEqual(b._lookup, table, name + ': the table is untouched');
        b.setEligible(2, false); b.setEligible(2, true);                 // a flap is not a build input
        b.setWeights(Uint32Array.from([1, 2, 3, 4, 5, 6, 99]));        // longer array, same first cap values
        assert.equal(slab[STAT_REBUILDS], 0, name + ': only [0, capacity) is compared');
        b.setWeights(Uint32Array.from([1, 2, 3, 4, 5, 7]));            // ONLY index cap-1 differs
        assert.equal(slab[STAT_REBUILDS], 1, name + ': the last index alone -> +1 (a `i < cap - 1` compare misses it)');
        assert.equal(b._weights[N - 1], 7);
        b.setWeights(Uint32Array.from([9, 2, 3, 4, 5, 7]));            // ONLY index 0 differs
        assert.equal(slab[STAT_REBUILDS], 2, name + ': the first index alone -> +1');
        b.rebuild();
        assert.equal(slab[STAT_REBUILDS], 3, name + ': rebuild() is unconditional -> +1');
        b.assertConsistent();
    }
});

test('K9 (1.1.1, restored in 1.2.0): M <= 2^31-1 passes validation (reaches allocation); M >= 2^31 is rejected BEFORE it; primes just above 2^24 are ACCEPTED (CH + BL)', () => {
    // The bound is EXACTLY the positive-int32 ceiling 2^31-1 = 2147483647 (above it the Int32Array slot
    // positions in _build wrap negative). A hard 2^24 cap is deferred to 2.0: 1.1.1 documented M valid up to
    // 2^31 - 1, so rejecting (2^24, 2^31-1] in a minor would break SemVer. Pinned from both sides:
    //   ACCEPTED (reach the lookup allocation -- the Uint32Array stub trips its SENTINEL; never 8 GB):
    //     16777213 (the largest prime <= 2^24), the smallest prime > 2^24 (computed here), and 2^31-1 (prime,
    //     the legal maximum). MUST-FAIL CONTROL: the capped tree (1.2.0 draft, `m > 16777216` rejected) throws
    //     LITE_PICK_OPTION for the > 2^24 prime and for 2^31-1 before allocation, so this test FAILS there;
    //     a too-tight mutant (`m >= 2147483647`) fails on 2^31-1.
    //   REJECTED with LITE_PICK_OPTION BEFORE allocation, by the K9 bound (the message names 2147483647, not
    //     the prime check): 2^31 (composite -- the bound runs before chIsPrime), 2147483659 (prime, 12 above
    //     the ceiling), and 2^53-1 (the largest safe integer; composite = 6361 x 69431 x 20394401, so it pins
    //     the K9 message at the far end of the range -- the bound-before-prime ORDER is pinned by 2^31 above).
    const M_OK = 2147483647, M_2_31 = 2147483648, M_BIG = 2147483659;
    assert.ok(chIsPrimeLocal(M_OK), 'prerequisite: 2^31-1 is prime');
    assert.ok(chIsPrimeLocal(M_BIG), 'prerequisite: 2147483659 is prime');
    assert.ok(chIsPrimeLocal(16777213), 'prerequisite: 16777213 is prime');
    let above24 = 16777217;
    while (!chIsPrimeLocal(above24)) above24++;

    // A Uint32Array stub that throws a SENTINEL for any length > 2^23: the lookup table (M slots) trips
    // it, the small owned-weights / inflight arrays (capacity) do not.
    const SENTINEL = Symbol('ch-m-alloc');
    const RealU32 = globalThis.Uint32Array;
    class U32Stub extends RealU32 {
        constructor(arg) {
            if (typeof arg === 'number' && arg > 0x800000) {
                const e = new Error('SENTINEL: refused to allocate a ' + arg + '-element Uint32Array');
                e.sentinel = SENTINEL;
                throw e;
            }
            super(arg);
        }
    }
    const ctors = [
        ['ConsistentHash', (m) => new ConsistentHashBalancer(4, up(4), null, m)],
        ['BoundedLoad', (m) => new BoundedLoadBalancer(4, up(4), new Uint32Array(4), 0.25, null, m)],
    ];
    globalThis.Uint32Array = U32Stub;
    try {
        for (const [name, make] of ctors) {
            for (const m of [16777213, above24, M_OK]) {
                assert.throws(() => make(m), (err) => {
                    assert.equal(err.sentinel, SENTINEL, name + ': M = ' + m + ' must pass validation and REACH the lookup ' +
                        'allocation (got ' + (err && err.code ? err.code + ' ' + err.message : err) + ')');
                    return true;
                });
            }
            for (const m of [M_2_31, M_BIG, Number.MAX_SAFE_INTEGER]) {
                assert.throws(() => make(m), (err) => {
                    assert.notEqual(err.sentinel, SENTINEL, name + ': M = ' + m + ' must be rejected BEFORE allocation');
                    assert.ok(err instanceof RangeError, name + ': wrong error type: ' + err);
                    assert.equal(err.code, 'LITE_PICK_OPTION');
                    assert.match(err.message, /2147483647/, name + ': M = ' + m + ' is rejected by the K9 bound');
                    return true;
                });
            }
        }
    } finally {
        globalThis.Uint32Array = RealU32;
    }
});

test('assertConsistent (1.2.0): the all-zero-weights mask must agree with the built weights (CH + BL)', () => {
    const N = 4, m = 101;
    const makers = [
        ['ConsistentHash', (w) => new ConsistentHashBalancer(N, up(N), w, m)],
        ['BoundedLoad', (w) => new BoundedLoadBalancer(N, up(N), new Uint32Array(N), 0.25, w, m)],
    ];
    const bad = (e) => e.code === 'LITE_PICK_INCONSISTENT' && /all-zero-weights mask/.test(e.message);
    for (const [name, make] of makers) {
        const normal = make(null);
        normal.assertConsistent();
        normal._wmask = 0;                       // corrupt: weighted table, mask says all-zero
        assert.throws(() => normal.assertConsistent(), bad, name + ': _wmask 0 over nonzero weights');
        const zero = make(new Uint32Array(N));
        zero.assertConsistent();
        zero._wmask = -1;                        // corrupt: all-zero weights, mask says routable
        assert.throws(() => zero.assertConsistent(), bad, name + ': _wmask -1 over all-zero weights');
        const drift = make(new Uint32Array(N));
        drift._weights[2] = 5;                   // a direct owned-weight write without a rebuild (UB)
        assert.throws(() => drift.assertConsistent(), bad, name + ': owned weights written without a rebuild');
    }
});

test('K8 retention: 200 cycles CH(64, M=65537) -> zero weights -> ones -> drop; every instance is finalized', async () => {
    // Without --expose-gc, expose it at runtime (the flag must be set before the context that reads it).
    let gc = globalThis.gc;
    if (typeof gc !== 'function') {
        v8.setFlagsFromString('--expose-gc');
        gc = vm.runInNewContext('gc');
    }
    let live = 0;
    // The held value is the cycle number (a primitive): the registry never closes over the balancer.
    const reg = new FinalizationRegistry(() => { live--; });
    const zeros = new Uint32Array(64), ones = new Uint32Array(64).fill(1), el = up(64);
    function churn() {
        for (let c = 0; c < 200; c++) {
            const b = new ConsistentHashBalancer(64, el, null, 65537, c);
            b.setWeights(zeros);
            if (b.pick(c) !== PICK_NONE) throw new Error('all-zero pick routed');
            b.setWeights(ones);
            if (b.pick(c) === PICK_NONE) throw new Error('re-weighted pick failed closed');
            reg.register(b, c);
            live++;
        }
    }
    churn();
    assert.equal(live, 200);
    for (let r = 0; r < 50 && live > 0; r++) {
        gc();
        await new Promise((res) => setTimeout(res, 10));
    }
    assert.equal(live, 0, 'every CH instance finalized after gc() (tracker size -> 0)');
});

test('M2 (kill): setWeights copies the LAST weight w[cap-1] -- the rebuild honours it (CH + BL)', () => {
    // The existing setWeights test changes no weight away from the default at index cap-1 (1 + 15%5 == 1
    // == the fill default), so a copy loop that stops one short (`i < cap - 1`) is invisible there. Here
    // ONLY w[cap-1] moves, from 1 to a dominating 1000, so the last backend must own the vast majority of
    // the Maglev slots after the rebuild; a loop that skips the last element leaves it at ~1/N share.
    const N = 4, m = 257, last = N - 1;
    const cases = [
        ['ConsistentHash', () => new ConsistentHashBalancer(N, up(N), Uint32Array.from([1, 1, 1, 1]), m)],
        // BoundedLoad inherits setWeights verbatim; with inflight all-0 and no notes (_total === 0) its
        // cap test is skipped, so pick(slot) returns the pure Maglev home -- the same table observable.
        ['BoundedLoad', () => new BoundedLoadBalancer(N, up(N), new Uint32Array(N), 0.25, Uint32Array.from([1, 1, 1, 1]), m)],
    ];
    for (const [name, make] of cases) {
        const b = make();
        b.setWeights(Uint32Array.from([1, 1, 1, 1000]));   // only w[cap-1] changes: 1 -> 1000
        let owned = 0;
        for (let slot = 0; slot < m; slot++) if (b.pick(slot) === last) owned++;
        assert.ok(owned > m / 2, name + ': backend ' + last + ' owns the majority of slots after reweighting (got ' +
            owned + '/' + m + '); the M2 mutant skips w[cap-1] -> ~' + Math.floor(m / N) + ' slots');
    }
});

// Local prime check for the K9 prerequisites (independent of the kernel's internal chIsPrime).
function chIsPrimeLocal(n) {
    if (!Number.isInteger(n) || n < 2) return false;
    if (n % 2 === 0) return n === 2;
    for (let d = 3; d * d <= n; d += 2) if (n % d === 0) return false;
    return true;
}
