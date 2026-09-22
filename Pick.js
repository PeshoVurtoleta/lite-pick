/**
 * @zakkster/lite-pick -- zero-GC load-balancing SELECTION KERNEL.
 *
 * M0 (0.0.x): scaffold + substrate seams, NO strategy yet. This file ships the
 * shared machinery every strategy (M1+) will reuse, and nothing else:
 *
 *   - VERSION        the single source-of-truth version stamp (3-place sync).
 *   - PICK_NONE      the fail-closed sentinel (-1): "no endpoint", never a dead pick.
 *   - Prng           an instance-local, deterministic xorshift32 (seeded, reset()).
 *   - BalancerBase   the eligibility seam: a fixed-capacity pool over a SHARED,
 *                    read-only Uint8Array eligibility view (1 = pickable, 0 = down)
 *                    written by @zakkster/lite-di-health / circuit breakers and only
 *                    READ here, plus an O(1) live count and a cold-path setEligible().
 *                    It does NOT implement pick() -- strategies subclass it.
 *
 * The identity (decisions/0001): lite-pick OWNS NO mutable state it can avoid owning.
 * It reads pre-allocated views (eligibility, inflight, weights, scores) that siblings or
 * the caller write, and returns an integer index. Health, circuit state, and load
 * counters live OUTSIDE the kernel. The steady-state pick path allocates 0 B/op.
 *
 * Roster (planned, one strategy per session -- see ROADMAP.md):
 *   RoundRobin, SmoothWRR, P2C, LeastConn/SED/NQ, PeakEWMA, ConsistentHash,
 *   BoundedLoad, WeightedRandom.
 *
 * Zero runtime dependencies. node:test only. ESM, single file, tree-shakeable.
 */

/** Version stamp. Synced across package.json and llms.txt (three-place rule). */
export const VERSION = '0.0.1';

/**
 * Fail-closed sentinel returned by pick() when no endpoint is eligible.
 * null is not zero: a strategy never picks a down node "to be safe".
 */
export const PICK_NONE = -1;

/**
 * Prng -- instance-local, deterministic xorshift32.
 *
 * One PRNG step is a few integer ops and allocates nothing, so a strategy can draw
 * on the hot path without touching Math.random (which is neither seedable nor
 * gate-friendly) and the balance benchmark (the anchor) stays reproducible.
 *
 * Marsaglia's xorshift32: full period 2^32 - 1, never yields 0 once seeded non-zero.
 */
export class Prng {
    /**
     * @param {number} [seed=0x9e3779b9] 32-bit seed (0 is remapped to the default,
     *   since xorshift stuck at 0 stays 0).
     */
    constructor(seed = 0x9e3779b9) {
        const s = seed >>> 0;
        this._seed = s === 0 ? 0x9e3779b9 : s;
        this._s = this._seed;
    }

    /** One xorshift32 step -> a uint32 in [1, 2^32). Zero-alloc, deterministic. */
    next() {
        let x = this._s;
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        this._s = x >>> 0;
        return this._s;
    }

    /** A uint32 in [0, n) via multiply-shift (no modulo bias for the balance gate). */
    nextBelow(n) {
        // (rand * n) >>> 32 -- unbiased enough for selection, one Math.imul-free mul.
        return Math.floor((this.next() / 4294967296) * n);
    }

    /** Restore the original seed, so a benchmark run is byte-for-byte repeatable. */
    reset() {
        this._s = this._seed;
    }
}

/**
 * BalancerBase -- the shared eligibility seam for every strategy.
 *
 * It owns ONLY: the fixed capacity, a reference to the caller/sibling-owned eligibility
 * Uint8Array (never copied), and an O(1) `_live` count maintained on the cold setEligible()
 * path so a strategy can fail closed in O(1). It never allocates after construction and
 * never calls into a health source -- writers mutate `eligible` at their own cadence; pick()
 * only reads it.
 *
 * Subclasses (M1+) implement pick(). BalancerBase.pick() throws, so an unfinished strategy
 * fails loudly rather than silently returning a dead index.
 */
export class BalancerBase {
    /**
     * @param {number} capacity  endpoint count (fixed; add/remove is a cold rebuild).
     * @param {Uint8Array} eligible  1 = pickable, 0 = down. SHARED, read-only to pick().
     *   Written by @zakkster/lite-di-health probes / circuit breakers / admin.
     */
    constructor(capacity, eligible) {
        if (!Number.isInteger(capacity) || capacity < 1) {
            throw new RangeError('[lite-pick] capacity must be an integer >= 1');
        }
        if (!(eligible instanceof Uint8Array) || eligible.length < capacity) {
            throw new RangeError('[lite-pick] eligible must be a Uint8Array of length >= capacity');
        }
        this._cap = capacity;
        this._eligible = eligible;
        this._live = 0;
        for (let i = 0; i < capacity; i++) if (eligible[i]) this._live++;
    }

    /** Endpoint count (fixed at construction). */
    get capacity() {
        return this._cap;
    }

    /** Number of currently eligible endpoints (O(1), cold-path maintained). */
    get live() {
        return this._live;
    }

    /** True iff endpoint i is currently pickable. O(1), zero-alloc. */
    isEligible(i) {
        return i >= 0 && i < this._cap && this._eligible[i] !== 0;
    }

    /**
     * Cold path: mark endpoint i up/down (delegated FROM lite-di-health), keeping the
     * shared view and the O(1) `_live` count in lockstep. Idempotent. Zero-alloc.
     * @param {number} i
     * @param {boolean} up
     */
    setEligible(i, up) {
        if (i < 0 || i >= this._cap) {
            throw new RangeError('[lite-pick] index out of range: ' + i);
        }
        const was = this._eligible[i];
        const now = up ? 1 : 0;
        if (was !== now) {
            this._eligible[i] = now;
            this._live += now ? 1 : -1;
        }
    }

    /**
     * Choose an endpoint index, or PICK_NONE when the whole pool is down (fail closed).
     * Not implemented in the base -- M1+ strategies override this.
     * @returns {number}
     */
    pick() {
        throw new Error('[lite-pick] BalancerBase.pick() is abstract -- use a strategy (M1+)');
    }
}
