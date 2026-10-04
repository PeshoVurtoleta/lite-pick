/**
 * @zakkster/lite-pick -- TypeScript declarations.
 *
 * M10 (1.0.0): substrate seams + RoundRobin + SmoothWRR + P2C + the exact LeastConn family
 * (LeastConn/SED/NQ) + PeakEWMA (latency-aware P2C) + ConsistentHash (Maglev table) +
 * BoundedLoad (consistent hashing with bounded loads) + WeightedRandom (O(1) Vose alias-table
 * sampling). Roster complete for now (NOT closed: AZ-aware routing, hedging, subsetting post-1.0).
 */

/** The single source-of-truth version stamp. */
export const VERSION: string;

/**
 * Fail-closed sentinel returned by `pick()` when no endpoint is eligible.
 * A strategy never returns a down index; `PICK_NONE` (-1) means "no endpoint".
 */
export const PICK_NONE: -1;

/**
 * The stable `code` on every error lite-pick throws or rejects with (1.1.0). Messages may change in any
 * release; codes are semver API. The error CLASS is unchanged (TypeError for a wrong type, RangeError for a
 * value out of its domain, Error otherwise). Kernel: CAPACITY, ARRAY (a typed array of the wrong type or too
 * short, or a bad stats slab), INDEX, WEIGHT, OPTION (a constructor / run option out of its domain), ARGUMENT
 * (a call argument: recordRtt's sample / clock, note's delta, Pool.run's fn), ABSTRACT, INCONSISTENT
 * (assertConsistent). Pool adds KEY_REQUIRED, CLOCK_REQUIRED, CLOCK_INVALID, ABORTED, NONE, FEEDBACK.
 */
export type LitePickErrorCode =
    | 'LITE_PICK_CAPACITY' | 'LITE_PICK_ARRAY' | 'LITE_PICK_INDEX' | 'LITE_PICK_WEIGHT' | 'LITE_PICK_OPTION'
    | 'LITE_PICK_ARGUMENT' | 'LITE_PICK_ABSTRACT' | 'LITE_PICK_INCONSISTENT'
    | 'LITE_PICK_KEY_REQUIRED' | 'LITE_PICK_CLOCK_REQUIRED' | 'LITE_PICK_CLOCK_INVALID' | 'LITE_PICK_ABORTED'
    | 'LITE_PICK_NONE' | 'LITE_PICK_FEEDBACK';

/**
 * Stats slab indices (1.1.0). Attach a caller-owned `Float64Array(STAT_COUNT)` with `attachStats`; the
 * balancer adds to it, never resets it (read deltas). Only events the caller cannot see are counted, and only
 * off the healthy pick path. New indices are only ever appended: size slabs with `STAT_COUNT`.
 */
/** P2C / PeakEWMA / WeightedRandom very-sparse fallback, or the ConsistentHash / BoundedLoad full-table sweep. */
export const STAT_FALLBACK_SCANS: 0;
/** A ConsistentHash / BoundedLoad / WeightedRandom table build (rebuild, setWeight, setWeights; the constructor's too). */
export const STAT_REBUILDS: 1;
/** A ConsistentHash / BoundedLoad keyed pick that did not return its home backend (home down, or over cap). */
export const STAT_DISPLACED: 2;
/** The number of stats indices in this version. */
export const STAT_COUNT: number;

/** The counters in a `describe()` snapshot (null when no slab is attached). */
export interface BalancerStats {
    fallbackScans: number;
    rebuilds: number;
    displaced: number;
}

/** The fields every `describe()` snapshot has; each strategy adds its own. Plain, JSON-safe data. */
export interface BalancerDescription {
    strategy: string;
    capacity: number;
    live: number;
    stats: BalancerStats | null;
}

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
 * The eligibility seam for every strategy. Owns the fixed capacity, a reference to a
 * read-only eligibility `Uint8Array`, and an O(1) live count. The array is flipped ONLY
 * through `setEligible` (the sole supported writer -- @zakkster/lite-di-health / circuit
 * breakers drive that call); a direct byte write desyncs the cached live count (UB). Each
 * balancer needs its own array. Subclasses implement `pick()`; the base `pick()` throws.
 */
export class BalancerBase {
    /**
     * @param capacity endpoint count (fixed).
     * @param eligible 1 = pickable, 0 = down (length >= capacity); per-balancer, flipped only via `setEligible`.
     */
    constructor(capacity: number, eligible: Uint8Array);
    /** Endpoint count (fixed at construction). */
    readonly capacity: number;
    /** Number of currently eligible endpoints (O(1)). */
    readonly live: number;
    /** True iff endpoint `i` is currently pickable; a non-integer or out-of-range `i` is `false` (never throws). */
    isEligible(i: number): boolean;
    /** Cold path: the only supported eligibility writer -- flips `i` up/down and keeps the live count exact.
     *  Throws `RangeError` on a non-integer or out-of-range index (incl. a numeric string like '2'). */
    setEligible(i: number, up: boolean): void;
    /**
     * Cold (1.1.0): count this balancer's internal events (`STAT_*`) into a caller-owned slab; `null`
     * detaches. Several balancers may share one slab. Throws RangeError (`LITE_PICK_ARRAY`) on anything but a
     * `Float64Array` of length >= `STAT_COUNT` or `null`.
     */
    attachStats(slab: Float64Array | null): void;
    /** The attached stats slab, or null. */
    readonly stats: Float64Array | null;
    /** Cold (1.1.0): a plain-object snapshot (allocates; never per pick). Node's `util.inspect` prints it too. */
    describe(): BalancerDescription;
    /**
     * Cold, opt-in (1.1.0): recount the cached state (the live count; SmoothWRR's eligible-weight total,
     * WeightedRandom's table weight sum, BoundedLoad's noted total) and throw `LITE_PICK_INCONSISTENT` on a
     * mismatch -- the trace of a direct `eligible[i]` / `weights[i]` write or a missing `note()`. O(cap).
     */
    assertConsistent(): void;
    /**
     * Choose an endpoint index, or `PICK_NONE`. Abstract in the base (throws). Declared with a
     * DELIBERATELY LOOSE optional numeric argument so a keyed subclass (`pick(keyHash)`) or a latency
     * subclass (`pick(now)`) that requires it stays assignable to `BalancerBase` (`const b:
     * BalancerBase = ch; b.pick()` type-checks). To get the required-arg compile check, reference the
     * CONCRETE class type (e.g. `ConsistentHashBalancer` / `PeakEwmaBalancer`), not `BalancerBase`.
     */
    pick(arg?: number): number;
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
    /** Snapshot: plus the cursor (the last index returned; -1 before any). */
    describe(): BalancerDescription & { strategy: 'RoundRobin'; cursor: number };
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
    /** Snapshot: plus the weights (a copy) and the cached eligible-weight total. */
    describe(): BalancerDescription & { strategy: 'SmoothWRR'; weights: number[]; eligibleWeight: number };
}

/**
 * P2cBalancer -- power-of-two-choices (M3), the headline strategy. Draws two distinct
 * eligible endpoints at random and returns the one with the lower in-flight load; the
 * `ln ln n / ln 2` peak-load ceiling. In-flight counts are the caller's Uint32Array
 * (read-only to `pick()`). O(1) per pick, 0 B/op. Fails closed (`PICK_NONE`) when down.
 */
export class P2cBalancer extends BalancerBase {
    /**
     * @param capacity endpoint count (fixed).
     * @param eligible shared view: 1 = pickable, 0 = down (length >= capacity).
     * @param inflight per-endpoint in-flight counts (length >= capacity), caller-owned, read-only.
     * @param seed deterministic PRNG seed (default 0x9e3779b9); reproducible benches.
     */
    constructor(capacity: number, eligible: Uint8Array, inflight: Uint32Array, seed?: number);
    /** Pick by power-of-two-choices (lower in-flight of two random eligibles), or `PICK_NONE`. */
    pick(): number;
    /** Snapshot: plus the total in flight. */
    describe(): BalancerDescription & { strategy: 'P2C'; inflight: number };
}

/**
 * LeastConnBalancer -- EXACT fewest-in-flight (M4, IPVS `lc`). A full O(cap) scan of the
 * caller-owned in-flight view returning the eligible node with the lowest count -- the deterministic
 * complement to P2C's O(1) approximation. Ties ROTATE (1.1.0): a cursor moves past each pick, so tied
 * nodes take turns (1.0.x gave every tie to the lowest index -- at low load one node took all traffic);
 * do not depend on WHICH tied node wins. In-flight counts are
 * caller-owned and read LIVE (no `setWeight`, no derived aggregate). 0 B/op. Fails closed
 * (`PICK_NONE`) when the whole pool is down.
 */
export class LeastConnBalancer extends BalancerBase {
    /**
     * @param capacity endpoint count (fixed).
     * @param eligible shared view: 1 = pickable, 0 = down (length >= capacity).
     * @param inflight per-endpoint in-flight counts (length >= capacity), caller-owned, read live.
     */
    constructor(capacity: number, eligible: Uint8Array, inflight: Uint32Array);
    /** The eligible node with the fewest in-flight requests, or `PICK_NONE`. O(cap). */
    pick(): number;
    /** Snapshot: plus the total in flight and the tie cursor. */
    describe(): BalancerDescription & { strategy: 'LeastConn'; inflight: number; tieCursor: number };
}

/**
 * SedBalancer -- shortest-expected-delay (M4, IPVS `sed`). Returns the eligible, positive-weight
 * node minimizing `(inflight + 1) / weight`; converges to load proportional-to-weight. BOTH
 * inflight and weights are caller-owned Uint32Arrays, read LIVE (no `setWeight`, no derived
 * aggregate). A weight-0 eligible node is not a candidate. Ties among equal scores rotate (1.1.0).
 * O(cap), 0 B/op. Fails closed (`PICK_NONE`) when no eligible node has a positive weight.
 */
export class SedBalancer extends BalancerBase {
    /**
     * @param capacity endpoint count (fixed).
     * @param eligible shared view: 1 = pickable, 0 = down (length >= capacity).
     * @param inflight per-endpoint in-flight counts (length >= capacity), caller-owned, read live.
     * @param weights per-endpoint weights (length >= capacity), caller-owned, read live.
     */
    constructor(capacity: number, eligible: Uint8Array, inflight: Uint32Array, weights: Uint32Array);
    /** The eligible node minimizing (inflight+1)/weight, or `PICK_NONE`. O(cap). */
    pick(): number;
    /** Snapshot: plus the total in flight, the weights (a copy) and the tie cursor. */
    describe(): BalancerDescription & { strategy: 'SED'; inflight: number; weights: number[]; tieCursor: number };
}

/**
 * NqBalancer -- never-queue (M4, IPVS `nq`). Returns an idle eligible positive-weight node
 * (in-flight 0) if one exists -- idle nodes take turns (1.1.0 rotating cursor) -- else the SED minimum
 * (ties rotate) -- the worker-pool fit. BOTH inflight and weights are caller-owned, read LIVE. O(cap)
 * worst case, 0 B/op. Fails closed (`PICK_NONE`) when no eligible node has a positive weight.
 */
export class NqBalancer extends BalancerBase {
    /**
     * @param capacity endpoint count (fixed).
     * @param eligible shared view: 1 = pickable, 0 = down (length >= capacity).
     * @param inflight per-endpoint in-flight counts (length >= capacity), caller-owned, read live.
     * @param weights per-endpoint weights (length >= capacity), caller-owned, read live.
     */
    constructor(capacity: number, eligible: Uint8Array, inflight: Uint32Array, weights: Uint32Array);
    /** The first idle eligible node, else the SED minimum, or `PICK_NONE`. O(cap). */
    pick(): number;
    /** Snapshot: plus the total in flight, the weights (a copy) and the tie cursor. */
    describe(): BalancerDescription & { strategy: 'NQ'; inflight: number; weights: number[]; tieCursor: number };
}

/**
 * PeakEwmaBalancer -- latency-aware power-of-two-choices (M7, Twitter Finagle's peak-EWMA).
 * Draws two distinct eligible endpoints and returns the LOWER COST (three cases: unsampled+idle -> 0;
 * unsampled+busy -> `(inflight + 1) x decaying pool mean`; sampled -> `(inflight + 1) x max(decayedEWMA,
 * dt-while-busy)`); a slow endpoint (high decayed EWMA rtt) is avoided even with a short queue,
 * and a hung node grows more expensive over time. `inflight` is the
 * caller-owned Uint32Array read LIVE; the EWMA state (`_ewma` / `_stamp`, Float64) is BALANCER-OWNED
 * and written ONLY by `recordRtt` (the warm feedback path). `pick(now)` decays on READ -- never
 * writes -- so it is 0 B/op, as is `recordRtt`. `now` / `sampleNs` are caller-supplied nanoseconds.
 * Cold start: an unsampled node costs 0 WHILE IDLE (graceful least-connections) and the pool's
 * DECAYING mean sampled rtt ONCE BUSY (1.1.0: every sample weighted by exp(-age/tau), so it follows a
 * latency-regime change), so a fast-failing or hung node cannot masquerade as a 1.0 ns node and become
 * a black hole; a hung node's busy floor grows with `dt` so it gets more expensive, not less. The
 * update is Finagle's (1.1.0): a sample above the stored estimate replaces it, else
 * `ewma x w + sample x (1 - w)`, `w = exp(-dt/tau)`. Never NaN. O(d)=O(1). Fails closed
 * (`PICK_NONE`) when the whole pool is down. A request that never returns is handled by a per-attempt
 * timeout (the attempt throws; /pool records `max(elapsed, failurePenaltyNs)`), not by the kernel.
 * Latency-aware: @zakkster/lite-pick/pool REQUIRES an `opts.clock` for this strategy.
 */
export class PeakEwmaBalancer extends BalancerBase {
    /** Marker: latency-aware; /pool requires `opts.clock` and feeds recordRtt() from it. */
    static readonly LATENCY: true;
    /**
     * @param capacity endpoint count (fixed).
     * @param eligible shared view: 1 = pickable, 0 = down (length >= capacity).
     * @param inflight per-endpoint in-flight counts (length >= capacity), caller-owned, read live.
     * @param tauNs the EWMA TIME CONSTANT in nanoseconds (finite, > 0); the half-life is tauNs x ln2.
     * @param seed deterministic PRNG seed (default 0x9e3779b9); reproducible benches.
     */
    constructor(capacity: number, eligible: Uint8Array, inflight: Uint32Array, tauNs: number, seed?: number);
    /** The decayed EWMA rtt estimate for endpoint `i` at time `now` (ns). Pure read, zero-alloc. */
    ewmaAt(i: number, now: number): number;
    /**
     * Warm feedback path: record an rtt sample (ns) for endpoint `i` at time `now` (ns). The first sample
     * sets the estimate exactly; then a larger sample replaces it, a smaller one blends in as
     * `ewma x w + sample x (1 - w)` (Finagle, 1.1.0). Also feeds the decaying pool mean. 0 B/op.
     */
    recordRtt(i: number, sampleNs: number, now: number): void;
    /** Pick by latency-aware power-of-two-choices at time `now` (ns), or `PICK_NONE`. O(d)=O(1). */
    pick(now: number): number;
    /** Snapshot: plus tau, the total in flight, the sampled-node count and the decaying pool mean (null before any sample). */
    describe(): BalancerDescription & {
        strategy: 'PeakEWMA'; tauNs: number; inflight: number; sampled: number; poolMeanNs: number | null;
    };
}

/** The default Maglev lookup-table size (a prime, 2^16 + 1). Configurable via the ctor. */
export const CH_DEFAULT_M: number;

/** The bounded forward-probe limit ConsistentHash walks past down slots (fail-closed). */
export const CH_PROBE_LIMIT: number;

/**
 * ConsistentHashBalancer -- sticky / cache-affinity routing via a prebuilt MAGLEV lookup table
 * (M8, IPVS `mh` / Meta Katran / Cilium). `pick(keyHash)` maps a caller-supplied INTEGER key to a
 * fixed backend (slot = keyHash % M, a table read, and a bounded forward-probe past down slots) --
 * O(1), 0 B/op. The key is a caller-supplied integer (coerced `>>> 0`; NaN -> 0), never a per-pick
 * string hash (the one zero-GC hazard -- hash string keys yourself, cold). The balancer OWNS the
 * lookup table (M x 4 bytes; the 65537 default is ~256KB, a COLD one-time allocation) and an internal
 * weights array; `setWeight` / `rebuild` rebuild the table (COLD). A health flap is absorbed by the
 * probe -- never a rebuild -- so removing a backend (`setEligible(i, false)`) remaps only ~1/N keys.
 * Fails closed (`PICK_NONE`) only when no eligible backend owns a table slot: past the 64-slot probe window
 * a cold O(M) sweep finds a far eligible backend (1.1.0; 1.0.x returned `PICK_NONE` there).
 */
export class ConsistentHashBalancer extends BalancerBase {
    /** Marker: keyed; /pool requires a numeric `opts.key`. Inherited by BoundedLoadBalancer. */
    static readonly KEYED: true;
    /**
     * @param capacity backend count (fixed).
     * @param eligible shared view: 1 = pickable, 0 = down (length >= capacity).
     * @param weights optional per-backend weights (length >= capacity), COPIED at construction;
     *   null = equal weight.
     * @param m the Maglev table size: a prime, > 1, and >= capacity (default 65537).
     * @param seed deterministic salt for the permutation mix (default 0x9e3779b9); reproducible.
     */
    constructor(capacity: number, eligible: Uint8Array, weights?: Uint32Array | null, m?: number, seed?: number);
    /** The Maglev table size M (prime). */
    readonly tableSize: number;
    /** Cold path: reconfigure backend `i`'s weight (uint32) and rebuild the table. */
    setWeight(i: number, w: number): void;
    /**
     * Cold path (1.1.0): replace ALL weights (copied, length >= capacity) and rebuild the table ONCE --
     * the batch form of `setWeight`. Validated before any write; throws RangeError on a bad array.
     */
    setWeights(weights: Uint32Array): void;
    /** Cold path: rebuild the lookup table from the current owned weights. */
    rebuild(): void;
    /**
     * Map an integer `keyHash` to a backend index (bounded probe past down slots, then a cold full-table
     * sweep -- 1.1.0), or `PICK_NONE` only when no eligible backend owns a table slot.
     */
    pick(keyHash: number): number;
    /** Snapshot: plus the table size M and the weights (a copy). */
    describe(): BalancerDescription & { strategy: 'ConsistentHash' | 'BoundedLoad'; tableSize: number; weights: number[] };
}

/**
 * BoundedLoadBalancer -- Consistent Hashing with Bounded Loads (M9, CHBL: Mirrokni et al. / Google
 * Research; Vimeo eps ~ 0.25). `ConsistentHashBalancer` (the Maglev table) PLUS an occupancy cap: a
 * key sticks to its hashed home backend UNLESS that backend is over
 * `cap = ceil((1 + eps) * (total + 1) / live)` -- the load-bearing part is the `+ 1` that counts the
 * INCOMING request (Mirrokni-Thorup-Zadimoghaddam per-bin capacity), so the cap is always >= 1 and a
 * second concurrent same-key request correctly overflows the home. In that case the request OVERFLOWS
 * along the same bounded forward-probe to the next eligible,
 * under-cap backend -- keeping consistent hashing's stickiness + minimal disruption AND adding the
 * HOTSPOT protection plain consistent hashing lacks. `pick(keyHash)` returns the first eligible,
 * under-cap backend in the probe window, else falls back to the first eligible seen (sticky wins; the
 * cap is a soft preference, never a dead pick); `_total === 0` skips the cap -> pure ConsistentHash.
 * `inflight` is the caller-owned Uint32Array read LIVE as the per-backend OCCUPANCY; the running
 * occupancy sum `_total` is BALANCER-OWNED and written ONLY by `note` (dispatch +1 / settle -1). When
 * using BoundedLoad you update `inflight[i]` AND call `note(i, +/-1)` in LOCKSTEP (or drive it through
 * the /pool adapter, which does both): `note` maintains `_total`, it does not write `inflight`. A
 * direct mutation of `inflight` without the matching `note` desyncs `_total` -- UB. It inherits the Maglev table + `setWeight` /
 * `setWeights` / `rebuild` / `tableSize` from ConsistentHashBalancer (reused verbatim). `pick()` and `note()` are
 * both 0 B/op / O(1). Fails closed (`PICK_NONE`) ONLY when no eligible backend owns a table slot (the
 * 1.1.0 full-table sweep past the probe window) -- NEVER merely because backends are over cap. NOT the P2C-with-cap "overload"
 * variant (that is byte-identical to P2C; the cap is only load-bearing on a sticky hash -- ADR 0011).
 */
export class BoundedLoadBalancer extends ConsistentHashBalancer {
    /**
     * @param capacity backend count (fixed).
     * @param eligible shared view: 1 = pickable, 0 = down (length >= capacity).
     * @param inflight per-backend OCCUPANCY (length >= capacity), caller-owned, read live; mutated
     *   EXCLUSIVELY via `note` / the /pool adapter (direct mutation desyncs `_total` -- UB).
     * @param eps the bounded-load slack over the mean (finite, > 0); default 0.25 (Vimeo).
     * @param weights optional per-backend weights (length >= capacity), COPIED; null = equal weight.
     * @param m the Maglev table size: a prime, > 1, and >= capacity (default 65537).
     * @param seed deterministic salt for the permutation mix (default 0x9e3779b9); reproducible.
     * @param minCap OPT-IN floor on the per-backend cap (1.1.0; default 0 = the paper's capacity):
     *   cap = max(minCap, ceil((1+eps)(T+1)/live)). At low load the paper's cap is 1, so a second
     *   concurrent request for the same key leaves its home; minCap = k keeps up to k at home, at the
     *   price of a looser bound while the pool is nearly idle. Integer in [0, 2^32 - 1].
     */
    constructor(
        capacity: number,
        eligible: Uint8Array,
        inflight: Uint32Array,
        eps?: number,
        weights?: Uint32Array | null,
        m?: number,
        seed?: number,
        minCap?: number,
    );
    /** The balancer-owned running sum of in-flight the mean/cap is computed from. */
    readonly totalInflight: number;
    /** The opt-in cap floor set at construction (1.1.0); 0 = the paper's capacity. */
    readonly minCap: number;
    /**
     * Warm feedback path: adjust the owned occupancy SUM by `delta` (dispatch +1 / settle -1), in
     * LOCKSTEP with the caller's `inflight[i]` write. Maintains `_total`; does NOT write `inflight`.
     * Clamps at 0. 0 B/op.
     */
    note(i: number, delta: number): void;
    /** Map an integer `keyHash` to a backend, honouring the occupancy cap (overflow past a hot home), or `PICK_NONE`. O(1). */
    pick(keyHash: number): number;
    /** Snapshot: the ConsistentHash fields plus eps, minCap, the noted total, the total in flight, and the cap a
     *  pick would use now (null while inactive: nothing noted, or nothing live). */
    describe(): BalancerDescription & {
        strategy: 'BoundedLoad'; tableSize: number; weights: number[];
        eps: number; minCap: number; total: number; inflight: number; cap: number | null;
    };
}

/**
 * WeightedRandomBalancer -- O(1) weighted-random selection via a Vose/Walker ALIAS TABLE (M10). `pick()`
 * draws one column + one probability compare to return an endpoint proportional to its weight, with
 * REJECTION-SAMPLING eligibility (retry an ineligible candidate up to a bounded count, then a 0-B/op
 * rotated linear eligible scan). The alias table is built COLD over the eligible-INDEPENDENT weights
 * (a weight-0 node is NEVER a column), so rejection renormalizes the weight distribution across the
 * surviving eligible mass. `weights` is the caller-owned Uint32Array; the balancer is the SOLE writer of
 * its derived table via cold `setWeight` / `rebuild` (direct weight mutation desyncs the table -- UB).
 * An eligibility flap NEVER rebuilds. The stateless O(1) sample (no accumulators to desync) for VERY
 * LARGE pools where SmoothWRR's O(cap) scan hurts -- trading smoothness for sampling variance. O(1),
 * 0 B/op, never throws. Fails closed (`PICK_NONE`) IFF `live === 0` OR no eligible node has a positive
 * weight. NOT `@zakkster/lite-random` (a game RNG returning an item; use lite-random for loot tables --
 * this is the eligibility-aware LB index selector; see GUIDE.md / ADR 0012).
 */
export class WeightedRandomBalancer extends BalancerBase {
    /**
     * @param capacity endpoint count (fixed).
     * @param eligible shared view: 1 = pickable, 0 = down (length >= capacity).
     * @param weights caller-owned per-endpoint weights (length >= capacity); mutate only via setWeight
     *   (the balancer is the sole writer of the derived alias table -- direct mutation is UB).
     * @param seed deterministic PRNG seed (default 0x9e3779b9); reproducible benches.
     */
    constructor(capacity: number, eligible: Uint8Array, weights: Uint32Array, seed?: number);
    /** Cold path: reconfigure endpoint `i`'s weight (uint32) and rebuild the alias table. */
    setWeight(i: number, w: number): void;
    /**
     * Cold path (1.1.0): replace ALL weights (copied into the weights array this balancer was built with,
     * length >= capacity) and rebuild the alias table ONCE. Validated before any write.
     */
    setWeights(weights: Uint32Array): void;
    /** Cold path: rebuild the alias table from the current caller weights (e.g. after a membership change). */
    rebuild(): void;
    /** Pick an endpoint index proportional to weight (eligibility by rejection sampling), or `PICK_NONE`. O(1). */
    pick(): number;
    /** Snapshot: plus the weights (a copy) and the weight sum the alias table was built on. */
    describe(): BalancerDescription & { strategy: 'WeightedRandom'; weights: number[]; weightSum: number };
}
