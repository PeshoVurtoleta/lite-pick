/**
 * @zakkster/lite-pick soak -- per lane+cycle seed derivation (audit RECOMMENDATIONS 1.11).
 *
 * The old harness mixed `lane.name.length` into the chaos seed, so lanes whose names share a
 * length (P2C/SED, SmoothWRR/LeastConn, ConsistentHash/WeightedRandom) drew IDENTICAL chaos
 * streams every cycle. This derives the seed from the lane INDEX instead, via murmur3's fmix32
 * avalanche mixer -- a BIJECTION on uint32, so distinct 32-bit inputs give distinct 32-bit
 * outputs. We encode (laneIndex, cycle) into a distinct input, so distinct (lane,cycle) pairs
 * get distinct seeds by construction (proven by selfCheckSeeds at startup).
 *
 * COLD module: seeds are drawn once per lane-cycle on the boundary, never on the hot path.
 */

/** murmur3 fmix32 finalizer -- a bijective avalanche mix over uint32. */
export function fmix32(h) {
    h >>>= 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

// laneIndex is < 16 (roster is 10), so `(cycle << 4) | laneIndex` is injective over
// (laneIndex, cycle) while laneIndex stays in [0, 16). XOR with the run base is a bijection,
// and fmix32 is a bijection, so the composition is injective in (laneIndex, cycle) for a base.
const LANE_BITS = 4;
const LANE_MASK = (1 << LANE_BITS) - 1;
const REMAP = 0x9e3779b9;   // seed 0 -> the default (xorshift stuck at 0 stays 0)

/**
 * The seed for (base, laneIndex, cycle). Pure. Seed 0 is remapped so a downstream xorshift
 * PRNG never starts dead.
 */
export function seedFor(base, laneIndex, cycle) {
    const input = ((base >>> 0) ^ (((cycle << LANE_BITS) | (laneIndex & LANE_MASK)) >>> 0)) >>> 0;
    const s = fmix32(input);
    return s === 0 ? REMAP : s;
}

/** A human-readable description of the seed formula, for the provenance header. */
export const SEED_FORMULA =
    'fmix32((base ^ ((cycle << 4) | laneIndex)) >>> 0); seed 0 -> 0x9e3779b9';

/**
 * Startup self-check (audit 1.11): every (laneIndex, cycle) seed must be DISTINCT across the
 * roster for cycles 0..1023. Returns null on success, or a collision description string.
 * O(laneCount * 1024) with a Set -- cold, runs once.
 */
export function selfCheckSeeds(base, laneCount, cycleSpan) {
    const span = cycleSpan === undefined ? 1024 : cycleSpan;
    const seen = new Map();
    for (let cy = 0; cy < span; cy++) {
        for (let li = 0; li < laneCount; li++) {
            const s = seedFor(base, li, cy);
            const prev = seen.get(s);
            if (prev !== undefined) {
                return 'seed collision 0x' + s.toString(16) + ' at (lane ' + li + ', cycle ' + cy +
                    ') and (lane ' + (prev & LANE_MASK) + ', cycle ' + (prev >>> LANE_BITS) + ')';
            }
            seen.set(s, ((cy << LANE_BITS) | li) >>> 0);
        }
    }
    return null;
}
