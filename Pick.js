/**
 * @zakkster/lite-pick -- zero-GC load-balancing SELECTION KERNEL.
 *
 * M3 (0.3.0): substrate seams + RoundRobin + SmoothWRR + P2C (the headline). This file ships:
 *
 *   - VERSION        the single source-of-truth version stamp (3-place sync).
 *   - PICK_NONE      the fail-closed sentinel (-1): "no endpoint", never a dead pick.
 *   - Prng           an instance-local, deterministic xorshift32 (seeded, reset()).
 *   - BalancerBase   the eligibility seam: a fixed-capacity pool over a SHARED,
 *                    read-only Uint8Array eligibility view (1 = pickable, 0 = down)
 *                    written by @zakkster/lite-di-health / circuit breakers and only
 *                    READ here, plus an O(1) live count and a cold-path setEligible().
 *                    It does NOT implement pick() -- strategies subclass it.
 *   - RoundRobinBalancer  the baseline strategy: a wrapping cursor that forward-scans
 *                    the eligibility view, skipping down nodes, O(1) amortized, 0 B/op.
 *   - SmoothWRRBalancer   the weighted default: nginx smooth weighted round-robin over
 *                    caller-configured integer weights, O(cap)/pick, 0 B/op.
 *   - P2cBalancer    the headline: power-of-two-choices over caller-owned in-flight counts;
 *                    the ln ln n balance ceiling, O(1)/pick, 0 B/op.
 *
 * The identity (decisions/0001): lite-pick OWNS NO mutable state it can avoid owning.
 * It reads pre-allocated views (eligibility, inflight, weights, scores) that siblings or
 * the caller write, and returns an integer index. Health, circuit state, and load
 * counters live OUTSIDE the kernel. The steady-state pick path allocates 0 B/op.
 *
 * Roster (one strategy per session -- see ROADMAP.md): RoundRobin [M1], SmoothWRR [M2],
 *   P2C [M3], LeastConn/SED/NQ, PeakEWMA, ConsistentHash, BoundedLoad, WeightedRandom [planned].
 *
 * Zero runtime dependencies. node:test only. ESM, single file, tree-shakeable.
 */

/** Version stamp. Synced across package.json and llms.txt (three-place rule). */
export const VERSION = '0.3.0';

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

/**
 * RoundRobinBalancer -- the baseline strategy (M1).
 *
 * A single wrapping cursor over the shared eligibility view. `pick()` advances the
 * cursor and forward-scans, skipping down nodes (`eligible[i] === 0`), until it lands
 * on the next pickable endpoint. Over a run of picks this hands each eligible endpoint
 * an equal share, in index order -- true round-robin over the LIVE set, not the raw
 * index space (the distinction from a naive `i++ % n`, which would return down nodes).
 *
 * Ownership (ADR 0001): it owns ONLY the integer cursor. Eligibility is the shared,
 * read-only Uint8Array from BalancerBase; `pick()` reads it and returns an index. No
 * SparseSet of eligibles is maintained -- ADR 0003 chose the stateless bitmap-scan path
 * (Option A) for M1; the lite-o1 RandomSet/SparseSet substrate (Option B, an optional
 * PEER dep) arrives at M3 when P2C needs a random eligible draw.
 *
 * Bound: O(1) amortized (one step when the next index is eligible), worst case O(cap)
 * when eligibility is sparse (bounded by a single wrap -- `_live > 0` guarantees a hit
 * within `cap` steps). Steady-state pick(): a compare-wrap loop over the view, one
 * cursor write. No object, closure, string, or array is created -- proven 0 B/op by
 * test/torture.mjs and test/perf/PerfGate.test.mjs.
 */
export class RoundRobinBalancer extends BalancerBase {
    /**
     * @param {number} capacity  endpoint count (fixed; add/remove is a cold rebuild).
     * @param {Uint8Array} eligible  shared view: 1 = pickable, 0 = down (length >= capacity).
     */
    constructor(capacity, eligible) {
        super(capacity, eligible);
        // Last index returned. -1 so the first pick starts the scan at index 0.
        this._cursor = -1;
    }

    /**
     * Next eligible endpoint index in round-robin order, or PICK_NONE when the whole
     * pool is down (fail closed). O(1) amortized, O(cap) worst case, zero-alloc.
     * @returns {number}
     */
    pick() {
        if (this._live === 0) return PICK_NONE;   // whole pool down: fail closed
        const cap = this._cap, el = this._eligible;
        let i = this._cursor;
        for (let steps = 0; steps < cap; steps++) {
            i++;
            if (i >= cap) i = 0;                   // wrap (cap is caller-given, not power-of-2)
            if (el[i]) { this._cursor = i; return i; }
        }
        // Unreachable while `_live` is exact (setEligible maintains it): a positive live
        // count guarantees a set bit within one wrap. Fail closed rather than loop.
        return PICK_NONE;
    }
}

/**
 * SmoothWRRBalancer -- nginx-style smooth weighted round-robin (M2).
 *
 * Distributes picks by caller-configured integer weights, spreading them SMOOTHLY over
 * time rather than in bursts: weights [5, 1, 1] yield A, A, B, A, C, A, A -- not the
 * A A A A A B C clumping of naive weight-expansion WRR. Each pick adds every eligible
 * node's weight to its accumulator, takes the node with the highest accumulator, and
 * subtracts the total eligible weight from it (the nginx `current += weight; pick max;
 * current -= total` algorithm).
 *
 * Ownership (ADR 0001, ADR 0004): this is the first strategy that owns ALGORITHM state --
 * the per-endpoint smoothing accumulators (`_current`, a Float64Array; Float64 absorbs the
 * sum of uint32 weights without overflow and is 0 B/op on the hot path). Weights live in
 * the caller's Uint32Array, but the balancer is the SOLE writer via the cold `setWeight()`,
 * which keeps `_totalEligibleWeight` exact; mutating the weights array directly desyncs the
 * total (documented UB). An eligibility toggle maintains the total AND resets the toggled
 * node's accumulator (ADR 0004: no stale credit across an eligibility epoch -- anti-flap
 * aligned, ADR 0002).
 *
 * Bound: O(cap) per pick (one scan of the pool -- SmoothWRR is inherently linear in the
 * pool size, negligible at real endpoint counts), zero-alloc. Fails closed (PICK_NONE)
 * when the eligible-weight sum is 0 -- whole pool down, or every eligible node's weight 0.
 */
export class SmoothWRRBalancer extends BalancerBase {
    /**
     * @param {number} capacity  endpoint count (fixed).
     * @param {Uint8Array} eligible  shared view: 1 = pickable, 0 = down (length >= capacity).
     * @param {Uint32Array} weights  per-endpoint weights (length >= capacity); the balancer
     *   is the sole writer via setWeight() -- direct mutation desyncs the total (UB).
     */
    constructor(capacity, eligible, weights) {
        super(capacity, eligible);
        if (!(weights instanceof Uint32Array) || weights.length < capacity) {
            throw new RangeError('[lite-pick] weights must be a Uint32Array of length >= capacity');
        }
        this._weights = weights;
        this._current = new Float64Array(capacity);
        let total = 0;
        for (let i = 0; i < capacity; i++) if (eligible[i]) total += weights[i];
        this._totalEligibleWeight = total;
    }

    /**
     * Cold path: mark endpoint i up/down, maintaining the eligible-weight total and
     * RESETTING the toggled node's accumulator (no stale credit across an eligibility
     * epoch, ADR 0004). Zero-alloc.
     * @param {number} i
     * @param {boolean} up
     */
    setEligible(i, up) {
        const was = this.isEligible(i);
        super.setEligible(i, up);           // validates range, flips the bit, updates _live
        const now = this._eligible[i] !== 0;
        if (was !== now) {
            this._totalEligibleWeight += now ? this._weights[i] : -this._weights[i];
            this._current[i] = 0;           // reset on every eligibility transition
        }
    }

    /**
     * Cold path: reconfigure endpoint i's weight, keeping the eligible-weight total exact.
     * @param {number} i
     * @param {number} w  new weight (uint32)
     */
    setWeight(i, w) {
        if (i < 0 || i >= this._cap) throw new RangeError('[lite-pick] index out of range: ' + i);
        const nw = w >>> 0;
        if (nw !== w) throw new RangeError('[lite-pick] weight must be a uint32: ' + w);
        const old = this._weights[i];
        if (nw === old) return;
        this._weights[i] = nw;
        if (this._eligible[i]) this._totalEligibleWeight += nw - old;
    }

    /**
     * Next endpoint by smooth weighting, or PICK_NONE (fail closed). O(cap), zero-alloc.
     * @returns {number}
     */
    pick() {
        const total = this._totalEligibleWeight;
        if (total <= 0) return PICK_NONE;   // whole pool down, or all eligible weights 0
        const cap = this._cap, el = this._eligible, wt = this._weights, cur = this._current;
        let best = -1, bestCur = -Infinity;
        for (let i = 0; i < cap; i++) {
            if (el[i]) {
                const c = cur[i] + wt[i];
                cur[i] = c;
                if (c > bestCur) { bestCur = c; best = i; }
            }
        }
        cur[best] -= total;                 // best >= 0 guaranteed while total > 0
        return best;
    }
}

/**
 * P2cBalancer -- power-of-two-choices (M3), the headline strategy.
 *
 * `pick()` draws TWO distinct eligible endpoints uniformly at random and returns the one
 * with the lower in-flight load. One extra probe over pure random buys an exponential drop
 * in peak load: the max load stays within `ln ln n / ln 2 + O(1)` of the mean (Azar-Broder-
 * Karlin-Upfal 1994), versus random's `ln n / ln ln n` gap. That additive `ln ln n` ceiling
 * -- proven in test/balance.mjs against a random foil -- is the library's analytical anchor.
 *
 * Ownership (ADR 0001, ADR 0005): in-flight counts live in the CALLER's Uint32Array, read-
 * only to `pick()` (the caller / the M5 lite-query adapter increments on dispatch, decrements
 * on settle -- lite-pick holds no request state). The eligible draw is REJECTION SAMPLING
 * over the shared bitmap: no peer, no owned draw-set, expected O(1) draws when eligibility is
 * dense (the common case), a bounded retry + a zero-alloc rotated linear-scan fallback for the
 * degenerate sparse case. A true worst-case-O(1) draw via lite-o1 `RandomSet` is a deferred
 * optional-peer optimization (ADR 0005), added only if sparse-eligibility measurement demands.
 *
 * Bound: O(d) = O(1) with d = 2 (two expected-O(1) draws + one compare). Steady-state pick():
 * a few PRNG steps + array reads, no object/closure/array created -- proven 0 B/op by
 * test/torture.mjs and test/perf/PerfGate.test.mjs. Fails closed (PICK_NONE) when the whole
 * pool is down.
 */
export class P2cBalancer extends BalancerBase {
    /**
     * @param {number} capacity  endpoint count (fixed).
     * @param {Uint8Array} eligible  shared view: 1 = pickable, 0 = down (length >= capacity).
     * @param {Uint32Array} inflight  per-endpoint in-flight counts (length >= capacity),
     *   caller-owned and only READ here.
     * @param {number} [seed=0x9e3779b9]  deterministic PRNG seed (reproducible benches).
     */
    constructor(capacity, eligible, inflight, seed = 0x9e3779b9) {
        super(capacity, eligible);
        if (!(inflight instanceof Uint32Array) || inflight.length < capacity) {
            throw new RangeError('[lite-pick] inflight must be a Uint32Array of length >= capacity');
        }
        this._inflight = inflight;
        this._rng = new Prng(seed);
    }

    /**
     * A uniformly random ELIGIBLE index, or PICK_NONE if none. Expected O(1) (rejection
     * sampling); a rotated linear scan from a random start is the zero-alloc fallback under
     * degenerate sparsity (unbiased first-eligible-after-a-random-offset). Internal.
     * @returns {number}
     */
    _draw() {
        if (this._live === 0) return PICK_NONE;
        const cap = this._cap, el = this._eligible;
        for (let tries = 0; tries < 64; tries++) {
            const i = this._rng.nextBelow(cap);
            if (el[i]) return i;
        }
        // Degenerate (very sparse eligibility): scan from a random start, wrapping, and
        // return the first eligible found. Zero-alloc; live > 0 guarantees a hit.
        let i = this._rng.nextBelow(cap);
        for (let k = 0; k < cap; k++) {
            if (el[i]) return i;
            i++;
            if (i >= cap) i = 0;
        }
        return PICK_NONE;
    }

    /**
     * Pick an endpoint by power-of-two-choices, or PICK_NONE (fail closed). O(1).
     * @returns {number}
     */
    pick() {
        const a = this._draw();
        if (a < 0) return PICK_NONE;          // whole pool down: fail closed
        if (this._live === 1) return a;       // only one eligible: it is both choices
        // Draw a DISTINCT second choice. A bounded redraw (not a single nudge) keeps the
        // two-choices property intact even at tiny pool sizes, where a single retry collides
        // often: at live>=2 each redraw misses with probability <= 1/2, so 32 tries leaves a
        // ~2^-32 collision chance -- while staying expected-O(1) (about two draws) and 0 B/op.
        let b = this._draw();
        for (let t = 0; b === a && t < 32; t++) b = this._draw();
        if (b < 0 || b === a) return a;       // astronomically rare: fall back to the first draw
        // Lower in-flight wins; ties go to the first draw (unbiased over many picks).
        return this._inflight[b] < this._inflight[a] ? b : a;
    }
}
