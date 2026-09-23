/**
 * @zakkster/lite-pick -- BoundedLoadBalancer boundary + behaviour suite (M9, CHBL).
 *
 *     node --test test/BoundedLoad.test.js
 *
 * BoundedLoad is Consistent Hashing with Bounded Loads (Mirrokni et al.): ConsistentHash (the Maglev
 * table) + an occupancy cap that overflows a hot backend to the next eligible under-cap one.
 *
 * Falsifiable assertions (the planner contract for M9):
 *   A1. VALIDATION: the constructor validates inflight + eps typeof-first, BEFORE allocating the table.
 *   A2. STICKY: with no occupancy noted (_total === 0), the same key always maps to the same backend
 *       -- identical to a plain ConsistentHashBalancer (pure consistent hashing, cap skipped).
 *   A3. OVERFLOW: when a key's hashed home is over cap, pick(key) returns a DIFFERENT eligible,
 *       under-cap backend (the request overflows along the probe); when the home is under cap it wins.
 *   A4. FAIL OPEN: when every backend is over cap, pick(key) still returns an eligible backend (the
 *       sticky first-eligible fallback) -- never PICK_NONE merely for overload.
 *   A5. FAIL CLOSED: PICK_NONE only when no eligible backend is reachable (pool down).
 *   A6. note() range + integer validation, clamp-at-0, and totalInflight tracking.
 *   A7. MINIMAL DISRUPTION: removing a backend reroutes only ~1/N keys (inherited from ConsistentHash).
 *   A8. Pool opts.key round-trip: a BoundedLoad + Pool keyed run is net-zero on inflight AND _total.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BoundedLoadBalancer, ConsistentHashBalancer, BalancerBase, PICK_NONE,
} from '../Pick.js';
import { Pool } from '../Pool.js';

const up = (n) => { const e = new Uint8Array(n); e.fill(1); return e; };

test('BoundedLoadBalancer is a ConsistentHashBalancer (and a BalancerBase)', () => {
    const b = new BoundedLoadBalancer(4, up(4), new Uint32Array(4), 0.25, null, 5);
    assert.ok(b instanceof ConsistentHashBalancer);
    assert.ok(b instanceof BalancerBase);
    assert.equal(b.capacity, 4);
    assert.equal(b.tableSize, 5);
    assert.equal(b.totalInflight, 0);
});

test('A1: constructor validates inflight, eps (typeof-first), and inherits m/weights checks', () => {
    assert.throws(() => new BoundedLoadBalancer(3, up(3), new Uint32Array(2)), RangeError);        // short inflight
    assert.throws(() => new BoundedLoadBalancer(3, up(3), [0, 0, 0]), RangeError);                 // not a Uint32Array
    assert.throws(() => new BoundedLoadBalancer(0, new Uint8Array(1), new Uint32Array(1)), RangeError); // capacity
    assert.throws(() => new BoundedLoadBalancer(3, up(3), new Uint32Array(3), 'nope'), TypeError); // eps typeof
    assert.throws(() => new BoundedLoadBalancer(3, up(3), new Uint32Array(3), 0), RangeError);     // eps <= 0
    assert.throws(() => new BoundedLoadBalancer(3, up(3), new Uint32Array(3), -1), RangeError);
    assert.throws(() => new BoundedLoadBalancer(3, up(3), new Uint32Array(3), NaN), RangeError);
    assert.throws(() => new BoundedLoadBalancer(3, up(3), new Uint32Array(3), Infinity), RangeError);
    // Inherited ConsistentHash guards: m must be a prime >= capacity.
    assert.throws(() => new BoundedLoadBalancer(3, up(3), new Uint32Array(3), 0.25, null, 4), RangeError); // 4 not prime
    assert.throws(() => new BoundedLoadBalancer(8, up(8), new Uint32Array(8), 0.25, null, 5), RangeError); // capacity > m
    // A valid construction does not throw; default eps is 0.25.
    assert.ok(new BoundedLoadBalancer(3, up(3), new Uint32Array(3)));
});

test('A2: sticky -- _total === 0 maps every key like plain ConsistentHash', () => {
    const n = 8, m = 17, seed = 0xABCDEF;
    const bl = new BoundedLoadBalancer(n, up(n), new Uint32Array(n), 0.25, null, m, seed);
    const ch = new ConsistentHashBalancer(n, up(n), null, m, seed);
    for (let k = 0; k < 10000; k++) {
        const key = (k * 2654435761) >>> 0;
        assert.equal(bl.pick(key), ch.pick(key), 'CHBL with no occupancy must equal pure ConsistentHash at key ' + key);
        // Stickiness: the same key twice is the same backend.
        assert.equal(bl.pick(key), bl.pick(key));
    }
});

test('A3: overflow -- a key whose home is over cap spills to a DIFFERENT eligible under-cap backend', () => {
    const n = 8, m = 17, seed = 0x1234;
    const inflight = new Uint32Array(n);
    const bl = new BoundedLoadBalancer(n, up(n), inflight, 0.25, null, m, seed);
    const key = 0xC0FFEE >>> 0;
    const home = bl.pick(key);                 // total 0 -> the sticky hashed home
    assert.ok(home >= 0 && home < n);
    // Pile occupancy onto the home so it is far over cap; keep inflight and _total in lockstep.
    inflight[home] = 100; bl.note(home, 100);  // total=100, live=8, cap=1.25*100/8=15.625
    assert.equal(bl.totalInflight, 100);
    const cap = (1 + 0.25) * 100 / n;
    assert.ok(inflight[home] > cap, 'home is over cap');
    const spill = bl.pick(key);
    assert.notEqual(spill, home, 'an over-cap home must overflow to another backend');
    assert.equal(bl.isEligible(spill), true, 'the overflow target is eligible');
    assert.ok(inflight[spill] < cap, 'the overflow target is under cap');
    // Drain the home back under cap -> the key sticks to its home again.
    inflight[home] = 0; bl.note(home, -100);
    assert.equal(bl.totalInflight, 0);
    assert.equal(bl.pick(key), home, 'once the home is under cap again the key sticks to it');
});

test('A4: fail OPEN -- every backend over cap still returns an eligible backend (sticky fallback)', () => {
    const n = 8, m = 17;
    const inflight = new Uint32Array(n);
    const bl = new BoundedLoadBalancer(n, up(n), inflight, 0.25, null, m, 99);
    // Uniformly heavy: every backend far above any cap.
    let total = 0;
    for (let i = 0; i < n; i++) { inflight[i] = 1000; total += 1000; }
    bl.note(0, total);
    for (let k = 0; k < 5000; k++) {
        const p = bl.pick((k * 40503) >>> 0);
        assert.notEqual(p, PICK_NONE, 'over-cap must fail OPEN, not PICK_NONE');
        assert.equal(bl.isEligible(p), true);
    }
});

test('A5: fail closed only when the whole pool is down; single node always returned', () => {
    const down = new BoundedLoadBalancer(4, new Uint8Array(4), new Uint32Array(4), 0.25, null, 5);
    assert.equal(down.pick(123), PICK_NONE);
    const one = new BoundedLoadBalancer(4, Uint8Array.from([0, 1, 0, 0]), new Uint32Array(4), 0.25, null, 5);
    one.note(1, 50); // even far over cap, the sole eligible backend is always returned (fail open)
    for (let k = 0; k < 1000; k++) assert.equal(one.pick(k * 2654435761), 1);
});

test('A6: note() validates index + integer delta, clamps at 0, tracks totalInflight', () => {
    const b = new BoundedLoadBalancer(4, up(4), new Uint32Array(4), 0.25, null, 5);
    assert.throws(() => b.note(-1, 1), RangeError);
    assert.throws(() => b.note(4, 1), RangeError);
    assert.throws(() => b.note(0, '1'), TypeError);
    assert.throws(() => b.note(0, 1.5), RangeError);
    assert.throws(() => b.note(0, NaN), RangeError);
    b.note(0, 3); b.note(1, 2); assert.equal(b.totalInflight, 5);
    b.note(2, -4); assert.equal(b.totalInflight, 1);
    b.note(3, -10); assert.equal(b.totalInflight, 0);   // clamp: never negative
});

test('A7: minimal disruption -- removing a backend reroutes only ~1/N keys (inherited)', () => {
    const N = 64, M = 8191, KEYS = 100000;
    const el = up(N);
    const bl = new BoundedLoadBalancer(N, el, new Uint32Array(N), 0.25, null, M, 0xABCDEF);
    const keys = new Uint32Array(KEYS);
    let s = 0xBEEF1234 >>> 0;
    for (let i = 0; i < KEYS; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; keys[i] = s; }
    const before = new Int32Array(KEYS);
    for (let i = 0; i < KEYS; i++) before[i] = bl.pick(keys[i]);
    bl.setEligible(7, false);
    let moved = 0, dead = 0;
    for (let i = 0; i < KEYS; i++) {
        const p = bl.pick(keys[i]);
        if (p !== before[i]) moved++;
        if (p === 7) dead++;
    }
    const pct = moved / KEYS * 100;
    assert.ok(pct <= 2 / N * 100, 'remap ' + pct.toFixed(2) + '% <= ' + (2 / N * 100).toFixed(2) + '% (2/N)');
    assert.equal(dead, 0, 'never routes to the removed backend');
});

test('A8: BoundedLoad + Pool keyed round-trip is net-zero on inflight AND totalInflight', async () => {
    const n = 8, m = 17;
    const inflight = new Uint32Array(n);
    const bl = new BoundedLoadBalancer(n, up(n), inflight, 0.25, null, m, 1);
    const pool = new Pool(bl, inflight);
    // A successful keyed run: opts.key drives pick(key); note() mirrors dispatch/settle.
    const got = await pool.run(async (i) => { assert.ok(i >= 0 && i < n); return i; }, { key: 0xABCD });
    assert.ok(got >= 0 && got < n);
    // A failing keyed run with failover.
    await pool.run(async () => { throw new Error('boom'); }, { key: 0xABCD, tries: 3 }).catch(() => {});
    let sum = 0; for (let i = 0; i < n; i++) sum += inflight[i];
    assert.equal(sum, 0, 'caller inflight net-zero after keyed runs');
    assert.equal(bl.totalInflight, 0, 'balancer _total net-zero after keyed runs');
});

test('never returns a down/oob index under adversarial flapping + notes', () => {
    const n = 16, m = 31;
    const el = up(n);
    const inflight = new Uint32Array(n);
    const bl = new BoundedLoadBalancer(n, el, inflight, 0.25, null, m, 7);
    let s = 0x1234abcd >>> 0;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
    for (let step = 0; step < 100000; step++) {
        if ((step & 3) === 0) bl.setEligible(rnd() % n, (rnd() & 1) === 0);
        const p = bl.pick(rnd());
        if (p === PICK_NONE) { /* only when nothing reachable */ }
        else {
            assert.ok(p >= 0 && p < n, 'in range at step ' + step);
            assert.equal(el[p], 1, 'down index at step ' + step);
            const i = rnd() % n;
            inflight[i] = (inflight[i] + 1) >>> 0; bl.note(i, 1);              // dispatch
            if ((step & 1) === 0 && inflight[i] > 0) { inflight[i]--; bl.note(i, -1); } // settle
        }
    }
    assert.ok(Number.isFinite(bl.totalInflight) && bl.totalInflight >= 0);
});
