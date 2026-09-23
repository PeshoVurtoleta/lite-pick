/**
 * @zakkster/lite-pick/pool -- TypeScript declarations (M5).
 *
 * The async request layer over the 0 B/op kernel: dispatch/settle in-flight counter
 * ergonomics + distinct-endpoint failover, plus a duck-typed query-cache fetcher adapter.
 */

/** The source-of-truth version stamp (re-exported from the core). */
export const VERSION: string;

/** The minimal balancer shape Pool drives (any lite-pick strategy satisfies it). */
export interface Balancer {
    /** `now` (PeakEwma clock) or `keyHash` (ConsistentHash/BoundedLoad) when supplied via opts. */
    pick(arg?: number): number;
    readonly capacity: number;
    readonly live: number;
    /** Optional latency-feedback sink (PeakEwmaBalancer); fed on settle when a clock is supplied. */
    recordRtt?(i: number, sampleNs: number, now: number): void;
    /** Optional occupancy sink (BoundedLoadBalancer); fed +1 on dispatch, -1 on settle. */
    note?(i: number, delta: number): void;
}

/** Options for `Pool.run`. */
export interface RunOptions {
    /** Passed to `fn`; when already aborted after a failure, stops failover (abort propagates). */
    signal?: AbortSignal;
    /** Max distinct-endpoint attempts (default 1 = no failover). */
    tries?: number;
    /**
     * A caller-owned nanosecond clock. When present it drives `pick(now)` and the opt-in
     * `recordRtt` latency feedback for a latency-aware balancer (PeakEwma); otherwise inert.
     */
    clock?: () => number;
    /**
     * An integer routing key for a keyed balancer (ConsistentHash / BoundedLoad). When present,
     * `run` calls `pick(key)`; the opt-in `note` occupancy hook is driven on dispatch/settle for
     * a bounded-load balancer. Ignored by non-keyed strategies.
     */
    key?: number;
}

/**
 * Pool -- wraps a balancer + the caller-owned in-flight view with dispatch/settle counter
 * ergonomics and distinct-endpoint failover. `run` increments in-flight on dispatch, decrements
 * on settle, and on a thrown error keeps the failed endpoint elevated so a load-aware strategy
 * steers the next attempt elsewhere. NOT a 0 B/op path (the kernel `pick()` is).
 */
export class Pool {
    /**
     * @param balancer a lite-pick strategy (or duck-compatible) with `pick()`, `capacity`, `live`.
     * @param inflight the SAME caller-owned in-flight view the balancer reads (length >= capacity).
     */
    constructor(balancer: Balancer, inflight: Uint32Array);
    /** The wrapped balancer. */
    readonly balancer: Balancer;
    /** The shared in-flight view Pool increments on dispatch and decrements on settle. */
    readonly inflight: Uint32Array;
    /**
     * Run `fn` against a chosen endpoint (in-flight incremented on dispatch, decremented on
     * settle), with up to `opts.tries` distinct-endpoint failover attempts on a throw. Rejects
     * with a `LITE_PICK_NONE`-coded error when no endpoint is eligible, or the last error when
     * every attempt fails.
     */
    run<T>(fn: (endpoint: number, signal?: AbortSignal) => Promise<T> | T, opts?: RunOptions): Promise<T>;
}

/** Context passed to the per-endpoint fetcher. */
export interface PerEndpointContext {
    endpoint: number;
    key: any;
    signal?: AbortSignal;
}

/** Context a query cache passes to the produced fetcher (lite-query's fetcher shape). */
export interface FetcherContext {
    key: any;
    signal?: AbortSignal;
}

/** Options for `liteQueryFetcher`. */
export interface FetcherOptions {
    /** Spatial failover attempts across the pool (default 1). */
    tries?: number;
}

/**
 * Adapt a Pool into a `({ key, signal }) => Promise` fetcher for a query cache (lite-query, or
 * any fetcher-shaped consumer). Imports nothing from lite-query -- duck-typed, zero peers.
 */
export function liteQueryFetcher<T>(
    pool: Pool,
    perEndpoint: (ctx: PerEndpointContext) => Promise<T> | T,
    opts?: FetcherOptions,
): (ctx: FetcherContext) => Promise<T>;
