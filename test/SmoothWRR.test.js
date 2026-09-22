/**
 * @zakkster/lite-pick -- SmoothWRRBalancer boundary + behaviour suite (M2).
 *
 *     node --test test/SmoothWRR.test.js
 *
 * Falsifiable assertions (the planner contract for M2):
 *   A1. FAIRNESS: over N = k*total picks, each eligible node gets EXACTLY k*weight[i].
 *   A2. SMOOTHNESS: the max run of the same node is strictly LESS than naive
 *       weight-expansion WRR's (which clumps A*weight in a row).
 *   A3. The documented sequence: weights [5,1,1] -> A,A,B,A,C,A,A.
 *   A4. `pick()` never returns a down node, and returns PICK_NONE when the
 *       eligible-weight sum is 0 (all down OR all eligible weights 0).
 *   A5. setWeight / setEligible keep the eligible-weight total exact; eligibility
 *       toggles reset the toggled node's accumulator (no stale credit).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SmoothWRRBalancer, BalancerBase, PICK_NONE } from '../Pick.js';

const up = (n) => { const e = new Uint8Array(n); e.fill(1); return e; };

/** Longest run of an identical value in a sequence. */
function maxRun(seq) {
    let best = 0, run = 0, prev = -2;
    for (const x of seq) { run = x === prev ? run + 1 : 1; prev = x; if (run > best) best = run; }
    return best;
}

/** Naive weight-expansion WRR: cycle [0*w0, 1*w1, ...] -- bursty, the foil. */
function burstyExpand(weights, picks) {
    const list = [];
    for (let i = 0; i < weights.length; i++) for (let k = 0; k < weights[i]; k++) list.push(i);
    const out = [];
    for (let p = 0; p < picks; p++) out.push(list[p % list.length]);
    return out;
}

test('SmoothWRRBalancer is a BalancerBase', () => {
    const b = new SmoothWRRBalancer(3, up(3), Uint32Array.from([1, 1, 1]));
    assert.ok(b instanceof BalancerBase);
    assert.equal(b.capacity, 3);
});

test('A3: weights [5,1,1] yield the documented smooth sequence', () => {
    const b = new SmoothWRRBalancer(3, up(3), Uint32Array.from([5, 1, 1]));
    const seq = [];
    for (let i = 0; i < 7; i++) seq.push(b.pick());
    assert.deepEqual(seq, [0, 0, 1, 0, 2, 0, 0]);
});

test('A1: exact fairness over k full cycles', () => {
    const weights = Uint32Array.from([5, 3, 1, 1]);
    const total = 10;
    const b = new SmoothWRRBalancer(4, up(4), weights);
    const counts = new Uint32Array(4);
    const k = 1000;
    for (let i = 0; i < k * total; i++) counts[b.pick()]++;
    for (let i = 0; i < 4; i++) assert.equal(counts[i], k * weights[i], 'node ' + i);
});

test('A2: smoother than naive weight-expansion WRR', () => {
    const weights = Uint32Array.from([10, 1, 1]);
    const total = 12;
    const b = new SmoothWRRBalancer(3, up(3), weights);
    const picks = total * 50;
    const smooth = [];
    for (let i = 0; i < picks; i++) smooth.push(b.pick());
    const bursty = burstyExpand(weights, picks);
    const sRun = maxRun(smooth), bRun = maxRun(bursty);
    assert.ok(sRun < bRun, 'smooth maxRun ' + sRun + ' should be < bursty maxRun ' + bRun);
    assert.equal(bRun, 10, 'bursty foil clumps the full weight in a row');
});

test('A4: skips down nodes; weight redistributes among the live set', () => {
    const weights = Uint32Array.from([2, 2, 2]);
    const el = Uint8Array.from([1, 0, 1]); // node 1 down
    const b = new SmoothWRRBalancer(3, el, weights);
    const counts = new Uint32Array(3);
    for (let i = 0; i < 4000; i++) counts[b.pick()]++;
    assert.equal(counts[1], 0);
    assert.equal(counts[0], 2000);
    assert.equal(counts[2], 2000);
});

test('A4: fail closed when all down', () => {
    const b = new SmoothWRRBalancer(3, new Uint8Array(3), Uint32Array.from([1, 1, 1]));
    assert.equal(b.pick(), PICK_NONE);
});

test('A4: fail closed when every eligible weight is 0', () => {
    const b = new SmoothWRRBalancer(3, up(3), new Uint32Array(3)); // all weights 0
    assert.equal(b.pick(), PICK_NONE);
    b.setWeight(1, 5); // now one node has weight
    for (let i = 0; i < 10; i++) assert.equal(b.pick(), 1);
});

test('A5: setWeight keeps the total exact and takes effect', () => {
    const weights = Uint32Array.from([1, 1]);
    const b = new SmoothWRRBalancer(2, up(2), weights);
    b.setWeight(0, 9); // 0 should now dominate 9:1
    const counts = new Uint32Array(2);
    for (let i = 0; i < 1000; i++) counts[b.pick()]++;
    assert.equal(counts[0], 900);
    assert.equal(counts[1], 100);
});

test('A5: setWeight validates uint32', () => {
    const b = new SmoothWRRBalancer(2, up(2), Uint32Array.from([1, 1]));
    assert.throws(() => b.setWeight(0, -1), RangeError);
    assert.throws(() => b.setWeight(0, 1.5), RangeError);
    assert.throws(() => b.setWeight(2, 1), RangeError);
});

test('A5: eligibility toggle resets the accumulator (no stale credit)', () => {
    const weights = Uint32Array.from([3, 1, 1]);
    const b = new SmoothWRRBalancer(3, up(3), weights);
    for (let i = 0; i < 20; i++) b.pick();   // build up some accumulator state on node 0
    b.setEligible(0, false);                  // drop it -> accumulator reset to 0
    b.setEligible(0, true);                   // re-admit -> starts fresh, not with old credit
    // With a fresh epoch and weights [3,1,1], the first picks favour 0 but do not burst
    // from stale credit: fairness over a full cycle is exact.
    const counts = new Uint32Array(3);
    for (let i = 0; i < 5000; i++) counts[b.pick()]++;
    assert.equal(counts[0], 3000);
    assert.equal(counts[1], 1000);
    assert.equal(counts[2], 1000);
});

test('A4 (churn): never returns a down index under adversarial flapping', () => {
    const n = 16;
    const el = up(n);
    const weights = new Uint32Array(n);
    for (let i = 0; i < n; i++) weights[i] = 1 + (i % 4);
    const b = new SmoothWRRBalancer(n, el, weights);
    let s = 0x9e3779b9 >>> 0;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
    for (let step = 0; step < 200000; step++) {
        if ((step & 3) === 0) b.setEligible(rnd() % n, (rnd() & 1) === 0);
        if ((step & 15) === 0) b.setWeight(rnd() % n, rnd() % 8);
        const p = b.pick();
        if (p === PICK_NONE) {
            assert.ok(b.live === 0 || b.pick() === PICK_NONE, 'PICK_NONE only when nothing pickable');
        } else {
            assert.equal(el[p], 1, 'returned a DOWN index at step ' + step + ': ' + p);
        }
    }
});

test('constructor validates the weights view', () => {
    assert.throws(() => new SmoothWRRBalancer(3, up(3), Uint32Array.from([1, 1])), RangeError);
    assert.throws(() => new SmoothWRRBalancer(3, up(3), [1, 1, 1]), RangeError);
    assert.throws(() => new SmoothWRRBalancer(0, new Uint8Array(1), new Uint32Array(1)), RangeError);
});
