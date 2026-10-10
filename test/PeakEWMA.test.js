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
 *   L4. (1.1.0) the update is Finagle's observe() exactly: 10 ms, one tau, then 5 ms -> 6.84 ms.
 *   D4. (1.1.0) the unsampled-busy price is a DECAYING pool mean that follows a latency-regime change.
 *   K6. (1.2.0) "unsampled" is the `_sampled` bitmap, not a negative `_stamp`: ANY finite clock learns.
 *       A run at `now - 2^40` is bit-identical to the run at `now` (picks, _ewma, _samp[0..1], ewmaAt);
 *       the blend, the busy floor and the pool-mean decay work at a negative / zero-crossing clock; the
 *       now >= 0 behaviour is byte-identical to 1.1.1 (test/fixtures/peak-k6-head.json, cut from HEAD).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
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

test('A7: recordRtt validates index, sample, now', () => {
    const b = new PeakEwmaBalancer(4, up(4), new Uint32Array(4), TAU);
    // M1: the index is validated by the shared _vIdx helper -> RangeError (a string index coerces to a
    // different value under >>> 0), consolidating the old typeof-first index check.
    assert.throws(() => b.recordRtt('0', 1, 1), RangeError);
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
    // unsampled marker (1.2.0: the _sampled bitmap), cost = (inflight+1) x 1 undecayed -> the lower-inflight node wins.
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

// --- H1 (kernel): cold-start + busy-floor pricing -- a black hole must become MORE expensive. ---

test('H1: an unsampled IDLE node gets the free probe (cost 0)', () => {
    // node 0 sampled at 1ms; node 1 unsampled and idle -> cost 0 -> the idle cold node is explored.
    const inflight = Uint32Array.from([0, 0]);
    const b = new PeakEwmaBalancer(2, up(2), inflight, TAU, 0xC0FFEE);
    b.recordRtt(0, 1e6, 0);                  // node 0: a real 1ms sample; node 1 stays unsampled
    for (let i = 0; i < 500; i++) assert.equal(b.pick(0), 1, 'the idle unsampled node (cost 0) must win');
});

test('H1: an unsampled BUSY node is priced at the pool mean, not 1.0 (no black hole)', () => {
    // node 0 sampled at 1ms, idle; node 1 unsampled but BUSY (5 in flight). Old code priced node 1 at
    // (5+1)*1.0 = 6 and it beat node 0 (1e6); now it is (5+1)*mean = 6e6 and loses.
    const inflight = Uint32Array.from([0, 5]);
    const b = new PeakEwmaBalancer(2, up(2), inflight, TAU, 0xC0FFEE);
    b.recordRtt(0, 1e6, 0);                  // only node 0 sampled -> mean = 1e6
    for (let i = 0; i < 500; i++) assert.equal(b.pick(0), 0, 'a busy cold node must not beat a healthy 1ms node');
});

test('H1: a hung sampled node (inflight>0, long dt) is floored at dt and loses to a healthy peer', () => {
    const tau = 1e6;
    const inflight = Uint32Array.from([0, 5]);   // node 1 is busy and about to hang
    const b = new PeakEwmaBalancer(2, up(2), inflight, tau, 0xC0FFEE);
    const t0 = 1000;
    b.recordRtt(0, 1e6, t0);
    b.recordRtt(1, 1e6, t0);                 // both last sampled at t0 with the same latency
    const now = t0 + 1e9;                    // a long time passes with node 1 still in flight (hung)
    // node 0 idle: cost ~ decayed EWMA ~ 0. node 1 busy: base = max(decayed, dt) = dt = ~1e9 -> huge.
    for (let i = 0; i < 500; i++) assert.equal(b.pick(now), 0, 'the hung busy node must lose to the healthy peer');
});

test('H1/L6: a negative dt is clamped in pick (no exp(+x) inflation)', () => {
    const tau = 1e6;
    const inflight = new Uint32Array(2);
    const b = new PeakEwmaBalancer(2, up(2), inflight, tau, 0xC0FFEE);
    const stamp = 1e9;
    b.recordRtt(0, 1e6, stamp);              // node 0 cheaper
    b.recordRtt(1, 2e6, stamp);              // node 1 pricier
    // Pick at now < stamp: unclamped dt = -1e9 -> exp(+1000) = Infinity would make both costs Inf and
    // flip the winner ~50% of the time. Clamped dt = 0 -> node 0 (1e6) beats node 1 (2e6) every time.
    for (let i = 0; i < 500; i++) assert.equal(b.pick(0), 0, 'clamped negative dt must not inflate/flip the pick');
});

test('L6: a negative dt is clamped in recordRtt and ewmaAt (no inflation)', () => {
    const tau = 1e6;
    const b = new PeakEwmaBalancer(2, up(2), new Uint32Array(2), tau);
    b.recordRtt(0, 1e6, 1000);
    // ewmaAt with now < stamp: clamp dt to 0 -> exactly the stored 1e6 (no exp(+x) blow-up).
    assert.equal(b.ewmaAt(0, 500), 1e6, 'ewmaAt clamps a negative dt');
    // recordRtt with now < previous stamp and a smaller sample: clamp -> ewma stays 1e6, never inflates.
    b.recordRtt(0, 500, 500);
    assert.equal(b._ewma[0], 1e6, 'recordRtt clamps a negative dt (no inflation of the stored estimate)');
});

test('D4: _samp[0] / _samp[1] are the exactly decayed sample sum / count (tau -> large recovers the plain mean)', () => {
    const b = new PeakEwmaBalancer(4, up(4), new Uint32Array(4), TAU);
    const samples = [[0, 100, 10], [1, 250, 400000], [0, 300, 900000], [2, 50, 2500000], [3, 1000, 2600000]];
    let sum = 0, cnt = 0, last = 0;
    for (const [i, rtt, t] of samples) {
        b.recordRtt(i, rtt, t);
        const w = Math.exp(-(t - last) / TAU);
        sum = sum * w + rtt; cnt = cnt * w + 1; last = t;
    }
    assert.equal(b._samp[0], sum, 'decayed sample sum exact');
    assert.equal(b._samp[1], cnt, 'decayed sample count exact');
    assert.equal(b._samp[2], 2600000, 'the time of the newest sample');
    const slow = new PeakEwmaBalancer(4, up(4), new Uint32Array(4), 1e300);   // tau >> every gap
    for (const [i, rtt, t] of samples) slow.recordRtt(i, rtt, t);
    assert.equal(slow._samp[0], 1700, 'with no decay the sum is the plain sum');
    assert.equal(slow._samp[1], samples.length, 'and the count the plain count');
});

test('L4: the blend is Finagle observe() exactly -- 10 ms, one tau, then 5 ms gives 6.84 ms (1.0.x: 4.51)', () => {
    const tau = 1e9, w = Math.exp(-1);
    const b = new PeakEwmaBalancer(2, up(2), new Uint32Array(2), tau);
    b.recordRtt(0, 10e6, 0);
    b.recordRtt(0, 5e6, tau);
    assert.ok(Math.abs(b._ewma[0] - 6.84e6) < 0.01e6, 'research/1.1.0 5.1 example: ' + b._ewma[0]);
    assert.equal(b._ewma[0], 10e6 * w + 5e6 * (1 - w), 'value x w + sample x (1 - w)');
    // The peak compares with the STORED value, not the decayed one: 8 ms is below the stored 10 ms, so
    // it BLENDS (8.74 ms) -- 1.0.x compared with the decayed 3.68 ms and snapped to 8 ms.
    const c = new PeakEwmaBalancer(2, up(2), new Uint32Array(2), tau);
    c.recordRtt(0, 10e6, 0);
    c.recordRtt(0, 8e6, tau);
    assert.equal(c._ewma[0], 10e6 * w + 8e6 * (1 - w));
    // Above the stored value it snaps, whatever the age.
    c.recordRtt(0, 20e6, 50 * tau);
    assert.equal(c._ewma[0], 20e6, 'a sample above the stored estimate replaces it');
    // Continuous at the boundary: a sample EQUAL to the stored value leaves it unchanged at any dt.
    const d = new PeakEwmaBalancer(2, up(2), new Uint32Array(2), tau);
    d.recordRtt(0, 7e6, 0);
    d.recordRtt(0, 7e6, 3 * tau);
    assert.ok(Math.abs(d._ewma[0] - 7e6) < 1e-6, 'sample == stored value is a fixed point');
});

test('D4: the unsampled-busy price follows a latency-regime change (a lifetime mean would not)', () => {
    // Node 2 (down: never picked) feeds the pool 10 ms for 20 tau, then 1 ms for 20 tau. Node 0 is
    // sampled at 3 ms and idle; node 1 is UNSAMPLED with one request in flight -> cost 2 x pool mean.
    // Decaying mean ~1 ms -> node 1 costs ~2 ms and wins. A lifetime mean (5.5 ms -> 11 ms) loses to 3 ms.
    const tau = 1e6, el = Uint8Array.from([1, 1, 0]), inf = Uint32Array.from([0, 1, 0]);
    const b = new PeakEwmaBalancer(3, el, inf, tau, 0xC0FFEE);
    let now = 0;
    for (let k = 0; k < 2000; k++) { now += tau / 100; b.recordRtt(2, 10e6, now); }
    const slowMean = b._samp[0] / b._samp[1];
    assert.ok(Math.abs(slowMean - 10e6) < 1, 'a constant stream: the mean IS the sample (' + slowMean + ')');
    for (let k = 0; k < 2000; k++) { now += tau / 100; b.recordRtt(2, 1e6, now); }
    const mean = b._samp[0] / b._samp[1];
    assert.ok(mean < 1.001e6, 'after 20 tau the mean has followed the new regime: ' + mean);
    b.recordRtt(0, 3e6, now);
    for (let i = 0; i < 500; i++) assert.equal(b.pick(now), 1, 'the busy cold node is priced at the CURRENT mean');
});

test('D4: the pool mean never goes NaN -- an overflowed sum restarts after a long gap; a backwards clock decays nothing', () => {
    const tau = 1e6;
    const b = new PeakEwmaBalancer(2, up(2), new Uint32Array(2), tau);
    b.recordRtt(0, 1.7e308, 0);
    b.recordRtt(1, 1.7e308, 0);
    assert.equal(b._samp[0], Infinity, 'the sum overflows (disclosed)');
    b.recordRtt(0, 5e5, 1e4 * tau);           // exp(-1e4) === 0: Infinity x 0 would be NaN
    assert.equal(b._samp[0], 5e5, 'the sum restarts at the sample');
    assert.ok(Number.isFinite(b._samp[1]) && b._samp[1] === 1, 'the count restarts at 1');
    const c = new PeakEwmaBalancer(2, up(2), new Uint32Array(2), tau);
    c.recordRtt(0, 100, 5000);
    c.recordRtt(1, 300, 1000);                // a backwards reading: weight 1, no decay, newest time kept
    assert.equal(c._samp[0], 400);
    assert.equal(c._samp[1], 2);
    assert.equal(c._samp[2], 5000, 'the pool stamp never moves backwards');
});

test('M1: recordRtt rejects a non-integer index; no sample recorded', () => {
    const b = new PeakEwmaBalancer(4, up(4), new Uint32Array(4), TAU);
    for (const bad of [1.5, NaN, '2', -1, 4]) {
        assert.throws(() => b.recordRtt(bad, 1000, 1), RangeError, 'recordRtt(' + String(bad) + ')');
    }
    assert.equal(b._samp[1], 0, 'no sample recorded after a rejected recordRtt');
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

// --- K6 (1.2.0): offset / negative clocks. "Unsampled" is the _sampled bitmap, not a negative _stamp. ---

const SHIFT = 2 ** 40;   // 1.0995e12: every shifted clock below is negative, every value an exact integer

/** A seeded control PRNG for the K6 programs (never the balancer's own). */
function k6rnd(seed) {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        let x = s ^ (s >>> 15);
        x = Math.imul(x, 0x2c1b3c6d) >>> 0;
        return (x ^ (x >>> 12)) >>> 0;
    };
}

/** A test-only spy: records every candidate draw of the CURRENT pick so the driver can see the arm it prices. */
class DrawSpy extends PeakEwmaBalancer {
    _draw() { const x = super._draw(); if (this._spy !== null) this._spy.push(x); return x; }
}

/**
 * Drive a 16-node balancer for 2000 steps on an INTEGER clock starting at `t0` (interleaved nodes, or a
 * non-monotonic clock), churning inflight so the busy floor and the unsampled-busy mean are both live.
 * The node index has its OWN stream (independent of the op / sample / clock / inflight stream), and nodes
 * 12..15 take no sample before step 1000, so the unsampled-and-busy arm is priced for half the run.
 * Returns the per-step trace (the pick, then _ewma, _samp[0..1] and ewmaAt for every node) and coverage
 * counts: `blend` records on a sampled node at or below its estimate (the exp-blend arm, not first-sample /
 * peak), `backwards` clock steps, and `unsampledBusy` pick candidates (first and final draw) that were
 * unsampled with inflight > 0 when priced.
 */
function k6trace(mode, t0) {
    const n = 16, inflight = new Uint32Array(n);
    const b = new DrawSpy(n, up(n), inflight, TAU, 0x2222);
    b._spy = null;
    const rnd = k6rnd(0x5555), rndNode = k6rnd(0x7777);
    const picks = [], state = [], drawn = [];
    let now = t0, blend = 0, backwards = 0, unsampledBusy = 0;
    for (let k = 0; k < 2000; k++) {
        const i = rndNode() % n;
        const sample = (rnd() % 1000) + (rnd() % 100) / 100;
        const step = mode === 'backwardsClock' && (rnd() & 3) === 0 ? -(rnd() % 500) : 100 + (rnd() % 1000);
        if (step < 0) backwards++;
        now += step;
        inflight[rnd() % n] = rnd() % 3;
        if (((k & 1) === 0 || k < 64) && (i < 12 || k >= 1000)) {
            if (b._sampled[i] === 1 && !(sample > b._ewma[i])) blend++;
            b.recordRtt(i, sample, now);
        }
        drawn.length = 0;
        b._spy = drawn;
        picks.push(b.pick(now));
        b._spy = null;
        if (drawn.length >= 2) {
            const c0 = drawn[0], c1 = drawn[drawn.length - 1];
            if (b._sampled[c0] === 0 && inflight[c0] > 0) unsampledBusy++;
            if (c1 !== c0 && b._sampled[c1] === 0 && inflight[c1] > 0) unsampledBusy++;
        }
        const row = [b._samp[0], b._samp[1]];
        for (let j = 0; j < n; j++) row.push(b._ewma[j], b.ewmaAt(j, now));
        state.push(row);
    }
    return { b, picks, state, now, blend, backwards, unsampledBusy };
}

for (const mode of ['interleaved', 'backwardsClock']) {
    test('K6-translate (' + mode + '): a run at now - 2^40 is bit-identical to the run at now', () => {
        const a = k6trace(mode, 1e9);
        const z = k6trace(mode, 1e9 - SHIFT);
        assert.ok(z.now < 0, 'the shifted clock is negative throughout');
        // Coverage floors, so the equality below is not vacuous. Measured (darwin / arm64, Node 26):
        // interleaved blend 766 / unsampled-busy 360; backwardsClock blend 770 / backwards 488 /
        // unsampled-busy 316. Floors sit ~20% below the measured values; the streams are seeded, so a
        // drop below a floor means the driver stopped reaching the arm, not noise.
        assert.ok(z.blend >= 600, 'blend records ' + z.blend + ' < 600');
        assert.ok(z.unsampledBusy >= 250, 'unsampled-and-busy candidates ' + z.unsampledBusy + ' < 250');
        if (mode === 'backwardsClock') assert.ok(z.backwards >= 400, 'backwards clock steps ' + z.backwards + ' < 400');
        let pickEq = 0;
        for (let k = 0; k < a.picks.length; k++) if (a.picks[k] === z.picks[k]) pickEq++;
        assert.equal(pickEq, 2000, 'picks equal: ' + pickEq + '/2000');
        for (let k = 0; k < a.state.length; k++) {
            const ra = a.state[k], rz = z.state[k];
            for (let c = 0; c < ra.length; c++) {
                if (!Object.is(ra[c], rz[c])) assert.fail('step ' + k + ' column ' + c + ': ' + ra[c] + ' !== ' + rz[c]);
            }
        }
        let ewmaEq = 0;
        for (let j = 0; j < 16; j++) if (Object.is(a.b._ewma[j], z.b._ewma[j])) ewmaEq++;
        assert.equal(ewmaEq, 16, '_ewma bit-equal: ' + ewmaEq + '/16');
        assert.equal(a.b._samp[2] - z.b._samp[2], SHIFT, '_samp[2] differs by exactly 2^40');
        assert.equal(z.b.describe().sampled, 16, 'every node learned at a negative clock (1.1.1: 0)');
        z.b.assertConsistent();
    });
}

test('K6-blend: the Finagle blend runs at a negative now (1000 @ -5e6, then 100 @ -4e6, tau 1e6)', () => {
    const b = new PeakEwmaBalancer(2, up(2), new Uint32Array(2), 1e6);
    b.recordRtt(0, 1000, -5e6);
    b.recordRtt(0, 100, -4e6);
    const w = Math.exp(-1);
    assert.equal(b._ewma[0], 1000 * w + 100 * (1 - w), 'blended, not re-initialized (1.1.1: 100)');
    assert.equal(b.ewmaAt(0, -4e6), b._ewma[0], 'ewmaAt at the sample time is the stored estimate');
    assert.equal(b.ewmaAt(0, -3e6), b._ewma[0] * Math.exp(-1), 'and it decays on read');
    assert.equal(b._samp[1], 1 * w + 1, 'the pool count decayed across the negative gap');
    assert.equal(b._samp[2], -4e6, 'the pool stamp is the newest (negative) time');
});

test('K6: the busy floor holds at a negative now (a hung node loses to a healthy busy peer)', () => {
    const inflight = Uint32Array.from([1, 1]);
    const b = new PeakEwmaBalancer(2, up(2), inflight, TAU, 0xC0FFEE);
    const now = -1e9 + 1e7;
    b.recordRtt(0, 100, -1e9);               // node 0: fast once, then hung for 1e7 ns
    b.recordRtt(1, 1000, now - 10);          // node 1: healthy, sampled just now
    // node 0 cost = 2 x max(100 e^-10, 1e7) = 2e7; node 1 = 2 x ~1000. 1.1.1 priced both at the mean (a coin flip).
    for (let i = 0; i < 1000; i++) assert.equal(b.pick(now), 1, 'the hung node must lose at a negative clock');
});

test('K6: a zero-crossing clock (-1e6 -> +1e6) learns exactly as its positive translate', () => {
    const run = (off) => {
        const inflight = new Uint32Array(8);
        const b = new PeakEwmaBalancer(8, up(8), inflight, TAU, 0xBEEF);
        const rnd = k6rnd(0x77);
        const picks = [];
        for (let t = -1e6; t <= 1e6; t += 1000) {
            inflight[rnd() & 7] = rnd() & 1;
            b.recordRtt(rnd() & 7, (rnd() % 5000) + 0.25, t + off);
            picks.push(b.pick(t + off));
        }
        return { b, picks };
    };
    const neg = run(0), pos = run(2 ** 30);
    assert.deepEqual(neg.picks, pos.picks, 'pick stream identical across the zero crossing');
    for (let j = 0; j < 8; j++) assert.ok(Object.is(neg.b._ewma[j], pos.b._ewma[j]), '_ewma[' + j + '] bit-equal');
    assert.ok(Object.is(neg.b._samp[0], pos.b._samp[0]) && Object.is(neg.b._samp[1], pos.b._samp[1]), '_samp[0..1] bit-equal');
    assert.equal(neg.b.describe().sampled, 8);
});

test('K6: a fresh node reads its undecayed 1.0 baseline at any clock magnitude or sign', () => {
    const b = new PeakEwmaBalancer(4, up(4), new Uint32Array(4), TAU);
    for (const now of [1e18, -1e18, 0, -0, -1, 1.7e15]) {
        for (let i = 0; i < 4; i++) assert.equal(b.ewmaAt(i, now), 1.0, 'ewmaAt(' + i + ', ' + now + ')');
    }
    assert.equal(b.describe().sampled, 0);
    assert.equal(b._samp[2], -Number.MAX_VALUE, 'the pool stamp seeds to the running-max identity');
});

test('K6: assertConsistent checks the sampled bitmap against the pool mean', () => {
    const b = new PeakEwmaBalancer(8, up(8), new Uint32Array(8), TAU);
    b.assertConsistent();                    // fresh: no node sampled, count 0
    b.recordRtt(2, 500, -7);
    b.assertConsistent();
    b._sampled[3] = 2;
    assert.throws(() => b.assertConsistent(), (e) => e.code === 'LITE_PICK_INCONSISTENT' && /_sampled\[3\] is 2/.test(e.message));
    const c = new PeakEwmaBalancer(8, up(8), new Uint32Array(8), TAU);
    c._sampled[5] = 1;                       // marked sampled, but the pool mean has no sample
    assert.throws(() => c.assertConsistent(), (e) => e.code === 'LITE_PICK_INCONSISTENT');
    const d = new PeakEwmaBalancer(8, up(8), new Uint32Array(8), TAU);
    d.recordRtt(0, 500, 1);
    d._sampled[0] = 0;                       // a sample in the mean, but no node marked
    assert.throws(() => d.assertConsistent(), (e) => e.code === 'LITE_PICK_INCONSISTENT');
});

/**
 * Fixture parity (K6 TASK 0): the 5 StreamParity peakMode programs, folding per step every node's sampled
 * flag, its _stamp where sampled, ewmaAt(j, now) and describe().sampled. The fixture was cut from
 * `git show HEAD:Pick.js` at 1.1.1 (where "sampled" was `_stamp >= 0`), so the now >= 0 behaviour of the
 * bitmap is proven byte-identical to the sentinel's. The driver mirrors test/stream-program.mjs peakMode.
 */
const _dv = new DataView(new ArrayBuffer(8));
function fU32(h, v) {
    v >>>= 0;
    for (let s = 0; s < 32; s += 8) { h ^= (v >>> s) & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
    return h;
}
function fF64(h, x) { _dv.setFloat64(0, x); return fU32(fU32(h, _dv.getUint32(0)), _dv.getUint32(4)); }
function k6capture(mode) {
    const n = 16, inflight = new Uint32Array(n);
    const b = new PeakEwmaBalancer(n, up(n), inflight, 1e6, 0x2222);
    const rnd = k6rnd(0x5555);
    let h = 0x811c9dc5 >>> 0, now = mode === 'fracClock' ? 1.7e15 : 1e9;
    for (let k = 0; k < 2000; k++) {
        const i = mode === 'backToBack' ? 5 : (rnd() % n);
        const sample = (rnd() % 1000) + (rnd() % 100) / 100;
        if (mode === 'batchOneNow') { if ((k % 8) === 0) now += 1000 + (rnd() % 1000); }
        else if (mode === 'backwardsClock') now += ((rnd() & 3) === 0) ? -(rnd() % 500) : (rnd() % 1000);
        else if (mode === 'fracClock') now += 1000 + (rnd() % 4096) + (rnd() % 4) * 0.25;
        else now += 100 + (rnd() % 1000);
        b.recordRtt(i, sample, now);
        for (let j = 0; j < n; j++) {
            const sj = b._sampled[j] === 1;
            h = fU32(h, sj ? 1 : 0);
            if (sj) h = fF64(h, b._stamp[j]);
            h = fF64(h, b.ewmaAt(j, now));
        }
        h = fU32(h, b.describe().sampled);
        b.pick(now);
    }
    const stamp = [], ewmaAt = [];
    for (let j = 0; j < n; j++) { stamp.push(b._sampled[j] === 1 ? b._stamp[j] : null); ewmaAt.push(b.ewmaAt(j, now)); }
    return { digest: (h >>> 0).toString(16).padStart(8, '0'), finalNow: now, finalSampled: b.describe().sampled, finalStamp: stamp, finalEwmaAt: ewmaAt };
}

test('K6: the bitmap is byte-identical to the 1.1.1 sentinel for now >= 0 (fixture cut from HEAD)', () => {
    const fx = JSON.parse(readFileSync(new URL('./fixtures/peak-k6-head.json', import.meta.url), 'utf8'));
    const modes = Object.keys(fx.modes);
    assert.deepEqual(modes, ['backToBack', 'interleaved', 'batchOneNow', 'backwardsClock', 'fracClock']);
    for (const m of modes) assert.deepEqual(k6capture(m), fx.modes[m], 'peakMode ' + m + ' drifted from the 1.1.1 fixture');
});

test('K6 retention: 1000 balancers driven on a negative clock are all collected (FinalizationRegistry -> 0)', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc');        // a gc() handle without a CLI flag (node --test runs this file)
    let live = 0;
    const reg = new FinalizationRegistry(() => { live--; });
    const churn = () => {
        const fb = new Float64Array(2);
        for (let c = 0; c < 1000; c++) {
            const inflight = new Uint32Array(64);
            const b = new PeakEwmaBalancer(64, up(64), inflight, TAU, c + 1);
            const t0 = -1.7e15 - c * 1e6;
            for (let k = 0; k < 64; k++) {
                fb[0] = 100 + k + 0.5; fb[1] = t0 + k * 1000;
                b.recordRttFrom(k, fb, 0);
                inflight[b.pick(fb[1])] = k & 3;
            }
            reg.register(b, undefined);      // the held value is a primitive: nothing closes over b
            live++;
        }
    };
    churn();
    assert.equal(live, 1000);
    for (let r = 0; r < 50 && live > 0; r++) {
        gc();
        await new Promise((res) => setTimeout(res, 10));
    }
    assert.equal(live, 0, 'tracker size after gc(): ' + live + ' of 1000 balancers retained');
});
