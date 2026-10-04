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

test('M1: note() rejects a non-integer/out-of-range index; totalInflight unchanged', () => {
    const b = new BoundedLoadBalancer(4, up(4), new Uint32Array(4), 0.25, null, 5);
    b.note(0, 3);
    assert.equal(b.totalInflight, 3);
    for (const bad of [1.5, NaN, '2', -1, 4]) {
        assert.throws(() => b.note(bad, 1), RangeError, 'note(' + String(bad) + ')');
    }
    assert.equal(b.totalInflight, 3, '_total unchanged after a rejected note');
});

// --- H4: the load-bearing change is the +1 that COUNTS THE INCOMING request (the old cap was
// (1+eps)*total/live, the new is (1+eps)*(total+1)/live). The Math.ceil in the kernel matches the
// published integer-slot definition but is a no-op for the `inf < cap` test (for integer inf,
// `inf < ceil(x)` == `inf < x`). At n=10 / eps 0.25 old and new behave IDENTICALLY for total <= 7;
// the +1 only bites at total >= 8, where the home's single request stops being evicted. The kernel's
// under-cap decisions are checked against the Mirrokni-Thorup-Zadimoghaddam per-bin capacity written in
// INTEGER arithmetic -- partially independent of the kernel's float path. It is NOT HAProxy:
// HAProxy's hash-balance-factor shares the +1 but splits ONE global ceil((m+1)F/100) slot budget across
// servers by weight (min 1), which is stricter (at total 8 / n 10 it would move this load-1 home). ---

// Oracle: the paper's per-bin capacity ceil((1+eps)(m+1)/n) in integer form. factorPct is the percentage
// load factor (125 == 1 + eps of 0.25); the capacity counts the incoming request and is at least 1; a
// backend is eligible while its load is STRICTLY below its capacity.
function mtzEligible(served, totalServed, live, factorPct) {
    const num = (totalServed + 1) * factorPct;            // integer numerator
    const den = 100 * live;                               // integer denominator
    let slots = Math.floor((num + den - 1) / den);        // integer ceil(num / den)
    if (slots < 1) slots = 1;                             // capacity is at least one
    return served < slots;
}

test('H4: the +1 (incoming request) keeps a key on its home where the old cap evicted it', () => {
    const n = 10, m = 17, eps = 0.25;
    const inflight = new Uint32Array(n);
    const bl = new BoundedLoadBalancer(n, up(n), inflight, eps, null, m, 0xABCD);
    const key = 0xBEEF >>> 0;
    const home = bl.pick(key);
    // Home carries a single request; 7 more spread elsewhere so total = 8, live = 10.
    inflight[home] = 1; bl.note(home, 1);
    let other = 0;
    while (bl.totalInflight < 8) { const o = (home + 1 + other) % n; inflight[o]++; bl.note(o, 1); other++; }
    assert.equal(bl.totalInflight, 8);
    // Old cap (no +1) = (1+eps)*total/live = 1.25*8/10 = 1.0 -> home (load 1) NOT < 1.0 -> evicted (H4 bug).
    // New cap (+1 counts the incoming) = 1.25*9/10 = 1.125 -> home (load 1) < 1.125 -> kept. The +1 is
    // the whole difference; the independent oracle agrees the home is eligible here.
    const oldCap = (1 + eps) * 8 / n;   // 1.0 -- the pre-1.0.1 cap WITHOUT the +1
    assert.equal(inflight[home] < oldCap, false, 'old cap 1.0 would have evicted a load-1 home');
    assert.equal(mtzEligible(inflight[home], 8, n, 125), true, 'oracle: home eligible at total 8');
    assert.equal(bl.pick(key), home, 'the +1 must keep the key on its home at this occupancy');
});

test('H4: kernel under-cap decisions agree with the integer per-bin capacity oracle over a hot-key burst', () => {
    const n = 10, m = 17, eps = 0.25;
    const inflight = new Uint32Array(n);
    const bl = new BoundedLoadBalancer(n, up(n), inflight, eps, null, m, 0x1234);
    const key = 0x99 >>> 0;
    const home = bl.pick(key);
    let overflowed = false;
    for (let r = 0; r < 40; r++) {
        const total = bl.totalInflight;
        const p = bl.pick(key);
        // The kernel's stick-vs-overflow decision must match the integer per-bin capacity oracle for the home.
        if (mtzEligible(inflight[home], total, n, 125)) {
            assert.equal(p, home, 'oracle: home eligible -> kernel must keep the key at r=' + r);
        } else {
            assert.notEqual(p, home, 'oracle: home over cap -> kernel must overflow at r=' + r);
            assert.equal(mtzEligible(inflight[p], total, n, 125), true, 'overflow target must be oracle-eligible');
            overflowed = true;
        }
        inflight[p]++; bl.note(p, 1);
    }
    assert.ok(overflowed, 'a single hot key eventually overflows its home');
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

test('L3 (1.1.0): nothing eligible in the probe window -> the full-table sweep, cap ignored (never a dead pick)', () => {
    // 100 backends, M = 101 (~1 slot each), only backend 99 up and loaded far over any cap: every key still
    // resolves to 99 -- 1.0.x returned PICK_NONE when the 65-slot window held no eligible backend.
    const N = 100, inflight = new Uint32Array(N);
    const bl = new BoundedLoadBalancer(N, new Uint8Array(N).fill(1), inflight, 0.25, null, 101);
    for (let i = 0; i < 99; i++) bl.setEligible(i, false);
    inflight[99] = 50; bl.note(99, 50);
    for (let k = 0; k < 2000; k++) assert.equal(bl.pick(k), 99, 'key ' + k);
});

test('minCap (1.1.0, N4): opt-in low-load affinity; default 0 is the paper capacity exactly', () => {
    // n = 10, eps 0.25, five CONCURRENT requests for one key. Paper capacity: the 2nd request sees
    // cap = ceil(1.25 x 2 / 10) = 1 and leaves home -- five requests land on five backends.
    const run = (minCap) => {
        const n = 10, inf = new Uint32Array(n);
        const bl = minCap === undefined
            ? new BoundedLoadBalancer(n, new Uint8Array(n).fill(1), inf, 0.25, null, 101)
            : new BoundedLoadBalancer(n, new Uint8Array(n).fill(1), inf, 0.25, null, 101, 0x9e3779b9, minCap);
        const got = [];
        for (let k = 0; k < 5; k++) { const p = bl.pick(12345); got.push(p); inf[p]++; bl.note(p, 1); }
        return got;
    };
    const paper = run(undefined);
    assert.deepEqual(run(0), paper, 'minCap 0 == the default');
    assert.equal(new Set(paper).size, 5, 'paper capacity: every concurrent same-key request overflows');
    const two = run(2), home = paper[0];
    assert.deepEqual(two.slice(0, 2), [home, home], 'minCap 2: two concurrent requests stay home');
    assert.notEqual(two[2], home, 'the third overflows');
    const four = run(4);
    assert.deepEqual(four.slice(0, 4), [home, home, home, home]);
    const b = new BoundedLoadBalancer(4, new Uint8Array(4).fill(1), new Uint32Array(4), 0.25, null, 7, 1, 3);
    assert.equal(b.minCap, 3);
    assert.equal(new BoundedLoadBalancer(4, new Uint8Array(4).fill(1), new Uint32Array(4), 0.25, null, 7).minCap, 0);
    for (const bad of [-1, 1.5, NaN, Infinity, 2 ** 32]) {
        assert.throws(() => new BoundedLoadBalancer(4, new Uint8Array(4).fill(1), new Uint32Array(4), 0.25, null, 7, 1, bad), RangeError, String(bad));
    }
    assert.throws(() => new BoundedLoadBalancer(4, new Uint8Array(4).fill(1), new Uint32Array(4), 0.25, null, 7, 1, '2'), TypeError);
});
