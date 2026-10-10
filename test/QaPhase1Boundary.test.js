/**
 * @zakkster/lite-pick -- 1.2.0 phase-1 QA boundary matrix (independent oracle, written from the ASSERTIONS,
 * not from the implementation's own tests).
 *
 *     node --test test/QaPhase1Boundary.test.js
 *
 *   A1 K6  PeakEWMA offset clocks: translate equivalence (bit-identical for exact integer shifts, every
 *          wrap point and the 2^53 edge, a clock crossing 0), rounding-level for a fractional shift,
 *          learning on an all-negative clock, -0 / NaN / null / undefined clocks, index boundaries.
 *   A2 K8  all-zero weights -> PICK_NONE in SmoothWRR, WeightedRandom, SED, NQ, ConsistentHash, BoundedLoad
 *          (capacity 1, 2, N; adversarial keys; weight only on DOWN nodes); a sum of exactly 2^32 is NOT zero.
 *   A3     equal-weights setWeights performs no build (STAT_REBUILDS unchanged) for CH / BL / WR, counters
 *          started just below their int32 / uint32 wrap points; WR setWeight compares against the BUILT value.
 *   A4     CODES: frozen, plain, 14 string keys, value === key, /pool re-exports the same object.
 *   A5     CH / BL M boundaries: 2^31-1 accepted (stubbed allocation), 2^31 / 2^32-1 / 2^32 / 2^53-1 / 2^53
 *          rejected before allocation; -1, 0, 1, -0, NaN, Infinity, null, string, 2^30 rejected.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    PICK_NONE, STAT_COUNT, STAT_REBUILDS, CODES,
    PeakEwmaBalancer, SmoothWRRBalancer, WeightedRandomBalancer, SedBalancer, NqBalancer,
    ConsistentHashBalancer, BoundedLoadBalancer,
} from '../Pick.js';
import { CODES as POOL_CODES } from '../Pool.js';

const up = (n) => new Uint8Array(n).fill(1);
const P31 = 2 ** 31, P32 = 2 ** 32, MAXS = Number.MAX_SAFE_INTEGER; // 2^53 - 1

// ---------------------------------------------------------------------------------------------------------
// A1 -- K6 offset clocks
// ---------------------------------------------------------------------------------------------------------

const TAU = 1e6, STEP = 1000, STEPS = 3000;

/** Drive a deterministic closed loop on clock base C; returns { picks, ewma[], mean, sampled }. */
function drive(C, n = 5, seed = 12345) {
    const inflight = new Uint32Array(n);
    const b = new PeakEwmaBalancer(n, up(n), inflight, TAU, seed);
    const picks = new Int32Array(STEPS);
    const open = [];   // [endpoint, startStep]
    for (let k = 0; k < STEPS; k++) {
        const now = C + k * STEP;
        const a = b.pick(now);
        picks[k] = a;
        if (a >= 0) { inflight[a]++; open.push([a, k]); }
        // settle the oldest request every other step with an integer rtt that depends on the endpoint
        if ((k & 1) === 1 && open.length > 0) {
            const [e, s] = open.shift();
            inflight[e]--;
            const rtt = (e + 1) * 7000 + ((k * 31) % 997);
            b.recordRtt(e, rtt, now);
            assert.ok(s <= k);
        }
    }
    const end = C + STEPS * STEP;
    const ewma = [];
    for (let i = 0; i < n; i++) ewma.push(b.ewmaAt(i, end));
    const d = b.describe();
    b.assertConsistent();
    return { picks, ewma, mean: d.poolMeanNs, sampled: d.sampled };
}

test('A1 K6: an integer-offset clock is BIT-IDENTICAL to its translate at every wrap point, crossing 0, and at the 2^53 edge', () => {
    const ref = drive(0);
    assert.ok(ref.sampled === 5, 'reference learns every node (sampled ' + ref.sampled + ')');
    const T = STEPS * STEP;
    const shifts = [
        -1, -(2 ** 30), -(P31 - 1), -P31, -(P32 - 1), -P32, -(2 ** 40), -(MAXS - T), // negative, deep to -2^53
        -(T >> 1),                       // crosses 0 mid-run
        P31 - (T >> 1), P32 - (T >> 1),  // start just below 2^31 / 2^32 so the run crosses the wrap for real
        MAXS - T,                        // the run ENDS exactly at 2^53 - 1
        1, 2 ** 30, P31 - 1,
    ];
    for (const C of shifts) {
        assert.ok(Number.isSafeInteger(C) && Number.isSafeInteger(C + T), 'prerequisite: shift ' + C + ' is exact');
        const got = drive(C);
        let firstDiff = -1;
        for (let k = 0; k < STEPS; k++) if (got.picks[k] !== ref.picks[k]) { firstDiff = k; break; }
        assert.equal(firstDiff, -1, 'C=' + C + ': pick sequence diverges at step ' + firstDiff);
        for (let i = 0; i < 5; i++) {
            assert.ok(Object.is(got.ewma[i], ref.ewma[i]), 'C=' + C + ': ewma[' + i + '] ' + got.ewma[i] + ' vs ' + ref.ewma[i]);
        }
        assert.ok(Object.is(got.mean, ref.mean), 'C=' + C + ': pool mean ' + got.mean + ' vs ' + ref.mean);
        assert.equal(got.sampled, 5, 'C=' + C + ': every node learns');
    }
});

test('A1 K6: a FRACTIONAL offset is rounding-level (rel err < 1e-9), not bit-identical by contract', () => {
    const run = (C) => {
        const b = new PeakEwmaBalancer(3, up(3), new Uint32Array(3), TAU, 7);
        for (let k = 0; k < 400; k++) b.recordRtt(k % 3, 5000 + (k * 37) % 4001, C + k * 1234.5);
        const end = C + 400 * 1234.5;
        return [0, 1, 2].map((i) => b.ewmaAt(i, end)).concat([b.describe().poolMeanNs]);
    };
    const ref = run(0);
    for (const C of [0.1, -0.1, -1e9 - 0.37, -1.7e15 + 0.25, 1e12 + 0.5]) {
        const got = run(C);
        for (let i = 0; i < ref.length; i++) {
            const rel = Math.abs(got[i] - ref[i]) / Math.abs(ref[i]);
            assert.ok(rel < 1e-9, 'C=' + C + ' value ' + i + ': rel err ' + rel);
        }
    }
});

test('A1 K6: an ALL-NEGATIVE clock learns (the fast node wins every idle pick); 1.1.x stayed random', () => {
    for (const base of [-1, -(2 ** 30), -P31, -P32, -(2 ** 40), -(MAXS - 1e7)]) {
        const inflight = new Uint32Array(2);
        const b = new PeakEwmaBalancer(2, up(2), inflight, TAU, 99);
        b.recordRtt(0, 1e6, base);       // slow
        b.recordRtt(1, 1e3, base + 10);  // fast
        let fast = 0;
        for (let k = 0; k < 1000; k++) if (b.pick(base + 20 + k) === 1) fast++;
        assert.equal(fast, 1000, 'base ' + base + ': fast node picked ' + fast + '/1000');
        assert.equal(b.describe().sampled, 2);
        b.assertConsistent();
    }
});

test('A1 K6: -0 clock == +0 clock bit-identically; NaN / Infinity / null / undefined now never throw in pick', () => {
    const mk = () => new PeakEwmaBalancer(4, up(4), new Uint32Array(4), TAU, 3);
    const a = mk(), z = mk();
    a.recordRtt(0, 500, 0); z.recordRtt(0, 500, -0);
    a.recordRtt(1, 900, 0); z.recordRtt(1, 900, -0);
    for (let k = 0; k < 200; k++) assert.equal(z.pick(-0), a.pick(0), 'step ' + k);
    for (let i = 0; i < 4; i++) assert.ok(Object.is(z.ewmaAt(i, -0), a.ewmaAt(i, 0)));
    for (const bad of [NaN, Infinity, -Infinity, null, undefined]) {
        const r = a.pick(bad);
        assert.ok(r >= 0 && r < 4, 'pick(' + bad + ') -> ' + r);
        const r2 = a.pickFrom(new Float64Array([bad]), 0);
        assert.ok(r2 >= 0 && r2 < 4, 'pickFrom(' + bad + ') -> ' + r2);
    }
    assert.ok(a.pickFrom(new Float64Array(1), 5) >= 0, 'pickFrom past the end never throws');
});

test('A1 K6: recordRtt rejects bad now / sample / index and leaves the bitmap untouched', () => {
    const b = new PeakEwmaBalancer(3, up(3), new Uint32Array(3), TAU, 1);
    for (const now of [NaN, Infinity, -Infinity, null, undefined, '5']) {
        assert.throws(() => b.recordRtt(0, 100, now), (e) => e.code === 'LITE_PICK_ARGUMENT', 'now=' + String(now));
    }
    for (const s of [NaN, -1, Infinity, -0.5]) {
        assert.throws(() => b.recordRtt(0, s, 0), (e) => e.code === 'LITE_PICK_ARGUMENT', 'sample=' + s);
    }
    for (const i of [-1, 3, 4, 1.5, NaN, P31 - 1, P31, P32 - 1, P32, MAXS, 2 ** 53]) {
        assert.throws(() => b.recordRtt(i, 100, 0), (e) => e.code === 'LITE_PICK_INDEX', 'i=' + i);
    }
    assert.equal(b.describe().sampled, 0, 'no rejected call marked a node sampled');
    assert.equal(b.describe().poolMeanNs, null);
    b.assertConsistent();
    // re-entrant: the same (i, now) twice, then a NON-monotonic earlier now -- clamps, never inflates
    b.recordRtt(2, 100, -5); b.recordRtt(2, 100, -5); b.recordRtt(2, 50, -1e12);
    assert.equal(b.describe().sampled, 1);
    assert.ok(b.ewmaAt(2, -1e12) <= 100, 'non-monotonic clock never inflates');
    b.assertConsistent();
    // the bitmap is 0/1: a direct corruption is named
    b._sampled[0] = 2;
    assert.throws(() => b.assertConsistent(), (e) => e.code === 'LITE_PICK_INCONSISTENT');
});

// ---------------------------------------------------------------------------------------------------------
// A2 -- K8 all-zero weights -> PICK_NONE in all six weighted strategies
// ---------------------------------------------------------------------------------------------------------

const KEYS = [0, 1, -1, 2 ** 30, P31 - 1, P31, P32 - 1, P32, MAXS, 2 ** 53, NaN, -0, Infinity, -Infinity, undefined, null, 0.5];

const SIX = [
    ['SmoothWRR', (n, el, w) => new SmoothWRRBalancer(n, el, w), false],
    ['WeightedRandom', (n, el, w) => new WeightedRandomBalancer(n, el, w, 5), false],
    ['SED', (n, el, w) => new SedBalancer(n, el, new Uint32Array(n).fill(P32 - 1), w), false],
    ['NQ', (n, el, w) => new NqBalancer(n, el, new Uint32Array(n), w), false],
    ['ConsistentHash', (n, el, w) => new ConsistentHashBalancer(n, el, w, 101), true],
    ['BoundedLoad', (n, el, w) => new BoundedLoadBalancer(n, el, new Uint32Array(n), 0.25, w, 101), true],
];

const pickAll = (b, keyed) => {
    const out = [];
    if (keyed) {
        for (const k of KEYS) out.push(b.pick(k));
        const buf = Uint32Array.from([0, 1, P32 - 1, 12345]);
        for (let i = 0; i < 6; i++) out.push(b.pickFrom(buf, i));   // 4, 5 past the end
    } else {
        for (let k = 0; k < 64; k++) out.push(b.pick());
    }
    return out;
};

test('A2 K8: all-zero weights -> PICK_NONE, never throws, in all six weighted strategies (capacity 1, 2, 7)', () => {
    for (const [name, make, keyed] of SIX) {
        for (const n of [1, 2, 7]) {
            const b = make(n, up(n), new Uint32Array(n));
            const got = pickAll(b, keyed);
            assert.ok(got.every((r) => r === PICK_NONE), name + ' n=' + n + ': all-zero routed ' + got.filter((r) => r !== PICK_NONE).length);
            b.assertConsistent();
        }
    }
});

test('A2 K8: weight only on DOWN nodes (every eligible node weight 0) -> PICK_NONE in all six', () => {
    for (const [name, make, keyed] of SIX) {
        const n = 4, el = Uint8Array.from([1, 0, 1, 0]);
        const b = make(n, el, Uint32Array.from([0, 9, 0, P32 - 1]));
        const got = pickAll(b, keyed);
        assert.ok(got.every((r) => r === PICK_NONE), name + ': routed to a weight-0 / down node ' + got.find((r) => r !== PICK_NONE));
        b.assertConsistent();
    }
});

test('A2 K8 adversarial: weights summing to EXACTLY 2^32 (two x 2^31) or all 2^32-1 are NOT all-zero (a uint32-wrapped sum would read 0)', () => {
    for (const [name, make, keyed] of SIX) {
        for (const w of [Uint32Array.from([P31, P31]), new Uint32Array(7).fill(P32 - 1)]) {
            const b = make(w.length, up(w.length), w);
            const got = pickAll(b, keyed);
            assert.ok(got.every((r) => r >= 0 && r < w.length), name + ' sum=' + w.reduce((s, x) => s + x, 0) + ': got ' + got.find((r) => !(r >= 0)));
            b.assertConsistent();
        }
    }
});

test('A2 K8: all-zero reached by the per-backend writer, then re-weighted, routes again (zero -> one -> zero)', () => {
    for (const [name, make, keyed] of SIX) {
        const n = 3, w = Uint32Array.from([1, 1, 1]);
        const b = make(n, up(n), w);
        const set = (i, v) => (typeof b.setWeight === 'function' ? b.setWeight(i, v) : (w[i] = v)); // SED / NQ read live
        for (let i = 0; i < n; i++) set(i, 0);
        assert.ok(pickAll(b, keyed).every((r) => r === PICK_NONE), name + ': zeroed via setWeight still routes');
        set(n - 1, P32 - 1);
        assert.ok(pickAll(b, keyed).every((r) => r === n - 1), name + ': only node ' + (n - 1) + ' has weight');
        set(n - 1, 0);
        assert.ok(pickAll(b, keyed).every((r) => r === PICK_NONE), name + ': back to all-zero');
        b.assertConsistent();
    }
});

test('A2 K8: BoundedLoad all-zero with the cap ACTIVE (noted load up to 2^32) and after a full pool flap', () => {
    const n = 4, inf = new Uint32Array(n).fill(P32 - 1);
    const b = new BoundedLoadBalancer(n, up(n), inf, 0.25, new Uint32Array(n), 101);
    for (let i = 0; i < n; i++) b.note(i, P32 - 1);   // mirror inflight: noted total 4 x (2^32 - 1) > 2^32
    for (const k of KEYS) assert.equal(b.pick(k), PICK_NONE);
    for (let i = 0; i < n; i++) b.setEligible(i, false);
    for (let i = 0; i < n; i++) b.setEligible(i, true);
    for (const k of KEYS) assert.equal(b.pick(k), PICK_NONE, 'a flap does not resurrect an all-zero table');
    b.assertConsistent();
});

// ---------------------------------------------------------------------------------------------------------
// A3 -- equal-weights setWeights performs no build
// ---------------------------------------------------------------------------------------------------------

const REBUILDERS = [
    ['ConsistentHash', (w) => new ConsistentHashBalancer(w.length, up(w.length), w, 101)],
    ['BoundedLoad', (w) => new BoundedLoadBalancer(w.length, up(w.length), new Uint32Array(w.length), 0.25, w, 101)],
    ['WeightedRandom', (w) => new WeightedRandomBalancer(w.length, up(w.length), w, 5)],
];

test('A3: setWeights equal to the built snapshot -> no build; counters started below the int32 / uint32 wrap cross it for real', () => {
    for (const [name, make] of REBUILDERS) {
        for (const start of [P31 - 1, P32 - 1, MAXS - 2]) {
            const w = Uint32Array.from([0, 1, P31, P32 - 1, 7]);
            const b = make(w);
            const slab = new Float64Array(STAT_COUNT);
            slab[STAT_REBUILDS] = start;
            b.attachStats(slab);
            b.setWeights(Uint32Array.from(w));                 // equal copy
            b.setWeights(Uint32Array.from([0, 1, P31, P32 - 1, 7, 99, 0])); // longer, equal prefix
            assert.equal(slab[STAT_REBUILDS], start, name + ' start=' + start + ': equal setWeights counted a build');
            const changed = Uint32Array.from([0, 1, P31, P32 - 1, 8]);
            b.setWeights(changed);
            assert.equal(slab[STAT_REBUILDS], start + 1, name + ': a changed weight builds once (crosses ' + start + ')');
            b.setWeights(changed);                             // duplicate call
            assert.equal(slab[STAT_REBUILDS], start + 1, name + ': duplicate setWeights is a no-op');
            const zero = new Uint32Array(5);
            b.setWeights(zero); b.setWeights(zero);
            assert.equal(slab[STAT_REBUILDS], start + 2, name + ': all-zero builds once, then skips');
            b.rebuild();
            assert.equal(slab[STAT_REBUILDS], start + 3, name + ': rebuild() is unconditional');
            b.assertConsistent();
        }
    }
});

test('A3: setWeights with the balancer\'s own array (aliasing) skips; bad arrays throw LITE_PICK_ARRAY and count nothing', () => {
    for (const [name, make] of REBUILDERS) {
        const w = Uint32Array.from([3, 1, 4, 1, 5]);
        const b = make(w);
        const slab = new Float64Array(STAT_COUNT); b.attachStats(slab);
        b.setWeights(b._weights);
        b.setWeights(b._weights.subarray(0));
        assert.equal(slab[STAT_REBUILDS], 0, name + ': self-alias counted a build');
        for (const bad of [null, undefined, new Uint32Array(4), new Uint32Array(0), Int32Array.from([3, 1, 4, 1, 5]), [3, 1, 4, 1, 5]]) {
            assert.throws(() => b.setWeights(bad), (e) => e.code === 'LITE_PICK_ARRAY', name + ': ' + String(bad));
        }
        assert.equal(slab[STAT_REBUILDS], 0);
        b.assertConsistent();
    }
});

test('A3: WR setWeight(i, v) compares against _built -- an in-place edit to the SHARED array still rebuilds', () => {
    const w = Uint32Array.from([1, 1, 1, 1]);
    const b = new WeightedRandomBalancer(4, up(4), w, 11);
    const slab = new Float64Array(STAT_COUNT); slab[STAT_REBUILDS] = P32 - 1; b.attachStats(slab);
    w[2] = 0;                       // caller edits the shared array in place
    b.setWeight(2, 0);              // the value is already 0 in _weights, but NOT in _built
    assert.equal(slab[STAT_REBUILDS], P32, 'in-place edit + setWeight must rebuild');
    for (let k = 0; k < 2000; k++) assert.notEqual(b.pick(), 2, 'weight-0 node picked after the rebuild');
    b.setWeight(2, 0);
    b.setWeight(2, -0);             // -0 >>> 0 === 0: same value, no build
    assert.equal(slab[STAT_REBUILDS], P32, 'equal-to-built setWeight is a no-op');
    for (const bad of [-1, P32, 1.5, NaN, Infinity, MAXS]) {
        assert.throws(() => b.setWeight(1, bad), (e) => e.code === 'LITE_PICK_WEIGHT', 'w=' + bad);
    }
    for (const i of [-1, 4, P31, P32 - 1]) {
        assert.throws(() => b.setWeight(i, 1), (e) => e.code === 'LITE_PICK_INDEX', 'i=' + i);
    }
    assert.equal(slab[STAT_REBUILDS], P32, 'rejected calls count nothing');
    b.setWeight(1, P32 - 1);
    assert.equal(slab[STAT_REBUILDS], P32 + 1);
    b.assertConsistent();
});

// ---------------------------------------------------------------------------------------------------------
// A4 -- CODES
// ---------------------------------------------------------------------------------------------------------

test('A4: CODES is a frozen plain object of exactly 14 string keys, value === key, shared with /pool', () => {
    assert.ok(Object.isFrozen(CODES));
    assert.equal(Object.getPrototypeOf(CODES), Object.prototype);
    const keys = Reflect.ownKeys(CODES);
    assert.equal(keys.length, 14);
    for (const k of keys) {
        assert.equal(typeof k, 'string');
        assert.equal(CODES[k], k);
        assert.match(k, /^LITE_PICK_[A-Z_]+$/);
    }
    assert.strictEqual(POOL_CODES, CODES);
    assert.throws(() => { 'use strict'; CODES.LITE_PICK_INDEX = 'x'; }, TypeError);
    assert.throws(() => { CODES.NEW = 'x'; }, TypeError);
    assert.throws(() => Object.defineProperty(CODES, 'LITE_PICK_NONE', { value: 1 }), TypeError);
    assert.equal(CODES.LITE_PICK_INDEX, 'LITE_PICK_INDEX');
    // a real thrown code resolves through the map
    try { new SmoothWRRBalancer(2, up(2), new Uint32Array(2)).setWeight(-1, 1); assert.fail('no throw'); } catch (e) {
        assert.equal(e.code, CODES.LITE_PICK_INDEX);
    }
});

// ---------------------------------------------------------------------------------------------------------
// A5 -- CH / BL table size M: K9 exactly (2^31 - 1), no 2^24 cap in 1.2.0
// ---------------------------------------------------------------------------------------------------------

test('A5: M boundary matrix (CH + BL): 2^31-1 reaches allocation; every invalid M fails closed with LITE_PICK_OPTION before it', () => {
    const SENTINEL = Symbol('alloc');
    const RealU32 = globalThis.Uint32Array;
    class U32Stub extends RealU32 {
        constructor(arg, ...rest) {
            if (typeof arg === 'number' && arg > 0x800000) { const e = new Error('SENTINEL ' + arg); e.sentinel = SENTINEL; throw e; }
            super(arg, ...rest);
        }
    }
    const ctors = [
        ['ConsistentHash', (m) => new ConsistentHashBalancer(4, up(4), null, m)],
        ['BoundedLoad', (m) => new BoundedLoadBalancer(4, up(4), new globalThis.Uint32Array(4), 0.25, null, m)],
    ];
    const reject = [
        [-1, RangeError], [0, RangeError], [1, RangeError], [-0, RangeError], [NaN, RangeError],
        [Infinity, RangeError], [-Infinity, RangeError], [1.5, RangeError], [2 ** 30, RangeError],
        [3, RangeError] /* prime but < capacity 4 */,
        [P31, RangeError], [P31 + 11, RangeError] /* 2147483659, prime */, [P32 - 1, RangeError], [P32, RangeError],
        [MAXS, RangeError], [2 ** 53, RangeError],
        [null, TypeError], ['65537', TypeError], [65537n, TypeError],
    ];
    globalThis.Uint32Array = U32Stub;
    try {
        for (const [name, make] of ctors) {
            assert.throws(() => make(P31 - 1), (e) => e.sentinel === SENTINEL, name + ': 2^31-1 must pass validation');
            assert.throws(() => make(16777259), (e) => e.sentinel === SENTINEL, name + ': a prime just above 2^24 is accepted (no 2^24 cap)');
            for (const [m, T] of reject) {
                assert.throws(() => make(m), (e) => {
                    assert.notEqual(e.sentinel, SENTINEL, name + ': M=' + String(m) + ' reached allocation');
                    assert.ok(e instanceof T, name + ': M=' + String(m) + ' wrong type ' + e);
                    assert.equal(e.code, 'LITE_PICK_OPTION', name + ': M=' + String(m));
                    if (Number.isInteger(m) && m > 2147483647) assert.match(e.message, /2147483647/);
                    return true;
                });
            }
        }
    } finally {
        globalThis.Uint32Array = RealU32;
    }
    // undefined -> the default M (65537) builds for real; a tiny prime M == capacity is legal
    for (const b of [new ConsistentHashBalancer(4, up(4), null, undefined), new ConsistentHashBalancer(2, up(2), null, 2)]) {
        b.assertConsistent();
        for (const k of KEYS) { const r = b.pick(k); assert.ok(r >= 0 && r < b.capacity, 'k=' + k + ' -> ' + r); }
    }
});
