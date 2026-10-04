/**
 * @zakkster/lite-pick -- zero-GC load-balancing SELECTION KERNEL.
 *
 * M10 (1.0.0): substrate seams + TEN strategies (the roster-complete release) -- RoundRobin,
 * SmoothWRR, P2C, the exact LeastConn family (LeastConn, SED, NQ), PeakEWMA (latency-aware P2C),
 * ConsistentHash (a Maglev lookup table), BoundedLoad (Consistent Hashing with Bounded Loads:
 * the Maglev table + an occupancy cap that overflows a hot backend), and WeightedRandom (O(1)
 * Vose alias-table sampling with rejection-sampling eligibility). This file ships:
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
 *                    eligible endpoints and takes the lower cost (three cases: idle-unsampled 0,
 *                    busy-unsampled priced at the sample mean, sampled (inflight+1) x decayed EWMA
 *                    floored by time-since-last-sample while busy -- see the class JSDoc).
 *                    Decay-on-READ (pick() never writes -> 0 B/op); the balancer OWNS the Float64
 *                    _ewma/_stamp state and is its SOLE writer via the warm recordRtt() feedback
 *                    path (also 0 B/op). Caller-supplied nanosecond clock. O(d)=O(1)/pick.
 *   - ConsistentHashBalancer  sticky/affinity routing via a prebuilt Maglev lookup table (IPVS
 *                    `mh`, Meta Katran, Cilium): pick(keyHash) is slot = keyHash % M, a table read,
 *                    and a bounded forward-probe over down slots -- O(1)/pick, 0 B/op. keyHash is a
 *                    caller-supplied INTEGER (no per-pick string hashing = the one zero-GC hazard);
 *                    the balancer OWNS the Uint32Array table + weights, rebuilt COLD on membership /
 *                    weight change (health flap is handled by the probe, never a rebuild).
 *   - BoundedLoadBalancer  Consistent Hashing with Bounded Loads (CHBL, Mirrokni et al. / Google
 *                    Research; Vimeo eps=0.25): ConsistentHash (the Maglev table) PLUS an occupancy
 *                    cap. pick(keyHash) sticks a key to its hashed home UNLESS that backend is over
 *                    cap = (1+eps) x _total / live, in which case the request OVERFLOWS along the same
 *                    bounded probe to the next eligible under-cap backend -- consistent hashing's
 *                    stickiness + minimal disruption PLUS the hotspot protection plain CH lacks. It
 *                    extends ConsistentHashBalancer (reusing its Maglev build + probe VERBATIM) and
 *                    OWNS a running `_total` (sole writer: the warm note(i, delta) seam). O(1), 0 B/op.
 *   - WeightedRandomBalancer  O(1) weighted-random selection via a Vose/Walker ALIAS TABLE (one
 *                    column draw + one probability compare -> a candidate), with rejection-sampling
 *                    eligibility (retry an ineligible candidate up to a bounded count, then a 0-B/op
 *                    rotated linear eligible scan). The alias table is built COLD over the eligible-
 *                    INDEPENDENT weights (a weight-0 node is NEVER a column), so rejection over the
 *                    bitmap renormalizes the weight distribution across the SURVIVING eligible mass.
 *                    The balancer OWNS its derived table (_prob/_alias) and is its SOLE writer via cold
 *                    setWeight/rebuild (the SmoothWRR precedent); an eligibility flap never rebuilds.
 *                    The stateless O(1) sample (no accumulators to desync) for VERY LARGE pools where
 *                    SmoothWRR's O(cap) scan hurts. O(1), 0 B/op. (Vose 1991 / Walker alias method.)
 *
 * The identity (decisions/0001): lite-pick OWNS NO mutable state it can avoid owning.
 * It reads pre-allocated views (eligibility, inflight, weights, scores) that siblings or
 * the caller write, and returns an integer index. Health, circuit state, and load
 * counters live OUTSIDE the kernel. The steady-state pick path allocates 0 B/op.
 *
 * Roster (one strategy per session -- see ROADMAP.md): RoundRobin [M1], SmoothWRR [M2],
 *   P2C [M3], LeastConn/SED/NQ [M4], PeakEWMA [M7], ConsistentHash [M8], BoundedLoad [M9],
 *   WeightedRandom [M10] -- roster complete for now (NOT closed: AZ-aware routing, hedging, and
 *   subsetting are queued post-1.0). The EXACT-O(log n) fewest-in-flight variant is a deferred
 *   @zakkster/lite-logn BinaryHeap optional-peer seam (decisions/0006), not this exact-O(cap) scan;
 *   a lite-logn Fenwick tree is the deferred DYNAMIC-weight complement to WeightedRandom's static
 *   alias table, and lite-o1 AliasTable a deferred duck-typed optional-peer upgrade for the build.
 *
 * M5 (0.5.0) adds the ergonomic request layer at the @zakkster/lite-pick/pool subpath (a
 * SEPARATE file, Pool.js -- the async dispatch/settle counter wrapper + distinct-endpoint
 * failover + a duck-typed query-cache fetcher). This kernel file stays PURE and 0 B/op; the
 * async Pool lives outside it (decisions/0007, the lite-query /stream + /await subpath precedent).
 *
 * Zero runtime dependencies. node:test only. ESM, single file, tree-shakeable.
 */

/** Version stamp. Synced across package.json and llms.txt (three-place rule). */
export const VERSION = '1.0.2';

/**
 * Fail-closed sentinel returned by pick() when no endpoint is eligible.
 * null is not zero: a strategy never picks a down node "to be safe".
 */
export const PICK_NONE = -1;

/**
 * Stats slab layout (1.1.0, D7). A balancer counts ONLY what its caller cannot see from outside, and only on
 * cold or already-taken slow branches: a counter on every pick cost RoundRobin 2.1 -> 5.7 ns (a read-modify-
 * write of one memory slot per pick), and the caller already sees every pick and every PICK_NONE. Attach a
 * caller-owned Float64Array with `attachStats(slab)` (length >= STAT_COUNT; several balancers may share one).
 * Counters only grow -- the library never resets them; read deltas. Float64 is exact to 2^53. New indices are
 * only ever APPENDED, so size slabs with STAT_COUNT, never a literal.
 */
/** A fallback scan ran: the P2C / PeakEWMA / WeightedRandom very-sparse fallback, or the ConsistentHash /
 *  BoundedLoad full-table sweep past the probe window. O(cap) or O(M) each -- a rising rate means a pool
 *  that is mostly down. */
export const STAT_FALLBACK_SCANS = 0;
/** A lookup or alias table was (re)built: ConsistentHash / BoundedLoad / WeightedRandom, the constructor's
 *  build included (it lands in the slab attached at that moment, i.e. the scratch slab). */
export const STAT_REBUILDS = 1;
/** ConsistentHash / BoundedLoad: a keyed pick that did NOT return its home slot's backend (home down, or --
 *  BoundedLoad -- over cap). The affinity-loss signal. */
export const STAT_DISPLACED = 2;
/** The number of stats indices in this version (a slab must be at least this long). */
export const STAT_COUNT = 3;

/** Every balancer without an attached slab writes here, unconditionally (no branch in the counting sites).
 *  Shared, never read. */
const _STATS_SCRATCH = new Float64Array(STAT_COUNT);

/** Node's custom-inspect hook, by its registry symbol: no import, and a plain unused key in browsers. */
const _INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * A coded error (1.1.0, D7): the usual TypeError / RangeError / Error, plus a stable `code` -- error
 * messages may change in any release, codes are semver API. Cold (only ever on a throw path).
 * @param {ErrorConstructor} Ctor
 * @param {string} code  a `LITE_PICK_*` code
 * @param {string} msg
 * @returns {Error}
 */
function _err(Ctor, code, msg) {
    const e = new Ctor(msg);
    e.code = code;
    return e;
}

/** Sum of a Uint32Array over [0, n), for the cold describe() / assertConsistent(). */
function _sum(a, n) {
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i];
    return s;
}

/**
 * COLD (L2, 1.1.0): the P2C / PeakEWMA very-sparse fallback after 64 rejected draws -- the k-th eligible
 * index, k uniform in [0, live). The 1.0.x fallback took the first eligible after a random start, which
 * favours a node that follows a long run of down nodes (nodes {0,1} of 100: 63.5% / 36.5%). A module
 * function (not a method) so P2C's `_draw` -- which PeakEWMA borrows with `.call` -- reaches it from either
 * class, and so it stays out of the hot `_draw` body. Counts STAT_FALLBACK_SCANS. Zero-alloc, O(cap).
 * @param {{ _cap: number, _eligible: Uint8Array, _live: number, _rng: Prng, _stats: Float64Array }} b
 * @returns {number}
 */
function _kthEligible(b) {
    b._stats[STAT_FALLBACK_SCANS] += 1;
    const cap = b._cap, el = b._eligible;
    let k = b._rng.nextBelow(b._live);
    for (let i = 0; i < cap; i++) {
        if (el[i]) { if (k === 0) return i; k--; }
    }
    return PICK_NONE;   // unreachable while _live matches the shared view (a direct write is UB, H2)
}

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

    /**
     * An integer in [0, n): floor(r / 2^32 x n) for a uniform uint32 r (L8, 1.1.0: this is a scaled floor,
     * not a multiply-shift). r / 2^32 is exact in a double, and so is the product while n < 2^21; the 2^32
     * values of r fall into n buckets whose sizes differ by at most one, a relative bias <= n / 2^32
     * (~6e-8 at n = 256) -- no modulo bias.
     */
    nextBelow(n) {
        return Math.floor((this.next() / 4294967296) * n);
    }

    /** Restore the original seed, so a benchmark run is byte-for-byte repeatable. */
    reset() {
        this._s = this._seed;
    }
}

/**
 * Validate an endpoint index for a COLD/WARM mutator (never the hot pick path): it must be an
 * in-range, non-negative INTEGER. `(i >>> 0) !== i` rejects NaN, fractions (1.5), negatives (-1),
 * and non-numbers (a string like '2' coerces to a different value under `>>> 0`); `i >= cap`
 * rejects out-of-range. Fails closed with the same RangeError style as the pre-existing range
 * checks -- invalid input is an error, never a silent typed-array no-op that desyncs `_live`.
 * @param {number} i
 * @param {number} cap
 */
function _vIdx(i, cap) {
    if ((i >>> 0) !== i || i >= cap) {
        throw _err(RangeError, 'LITE_PICK_INDEX', '[lite-pick] index out of range: ' + i);
    }
}

/**
 * BalancerBase -- the shared eligibility seam for every strategy.
 *
 * It owns ONLY: the fixed capacity, a reference to the caller/sibling-owned eligibility
 * Uint8Array (never copied), and an O(1) `_live` count maintained on the cold setEligible()
 * path so a strategy can fail closed in O(1). It never allocates after construction and
 * never calls into a health source. The eligibility view is flipped ONLY through setEligible()
 * (the sole supported writer, which keeps `_live` -- and SmoothWRR's eligible-weight total --
 * exact); a health source / breaker drives that call. A direct `eligible[i]` write bypasses the
 * cache and desyncs `_live` (fail-closed picks, wrong ratios) -- UB (1.0.1 contract). Each
 * balancer needs its OWN eligibility array (a shared `Eligibility` object is deferred to 2.0).
 * pick() only reads.
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
            throw _err(RangeError, 'LITE_PICK_CAPACITY', '[lite-pick] capacity must be an integer >= 1');
        }
        if (!(eligible instanceof Uint8Array) || eligible.length < capacity) {
            throw _err(RangeError, 'LITE_PICK_ARRAY', '[lite-pick] eligible must be a Uint8Array of length >= capacity');
        }
        this._cap = capacity;
        this._eligible = eligible;
        this._live = 0;
        this._stats = _STATS_SCRATCH;   // D7: counting sites write here until attachStats() (no branch)
        for (let i = 0; i < capacity; i++) if (eligible[i]) this._live++;
    }

    /**
     * Cold (1.1.0, D7): count this balancer's internal events into a caller-owned Float64Array (see
     * STAT_FALLBACK_SCANS / STAT_REBUILDS / STAT_DISPLACED). `null` detaches. Several balancers may share
     * one slab (their counts add up). The library never resets it.
     * @param {Float64Array|null} slab  length >= STAT_COUNT
     */
    attachStats(slab) {
        if (slab === null) { this._stats = _STATS_SCRATCH; return; }
        if (!(slab instanceof Float64Array) || slab.length < STAT_COUNT) {
            throw _err(RangeError, 'LITE_PICK_ARRAY',
                '[lite-pick] stats must be a Float64Array of length >= STAT_COUNT (' + STAT_COUNT + '), or null');
        }
        this._stats = slab;
    }

    /** The attached stats slab, or null. */
    get stats() {
        return this._stats === _STATS_SCRATCH ? null : this._stats;
    }

    /**
     * Cold (1.1.0, D7): a plain-object snapshot for logs and admin endpoints -- the strategy, capacity, live
     * count, the attached counters (null when none) and each strategy's own state. Allocates; never call it
     * per pick. Arrays are plain copies, so the snapshot is JSON-safe and does not track later changes.
     * @returns {object}
     */
    describe() {
        const s = this._stats;
        return {
            strategy: 'BalancerBase',
            capacity: this._cap,
            live: this._live,
            stats: s === _STATS_SCRATCH ? null
                : { fallbackScans: s[STAT_FALLBACK_SCANS], rebuilds: s[STAT_REBUILDS], displaced: s[STAT_DISPLACED] },
        };
    }

    /** `util.inspect` / `console.log` in Node print describe() under the class name. Browsers ignore it. */
    [_INSPECT](depth, options, inspect) {
        const name = this.constructor.name;
        if (depth < 0) return '[' + name + ']';
        const d = this.describe();
        if (typeof inspect !== 'function') return d;
        return name + ' ' + inspect(d, Object.assign({}, options, { depth: options.depth == null ? null : options.depth - 1 }));
    }

    /**
     * Cold, opt-in (1.1.0, audit H2): recount the cached state from the arrays it caches and THROW (code
     * LITE_PICK_INCONSISTENT) on any mismatch. The usual cause is a direct `eligible[i] = ...` write, which
     * bypasses setEligible() and desyncs `live` (PICK_NONE with a node up, wrong ratios). O(cap); for tests
     * and debug builds, not the request path. Strategies add their own caches (SmoothWRR's eligible-weight
     * total, WeightedRandom's weight sum, BoundedLoad's noted total).
     */
    assertConsistent() {
        const cap = this._cap, el = this._eligible;
        let live = 0;
        for (let i = 0; i < cap; i++) {
            const v = el[i];
            if (v > 1) {
                throw _err(Error, 'LITE_PICK_INCONSISTENT', '[lite-pick] eligible[' + i + '] is ' + v +
                    ': setEligible() writes only 0 and 1, so it was written directly');
            }
            live += v;
        }
        if (live !== this._live) {
            throw _err(Error, 'LITE_PICK_INCONSISTENT', '[lite-pick] live is ' + this._live + ' but eligible[] has ' +
                live + ' up: eligible[] was written directly -- flip it only through setEligible()');
        }
    }

    /** Endpoint count (fixed at construction). */
    get capacity() {
        return this._cap;
    }

    /** Number of currently eligible endpoints (O(1), cold-path maintained). */
    get live() {
        return this._live;
    }

    /** True iff endpoint i is currently pickable. O(1), zero-alloc. A non-integer (1.5, NaN)
     *  is never pickable -> false (isEligible NEVER throws; it is a pure predicate). */
    isEligible(i) {
        return (i >>> 0) === i && i < this._cap && this._eligible[i] !== 0;
    }

    /**
     * Cold path: mark endpoint i up/down (delegated FROM lite-di-health), keeping the
     * shared view and the O(1) `_live` count in lockstep. Idempotent. Zero-alloc.
     * @param {number} i
     * @param {boolean} up
     */
    setEligible(i, up) {
        _vIdx(i, this._cap);
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
        throw _err(Error, 'LITE_PICK_ABSTRACT', '[lite-pick] BalancerBase.pick() is abstract -- use a strategy (M1+)');
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

    /** Cold snapshot (1.1.0): the base fields plus the cursor (the last index returned, -1 before any). */
    describe() {
        const d = super.describe();
        d.strategy = 'RoundRobin';
        d.cursor = this._cursor;
        return d;
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
            throw _err(RangeError, 'LITE_PICK_ARRAY', '[lite-pick] weights must be a Uint32Array of length >= capacity');
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
        _vIdx(i, this._cap);
        const nw = w >>> 0;
        if (nw !== w) throw _err(RangeError, 'LITE_PICK_WEIGHT', '[lite-pick] weight must be a uint32: ' + w);
        const old = this._weights[i];
        if (nw === old) return;
        this._weights[i] = nw;
        this._current[i] = 0;               // reset credit: a reweighted node holds no stale accumulator
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
            if (el[i] && wt[i] > 0) {       // eligible AND positive weight: a weight-0 node is never a candidate
                const c = cur[i] + wt[i];
                cur[i] = c;
                if (c > bestCur) { bestCur = c; best = i; }
            }
        }
        // best >= 0 while total > 0 -- provided eligibility is written ONLY through setEligible (the
        // 1.0.1 contract that keeps _totalEligibleWeight in lockstep); a direct eligible[] write desyncs it.
        cur[best] -= total;
        return best;
    }

    /** Cold snapshot (1.1.0): the base fields plus the weights and the cached eligible-weight total. */
    describe() {
        const d = super.describe();
        d.strategy = 'SmoothWRR';
        d.weights = Array.from(this._weights.subarray(0, this._cap));
        d.eligibleWeight = this._totalEligibleWeight;
        return d;
    }

    /** Cold, opt-in (1.1.0): the base recount plus the eligible-weight total (a direct `weights[i]` write desyncs it). */
    assertConsistent() {
        super.assertConsistent();
        const cap = this._cap, el = this._eligible, wt = this._weights;
        let t = 0;
        for (let i = 0; i < cap; i++) if (el[i]) t += wt[i];
        if (t !== this._totalEligibleWeight) {
            throw _err(Error, 'LITE_PICK_INCONSISTENT', '[lite-pick] the eligible-weight total is ' + this._totalEligibleWeight +
                ' but the weights sum to ' + t + ': weights[] was written directly -- use setWeight()');
        }
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
            throw _err(RangeError, 'LITE_PICK_ARRAY', '[lite-pick] inflight must be a Uint32Array of length >= capacity');
        }
        this._inflight = inflight;
        this._rng = new Prng(seed);
    }

    /**
     * A uniformly random ELIGIBLE index, or PICK_NONE if none. Expected O(1) (rejection
     * sampling); under degenerate sparsity (64 misses) the zero-alloc fallback draws k in [0, live)
     * and walks to the k-th eligible index -- uniform by construction (L2, 1.1.0). Internal.
     * @returns {number}
     */
    _draw() {
        if (this._live === 0) return PICK_NONE;
        const cap = this._cap, el = this._eligible;
        for (let tries = 0; tries < 64; tries++) {
            const i = this._rng.nextBelow(cap);
            if (el[i]) return i;
        }
        return _kthEligible(this);   // degenerate sparsity: the cold fallback (L2), counted (D7)
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

    /** Cold snapshot (1.1.0): the base fields plus the total in flight. */
    describe() {
        const d = super.describe();
        d.strategy = 'P2C';
        d.inflight = _sum(this._inflight, this._cap);
        return d;
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
 * no object/closure/array created -- 0 B/op. Ties ROTATE (1.1.0, M5): a cursor moves past each pick, so
 * tied nodes take turns instead of the lowest index winning every tie (deterministic, no random draw;
 * callers still must not depend on WHICH tied node wins). Fails
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
            throw _err(RangeError, 'LITE_PICK_ARRAY', '[lite-pick] inflight must be a Uint32Array of length >= capacity');
        }
        this._inflight = inflight;
        this._cur = 0;   // rotating tie-break cursor (M5, 1.1.0): the next scan's preferred start
    }

    /**
     * The eligible endpoint with the fewest in-flight requests, or PICK_NONE (fail closed).
     * O(cap), zero-alloc. Ties ROTATE (1.1.0): the first least-loaded node at or after a cursor that moves
     * past each pick -- deterministic, no random draw.
     * @returns {number}
     */
    pick() {
        if (this._live === 0) return PICK_NONE;   // whole pool down: fail closed
        const cap = this._cap, el = this._eligible, inf = this._inflight;
        // Rotating tie-break (M5, 1.1.0): scan [cursor, cap) then [0, cursor) and keep the FIRST least-loaded
        // node in that order; the cursor moves past the pick. 1.0.x scanned from 0, so the lowest index won
        // every tie and at low load one node took everything (8 idle nodes, one request at a time: 100% to
        // node 0; now 12.5% each). NGINX/HAProxy/Envoy spread ties too; IPVS does not. Two loops, not a
        // wrapped index: the per-node work stays one compare (research/1.1.0-kernel-and-api.md section 3).
        const cur = this._cur < cap ? this._cur : 0;
        let best = -1, bestLoad = 0;
        for (let i = cur; i < cap; i++) {
            if (el[i]) {
                const c = inf[i];
                if (best < 0 || c < bestLoad) { best = i; bestLoad = c; }
            }
        }
        for (let i = 0; i < cur; i++) {
            if (el[i]) {
                const c = inf[i];
                if (best < 0 || c < bestLoad) { best = i; bestLoad = c; }
            }
        }
        this._cur = best + 1;                     // best >= 0 guaranteed while _live > 0
        return best;
    }

    /** Cold snapshot (1.1.0): the base fields plus the total in flight and the tie cursor. */
    describe() {
        const d = super.describe();
        d.strategy = 'LeastConn';
        d.inflight = _sum(this._inflight, this._cap);
        d.tieCursor = this._cur;
        return d;
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
 * Bound: O(cap) per pick (one scan, one Float64 division per eligible node), 0 B/op. Ties among
 * equal scores rotate (1.1.0, as LeastConn). Fails closed (PICK_NONE) when no eligible endpoint has a
 * positive weight.
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
            throw _err(RangeError, 'LITE_PICK_ARRAY', '[lite-pick] inflight must be a Uint32Array of length >= capacity');
        }
        if (!(weights instanceof Uint32Array) || weights.length < capacity) {
            throw _err(RangeError, 'LITE_PICK_ARRAY', '[lite-pick] weights must be a Uint32Array of length >= capacity');
        }
        this._inflight = inflight;
        this._weights = weights;
        this._cur = 0;   // rotating tie-break cursor (M5, 1.1.0): the next scan's preferred start
    }

    /**
     * The eligible endpoint minimizing (inflight + 1) / weight, or PICK_NONE (fail closed).
     * O(cap), zero-alloc. Ties rotate (1.1.0); weight-0 nodes are not candidates.
     * @returns {number}
     */
    pick() {
        if (this._live === 0) return PICK_NONE;   // whole pool down: fail closed
        const cap = this._cap, el = this._eligible, inf = this._inflight, wt = this._weights;
        // Rotating tie-break among EQUAL scores (M5, 1.1.0) -- as LeastConnBalancer.pick: [cursor, cap) then
        // [0, cursor), first minimum in that order. Equal rationals (inf + 1) / w divide to the same double.
        const cur = this._cur < cap ? this._cur : 0;
        let best = -1, bestScore = Infinity;
        for (let i = cur; i < cap; i++) {
            if (el[i]) {
                const w = wt[i];
                if (w > 0) {
                    const score = (inf[i] + 1) / w;
                    if (score < bestScore) { bestScore = score; best = i; }
                }
            }
        }
        for (let i = 0; i < cur; i++) {
            if (el[i]) {
                const w = wt[i];
                if (w > 0) {
                    const score = (inf[i] + 1) / w;
                    if (score < bestScore) { bestScore = score; best = i; }
                }
            }
        }
        if (best < 0) return PICK_NONE;           // every eligible node has weight 0
        this._cur = best + 1;
        return best;
    }

    /** Cold snapshot (1.1.0): the base fields plus the total in flight, the weights and the tie cursor. */
    describe() {
        const d = super.describe();
        d.strategy = 'SED';
        d.inflight = _sum(this._inflight, this._cap);
        d.weights = Array.from(this._weights.subarray(0, this._cap));
        d.tieCursor = this._cur;
        return d;
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
 * live, no derived aggregate. An idle eligible node (in-flight 0, weight > 0) wins outright; when
 * several are idle they take turns (1.1.0 rotating cursor -- 1.0.x returned the lowest idle index).
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
            throw _err(RangeError, 'LITE_PICK_ARRAY', '[lite-pick] inflight must be a Uint32Array of length >= capacity');
        }
        if (!(weights instanceof Uint32Array) || weights.length < capacity) {
            throw _err(RangeError, 'LITE_PICK_ARRAY', '[lite-pick] weights must be a Uint32Array of length >= capacity');
        }
        this._inflight = inflight;
        this._weights = weights;
        this._cur = 0;   // rotating tie-break cursor (M5, 1.1.0): the next scan's preferred start
    }

    /**
     * An idle eligible endpoint (in-flight 0, weight > 0; idle nodes take turns), else the SED minimum
     * (ties rotate), else PICK_NONE (fail closed). O(cap) worst case. Zero-alloc.
     * @returns {number}
     */
    pick() {
        if (this._live === 0) return PICK_NONE;   // whole pool down: fail closed
        const cap = this._cap, el = this._eligible, inf = this._inflight, wt = this._weights;
        // Rotating tie-break (M5, 1.1.0): scan [cursor, cap) then [0, cursor). The first IDLE node in that
        // order wins at once (never queue) -- O(distance) to it, so idle nodes take turns -- else the first
        // SED minimum in that order.
        const cur = this._cur < cap ? this._cur : 0;
        let best = -1, bestScore = Infinity;
        for (let i = cur; i < cap; i++) {
            if (el[i]) {
                const w = wt[i];
                if (w > 0) {
                    if (inf[i] === 0) { this._cur = i + 1; return i; }   // idle: never queue -- take it immediately
                    const score = (inf[i] + 1) / w;
                    if (score < bestScore) { bestScore = score; best = i; }
                }
            }
        }
        for (let i = 0; i < cur; i++) {
            if (el[i]) {
                const w = wt[i];
                if (w > 0) {
                    if (inf[i] === 0) { this._cur = i + 1; return i; }   // idle: never queue -- take it immediately
                    const score = (inf[i] + 1) / w;
                    if (score < bestScore) { bestScore = score; best = i; }
                }
            }
        }
        if (best < 0) return PICK_NONE;           // every eligible node has weight 0
        this._cur = best + 1;
        return best;
    }

    /** Cold snapshot (1.1.0): the base fields plus the total in flight, the weights and the tie cursor. */
    describe() {
        const d = super.describe();
        d.strategy = 'NQ';
        d.inflight = _sum(this._inflight, this._cap);
        d.weights = Array.from(this._weights.subarray(0, this._cap));
        d.tieCursor = this._cur;
        return d;
    }
}

/**
 * PeakEwmaBalancer -- latency-aware power-of-two-choices (M7), Twitter Finagle's peak-EWMA.
 *
 * `pick(now)` draws TWO distinct eligible endpoints (the same rejection-sampling machinery as
 * P2cBalancer -- reused verbatim, not re-implemented) and returns the one with the lower COST. It
 * is P2C over a LATENCY signal instead of raw in-flight count: a slow endpoint (high EWMA rtt) is
 * avoided even when its queue is short, so the pool steers around a degraded-but-up node -- the
 * strategy the multi-region FE case wants. O(d) = O(1) per pick.
 *
 * Cost, per candidate i (a pure READ -- scalar-only, no write, no clock call, 0 B/op):
 *   - unsampled (`_stamp < 0`) AND idle (`inflight === 0`) -> cost 0. This is NOT a one-shot probe the
 *     kernel can enforce: an idle unsampled node costs 0 EVERY time it is idle, so it holds exactly one
 *     request in flight at a time (the next pick sees inflight > 0) until its FIRST recordRtt. A node
 *     that never gets a sample -- e.g. one that fails fast so the caller records nothing -- stays at
 *     cost 0 whenever idle and keeps winning. Callers MUST record failures too (@zakkster/lite-pick/pool
 *     does this from 1.0.1) or a fast-failing endpoint is a black hole the kernel alone cannot see.
 *   - unsampled AND busy (`inflight > 0`) -> `(inflight + 1) x mean`, where `mean` is the pool's
 *     DECAYING mean sampled rtt (1.1.0; `_samp[0] / _samp[1]` = decayed sum / decayed count, every
 *     sample weighted by exp(-age/tau); 1.0 before ANY sample). A cold-but-busy node is priced at the
 *     pool mean, NOT the old 1.0 ns that made it a black hole (H1), and the mean follows a
 *     latency-regime change within a few tau (1.0.x's lifetime mean never forgot one).
 *   - sampled -> `(inflight + 1) x base`, `base = max(decayedEWMA, dt)` WHILE BUSY else `decayedEWMA`
 *     (`decayedEWMA = ewma x exp(-dt/tau)`, `dt = max(now - stamp, 0)`). The busy floor means a hung
 *     node -- inflight > 0 and no completion, so `dt` grows without bound -- gets MORE expensive over
 *     time instead of decaying toward 0 and becoming the most attractive pick (H1/L6).
 *
 * Ownership (ADR 0001, ADR 0009): `inflight` is the CALLER's Uint32Array, read LIVE (the P2C /
 * LeastConn seam). The EWMA state -- `_ewma` (the decayed rtt estimate) and `_stamp` (the ns
 * timestamp of each node's last update), both Float64Array -- is BALANCER-OWNED (the SmoothWRR
 * precedent: a strategy may own algorithm state), and the balancer is its SOLE writer, via the
 * warm `recordRtt()` feedback path. `pick()` NEVER writes: it decays ON READ, so the hot path
 * stays a pure read -> 0 B/op.
 *
 * Decay-on-read: ewmaAt(i, now) = _ewma[i] x exp(-max(now - _stamp[i], 0) / tau). No write, no clock
 * call on the gated path -- `now` (and the rtt sample) are CALLER-supplied nanoseconds, consistent
 * between `pick(now)` and `recordRtt(i, sampleNs, now)`, so the whole strategy is deterministic
 * and testable and allocates nothing. `dt` is clamped at 0 (L6) so a non-monotonic clock can never
 * inflate the estimate via `exp(+x)`.
 *
 * Cold start: `_ewma` seeds to 1.0 and `_stamp` to a NEGATIVE "unsampled" sentinel (-1). An unsampled
 * node costs 0 WHILE IDLE (so it holds one request in flight at a time until its first recordRtt) and
 * the pool's decaying mean ONCE BUSY (1.0 only before the very first sample), so a cold node that took
 * work is never mistaken for a 1.0 ns node and cannot become a black hole once samples flow (H1). The
 * first `recordRtt` initializes the EWMA EXACTLY to the sample (clock-independent); the peak rule
 * applies only from the second sample on. It is never NaN.
 *
 * Update rule (1.1.0, L4): Finagle's `observe()` exactly. A sample above the STORED estimate replaces
 * it; otherwise `ewma = ewma x w + sample x (1 - w)`, `w = exp(-dt/tau)`. (1.0.x decayed the estimate
 * first and then blended, `ewma x w^2 + sample x (1 - w)`, and forgot a slow period faster than
 * designed: 10 ms, one tau, then a 5 ms sample gave 4.51 ms where Finagle gives 6.84 ms.) One
 * deliberate difference: Finagle and tower also fold a 0 sample in on every READ, so their estimate
 * depends on how often a node is read; ours is a pure function of the samples and the clock.
 *
 * ACCEPTED CAVEAT (research/1.1.0-kernel-and-api.md 5.3, D5): a node that was idle and then receives a
 * request is priced by the time since its LAST response (the `dt` floor / the mean) until that
 * in-flight request completes -- there is no per-dispatch "busy since" stamp, by decision: Finagle,
 * tower and Linkerd do not keep one either, and a stamp would need a new call on every dispatch. The
 * answer to a request that never returns is a per-attempt TIMEOUT: the attempt throws, and the caller
 * (or @zakkster/lite-pick/pool) records `max(elapsed, penalty)` as a peak sample.
 *
 * Contract: `now` (in `pick(now)` / `recordRtt`) and `sampleNs` MUST be FINITE numbers. `recordRtt`
 * throws on a non-finite argument (the warm path); `pick(now)` never throws (the fail-closed
 * contract), so a non-finite `now` yields P2C-random selection rather than an error.
 *
 * Anti-flap (ADR 0002, ADR 0009): the EWMA time constant IS the smoothing -- a single slow sample
 * snaps the cost up instantly and it decays back over ~tau (half-life = tau x ln2), so there is NO
 * extra dwell/hysteresis.
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
     * Marker: this is a LATENCY-AWARE strategy -- pick() consumes a clock reading (`now`), so
     * @zakkster/lite-pick/pool REQUIRES an `opts.clock` and feeds recordRtt() from it. Read via
     * `balancer.constructor.LATENCY` so Pool stays duck-typed (imports nothing new).
     */
    static LATENCY = true;

    /**
     * @param {number} capacity  endpoint count (fixed).
     * @param {Uint8Array} eligible  shared view: 1 = pickable, 0 = down (length >= capacity).
     * @param {Uint32Array} inflight  per-endpoint in-flight counts (length >= capacity),
     *   caller-owned and only READ here.
     * @param {number} tauNs  the EWMA TIME CONSTANT in nanoseconds (> 0, finite; the half-life is
     *   tauNs x ln2): larger tau = slower decay = longer memory of a latency spike.
     * @param {number} [seed=0x9e3779b9]  deterministic PRNG seed (reproducible benches).
     */
    constructor(capacity, eligible, inflight, tauNs, seed = 0x9e3779b9) {
        super(capacity, eligible);
        // Validate typeof-first, BEFORE allocating the owned Float64 state (fail closed early).
        if (!(inflight instanceof Uint32Array) || inflight.length < capacity) {
            throw _err(RangeError, 'LITE_PICK_ARRAY', '[lite-pick] inflight must be a Uint32Array of length >= capacity');
        }
        if (typeof tauNs !== 'number') {
            throw _err(TypeError, 'LITE_PICK_OPTION', '[lite-pick] tauNs must be a number');
        }
        if (!Number.isFinite(tauNs) || tauNs <= 0) {
            throw _err(RangeError, 'LITE_PICK_OPTION', '[lite-pick] tauNs must be a finite number > 0');
        }
        this._inflight = inflight;
        this._tau = tauNs;
        this._rng = new Prng(seed);
        this._ewma = new Float64Array(capacity);
        this._stamp = new Float64Array(capacity);
        // Decaying pool mean of ALL rtt samples (1.1.0, D4; O(1), warm-path maintained in recordRtt): the
        // price an unsampled-but-BUSY node pays, so a cold node is not mistaken for a 1.0 ns node once it
        // has work in flight. [0] decayed sum, [1] decayed count, [2] time of the newest sample. Both sums
        // decay by the same factor, so mean = _samp[0] / _samp[1] needs no decay on read; count 0 (no
        // sample yet) -> 1.0. Held in a pre-allocated Float64Array (the hot-path law: pre-allocate
        // typed-array scalars, never a per-op object). Never NaN: the count is >= 1 after any sample.
        this._samp = new Float64Array(3);
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
        let dt = now - s;
        if (dt < 0) dt = 0;              // L6: clamp a non-monotonic clock -- exp(+x) must never inflate
        return this._ewma[i] * Math.exp(-dt / this._tau);
    }

    /**
     * Record an rtt SAMPLE for endpoint i at time `now` (the warm feedback path -- NOT the hot
     * pick path). The FIRST sample (an unsampled node, `_stamp < 0`) initializes the EWMA EXACTLY
     * to the sample, clock-magnitude-independent. Thereafter Finagle's peak rule (1.1.0, L4): a
     * sample above the STORED estimate replaces it (a spike is felt instantly), else
     * `ewma x w + sample x (1 - w)` with `w = exp(-dt/tau)` (it eases back over ~tau). Every sample
     * also feeds the decaying pool mean. The balancer is the SOLE writer of `_ewma` / `_stamp` /
     * `_samp`. Zero-alloc on the success path.
     * @param {number} i  endpoint index
     * @param {number} sampleNs  observed rtt in nanoseconds (finite, >= 0)
     * @param {number} now  caller-supplied nanoseconds (finite), consistent with pick(now)
     */
    recordRtt(i, sampleNs, now) {
        _vIdx(i, this._cap);
        if (typeof sampleNs !== 'number' || typeof now !== 'number') {
            throw _err(TypeError, 'LITE_PICK_ARGUMENT', '[lite-pick] recordRtt(i, sampleNs, now) requires numbers');
        }
        if (!Number.isFinite(sampleNs) || sampleNs < 0) {
            throw _err(RangeError, 'LITE_PICK_ARGUMENT', '[lite-pick] sampleNs must be a finite number >= 0');
        }
        if (!Number.isFinite(now)) throw _err(RangeError, 'LITE_PICK_ARGUMENT', '[lite-pick] now must be a finite number');
        const v = this._ewma[i];
        if (this._stamp[i] < 0 || sampleNs > v) {
            this._ewma[i] = sampleNs;   // first sample: exact init (clock-independent); else the PEAK: snap up
        } else {
            // L4 (1.1.0): Finagle's observe() exactly -- value x w + sample x (1 - w), the peak compared
            // with the STORED value. 1.0.x decayed twice (value x w^2 + sample x (1 - w)).
            let dt = now - this._stamp[i];
            if (dt < 0) dt = 0;         // L6: clamp a non-monotonic clock -- exp(+x) must never inflate
            const w = Math.exp(-dt / this._tau);
            this._ewma[i] = v * w + sampleNs * (1 - w);
        }
        this._stamp[i] = now;
        // O(1) warm DECAYING pool mean (1.1.0, D4): the sum and the count both decay by exp(-dt/tau) since
        // the newest sample from ANY node, then take this one at weight 1, so mean = sum / count weights
        // every sample by exp(-age/tau). Unboxed Float64Array (see the ctor). An overflowed (+Infinity) sum
        // times an underflowed pw === 0 is NaN; that reads as 0, so the sum restarts and is never NaN.
        // Zero-box: the guard merges two DOUBLES. `pw > 0 ? s[0] * pw + sampleNs : sampleNs` merged a double
        // with the tagged parameter, and Maglev boxed it (~16 B/op, PerfGate 8N: 24 scavenges).
        const s = this._samp;
        let pdt = now - s[2];
        if (pdt < 0) pdt = 0;           // L6: a backwards reading folds in at weight 1 and decays nothing
        else s[2] = now;
        const pw = Math.exp(-pdt / this._tau);
        const kept = s[0] * pw;
        s[0] = (kept === kept ? kept : 0) + sampleNs;
        s[1] = s[1] * pw + 1;
    }

    /**
     * Pick by latency-aware power-of-two-choices: two distinct eligible draws, LOWER COST wins (a tie
     * goes to the first draw). Cost is the three-case function documented on the class (unsampled+idle
     * -> 0; unsampled+busy -> (inflight+1) x decaying pool mean; sampled -> (inflight+1) x max(decayedEWMA,
     * dt-while-busy)), NOT a plain (inflight+1) x ewmaAt. PICK_NONE (fail closed) iff the whole pool is
     * down. O(d)=O(1), 0 B/op (pure read -- no write, no clock call; the mean division runs only in the
     * unsampled-and-busy arm, never in the both-sampled steady state).
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
        // Per-candidate cost (pure READ, scalar-only, 0 B/op). See the class JSDoc for the three cases.
        //   unsampled + idle -> 0 (costs 0 while idle until its first recordRtt; NOT a one-shot probe).
        //   unsampled + busy -> (inf+1) x pool mean  (the mean DIVISION runs ONLY here -- never in
        //                       the both-sampled steady state -- priced at the pool mean, not 1.0 ns).
        //   sampled          -> (inf+1) x base, base = decayed EWMA, floored at dt WHILE BUSY so a hung
        //                       node (dt grows, no completion) gets MORE expensive, not less.
        const sa = stamp[a];
        let costA;
        if (sa < 0) {
            costA = inf[a] === 0 ? 0 : (inf[a] + 1) * (this._samp[1] > 0 ? this._samp[0] / this._samp[1] : 1.0);
        } else {
            let dtA = now - sa;
            if (dtA < 0) dtA = 0;             // L6: clamp non-monotonic clock
            const decA = ewma[a] * Math.exp(-dtA / tau);
            const baseA = inf[a] > 0 ? (decA > dtA ? decA : dtA) : decA;   // busy floor: >= time since last sample
            costA = (inf[a] + 1) * baseA;
        }
        const sb = stamp[b];
        let costB;
        if (sb < 0) {
            costB = inf[b] === 0 ? 0 : (inf[b] + 1) * (this._samp[1] > 0 ? this._samp[0] / this._samp[1] : 1.0);
        } else {
            let dtB = now - sb;
            if (dtB < 0) dtB = 0;             // L6: clamp non-monotonic clock
            const decB = ewma[b] * Math.exp(-dtB / tau);
            const baseB = inf[b] > 0 ? (decB > dtB ? decB : dtB) : decB;   // busy floor
            costB = (inf[b] + 1) * baseB;
        }
        return costB < costA ? b : a;         // lower cost wins; tie -> the first draw
    }

    /** Cold snapshot (1.1.0): the base fields plus tau, the total in flight, how many nodes have a sample,
     *  and the decaying pool mean (null before any sample). */
    describe() {
        const d = super.describe();
        d.strategy = 'PeakEWMA';
        d.tauNs = this._tau;
        d.inflight = _sum(this._inflight, this._cap);
        let sampled = 0;
        for (let i = 0; i < this._cap; i++) if (this._stamp[i] >= 0) sampled++;
        d.sampled = sampled;
        d.poolMeanNs = this._samp[1] > 0 ? this._samp[0] / this._samp[1] : null;
        return d;
    }
}

/** The default Maglev lookup-table size: a prime (2^16 + 1). Configurable via the ctor. */
export const CH_DEFAULT_M = 65537;

/** The bounded forward-probe limit ConsistentHash walks past down slots (fail-closed). */
export const CH_PROBE_LIMIT = 64;

/**
 * A deterministic 32-bit integer mix (an SplitMix/Murmur-style finalizer). Used COLD, once
 * per backend at table build, to derive the two Maglev permutation parameters from a backend
 * INDEX -- NO string hashing, NO new dependency, no allocation. Returns a uint32.
 * @param {number} x
 * @returns {number}
 */
function chMix32(x) {
    x = x >>> 0;
    x ^= x >>> 16; x = Math.imul(x, 0x7feb352d);
    x ^= x >>> 15; x = Math.imul(x, 0x846ca68b);
    x ^= x >>> 16;
    return x >>> 0;
}

/** Cold primality test (trial division). M must be prime so a Maglev skip yields a full permutation. */
function chIsPrime(n) {
    if (!Number.isInteger(n) || n < 2) return false;
    if (n % 2 === 0) return n === 2;
    if (n % 3 === 0) return n === 3;
    for (let d = 5; d * d <= n; d += 6) {
        if (n % d === 0 || n % (d + 2) === 0) return false;
    }
    return true;
}

/**
 * ConsistentHashBalancer -- sticky / cache-affinity routing via a prebuilt MAGLEV lookup table
 * (M8), the in-kernel/production consistent-hash choice (Linux IPVS `mh`, Meta Katran, Cilium).
 *
 * `pick(keyHash)` maps a caller-supplied INTEGER key to a fixed backend: slot = keyHash % M, read
 * the backend at `lookup[slot]`, and if it is down walk a BOUNDED forward-probe (<= 64 slots) to
 * the next eligible backend. That is a few integer ops over a prebuilt Uint32Array table -- O(1)
 * per pick, 0 B/op. The KEY MUST BE AN INTEGER (`keyHash >>> 0`, so NaN -> 0 deterministically):
 * per-pick STRING hashing is the one zero-GC hazard, so the caller hashes string keys themselves
 * (cold) and passes the integer -- lite-pick adds NO hashing dependency (RESEARCH section 5).
 *
 * MINIMAL DISRUPTION is the selling point: on a scale event only ~1/N of keys move. Removing a
 * backend is just marking it down (`setEligible(i, false)`) -- the table is UNCHANGED, so every
 * key NOT on that backend keeps its exact backend (0 remap) and only its keys probe forward.
 * A membership or WEIGHT change rebuilds the table (COLD); a health flap NEVER does (the probe
 * absorbs it). test/balance.mjs anchors this: remove 1 of 64 backends -> <= 3.13% keys remapped,
 * vs the naive-modulo foil's >= 95%.
 *
 * Ownership (ADR 0001, ADR 0010): the balancer OWNS the lookup `Uint32Array` (M x 4 bytes; the
 * 65537 default is ~256KB, a COLD one-time allocation -- disclosed, and M is configurable DOWN
 * for small pools) AND an internal weights `Uint32Array` (the SmoothWRR sole-writer precedent):
 * cold `setWeight(i, w)` / `rebuild()` rebuild the table from the current weights. Eligibility is
 * the shared read-only bitmap from BalancerBase, read live by `pick()`; the base `setEligible`
 * only flips a bit (no rebuild).
 *
 * Weighted Maglev populate: each backend b takes a per-backend slot QUOTA proportional to its
 * weight (unweighted = equal quota, quotas summing to exactly M), stepping through its own
 * permutation `permutation[j] = (offset + j*skip) % M` (offset = h1(b) % M, skip = h2(b) % (M-1) +
 * 1, h1/h2 from a deterministic integer mix of the index -- no string hashing). Because the
 * permutation covers ALL M slots, a backend with remaining quota can always reach an empty slot
 * while one exists, so the O(M x N) COLD build never stalls. BUILD-COST GUARD (fail closed): the
 * ctor requires `capacity <= M` (more members than slots would overfill M / starve backends) and
 * M prime > 1.
 *
 * DEFERRED optional-peer seam (ADR 0010 / llms.txt, never on the pick path): a `@zakkster/lite-filter`
 * hot-key / known-key oracle (BlockedBloom etc.) for warm-affinity + admission at the KEY-routing
 * layer, and a `@zakkster/lite-o1` `EliasFano` ring alternative to the table. Import NOTHING;
 * `peerDependencies` STAYS `{}` until a shipped code path imports it.
 *
 * Bound: O(1) per pick, 0 B/op (integer ops over the prebuilt table -- no allocation). Fails closed
 * (PICK_NONE) only when no eligible backend owns a table slot (the whole pool down, or only weight-0
 * backends up). Past the 64-slot probe window a cold O(M) sweep finds a far eligible slot (L3, 1.1.0 --
 * 1.0.x returned PICK_NONE there; ADR 0010 amendment).
 */
export class ConsistentHashBalancer extends BalancerBase {
    /**
     * Marker: this is a KEYED strategy -- pick(keyHash) routes by an integer key, so
     * @zakkster/lite-pick/pool REQUIRES a numeric `opts.key`. Inherited by BoundedLoadBalancer.
     * Read via `balancer.constructor.KEYED` so Pool stays duck-typed (imports nothing new).
     */
    static KEYED = true;

    /**
     * @param {number} capacity  backend count (fixed; add/remove is a cold rebuild).
     * @param {Uint8Array} eligible  shared view: 1 = pickable, 0 = down (length >= capacity).
     * @param {Uint32Array|null} [weights=null]  optional per-backend weights (length >= capacity);
     *   the values are COPIED into the balancer-owned weights at construction. null = equal weight.
     * @param {number} [m=CH_DEFAULT_M]  the Maglev table size: a prime, > 1, and >= capacity.
     * @param {number} [seed=0x9e3779b9]  deterministic salt for the permutation mix (reproducible).
     */
    constructor(capacity, eligible, weights = null, m = CH_DEFAULT_M, seed = 0x9e3779b9) {
        super(capacity, eligible);
        // Validate typeof-first, BEFORE allocating the table / owned weights (fail closed early).
        if (typeof m !== 'number') {
            throw _err(TypeError, 'LITE_PICK_OPTION', '[lite-pick] table size M must be a number');
        }
        if (!Number.isInteger(m) || m < 2 || !chIsPrime(m)) {
            throw _err(RangeError, 'LITE_PICK_OPTION', '[lite-pick] table size M must be a prime integer > 1: ' + m);
        }
        if (capacity > m) {
            throw _err(RangeError, 'LITE_PICK_OPTION', '[lite-pick] capacity ' + capacity +
                ' exceeds table size M ' + m + ' (would overfill / starve backends)');
        }
        if (weights !== null && (!(weights instanceof Uint32Array) || weights.length < capacity)) {
            throw _err(RangeError, 'LITE_PICK_ARRAY', '[lite-pick] weights must be a Uint32Array of length >= capacity');
        }
        this._m = m;
        this._seed = seed >>> 0;
        // Balancer-owned weights (the SmoothWRR sole-writer precedent): copied, then the sole
        // mutator is setWeight (which rebuilds). Unweighted default = equal weight 1.
        this._weights = new Uint32Array(capacity);
        if (weights !== null) this._weights.set(weights.subarray(0, capacity));
        else this._weights.fill(1);
        // The prebuilt lookup table (slot -> backend index). M x 4 bytes; the COLD build fills it.
        this._lookup = new Uint32Array(m);
        this._build();
    }

    /** The Maglev table size M (prime). Readonly. */
    get tableSize() {
        return this._m;
    }

    /**
     * COLD: (re)populate the lookup table from the current balancer-owned weights via the weighted
     * Maglev algorithm. O(M x N); never stalls (each backend's permutation covers all M slots).
     * Rebuilt only on a membership / weight change -- never on a health flap. Allocates only cold
     * scratch that is released after the build; the lookup table itself is reused in place.
     */
    _build() {
        this._stats[STAT_REBUILDS] += 1;
        const M = this._m, N = this._cap, wt = this._weights, lookup = this._lookup, seed = this._seed;
        // Per-backend Maglev permutation parameters from a deterministic integer mix of the index.
        const offset = new Int32Array(N);
        const skip = new Int32Array(N);
        for (let b = 0; b < N; b++) {
            const h1 = chMix32(b ^ seed);
            const h2 = chMix32((b ^ seed) + 0x9e3779b9);
            offset[b] = h1 % M;
            skip[b] = (h2 % (M - 1)) + 1;
        }
        // Per-backend slot QUOTA proportional to weight, summing to exactly M (unweighted = equal).
        const quota = new Int32Array(N);
        let total = 0;
        for (let b = 0; b < N; b++) total += wt[b];
        if (total <= 0) {
            // Degenerate all-zero weights: equal quota so the table is still fully, validly populated.
            const base = Math.floor(M / N);
            for (let b = 0; b < N; b++) quota[b] = base;
            let leftover = M - base * N;
            for (let b = 0; leftover > 0; b = (b + 1) % N) { quota[b]++; leftover--; }
        } else {
            let assigned = 0;
            for (let b = 0; b < N; b++) { const q = Math.floor(wt[b] / total * M); quota[b] = q; assigned += q; }
            let leftover = M - assigned;
            // Hand the rounding leftover to positive-weight backends in index order (deterministic).
            for (let b = 0; leftover > 0; b = (b + 1) % N) { if (wt[b] > 0) { quota[b]++; leftover--; } }
        }
        // Maglev populate honoring the quota. The permutation is surjective over all M slots, so a
        // backend with remaining quota always reaches an empty slot while one exists -> no stall.
        // L7 (1.1.0): ADDITIVE stepping. Backend b's permutation is offset, offset+skip, offset+2skip, ...
        // (mod M); `cur[b]` holds its next position and advances by `skip[b]` with one conditional subtract.
        // The SAME sequence as `(offset + j*skip) % M` -- identical tables, so an upgrade moves no key --
        // without the multiply, which cost 10.5 ms per rebuild at M = 65537 (1.3 ms now).
        const cur = new Int32Array(N);
        for (let b = 0; b < N; b++) cur[b] = offset[b];
        const filledCount = new Int32Array(N);
        const taken = new Uint8Array(M);
        let filled = 0;
        while (filled < M) {
            let progressed = false;
            for (let b = 0; b < N; b++) {
                if (filledCount[b] >= quota[b]) continue;
                const sk = skip[b];
                let c = cur[b];
                while (taken[c]) { c += sk; if (c >= M) c -= M; }
                lookup[c] = b;
                taken[c] = 1;
                c += sk; if (c >= M) c -= M;
                cur[b] = c;
                filledCount[b]++;
                filled++;
                progressed = true;
                if (filled >= M) break;
            }
            if (!progressed) break;   // unreachable while quotas sum to M -- defensive
        }
        // Defensive completeness (unreachable): any slot left empty is pinned to backend 0 so pick()
        // never reads a stale / out-of-range index. Fail closed on a valid table, always.
        if (filled < M) {
            for (let c = 0; c < M; c++) if (!taken[c]) lookup[c] = 0;
        }
    }

    /**
     * COLD: reconfigure backend i's weight (uint32) and REBUILD the table from the new weights.
     * The balancer is the sole writer of its owned weights (the SmoothWRR precedent).
     * @param {number} i
     * @param {number} w  new weight (uint32)
     */
    setWeight(i, w) {
        _vIdx(i, this._cap);
        const nw = w >>> 0;
        if (nw !== w) throw _err(RangeError, 'LITE_PICK_WEIGHT', '[lite-pick] weight must be a uint32: ' + w);
        if (nw === this._weights[i]) return;
        this._weights[i] = nw;
        this._build();
    }

    /**
     * COLD (1.1.0): replace ALL backend weights at once and rebuild the table ONCE. Per-backend `setWeight`
     * rebuilds on every call (N rebuilds to retune N backends); this is the batch form. `weights` is COPIED
     * into the balancer-owned weights (indices [0, capacity)); validated before any write, so a bad call
     * changes nothing.
     * @param {Uint32Array} weights  new per-backend weights (length >= capacity)
     */
    setWeights(weights) {
        if (!(weights instanceof Uint32Array) || weights.length < this._cap) {
            throw _err(RangeError, 'LITE_PICK_ARRAY', '[lite-pick] weights must be a Uint32Array of length >= capacity');
        }
        const wt = this._weights;
        for (let i = 0; i < this._cap; i++) wt[i] = weights[i];
        this._build();
    }

    /** COLD: rebuild the lookup table from the current owned weights (e.g. after a membership change). */
    rebuild() {
        this._build();
    }

    /**
     * Map an INTEGER key to a backend index, or PICK_NONE (fail closed). O(1), 0 B/op.
     *
     * slot = (keyHash >>> 0) % M; if `lookup[slot]` is eligible return it, else forward-probe up to
     * CH_PROBE_LIMIT (64) slots for the next eligible backend. `keyHash` is coerced `>>> 0` (NaN -> 0
     * deterministically) and pick NEVER throws (the fail-closed contract). Past the window a cold
     * full-table sweep (`_sweep`, L3); PICK_NONE only when no eligible backend owns a table slot.
     * @param {number} keyHash  a caller-supplied integer key hash (coerced to uint32)
     * @returns {number}
     */
    pick(keyHash) {
        if (this._live === 0) return PICK_NONE;   // whole pool down: fail closed
        const M = this._m, el = this._eligible, lookup = this._lookup;
        let slot = (keyHash >>> 0) % M;           // integer key; NaN >>> 0 = 0 (never throws)
        let i = lookup[slot];
        if (el[i]) return i;
        this._stats[STAT_DISPLACED] += 1;         // D7: the home backend is down (the probe path only)
        // Bounded forward-probe past down slots; past the window, the cold full-table sweep (L3).
        for (let p = 0; p < CH_PROBE_LIMIT; p++) {
            slot++;
            if (slot >= M) slot = 0;
            i = lookup[slot];
            if (el[i]) return i;
        }
        return this._sweep(slot);
    }

    /**
     * COLD (L3, 1.1.0): past the CH_PROBE_LIMIT window, sweep the WHOLE table forward from `slot` and return
     * the first eligible backend -- the same idea as Linux IPVS `mh-fallback`. 1.0.x returned PICK_NONE here,
     * so a near-total outage (65+ consecutive slots on down backends) could fail closed while backends were
     * up. Now PICK_NONE means no eligible backend owns a table slot. O(M), 0 B/op, only on that path.
     * @param {number} slot  the last probed slot
     * @returns {number}
     */
    _sweep(slot) {
        this._stats[STAT_FALLBACK_SCANS] += 1;
        const M = this._m, el = this._eligible, lookup = this._lookup;
        for (let p = 0; p < M; p++) {
            slot++;
            if (slot >= M) slot = 0;
            const i = lookup[slot];
            if (el[i]) return i;
        }
        return PICK_NONE;
    }

    /** Cold snapshot (1.1.0): the base fields plus the table size M and the weights. */
    describe() {
        const d = super.describe();
        d.strategy = 'ConsistentHash';
        d.tableSize = this._m;
        d.weights = Array.from(this._weights.subarray(0, this._cap));
        return d;
    }
}

/**
 * BoundedLoadBalancer -- Consistent Hashing with Bounded Loads (M9, CHBL: Mirrokni-Thorup-
 * Zadimoghaddam, Google Research 2016; Vimeo's eps ~ 0.25). This is `ConsistentHashBalancer` (the M8
 * Maglev table) PLUS an occupancy CAP: a key sticks to its hashed home backend UNLESS that backend is
 * over the cap, in which case the request OVERFLOWS along the same bounded forward-probe to the next
 * eligible, under-cap backend. It keeps consistent hashing's stickiness + minimal disruption AND adds
 * the HOTSPOT protection plain consistent hashing lacks: a few very hot keys can pile unbounded load
 * on one backend, so the cap spreads the overflow to neighbours while everything else stays put.
 *
 * Why this is the REAL bounded-load strategy (ADR 0011): P2C-over-inflight with a `(1+eps) x mean` cap
 * is byte-identical to plain P2C (an under-cap draw ALWAYS has lower inflight than an over-cap one, so
 * "prefer under-cap" and "lower-of-two" pick the same node) -- the cap is a no-op there. The cap is
 * only LOAD-BEARING when the primary choice is fixed by something OTHER than load: a hash. CHBL is
 * that -- the hashed home is sticky, and the cap is what lets a hot home overflow.
 *
 * `pick(keyHash)` (HOT, 0 B/op, NEVER throws): k = keyHash >>> 0; slot = k % M; walk the M8 probe
 * window (home + CH_PROBE_LIMIT slots) and return the FIRST backend that is ELIGIBLE AND UNDER cap
 * (`inflight[b] < cap`). If none in the window is under cap, FALL BACK to the first eligible seen
 * (sticky wins; the cap is a soft preference, never a dead pick). When `_total === 0` the cap test is
 * skipped entirely -> behaves as pure ConsistentHash. `cap = ceil((1 + eps) x (_total + 1) / live)`
 * -- the load-bearing change from the old `(1 + eps) x _total / live` is the +1 that counts the
 * INCOMING request (Mirrokni-Thorup-Zadimoghaddam per-bin capacity). The ceil is the paper's integer
 * capacity; the code compares against the unrounded x, which is equivalent for the `inf < cap` test
 * (for integer inf, `inf < ceil(x)` == `inf < x`) and avoids the call on the hot path. A second concurrent same-key request correctly overflows the home
 * until `(1+eps)(_total+1)/live > 1`. HAProxy's `hash-balance-factor` shares the +1 but distributes
 * ONE global `ceil((m+1)F/100)` slot budget across servers by weight (min 1), which is stricter.
 *
 * Ownership (ADR 0001, ADR 0004, ADR 0010, ADR 0011): the Maglev lookup table + weights are
 * BALANCER-OWNED and built COLD (reused from ConsistentHashBalancer VERBATIM -- `_build`, `setWeight`,
 * `rebuild`, `tableSize`, the probe walk, `chMix32`, `CH_DEFAULT_M`, `CH_PROBE_LIMIT`). `inflight` is
 * the CALLER's Uint32Array, read LIVE as the per-backend OCCUPANCY source. The running occupancy sum
 * `_total` is BALANCER-OWNED and its SOLE writer is the warm `note(i, delta)` feedback path
 * (dispatch +1 / settle -1), so the cap's mean stays O(1)-current without a scan.
 *
 * CONTRACT (the SmoothWRR-weights asymmetry): when using BoundedLoad, update `inflight[i]` AND call
 * `note(i, +/-1)` in LOCKSTEP (or drive it through the /pool adapter, which does both). `note`
 * maintains `_total`; it does NOT write `inflight`. A direct `inflight` write without the matching
 * `note` desyncs `_total` from the true sum, so the cap goes wrong -- UB. `note()` clamps `_total`
 * at 0; `totalInflight` exposes it.
 *
 * Bound: O(1) per pick (modulo + table read + bounded cap-aware probe), 0 B/op on BOTH `pick()` and
 * `note()` (torture + PerfGate). Fails closed (PICK_NONE) ONLY when no eligible backend owns a table
 * slot (M8's contract, with the L3 sweep) -- NEVER merely because backends are over cap.
 */
export class BoundedLoadBalancer extends ConsistentHashBalancer {
    /**
     * @param {number} capacity  backend count (fixed; add/remove is a cold rebuild).
     * @param {Uint8Array} eligible  shared view: 1 = pickable, 0 = down (length >= capacity).
     * @param {Uint32Array} inflight  per-backend OCCUPANCY (length >= capacity), caller-owned and read
     *   LIVE -- but mutated EXCLUSIVELY via note() / the /pool adapter (direct mutation desyncs the
     *   owned _total -- UB).
     * @param {number} [eps=0.25]  the bounded-load slack over the mean: finite, > 0. cap =
     *   (1 + eps) x mean occupancy. Default 0.25 (Vimeo).
     * @param {Uint32Array|null} [weights=null]  optional per-backend weights (COPIED); null = equal.
     * @param {number} [m=CH_DEFAULT_M]  the Maglev table size: a prime, > 1, and >= capacity.
     * @param {number} [seed=0x9e3779b9]  deterministic salt for the permutation mix (reproducible).
     * @param {number} [minCap=0]  OPT-IN floor on the per-backend cap (N4, 1.1.0): cap = max(minCap,
     *   ceil((1+eps)(T+1)/live)). 0 (default) is the paper's / HAProxy's capacity exactly. At low load
     *   that capacity is 1, so a SECOND concurrent request for the same key always leaves its home;
     *   minCap = k keeps up to k concurrent same-key requests at home, at the price of a looser bound
     *   while the pool is nearly idle. Our extension -- no reference implementation offers the knob.
     */
    constructor(capacity, eligible, inflight, eps = 0.25, weights = null, m = CH_DEFAULT_M, seed = 0x9e3779b9, minCap = 0) {
        // Validate inflight + eps typeof-first, BEFORE super() allocates the (cold, ~256KB) Maglev
        // table (fail closed early -- the PeakEWMA / ConsistentHash precedent). These read the args
        // only (no `this`), so they may run before super().
        if (!(inflight instanceof Uint32Array) || inflight.length < capacity) {
            throw _err(RangeError, 'LITE_PICK_ARRAY', '[lite-pick] inflight must be a Uint32Array of length >= capacity');
        }
        if (typeof eps !== 'number') {
            throw _err(TypeError, 'LITE_PICK_OPTION', '[lite-pick] eps must be a number');
        }
        if (!Number.isFinite(eps) || eps <= 0) {
            throw _err(RangeError, 'LITE_PICK_OPTION', '[lite-pick] eps must be a finite number > 0');
        }
        if (typeof minCap !== 'number') {
            throw _err(TypeError, 'LITE_PICK_OPTION', '[lite-pick] minCap must be a number');
        }
        if (!Number.isInteger(minCap) || minCap < 0 || minCap > 0xFFFFFFFF) {
            throw _err(RangeError, 'LITE_PICK_OPTION', '[lite-pick] minCap must be an integer in [0, 2^32 - 1]: ' + minCap);
        }
        // super() validates capacity/eligible/weights/m, copies weights, and builds the Maglev table.
        super(capacity, eligible, weights, m, seed);
        this._inflight = inflight;
        this._eps = eps;
        this._minCap = minCap;
        // The running occupancy sum the balancer OWNS. Starts at 0: note() is its sole writer, so a
        // caller must drive dispatch/settle through note() (or /pool) -- inflight seeded non-zero
        // BEFORE construction would desync it (UB, as documented).
        this._total = 0;
    }

    /** The balancer-owned running sum of in-flight the mean/cap is computed from. Readonly. */
    get totalInflight() {
        return this._total;
    }

    /** The opt-in cap floor (N4, 1.1.0); 0 = the paper's capacity. Readonly (set at construction). */
    get minCap() {
        return this._minCap;
    }

    /**
     * Warm feedback path (NOT the hot pick path): adjust the owned running occupancy sum by `delta`
     * for backend `i`. This is the SOLE writer of `_total`: dispatch is note(i, +1), settle is
     * note(i, -1), so the cap's mean stays O(1)-current without scanning inflight. `i` is validated in
     * range (like setEligible); `delta` is validated typeof-first as an integer. `_total` clamps at 0
     * (an over-decrement never drives the mean negative). Zero-alloc on the success path.
     * @param {number} i  backend index (validated in range)
     * @param {number} delta  integer occupancy change (+1 dispatch, -1 settle)
     */
    note(i, delta) {
        _vIdx(i, this._cap);
        if (typeof delta !== 'number') throw _err(TypeError, 'LITE_PICK_ARGUMENT', '[lite-pick] delta must be a number');
        if (!Number.isInteger(delta)) throw _err(RangeError, 'LITE_PICK_ARGUMENT', '[lite-pick] delta must be an integer: ' + delta);
        const t = this._total + delta;
        this._total = t > 0 ? t : 0;   // clamp: over-decrement never drives the mean negative
    }

    /**
     * Map an INTEGER key to a backend, honouring the occupancy cap, or PICK_NONE (fail closed). O(1),
     * 0 B/op, never throws. slot = (keyHash >>> 0) % M; walk the M8 probe window (home + CH_PROBE_LIMIT
     * slots) and return the FIRST backend that is ELIGIBLE AND under cap = ceil((1+eps) x (_total+1) /
     * live). If none in the window is under cap, fall back to the FIRST eligible seen (sticky wins -- the cap is
     * a soft preference, never a dead pick). `_total === 0` skips the cap test -> pure ConsistentHash.
     * Nothing eligible in the window: the cold full-table sweep (L3). PICK_NONE ONLY when no eligible
     * backend owns a table slot.
     * @param {number} keyHash  a caller-supplied integer key hash (coerced to uint32)
     * @returns {number}
     */
    pick(keyHash) {
        if (this._live === 0) return PICK_NONE;   // whole pool down: fail closed
        const M = this._m, el = this._eligible, lookup = this._lookup, inf = this._inflight;
        const total = this._total;
        // cap is only meaningful once occupancy is known; _total === 0 -> pure ConsistentHash.
        const capActive = total > 0;
        // CHBL cap (Mirrokni-Thorup-Zadimoghaddam per-bin capacity). The load-bearing part is the +1
        // that counts the INCOMING request. The paper's integer capacity is ceil(x); it is NOT taken here
        // because for an integer inf `inf < ceil(x)` == `inf < x`, and the call cost 15-20% (N3).
        let cap = capActive ? (1 + this._eps) * (total + 1) / this._live : 0;     // > 0: total>0, live>0
        // Opt-in floor (N4, 1.1.0): for integer inf and minCap, inf < max(minCap, x) == inf < max(minCap, ceil(x)).
        if (cap < this._minCap) cap = this._minCap;
        let slot = (keyHash >>> 0) % M;           // integer key; NaN >>> 0 = 0 (never throws)
        let firstEligible = -1;                   // the pure-ConsistentHash sticky fallback answer
        let i = lookup[slot];
        if (el[i]) {
            if (!capActive || inf[i] < cap) return i;   // sticky home, under cap: the common fast path
            firstEligible = i;
        }
        this._stats[STAT_DISPLACED] += 1;         // D7: home down or over cap (the probe path only)
        // Bounded forward-probe (M8's exact walk): the first eligible AND under-cap backend wins; a hot
        // home OVERFLOWS to its neighbours. Past the window we fall back to the sticky first-eligible.
        for (let p = 0; p < CH_PROBE_LIMIT; p++) {
            slot++;
            if (slot >= M) slot = 0;
            i = lookup[slot];
            if (el[i]) {
                if (!capActive || inf[i] < cap) return i;   // eligible + under cap: overflow target
                if (firstEligible < 0) firstEligible = i;    // remember the first eligible (fallback)
            }
        }
        // Nothing eligible in the window: the cold full-table sweep (L3), cap ignored (never a dead pick).
        return firstEligible >= 0 ? firstEligible : this._sweep(slot);
    }

    /** Cold snapshot (1.1.0): the ConsistentHash fields plus eps, minCap, the noted total, the total in
     *  flight and the cap a pick would use now (null while the cap is inactive: total 0 or nothing live). */
    describe() {
        const d = super.describe();
        d.strategy = 'BoundedLoad';
        d.eps = this._eps;
        d.minCap = this._minCap;
        d.total = this._total;
        d.inflight = _sum(this._inflight, this._cap);
        let cap = null;
        if (this._total > 0 && this._live > 0) {
            cap = (1 + this._eps) * (this._total + 1) / this._live;
            if (cap < this._minCap) cap = this._minCap;
        }
        d.cap = cap;
        return d;
    }

    /** Cold, opt-in (1.1.0): the base recount plus the noted total, which must equal the inflight sum -- every
     *  inflight change mirrored by note(i, delta) (Pool does both). Call it between requests, not mid-dispatch. */
    assertConsistent() {
        super.assertConsistent();
        const t = _sum(this._inflight, this._cap);
        if (t !== this._total) {
            throw _err(Error, 'LITE_PICK_INCONSISTENT', '[lite-pick] the noted total is ' + this._total + ' but inflight[] sums to ' +
                t + ': mirror every inflight change with note(i, delta)');
        }
    }
}

/**
 * WeightedRandomBalancer -- O(1) weighted-random selection via a Vose/Walker ALIAS TABLE (M10),
 * the roster-completing strategy.
 *
 * `pick()` draws ONE column uniformly (`prng.nextBelow(cap)`), compares one fresh uniform against
 * `_prob[col]`, and takes `col` or `_alias[col]` -- a constant handful of integer/float ops that
 * return an endpoint proportional to its weight. This is the STATELESS O(1) weighted selector: no
 * per-endpoint accumulator to desync (SmoothWRR's `_current`), just a static table sampled with a
 * PRNG -- the fit for VERY LARGE pools where SmoothWRR's O(cap)-per-pick scan hurts. It trades
 * SmoothWRR's deterministic low-variance smoothness for sampling variance (any single pick is
 * random; the LAW OF LARGE NUMBERS delivers the weight ratios over a run -- balance.mjs anchors it).
 *
 * ELIGIBILITY is REJECTION SAMPLING over the shared bitmap (the ADR 0005 / P2C discipline, not a
 * table rebuild): if the drawn candidate is ineligible, redraw up to a bounded 64 times, then fall
 * back to a 0-B/op rotated linear scan from a random start for the degenerate heavy-outage case.
 * Because the alias table is built over the ELIGIBLE-INDEPENDENT weights and a candidate is ALWAYS
 * a positive-weight node (a weight-0 node is never a column -- see _build), rejecting the ineligible
 * draws RENORMALIZES the weight distribution over the SURVIVING eligible mass: each eligible node's
 * long-run share converges to weight[i] / sum(eligible weights) (ADR 0012 Fork 1). The rare fallback
 * scan returns the first eligible positive-weight node from a random offset (unbiased first-after-
 * offset), a correctness net, not a proportional path.
 *
 * Ownership (ADR 0001, ADR 0004, ADR 0012): `weights` is the CALLER's Uint32Array (length >= capacity)
 * -- the SmoothWRR / SED weight seam -- and the balancer is the SOLE writer of its DERIVED alias table
 * (`_prob` Float64Array + `_alias` Int32Array, both balancer-owned) via the cold `setWeight` / `rebuild`
 * (which read `weights` and rebuild the table); mutating `weights` directly desyncs the table (UB, the
 * SmoothWRR asymmetry). The alias build reuses COLD scratch worklists allocated once in the ctor -- the
 * build allocates nothing per call, and pick() allocates nothing per call.
 *
 * Fail-closed (ADR 0012 Fork 2): `pick()` returns PICK_NONE (-1) IFF `live === 0` OR no eligible node
 * has a positive weight (all-zero weights, or every eligible node's weight is 0). NEVER a dead pick,
 * a weight-0 return, or an out-of-range index. `pick()` never throws.
 *
 * Bound: O(1) per pick (one column draw + one compare, expected O(1) rejection draws when eligibility
 * is dense), 0 B/op (integer/float locals only) -- proven by test/torture.mjs + test/perf/PerfGate.test.mjs.
 *
 * DEFERRED optional-peer seams (import NOTHING; peerDependencies STAYS `{}` until a shipped path imports
 * one): a `@zakkster/lite-o1` `AliasTable` as a duck-typed drop-in for the inline Vose build, and a
 * `@zakkster/lite-logn` Fenwick/BinaryIndexedTree for the DYNAMIC-weight case (O(log n) update + sample)
 * -- the mutable-weight complement to this static table's O(1) sample / O(cap) rebuild (ADR 0012).
 *
 * NOT `@zakkster/lite-random`: that sibling is a GAME RNG (Mulberry32; loot tables, particles, gaussian)
 * whose `weighted(items, weights)` returns an ITEM one-shot, is NOT eligibility-aware, holds no reusable
 * table, and uses a different PRNG. lite-pick's WeightedRandom returns an endpoint INDEX, honours the
 * shared eligibility bitmap (fail-closed), owns a persistent alias table rebuilt only on reweight, and
 * uses the in-repo xorshift32. Different domain + contract -- not a peer, not a substrate (ADR 0012 / GUIDE.md).
 */
export class WeightedRandomBalancer extends BalancerBase {
    /**
     * @param {number} capacity  endpoint count (fixed; add/remove is a cold rebuild).
     * @param {Uint8Array} eligible  shared view: 1 = pickable, 0 = down (length >= capacity).
     * @param {Uint32Array} weights  caller-owned per-endpoint weights (length >= capacity); the balancer
     *   is the sole writer of the DERIVED alias table via setWeight (direct mutation desyncs it -- UB).
     * @param {number} [seed=0x9e3779b9]  deterministic PRNG seed (reproducible benches).
     */
    constructor(capacity, eligible, weights, seed = 0x9e3779b9) {
        super(capacity, eligible);
        // Validate typeof-first, BEFORE allocating the owned table / scratch (fail closed early -- the
        // PeakEWMA / ConsistentHash / BoundedLoad discipline).
        if (!(weights instanceof Uint32Array) || weights.length < capacity) {
            throw _err(RangeError, 'LITE_PICK_ARRAY', '[lite-pick] weights must be a Uint32Array of length >= capacity');
        }
        this._weights = weights;
        this._rng = new Prng(seed);
        // Balancer-owned derived table: _prob (the split probability per column) + _alias (the column's
        // alternate). A candidate is ALWAYS a positive-weight node (see _build), so pick() never returns
        // a weight-0 index.
        this._prob = new Float64Array(capacity);
        this._alias = new Int32Array(capacity);
        // COLD scratch worklists for the Vose build (small/large index stacks + the scaled probabilities),
        // allocated ONCE here and reused by every _build -- the build never allocates per call.
        this._small = new Int32Array(capacity);
        this._large = new Int32Array(capacity);
        this._scaled = new Float64Array(capacity);
        this._psum = 0;      // sum of ALL weights (the eligible-independent normalizer); 0 => degenerate.
        this._builds = 0;    // COLD rebuild counter (observability / the anti-flap gate: a flap adds 0).
        this._build();
    }

    /**
     * COLD: (re)build the Vose/Walker alias table from the current caller weights. The standard
     * small/large worklist over `scaled[i] = weights[i] * cap / total` (mean-1 normalization): pair a
     * deficient (< 1) column with a surplus (>= 1) one until one worklist empties, then drain the
     * residue (numerically ~1 full columns) to prob 1. A weight-0 node has scaled 0, so it is popped
     * once, assigned prob 0 + a POSITIVE-weight alias, and NEVER reaches the prob-1 drain -- it can
     * never be returned as its own column. All-zero weights (total 0) leaves _psum 0 and pick() fails
     * closed. Reuses the cold scratch worklists -- allocates nothing. ~15 lines (do NOT re-implement
     * lite-o1's AliasTable; this is the inline standard build, ADR 0012 Fork 0).
     */
    _build() {
        this._builds++;
        this._stats[STAT_REBUILDS] += 1;
        const cap = this._cap, wt = this._weights, prob = this._prob, alias = this._alias;
        const scaled = this._scaled, small = this._small, large = this._large;
        let total = 0;
        for (let i = 0; i < cap; i++) total += wt[i];
        this._psum = total;
        if (total <= 0) {
            // Degenerate all-zero weights: no positive-weight column. pick() short-circuits on _psum===0
            // (PICK_NONE), so the table is never read -- fill it defensively (each column self-referential).
            for (let i = 0; i < cap; i++) { prob[i] = 0; alias[i] = i; }
            return;
        }
        const scale = cap / total;
        let ns = 0, nl = 0;                       // small / large stack heights (indices into the scratch)
        for (let i = 0; i < cap; i++) {
            const v = wt[i] * scale;
            scaled[i] = v;
            if (v < 1) small[ns++] = i; else large[nl++] = i;
        }
        while (ns > 0 && nl > 0) {
            const s = small[--ns];
            const l = large[--nl];
            prob[s] = scaled[s];
            alias[s] = l;                         // l is surplus (scaled >= 1) => positive weight
            const rem = (scaled[l] + scaled[s]) - 1;
            scaled[l] = rem;
            if (rem < 1) small[ns++] = l; else large[nl++] = l;
        }
        while (nl > 0) { const l = large[--nl]; prob[l] = 1; alias[l] = l; }   // full columns
        while (ns > 0) { const s = small[--ns]; prob[s] = 1; alias[s] = s; }   // float residue ~1
    }

    /**
     * COLD: reconfigure endpoint i's weight (uint32) and REBUILD the alias table from the new weights.
     * The balancer is the sole writer of the derived table (the SmoothWRR / ConsistentHash precedent).
     * @param {number} i
     * @param {number} w  new weight (uint32)
     */
    setWeight(i, w) {
        _vIdx(i, this._cap);
        const nw = w >>> 0;
        if (nw !== w) throw _err(RangeError, 'LITE_PICK_WEIGHT', '[lite-pick] weight must be a uint32: ' + w);
        if (nw === this._weights[i]) return;
        this._weights[i] = nw;
        this._build();
    }

    /**
     * COLD (1.1.0): replace ALL weights at once and rebuild the alias table ONCE -- the batch form of
     * `setWeight` (which rebuilds per call). The values are COPIED into the weights array this balancer was
     * built with (the caller's array, indices [0, capacity)); validated before any write.
     * @param {Uint32Array} weights  new per-endpoint weights (length >= capacity)
     */
    setWeights(weights) {
        if (!(weights instanceof Uint32Array) || weights.length < this._cap) {
            throw _err(RangeError, 'LITE_PICK_ARRAY', '[lite-pick] weights must be a Uint32Array of length >= capacity');
        }
        const wt = this._weights;
        for (let i = 0; i < this._cap; i++) wt[i] = weights[i];
        this._build();
    }

    /** COLD: rebuild the alias table from the current caller weights (e.g. after a membership change). */
    rebuild() {
        this._build();
    }

    /**
     * Pick an endpoint index proportional to weight, or PICK_NONE (fail closed). O(1), 0 B/op, never
     * throws. One column draw + one probability compare yields a positive-weight candidate; an
     * ineligible candidate is rejection-redrawn up to 64 times (renormalizing the weight distribution
     * over the eligible mass), then a rotated linear scan from a random start returns the first eligible
     * positive-weight node. PICK_NONE IFF live === 0 OR no eligible node has a positive weight.
     * @returns {number}
     */
    pick() {
        if (this._live === 0 || this._psum === 0) return PICK_NONE;   // pool down / no positive weight
        const cap = this._cap, el = this._eligible, prob = this._prob, alias = this._alias, rng = this._rng;
        // Fast path: alias draw + rejection on eligibility. A candidate is always positive-weight, so
        // rejecting the ineligible ones renormalizes weight-proportionality over the surviving mass.
        for (let t = 0; t < 64; t++) {
            const col = rng.nextBelow(cap);
            const u = rng.next() / 4294967296;    // fresh uniform in [0, 1)
            const cand = u < prob[col] ? col : alias[col];
            if (el[cand]) return cand;
        }
        return this._sparsePick();                // degenerate sparsity: the cold fallback (L2)
    }

    /**
     * COLD (L2, 1.1.0): the very-sparse fallback, WEIGHT-PROPORTIONAL over the eligible positive-weight nodes
     * like the fast path -- u uniform in [0, eligible weight), walk the cumulative weights. The 1.0.x
     * fallback (first eligible after a random start) favoured a node after a long down run. Its own method so
     * the fractional `u` never lives in pick()'s body (the zero-box law); returns an index. Zero-alloc, O(cap).
     * @returns {number}
     */
    _sparsePick() {
        this._stats[STAT_FALLBACK_SCANS] += 1;
        const cap = this._cap, el = this._eligible, wt = this._weights;
        let s = 0;
        for (let i = 0; i < cap; i++) if (el[i]) s += wt[i];
        if (s === 0) return PICK_NONE;            // no eligible positive-weight node
        let u = (this._rng.next() / 4294967296) * s;
        let last = PICK_NONE;
        for (let i = 0; i < cap; i++) {
            if (el[i] && wt[i] > 0) { u -= wt[i]; last = i; if (u < 0) return i; }
        }
        return last;                              // float residue: the last positive-weight eligible node
    }

    /** Cold snapshot (1.1.0): the base fields plus the weights and the weight sum the alias table was built on. */
    describe() {
        const d = super.describe();
        d.strategy = 'WeightedRandom';
        d.weights = Array.from(this._weights.subarray(0, this._cap));
        d.weightSum = this._psum;
        return d;
    }

    /** Cold, opt-in (1.1.0): the base recount plus the table's weight sum (a direct `weights[i]` write without
     *  rebuild() leaves the alias table stale). */
    assertConsistent() {
        super.assertConsistent();
        const t = _sum(this._weights, this._cap);
        if (t !== this._psum) {
            throw _err(Error, 'LITE_PICK_INCONSISTENT', '[lite-pick] the alias table was built on a weight sum of ' + this._psum +
                ' but the weights sum to ' + t + ': weights[] changed without rebuild() -- use setWeight() / setWeights()');
        }
    }
}
