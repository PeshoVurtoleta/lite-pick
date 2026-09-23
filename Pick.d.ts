/**
 * @zakkster/lite-pick -- TypeScript declarations.
 *
 * M9 (0.9.0): substrate seams + RoundRobin + SmoothWRR + P2C + the exact LeastConn family
 * (LeastConn/SED/NQ) + PeakEWMA (latency-aware P2C) + ConsistentHash (Maglev table) +
 * BoundedLoad (P2C with a dynamic occupancy cap). The remaining strategy class (WeightedRandom)
 * is added one per session.
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
}

/**
 * LeastConnBalancer -- EXACT fewest-in-flight (M4, IPVS `lc`). A full O(cap) scan of the
 * caller-owned in-flight view returning the eligible node with the lowest count (lowest index
 * on a tie) -- the deterministic complement to P2C's O(1) approximation. In-flight counts are
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
}

/**
 * SedBalancer -- shortest-expected-delay (M4, IPVS `sed`). Returns the eligible, positive-weight
 * node minimizing `(inflight + 1) / weight`; converges to load proportional-to-weight. BOTH
 * inflight and weights are caller-owned Uint32Arrays, read LIVE (no `setWeight`, no derived
 * aggregate). A weight-0 eligible node is not a candidate. O(cap), 0 B/op. Fails closed
 * (`PICK_NONE`) when no eligible node has a positive weight.
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
}

/**
 * NqBalancer -- never-queue (M4, IPVS `nq`). Returns the first idle eligible positive-weight
 * node (in-flight 0) if one exists, else the SED minimum -- the worker-pool fit. BOTH inflight
 * and weights are caller-owned, read LIVE. O(cap) worst case, O(1) when an early node is idle,
 * 0 B/op. Fails closed (`PICK_NONE`) when no eligible node has a positive weight.
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
}

/**
 * PeakEwmaBalancer -- latency-aware power-of-two-choices (M7, Twitter Finagle's peak-EWMA).
 * Draws two distinct eligible endpoints and returns the lower cost = `(inflight + 1) * ewmaAt(now)`;
 * a slow endpoint (high decayed EWMA rtt) is avoided even with a short queue. `inflight` is the
 * caller-owned Uint32Array read LIVE; the EWMA state (`_ewma` / `_stamp`, Float64) is BALANCER-OWNED
 * and written ONLY by `recordRtt` (the warm feedback path). `pick(now)` decays on READ -- never
 * writes -- so it is 0 B/op, as is `recordRtt`. `now` / `sampleNs` are caller-supplied nanoseconds.
 * Cold start seeds the EWMA to 1.0 -> graceful least-connections, never NaN. O(d)=O(1). Fails
 * closed (`PICK_NONE`) when the whole pool is down.
 */
export class PeakEwmaBalancer extends BalancerBase {
    /**
     * @param capacity endpoint count (fixed).
     * @param eligible shared view: 1 = pickable, 0 = down (length >= capacity).
     * @param inflight per-endpoint in-flight counts (length >= capacity), caller-owned, read live.
     * @param tauNs the EWMA time-constant / half-life in nanoseconds (finite, > 0).
     * @param seed deterministic PRNG seed (default 0x9e3779b9); reproducible benches.
     */
    constructor(capacity: number, eligible: Uint8Array, inflight: Uint32Array, tauNs: number, seed?: number);
    /** The decayed EWMA rtt estimate for endpoint `i` at time `now` (ns). Pure read, zero-alloc. */
    ewmaAt(i: number, now: number): number;
    /** Warm feedback path: record an rtt sample (ns) for endpoint `i` at time `now` (ns). 0 B/op. */
    recordRtt(i: number, sampleNs: number, now: number): void;
    /** Pick by latency-aware power-of-two-choices at time `now` (ns), or `PICK_NONE`. O(d)=O(1). */
    pick(now?: number): number;
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
 * Fails closed (`PICK_NONE`) when the pool is down or no eligible backend is reachable within the bound.
 */
export class ConsistentHashBalancer extends BalancerBase {
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
    /** Cold path: rebuild the lookup table from the current owned weights. */
    rebuild(): void;
    /** Map an integer `keyHash` to a backend index (bounded probe past down slots), or `PICK_NONE`. */
    pick(keyHash?: number): number;
}

/**
 * BoundedLoadBalancer -- Consistent Hashing with Bounded Loads (M9, CHBL: Mirrokni et al. / Google
 * Research; Vimeo eps ~ 0.25). `ConsistentHashBalancer` (the Maglev table) PLUS an occupancy cap: a
 * key sticks to its hashed home backend UNLESS that backend is over `cap = (1 + eps) * _total / live`,
 * in which case the request OVERFLOWS along the same bounded forward-probe to the next eligible,
 * under-cap backend -- keeping consistent hashing's stickiness + minimal disruption AND adding the
 * HOTSPOT protection plain consistent hashing lacks. `pick(keyHash)` returns the first eligible,
 * under-cap backend in the probe window, else falls back to the first eligible seen (sticky wins; the
 * cap is a soft preference, never a dead pick); `_total === 0` skips the cap -> pure ConsistentHash.
 * `inflight` is the caller-owned Uint32Array read LIVE as the per-backend OCCUPANCY; the running
 * occupancy sum `_total` is BALANCER-OWNED and written ONLY by `note` (dispatch +1 / settle -1), so
 * when using BoundedLoad the mirrored counter must be mutated exclusively through `note` / the /pool
 * adapter (direct mutation desyncs `_total` -- UB). It inherits the Maglev table + `setWeight` /
 * `rebuild` / `tableSize` from ConsistentHashBalancer (reused verbatim). `pick()` and `note()` are
 * both 0 B/op / O(1). Fails closed (`PICK_NONE`) ONLY when no eligible backend is reachable within
 * the probe window -- NEVER merely because backends are over cap. NOT the P2C-with-cap "overload"
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
     */
    constructor(
        capacity: number,
        eligible: Uint8Array,
        inflight: Uint32Array,
        eps?: number,
        weights?: Uint32Array | null,
        m?: number,
        seed?: number,
    );
    /** The balancer-owned running sum of in-flight the mean/cap is computed from. */
    readonly totalInflight: number;
    /** Warm feedback path: adjust the owned occupancy sum (dispatch +1 / settle -1). Clamps at 0. 0 B/op. */
    note(i: number, delta: number): void;
    /** Map an integer `keyHash` to a backend, honouring the occupancy cap (overflow past a hot home), or `PICK_NONE`. O(1). */
    pick(keyHash?: number): number;
}
