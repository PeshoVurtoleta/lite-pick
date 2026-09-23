/**
 * @zakkster/lite-pick -- LeastConnBalancer boundary + behaviour suite (M4).
 *
 *     node --test test/LeastConn.test.js
 *
 * Falsifiable assertions (the planner contract for M4 / LeastConn):
 *   A1. EXACT MINIMUM: pick() always returns an eligible node whose in-flight count equals
 *       the minimum over the eligible set (lowest index on a tie).
 *   A2. FEEDBACK LOOP: with increment-on-dispatch, load spreads perfectly (max-min <= 1).
 *   A3. pick() never returns a down node; PICK_NONE only when the whole pool is down.
 *   A4. A single eligible node is returned every time.
 *   A5. Reads inflight LIVE: a direct mutation of the caller's inflight view is reflected
 *       by the very next pick (no cached copy).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LeastConnBalancer, BalancerBase, PICK_NONE } from '../Pick.js';

const up = (n) => { const e = new Uint8Array(n); e.fill(1); return e; };

test('LeastConnBalancer is a BalancerBase', () => {
    const b = new LeastConnBalancer(3, up(3), new Uint32Array(3));
    assert.ok(b instanceof BalancerBase);
    assert.equal(b.capacity, 3);
});

test('constructor validates the inflight view', () => {
    assert.throws(() => new LeastConnBalancer(3, up(3), new Uint32Array(2)), RangeError);
    assert.throws(() => new LeastConnBalancer(3, up(3), [0, 0, 0]), RangeError);
    assert.throws(() => new LeastConnBalancer(0, new Uint8Array(1), new Uint32Array(1)), RangeError);
});

test('A1: returns the exact fewest-in-flight node', () => {
    const inflight = Uint32Array.from([5, 2, 9, 2, 7]);
    const b = new LeastConnBalancer(5, up(5), inflight);
    assert.equal(b.pick(), 1); // min is 2, first at index 1
    inflight[1] = 8;
    assert.equal(b.pick(), 3); // now the other 2, at index 3
});

test('A1: skips down nodes even when they hold the global minimum', () => {
    const el = Uint8Array.from([1, 0, 1, 1]);
    const inflight = Uint32Array.from([4, 0, 6, 5]); // index 1 is min but DOWN
    const b = new LeastConnBalancer(4, el, inflight);
    assert.equal(b.pick(), 0); // lowest eligible load is index 0 (4)
});

test('A2: feedback loop spreads load perfectly (max-min <= 1)', () => {
    const n = 64;
    const inflight = new Uint32Array(n);
    const b = new LeastConnBalancer(n, up(n), inflight);
    for (let i = 0; i < n * 500; i++) inflight[b.pick()]++; // increment on dispatch
    let max = 0, min = Infinity;
    for (let i = 0; i < n; i++) { if (inflight[i] > max) max = inflight[i]; if (inflight[i] < min) min = inflight[i]; }
    assert.ok(max - min <= 1, 'perfect greedy balance: max-min=' + (max - min));
});

test('A3: fail closed when the whole pool is down', () => {
    const b = new LeastConnBalancer(4, new Uint8Array(4), new Uint32Array(4));
    assert.equal(b.pick(), PICK_NONE);
});

test('A4: a single eligible node is returned every time', () => {
    const el = Uint8Array.from([0, 0, 1, 0]);
    const b = new LeastConnBalancer(4, el, Uint32Array.from([0, 0, 9, 0]));
    for (let i = 0; i < 100; i++) assert.equal(b.pick(), 2);
});

test('A5: reads inflight live (no cached copy)', () => {
    const inflight = Uint32Array.from([0, 0]);
    const b = new LeastConnBalancer(2, up(2), inflight);
    assert.equal(b.pick(), 0); // tie -> lowest index
    inflight[0] = 3;
    assert.equal(b.pick(), 1); // live read sees the change immediately
});

test('A3 (churn): never returns a down index under adversarial flapping', () => {
    const n = 16, el = up(n), inflight = new Uint32Array(n);
    const b = new LeastConnBalancer(n, el, inflight);
    let s = 0x1234abcd >>> 0;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
    for (let step = 0; step < 200000; step++) {
        if ((step & 3) === 0) b.setEligible(rnd() % n, (rnd() & 1) === 0);
        const p = b.pick();
        if (p === PICK_NONE) assert.equal(b.live, 0, 'PICK_NONE only when pool empty');
        else { assert.equal(el[p], 1, 'down index at step ' + step); inflight[p]++; }
    }
});
