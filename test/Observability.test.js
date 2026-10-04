/**
 * @zakkster/lite-pick -- 1.1.0 observability (research/1.1.0-kernel-and-api.md section 7, D7; audit H2).
 *
 *     node --test test/Observability.test.js
 *
 * Falsifiable assertions:
 *   E1. Every kernel and Pool throw carries its stable `code` and keeps its error class.
 *   S1. attachStats validates (Float64Array, length >= STAT_COUNT, or null) and `stats` reads it back.
 *   S2. A healthy pick counts NOTHING; each internal event counts exactly once: the P2C / PeakEWMA /
 *       WeightedRandom sparse fallback and the ConsistentHash sweep (STAT_FALLBACK_SCANS), every table
 *       build (STAT_REBUILDS), a keyed pick that leaves its home (STAT_DISPLACED). A shared slab adds up.
 *   D1. describe() for all ten strategies: the right strategy name, base fields, JSON-safe, a snapshot.
 *   D2. util.inspect prints the class name and the describe() fields.
 *   C1. assertConsistent() passes on a clean balancer of every strategy, and throws LITE_PICK_INCONSISTENT
 *       on a direct eligible write, a non-0/1 eligible byte, a direct SmoothWRR / WeightedRandom weight
 *       write, and a BoundedLoad inflight change without note().
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import {
    BalancerBase, RoundRobinBalancer, SmoothWRRBalancer, P2cBalancer, LeastConnBalancer, SedBalancer, NqBalancer,
    PeakEwmaBalancer, ConsistentHashBalancer, BoundedLoadBalancer, WeightedRandomBalancer,
    STAT_FALLBACK_SCANS, STAT_REBUILDS, STAT_DISPLACED, STAT_COUNT, PICK_NONE,
} from '../Pick.js';
import { Pool, liteQueryFetcher } from '../Pool.js';

const up = (n) => new Uint8Array(n).fill(1);
const u32 = (n, v = 1) => new Uint32Array(n).fill(v);

/** Every strategy, freshly built over `n` nodes. */
function all(n) {
    return [
        ['RoundRobin', new RoundRobinBalancer(n, up(n))],
        ['SmoothWRR', new SmoothWRRBalancer(n, up(n), u32(n, 2))],
        ['P2C', new P2cBalancer(n, up(n), u32(n, 0))],
        ['LeastConn', new LeastConnBalancer(n, up(n), u32(n, 0))],
        ['SED', new SedBalancer(n, up(n), u32(n, 0), u32(n, 3))],
        ['NQ', new NqBalancer(n, up(n), u32(n, 0), u32(n, 3))],
        ['PeakEWMA', new PeakEwmaBalancer(n, up(n), u32(n, 0), 1e6)],
        ['ConsistentHash', new ConsistentHashBalancer(n, up(n), null, 257)],
        ['BoundedLoad', new BoundedLoadBalancer(n, up(n), u32(n, 0), 0.25, null, 257)],
        ['WeightedRandom', new WeightedRandomBalancer(n, up(n), u32(n, 2))],
    ];
}

function code(fn, Cls, c) {
    assert.throws(fn, (e) => e instanceof Cls && e.code === c, 'expected ' + Cls.name + ' ' + c);
}

test('E1: every kernel throw carries its code and keeps its class', () => {
    code(() => new RoundRobinBalancer(0, up(1)), RangeError, 'LITE_PICK_CAPACITY');
    code(() => new RoundRobinBalancer(4, up(2)), RangeError, 'LITE_PICK_ARRAY');
    code(() => new BalancerBase(2, up(2)).pick(), Error, 'LITE_PICK_ABSTRACT');
    code(() => new RoundRobinBalancer(2, up(2)).setEligible(5, true), RangeError, 'LITE_PICK_INDEX');
    code(() => new SmoothWRRBalancer(2, up(2), [1, 1]), RangeError, 'LITE_PICK_ARRAY');
    code(() => new SmoothWRRBalancer(2, up(2), u32(2)).setWeight(0, -1), RangeError, 'LITE_PICK_WEIGHT');
    code(() => new P2cBalancer(2, up(2), null), RangeError, 'LITE_PICK_ARRAY');
    code(() => new SedBalancer(2, up(2), u32(2), null), RangeError, 'LITE_PICK_ARRAY');
    code(() => new PeakEwmaBalancer(2, up(2), u32(2), 'x'), TypeError, 'LITE_PICK_OPTION');
    code(() => new PeakEwmaBalancer(2, up(2), u32(2), 0), RangeError, 'LITE_PICK_OPTION');
    const pe = new PeakEwmaBalancer(2, up(2), u32(2), 1e6);
    code(() => pe.recordRtt(0, '1', 1), TypeError, 'LITE_PICK_ARGUMENT');
    code(() => pe.recordRtt(0, -1, 1), RangeError, 'LITE_PICK_ARGUMENT');
    code(() => pe.recordRtt(0, 1, NaN), RangeError, 'LITE_PICK_ARGUMENT');
    code(() => pe.recordRtt(9, 1, 1), RangeError, 'LITE_PICK_INDEX');
    code(() => new ConsistentHashBalancer(2, up(2), null, 'x'), TypeError, 'LITE_PICK_OPTION');
    code(() => new ConsistentHashBalancer(2, up(2), null, 256), RangeError, 'LITE_PICK_OPTION');
    code(() => new ConsistentHashBalancer(8, up(8), null, 7), RangeError, 'LITE_PICK_OPTION');
    code(() => new ConsistentHashBalancer(2, up(2), null, 257).setWeight(0, 1.5), RangeError, 'LITE_PICK_WEIGHT');
    code(() => new ConsistentHashBalancer(2, up(2), null, 257).setWeights([1, 1]), RangeError, 'LITE_PICK_ARRAY');
    code(() => new BoundedLoadBalancer(2, up(2), u32(2), 'x'), TypeError, 'LITE_PICK_OPTION');
    code(() => new BoundedLoadBalancer(2, up(2), u32(2), -1), RangeError, 'LITE_PICK_OPTION');
    code(() => new BoundedLoadBalancer(2, up(2), u32(2), 0.25, null, 257, 1, 'x'), TypeError, 'LITE_PICK_OPTION');
    code(() => new BoundedLoadBalancer(2, up(2), u32(2), 0.25, null, 257, 1, -1), RangeError, 'LITE_PICK_OPTION');
    const bl = new BoundedLoadBalancer(2, up(2), u32(2), 0.25, null, 257);
    code(() => bl.note(0, '1'), TypeError, 'LITE_PICK_ARGUMENT');
    code(() => bl.note(0, 0.5), RangeError, 'LITE_PICK_ARGUMENT');
    code(() => new WeightedRandomBalancer(2, up(2), [1, 1]), RangeError, 'LITE_PICK_ARRAY');
    code(() => new WeightedRandomBalancer(2, up(2), u32(2)).setWeight(0, 2 ** 32), RangeError, 'LITE_PICK_WEIGHT');
    code(() => new RoundRobinBalancer(2, up(2)).attachStats(new Float64Array(STAT_COUNT - 1)), RangeError, 'LITE_PICK_ARRAY');
});

test('E1: every Pool throw and rejection carries a code', async () => {
    code(() => new Pool({}, u32(2)), TypeError, 'LITE_PICK_ARGUMENT');
    const b = new P2cBalancer(2, up(2), u32(2, 0));
    code(() => new Pool(b, new Uint32Array(1)), RangeError, 'LITE_PICK_ARRAY');
    const pool = new Pool(b, u32(2, 0));
    await assert.rejects(pool.run('nope'), (e) => e instanceof TypeError && e.code === 'LITE_PICK_ARGUMENT');
    await assert.rejects(pool.run(() => 1, { failurePenaltyNs: 0 }), (e) => e instanceof RangeError && e.code === 'LITE_PICK_OPTION');
    code(() => liteQueryFetcher({}, () => 1), TypeError, 'LITE_PICK_ARGUMENT');
    code(() => liteQueryFetcher(pool, null), TypeError, 'LITE_PICK_ARGUMENT');
    code(() => liteQueryFetcher(pool, () => 1, { failurePenaltyNs: -1 }), RangeError, 'LITE_PICK_OPTION');
});

test('S1: attachStats validates; stats reads back; null detaches', () => {
    const b = new RoundRobinBalancer(4, up(4));
    assert.equal(b.stats, null, 'no slab by default');
    const slab = new Float64Array(STAT_COUNT);
    b.attachStats(slab);
    assert.equal(b.stats, slab);
    b.attachStats(null);
    assert.equal(b.stats, null);
    for (const bad of [undefined, [0, 0, 0], new Uint32Array(STAT_COUNT), new Float64Array(STAT_COUNT - 1)]) {
        assert.throws(() => b.attachStats(bad), RangeError);
    }
    assert.equal(b.stats, null, 'a rejected slab attaches nothing');
});

test('S2: a healthy pick counts nothing; each internal event counts once', () => {
    const n = 64, slab = new Float64Array(STAT_COUNT);
    const p2c = new P2cBalancer(n, up(n), u32(n, 0));
    p2c.attachStats(slab);
    for (let i = 0; i < 1000; i++) p2c.pick();
    assert.deepEqual(Array.from(slab), [0, 0, 0], 'healthy P2C: nothing counted');

    // P2C sparse fallback: 1 of 2048 up -> the 64 draws almost always miss.
    const sp = new Uint8Array(2048); sp[1500] = 1;
    const p = new P2cBalancer(2048, sp, new Uint32Array(2048)), s1 = new Float64Array(STAT_COUNT);
    p.attachStats(s1);
    let got = 0;
    for (let i = 0; i < 200; i++) if (p.pick() === 1500) got++;
    assert.equal(got, 200);
    assert.ok(s1[STAT_FALLBACK_SCANS] > 150 && s1[STAT_FALLBACK_SCANS] <= 400, 'P2C fallbacks counted: ' + s1[0]);
    // PeakEWMA borrows P2C's _draw and so its fallback.
    const pe = new PeakEwmaBalancer(2048, sp.slice(), new Uint32Array(2048), 1e6), s2 = new Float64Array(STAT_COUNT);
    pe.attachStats(s2);
    for (let i = 0; i < 100; i++) pe.pick(0);
    assert.ok(s2[STAT_FALLBACK_SCANS] > 50, 'PeakEWMA fallbacks counted: ' + s2[0]);
    // WeightedRandom sparse fallback.
    const wr = new WeightedRandomBalancer(2048, sp.slice(), u32(2048, 1)), s3 = new Float64Array(STAT_COUNT);
    wr.attachStats(s3);
    for (let i = 0; i < 100; i++) assert.equal(wr.pick(), 1500);
    assert.ok(s3[STAT_FALLBACK_SCANS] > 90, 'WeightedRandom fallbacks counted: ' + s3[0]);

    // ConsistentHash: rebuilds, displaced, sweep.
    const ch = new ConsistentHashBalancer(n, up(n), null, 257), s4 = new Float64Array(STAT_COUNT);
    ch.attachStats(s4);
    for (let k = 0; k < 1000; k++) ch.pick(k);
    assert.deepEqual(Array.from(s4), [0, 0, 0], 'healthy CH: nothing counted');
    ch.setWeight(3, 5);
    ch.setWeights(u32(n, 2));
    ch.rebuild();
    assert.equal(s4[STAT_REBUILDS], 3, 'setWeight + setWeights + rebuild = 3 builds');
    const homes = new Int32Array(1000);
    for (let k = 0; k < 1000; k++) homes[k] = ch.pick(k);
    ch.setEligible(homes[0], false);
    let moved = 0;
    for (let k = 0; k < 1000; k++) if (homes[k] === homes[0]) moved++;
    for (let k = 0; k < 1000; k++) ch.pick(k);
    assert.equal(s4[STAT_DISPLACED], moved, 'exactly the keys homed on the down backend are displaced');
    assert.equal(s4[STAT_FALLBACK_SCANS], 0);
    // The sweep: every backend down but one -> most keys run past the 64-slot window.
    for (let i = 1; i < n; i++) ch.setEligible(i, i === n - 1);
    ch.setEligible(0, false);
    for (let k = 0; k < 200; k++) assert.equal(ch.pick(k), n - 1);
    assert.ok(s4[STAT_FALLBACK_SCANS] > 0, 'the full-table sweep is counted');

    // BoundedLoad: an over-cap home is displaced even though it is up.
    const inf = u32(4, 0), bl = new BoundedLoadBalancer(4, up(4), inf, 0.25, null, 257), s5 = new Float64Array(STAT_COUNT);
    bl.attachStats(s5);
    const h = bl.pick(7);
    inf[h] = 3; bl.note(h, 3);                 // cap = 1.25 x 4 / 4 = 1.25 -> the home (3) is over
    assert.notEqual(bl.pick(7), h);
    assert.equal(s5[STAT_DISPLACED], 1, 'the over-cap home displaced the key');

    // A shared slab adds up; WeightedRandom counts its builds.
    const shared = new Float64Array(STAT_COUNT);
    const w1 = new WeightedRandomBalancer(4, up(4), u32(4, 1)), w2 = new WeightedRandomBalancer(4, up(4), u32(4, 1));
    w1.attachStats(shared); w2.attachStats(shared);
    w1.rebuild(); w2.setWeight(0, 3); w2.setWeights(u32(4, 2));
    assert.equal(shared[STAT_REBUILDS], 3);
});

test('D1: describe() for every strategy -- name, base fields, JSON-safe, a snapshot', () => {
    for (const [name, b] of all(8)) {
        const d = b.describe();
        assert.equal(d.strategy, name);
        assert.equal(d.capacity, 8);
        assert.equal(d.live, 8);
        assert.equal(d.stats, null);
        assert.deepEqual(JSON.parse(JSON.stringify(d)), d, name + ' snapshot is JSON-safe');
        b.setEligible(0, false);
        assert.equal(d.live, 8, 'a snapshot, not a live view');
        assert.equal(b.describe().live, 7);
        if (d.weights) assert.ok(Array.isArray(d.weights) && d.weights.length === 8, name + ' weights copied');
    }
    const slab = new Float64Array(STAT_COUNT); slab[STAT_REBUILDS] = 4; slab[STAT_DISPLACED] = 2;
    const ch = new ConsistentHashBalancer(4, up(4), null, 257);
    ch.attachStats(slab);
    assert.deepEqual(ch.describe().stats, { fallbackScans: 0, rebuilds: 4, displaced: 2 });

    const inf = u32(4, 0), bl = new BoundedLoadBalancer(4, up(4), inf, 0.25, null, 257, 0, 2);
    assert.equal(bl.describe().cap, null, 'no cap while nothing is in flight');
    inf[1] = 4; bl.note(1, 4);
    const d = bl.describe();
    assert.equal(d.total, 4);
    assert.equal(d.inflight, 4);
    assert.equal(d.minCap, 2);
    assert.equal(d.cap, 2, 'the minCap floor: max(2, 1.25 x 5 / 4)');
    const bl0 = new BoundedLoadBalancer(4, up(4), Uint32Array.from([0, 4, 0, 0]), 0.25, null, 257);
    bl0.note(1, 4);
    assert.equal(bl0.describe().cap, 1.25 * 5 / 4, 'the cap a pick would use: (1 + eps)(T + 1) / live');

    const pe = new PeakEwmaBalancer(4, up(4), u32(4, 0), 1e6);
    assert.equal(pe.describe().poolMeanNs, null);
    pe.recordRtt(2, 500, 10);
    assert.equal(pe.describe().sampled, 1);
    assert.equal(pe.describe().poolMeanNs, 500);
    const wr = new WeightedRandomBalancer(3, up(3), Uint32Array.from([1, 2, 3]));
    assert.equal(wr.describe().weightSum, 6);
});

test('D2: util.inspect prints the class name and the snapshot', () => {
    const b = new SmoothWRRBalancer(3, up(3), Uint32Array.from([5, 1, 1]));
    const s = inspect(b);
    assert.match(s, /^SmoothWRRBalancer \{/);
    assert.match(s, /strategy: 'SmoothWRR'/);
    assert.match(s, /eligibleWeight: 7/);
    assert.match(inspect({ a: { c: b } }, { depth: 1 }), /\[SmoothWRRBalancer\]/, 'past depth: the bare name');
});

test('C1: assertConsistent passes clean, throws LITE_PICK_INCONSISTENT on each misuse', () => {
    for (const [name, b] of all(8)) {
        assert.doesNotThrow(() => b.assertConsistent(), name + ' clean');
        b.setEligible(3, false);
        assert.doesNotThrow(() => b.assertConsistent(), name + ' after setEligible');
        b._eligible[5] = 0;                         // the H2 misuse: a direct write
        code(() => b.assertConsistent(), Error, 'LITE_PICK_INCONSISTENT');
        b._eligible[5] = 1;
        assert.doesNotThrow(() => b.assertConsistent(), name + ' restored');
        b._eligible[5] = 2;
        code(() => b.assertConsistent(), Error, 'LITE_PICK_INCONSISTENT');
    }
    const w = Uint32Array.from([1, 2, 3]);
    const sw = new SmoothWRRBalancer(3, up(3), w);
    w[1] = 9;
    code(() => sw.assertConsistent(), Error, 'LITE_PICK_INCONSISTENT');
    sw.setWeight(1, 2); w[1] = 2;
    const ww = Uint32Array.from([1, 2, 3]), wr = new WeightedRandomBalancer(3, up(3), ww);
    ww[0] = 7;
    code(() => wr.assertConsistent(), Error, 'LITE_PICK_INCONSISTENT');
    wr.rebuild();
    assert.doesNotThrow(() => wr.assertConsistent(), 'rebuild() re-syncs the table');
    const inf = u32(4, 0), bl = new BoundedLoadBalancer(4, up(4), inf, 0.25, null, 257);
    inf[2] = 1;                                     // dispatch without note()
    code(() => bl.assertConsistent(), Error, 'LITE_PICK_INCONSISTENT');
    bl.note(2, 1);
    assert.doesNotThrow(() => bl.assertConsistent());
    assert.notEqual(bl.pick(1), PICK_NONE);
});
