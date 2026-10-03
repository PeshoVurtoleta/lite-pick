/**
 * @zakkster/lite-pick/pool -- Pool + liteQueryFetcher boundary suite (M5).
 *
 *     node --test test/Pool.test.js
 *
 * Falsifiable assertions (the planner contract for M5):
 *   A1. run() resolves with fn's result; in-flight is +1 DURING fn, back to baseline AFTER.
 *   A2. in-flight returns to baseline even when fn THROWS (settle-in-finally).
 *   A3. FAIL-CLOSED: run() rejects with a LITE_PICK_NONE-coded error when the pool is all-down.
 *   A4. FAILOVER: with tries>1, a load-aware strategy re-picks a DISTINCT endpoint after a throw.
 *   A5. TRIES EXHAUSTION: every attempt failing rejects with the LAST error.
 *   A6. ABORT: an aborted signal after a failure stops failover (no re-pick), propagates.
 *   A7. SIGNAL PASSTHROUGH: fn receives the signal handed to run().
 *   A8. CONCURRENCY: many overlapping runs settle with in-flight back to all-zero (no leak).
 *   A9. liteQueryFetcher returns a ({key,signal})->Promise that drives the pool; duck-typed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    RoundRobinBalancer, LeastConnBalancer, PeakEwmaBalancer,
    ConsistentHashBalancer, WeightedRandomBalancer, BoundedLoadBalancer,
} from '../Pick.js';
import { Pool, liteQueryFetcher, VERSION } from '../Pool.js';

const up = (n) => { const e = new Uint8Array(n); e.fill(1); return e; };
const tick = () => new Promise((r) => setTimeout(r, 0));

test('VERSION is re-exported from the core', () => {
    assert.equal(typeof VERSION, 'string');
});

test('constructor validates the balancer and inflight view', () => {
    const inflight = new Uint32Array(4);
    assert.throws(() => new Pool({}, inflight), TypeError);
    assert.throws(() => new Pool(new LeastConnBalancer(4, up(4), inflight), new Uint32Array(2)), RangeError);
    assert.throws(() => new Pool(new LeastConnBalancer(4, up(4), inflight), [0, 0, 0, 0]), RangeError);
});

test('A1: resolves with fn result; in-flight +1 during, baseline after', async () => {
    const inflight = new Uint32Array(4);
    const pool = new Pool(new LeastConnBalancer(4, up(4), inflight), inflight);
    let sawInflight = -1, sawEndpoint = -1;
    const result = await pool.run((i) => { sawEndpoint = i; sawInflight = inflight[i]; return 'ok:' + i; });
    assert.equal(result, 'ok:' + sawEndpoint);
    assert.equal(sawInflight, 1, 'in-flight is 1 during fn');
    assert.equal(inflight[sawEndpoint], 0, 'in-flight back to 0 after settle');
});

test('A2: in-flight returns to baseline when fn throws', async () => {
    const inflight = new Uint32Array(2);
    const pool = new Pool(new LeastConnBalancer(2, up(2), inflight), inflight);
    await assert.rejects(pool.run(() => { throw new Error('boom'); }), /boom/);
    assert.equal(inflight[0], 0);
    assert.equal(inflight[1], 0);
});

test('A3: fail closed with a coded error when the pool is all-down', async () => {
    const inflight = new Uint32Array(4);
    const pool = new Pool(new LeastConnBalancer(4, new Uint8Array(4), inflight), inflight);
    await assert.rejects(pool.run(() => 'never'), (e) => e.code === 'LITE_PICK_NONE');
});

test('A4: failover re-picks a DISTINCT endpoint on a throw (tries=2)', async () => {
    const inflight = new Uint32Array(2);
    const pool = new Pool(new LeastConnBalancer(2, up(2), inflight), inflight);
    const seen = [];
    const result = await pool.run((i) => {
        seen.push(i);
        if (seen.length === 1) throw new Error('first fails');
        return 'served-by-' + i;
    }, { tries: 2 });
    assert.equal(seen.length, 2, 'two attempts');
    assert.notEqual(seen[0], seen[1], 'second attempt is a DISTINCT endpoint');
    assert.equal(result, 'served-by-' + seen[1]);
    assert.equal(inflight[0], 0); assert.equal(inflight[1], 0); // all released
});

test('A5: tries exhaustion rejects with the LAST error', async () => {
    const inflight = new Uint32Array(3);
    const pool = new Pool(new RoundRobinBalancer(3, up(3)), inflight);
    let n = 0;
    await assert.rejects(
        pool.run(() => { n++; throw new Error('fail-' + n); }, { tries: 3 }),
        /fail-3/,
    );
    assert.equal(n, 3, 'all three attempts ran');
    for (let i = 0; i < 3; i++) assert.equal(inflight[i], 0);
});

test('A6: an aborted signal after a failure stops failover', async () => {
    const inflight = new Uint32Array(4);
    const pool = new Pool(new LeastConnBalancer(4, up(4), inflight), inflight);
    const ac = new AbortController();
    let attempts = 0;
    await assert.rejects(pool.run((i, sig) => {
        attempts++;
        ac.abort();                       // simulate the caller aborting mid-request
        throw new Error('aborted-fail');
    }, { tries: 4, signal: ac.signal }), /aborted-fail/);
    assert.equal(attempts, 1, 'no failover after abort');
    for (let i = 0; i < 4; i++) assert.equal(inflight[i], 0);
});

test('A7: fn receives the signal handed to run()', async () => {
    const inflight = new Uint32Array(2);
    const pool = new Pool(new LeastConnBalancer(2, up(2), inflight), inflight);
    const ac = new AbortController();
    let got;
    await pool.run((i, sig) => { got = sig; }, { signal: ac.signal });
    assert.equal(got, ac.signal);
});

test('A8: concurrent overlapping runs settle with in-flight all-zero', async () => {
    const n = 8;
    const inflight = new Uint32Array(n);
    const pool = new Pool(new LeastConnBalancer(n, up(n), inflight), inflight);
    const runs = [];
    for (let i = 0; i < 200; i++) {
        runs.push(pool.run(async () => { await tick(); return 1; }));
    }
    // While in flight, the total should be exactly the number of live runs.
    let total = 0; for (let i = 0; i < n; i++) total += inflight[i];
    assert.equal(total, 200, 'all 200 runs are in-flight before settle');
    await Promise.all(runs);
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0, 'endpoint ' + i + ' leaked in-flight');
});

test('A9: liteQueryFetcher produces a lite-query-shaped fetcher', async () => {
    const inflight = new Uint32Array(4);
    const pool = new Pool(new LeastConnBalancer(4, up(4), inflight), inflight);
    const urls = ['a', 'b', 'c', 'd'];
    const fetcher = liteQueryFetcher(pool, ({ endpoint, key, signal }) => {
        assert.ok(signal === undefined || signal instanceof AbortSignal);
        return urls[endpoint] + ':' + key[0];
    }, { tries: 2 });
    const ac = new AbortController();
    const out = await fetcher({ key: ['x'], signal: ac.signal });
    assert.match(out, /^[abcd]:x$/);
    for (let i = 0; i < 4; i++) assert.equal(inflight[i], 0);
});

test('A9: liteQueryFetcher validates its inputs', () => {
    const inflight = new Uint32Array(2);
    const pool = new Pool(new LeastConnBalancer(2, up(2), inflight), inflight);
    assert.throws(() => liteQueryFetcher({}, () => 1), TypeError);
    assert.throws(() => liteQueryFetcher(pool, 'nope'), TypeError);
});

// A monotonic caller clock (ns): advances 1000 per read.
function makeClock() {
    let t = 0;
    return () => (t += 1000);
}

test('A10: records rtt on settle when the balancer supports it AND a clock is supplied', async () => {
    const n = 4;
    const inflight = new Uint32Array(n);
    const pe = new PeakEwmaBalancer(n, up(n), inflight, 1e9, 0xABCDEF);
    const pool = new Pool(pe, inflight);
    // Before any run every node reads the cold seed 1.0.
    for (let i = 0; i < n; i++) assert.equal(pe.ewmaAt(i, 0), 1.0);
    let endpoint = -1;
    // clock: pick -> now=1000, settle -> done=2000, so the recorded sample is 1000ns at now=2000.
    await pool.run((i) => { endpoint = i; return 'ok'; }, { clock: makeClock() });
    assert.ok(endpoint >= 0);
    assert.equal(pe.ewmaAt(endpoint, 2000), 1000, 'the settled endpoint recorded its 1000ns rtt');
    assert.equal(inflight[endpoint], 0, 'in-flight net-zero after settle');
});

test('A11: inert (no error, net-zero inflight) when the balancer has no recordRtt', async () => {
    const n = 4;
    const inflight = new Uint32Array(n);
    const pool = new Pool(new LeastConnBalancer(n, up(n), inflight), inflight);
    const result = await pool.run((i) => 'served-' + i, { clock: makeClock() });
    assert.match(result, /^served-\d$/);
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0);
});

test('A12: a latency balancer run WITHOUT a clock throws (1.0.1 required-clock contract)', async () => {
    const n = 4;
    const inflight = new Uint32Array(n);
    const pe = new PeakEwmaBalancer(n, up(n), inflight, 1e9, 0xABCDEF);
    const pool = new Pool(pe, inflight);
    // A LATENCY balancer (constructor.LATENCY === true) requires opts.clock -- fail closed, no dispatch.
    let calls = 0;
    await assert.rejects(
        pool.run((i) => { void i; calls++; return 'ok'; }),
        (e) => e.code === 'LITE_PICK_CLOCK_REQUIRED' && /opts\.clock/.test(e.message),
    );
    assert.equal(calls, 0, 'fn never dispatched');
    for (let i = 0; i < n; i++) {
        assert.equal(pe.ewmaAt(i, 0), 1.0, 'no rtt recorded -- EWMA state untouched');
        assert.equal(inflight[i], 0, 'in-flight net-zero');
    }
});

test('A13: abort/failover paths unaffected by the rtt hook (tries=2, first throws)', async () => {
    const n = 2;
    const inflight = new Uint32Array(n);
    const pe = new PeakEwmaBalancer(n, up(n), inflight, 1e9, 0xABCDEF);
    const pool = new Pool(pe, inflight);
    const seen = [];
    const result = await pool.run((i) => {
        seen.push(i);
        if (seen.length === 1) throw new Error('first fails');
        return 'served-by-' + i;
    }, { tries: 2, clock: makeClock() });
    assert.equal(seen.length, 2, 'two attempts');
    assert.notEqual(seen[0], seen[1], 'second attempt is a DISTINCT endpoint');
    assert.equal(result, 'served-by-' + seen[1]);
    assert.equal(inflight[0], 0); assert.equal(inflight[1], 0);   // all released, net-zero
});

// =====================================================================================
// Batch 2 (1.0.1) regression suite: H1 / M2 / M3 / M4 / abort-before-every / L1.
// =====================================================================================

// A +1ms-per-read nanosecond clock (used by the PeakEWMA lanes).
function msClock() {
    let t = 0;
    return () => (t += 1e6);
}

// Spy balancers that record their pick() argument, to prove the key/clock channels never cross.
class SpyLatency {
    static LATENCY = true;
    constructor(n) { this.capacity = n; this.live = n; this.picks = []; }
    pick(now) { this.picks.push(now); return 0; }
    isEligible() { return true; }
    recordRtt() {}
}
class SpyKeyed {
    static KEYED = true;
    constructor(n) { this.capacity = n; this.live = n; this.picks = []; }
    pick(key) { this.picks.push(key); return 0; }
    isEligible() { return true; }
}
// A latency balancer whose recordRtt always throws -- to prove settle feedback rejects loudly.
class ThrowingRttLatency {
    static LATENCY = true;
    constructor(n) { this.capacity = n; this.live = n; }
    pick(now) { void now; return 0; }
    isEligible() { return true; }
    recordRtt() { throw new Error('rtt-feedback-boom'); }
}
// A duck-typed latency balancer WITHOUT the static LATENCY marker (nit 7): a clock still drives pick(now).
class DuckClockPick {
    constructor(n) { this.capacity = n; this.live = n; this.picks = []; this.rtts = 0; }
    pick(now) { this.picks.push(now); return 0; }
    isEligible() { return true; }
    recordRtt() { this.rtts++; }
}
// A balancer whose note(+1) throws (nit 8): the finally must NOT send an unpaired note(-1).
class ThrowingNotePlus {
    constructor(n) { this.capacity = n; this.live = n; this.calls = []; }
    pick() { return 0; }
    isEligible() { return true; }
    note(i, d) { void i; this.calls.push(d); if (d > 0) throw new Error('note-plus-boom'); }
}

test('B1 (H1): a fast-failing PeakEWMA node collapses to a tiny share (short fake-clock span; recovery -> B18)', async () => {
    const n = 4;
    const inflight = new Uint32Array(n);
    const pe = new PeakEwmaBalancer(n, up(n), inflight, 1e9, 0xABCDEF);
    const pool = new Pool(pe, inflight);
    const clock = msClock();
    const N = 2000;
    const dispatches = new Uint32Array(n);
    let failures = 0;
    for (let r = 0; r < N; r++) {
        try {
            await pool.run((i) => {
                dispatches[i]++;
                if (i === 0) throw new Error('node0 always fails');   // node 0: fast fail
                return 'ok';                                          // nodes 1..3: succeed
            }, { clock });                                            // tries:1 -> a node-0 dispatch is a failure
        } catch { failures++; }
    }
    assert.ok(dispatches[0] >= 1, 'node 0 receives a (small, non-zero) share');
    assert.ok(dispatches[0] < N * 0.1, 'node 0 share far below the old ~49% share of 988/2000 (got ' + dispatches[0] + ')');
    assert.ok(failures < N * 0.1, 'failure rate far below the old 49.4% (got ' + failures + '/' + N + ')');
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0, 'net-zero on node ' + i);
});

test('B2 (H1): a HUNG PeakEWMA node does not attract unbounded traffic (bounded concurrency)', async () => {
    const n = 4;
    const inflight = new Uint32Array(n);
    const pe = new PeakEwmaBalancer(n, up(n), inflight, 1e9, 0x1234);
    const pool = new Pool(pe, inflight);
    const clock = msClock();
    const N = 400;
    const dispatches = new Uint32Array(n);
    for (let r = 0; r < N; r++) {
        const p = pool.run((i) => {
            dispatches[i]++;
            if (i === 0) return new Promise(() => {});   // node 0: never settles (hung)
            return tick();                                // others settle promptly
        }, { clock });
        p.then(() => {}, () => {});                       // swallow: the hung runs never settle
        await tick();                                     // let the settled runs drain between launches
    }
    assert.ok(dispatches[0] >= 1, 'node 0 sees some traffic');
    assert.ok(dispatches[0] <= 20, 'hung node 0 attraction stays bounded, nowhere near the old ~49% (got ' + dispatches[0] + ')');
    for (let i = 1; i < n; i++) assert.equal(inflight[i], 0, 'healthy node ' + i + ' drained');
    assert.equal(inflight[0], dispatches[0], 'exactly the hung dispatches remain in flight on node 0');
});

test('B3a (M4): a throwing settle clock after SUCCESS rejects LITE_PICK_FEEDBACK, preserving fn result', async () => {
    const n = 2;
    const inflight = new Uint32Array(n);
    const pe = new PeakEwmaBalancer(n, up(n), inflight, 1e9, 0xABC);
    const pool = new Pool(pe, inflight);
    let reads = 0;
    const clock = () => { reads++; if (reads >= 2) throw new Error('settle-clock-boom'); return 1000; };
    let calls = 0;
    await assert.rejects(
        pool.run((i) => { void i; calls++; return 'value-ok'; }, { clock, tries: 3 }),
        (e) => e.code === 'LITE_PICK_FEEDBACK' && e.result === 'value-ok' && /settle-clock-boom/.test(e.cause.message),
    );
    assert.equal(calls, 1, 'fn ran exactly once (a settle-feedback error never re-runs fn)');
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0);
});

test('B3b (M4): a NaN settle clock after SUCCESS rejects LITE_PICK_FEEDBACK, preserving fn result', async () => {
    const n = 2;
    const inflight = new Uint32Array(n);
    const pe = new PeakEwmaBalancer(n, up(n), inflight, 1e9, 0xABC);
    const pool = new Pool(pe, inflight);
    let reads = 0;
    const clock = () => { reads++; return reads >= 2 ? NaN : 1000; };
    let calls = 0;
    await assert.rejects(
        pool.run((i) => { void i; calls++; return 'v2'; }, { clock, tries: 3 }),
        (e) => e.code === 'LITE_PICK_FEEDBACK' && e.result === 'v2' && /finite number/.test(e.cause.message),
    );
    assert.equal(calls, 1);
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0);
});

test('B3c (M4): a throwing recordRtt after SUCCESS rejects LITE_PICK_FEEDBACK, preserving fn result', async () => {
    const inflight = new Uint32Array(2);
    const pool = new Pool(new ThrowingRttLatency(2), inflight);
    let calls = 0;
    await assert.rejects(
        pool.run((i) => { void i; calls++; return 'r'; }, { clock: msClock(), tries: 3 }),
        (e) => e.code === 'LITE_PICK_FEEDBACK' && e.result === 'r' && /rtt-feedback-boom/.test(e.cause.message),
    );
    assert.equal(calls, 1, 'fn ran exactly once');
    for (let i = 0; i < 2; i++) assert.equal(inflight[i], 0);
});

test('B3d (M4): a backwards-stepping but finite clock records NO sample and RESOLVES', async () => {
    const n = 2;
    const inflight = new Uint32Array(n);
    const pe = new PeakEwmaBalancer(n, up(n), inflight, 1e9, 0xABC);
    const pool = new Pool(pe, inflight);
    let reads = 0;
    const clock = () => { reads++; return reads === 1 ? 5000 : 2000; };   // done < now: a non-monotonic quirk
    let endpoint = -1;
    const out = await pool.run((i) => { endpoint = i; return 'ok:' + i; }, { clock });
    assert.equal(out, 'ok:' + endpoint, 'resolves normally -- a finite clock quirk is not a rejection');
    // No fabricated 0 ns sample: the sample count is unchanged and the endpoint is still unsampled.
    assert.equal(pe._samp[1], 0, 'no sample recorded for a backwards reading');
    assert.ok(pe._stamp[endpoint] < 0, 'endpoint stays unsampled');
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0);
});

test('B3e (M4): a coarse clock (done === now) records a REAL 0 ns sample', async () => {
    const n = 2;
    const inflight = new Uint32Array(n);
    const pe = new PeakEwmaBalancer(n, up(n), inflight, 1e9, 0xABC);
    const pool = new Pool(pe, inflight);
    const clock = () => 7000;                                               // never advances: coarse clock
    const out = await pool.run((i) => 'ok:' + i, { clock });
    assert.ok(out.startsWith('ok:'));
    assert.equal(pe._samp[1], 1, 'done === now is a genuine reading and is recorded');
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0);
});

test('B4 (M4): a non-finite clock reading throws BEFORE dispatch, in-flight net-zero', async () => {
    const n = 4;
    const inflight = new Uint32Array(n);
    const pe = new PeakEwmaBalancer(n, up(n), inflight, 1e9, 0xABC);
    const pool = new Pool(pe, inflight);
    let calls = 0;
    await assert.rejects(
        pool.run((i) => { void i; calls++; return 'ok'; }, { clock: () => NaN }),
        /\[lite-pick\] clock\(\) must return a finite number/,
    );
    assert.equal(calls, 0, 'fn never dispatched on a broken clock');
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0);
});

test('B5 (M3): a keyed balancer without a numeric opts.key throws (fail closed, names the option)', async () => {
    const n = 8;
    const inflight = new Uint32Array(n);
    const ch = new ConsistentHashBalancer(n, up(n), null, 257);
    const pool = new Pool(ch, inflight);
    await assert.rejects(
        pool.run(() => 'never'),
        (e) => e.code === 'LITE_PICK_KEY_REQUIRED' && /opts\.key/.test(e.message),
    );
    await assert.rejects(
        pool.run(() => 'never', { key: 'nope' }),   // non-numeric key
        (e) => e.code === 'LITE_PICK_KEY_REQUIRED',
    );
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0);
});

test('B6 (M3): a latency balancer without opts.clock throws (fail closed, names the option)', async () => {
    const n = 4;
    const inflight = new Uint32Array(n);
    const pe = new PeakEwmaBalancer(n, up(n), inflight, 1e9, 0xABCDEF);
    const pool = new Pool(pe, inflight);
    await assert.rejects(
        pool.run((i) => 'ok:' + i),
        (e) => e.code === 'LITE_PICK_CLOCK_REQUIRED' && /opts\.clock/.test(e.message),
    );
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0);
});

test('B7 (M3): the clock reading goes to a latency pick as `now`, never the key', async () => {
    const inflight = new Uint32Array(2);
    const spy = new SpyLatency(2);
    const pool = new Pool(spy, inflight);
    await pool.run(() => 'ok', { clock: () => 12345, key: 999 });
    assert.equal(spy.picks[0], 12345, 'pick(now) received the clock reading');
    assert.notEqual(spy.picks[0], 999, 'the key never reached PeakEWMA as `now`');
    for (let i = 0; i < 2; i++) assert.equal(inflight[i], 0);
});

test('B7 (M3): the key goes to a keyed pick, never a clock reading', async () => {
    const inflight = new Uint32Array(2);
    const spy = new SpyKeyed(2);
    const pool = new Pool(spy, inflight);
    await pool.run(() => 'ok', { key: 777, clock: () => 555 });
    assert.equal(spy.picks[0], 777, 'pick(key) received the key');
    assert.notEqual(spy.picks[0], 555, 'the clock reading was never used as the hash key');
    for (let i = 0; i < 2; i++) assert.equal(inflight[i], 0);
});

test('B8 (M2): ConsistentHash keyed failover reaches 3 DISTINCT backends (tries=3)', async () => {
    const n = 8;
    const inflight = new Uint32Array(n);
    const ch = new ConsistentHashBalancer(n, up(n), null, 257, 0xC0FFEE);
    const pool = new Pool(ch, inflight);
    const seen = [];
    await assert.rejects(
        pool.run((i) => { seen.push(i); throw new Error('fail-' + i); }, { key: 0xDEADBEEF, tries: 3 }),
        /fail-/,
    );
    assert.equal(seen.length, 3, 'three attempts');
    assert.equal(new Set(seen).size, 3, 'three DISTINCT backends (got ' + seen.join(',') + ')');
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0);
});

test('B9 (M2): WeightedRandom 100:1 failover reaches 2 DISTINCT endpoints (tries=2)', async () => {
    const inflight = new Uint32Array(2);
    const weights = new Uint32Array([100, 1]);
    const wr = new WeightedRandomBalancer(2, up(2), weights, 0x5EED);
    const pool = new Pool(wr, inflight);
    const seen = [];
    await assert.rejects(
        pool.run((i) => { seen.push(i); throw new Error('fail'); }, { tries: 2 }),
        /fail/,
    );
    assert.equal(seen.length, 2, 'two attempts');
    assert.notEqual(seen[0], seen[1], 'DISTINCT endpoints (got ' + seen.join(',') + ')');
    for (let i = 0; i < 2; i++) assert.equal(inflight[i], 0);
});

test('B10 (M2): LeastConn inflight [0,5] failover picks [0,1] (tries=2)', async () => {
    const inflight = new Uint32Array([0, 5]);
    const lc = new LeastConnBalancer(2, up(2), inflight);
    const pool = new Pool(lc, inflight);
    const seen = [];
    await assert.rejects(
        pool.run((i) => { seen.push(i); throw new Error('fail'); }, { tries: 2 }),
        /fail/,
    );
    assert.deepEqual(seen, [0, 1], 'first the least-loaded (0), then the DISTINCT untried (1)');
    assert.equal(inflight[0], 0, 'node 0 released');
    assert.equal(inflight[1], 5, 'the pre-seeded load on node 1 is restored net-zero');
});

test('B11 (M2): failover STOPS when fewer distinct endpoints than tries (never re-hammers)', async () => {
    const n = 2;
    const inflight = new Uint32Array(n);
    const lc = new LeastConnBalancer(n, up(n), inflight);
    const pool = new Pool(lc, inflight);
    const seen = [];
    await assert.rejects(
        pool.run((i) => { seen.push(i); throw new Error('fail-' + i); }, { tries: 5 }),
        /fail-/,
    );
    assert.equal(seen.length, 2, 'only 2 distinct endpoints exist -> exactly 2 attempts, no re-hammer');
    assert.equal(new Set(seen).size, 2, 'both attempts distinct');
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0);
});

test('B12 (abort-before-every): an already-aborted signal dispatches nothing', async () => {
    const n = 4;
    const inflight = new Uint32Array(n);
    const pool = new Pool(new LeastConnBalancer(n, up(n), inflight), inflight);
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    await assert.rejects(pool.run((i) => { void i; calls++; return 'ok'; }, { signal: ac.signal, tries: 4 }));
    assert.equal(calls, 0, 'fn never dispatched for a pre-aborted signal');
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0);
});

test('B13 (L1): run(fn, null) and run(fn, undefined) work (null-safe options)', async () => {
    const n = 4;
    const inflight = new Uint32Array(n);
    const pool = new Pool(new LeastConnBalancer(n, up(n), inflight), inflight);
    const a = await pool.run((i) => 'a:' + i, null);
    const b = await pool.run((i) => 'b:' + i, undefined);
    assert.match(a, /^a:\d$/);
    assert.match(b, /^b:\d$/);
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0);
});

test('B12b (abort): a structural aborted signal with NO throwIfAborted dispatches nothing', async () => {
    const n = 4;
    const inflight = new Uint32Array(n);
    const pool = new Pool(new LeastConnBalancer(n, up(n), inflight), inflight);
    let calls = 0;
    await assert.rejects(
        pool.run((i) => { void i; calls++; return 'ok'; }, { signal: { aborted: true }, tries: 4 }),
        (e) => e.code === 'LITE_PICK_ABORTED',
    );
    assert.equal(calls, 0, 'no dispatch despite the missing throwIfAborted (no fail-open)');
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0);
});

test('B12c (abort): a NO-OP throwIfAborted still dispatches nothing (Pool always throws)', async () => {
    const n = 4;
    const inflight = new Uint32Array(n);
    const pool = new Pool(new LeastConnBalancer(n, up(n), inflight), inflight);
    let calls = 0;
    await assert.rejects(
        pool.run((i) => { void i; calls++; return 'ok'; }, { signal: { aborted: true, throwIfAborted() {} }, tries: 4 }),
        (e) => e.code === 'LITE_PICK_ABORTED',
    );
    assert.equal(calls, 0, 'a no-op throwIfAborted does not let a dispatch slip through');
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0);
});

test('B12d (abort): a structural signal reason is thrown when present', async () => {
    const n = 2;
    const inflight = new Uint32Array(n);
    const pool = new Pool(new LeastConnBalancer(n, up(n), inflight), inflight);
    const reason = new Error('custom-abort-reason');
    let calls = 0;
    await assert.rejects(
        pool.run((i) => { void i; calls++; return 'ok'; }, { signal: { aborted: true, reason }, tries: 3 }),
        (e) => e === reason,
    );
    assert.equal(calls, 0);
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0);
});

test('B14 (M4): a throwing PENALTY clock preserves fn error identity + attaches feedback', async () => {
    const n = 4;
    const inflight = new Uint32Array(n);
    const pe = new PeakEwmaBalancer(n, up(n), inflight, 1e9, 0xABC);
    const pool = new Pool(pe, inflight);
    let reads = 0;
    const clock = () => { reads++; if (reads >= 2) throw new Error('penalty-clock-boom'); return 1000; };
    const fnErr = new Error('fn-failed');
    let thrown;
    try { await pool.run(() => { throw fnErr; }, { clock, tries: 3 }); } catch (e) { thrown = e; }
    assert.equal(thrown, fnErr, 'fn error object thrown by IDENTITY, never replaced');
    assert.equal(thrown.liteFeedbackError.message, 'penalty-clock-boom', 'feedback error attached');
    assert.ok(!Object.keys(thrown).includes('liteFeedbackError'), 'attachment is NON-enumerable');
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0);
});

test('B15 (M4): a throwing PENALTY recordRtt preserves fn error identity + attaches feedback', async () => {
    const inflight = new Uint32Array(2);
    const pool = new Pool(new ThrowingRttLatency(2), inflight);
    const fnErr = new Error('fn-boom');
    let thrown;
    try { await pool.run(() => { throw fnErr; }, { clock: msClock(), tries: 3 }); } catch (e) { thrown = e; }
    assert.equal(thrown, fnErr, 'fn error object thrown by identity');
    assert.equal(thrown.liteFeedbackError.message, 'rtt-feedback-boom');
    for (let i = 0; i < 2; i++) assert.equal(inflight[i], 0);
});

test('B15b (M4): a penalty hook that throws NULL is still a feedback failure (failover stops, fn ran once)', async () => {
    const n = 4;
    const inflight = new Uint32Array(n);
    const pe = new PeakEwmaBalancer(n, up(n), inflight, 1e9, 0xABC);
    pe.recordRtt = () => { throw null; };      // pathological hook: throws null, not an Error
    const pool = new Pool(pe, inflight);
    const fnErr = new Error('fn-null');
    let calls = 0, thrown;
    try { await pool.run(() => { calls++; throw fnErr; }, { clock: msClock(), tries: 3 }); } catch (e) { thrown = e; }
    assert.equal(calls, 1, 'a null throw must not be mistaken for success -- no failover past a broken hook');
    assert.equal(thrown, fnErr, 'fn error object thrown by identity');
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0);
});

test('B16 (M4): a non-finite PENALTY clock reading is handled like a broken clock (identity preserved)', async () => {
    const n = 4;
    const inflight = new Uint32Array(n);
    const pe = new PeakEwmaBalancer(n, up(n), inflight, 1e9, 0xABC);
    const pool = new Pool(pe, inflight);
    let reads = 0;
    const clock = () => { reads++; return reads >= 2 ? Infinity : 1000; };
    const fnErr = new Error('fn-x');
    let thrown;
    try { await pool.run(() => { throw fnErr; }, { clock, tries: 3 }); } catch (e) { thrown = e; }
    assert.equal(thrown, fnErr);
    assert.ok(/finite number/.test(thrown.liteFeedbackError.message), 'non-finite done handled as a broken clock, never a silent skip');
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0);
});

test('B17 (M2): keyed failover SPREADS across backends (no single-neighbour hotspot) and is stable per key', async () => {
    const n = 8;
    const inflight = new Uint32Array(n);
    const ch = new ConsistentHashBalancer(n, up(n), null, 257, 0xC0FFEE);
    const pool = new Pool(ch, inflight);
    // Collect keys that all HOME onto one backend, so failover from that one backend is what we measure.
    const byHome = Array.from({ length: n }, () => []);
    for (let kk = 0; kk < 60000 && byHome.filter((a) => a.length >= 100).length < 1; kk++) {
        const key = (Math.imul(kk + 1, 2654435761) >>> 0);
        const home = ch.pick(key);
        if (byHome[home].length < 200) byHome[home].push(key);
    }
    const h0 = byHome.findIndex((a) => a.length >= 100);
    assert.ok(h0 >= 0, 'found a home backend with enough keys');
    const keys = byHome[h0].slice(0, 100);
    const targetCount = new Uint32Array(n);
    const firstTarget = new Map();
    async function failover(key) {
        const seen = [];
        await pool.run((i) => { seen.push(i); if (seen.length === 1) throw new Error('home-fail'); return 'ok'; }, { key, tries: 2 });
        return { home: seen[0], target: seen[1] };
    }
    for (const key of keys) {
        const { home, target } = await failover(key);
        assert.equal(home, h0, 'all keys home to h0');
        targetCount[target]++;
        firstTarget.set(key, target);
    }
    let max = 0; for (let i = 0; i < n; i++) max = Math.max(max, targetCount[i]);
    assert.ok(max < keys.length * 0.4, 'no single backend absorbs >= 40% of failovers (max ' + (100 * max / keys.length).toFixed(1) + '%)');
    for (const key of keys.slice(0, 30)) {
        const { target } = await failover(key);
        assert.equal(target, firstTarget.get(key), 'each key\'s failover target is stable across runs');
    }
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0);
});

// Drives a 4-node PeakEWMA pool where node 0 always throws; returns the measured re-probe cadence.
async function measureReprobe(tau, step, penalty, N) {
    const n = 4;
    const inflight = new Uint32Array(n);
    const pe = new PeakEwmaBalancer(n, up(n), inflight, tau, 0x5EED);
    const pool = new Pool(pe, inflight);
    let t = 0;
    const clock = () => (t += step);
    const d = new Uint32Array(n);
    const probeTimes = [];
    const opts = penalty === undefined ? { clock } : { clock, failurePenaltyNs: penalty };
    for (let r = 0; r < N; r++) {
        try {
            await pool.run((i) => { d[i]++; if (i === 0) { probeTimes.push(t); throw new Error('x'); } return 'ok'; }, opts);
        } catch { /* node-0 dispatch is a failure */ }
    }
    const gaps = [];
    for (let i = 1; i < probeTimes.length; i++) gaps.push(probeTimes[i] - probeTimes[i - 1]);
    const avg = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : NaN;
    return { avg, probes: probeTimes.length, share0: d[0] / N, inflight };
}

test('B18 (H1): a failed PeakEWMA node is periodically RE-PROBED at ~tau*ln(penalty/rtt), share stays low', async () => {
    const tau = 3e7;                          // 30 ms (the README value)
    const step = 1e6;                         // 1 ms per clock read (the healthy rtt scale)
    const N = 4000;
    // Default penalty (1e9): cadence ~ tau*ln(1e9/1e6). The band is tight in LOG space (|ln ratio| < 0.3,
    // i.e. within ~0.74x-1.35x) because the model is logarithmic: a +/-3x band would accept penalty
    // errors of several orders of magnitude.
    const base = await measureReprobe(tau, step, undefined, N);
    const expBase = tau * Math.log(1e9 / step);
    assert.ok(base.probes >= 4, 'node 0 is re-probed periodically -- recovery works (got ' + base.probes + ')');
    assert.ok(base.share0 < 0.05, 'steady-state share stays low (' + base.share0 + ')');
    assert.ok(Math.abs(Math.log(base.avg / expBase)) < 0.3,
        'default cadence ~ tau*ln(penalty/rtt): avg ' + base.avg.toExponential(2) + ' vs ' + expBase.toExponential(2));
    // A 1000x larger penalty must roughly DOUBLE the cadence (ln(1e12/1e6) / ln(1e9/1e6) = 2): proves the
    // cadence actually depends on failurePenaltyNs as documented.
    const big = await measureReprobe(tau, step, 1e12, N);
    const expBig = tau * Math.log(1e12 / step);
    assert.ok(Math.abs(Math.log(big.avg / expBig)) < 0.3,
        'penalty 1e12 cadence: avg ' + big.avg.toExponential(2) + ' vs ' + expBig.toExponential(2));
    const ratio = big.avg / base.avg;
    assert.ok(Math.abs(Math.log(ratio / 2)) < 0.2, 'cadence ratio ~2 for a 1000x penalty (got ' + ratio.toFixed(2) + ')');
    for (const r of [base, big]) for (let i = 0; i < 4; i++) assert.equal(r.inflight[i], 0);
});

test('B19 (nit 7): a duck-typed latency balancer WITHOUT static LATENCY still gets pick(now) when a clock is supplied', async () => {
    const inflight = new Uint32Array(2);
    const duck = new DuckClockPick(2);
    const pool = new Pool(duck, inflight);
    await pool.run(() => 'ok', { clock: () => 4242 });
    assert.equal(duck.picks[0], 4242, 'pick received the clock reading as `now` (1.0.0 behaviour preserved)');
    assert.equal(duck.rtts, 1, 'recordRtt fed on settle');
    for (let i = 0; i < 2; i++) assert.equal(inflight[i], 0);
});

test('B20 (nit 8): a throwing note(+1) is not followed by an UNPAIRED note(-1)', async () => {
    const inflight = new Uint32Array(2);
    const bal = new ThrowingNotePlus(2);
    const pool = new Pool(bal, inflight);
    await assert.rejects(pool.run(() => 'ok'), /note-plus-boom/);
    assert.deepEqual(bal.calls, [1], 'only the throwing note(+1); the finally sent NO unpaired note(-1)');
    for (let i = 0; i < 2; i++) assert.equal(inflight[i], 0, 'inflight still released net-zero');
});

// =====================================================================================
// 1.0.2 regression suite: N1 (abort is not a penalty) / N2 (unmarked balancers keep opts.key).
// =====================================================================================

test('C1 (N1): a caller abort mid-flight feeds NO penalty -- the endpoint keeps its estimate and its share', async () => {
    const n = 4;
    const inflight = new Uint32Array(n);
    const pe = new PeakEwmaBalancer(n, up(n), inflight, 1e9, 0xABCDEF);
    const pool = new Pool(pe, inflight);
    const clock = msClock();
    for (let r = 0; r < 100; r++) await pool.run(() => 'ok', { clock });   // every node settles at ~1 ms
    let victim = -1;
    const ac = new AbortController();
    await assert.rejects(pool.run((i) => {
        victim = i;
        ac.abort();                       // the caller cancels mid-request (unmount, client timeout)
        throw new Error('aborted-mid-flight');
    }, { clock, signal: ac.signal }), /aborted-mid-flight/);
    assert.ok(victim >= 0, 'the aborted run dispatched');
    const now = clock();
    assert.ok(pe.ewmaAt(victim, now) <= 2e6,
        'no 1 s penalty: ewma stays at the ~1 ms scale (got ' + pe.ewmaAt(victim, now).toExponential(2) + ')');
    const hits = new Uint32Array(n);
    const N = 1000;
    for (let r = 0; r < N; r++) await pool.run((i) => { hits[i]++; return 'ok'; }, { clock });
    assert.ok(hits[victim] >= N * 0.2,
        'the aborted endpoint is not shunned: ' + hits[victim] + '/' + N + ' (hits ' + Array.from(hits).join(',') + ')');
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0, 'net-zero on node ' + i);
});

test('C1b (N1): a plain failure (no abort) still feeds the H1 penalty', async () => {
    const n = 4;
    const inflight = new Uint32Array(n);
    const pe = new PeakEwmaBalancer(n, up(n), inflight, 1e9, 0xABCDEF);
    const pool = new Pool(pe, inflight);
    const clock = msClock();
    for (let r = 0; r < 100; r++) await pool.run(() => 'ok', { clock });
    let victim = -1;
    await assert.rejects(pool.run((i) => { victim = i; throw new Error('plain-fail'); }, { clock }), /plain-fail/);
    assert.ok(pe.ewmaAt(victim, clock()) > 1e8, 'the penalty landed on a real failure');
});

test('C2 (N2): an UNMARKED wrapper around ConsistentHash still routes by opts.key (1.0.0 semantics)', async () => {
    const n = 8;
    const inflight = new Uint32Array(n);
    const ch = new ConsistentHashBalancer(n, up(n), null, 257, 0xC0FFEE);
    // A plain-object decorator with no static KEYED marker (the shape a user's wrapper takes).
    const wrapper = {
        capacity: ch.capacity,
        get live() { return ch.live; },
        pick: (k) => ch.pick(k),
        isEligible: (i) => ch.isEligible(i),
    };
    const pool = new Pool(wrapper, inflight);
    const reached = new Set();
    for (let k = 1; k <= 200; k++) {
        const got = await pool.run((i) => i, { key: Math.imul(k, 0x9e3779b1) >>> 0 });
        assert.equal(got, ch.pick(Math.imul(k, 0x9e3779b1) >>> 0), 'Pool routed key ' + k + ' exactly as pick(key)');
        reached.add(got);
    }
    assert.ok(reached.size >= 6, '200 keys reach >= 6 of 8 backends (got ' + reached.size + ')');
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0);
});

test('C3 (N2): an unmarked balancer given BOTH key and clock gets pick(key), and recordRtt is still fed', async () => {
    const inflight = new Uint32Array(2);
    const duck = new DuckClockPick(2);
    const pool = new Pool(duck, inflight);
    await pool.run(() => 'ok', { clock: () => 4242, key: 7 });
    assert.equal(duck.picks[0], 7, 'the key wins for an unmarked balancer, as in 1.0.0');
    assert.equal(duck.rtts, 1, 'latency feedback still fed on settle');
    for (let i = 0; i < 2; i++) assert.equal(inflight[i], 0);
});
