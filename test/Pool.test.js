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
import { RoundRobinBalancer, LeastConnBalancer, PeakEwmaBalancer } from '../Pick.js';
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

test('A12: inert when a recordRtt-capable balancer is run WITHOUT a clock', async () => {
    const n = 4;
    const inflight = new Uint32Array(n);
    const pe = new PeakEwmaBalancer(n, up(n), inflight, 1e9, 0xABCDEF);
    const pool = new Pool(pe, inflight);
    await pool.run((i) => 'ok:' + i);                 // no opts -> no clock -> hook inert
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
