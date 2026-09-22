/**
 * @zakkster/lite-pick -- TypeScript declarations.
 *
 * M2 (0.2.0): substrate seams + RoundRobin + SmoothWRR (weighted). The remaining
 * strategy classes (P2C, LeastConn/SED/NQ, PeakEWMA, ConsistentHash, BoundedLoad,
 * WeightedRandom) are added one per session.
 */

/** The single source-of-truth version stamp. */
export const VERSION: string;

/**
 * Fail-closed sentinel returned by `pick()` when no endpoint is eligible.
 * A strategy never returns a down index; `PICK_NONE` (-1) means "no endpoint".
 */
export const PICK_NONE: -1;

/**
 * Instance-local, deterministic xorshift32 PRNG. Zero-alloc per step; seedable and
 * `reset()`-able so the balance benchmark stays reproducible.
 */
export class Prng {
    /** @param seed 32-bit seed; 0 is remapped to the default. */
    constructor(seed?: number);
    /** One xorshift32 step -> a uint32 in [1, 2^32). */
    next(): number;
    /** A uint32 in [0, n). */
    nextBelow(n: number): number;
    /** Restore the original seed. */
    reset(): void;
}

/**
 * The shared eligibility seam for every strategy. Owns the fixed capacity, a reference
 * to a shared read-only eligibility `Uint8Array` (written by @zakkster/lite-di-health /
 * circuit breakers, read by `pick()`), and an O(1) live count. Subclasses implement
 * `pick()`; the base `pick()` throws.
 */
export class BalancerBase {
    /**
     * @param capacity endpoint count (fixed).
     * @param eligible shared view: 1 = pickable, 0 = down (length >= capacity).
     */
    constructor(capacity: number, eligible: Uint8Array);
    /** Endpoint count (fixed at construction). */
    readonly capacity: number;
    /** Number of currently eligible endpoints (O(1)). */
    readonly live: number;
    /** True iff endpoint `i` is currently pickable. */
    isEligible(i: number): boolean;
    /** Cold path: mark endpoint `i` up/down, keeping the live count exact. */
    setEligible(i: number, up: boolean): void;
    /** Choose an endpoint index, or `PICK_NONE`. Abstract in the base (throws). */
    pick(): number;
}

/**
 * RoundRobinBalancer -- the baseline strategy (M1). A wrapping cursor that forward-scans
 * the shared eligibility view, skipping down nodes, to hand each LIVE endpoint an equal
 * share in index order. Owns only its cursor; O(1) amortized, 0 B/op on `pick()`.
 */
export class RoundRobinBalancer extends BalancerBase {
    /**
     * @param capacity endpoint count (fixed).
     * @param eligible shared view: 1 = pickable, 0 = down (length >= capacity).
     */
    constructor(capacity: number, eligible: Uint8Array);
    /** Next eligible index in round-robin order, or `PICK_NONE` when the pool is down. */
    pick(): number;
}

/**
 * SmoothWRRBalancer -- nginx-style smooth weighted round-robin (M2). Distributes picks by
 * caller-configured integer weights, interleaved smoothly (weights [5,1,1] -> A,A,B,A,C,A,A).
 * Owns its smoothing accumulators; the sole writer of the weights via `setWeight`. O(cap)
 * per pick, 0 B/op. Fails closed (`PICK_NONE`) when the eligible-weight sum is 0.
 */
export class SmoothWRRBalancer extends BalancerBase {
    /**
     * @param capacity endpoint count (fixed).
     * @param eligible shared view: 1 = pickable, 0 = down (length >= capacity).
     * @param weights per-endpoint weights (length >= capacity); mutate only via setWeight.
     */
    constructor(capacity: number, eligible: Uint8Array, weights: Uint32Array);
    /** Cold path: reconfigure endpoint `i`'s weight, keeping the eligible-weight total exact. */
    setWeight(i: number, w: number): void;
    /** Next endpoint by smooth weighting, or `PICK_NONE` when the eligible-weight sum is 0. */
    pick(): number;
}
