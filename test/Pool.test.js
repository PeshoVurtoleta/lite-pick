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
 *   K1-K12 (1.2.0, K10 + weight 0): the failover fallback is ONE weighted choice among untried, eligible,
 *       positive-weight endpoints -- every gate below also runs on the 1bc5eec Pick.js + Pool.js pair
 *       (`git show`) where the cap-8 / cap-64 bands, the weighted ratio, the tries-3 adjacency, the unkeyed
 *       spread and the weight-0 check FAIL (stability and determinism are non-regression gates there).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as PICK from '../Pick.js';
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
    assert.equal(pe._sampled[endpoint], 0, 'endpoint stays unsampled');
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
        (e) => /\[lite-pick\] clock\(\) must return a finite number/.test(e.message) &&
            e.code === 'LITE_PICK_CLOCK_INVALID',   // N7: coded like every other Pool error
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

test('C1c (D5, 1.1.0): a per-attempt timeout INSIDE fn is a failure -- it records the elapsed time as a peak and fails over', async () => {
    // The hung-node answer (research/1.1.0 5.3): an attempt-level timer, not the run's signal. The run's
    // signal stays un-aborted, so the timeout is the endpoint's fault: max(elapsed, penalty) is recorded.
    const n = 4;
    const inflight = new Uint32Array(n);
    const pe = new PeakEwmaBalancer(n, up(n), inflight, 1e9, 0xABCDEF);
    const pool = new Pool(pe, inflight);
    let t = 0;
    const clock = () => t;
    for (let r = 0; r < 100; r++) await pool.run(() => { t += 1e6; return 'ok'; }, { clock });   // ~1 ms each
    const ac = new AbortController();     // the CALLER's signal: never aborted here
    let hung = -1;
    const out = await pool.run((i, signal) => {
        assert.equal(signal, ac.signal, 'fn sees the run signal; its own timer is separate');
        if (hung < 0) {
            hung = i;
            t += 3e9;                     // the attempt's own 3 s timer fires
            throw new DOMException('attempt timed out', 'TimeoutError');
        }
        t += 1e6;
        return 'ok:' + i;
    }, { clock, tries: 2, signal: ac.signal, failurePenaltyNs: 1e9 });
    assert.ok(out.startsWith('ok:') && out !== 'ok:' + hung, 'failed over to another endpoint');
    assert.ok(pe._ewma[hung] >= 3e9, 'the elapsed 3 s (> the 1 s penalty) is the peak sample: ' + pe._ewma[hung]);
    for (let i = 0; i < n; i++) assert.equal(inflight[i], 0, 'net-zero on node ' + i);
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

// =====================================================================================
// F1 boundary: attempt 0 is held in scalars (d0/e0/n0). A duck-typed balancer may return ANY value from
// pick() -- not just an index or PICK_NONE. Every note(i,+1) must be paired with note(i,-1) (same value,
// Object.is) and inflight must be left balanced, whether the run succeeds, throws, or fails over.
// =====================================================================================

class FixedPick {
    constructor(n, v) { this.capacity = n; this.live = n; this.v = v; this.notes = []; }
    pick() { return this.v; }
    isEligible() { return true; }
    note(i, d) { this.notes.push([i, d]); }
}

test('F1: a non-sentinel pick() (undefined/NaN/-2/\'x\'/null/-0/out-of-range/...) pairs every note(+1) with note(-1), inflight balanced', async () => {
    const n = 4;
    const values = [0, 1, n - 1, n, n + 1, 2 ** 32, '', null, undefined, NaN, -0, -2, 'x', '0', 1.5];
    const fnErr = new Error('f1-attempt-fail');
    for (const v of values) {
        const label = Object.is(v, -0) ? '-0' : typeof v === 'string' ? JSON.stringify(v) : String(v);
        for (const shape of ['ok', 'throw', 'failover']) {
            const inflight = new Uint32Array(n);
            const bal = new FixedPick(n, v);
            const pool = new Pool(bal, inflight);
            let calls = 0;
            let first;
            const fn = (i) => {
                if (calls++ === 0) {
                    first = i;
                    assert.ok(bal.notes.length === 1 && Object.is(bal.notes[0][0], v) && bal.notes[0][1] === 1,
                        label + '/' + shape + ': note(+1) landed for attempt 0 before fn ran');
                    if (shape !== 'ok') throw fnErr;
                }
                return 'ok';
            };
            const p = pool.run(fn, { tries: shape === 'failover' ? 2 : 1 });
            if (shape === 'throw') await assert.rejects(p, (e) => e === fnErr);
            else assert.equal(await p, 'ok');
            assert.ok(Object.is(first, v), label + '/' + shape + ': fn received the value pick() returned');
            const pending = [];
            let plus = 0, minus = 0;
            for (const [i, d] of bal.notes) {
                if (d === 1) { plus++; pending.push(i); continue; }
                minus++;
                const k = pending.findIndex((x) => Object.is(x, i));
                assert.ok(k >= 0, label + '/' + shape + ': note(' + String(i) + ', -1) has no matching note(+1)');
                pending.splice(k, 1);
            }
            assert.equal(plus, shape === 'failover' ? 2 : 1, label + '/' + shape + ': dispatch count');
            assert.equal(minus, plus, label + '/' + shape + ': every note(+1) is paired with a note(-1)');
            assert.equal(pending.length, 0, label + '/' + shape + ': no unpaired note(+1)');
            for (const key of Object.keys(inflight)) {
                assert.equal(inflight[key], 0, label + '/' + shape + ': inflight[' + key + '] left at ' + inflight[key]);
            }
        }
    }
});

// =====================================================================================
// M4 / M5 (kill): the distinct-failover internals -- the bounded re-pick (REPICK_LIMIT) and the
// rotating per-Pool scan cursor. Both survive the real-balancer failover tests above (B8-B11),
// which never distinguish a re-pick result from a scan result, nor chain enough unkeyed runs to
// observe the cursor rotating. Scripted / fixed stubs below make each one load-bearing.
// =====================================================================================

// A balancer whose pick() replays a fixed script of return values (no note(): the notes branch is off).
class ScriptPick {
    constructor(n, script, down = -1) { this.capacity = n; this.live = n; this.script = script; this.i = 0; this.down = down; }
    pick() { const v = this.script[this.i]; this.i++; return v; }
    isEligible(i) { return i !== this.down; }
}

test('M4 (kill): a re-pick that yields a DISTINCT untried endpoint is used BEFORE the fallback choice', async () => {
    const N = 4, inflight = new Uint32Array(N);
    // attempt 0 picks 0 (fails); attempt 1 first repeats 0 (already tried), then the bounded re-pick
    // yields 2 (distinct, untried) -> 2 is used. With REPICK_LIMIT = 0 the re-pick loop never runs, so 0
    // stays tried and Pool falls to the weighted fallback, which CANNOT return 2: the stub reports 2 as
    // not eligible (the re-pick result is used as-is; only the fallback consults isEligible).
    const pool = new Pool(new ScriptPick(N, [0, 0, 2], 2), inflight);
    const seen = [];
    await assert.rejects(
        pool.run((i) => { seen.push(i); throw new Error('fail-' + i); }, { tries: 2 }),
        /fail-/,
    );
    assert.deepEqual(seen, [0, 2],
        'the bounded re-pick found the distinct endpoint 2 before the fallback (REPICK_LIMIT=0 mutant: never 2)');
    for (let i = 0; i < N; i++) assert.equal(inflight[i], 0, 'inflight net-zero');
});

test('M5 (kill, K4): the unkeyed fallback spreads uniformly (no weightOf -> weight 1) and advances _failSeq', async () => {
    const r = await unkeyedSpread({ P: PICK, Pool }, 5, 4000);
    assert.ok(r.ok, 'FixedPick of 5, 4000 runs: nodes 1-4 each 1000 +-12% (got ' + r.counts.join(',') + ')');
    for (let i = 0; i < 5; i++) assert.equal(r.inflight[i], 0, 'inflight net-zero');
    const mut = await loadPair(readFileSync(PICK_PATH, 'utf8'), patchOnce(readFileSync(POOL_PATH, 'utf8'),
        '(this._failSeq = (this._failSeq + 1) & 0x3fffffff)', 'this._failSeq'));
    const m = await unkeyedSpread(mut, 5, 4000);
    assert.ok(!m.ok, 'a Pool that never advances _failSeq pins one target (got ' + m.counts.join(',') + ')');
});

// =====================================================================================
// K1-K7 (1.2.0, ASSERTION 2): K10 neighbour double share + weight-0 failover. Every gate is a function of
// a { P (Pick module), Pool } pair, so the SAME gate runs on the in-tree pair and on the 1bc5eec pair.
// =====================================================================================

const PICK_PATH = fileURLToPath(new URL('../Pick.js', import.meta.url));
const POOL_PATH = fileURLToPath(new URL('../Pool.js', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IN_TREE = { P: PICK, Pool };

/** Replace exactly one occurrence (a mutant anchor that moved fails loudly instead of testing nothing). */
function patchOnce(src, from, to) {
    assert.equal(src.split(from).length - 1, 1, 'mutant anchor found once: ' + from);
    return src.split(from).join(to);
}

/** Import a Pick.js + Pool.js pair from source text (Pool resolves './Pick.js' to the SAME side). */
async function loadPair(pickSrc, poolSrc) {
    const dir = mkdtempSync(join(tmpdir(), 'litepick-pool-'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'Pick.js'), pickSrc);
    writeFileSync(join(dir, 'Pool.js'), poolSrc);
    try {
        const P = await import(pathToFileURL(join(dir, 'Pick.js')).href);
        const Q = await import(pathToFileURL(join(dir, 'Pool.js')).href);
        return { P, Pool: Q.Pool };
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Seeded xorshift32 u32 keys (never 0). */
function xs(seed) {
    let x = seed >>> 0 || 1;
    return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
}

/** Keyed CH: NK keys homed on `home` fail on attempt 0; returns the attempt-1 histogram. */
async function keyedSpill(M, cap, weights, home, NK, seed) {
    const ch = new M.P.ConsistentHashBalancer(cap, up(cap), weights ? Uint32Array.from(weights) : null);
    const inflight = new Uint32Array(cap), pool = new M.Pool(ch, inflight), rnd = xs(seed);
    const hist = new Float64Array(cap), fail = new Error('home');
    let att = 0, a1 = -1;
    const fn = (i) => { if (att++ === 0) throw fail; a1 = i; return 1; };
    for (let n = 0; n < NK;) {
        const k = rnd();
        if (ch.pick(k) !== home) continue;
        n++; att = 0; a1 = -1;
        await pool.run(fn, { key: k, tries: 2 });
        hist[a1]++;
    }
    for (let i = 0; i < cap; i++) assert.equal(inflight[i], 0, 'inflight net-zero');
    return hist;
}

/** K1/K2: every survivor of each home within +-band of NK / (cap - 1). */
async function bandGate(M, cap, homes, band, NK = 20000) {
    let worst = 0;
    for (const h of homes) {
        const hist = await keyedSpill(M, cap, null, h, NK, 0x51ee0000 + h);
        const ideal = NK / (cap - 1);
        if (hist[h] !== 0) worst = Infinity;
        for (let i = 0; i < cap; i++) if (i !== h) worst = Math.max(worst, Math.abs(hist[i] - ideal) / ideal);
    }
    return { ok: worst <= band, worst };
}

/** K3: [1,1,1,1,4,4,4,4], every home: mean(w4 survivor count) / mean(w1 survivor count), averaged. */
async function weightedRatio(M, NK = 20000) {
    const W = [1, 1, 1, 1, 4, 4, 4, 4];
    let sum = 0;
    for (let h = 0; h < 8; h++) {
        const hist = await keyedSpill(M, 8, W, h, NK, 0x3e1c0000 + h);
        let s1 = 0, n1 = 0, s4 = 0, n4 = 0;
        for (let i = 0; i < 8; i++) if (i !== h) { if (W[i] === 1) { s1 += hist[i]; n1++; } else { s4 += hist[i]; n4++; } }
        sum += (s4 / n4) / (s1 / n1);
    }
    const ratio = sum / 8;
    return { ok: ratio >= 3.6 && ratio <= 4.4, ratio };
}

/** K4: tries 3, every attempt fails: attempt 2 == attempt 1 + 1 (mod 8) in <= 25% of runs. */
async function adjacency(M, runs = 4000) {
    const ch = new M.P.ConsistentHashBalancer(8, up(8), null);
    const pool = new M.Pool(ch, new Uint32Array(8)), rnd = xs(0xad1ace17);
    let adj = 0, short = 0;
    for (let r = 0; r < runs; r++) {
        const seen = [];
        await pool.run((i) => { seen.push(i); throw new Error('x'); }, { key: rnd(), tries: 3 }).catch(() => {});
        if (seen.length !== 3 || new Set(seen).size !== 3) short++;   // every run must reach 3 DISTINCT attempts
        else if (seen[2] === ((seen[1] + 1) & 7)) adj++;
    }
    return { ok: short === 0 && adj <= runs * 0.25, share: adj / runs, short };
}

/** K5: the same key fails over to the same target, on the same Pool and on a fresh one (30 keys). */
async function stablePerKey(M) {
    const mk = () => new M.Pool(new M.P.ConsistentHashBalancer(8, up(8), Uint32Array.from([1, 2, 3, 4, 1, 2, 3, 4])), new Uint32Array(8));
    const a = mk(), b = mk(), rnd = xs(0x57ab1e00);
    const target = async (pool, key) => { let att = 0, t = -1; await pool.run((i) => { if (att++ === 0) throw new Error('x'); t = i; }, { key, tries: 2 }); return t; };
    let same = 0;
    for (let k = 0; k < 30; k++) {
        const key = rnd();
        const t0 = await target(a, key);
        if (t0 >= 0 && t0 === await target(a, key) && t0 === await target(b, key)) same++;
    }
    return { ok: same === 30, same };
}

/** K4 unkeyed: FixedPick(n, 0) fails on 0 every run; nodes 1..n-1 each runs / (n - 1) +-12%. */
async function unkeyedSpread(M, n, runs) {
    const inflight = new Uint32Array(n), pool = new M.Pool(new FixedPick(n, 0), inflight);
    const counts = new Array(n).fill(0);
    for (let r = 0; r < runs; r++) {
        let att = 0;
        await pool.run((i) => { if (att++ === 0) throw new Error('x'); counts[i]++; }, { tries: 2 });
    }
    const ideal = runs / (n - 1);
    let ok = counts[0] === 0;
    for (let i = 1; i < n; i++) if (Math.abs(counts[i] - ideal) > ideal * 0.12) ok = false;
    return { ok, counts, inflight };
}

/** K6: two fresh Pools replay the same first 64 unkeyed failover targets (and the sequence is not constant). */
async function freshReplay(M) {
    const seq = async () => {
        const pool = new M.Pool(new FixedPick(8, 0), new Uint32Array(8)), out = [];
        for (let r = 0; r < 64; r++) { let att = 0; await pool.run((i) => { if (att++ === 0) throw new Error('x'); out.push(i); }, { tries: 2 }); }
        return out;
    };
    const a = await seq(), b = await seq();
    return { ok: a.length === 64 && a.join() === b.join() && new Set(a).size > 1, a };
}

/** K7: the research-1.3 weight-0 scenarios, 2e4 runs each: 0 failover dispatches to a weight-0 backend;
 *  [1,0,0,0] dispatches exactly once and rejects with attempt 0's error (same identity). */
async function weightZero(M, NR = 20000) {
    const P = M.P;
    const kinds = [
        ['ConsistentHash', true, (c, e, i, w) => new P.ConsistentHashBalancer(c, e, w)],
        ['BoundedLoad', true, (c, e, i, w) => new P.BoundedLoadBalancer(c, e, i, 0.25, w)],
        ['SmoothWRR', false, (c, e, i, w) => new P.SmoothWRRBalancer(c, e, w)],
        ['WeightedRandom', false, (c, e, i, w) => new P.WeightedRandomBalancer(c, e, w)],
        ['SED', false, (c, e, i, w) => new P.SedBalancer(c, e, i, w)],
        ['NQ', false, (c, e, i, w) => new P.NqBalancer(c, e, i, w)],
    ];
    let toZero = 0, badSingle = 0;
    for (const W of [[1, 0, 0, 0], [1, 1, 1, 1, 0, 0, 0, 0]]) {
        for (const [, keyed, mk] of kinds) {
            const cap = W.length, inflight = new Uint32Array(cap);
            const pool = new M.Pool(mk(cap, up(cap), inflight, Uint32Array.from(W)), inflight);
            const rnd = xs(0xbadc0de5);
            for (let r = 0; r < NR; r++) {
                const seen = [], e0 = new Error('attempt0');
                let got;
                try {
                    await pool.run((i) => { seen.push(i); if (seen.length === 1) throw e0; return 1; }, keyed ? { key: rnd(), tries: 2 } : { tries: 2 });
                } catch (e) { got = e; }
                for (let k = 1; k < seen.length; k++) if (W[seen[k]] === 0) toZero++;
                if (cap === 4 && (seen.length !== 1 || got !== e0)) badSingle++;
            }
            for (let i = 0; i < cap; i++) if (inflight[i] !== 0) badSingle++;
        }
    }
    return { ok: toZero === 0 && badSingle === 0, toZero, badSingle };
}

const K_GATES = [
    ['K1 CH cap 8 homes {0,3,7}: every survivor within +-10% of 2e4/7', (M) => bandGate(M, 8, [0, 3, 7], 0.10)],
    ['K2 CH cap 64 homes {0,31,63}: every survivor within +-30% of 2e4/63', (M) => bandGate(M, 64, [0, 31, 63], 0.30)],
    ['K3 weighted [1,1,1,1,4,4,4,4]: mean w4/w1 spill ratio in [3.6, 4.4]', (M) => weightedRatio(M)],
    ['K4 tries 3: attempt 2 == attempt 1 + 1 (mod 8) in <= 25% of runs', (M) => adjacency(M)],
    ['K4u unkeyed FixedPick of 5, 4000 runs: nodes 1-4 each 1000 +-12%', (M) => unkeyedSpread(M, 5, 4000)],
    ['K5 same key same target 30/30 (same Pool and a fresh one)', (M) => stablePerKey(M)],
    ['K6 two fresh Pools replay the same first 64 unkeyed targets', (M) => freshReplay(M)],
    ['K7 weight 0: no failover to a weight-0 backend; [1,0,0,0] stops after attempt 0 with its error', (M) => weightZero(M)],
];
/** The gates the 1bc5eec pair must FAIL (K5 / K6 are non-regression properties it already had). */
const K_MUST_FAIL_OLD = ['K1', 'K2', 'K3', 'K4', 'K4u', 'K7'];

for (const [name, gate] of K_GATES) {
    test(name, async (t) => {
        const r = await gate(IN_TREE);
        t.diagnostic('in-tree ' + JSON.stringify(r, (k, v) => (v instanceof Uint32Array ? undefined : v)));
        assert.ok(r.ok, name + ' ' + JSON.stringify(r, (k, v) => (v instanceof Uint32Array ? undefined : v)));
    });
}

test('K8 duck typing: weightOf is honoured (0 / negative / NaN / Infinity / non-number are not candidates); none left -> last error', async () => {
    const W = [1, 0, 5, -2, NaN, Infinity, '3', 2];
    class Duck extends FixedPick { weightOf(i) { return W[i]; } }
    const pool = new Pool(new Duck(8, 0), new Uint32Array(8));
    const counts = new Array(8).fill(0);
    for (let r = 0; r < 7000; r++) {
        let att = 0;
        await pool.run((i) => { if (att++ === 0) throw new Error('x'); counts[i]++; }, { tries: 2 });
    }
    assert.deepEqual(counts.map((c, i) => (c > 0 ? i : -1)).filter((i) => i >= 0), [2, 7], 'only the finite positive weights');
    assert.ok(Math.abs(counts[2] / counts[7] - 2.5) < 0.25, 'weight-proportional 5:2 (got ' + counts[2] + ':' + counts[7] + ')');
    const e0 = new Error('only');
    const lone = new Pool(new (class extends FixedPick { weightOf(i) { return i === 0 ? 1 : 0; } })(4, 0), new Uint32Array(4));
    let n = 0;
    await assert.rejects(lone.run(() => { n++; throw e0; }, { tries: 4 }), (e) => e === e0);
    assert.equal(n, 1, 'no positive-weight untried endpoint: exactly one dispatch');
});

/** K10: fractional duck weights [0.1, 0.2, 0.7] behind a failing home 0 -- each share within +-10% relative. */
async function fractionalShares(M, runs = 10000) {
    const W = [1, 0.1, 0.2, 0.7];
    class Frac extends FixedPick { weightOf(i) { return W[i]; } }
    const inflight = new Uint32Array(4), pool = new M.Pool(new Frac(4, 0), inflight);
    const counts = [0, 0, 0, 0];
    for (let r = 0; r < runs; r++) {
        let att = 0;
        await pool.run((i) => { if (att++ === 0) throw new Error('x'); counts[i]++; }, { tries: 2 });
    }
    const shares = counts.map((c) => c / runs);
    let ok = counts[0] === 0 && inflight.every((v) => v === 0);
    for (let i = 1; i < 4; i++) if (Math.abs(shares[i] - W[i]) > W[i] * 0.10) ok = false;
    return { ok, shares };
}

/** The in-tree Pool.js with one anchor replaced, paired with the in-tree Pick.js. */
async function poolMutant(from, to) {
    return loadPair(readFileSync(PICK_PATH, 'utf8'), patchOnce(readFileSync(POOL_PATH, 'utf8'), from, to));
}

test('K10 fractional duck weights [0.1, 0.2, 0.7]: weight-proportional (a floored target is not)', async (t) => {
    const r = await fractionalShares(IN_TREE);
    t.diagnostic('in-tree ' + JSON.stringify(r));
    assert.ok(r.ok, 'shares within +-10% relative of 0.1 / 0.2 / 0.7: ' + JSON.stringify(r));
    const m = await fractionalShares(await poolMutant('    const t = ((h >>> 0) / 4294967296) * W;',
        '    const t = Math.floor(((h >>> 0) / 4294967296) * W);'));
    t.diagnostic('floor mutant ' + JSON.stringify(m));
    assert.ok(!m.ok, 'the floor(target) mutant must FAIL (it sends every fractional run to the first candidate)');
});

/** K11: weights near Number.MAX_VALUE overflow the sum to Infinity -> no fallback; the run stops after attempt 0. */
async function overflowStops(M) {
    class Huge extends FixedPick { weightOf() { return Number.MAX_VALUE; } }
    const inflight = new Uint32Array(4), pool = new M.Pool(new Huge(4, 0), inflight), e0 = new Error('attempt0');
    let n = 0, got;
    try { await pool.run(() => { n++; throw e0; }, { tries: 3 }); } catch (e) { got = e; }
    return { ok: n === 1 && got === e0 && inflight.every((v) => v === 0), dispatches: n, sameError: got === e0 };
}

test('K11 a weight sum that overflows to Infinity stops failover (attempt 0\'s error, inflight 0)', async (t) => {
    const r = await overflowStops(IN_TREE);
    assert.ok(r.ok, JSON.stringify(r));
    const m = await overflowStops(await poolMutant('    if (!(W > 0 && W < Infinity)) return PICK_NONE;', '    if (!(W > 0)) return PICK_NONE;'));
    t.diagnostic('nofinite mutant ' + JSON.stringify(m));
    assert.ok(!m.ok, 'the mutant that accepts a non-finite sum must FAIL (it dispatches attempt 1)');
});

test('K12 a throwing weightOf rejects the run with ITS error (not attempt 0\'s); inflight drains to 0', async () => {
    const ew = new Error('weightOf broke'), e0 = new Error('attempt0');
    class Broken extends FixedPick { weightOf() { throw ew; } }
    const inflight = new Uint32Array(4), pool = new Pool(new Broken(4, 0), inflight);
    let n = 0;
    await assert.rejects(pool.run(() => { n++; throw e0; }, { tries: 3 }), (e) => e === ew);
    assert.equal(n, 1, 'attempt 0 dispatched once; the fallback threw before any second dispatch');
    for (let i = 0; i < 4; i++) assert.equal(inflight[i], 0, 'inflight net-zero');
});

test('K9 revert check: the 1bc5eec Pick.js + Pool.js pair FAILS the K10 / weight-0 gates', async (t) => {
    let pickSrc, poolSrc;
    try {   // ONLY git history may skip; a loadPair/import failure below is a real failure
        const show = (f) => execFileSync('git', ['show', '1bc5eec:' + f], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        pickSrc = show('Pick.js');
        poolSrc = show('Pool.js');
    } catch {
        t.skip('git history unavailable (shallow clone / tarball)');
        return;
    }
    const old = await loadPair(pickSrc, poolSrc);
    for (const [name, gate] of K_GATES) {
        const id = name.split(' ')[0];
        const r = await gate(old);
        t.diagnostic('1bc5eec ' + id + ' ' + JSON.stringify(r, (k, v) => (v instanceof Uint32Array ? undefined : v)));
        if (K_MUST_FAIL_OLD.includes(id)) assert.ok(!r.ok, id + ' must FAIL on 1bc5eec ' + JSON.stringify(r));
        else assert.ok(r.ok, id + ' is a non-regression gate and holds on 1bc5eec too');
    }
});

// K3 (1.2.0): Pool over `ties:'random'` kernels. Distinctness is Pool's, determinism is the kernel's seeded draw.
// A background load [0,0,2,2] makes the kernel RETURN held endpoints: after attempts 0 and 1 take nodes 0 and 1
// (held, kept elevated to 1), the least-load pick keeps returning 0 / 1 (load 1 < 2), so attempts 2 and 3 can
// only be distinct via Pool's re-pick loop + _chooseUntried. A coverage assert (pick calls > 4 per run) proves
// that path ran. The held-ignoring Pool mutant (fallback `if (i === PICK_NONE) {`) fails 40/40 runs here.
// Pins: (1) tries 4, every attempt throws -> 4 DISTINCT endpoints per run (cap 4, so the last is forced);
// (2) same seed -> identical trace across two fresh Pool+balancer pairs; (3) a different seed -> a different
// trace; (4) inflight (net of the background) drains to 0. Expected values come from the contract.
test('K3 Pool over ties:random LeastConn / SED / NQ: distinct failover, seed-deterministic, inflight drains', async () => {
    const cap = 4, RUNS = 40, BG = [0, 0, 2, 2];
    const make = (kind, seed) => {
        const el = up(cap), inf = new Uint32Array(cap), wt = new Uint32Array(cap).fill(1);
        const o = { ties: 'random', seed };
        const b = kind === 'LC' ? new LeastConnBalancer(cap, el, inf, o)
            : kind === 'SED' ? new PICK.SedBalancer(cap, el, inf, wt, o)
            : new PICK.NqBalancer(cap, el, inf, wt, o);
        const st = { pickCalls: 0 };
        const orig = b.pick;
        b.pick = function () { st.pickCalls++; return orig.call(this); };
        return { pool: new Pool(b, inf), inf, st };
    };
    const trace = async (kind, seed) => {
        const { pool, inf, st } = make(kind, seed);
        const out = [];
        for (let r = 0; r < RUNS; r++) {
            const seen = [];
            for (let i = 0; i < cap; i++) inf[i] += BG[i];
            await assert.rejects(pool.run((i) => { seen.push(i); throw new Error('fail'); }, { tries: 4 }));
            for (let i = 0; i < cap; i++) inf[i] -= BG[i];
            assert.equal(seen.length, 4, kind + ' run ' + r + ': all 4 attempts dispatched');
            assert.equal(new Set(seen).size, 4, kind + ' run ' + r + ': 4 distinct endpoints, saw ' + seen.join(','));
            out.push(seen.join(''));
        }
        for (let i = 0; i < cap; i++) assert.equal(inf[i], 0, 'inflight drained');
        assert.ok(st.pickCalls > 4 * RUNS, kind + ': Pool re-picked (pick calls ' + st.pickCalls + ' > ' + 4 * RUNS + ')');
        return out.join('|');
    };
    for (const kind of ['LC', 'SED', 'NQ']) {
        const a = await trace(kind, 12345), b = await trace(kind, 12345), c = await trace(kind, 54321);
        assert.equal(a, b, kind + ': same seed -> same dispatch trace');
        assert.notEqual(a, c, kind + ': different seed -> different dispatch trace');
    }
});
