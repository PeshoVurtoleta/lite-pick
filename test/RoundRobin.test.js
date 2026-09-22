/**
 * @zakkster/lite-pick -- RoundRobinBalancer boundary + behaviour suite (M1).
 *
 *     node --test test/RoundRobin.test.js
 *
 * Falsifiable assertions (the planner contract for M1):
 *   A1. Over a run with all nodes eligible, each node gets an EQUAL share (perfect RR).
 *   A2. `pick()` NEVER returns a down index -- under static AND churning eligibility.
 *   A3. Whole pool down -> `pick()` returns PICK_NONE (fail closed), never a dead index.
 *   A4. Round-robin ORDER: consecutive picks visit eligible indices in ascending,
 *       wrapping order.
 *   A5. A single eligible node is returned every time.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoundRobinBalancer, BalancerBase, PICK_NONE } from '../Pick.js';

/** All-up pool of n endpoints. */
function allUp(n) {
    const el = new Uint8Array(n);
    el.fill(1);
    return el;
}

test('RoundRobinBalancer is a BalancerBase', () => {
    const rr = new RoundRobinBalancer(4, allUp(4));
    assert.ok(rr instanceof BalancerBase);
    assert.equal(rr.capacity, 4);
    assert.equal(rr.live, 4);
});

test('A4: cycles eligible indices in ascending, wrapping order', () => {
    const rr = new RoundRobinBalancer(4, allUp(4));
    const seq = [];
    for (let i = 0; i < 9; i++) seq.push(rr.pick());
    assert.deepEqual(seq, [0, 1, 2, 3, 0, 1, 2, 3, 0]);
});

test('A1: perfect fairness over a run when all are eligible', () => {
    const n = 7;
    const rr = new RoundRobinBalancer(n, allUp(n));
    const counts = new Uint32Array(n);
    const PICKS = 7000;
    for (let i = 0; i < PICKS; i++) counts[rr.pick()]++;
    for (let i = 0; i < n; i++) assert.equal(counts[i], PICKS / n, 'node ' + i);
});

test('A2 (static): skips down nodes, only returns eligible ones', () => {
    const el = Uint8Array.from([1, 0, 1, 0, 1]); // 0,2,4 up
    const rr = new RoundRobinBalancer(5, el);
    const seq = [];
    for (let i = 0; i < 6; i++) seq.push(rr.pick());
    assert.deepEqual(seq, [0, 2, 4, 0, 2, 4]);
});

test('A1 under partial eligibility: equal share among the live set', () => {
    const el = Uint8Array.from([1, 0, 1, 0, 1]); // 3 live
    const rr = new RoundRobinBalancer(5, el);
    const counts = new Uint32Array(5);
    const PICKS = 3000;
    for (let i = 0; i < PICKS; i++) counts[rr.pick()]++;
    assert.equal(counts[1], 0);
    assert.equal(counts[3], 0);
    assert.equal(counts[0], 1000);
    assert.equal(counts[2], 1000);
    assert.equal(counts[4], 1000);
});

test('A3: whole pool down -> PICK_NONE (fail closed)', () => {
    const rr = new RoundRobinBalancer(4, new Uint8Array(4)); // all 0
    assert.equal(rr.live, 0);
    assert.equal(rr.pick(), PICK_NONE);
    assert.equal(rr.pick(), PICK_NONE); // still, repeatedly
});

test('A5: a single eligible node is returned every time', () => {
    const el = Uint8Array.from([0, 0, 1, 0]);
    const rr = new RoundRobinBalancer(4, el);
    for (let i = 0; i < 100; i++) assert.equal(rr.pick(), 2);
});

test('recovers when the pool goes from all-down to some-up', () => {
    const el = new Uint8Array(3); // all down
    const rr = new RoundRobinBalancer(3, el);
    assert.equal(rr.pick(), PICK_NONE);
    rr.setEligible(1, true);
    assert.equal(rr.pick(), 1);
    assert.equal(rr.pick(), 1);
    rr.setEligible(2, true);
    // cursor is at 1; next scan finds 2, then wraps to 1, ...
    assert.deepEqual([rr.pick(), rr.pick(), rr.pick()], [2, 1, 2]);
});

test('dropping the node the cursor last returned is handled', () => {
    const rr = new RoundRobinBalancer(3, allUp(3));
    assert.equal(rr.pick(), 0);
    assert.equal(rr.pick(), 1);
    rr.setEligible(1, false); // drop the one we're sitting on
    // next scan from cursor=1 -> 2, then wrap -> 0, skip the down 1
    assert.deepEqual([rr.pick(), rr.pick(), rr.pick()], [2, 0, 2]);
});

test('A2 (churn): never returns a down index under adversarial flapping', () => {
    const n = 16;
    const el = allUp(n);
    const rr = new RoundRobinBalancer(n, el);
    // Deterministic LCG so the churn is reproducible.
    let s = 0x2545f491 >>> 0;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
    for (let step = 0; step < 200000; step++) {
        // Flip a random node's eligibility every few picks.
        if ((step & 3) === 0) {
            const j = rnd() % n;
            rr.setEligible(j, (rnd() & 1) === 0);
        }
        const p = rr.pick();
        if (p === PICK_NONE) {
            assert.equal(rr.live, 0, 'PICK_NONE only when pool empty');
        } else {
            assert.equal(el[p], 1, 'returned a DOWN index at step ' + step + ': ' + p);
        }
    }
});

test('capacity/eligible validation inherited from BalancerBase', () => {
    assert.throws(() => new RoundRobinBalancer(0, new Uint8Array(1)), RangeError);
    assert.throws(() => new RoundRobinBalancer(4, new Uint8Array(3)), RangeError);
    assert.throws(() => new RoundRobinBalancer(4, [1, 1, 1, 1]), RangeError);
});
