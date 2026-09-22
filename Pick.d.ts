/**
 * @zakkster/lite-pick -- TypeScript declarations.
 *
 * M0 (0.0.x): the substrate seams only. Strategy classes (RoundRobin, SmoothWRR, P2C,
 * LeastConn/SED/NQ, PeakEWMA, ConsistentHash, BoundedLoad, WeightedRandom) are added
 * one per session (M1+).
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
