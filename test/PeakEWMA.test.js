/**
 * @zakkster/lite-pick -- PeakEwmaBalancer boundary + behaviour suite (M7).
 *
 *     node --test test/PeakEWMA.test.js
 *
 * Falsifiable assertions (the planner contract for M7):
 *   A1. COLD START: with zero samples, 1e5 picks are all eligible, never NaN, never PICK_NONE
 *       while live>0; unsampled nodes read ewmaAt ~ 1.0 (graceful least-connections).
 *   A2. SNAP UP: one large rtt sample instantly raises the node's cost (ewmaAt == sample at now).
 *   A3. DECAY: at dt = tau after a sample, ewmaAt has decayed to sample / e within ~1%.
 *   A4. SLOW-NODE AVOIDANCE: a node with 10x EWMA rtt is (almost) never chosen by the two-choice.
 *   A5. FAIL CLOSED: PICK_NONE iff the whole pool is down; a single eligible node is always returned.
 *   A6. TIE-BREAK to the first draw: an all-equal cold pool picks IDENTICALLY to P2C on the same seed.
 *   A7. VALIDATION: the constructor and recordRtt throw typeof-first on bad inputs, before allocation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PeakEwmaBalancer, P2cBalancer, BalancerBase, PICK_NONE } from '../Pick.js';

const up = (n) => { const e = new Uint8Array(n); e.fill(1); return e; };
const TAU = 1e6; // 1 ms half-life in ns

test('PeakEwmaBalancer is a BalancerBase', () => {
    const b = new PeakEwmaBalancer(3, up(3), new Uint32Array(3), TAU);
    assert.ok(b instanceof BalancerBase);
    assert.equal(b.capacity, 3);
});

test('A7: constructor validates inflight, tauNs, capacity (typeof-first)', () => {
    assert.throws(() => new PeakEwmaBalancer(3, up(3), new Uint32Array(2), TAU), RangeError);
    assert.throws(() => new PeakEwmaBalancer(3, up(3), [0, 0, 0], TAU), RangeError);
    assert.throws(() => new PeakEwmaBalancer(0, new Uint8Array(1), new Uint32Array(1), TAU), RangeError);
    assert.throws(() => new PeakEwmaBalancer(3, up(3), new Uint32Array(3), 'nope'), TypeError);
    assert.throws(() => new PeakEwmaBalancer(3, up(3), new Uint32Array(3), 0), RangeError);
    assert.throws(() => new PeakEwmaBalancer(3, up(3), new Uint32Array(3), -1), RangeError);
    assert.throws(() => new PeakEwmaBalancer(3, up(3), new Uint32Array(3), NaN), RangeError);
    assert.throws(() => new PeakEwmaBalancer(3, up(3), new Uint32Array(3), Infinity), RangeError);
});

test('A7: recordRtt validates index, sample, now (typeof-first)', () => {
    const b = new PeakEwmaBalancer(4, up(4), new Uint32Array(4), TAU);
    assert.throws(() => b.recordRtt('0', 1, 1), TypeError);
    assert.throws(() => b.recordRtt(0, '1', 1), TypeError);
    assert.throws(() => b.recordRtt(0, 1, '1'), TypeError);
    assert.throws(() => b.recordRtt(-1, 1, 1), RangeError);
    assert.throws(() => b.recordRtt(4, 1, 1), RangeError);
    assert.throws(() => b.recordRtt(0, -1, 1), RangeError);
    assert.throws(() => b.recordRtt(0, NaN, 1), RangeError);
    assert.throws(() => b.recordRtt(0, Infinity, 1), RangeError);
    assert.throws(() => b.recordRtt(0, 1, NaN), RangeError);
    // A valid call does not throw.
    b.recordRtt(0, 1000, 500);
});

test('A1: cold start -- 1e5 picks all eligible, never NaN, never PICK_NONE while live>0', () => {
    const n = 32;
    const el = Uint8Array.from({ length: n }, (_, i) => (i % 3 === 0 ? 0 : 1)); // ~2/3 up
    const inflight = new Uint32Array(n);
    const b = new PeakEwmaBalancer(n, el, inflight, TAU, 0xC0FFEE);
    assert.ok(b.live > 0);
    for (let i = 0; i < 100000; i++) {
        const now = i; // increasing caller clock
        const p = b.pick(now);
        assert.notEqual(p, PICK_NONE, 'PICK_NONE while live>0 at step ' + i);
        assert.equal(el[p], 1, 'returned down index ' + p);
        assert.ok(Number.isFinite(b.ewmaAt(p, now)), 'non-finite ewmaAt at step ' + i);
    }
    // Unsampled nodes read ~1.0 at now == 0 (graceful least-connections).
    for (let i = 0; i < n; i++) assert.equal(b.ewmaAt(i, 0), 1.0);
});

test('A2: a single large sample SNAPS the cost up instantly', () => {
    const b = new PeakEwmaBalancer(4, up(4), new Uint32Array(4), TAU);
    const now = 5000;
    assert.ok(b.ewmaAt(1, now) < 1e8, 'cold node cost is small before any sample');
    b.recordRtt(1, 1e8, now);
    assert.equal(b.ewmaAt(1, now), 1e8, 'ewma snaps to the sample at the sample time');
    // A subsequent SMALLER sample does not snap down; it eases toward the smaller value.
    b.recordRtt(1, 1000, now); // dt=0 -> w=1 -> e stays 1e8 -> new = 1e8 + (1000-1e8)*0 = 1e8
    assert.equal(b.ewmaAt(1, now), 1e8, 'a smaller sample at dt=0 does not pull the peak down');
});

test('A3: at dt = tau the EWMA decays to sample / e within ~1%', () => {
    const b = new PeakEwmaBalancer(2, up(2), new Uint32Array(2), TAU);
    const t0 = 10000;
    b.recordRtt(0, 1e8, t0);
    const decayed = b.ewmaAt(0, t0 + TAU);
    const expected = 1e8 / Math.E;
    assert.ok(Math.abs(decayed - expected) / expected < 0.01,
        'decayed ' + decayed + ' not within 1% of sample/e ' + expected);
});

test('A3b: cold start under a LARGE clock degrades to LeastConn, not random (0.7.1 regression)', () => {
    // The bug: with _stamp seeded to 0, an unsampled node decays as exp(-now/tau) -> 0 under a real
    // large clock, so every cold cost collapses to ~0 and selection becomes random. With the
    // unsampled sentinel, cost = (inflight+1) x 1 undecayed -> the lower-inflight node wins.
    const NOW = 1e12;                         // a realistic large-magnitude ns clock
    const inflight = Uint32Array.from([0, 5]);
    const b = new PeakEwmaBalancer(2, up(2), inflight, 1e6, 0xC0FFEE);
    for (let i = 0; i < 2000; i++) {
        assert.equal(b.pick(NOW), 0, 'cold pick under large clock must take the lower-inflight node');
    }
    // First recordRtt initializes the EWMA EXACTLY to the sample, regardless of `now` magnitude.
    b.recordRtt(1, 1234, NOW);
    assert.equal(b.ewmaAt(1, NOW), 1234, 'first sample sets ewma exactly, clock-magnitude-independent');
    // And an unsampled node still reads its undecayed baseline at the same large clock.
    assert.equal(b.ewmaAt(0, NOW), 1.0, 'unsampled node reads undecayed baseline under large clock');
});

test('A4: a slow node (10x EWMA rtt) is (almost) never chosen', () => {
    const n = 8;
    const inflight = new Uint32Array(n); // all idle -> the (inflight+1) factor is uniform
    const b = new PeakEwmaBalancer(n, up(n), inflight, 1e12, 42); // huge tau: no decay within the run
    const now = 0;
    b.recordRtt(0, 10e6, now);           // node 0: 10x latency
    for (let i = 1; i < n; i++) b.recordRtt(i, 1e6, now); // the rest: baseline
    const counts = new Uint32Array(n);
    const PICKS = 200000;
    for (let i = 0; i < PICKS; i++) counts[b.pick(now)]++;
    const fairShare = PICKS / n;
    assert.ok(counts[0] < fairShare / 4,
        'slow node got ' + counts[0] + ', should be well below fair share ' + fairShare);
});

test('A5: fail closed when the whole pool is down; single node always returned', () => {
    const down = new PeakEwmaBalancer(4, new Uint8Array(4), new Uint32Array(4), TAU);
    assert.equal(down.pick(0), PICK_NONE);
    const one = new PeakEwmaBalancer(4, Uint8Array.from([0, 1, 0, 0]), new Uint32Array(4), TAU);
    for (let i = 0; i < 100; i++) assert.equal(one.pick(i), 1);
});

test('A6: tie-break to the first draw -- all-equal cold pool matches P2C on the same seed', () => {
    const n = 16;
    const seed = 0xABCDEF;
    const inflight = new Uint32Array(n); // all equal (zero) -> cost tie -> first draw wins
    const pe = new PeakEwmaBalancer(n, up(n), inflight, TAU, seed);
    const p2c = new P2cBalancer(n, up(n), inflight, seed);
    for (let i = 0; i < 5000; i++) {
        assert.equal(pe.pick(0), p2c.pick(), 'tie-break diverged at step ' + i);
    }
});

test('never returns a down index under adversarial flapping', () => {
    const n = 16;
    const el = up(n);
    const inflight = new Uint32Array(n);
    const b = new PeakEwmaBalancer(n, el, inflight, TAU, 7);
    let s = 0x1234abcd >>> 0;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
    for (let step = 0; step < 100000; step++) {
        if ((step & 3) === 0) b.setEligible(rnd() % n, (rnd() & 1) === 0);
        const p = b.pick(step);
        if (p === PICK_NONE) assert.equal(b.live, 0, 'PICK_NONE only when pool empty');
        else {
            assert.equal(el[p], 1, 'down index at step ' + step);
            inflight[p]++;
            if ((step & 7) === 0) b.recordRtt(p, rnd() % 100000, step); // warm feedback churn
        }
    }
});
