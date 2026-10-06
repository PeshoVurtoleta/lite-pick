/**
 * @zakkster/lite-pick -- deterministic golden-STREAM programs for StreamParity.test.js.
 *
 * NOT a *.test.js file: a library. `fingerprints(mod)` runs a FIXED, seeded program over every
 * exported strategy and folds the observable output -- the pick() stream, PeakEWMA's `_ewma`/`_samp`
 * Float64 state, the ConsistentHash / BoundedLoad lookup table -- into an FNV-1a-32 digest per
 * program. A bit for bit behaviour change (a desynced eligible-weight sum, a stale alias table, a
 * non-bit-exact decay rewrite) moves a digest; an invariant-preserving refactor does not.
 *
 * The caller passes the MODULE NAMESPACE (`import * as mod from '../Pick.js'`), so the SAME program
 * runs against the shipped kernel and against a HEAD / mutant copy for the revert-check. Pure: the
 * function allocates its own scratch, reads no global state, never mutates its argument's exports.
 *
 * FNV-1a-32 (Fowler-Noll-Vo): offset 0x811c9dc5, prime 0x01000193, per byte. Doubles fold their two
 * 32-bit halves (big-endian via a DataView), so -0, NaN payloads and every mantissa bit are observed.
 * Picks fold as uint32 (PICK_NONE = -1 -> 0xffffffff), a distinct, stable symbol.
 */

const FNV_PRIME = 0x01000193;
const INIT = 0x811c9dc5 >>> 0;
const _dv = new DataView(new ArrayBuffer(8));

function fByte(h, b) { h ^= (b & 0xff); return Math.imul(h, FNV_PRIME) >>> 0; }
function fU32(h, v) { v >>>= 0; h = fByte(h, v); h = fByte(h, v >>> 8); h = fByte(h, v >>> 16); return fByte(h, v >>> 24); }
function fF64(h, x) { _dv.setFloat64(0, x); h = fU32(h, _dv.getUint32(0)); return fU32(h, _dv.getUint32(4)); }
function hex(h) { return (h >>> 0).toString(16).padStart(8, '0'); }

/**
 * A control PRNG for the PROGRAM (flaps / weights / keys) -- never the balancer's own PRNG. An LCG
 * step followed by an output scramble, because a bare LCG's LOW bits alternate (so `rnd() & 1` with two
 * draws per step would pin a flap's direction to a constant and nothing would ever go down). The
 * scramble (a MurmurHash3-style finalizer) mixes every bit so `& 1` and `% n` are both usable.
 */
function lcg(seed) {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        let x = s ^ (s >>> 15);
        x = Math.imul(x, 0x2c1b3c6d) >>> 0;
        x ^= x >>> 12;
        return x >>> 0;
    };
}

function upArr(n) { const e = new Uint8Array(n); e.fill(1); return e; }
function rampWeights(n, rnd) { const w = new Uint32Array(n); for (let i = 0; i < n; i++) w[i] = 1 + (rnd() % 8); return w; }

/** RoundRobin: pick stream across eligibility flaps (no weights). */
function rr(mod) {
    const n = 64, el = upArr(n), rnd = lcg(0x1111);
    const b = new mod.RoundRobinBalancer(n, el);
    let h = INIT;
    for (let k = 0; k < 4000; k++) {
        if ((k & 7) === 0) b.setEligible(rnd() % n, (rnd() & 1) === 0);
        h = fU32(h, b.pick());
    }
    return hex(h);
}

/** SmoothWRR: pick stream across flaps + occasional setWeight (this strategy has no setWeights / rebuild). */
function smoothwrr(mod) {
    const n = 48, el = upArr(n), rnd = lcg(0x2222);
    const weights = rampWeights(n, rnd);
    const b = new mod.SmoothWRRBalancer(n, el, weights);
    let h = INIT;
    for (let k = 0; k < 4000; k++) {
        if ((k & 7) === 0) b.setEligible(rnd() % n, (rnd() & 1) === 0);
        if ((k % 500) === 499) b.setWeight(rnd() % n, 1 + (rnd() % 16));
        h = fU32(h, b.pick());
    }
    return hex(h);
}

/** A load-reading strategy (P2C / LeastConn / SED / NQ): flaps + a churning caller inflight array. */
function loadStream(mod, Ctor, withWeights) {
    const n = 48, el = upArr(n), rnd = lcg(0x3333);
    const inflight = new Uint32Array(n);
    const weights = rampWeights(n, lcg(0x4444));
    const b = withWeights ? new Ctor(n, el, inflight, weights) : new Ctor(n, el, inflight);
    let h = INIT;
    for (let k = 0; k < 4000; k++) {
        if ((k & 7) === 0) b.setEligible(rnd() % n, (rnd() & 1) === 0);
        const j = rnd() % n;
        inflight[j] = rnd() % 32;                 // caller mutates in-flight (read-only to pick)
        h = fU32(h, b.pick());
    }
    return hex(h);
}

/**
 * PeakEWMA: fold `_ewma[0..n)` + `_samp[0..3)` + the `pick(now)` selection AFTER each recordRtt, over
 * five clock regimes that exercise the pool-decay block and the node-blend arm (K1): the same node
 * back-to-back, interleaved nodes, a batch sharing one `now`, a non-monotonic clock, and a FRACTIONAL
 * hrtime-scale (~1.7e15) clock. The fracClock mode advances by quarter-integer steps that stay exactly
 * representable at 1.7e15 (ULP 0.25), so `dt` and `pdt` are FRACTIONAL -- that is what separates
 * `exp(-x / tau)` from the non-bit-exact `exp(-x * (1 / tau))` rewrite (integer steps alias the two).
 */
function peakMode(mod, mode) {
    const n = 16, el = upArr(n), inflight = new Uint32Array(n);
    const b = new mod.PeakEwmaBalancer(n, el, inflight, 1e6, 0x2222);
    const rnd = lcg(0x5555);
    let h = INIT, now = mode === 'fracClock' ? 1.7e15 : 1e9;
    for (let k = 0; k < 2000; k++) {
        const i = mode === 'backToBack' ? 5 : (rnd() % n);
        const sample = (rnd() % 1000) + (rnd() % 100) / 100;   // fractional sample
        if (mode === 'batchOneNow') { if ((k % 8) === 0) now += 1000 + (rnd() % 1000); }
        else if (mode === 'backwardsClock') now += ((rnd() & 3) === 0) ? -(rnd() % 500) : (rnd() % 1000);
        else if (mode === 'fracClock') now += 1000 + (rnd() % 4096) + (rnd() % 4) * 0.25;   // quarter-integer pdt
        else now += 100 + (rnd() % 1000);
        b.recordRtt(i, sample, now);
        for (let j = 0; j < n; j++) h = fF64(h, b._ewma[j]);
        h = fF64(h, b._samp[0]); h = fF64(h, b._samp[1]); h = fF64(h, b._samp[2]);
        h = fU32(h, b.pick(now));                                // fold the selection stream (pure read)
    }
    return hex(h);
}

/** ConsistentHash: fold the lookup table after a setWeights batch, then a keyed pick stream. */
function consistenthash(mod) {
    const n = 16, m = 131, el = upArr(n), rnd = lcg(0x6666);
    const b = new mod.ConsistentHashBalancer(n, el, rampWeights(n, lcg(0x7777)), m, 0x1234abcd);
    let h = INIT;
    b.setWeights(rampWeights(n, lcg(0x8888)));
    for (let s = 0; s < m; s++) h = fU32(h, b._lookup[s]);
    for (let k = 0; k < 4000; k++) {
        if ((k & 7) === 0) b.setEligible(rnd() % n, (rnd() & 1) === 0);
        h = fU32(h, b.pick(rnd()));
    }
    return hex(h);
}

/** BoundedLoad: the CH table + a keyed pick stream with note() driving occupancy. */
function boundedload(mod) {
    const n = 16, m = 131, el = upArr(n), rnd = lcg(0x9999);
    const inflight = new Uint32Array(n);
    const b = new mod.BoundedLoadBalancer(n, el, inflight, 0.25, rampWeights(n, lcg(0xaaaa)), m, 0x1234abcd);
    let h = INIT;
    b.setWeights(rampWeights(n, lcg(0xbbbb)));
    for (let s = 0; s < m; s++) h = fU32(h, b._lookup[s]);
    for (let k = 0; k < 4000; k++) {
        if ((k & 7) === 0) b.setEligible(rnd() % n, (rnd() & 1) === 0);
        const p = b.pick(rnd());
        h = fU32(h, p);
        if (p >= 0) { inflight[p]++; b.note(p, 1); }
        if ((k & 3) === 0) { const q = rnd() % n; if (inflight[q] > 0) { inflight[q]--; b.note(q, -1); } }
    }
    return hex(h);
}

/**
 * WeightedRandom, DENSE: pick stream over flaps + setWeight + a non-overlapping setWeights batch + a bare
 * rebuild() (fast alias path). The setWeights array is a FRESH Uint32Array (never a view of the balancer's
 * own weights), so the K5 copy `_weights.set(weights.subarray(0, cap))` is exercised with values that differ
 * at index 0 and at cap-1 -- a `_weights[0] ^= 1` after the set, or a `.subarray(0, cap-1)` that drops the
 * last element, rebuilds a different alias table and moves this digest.
 */
function weightedrandom(mod) {
    const n = 64, el = upArr(n), rnd = lcg(0xcccc);
    const weights = rampWeights(n, lcg(0xdddd));
    const b = new mod.WeightedRandomBalancer(n, el, weights, 0xC0FFEE);
    const sw = lcg(0xabcd);
    let h = INIT;
    for (let k = 0; k < 4000; k++) {
        if ((k & 7) === 0) b.setEligible(rnd() % n, (rnd() & 1) === 0);
        if ((k % 500) === 499) b.setWeight(rnd() % n, rnd() % 32);
        if ((k % 900) === 899) b.setWeights(rampWeights(n, sw));   // K5: non-overlapping batch copy + rebuild
        if ((k % 1300) === 1299) b.rebuild();
        h = fU32(h, b.pick());
    }
    return hex(h);
}

/**
 * WeightedRandom, SPARSE: cap 2048 with a SMALL eligible set (~a dozen of 2048), so the 64-try
 * rejection loop mostly exhausts and pick() reaches `_sparsePick` -- the fallback whose eligible-weight
 * sum is the cache `_ew` maintains across setEligible (K2). A FIXED anchor set is always up (live is
 * never 0, so the fallback always has a target and really runs), while a larger TOGGLE set flaps every
 * few steps -- so `_ew` drifts from the last rebuild and a stale / off-by-one `_ew` scales the fallback's
 * uniform differently, yielding a different index and moving this digest. Reweights, a non-overlapping
 * setWeights batch, and a bare rebuild() land between flaps (so `_ew` is recomputed mid-stream too).
 */
function weightedrandomSparse(mod) {
    const n = 2048, rnd = lcg(0xeeee);
    const anchors = [7, 311, 900, 1500, 2001, 42];           // always up: live >= 6, fallback always fires
    const toggles = [];
    for (let i = 0; i < 24; i++) toggles.push(((i * 83) + 11) % n);   // 24 spread indices that flap
    const el = new Uint8Array(n);
    for (const i of anchors) el[i] = 1;
    for (const i of toggles) el[i] = 1;
    const weights = rampWeights(n, lcg(0xffff));
    const b = new mod.WeightedRandomBalancer(n, el, weights, 0xFACEFEED);
    const sw = lcg(0xdcba);
    let h = INIT;
    for (let k = 0; k < 8000; k++) {
        if ((k % 3) === 0) b.setEligible(toggles[rnd() % toggles.length], (rnd() & 1) === 0);
        if ((k % 1500) === 1499) b.setWeight(toggles[rnd() % toggles.length], 1 + (rnd() % 20));
        if ((k % 2000) === 1999) b.setWeights(rampWeights(n, sw));   // K5: non-overlapping batch copy + rebuild
        if ((k % 2600) === 2599) b.rebuild();
        h = fU32(h, b.pick());
    }
    return hex(h);
}

/**
 * Run every program against the passed module namespace. Returns a frozen { program: digest } map.
 * @param {object} mod  the Pick.js module namespace (all exported classes).
 * @returns {Object<string,string>}
 */
export function fingerprints(mod) {
    return Object.freeze({
        roundrobin: rr(mod),
        smoothwrr: smoothwrr(mod),
        p2c: loadStream(mod, mod.P2cBalancer, false),
        leastconn: loadStream(mod, mod.LeastConnBalancer, false),
        sed: loadStream(mod, mod.SedBalancer, true),
        nq: loadStream(mod, mod.NqBalancer, true),
        'peakewma.backToBack': peakMode(mod, 'backToBack'),
        'peakewma.interleaved': peakMode(mod, 'interleaved'),
        'peakewma.batchOneNow': peakMode(mod, 'batchOneNow'),
        'peakewma.backwardsClock': peakMode(mod, 'backwardsClock'),
        'peakewma.fracClock': peakMode(mod, 'fracClock'),
        consistenthash: consistenthash(mod),
        boundedload: boundedload(mod),
        weightedrandom: weightedrandom(mod),
        'weightedrandom.sparse': weightedrandomSparse(mod),
    });
}
