/**
 * @zakkster/lite-pick -- SedBalancer boundary + behaviour suite (M4).
 *
 *     node --test test/SED.test.js
 *
 * Falsifiable assertions (the planner contract for M4 / SED):
 *   A1. EXACT SED MINIMUM: pick() returns the eligible, positive-weight node minimizing
 *       (inflight + 1) / weight (lowest index on a tie).
 *   A2. WEIGHT-0 EXCLUSION: an eligible node with weight 0 is never picked; if every eligible
 *       node has weight 0, pick() fails closed.
 *   A3. WEIGHTED FAIRNESS: in a feedback loop, load converges to proportional-to-weight
 *       (inflight[i] / weight[i] roughly equal across the pool).
 *   A4. Equal weights reduce SED to least-connections.
 *   A5. pick() never returns a down node; PICK_NONE only when no eligible positive-weight node.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SedBalancer, BalancerBase, PICK_NONE } from '../Pick.js';

const up = (n) => { const e = new Uint8Array(n); e.fill(1); return e; };

test('SedBalancer is a BalancerBase', () => {
    const b = new SedBalancer(3, up(3), new Uint32Array(3), Uint32Array.from([1, 1, 1]));
    assert.ok(b instanceof BalancerBase);
});

test('constructor validates inflight and weights', () => {
    assert.throws(() => new SedBalancer(3, up(3), new Uint32Array(2), new Uint32Array(3)), RangeError);
    assert.throws(() => new SedBalancer(3, up(3), new Uint32Array(3), new Uint32Array(2)), RangeError);
    assert.throws(() => new SedBalancer(3, up(3), new Uint32Array(3), [1, 1, 1]), RangeError);
});

test('A1: returns the exact SED minimum (inflight+1)/weight', () => {
    // node 0: (0+1)/1 = 1.0 ; node 1: (0+1)/3 = 0.333 ; node 2: (2+1)/2 = 1.5
    const b = new SedBalancer(3, up(3), Uint32Array.from([0, 0, 2]), Uint32Array.from([1, 3, 2]));
    assert.equal(b.pick(), 1);
});

test('A2: weight-0 node is never a candidate', () => {
    // node 0 has the lowest raw inflight but weight 0 -> excluded.
    const b = new SedBalancer(3, up(3), Uint32Array.from([0, 5, 5]), Uint32Array.from([0, 1, 1]));
    assert.equal(b.pick(), 1); // (5+1)/1 == node 2, tie -> lowest index 1
});

test('A2: all eligible weights 0 -> fail closed even with the pool up', () => {
    const b = new SedBalancer(4, up(4), new Uint32Array(4), new Uint32Array(4));
    assert.equal(b.live, 4);
    assert.equal(b.pick(), PICK_NONE);
});

test('A3: weighted fairness -- load converges to proportional-to-weight', () => {
    const weights = Uint32Array.from([1, 2, 3, 4]); // sum 10
    const n = weights.length;
    const inflight = new Uint32Array(n);
    const b = new SedBalancer(n, up(n), inflight, weights);
    const TOTAL = 100000;
    for (let i = 0; i < TOTAL; i++) inflight[b.pick()]++;
    // Each node's share should track its weight fraction within a small tolerance.
    for (let i = 0; i < n; i++) {
        const share = inflight[i] / TOTAL;
        const target = weights[i] / 10;
        assert.ok(Math.abs(share - target) < 0.01,
            'node ' + i + ' share ' + share.toFixed(3) + ' should track weight target ' + target.toFixed(3));
    }
});

test('A4: equal weights reduce SED to least-connections', () => {
    const w = Uint32Array.from([1, 1, 1, 1]);
    const inflight = Uint32Array.from([3, 1, 4, 1]);
    const b = new SedBalancer(4, up(4), inflight, w);
    assert.equal(b.pick(), 1); // min inflight, lowest index on tie
});

test('A5 (churn): never returns a down or weight-0 index under flapping', () => {
    const n = 12, el = up(n), inflight = new Uint32Array(n), weights = new Uint32Array(n);
    for (let i = 0; i < n; i++) weights[i] = 1 + (i & 3);
    const b = new SedBalancer(n, el, inflight, weights);
    let s = 0xbeef1234 >>> 0;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
    for (let step = 0; step < 200000; step++) {
        if ((step & 3) === 0) b.setEligible(rnd() % n, (rnd() & 1) === 0);
        const p = b.pick();
        if (p === PICK_NONE) continue; // acceptable when no eligible positive-weight node
        assert.equal(el[p], 1, 'down index at step ' + step);
        assert.ok(weights[p] > 0, 'weight-0 index at step ' + step);
        inflight[p]++;
    }
});
