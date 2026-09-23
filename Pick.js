/**
 * @zakkster/lite-pick -- zero-GC load-balancing SELECTION KERNEL.
 *
 * M7 (0.7.0): substrate seams + seven strategies -- RoundRobin, SmoothWRR, P2C, the exact
 * LeastConn family (LeastConn, SED, NQ), and PeakEWMA (latency-aware P2C). This file ships:
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
 *   - P2cBalancer    power-of-two-choices over caller-owned in-flight counts; the ln ln n
 *                    balance ceiling, O(1)/pick, 0 B/op. This IS the O(1) least-connections
 *                    APPROXIMATION ("P2C-least-conn") -- the LeastConn family below is exact.
 *   - LeastConnBalancer   EXACT fewest-in-flight (IPVS `lc`): a full O(cap) scan of the
 *                    caller-owned in-flight view, 0 B/op. The deterministic complement to
 *                    P2C's O(1) approximation.
 *   - SedBalancer    shortest-expected-delay (IPVS `sed`): minimizes (inflight+1)/weight --
 *                    charges the NEW request's marginal cost. O(cap)/pick, 0 B/op.
 *   - NqBalancer     never-queue (IPVS `nq`): an IDLE eligible endpoint immediately if one
 *                    exists, else SED. The worker-pool fit. O(cap)/pick, 0 B/op.
 *   - PeakEwmaBalancer  latency-aware P2C (Twitter Finagle's peak-EWMA): draws two distinct
 *                    eligible endpoints and takes the lower cost = (inflight+1) x decayed EWMA(rtt).
 *                    Decay-on-READ (pick() never writes -> 0 B/op); the balancer OWNS the Float64
 *                    _ewma/_stamp state and is its SOLE writer via the warm recordRtt() feedback
 *                    path (also 0 B/op). Caller-supplied nanosecond clock. O(d)=O(1)/pick.
 *
 * The identity (decisions/0001): lite-pick OWNS NO mutable state it can avoid owning.
 * It reads pre-allocated views (eligibility, inflight, weights, scores) that siblings or
 * the caller write, and returns an integer index. Health, circuit state, and load
 * counters live OUTSIDE the kernel. The steady-state pick path allocates 0 B/op.
 *
 * Roster (one strategy per session -- see ROADMAP.md): RoundRobin [M1], SmoothWRR [M2],
 *   P2C [M3], LeastConn/SED/NQ [M4], PeakEWMA [M7], ConsistentHash, BoundedLoad, WeightedRandom
 *   [planned]. The EXACT-O(log n) fewest-in-flight variant is a deferred @zakkster/lite-logn
 *   BinaryHeap optional-peer seam (decisions/0006), not this exact-O(cap) scan.
 *
 * M5 (0.5.0) adds the ergonomic request layer at the @zakkster/lite-pick/pool subpath (a
 * SEPARATE file, Pool.js -- the async dispatch/settle counter wrapper + distinct-endpoint
 * failover + a duck-typed query-cache fetcher). This kernel file stays PURE and 0 B/op; the
 * async Pool lives outside it (decisions/0007, the lite-query /stream + /await subpath precedent).
 *
 * Zero runtime dependencies. node:test only. ESM, single file, tree-shakeable.
 */

/** Version stamp. Synced across package.json and llms.txt (three-place rule). */
export const VERSION = '0.7.2';

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

/**
 * LeastConnBalancer -- EXACT fewest-in-flight (M4), IPVS `lc` made zero-GC.
 *
 * `pick()` scans the whole pool and returns the eligible endpoint with the lowest in-flight
 * count -- the deterministic, exact complement to P2cBalancer's O(1) two-choice APPROXIMATION
 * of the same objective. Where P2C trades a tiny balance gap for O(1), LeastConn pays O(cap)
 * for the exact minimum: in a closed feedback loop (the caller increments inflight on dispatch
 * and decrements on settle) it is the greedy-optimal assignment -- max-minus-min load stays
 * within 1 (test/balance.mjs proves the perfect balance, tighter than P2C's ln ln n gap).
 *
 * Ownership (ADR 0001, ADR 0006): in-flight counts live in the CALLER's Uint32Array, read-only
 * to `pick()`. LeastConn owns NO derived state beyond the base `_live` -- it reads inflight
 * live each scan, so (unlike SmoothWRR's weights) the caller may mutate the inflight view
 * directly between picks; that is the whole point of the shared-counter seam.
 *
 * Bound: O(cap) per pick (one scan). Steady-state pick(): integer compares + one index write,
 * no object/closure/array created -- 0 B/op. Tie-break is the lowest index (deterministic);
 * the feedback loop breaks a startup all-zero tie by raising the picked node's count. Fails
 * closed (PICK_NONE) when the whole pool is down.
 *
 * NOTE: without a feedback loop (inflight never changes) LeastConn returns the same lowest-load
 * index every call -- correct by contract (it IS the least-loaded), but the caller must feed
 * load back for it to distribute. The M5 lite-query adapter provides that increment/decrement.
 */
export class LeastConnBalancer extends BalancerBase {
    /**
     * @param {number} capacity  endpoint count (fixed).
     * @param {Uint8Array} eligible  shared view: 1 = pickable, 0 = down (length >= capacity).
     * @param {Uint32Array} inflight  per-endpoint in-flight counts (length >= capacity),
     *   caller-owned and only READ here.
     */
    constructor(capacity, eligible, inflight) {
        super(capacity, eligible);
        if (!(inflight instanceof Uint32Array) || inflight.length < capacity) {
            throw new RangeError('[lite-pick] inflight must be a Uint32Array of length >= capacity');
        }
        this._inflight = inflight;
    }

    /**
     * The eligible endpoint with the fewest in-flight requests, or PICK_NONE (fail closed).
     * O(cap), zero-alloc. Lowest index on a tie.
     * @returns {number}
     */
    pick() {
        if (this._live === 0) return PICK_NONE;   // whole pool down: fail closed
        const cap = this._cap, el = this._eligible, inf = this._inflight;
        let best = -1, bestLoad = 0;
        for (let i = 0; i < cap; i++) {
            if (el[i]) {
                const c = inf[i];
                if (best < 0 || c < bestLoad) { best = i; bestLoad = c; }
            }
        }
        return best;                              // best >= 0 guaranteed while _live > 0
    }
}

/**
 * SedBalancer -- shortest-expected-delay (M4), IPVS `sed` made zero-GC.
 *
 * `pick()` returns the eligible endpoint that minimizes `(inflight + 1) / weight` -- the
 * expected delay if the NEW request were placed there (the +1 charges the request itself).
 * Higher-weight endpoints absorb proportionally more load; SED converges to inflight/weight
 * equal across the pool (test/balance.mjs proves the weighted fairness). It is the weighted
 * generalization of least-connections: with all weights equal, SED and LeastConn agree.
 *
 * Ownership (ADR 0001, ADR 0006): BOTH inflight AND weights are caller-owned Uint32Arrays,
 * read-only to `pick()`. SED (like LeastConn, unlike SmoothWRR) owns NO derived weight
 * aggregate -- it reads weights live each scan, so there is no `setWeight` and no total to
 * desync: the caller may retune weights directly between picks. An eligible endpoint whose
 * weight is 0 is NOT a candidate (its expected delay is infinite); if every eligible endpoint
 * has weight 0, `pick()` fails closed.
 *
 * Bound: O(cap) per pick (one scan, one Float64 division per eligible node), 0 B/op. Lowest
 * index on a tie. Fails closed (PICK_NONE) when no eligible endpoint has a positive weight.
 */
export class SedBalancer extends BalancerBase {
    /**
     * @param {number} capacity  endpoint count (fixed).
     * @param {Uint8Array} eligible  shared view: 1 = pickable, 0 = down (length >= capacity).
     * @param {Uint32Array} inflight  per-endpoint in-flight counts (length >= capacity), caller-owned.
     * @param {Uint32Array} weights  per-endpoint weights (length >= capacity), caller-owned; read live.
     */
    constructor(capacity, eligible, inflight, weights) {
        super(capacity, eligible);
        if (!(inflight instanceof Uint32Array) || inflight.length < capacity) {
            throw new RangeError('[lite-pick] inflight must be a Uint32Array of length >= capacity');
        }
        if (!(weights instanceof Uint32Array) || weights.length < capacity) {
            throw new RangeError('[lite-pick] weights must be a Uint32Array of length >= capacity');
        }
        this._inflight = inflight;
        this._weights = weights;
    }

    /**
     * The eligible endpoint minimizing (inflight + 1) / weight, or PICK_NONE (fail closed).
     * O(cap), zero-alloc. Lowest index on a tie; weight-0 nodes are not candidates.
     * @returns {number}
     */
    pick() {
        if (this._live === 0) return PICK_NONE;   // whole pool down: fail closed
        const cap = this._cap, el = this._eligible, inf = this._inflight, wt = this._weights;
        let best = -1, bestScore = Infinity;
        for (let i = 0; i < cap; i++) {
            if (el[i]) {
                const w = wt[i];
                if (w > 0) {
                    const score = (inf[i] + 1) / w;
                    if (score < bestScore) { bestScore = score; best = i; }
                }
            }
        }
        return best;                              // -1 when every eligible node has weight 0
    }
}

/**
 * NqBalancer -- never-queue (M4), IPVS `nq` made zero-GC.
 *
 * `pick()` returns an IDLE eligible endpoint (in-flight 0, positive weight) the instant one
 * exists -- never leaving a free server idle while queueing elsewhere -- and otherwise falls
 * back to SED (`(inflight + 1) / weight`). This is the best fit for the in-process worker-pool
 * case: spin up idle capacity first, only weigh expected delay once everyone is busy.
 *
 * Ownership (ADR 0001, ADR 0006): identical to SED -- caller-owned inflight + weights, read
 * live, no derived aggregate. The first idle eligible node (lowest index, in-flight 0, weight
 * > 0) short-circuits the scan.
 *
 * Bound: O(cap) worst case (no idle node -> a full SED scan); O(1) when a low-index endpoint is
 * idle. 0 B/op. Fails closed (PICK_NONE) when no eligible endpoint has a positive weight.
 */
export class NqBalancer extends BalancerBase {
    /**
     * @param {number} capacity  endpoint count (fixed).
     * @param {Uint8Array} eligible  shared view: 1 = pickable, 0 = down (length >= capacity).
     * @param {Uint32Array} inflight  per-endpoint in-flight counts (length >= capacity), caller-owned.
     * @param {Uint32Array} weights  per-endpoint weights (length >= capacity), caller-owned; read live.
     */
    constructor(capacity, eligible, inflight, weights) {
        super(capacity, eligible);
        if (!(inflight instanceof Uint32Array) || inflight.length < capacity) {
            throw new RangeError('[lite-pick] inflight must be a Uint32Array of length >= capacity');
        }
        if (!(weights instanceof Uint32Array) || weights.length < capacity) {
            throw new RangeError('[lite-pick] weights must be a Uint32Array of length >= capacity');
        }
        this._inflight = inflight;
        this._weights = weights;
    }

    /**
     * The first idle eligible endpoint (in-flight 0, weight > 0), else the SED minimum, else
     * PICK_NONE (fail closed). O(cap) worst case, O(1) when an early node is idle. Zero-alloc.
     * @returns {number}
     */
    pick() {
        if (this._live === 0) return PICK_NONE;   // whole pool down: fail closed
        const cap = this._cap, el = this._eligible, inf = this._inflight, wt = this._weights;
        let best = -1, bestScore = Infinity;
        for (let i = 0; i < cap; i++) {
            if (el[i]) {
                const w = wt[i];
                if (w > 0) {
                    if (inf[i] === 0) return i;   // idle: never queue -- take it immediately
                    const score = (inf[i] + 1) / w;
                    if (score < bestScore) { bestScore = score; best = i; }
                }
            }
        }
        return best;                              // -1 when every eligible node has weight 0
    }
}

/**
 * PeakEwmaBalancer -- latency-aware power-of-two-choices (M7), Twitter Finagle's peak-EWMA.
 *
 * `pick(now)` draws TWO distinct eligible endpoints (the same rejection-sampling machinery as
 * P2cBalancer -- reused verbatim, not re-implemented) and returns the one with the lower COST,
 * where cost(i) = (inflight[i] + 1) x ewmaAt(i, now). It is P2C over a LATENCY signal instead of
 * raw in-flight count: a slow endpoint (high EWMA rtt) is avoided even when its queue is short,
 * so the pool steers around a degraded-but-up node -- the strategy the multi-region FE case wants.
 * O(d) = O(1) per pick.
 *
 * Ownership (ADR 0001, ADR 0009): `inflight` is the CALLER's Uint32Array, read LIVE (the P2C /
 * LeastConn seam). The EWMA state -- `_ewma` (the decayed rtt estimate) and `_stamp` (the ns
 * timestamp of each node's last update), both Float64Array -- is BALANCER-OWNED (the SmoothWRR
 * precedent: a strategy may own algorithm state), and the balancer is its SOLE writer, via the
 * warm `recordRtt()` feedback path. `pick()` NEVER writes: it decays ON READ, so the hot path
 * stays a pure read -> 0 B/op.
 *
 * Decay-on-read: ewmaAt(i, now) = _ewma[i] x exp(-(now - _stamp[i]) / tau). No write, no clock
 * call on the gated path -- `now` (and the rtt sample) are CALLER-supplied nanoseconds, consistent
 * between `pick(now)` and `recordRtt(i, sampleNs, now)`, so the whole strategy is deterministic
 * and testable and allocates nothing.
 *
 * Cold start: `_ewma` seeds to 1.0 and `_stamp` to a NEGATIVE "unsampled" sentinel (-1). While a
 * node is unsampled `ewmaAt` returns the baseline 1.0 UNDECAYED, so before any sample cost(i) =
 * (inflight[i] + 1) x 1 and PeakEWMA degrades GRACEFULLY to plain least-connections (P2C-over-
 * inflight) REGARDLESS of the caller's clock magnitude -- a plain `_stamp = 0` would decay as
 * exp(-now/tau) -> 0 under a real large clock and collapse a cold pool to random. The first
 * `recordRtt` initializes the EWMA EXACTLY to the sample (clock-independent); the peak rule applies
 * only from the second sample on. It is never NaN.
 *
 * Contract: `now` (in `pick(now)` / `recordRtt`) and `sampleNs` MUST be FINITE numbers. `recordRtt`
 * throws on a non-finite argument (the warm path); `pick(now)` never throws (the fail-closed
 * contract), so a non-finite `now` yields P2C-random selection rather than an error.
 *
 * Anti-flap (ADR 0002, ADR 0009): the EWMA half-life IS the smoothing -- a single slow sample
 * snaps the cost up instantly and it decays back over ~tau, so there is NO extra dwell/hysteresis.
 *
 * Deferred (ADR 0009 / llms.txt): a p99-aware variant scoring inflight x p99Rtt via a per-node
 * @zakkster/lite-sketch `DDSketch` (optional peer, 0 B/op `add`). EWMA-mean is the shipped,
 * zero-peer default; `peerDependencies` stays empty until a shipped path imports the sketch.
 *
 * Bound: O(d) = O(1) per pick (two expected-O(1) rejection draws + two exp() + a compare),
 * 0 B/op on BOTH `pick()` and `recordRtt()` (torture + PerfGate). Fails closed (PICK_NONE) when
 * the whole pool is down.
 */
export class PeakEwmaBalancer extends BalancerBase {
    /**
     * @param {number} capacity  endpoint count (fixed).
     * @param {Uint8Array} eligible  shared view: 1 = pickable, 0 = down (length >= capacity).
     * @param {Uint32Array} inflight  per-endpoint in-flight counts (length >= capacity),
     *   caller-owned and only READ here.
     * @param {number} tauNs  the EWMA time-constant / half-life in nanoseconds (> 0, finite):
     *   larger tau = slower decay = longer memory of a latency spike.
     * @param {number} [seed=0x9e3779b9]  deterministic PRNG seed (reproducible benches).
     */
    constructor(capacity, eligible, inflight, tauNs, seed = 0x9e3779b9) {
        super(capacity, eligible);
        // Validate typeof-first, BEFORE allocating the owned Float64 state (fail closed early).
        if (!(inflight instanceof Uint32Array) || inflight.length < capacity) {
            throw new RangeError('[lite-pick] inflight must be a Uint32Array of length >= capacity');
        }
        if (typeof tauNs !== 'number') {
            throw new TypeError('[lite-pick] tauNs must be a number');
        }
        if (!Number.isFinite(tauNs) || tauNs <= 0) {
            throw new RangeError('[lite-pick] tauNs must be a finite number > 0');
        }
        this._inflight = inflight;
        this._tau = tauNs;
        this._rng = new Prng(seed);
        this._ewma = new Float64Array(capacity);
        this._stamp = new Float64Array(capacity);
        // Cold start: _ewma seeds to 1.0 and _stamp to a NEGATIVE "unsampled" sentinel (-1). The
        // sentinel makes ewmaAt read the baseline UNDECAYED (graceful LeastConn) regardless of the
        // caller's clock magnitude -- a plain _stamp=0 would decay as exp(-now/tau) -> 0 under a
        // real large-magnitude clock and collapse a cold pool to random selection.
        for (let i = 0; i < capacity; i++) { this._ewma[i] = 1.0; this._stamp[i] = -1; }
    }

    /**
     * A uniformly random ELIGIBLE index, or PICK_NONE if none. Reuses P2cBalancer's exact
     * rejection-sampling draw (ADR 0005) verbatim -- same `_rng` / `_eligible` / `_live` fields,
     * no re-implementation, no owned draw-set. Internal, zero-alloc.
     * @returns {number}
     */
    _draw() {
        return P2cBalancer.prototype._draw.call(this);
    }

    /**
     * The decayed EWMA rtt estimate for endpoint i at time `now` (ns). Pure READ -- exponential
     * decay applied on read, never written. An UNSAMPLED node (`_stamp < 0`) reads its baseline
     * 1.0 UNDECAYED (graceful LeastConn), so a cold pool never underflows to 0 under a real
     * large-magnitude clock. `now` must be finite. Zero-alloc.
     * @param {number} i
     * @param {number} now  caller-supplied nanoseconds
     * @returns {number}
     */
    ewmaAt(i, now) {
        const s = this._stamp[i];
        if (s < 0) return this._ewma[i]; // unsampled: undecayed baseline, clock-magnitude-independent
        return this._ewma[i] * Math.exp(-(now - s) / this._tau);
    }

    /**
     * Record an rtt SAMPLE for endpoint i at time `now` (the warm feedback path -- NOT the hot
     * pick path). The FIRST sample (an unsampled node, `_stamp < 0`) initializes the EWMA EXACTLY
     * to the sample, clock-magnitude-independent. Thereafter the Finagle peak rule applies: decay
     * the stored estimate to `now`, then SNAP UP to the sample if it is larger (a spike is felt
     * instantly) else ease toward it (it decays back over ~tau). The balancer is the SOLE writer of
     * `_ewma` / `_stamp`. Zero-alloc on the success path.
     * @param {number} i  endpoint index
     * @param {number} sampleNs  observed rtt in nanoseconds (finite, >= 0)
     * @param {number} now  caller-supplied nanoseconds (finite), consistent with pick(now)
     */
    recordRtt(i, sampleNs, now) {
        if (typeof i !== 'number' || typeof sampleNs !== 'number' || typeof now !== 'number') {
            throw new TypeError('[lite-pick] recordRtt(i, sampleNs, now) requires numbers');
        }
        if (i < 0 || i >= this._cap) throw new RangeError('[lite-pick] index out of range: ' + i);
        if (!Number.isFinite(sampleNs) || sampleNs < 0) {
            throw new RangeError('[lite-pick] sampleNs must be a finite number >= 0');
        }
        if (!Number.isFinite(now)) throw new RangeError('[lite-pick] now must be a finite number');
        if (this._stamp[i] < 0) {
            this._ewma[i] = sampleNs;   // first sample: exact init, no decay (clock-independent)
        } else {
            const w = Math.exp(-(now - this._stamp[i]) / this._tau);
            const e = this._ewma[i] * w;
            this._ewma[i] = sampleNs > e ? sampleNs : e + (sampleNs - e) * (1 - w);
        }
        this._stamp[i] = now;
    }

    /**
     * Pick by latency-aware power-of-two-choices: two distinct eligible draws, lower cost =
     * (inflight+1) x ewmaAt(now) wins; a tie goes to the first draw. PICK_NONE (fail closed) iff
     * the whole pool is down. O(d)=O(1), 0 B/op (pure read -- no write, no clock call).
     * @param {number} now  caller-supplied nanoseconds (consistent with recordRtt)
     * @returns {number}
     */
    pick(now) {
        const a = this._draw();
        if (a < 0) return PICK_NONE;          // whole pool down: fail closed
        if (this._live === 1) return a;       // only one eligible: it is both choices
        // A DISTINCT second draw, bounded (the ADR 0005 rationale): at live>=2 each redraw misses
        // with probability <= 1/2, so 32 tries leaves a ~2^-32 collision chance, expected-O(1), 0 B/op.
        let b = this._draw();
        for (let t = 0; b === a && t < 32; t++) b = this._draw();
        if (b < 0 || b === a) return a;       // astronomically rare: fall back to the first draw
        const inf = this._inflight, ewma = this._ewma, stamp = this._stamp, tau = this._tau;
        // Decay-on-read with the unsampled sentinel: `_stamp < 0` reads the undecayed baseline
        // (graceful LeastConn), else exponential decay. A cheap per-candidate compare, no alloc.
        const sa = stamp[a], sb = stamp[b];
        const costA = (inf[a] + 1) * (sa < 0 ? ewma[a] : ewma[a] * Math.exp(-(now - sa) / tau));
        const costB = (inf[b] + 1) * (sb < 0 ? ewma[b] : ewma[b] * Math.exp(-(now - sb) / tau));
        return costB < costA ? b : a;         // lower cost wins; tie -> the first draw
    }
}
