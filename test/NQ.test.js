/**
 * @zakkster/lite-pick -- NqBalancer boundary + behaviour suite (M4).
 *
 *     node --test test/NQ.test.js
 *
 * Falsifiable assertions (the planner contract for M4 / NQ):
 *   A1. IDLE-FIRST: if any eligible positive-weight node is idle (in-flight 0), pick() returns
 *       the FIRST such node -- never queues while a server sits free.
 *   A2. SED FALLBACK: with no idle node, pick() returns the SED minimum ((inflight+1)/weight).
 *   A3. WEIGHT-0 EXCLUSION: a weight-0 node is never picked (even when idle); all-zero-weight
 *       fails closed.
 *   A4. WORKER-POOL FILL: dispatching to idle-first spreads the first n requests across n
 *       distinct idle workers before any second request is queued.
 *   A5. pick() never returns a down node; PICK_NONE only when no eligible positive-weight node.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NqBalancer, BalancerBase, PICK_NONE } from '../Pick.js';

const up = (n) => { const e = new Uint8Array(n); e.fill(1); return e; };

test('NqBalancer is a BalancerBase', () => {
    const b = new NqBalancer(3, up(3), new Uint32Array(3), Uint32Array.from([1, 1, 1]));
    assert.ok(b instanceof BalancerBase);
});

test('constructor validates inflight and weights', () => {
    assert.throws(() => new NqBalancer(3, up(3), new Uint32Array(2), new Uint32Array(3)), RangeError);
    assert.throws(() => new NqBalancer(3, up(3), new Uint32Array(3), new Uint32Array(2)), RangeError);
});

test('A1: idle-first -- returns the first idle node ignoring SED', () => {
    // node 2 is idle (inflight 0); nodes 0,1 are busy. NQ jumps to 2 regardless of weight.
    const b = new NqBalancer(3, up(3), Uint32Array.from([1, 2, 0]), Uint32Array.from([9, 9, 1]));
    assert.equal(b.pick(), 2);
});

test('A1: the FIRST idle node wins (lowest index)', () => {
    const b = new NqBalancer(4, up(4), Uint32Array.from([2, 0, 0, 0]), Uint32Array.from([1, 1, 1, 1]));
    assert.equal(b.pick(), 1);
});

test('A1: an idle but DOWN node is skipped; the first idle ELIGIBLE node wins', () => {
    const el = Uint8Array.from([1, 0, 1, 1]);
    const b = new NqBalancer(4, el, Uint32Array.from([3, 0, 0, 0]), Uint32Array.from([1, 1, 1, 1]));
    assert.equal(b.pick(), 2); // index 1 idle but down -> first idle eligible is 2
});

test('A2: no idle node -> SED fallback', () => {
    // all busy: node 0 (1+1)/1=2, node 1 (1+1)/2=1, node 2 (3+1)/2=2 -> min is node 1
    const b = new NqBalancer(3, up(3), Uint32Array.from([1, 1, 3]), Uint32Array.from([1, 2, 2]));
    assert.equal(b.pick(), 1);
});

test('A3: a weight-0 node is never picked, even when idle', () => {
    // node 0 idle but weight 0 -> excluded; node 1 idle with weight -> picked.
    const b = new NqBalancer(3, up(3), Uint32Array.from([0, 0, 5]), Uint32Array.from([0, 1, 1]));
    assert.equal(b.pick(), 1);
});

test('A3: all eligible weights 0 -> fail closed', () => {
    const b = new NqBalancer(4, up(4), new Uint32Array(4), new Uint32Array(4));
    assert.equal(b.pick(), PICK_NONE);
});

test('A4: worker-pool fill -- n requests fan out to n distinct idle workers first', () => {
    const n = 8;
    const inflight = new Uint32Array(n);
    const b = new NqBalancer(n, up(n), inflight, new Uint32Array(n).fill(1));
    const seen = new Set();
    for (let i = 0; i < n; i++) { const p = b.pick(); seen.add(p); inflight[p]++; } // dispatch, no settle
    assert.equal(seen.size, n, 'first n picks should hit n distinct idle workers');
});

test('A4: fail closed when the whole pool is down', () => {
    const b = new NqBalancer(4, new Uint8Array(4), new Uint32Array(4), new Uint32Array(4).fill(1));
    assert.equal(b.pick(), PICK_NONE);
});

test('A5 (churn): never returns a down or weight-0 index under flapping', () => {
    const n = 12, el = up(n), inflight = new Uint32Array(n), weights = new Uint32Array(n);
    for (let i = 0; i < n; i++) weights[i] = 1 + (i & 3);
    const b = new NqBalancer(n, el, inflight, weights);
    let s = 0x0ddba11 >>> 0;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
    for (let step = 0; step < 200000; step++) {
        if ((step & 3) === 0) b.setEligible(rnd() % n, (rnd() & 1) === 0);
        if ((step & 7) === 0) { const j = rnd() % n; inflight[j] = inflight[j] > 0 ? inflight[j] - 1 : 0; }
        const p = b.pick();
        if (p === PICK_NONE) continue;
        assert.equal(el[p], 1, 'down index at step ' + step);
        assert.ok(weights[p] > 0, 'weight-0 index at step ' + step);
        inflight[p]++;
    }
});
