/**
 * @zakkster/lite-pick -- P2cBalancer boundary + behaviour suite (M3).
 *
 *     node --test test/P2C.test.js
 *
 * Falsifiable assertions (the planner contract for M3):
 *   A1. With n=2 eligible, pick() ALWAYS returns the lower-in-flight node (two distinct
 *       draws -> the pair is {0,1} -> the lower load wins deterministically).
 *   A2. DETERMINISM: same seed + same inflight -> identical pick sequence.
 *   A3. pick() never returns a down node; PICK_NONE only when the whole pool is down.
 *   A4. A single eligible node is returned every time.
 *   A5. BALANCE: over a balls-into-bins run, P2C's peak load is dramatically below a
 *       random single-draw foil's (the ln ln n vs ln n / ln ln n gap). The full anchor
 *       is test/balance.mjs; this is the in-suite smoke.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P2cBalancer, BalancerBase, PICK_NONE, Prng } from '../Pick.js';

const up = (n) => { const e = new Uint8Array(n); e.fill(1); return e; };

test('P2cBalancer is a BalancerBase', () => {
    const b = new P2cBalancer(3, up(3), new Uint32Array(3));
    assert.ok(b instanceof BalancerBase);
    assert.equal(b.capacity, 3);
});

test('constructor validates the inflight view', () => {
    assert.throws(() => new P2cBalancer(3, up(3), new Uint32Array(2)), RangeError);
    assert.throws(() => new P2cBalancer(3, up(3), [0, 0, 0]), RangeError);
    assert.throws(() => new P2cBalancer(0, new Uint8Array(1), new Uint32Array(1)), RangeError);
});

test('A1: with n=2, always returns the lower-in-flight node', () => {
    const inflight = Uint32Array.from([0, 5]);
    const b = new P2cBalancer(2, up(2), inflight);
    for (let i = 0; i < 200; i++) assert.equal(b.pick(), 0);
    inflight[0] = 9; // now node 1 is lower
    for (let i = 0; i < 200; i++) assert.equal(b.pick(), 1);
});

test('A2: deterministic for a given seed', () => {
    const inflight = Uint32Array.from([3, 1, 4, 1, 5, 9, 2, 6]);
    const a = new P2cBalancer(8, up(8), inflight, 0xC0FFEE);
    const c = new P2cBalancer(8, up(8), inflight, 0xC0FFEE);
    for (let i = 0; i < 1000; i++) assert.equal(a.pick(), c.pick());
});

test('A3: fail closed when the whole pool is down', () => {
    const b = new P2cBalancer(4, new Uint8Array(4), new Uint32Array(4));
    assert.equal(b.pick(), PICK_NONE);
});

test('A4: a single eligible node is returned every time', () => {
    const el = Uint8Array.from([0, 1, 0, 0]);
    const b = new P2cBalancer(4, el, new Uint32Array(4));
    for (let i = 0; i < 100; i++) assert.equal(b.pick(), 1);
});

test('A3: skips down nodes -- never returns an ineligible index', () => {
    const el = Uint8Array.from([1, 0, 1, 0, 1, 0, 1, 0]);
    const b = new P2cBalancer(8, el, new Uint32Array(8), 42);
    for (let i = 0; i < 100000; i++) {
        const p = b.pick();
        assert.equal(el[p], 1, 'returned down index ' + p);
    }
});

test('A3 (churn): never returns a down index under adversarial flapping', () => {
    const n = 16;
    const el = up(n);
    const inflight = new Uint32Array(n);
    const b = new P2cBalancer(n, el, inflight, 7);
    let s = 0x1234abcd >>> 0;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
    for (let step = 0; step < 200000; step++) {
        if ((step & 3) === 0) b.setEligible(rnd() % n, (rnd() & 1) === 0);
        const p = b.pick();
        if (p === PICK_NONE) assert.equal(b.live, 0, 'PICK_NONE only when pool empty');
        else { assert.equal(el[p], 1, 'down index at step ' + step); inflight[p]++; }
    }
});

test('handles a very sparse eligible set (rejection-sample fallback path)', () => {
    const n = 4096;
    const el = new Uint8Array(n); // one eligible node in a big pool
    el[3000] = 1;
    const b = new P2cBalancer(n, el, new Uint32Array(n), 99);
    for (let i = 0; i < 5000; i++) assert.equal(b.pick(), 3000);
});

test('A5 (smoke): P2C peak load far below a random single-draw foil', () => {
    const n = 1024;
    const picks = n * 32; // balls into bins
    const el = up(n);

    // P2C: each pick increments the chosen bin's in-flight; pick() reads it back.
    const p2cLoad = new Uint32Array(n);
    const p2c = new P2cBalancer(n, el, p2cLoad, 0xABCDEF);
    for (let i = 0; i < picks; i++) p2cLoad[p2c.pick()]++;

    // Random single-draw foil over the same seed stream.
    const rndLoad = new Uint32Array(n);
    const rng = new Prng(0xABCDEF);
    for (let i = 0; i < picks; i++) rndLoad[rng.nextBelow(n)]++;

    const mean = picks / n; // 32
    let p2cMax = 0, rndMax = 0;
    for (let i = 0; i < n; i++) { if (p2cLoad[i] > p2cMax) p2cMax = p2cLoad[i]; if (rndLoad[i] > rndMax) rndMax = rndLoad[i]; }

    const p2cGap = p2cMax - mean, rndGap = rndMax - mean;
    // P2C's additive gap above the mean is a small ln ln n constant; random's is much larger.
    assert.ok(p2cGap < rndGap / 2, 'P2C gap ' + p2cGap + ' should be << random gap ' + rndGap);
    assert.ok(p2cGap <= 8, 'P2C gap ' + p2cGap + ' should be a small ln ln n constant');
});
