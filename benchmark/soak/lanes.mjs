/**
 * @zakkster/lite-pick soak -- lane roster + reused invariant wiring (audit 1.6 tiny pools).
 *
 * KERNEL_LANES: the ten strategy lanes at CAP=256. Their `massKind` map was copied VERBATIM from the
 * original benchmark/Soak.mjs (golden-checked against `git show HEAD:benchmark/Soak.mjs` at the
 * redesign; that file is now retired -- ADR 0014) so the fail-closed IFF each pick()'s exact PICK_NONE
 * condition is preserved. TINY_LANES: the same ten strategies at cap in {1,2,3} (picked by
 * cycle%3), which exercise the _live===1 shortcut, the P2C redraw loop and the ConsistentHash
 * probe on degenerate pools -- report-only throughput/latency gates.
 *
 * massOf / checkLane REUSE the imported checkers from test/invariants.mjs; they are not
 * reimplemented here. COLD module: lane build + invariant checks run on the boundary, never hot.
 */

import {
    RoundRobinBalancer, SmoothWRRBalancer, P2cBalancer, LeastConnBalancer, SedBalancer,
    NqBalancer, PeakEwmaBalancer, ConsistentHashBalancer, BoundedLoadBalancer, WeightedRandomBalancer,
    PICK_NONE, CH_PROBE_LIMIT,
} from './kernel.mjs';
import {
    checkBase, checkConsistentHash, reachableWithinBound, checkBoundedLoad, checkWeightedRandom,
    recomputeLive, recomputeEligibleWeight, recomputeEligibleWeighted, allFinite,
} from '../../test/invariants.mjs';

export const CAP = 256;
export const MASK = CAP - 1;          // pow2 modulo mask for the hot loop
export const M_CH = 4099;             // Maglev table size for keyed lanes: the smallest prime >= 16 x CAP (S14)
export const TINY_CAPS = [1, 2, 3];   // cap = TINY_CAPS[cycle % 3]
const M_TINY = 17;                    // small prime Maglev table for the tiny keyed lanes

// Key stream: a pre-filled Uint32Array masked to 30 bits (SMI-safe hashes), power-of-2 length so
// the hot keyed step indexes with a bitmask. Filled once at module init (cold).
export const KEY_COUNT = 4096;
export const KEY_MASK = KEY_COUNT - 1;
export const KEYS = new Uint32Array(KEY_COUNT);
{
    let h = 0x2545F491 >>> 0;
    for (let i = 0; i < KEY_COUNT; i++) {
        h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h >>>= 0;
        KEYS[i] = h & 0x3FFFFFFF;   // 30-bit mask
    }
}

// Family drives which allocation-free hot step (hot.mjs) runs the lane.
export const FAMILY = Object.freeze({ PLAIN: 'plain', LOAD: 'load', LATENCY: 'latency', KEYED: 'keyed' });

/** Build the eligibility + weight/inflight arrays a lane owns, all sized to `cap`. */
function baseArrays(cap, weighted) {
    const eligible = new Uint8Array(cap).fill(1);
    let weights = null;
    if (weighted) {
        weights = new Uint32Array(cap);
        for (let i = 0; i < cap; i++) weights[i] = 1 + (i & 7);
    }
    return { eligible, weights };
}

// -------------------------------------------------------------------------------------------------
// The lane descriptors. `massKind` is the golden map from the retired Soak.mjs (do not change). `family` selects
// the hot step; the boolean flags mirror the old descriptor. make(seed, cap, m) is cold.
// -------------------------------------------------------------------------------------------------
const DESCRIPTORS = [
    {
        name: 'RoundRobin', family: FAMILY.PLAIN,
        keyed: false, weighted: false, usesSetWeight: false, loadAware: false, notes: false, latency: false,
        massKind: 'live',
        make: (seed, cap) => {
            const { eligible } = baseArrays(cap, false);
            return { b: new RoundRobinBalancer(cap, eligible), eligible, inflight: null, weights: null };
        },
        extra: () => null,
    },
    {
        name: 'SmoothWRR', family: FAMILY.PLAIN,
        keyed: false, weighted: true, usesSetWeight: true, loadAware: false, notes: false, latency: false,
        massKind: 'eligibleWeight',
        make: (seed, cap) => {
            const { eligible, weights } = baseArrays(cap, true);
            return { b: new SmoothWRRBalancer(cap, eligible, weights), eligible, inflight: null, weights };
        },
        extra: (b, ctx) => {
            const want = recomputeEligibleWeight(ctx.eligible, ctx.weights, ctx.cap);
            if (b._totalEligibleWeight !== want) {
                return '_totalEligibleWeight ' + b._totalEligibleWeight + ' != recomputed ' + want;
            }
            if (!allFinite(b._current, ctx.cap)) return '_current has a non-finite accumulator';
            return null;
        },
    },
    {
        name: 'P2C', family: FAMILY.LOAD,
        keyed: false, weighted: false, usesSetWeight: false, loadAware: true, notes: false, latency: false,
        massKind: 'live',
        make: (seed, cap) => {
            const { eligible } = baseArrays(cap, false);
            const inflight = new Uint32Array(cap);
            return { b: new P2cBalancer(cap, eligible, inflight, seed), eligible, inflight, weights: null };
        },
        extra: () => null,
    },
    {
        name: 'LeastConn', family: FAMILY.LOAD,
        keyed: false, weighted: false, usesSetWeight: false, loadAware: true, notes: false, latency: false,
        massKind: 'live',
        make: (seed, cap) => {
            const { eligible } = baseArrays(cap, false);
            const inflight = new Uint32Array(cap);
            return { b: new LeastConnBalancer(cap, eligible, inflight), eligible, inflight, weights: null };
        },
        extra: () => null,
    },
    {
        name: 'SED', family: FAMILY.LOAD,
        keyed: false, weighted: true, usesSetWeight: false, loadAware: true, notes: false, latency: false,
        massKind: 'eligibleWeighted',
        make: (seed, cap) => {
            const { eligible, weights } = baseArrays(cap, true);
            const inflight = new Uint32Array(cap);
            return { b: new SedBalancer(cap, eligible, inflight, weights), eligible, inflight, weights };
        },
        extra: () => null,
    },
    {
        name: 'NQ', family: FAMILY.LOAD,
        keyed: false, weighted: true, usesSetWeight: false, loadAware: true, notes: false, latency: false,
        massKind: 'eligibleWeighted',
        make: (seed, cap) => {
            const { eligible, weights } = baseArrays(cap, true);
            const inflight = new Uint32Array(cap);
            return { b: new NqBalancer(cap, eligible, inflight, weights), eligible, inflight, weights };
        },
        extra: () => null,
    },
    {
        name: 'PeakEWMA', family: FAMILY.LATENCY,
        keyed: false, weighted: false, usesSetWeight: false, loadAware: true, notes: false, latency: true,
        massKind: 'live',
        make: (seed, cap) => {
            const { eligible } = baseArrays(cap, false);
            const inflight = new Uint32Array(cap);
            return { b: new PeakEwmaBalancer(cap, eligible, inflight, 1e6, seed), eligible, inflight, weights: null };
        },
        extra: (b, ctx) => {
            if (!allFinite(b._ewma, ctx.cap)) return '_ewma has a non-finite cell';
            if (!allFinite(b._stamp, ctx.cap)) return '_stamp has a non-finite cell';
            return null;
        },
    },
    {
        name: 'ConsistentHash', family: FAMILY.KEYED,
        keyed: true, weighted: true, usesSetWeight: true, loadAware: false, notes: false, latency: false,
        massKind: 'reachable',
        make: (seed, cap, m) => {
            const { eligible, weights } = baseArrays(cap, true);
            return { b: new ConsistentHashBalancer(cap, eligible, weights, m, seed), eligible, inflight: null, weights };
        },
        extra: (b, ctx) => checkConsistentHash(b, ctx.eligible, ctx.cap, ctx.lastPick),
    },
    {
        name: 'BoundedLoad', family: FAMILY.KEYED,
        keyed: true, weighted: true, usesSetWeight: true, loadAware: true, notes: true, latency: false,
        massKind: 'reachable',
        make: (seed, cap, m) => {
            const { eligible, weights } = baseArrays(cap, true);
            const inflight = new Uint32Array(cap);
            return { b: new BoundedLoadBalancer(cap, eligible, inflight, 0.25, weights, m, seed), eligible, inflight, weights };
        },
        extra: (b, ctx) => checkConsistentHash(b, ctx.eligible, ctx.cap, ctx.lastPick) ||
            checkBoundedLoad(b, ctx.inflight, ctx.cap),
    },
    {
        name: 'WeightedRandom', family: FAMILY.PLAIN,
        keyed: false, weighted: true, usesSetWeight: true, loadAware: false, notes: false, latency: false,
        massKind: 'eligibleWeighted',
        make: (seed, cap) => {
            const { eligible, weights } = baseArrays(cap, true);
            return { b: new WeightedRandomBalancer(cap, eligible, weights, seed), eligible, inflight: null, weights };
        },
        extra: (b, ctx) => checkWeightedRandom(b, ctx.weights, ctx.cap),
    },
];

export const ROSTER = DESCRIPTORS.map((d) => d.name);

/** Kernel lanes: fixed CAP=256, Maglev M=257. */
export const KERNEL_LANES = DESCRIPTORS.map((d) => Object.freeze({
    ...d, cap: CAP, m: M_CH, tier: 'kernel', capOf: () => CAP, mOf: () => M_CH,
}));

/** Tiny lanes: cap cycles through {1,2,3}; report-only. Same strategy descriptors. */
export const TINY_LANES = DESCRIPTORS.map((d) => Object.freeze({
    ...d, tier: 'tiny', capOf: (cycle) => TINY_CAPS[cycle % TINY_CAPS.length], mOf: () => M_TINY,
}));

/** The pickable mass for a lane's fail-closed IFF (matches each pick()'s exact PICK_NONE). */
export function massOf(lane, ctx) {
    switch (lane.massKind) {
        case 'live': return recomputeLive(ctx.eligible, ctx.cap);
        case 'eligibleWeight': return recomputeEligibleWeight(ctx.eligible, ctx.weights, ctx.cap);
        case 'eligibleWeighted': return recomputeEligibleWeighted(ctx.eligible, ctx.weights, ctx.cap);
        case 'reachable': return reachableWithinBound(ctx.b, ctx.eligible, ctx.keyHash, CH_PROBE_LIMIT);
        default: throw new Error('[soak] unknown massKind ' + lane.massKind);
    }
}

/** checkBase (universal) + the lane's strategy-specific extra invariant. Returns null or a reason. */
export function checkLane(lane, ctx) {
    const mass = massOf(lane, ctx);
    const base = checkBase(ctx.b, ctx.eligible, ctx.cap, ctx.lastPick, mass);
    if (base !== null) return base;
    return lane.extra(ctx.b, ctx);
}

export { PICK_NONE, CH_PROBE_LIMIT };
