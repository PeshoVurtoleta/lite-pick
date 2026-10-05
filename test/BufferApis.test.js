/**
 * @zakkster/lite-pick -- the 1.1.0 zero-box buffer APIs (research/1.1.0-buffer-apis.md, B6).
 *
 *     node --test test/BufferApis.test.js
 *
 * Falsifiable assertions:
 *   Z1. PeakEWMA `pickFrom(buf, i)` selects exactly what `pick(buf[i])` does, step for step, on twin balancers
 *       (same seed, same feedback) -- realistic 1.7e15 clocks included.
 *   Z2. `recordRttFrom(i, buf, j)` leaves byte-identical state (`_ewma`, `_stamp`, `_samp`) to
 *       `recordRtt(i, buf[j], buf[j + 1])`, for fractional samples and large clocks.
 *   Z3. `recordRttFrom` rejects a bad endpoint (LITE_PICK_INDEX), a non-Float64Array / missing slot
 *       (LITE_PICK_ARRAY), a non-finite or negative sample / non-finite now (LITE_PICK_ARGUMENT) -- with no write.
 *   Z4. `pickFrom` never throws for any value or index: past the end it behaves like pick(NaN).
 *   Z5. ConsistentHash / BoundedLoad `pickFrom(buf, i)` == `pick(buf[i])` for keys >= 2^31, negative Int32Array
 *       keys and Float64Array keys (fractions, 2^40, NaN), BoundedLoad also under load.
 *   Z6. The PRNG change is invisible: nextBelow, P2C, WeightedRandom (fast and very-sparse paths) and
 *       PeakEWMA streams match golden fingerprints taken from the pre-B6 kernel (076157e).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    Prng, P2cBalancer, PeakEwmaBalancer, ConsistentHashBalancer, BoundedLoadBalancer, WeightedRandomBalancer,
} from '../Pick.js';

const up = (n) => new Uint8Array(n).fill(1);

function code(fn, Cls, c) {
    assert.throws(fn, (e) => e instanceof Cls && e.code === c, 'expected ' + Cls.name + ' ' + c);
}

function twinsPe(n, seed) {
    const infA = new Uint32Array(n), infB = new Uint32Array(n);
    for (let i = 0; i < n; i++) infA[i] = infB[i] = i & 3;
    return [new PeakEwmaBalancer(n, up(n), infA, 1e6, seed), new PeakEwmaBalancer(n, up(n), infB, 1e6, seed)];
}

function sameState(a, b, msg) {
    assert.deepEqual(Array.from(a._ewma), Array.from(b._ewma), msg + ': _ewma');
    assert.deepEqual(Array.from(a._stamp), Array.from(b._stamp), msg + ': _stamp');
    assert.deepEqual(Array.from(a._samp), Array.from(b._samp), msg + ': _samp');
}

test('Z1/Z2: PeakEWMA pickFrom == pick and recordRttFrom == recordRtt, step for step', () => {
    const [a, b] = twinsPe(64, 0xFEED);
    const clk = new Float64Array(1), fb = new Float64Array(4);
    let t = 1.7e15;
    for (let k = 0; k < 20000; k++) {
        t += 997;
        clk[0] = t;
        const pa = a.pick(t), pb = b.pickFrom(clk, 0);
        assert.equal(pb, pa, 'pick diverged at step ' + k);
        if ((k & 3) === 0) {
            const sample = 1000 + (k % 777) * 13.5;     // fractional: never a small integer
            a.recordRtt(pa, sample, t);
            fb[2] = sample; fb[3] = t;                   // an offset slot pair, not just 0
            b.recordRttFrom(pb, fb, 2);
        }
    }
    sameState(a, b, 'after 20000 steps');
});

test('Z3: recordRttFrom rejects with a code and writes nothing', () => {
    const [b] = twinsPe(4, 1);
    b.recordRtt(1, 500, 10);
    const snap = { e: Array.from(b._ewma), s: Array.from(b._stamp), m: Array.from(b._samp) };
    const ok = new Float64Array([700, 20]);
    code(() => b.recordRttFrom(9, ok, 0), RangeError, 'LITE_PICK_INDEX');
    code(() => b.recordRttFrom(1.5, ok, 0), RangeError, 'LITE_PICK_INDEX');
    code(() => b.recordRttFrom(1, [700, 20], 0), RangeError, 'LITE_PICK_ARRAY');
    code(() => b.recordRttFrom(1, new Float32Array(2), 0), RangeError, 'LITE_PICK_ARRAY');
    code(() => b.recordRttFrom(1, ok, 1), RangeError, 'LITE_PICK_ARRAY');     // slot j + 1 missing
    code(() => b.recordRttFrom(1, ok, -1), RangeError, 'LITE_PICK_ARRAY');
    code(() => b.recordRttFrom(1, ok, 0.5), RangeError, 'LITE_PICK_ARRAY');
    code(() => b.recordRttFrom(1, null, 0), RangeError, 'LITE_PICK_ARRAY');
    code(() => b.recordRttFrom(1, new Float64Array([NaN, 20]), 0), RangeError, 'LITE_PICK_ARGUMENT');
    code(() => b.recordRttFrom(1, new Float64Array([-1, 20]), 0), RangeError, 'LITE_PICK_ARGUMENT');
    code(() => b.recordRttFrom(1, new Float64Array([700, Infinity]), 0), RangeError, 'LITE_PICK_ARGUMENT');
    // The plain method keeps its own codes, now routed through the same body.
    code(() => b.recordRtt(1, '700', 20), TypeError, 'LITE_PICK_ARGUMENT');
    code(() => b.recordRtt(1, 700, NaN), RangeError, 'LITE_PICK_ARGUMENT');
    assert.deepEqual({ e: Array.from(b._ewma), s: Array.from(b._stamp), m: Array.from(b._samp) }, snap, 'no write');
});

test('Z4: pickFrom never throws for any value or index (past the end == pick(NaN))', () => {
    const [a, b] = twinsPe(16, 7);
    const clk = new Float64Array([5e14]);
    for (let k = 0; k < 500; k++) {
        assert.equal(b.pickFrom(clk, 3), a.pick(NaN), 'an index past the end behaves like a non-finite now');
    }
    const el = up(16);
    const ch = new ConsistentHashBalancer(16, el, null, 257);
    const keys = new Uint32Array([123456]);
    assert.equal(ch.pickFrom(keys, 9), ch.pick(NaN));
    assert.equal(ch.pickFrom(keys, 9), ch.pick(0), 'past the end -> key 0');
    for (const v of [NaN, Infinity, -0, 1e300]) {
        const f = new Float64Array([v]);
        assert.equal(b.pickFrom(f, 0) >= 0, true, 'never PICK_NONE while live > 0, now = ' + v);
    }
});

test('Z5: ConsistentHash / BoundedLoad pickFrom(buf, i) == pick(buf[i]) for every key shape', () => {
    const n = 64, w = new Uint32Array(n).map((_, i) => 1 + (i & 7));
    const ch = new ConsistentHashBalancer(n, up(n), w, 4099);
    for (let i = 0; i < n; i += 3) ch.setEligible(i, false);   // exercise the probe path too
    const u = new Uint32Array(4096), s = new Int32Array(4096), f = new Float64Array(4096);
    for (let k = 0; k < 4096; k++) {
        u[k] = (Math.imul(k, 0x9e3779b1) | 0x80000000) >>> 0;   // all >= 2^31
        s[k] = Math.imul(k, 0x85ebca6b) | 0;                     // half negative
        f[k] = k % 7 === 0 ? NaN : (k % 7 === 1 ? 2 ** 40 + k : k * 1.5 - 3000);
    }
    for (let k = 0; k < 4096; k++) {
        assert.equal(ch.pickFrom(u, k), ch.pick(u[k]), 'uint32 key ' + u[k]);
        assert.equal(ch.pickFrom(s, k), ch.pick(s[k]), 'int32 key ' + s[k]);
        assert.equal(ch.pickFrom(f, k), ch.pick(f[k]), 'float64 key ' + f[k]);
    }
    const inf = new Uint32Array(n), bl = new BoundedLoadBalancer(n, up(n), inf, 0.25, w, 4099, 0, 2);
    for (let k = 0; k < 4096; k++) {
        const p = bl.pickFrom(u, k);
        assert.equal(p, bl.pick(u[k]), 'BoundedLoad key ' + u[k]);
        if ((k & 1) === 0) { inf[p]++; bl.note(p, 1); }       // load builds up: the cap path engages
    }
    assert.ok(bl.describe().cap !== null);
});

test('Z6: the PRNG change keeps every random stream bit-identical (golden fingerprints from 076157e)', () => {
    const fnv = () => {
        let h = 0x811c9dc5;
        return {
            add(v) {
                h ^= v & 0xff; h = Math.imul(h, 0x01000193);
                h ^= (v >>> 8) & 0xff; h = Math.imul(h, 0x01000193);
                h ^= (v >>> 16) & 0xff; h = Math.imul(h, 0x01000193);
            },
            get() { return h >>> 0; },
        };
    };
    let f = fnv();
    const r = new Prng(0xC0FFEE);
    for (let i = 0; i < 100000; i++) f.add(r.nextBelow(1 + (i % 1000)));
    assert.equal(f.get(), 3563437827, 'nextBelow stream');

    let N = 64, el = new Uint8Array(N);
    for (let i = 0; i < N; i++) el[i] = (i % 3) ? 1 : 0;
    const p2c = new P2cBalancer(N, el, new Uint32Array(N).map((_, i) => i & 7), 0xBEEF);
    f = fnv();
    for (let i = 0; i < 100000; i++) f.add(p2c.pick());
    assert.equal(f.get(), 2976131386, 'P2C stream');

    el = up(N);
    for (let i = 0; i < N; i += 5) el[i] = 0;
    const wr = new WeightedRandomBalancer(N, el, new Uint32Array(N).map((_, i) => 1 + (i % 9)), 0x5EED);
    f = fnv();
    for (let i = 0; i < 100000; i++) f.add(wr.pick());
    assert.equal(f.get(), 3113922973, 'WeightedRandom fast-path stream');

    N = 2048;
    const sp = new Uint8Array(N); sp[7] = 1; sp[900] = 1; sp[2000] = 1;
    const wrs = new WeightedRandomBalancer(N, sp, new Uint32Array(N).map((_, i) => 1 + (i % 5)), 0xFA11);
    f = fnv();
    for (let i = 0; i < 20000; i++) f.add(wrs.pick());
    assert.equal(f.get(), 2744004901, 'WeightedRandom very-sparse fallback stream');

    const inf = new Uint32Array(32).map((_, i) => i & 3);
    const pe = new PeakEwmaBalancer(32, up(32), inf, 1e6, 0xFEED);
    f = fnv();
    let t = 1e15;
    for (let i = 0; i < 50000; i++) {
        t += 997;
        const p = pe.pick(t);
        f.add(p);
        if ((i & 3) === 0) pe.recordRtt(p, 1000 + (i % 777) * 13.5, t);
    }
    assert.equal(f.get(), 3173007433, 'PeakEWMA pick + recordRtt stream');
});
