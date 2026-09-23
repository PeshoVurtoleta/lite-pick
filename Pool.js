/**
 * @zakkster/lite-pick/pool -- the ergonomic request wrapper (M5).
 *
 *     import { Pool, liteQueryFetcher } from '@zakkster/lite-pick/pool';
 *
 * The kernel (Pick.js) is a PURE, 0 B/op selector: pick() -> index. Real callers also need
 * the counter ergonomics ADR 0001 always promised -- increment in-flight on DISPATCH,
 * decrement on SETTLE, and on a failure re-pick a DIFFERENT endpoint. That layer is async
 * (it wraps the request lifecycle), so it lives OUTSIDE the single-file 0 B/op kernel, in
 * this separate subpath file (the lite-query precedent: /stream, /await are subpath entries).
 *
 * BOUNDARY (decisions/0007): Pool owns SPATIAL failover -- try up to `tries` DISTINCT endpoints,
 * once each, on a thrown error. It does NOT own TEMPORAL retry (backoff, staleness) -- that
 * belongs to the caller / a query cache (lite-query's `retry`). The two never double-own: Pool
 * moves ACROSS the pool once; the caller retries the whole operation over TIME.
 *
 * ZERO-GC boundary: the kernel `pick()` is 0 B/op; `Pool.run` is a NORMAL async wrapper -- the
 * request it wraps already allocates a promise -- adding only O(1) integer counter ops per
 * attempt plus one small per-run bookkeeping array. It is NOT held to the kernel's 0 B/op bar.
 *
 * Duck-typed, zero HARD deps, zero peers: `liteQueryFetcher` returns a value shaped like
 * lite-query's `fetcher` (`({ key, signal }) => Promise`) WITHOUT importing lite-query, so
 * `peerDependencies` stays empty and the same helper serves any fetcher-shaped consumer.
 */

import { VERSION, PICK_NONE } from './Pick.js';

/** Re-exported so a /pool-only importer can read the version without importing the core. */
export { VERSION };

/**
 * Pool -- wraps a balancer + the caller-owned in-flight view with the dispatch/settle counter
 * ergonomics and distinct-endpoint failover. The balancer is duck-typed (anything with
 * `pick() -> number`, `capacity`, and `live`), so a Pool can drive any lite-pick strategy or a
 * compatible custom one.
 */
export class Pool {
    /**
     * @param {{ pick(): number, capacity: number, live: number }} balancer  a lite-pick
     *   strategy (RoundRobin / SmoothWRR / P2C / LeastConn / SED / NQ) or a duck-compatible one.
     * @param {Uint32Array} inflight  the SAME caller-owned in-flight view the balancer reads
     *   (length >= balancer.capacity). Pool is the increment/decrement authority around run().
     */
    constructor(balancer, inflight) {
        if (!balancer || typeof balancer.pick !== 'function' ||
            typeof balancer.capacity !== 'number' || typeof balancer.live !== 'number') {
            throw new TypeError('[lite-pick] Pool needs a balancer with pick(), capacity, and live');
        }
        if (!(inflight instanceof Uint32Array) || inflight.length < balancer.capacity) {
            throw new RangeError('[lite-pick] inflight must be a Uint32Array of length >= balancer.capacity');
        }
        this._b = balancer;
        this._inflight = inflight;
    }

    /** The wrapped balancer. */
    get balancer() {
        return this._b;
    }

    /** The shared in-flight view Pool increments on dispatch and decrements on settle. */
    get inflight() {
        return this._inflight;
    }

    /**
     * Run `fn` against a chosen endpoint, incrementing its in-flight on dispatch and decrementing
     * on settle. On a thrown error, keep the failed endpoint's count ELEVATED and re-pick -- so a
     * load-aware strategy (P2C / LeastConn / SED / NQ) naturally steers the next attempt to a
     * DIFFERENT endpoint -- up to `tries` attempts, then throw the last error. All counts this run
     * raised are released before returning or throwing (net-zero per run).
     *
     * @template T
     * @param {(endpoint: number, signal?: AbortSignal) => (Promise<T>|T)} fn  the per-endpoint work.
     * @param {{ signal?: AbortSignal, tries?: number }} [opts]  `tries` (default 1 = no failover)
     *   is the max number of distinct-endpoint attempts; `signal` is passed to `fn` and, when
     *   already aborted after a failure, stops failover (the abort propagates, no re-pick).
     * @returns {Promise<T>}
     */
    async run(fn, opts) {
        if (typeof fn !== 'function') throw new TypeError('[lite-pick] Pool.run needs a function');
        const rawTries = opts && opts.tries != null ? (opts.tries | 0) : 1;
        const tries = rawTries > 0 ? rawTries : 1;
        const signal = opts ? opts.signal : undefined;
        const inflight = this._inflight, b = this._b;
        const held = [];                 // endpoints incremented this run (kept elevated across failover)
        let lastErr;
        try {
            for (let attempt = 0; attempt < tries; attempt++) {
                const i = b.pick();
                if (i === PICK_NONE) {
                    if (attempt === 0) {
                        const e = new Error('[lite-pick] no eligible endpoint');
                        e.code = 'LITE_PICK_NONE';
                        throw e;
                    }
                    break;               // pool went fully down mid-failover: surface the last error
                }
                inflight[i] = (inflight[i] + 1) >>> 0;
                held.push(i);
                try {
                    return await fn(i, signal);
                } catch (err) {
                    lastErr = err;
                    if (signal && signal.aborted) throw err;   // abort: stop failover, propagate
                }
                // keep inflight[i] elevated so the next pick() steers to a different endpoint
            }
            throw lastErr;
        } finally {
            for (let k = 0; k < held.length; k++) {
                const j = held[k];
                inflight[j] = inflight[j] > 0 ? inflight[j] - 1 : 0;
            }
        }
    }
}

/**
 * liteQueryFetcher -- adapt a Pool into a fetcher for a query cache (lite-query's `fetcher`, or
 * any `({ key, signal }) => Promise` consumer). Duck-typed: imports NOTHING from lite-query.
 *
 *     const fetcher = liteQueryFetcher(pool, ({ endpoint, key, signal }) =>
 *         fetch(urls[endpoint] + '/' + key[0], { signal }).then(r => r.json()), { tries: 2 });
 *     query(qc, { key: ['users'], fetcher });
 *
 * The query cache owns TEMPORAL retry/backoff/staleness; the Pool owns SPATIAL failover across
 * the pool (`tries`). Wiring both is deliberate layering, never double-ownership (ADR 0007).
 *
 * @template T
 * @param {Pool} pool
 * @param {(ctx: { endpoint: number, key: any, signal?: AbortSignal }) => (Promise<T>|T)} perEndpoint
 * @param {{ tries?: number }} [opts]  spatial failover attempts (default 1).
 * @returns {(ctx: { key: any, signal?: AbortSignal }) => Promise<T>}
 */
export function liteQueryFetcher(pool, perEndpoint, opts) {
    if (!(pool instanceof Pool)) throw new TypeError('[lite-pick] liteQueryFetcher needs a Pool');
    if (typeof perEndpoint !== 'function') {
        throw new TypeError('[lite-pick] liteQueryFetcher needs a per-endpoint function');
    }
    const tries = opts && opts.tries != null ? opts.tries : 1;
    return function fetcher(ctx) {
        const key = ctx ? ctx.key : undefined;
        const signal = ctx ? ctx.signal : undefined;
        return pool.run((endpoint, sig) => perEndpoint({ endpoint, key, signal: sig }), { signal, tries });
    };
}
