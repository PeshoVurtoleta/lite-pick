/**
 * @zakkster/lite-pick/pool -- TypeScript declarations (M5).
 *
 * The async request layer over the 0 B/op kernel: dispatch/settle in-flight counter
 * ergonomics + distinct-endpoint failover, plus a duck-typed query-cache fetcher adapter.
 */

/** The source-of-truth version stamp (re-exported from the core). */
export const VERSION: string;

/**
 * The minimal abort-signal shape Pool reads (L15). A structural type -- NOT the global DOM
 * `AbortSignal` -- so a consumer compiling with `lib: ["ES2022"]` only (no DOM, no @types/node)
 * still type-checks. A real `AbortSignal` (DOM or node:) satisfies it.
 */
export interface AbortLike {
    readonly aborted: boolean;
    readonly reason?: unknown;
    throwIfAborted?(): void;
}

/**
 * The minimal balancer shape Pool drives. A KEYED strategy (ConsistentHash / BoundedLoad) exposes a
 * static `KEYED === true` and takes `pick(keyHash)`; a LATENCY strategy (PeakEWMA) exposes a static
 * `LATENCY === true` and takes `pick(now)`; a plain strategy takes `pick()`. All lite-pick strategies
 * satisfy this (their required-arg `pick` is bivariant-compatible with the zero-arg method here).
 */
export interface Balancer {
    /** `now` (latency clock) or `keyHash` (keyed) when the strategy requires it, else no argument. */
    pick(arg?: number): number;
    readonly capacity: number;
    readonly live: number;
    /** True iff endpoint `i` is currently pickable (used by distinct failover's untried scan). */
    isEligible?(i: number): boolean;
    /** Optional latency-feedback sink (PeakEwmaBalancer); fed on settle when a clock is in use. */
    recordRtt?(i: number, sampleNs: number, now: number): void;
    /** Optional occupancy sink (BoundedLoadBalancer); fed +1 on dispatch, -1 on settle. */
    note?(i: number, delta: number): void;
}

/** Options for `Pool.run`. */
export interface RunOptions {
    /** Passed to `fn`; when already aborted, stops dispatch/failover (the abort propagates). */
    signal?: AbortLike;
    /** Max distinct-endpoint attempts (default 1 = no failover). */
    tries?: number;
    /**
     * A caller-owned nanosecond clock. REQUIRED for a latency-aware balancer (PeakEWMA): `run`
     * validates each reading is finite, drives `pick(now)`, and feeds `recordRtt` on settle (and a
     * failure penalty on a throw). For a non-latency balancer it is optional and only feeds
     * `recordRtt` if the balancer duck-types it; otherwise inert. Omitting it for a latency balancer
     * is a runtime error.
     */
    clock?: () => number;
    /**
     * An integer routing key. REQUIRED for a keyed balancer (ConsistentHash / BoundedLoad): `run`
     * drives `pick(key)` (sticky / bounded-load routing). Omitting it for a keyed balancer is a
     * runtime error. It is NOT passed to a latency balancer as `now`, and is ignored by non-keyed,
     * non-latency strategies. The `note` occupancy hook is driven whenever the balancer duck-types
     * `note`, independently of `key`.
     */
    key?: number;
    /**
     * The minimum rtt penalty (nanoseconds) a thrown attempt feeds a latency-aware balancer via
     * `recordRtt(i, max(elapsed, failurePenaltyNs), done)`, so a fast-failing endpoint stops being the
     * cheapest pick. Finite, > 0. Default 1e9 (1 s). RECOVERY: the penalized estimate decays back to
     * competitive after roughly `tauNs * ln(failurePenaltyNs / healthyRttNs)`, so the node is
     * periodically RE-PROBED at that cadence (recovery works) while its steady-state share stays low.
     */
    failurePenaltyNs?: number;
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
     * Run `fn` against a chosen endpoint (in-flight incremented on dispatch, decremented on settle),
     * with up to `opts.tries` genuinely DISTINCT-endpoint failover attempts on a throw (failover
     * targets are spread across keys for a keyed run and cursor-rotated for an unkeyed run). A keyed
     * balancer requires `opts.key` and a latency balancer requires `opts.clock` (a `LITE_PICK_KEY_REQUIRED`
     * / `LITE_PICK_CLOCK_REQUIRED`-coded error otherwise).
     *
     * Rejections: `LITE_PICK_NONE` when no endpoint is eligible; the last error when every attempt
     * fails; an already-aborted `signal` dispatches NOTHING and rejects (the signal's `reason`, or a
     * `LITE_PICK_ABORTED`-coded error). Feedback is loud and never re-runs `fn`: if SETTLE-time feedback
     * after a SUCCESS fails (clock throws / non-finite, or `recordRtt` throws), `run` rejects with a
     * `LITE_PICK_FEEDBACK`-coded error carrying `.cause` (the feedback error) and `.result` (fn's
     * resolved value). If PENALTY feedback after a FAILURE fails, `run` throws fn's error object
     * unchanged (identity preserved) with the feedback error attached as a non-enumerable
     * `liteFeedbackError`. A backwards-stepping but finite clock reading records NO rtt sample and
     * resolves normally (a failed attempt still records the full penalty). `opts` may be omitted or `null`.
     */
    run<T>(fn: (endpoint: number, signal?: AbortLike) => Promise<T> | T, opts?: RunOptions | null): Promise<T>;
}

/** Context passed to the per-endpoint fetcher. */
export interface PerEndpointContext {
    endpoint: number;
    key: any;
    signal?: AbortLike;
}

/** Context a query cache passes to the produced fetcher (lite-query's fetcher shape). */
export interface FetcherContext {
    key: any;
    signal?: AbortLike;
}

/** Options for `liteQueryFetcher`. */
export interface FetcherOptions {
    /** Spatial failover attempts across the pool (default 1). */
    tries?: number;
    /** A nanosecond clock forwarded to a latency-aware balancer (PeakEWMA); otherwise inert. */
    clock?: () => number;
    /** Minimum rtt penalty a thrown attempt feeds a latency-aware balancer; forwarded to `pool.run`. */
    failurePenaltyNs?: number;
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
