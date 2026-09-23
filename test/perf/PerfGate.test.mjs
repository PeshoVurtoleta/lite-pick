/**
 * @zakkster/lite-pick -- the HARD zero-allocation perf gate (@zakkster/lite-perf-gate).
 *
 * Run:  node --expose-gc --max-semi-space-size=4 --test test/perf/PerfGate.test.mjs
 *
 * A node:test-native COMPLEMENT to torture (0 B/op), not a replacement. M4 gates the
 * SUBSTRATE hot ops every strategy rides -- the deterministic Prng draw (next / nextBelow)
 * and the BalancerBase eligibility read (isEligible) -- AND RoundRobin.pick(), SmoothWRR.pick(),
 * P2C.pick(), LeastConn.pick(), SED.pick(), and NQ.pick(), via scavenge scaling at N and k*N,
 * with the old-gen and external / arrayBuffers lanes pinned to 0. Backing arrays are fixed at
 * construction and NEVER grow, so each scenario's `grows` counter (its backing .buffer.byteLength)
 * shows a 0 delta.
 *
 * Each strategy session (M1+) appends its own reused-instance scenario + its own
 * mustFail teeth-check here (ROADMAP section 3 / accounting site 10).
 *
 * mustFail: a "draw into a fresh []" step that MUST trip the gate (scavenges scale with
 * n), proving the instrument has teeth on the lite-pick surface.
 */

import { zgcSuite } from '@zakkster/lite-perf-gate';
import {
    Prng, BalancerBase, RoundRobinBalancer, SmoothWRRBalancer, P2cBalancer,
    LeastConnBalancer, SedBalancer, NqBalancer, PeakEwmaBalancer, ConsistentHashBalancer,
    BoundedLoadBalancer,
} from '../../Pick.js';

const CAP = 1 << 14;      // pool capacity 16384 (O(1)/O(d) scenarios: size is irrelevant)
const MASK = CAP - 1;     // power-of-2 mask: nextBelow stays in [0, CAP)
// The O(cap)-per-pick strategies (SmoothWRR + the exact LeastConn family) use a REALISTIC
// pool size (real balancer pools are dozens-to-hundreds of endpoints). Proving 0 B/op does
// not need a huge pool, and CAP=16384 would make each pick scan 16384 nodes -- a needless
// slow gate.
const SWRR_CAP = 256;
const SCAN_CAP = 256;     // LeastConn / SED / NQ (all O(cap) scans)

/** The zero-alloc counter for substrate scenarios: the eligibility view's byte length. */
function grows(s) {
    return s.el.buffer.byteLength;
}

/** A half-eligible pool of CAP endpoints (even indices up). */
function makePool() {
    const el = new Uint8Array(CAP);
    for (let i = 0; i < CAP; i += 2) el[i] = 1;
    return el;
}

/** prng-draw: one xorshift32 step folded into an int32 accumulator, zero-alloc. */
const prngDraw = {
    name: 'Prng.nextBelow draw',
    setup() {
        const el = makePool();
        return { el, base: new BalancerBase(CAP, el), rng: new Prng(0x1234abcd), acc: 0 };
    },
    hot(s, n) {
        const rng = s.rng;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + rng.nextBelow(CAP)) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: grows(s) }; },
};

/** eligible-read: draw an index, read its eligibility bit, int32-wrapped acc. */
const eligibleRead = {
    name: 'BalancerBase.isEligible read',
    setup() {
        const el = makePool();
        return { el, base: new BalancerBase(CAP, el), rng: new Prng(0xfeedface), acc: 0 };
    },
    hot(s, n) {
        const base = s.base, rng = s.rng;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) {
            acc = (acc + (base.isEligible(rng.nextBelow(CAP)) ? 1 : 0)) | 0;
        }
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: grows(s) }; },
};

/** set-churn: flip an eligibility bit up then down -- cold path, still zero-alloc. */
const setChurn = {
    name: 'BalancerBase.setEligible churn',
    setup() {
        const el = makePool();
        return { el, base: new BalancerBase(CAP, el), i: 1 };
    },
    hot(s, n) {
        const base = s.base;
        let i = s.i | 0;
        for (let k = 0; k < n; k++) {
            i = (i + 2) & MASK;      // walk odd (initially-down) indices
            base.setEligible(i, true);
            base.setEligible(i, false);
        }
        s.i = i | 0;
    },
    statsOf(s) { return { grows: grows(s) }; },
};

/** roundrobin-pick: reused RR over a half-eligible pool; each op a real pick(). */
const roundRobinPick = {
    name: 'RoundRobinBalancer.pick()',
    setup() {
        const el = makePool();
        return { el, base: new RoundRobinBalancer(CAP, el), acc: 0 };
    },
    hot(s, n) {
        const rr = s.base;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + rr.pick()) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: grows(s) }; },
};

/**
 * smoothwrr-pick: reused SmoothWRR over a weighted, half-eligible pool; each op a real
 * pick(). Its `grows` counter covers ALL three backing arrays (eligibility + weights +
 * the owned Float64 accumulators) -- none reallocates, so the delta must be 0.
 */
const smoothWrrPick = {
    name: 'SmoothWRRBalancer.pick()',
    setup() {
        const el = new Uint8Array(SWRR_CAP);
        for (let i = 0; i < SWRR_CAP; i += 2) el[i] = 1; // half eligible
        const weights = new Uint32Array(SWRR_CAP);
        for (let i = 0; i < SWRR_CAP; i++) weights[i] = 1 + (i & 7);
        const wrr = new SmoothWRRBalancer(SWRR_CAP, el, weights);
        return { el, weights, wrr, acc: 0 };
    },
    hot(s, n) {
        const wrr = s.wrr;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + wrr.pick()) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) {
        return {
            grows: s.el.buffer.byteLength + s.weights.buffer.byteLength + s.wrr._current.buffer.byteLength,
        };
    },
};

/**
 * p2c-pick: reused P2cBalancer over a half-eligible pool + a caller-owned inflight array;
 * each op two rejection-sampled draws + a compare. O(1), so CAP is fine. The `grows`
 * counter covers the eligibility + inflight arrays (neither reallocates -> 0 delta).
 */
const p2cPick = {
    name: 'P2cBalancer.pick()',
    setup() {
        const el = makePool();
        const inflight = new Uint32Array(CAP);
        for (let i = 0; i < CAP; i++) inflight[i] = i & 15;
        return { el, inflight, p2c: new P2cBalancer(CAP, el, inflight, 0xABCDEF), acc: 0 };
    },
    hot(s, n) {
        const p2c = s.p2c;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + p2c.pick()) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: s.el.buffer.byteLength + s.inflight.buffer.byteLength }; },
};

/** A half-eligible SCAN_CAP pool + a caller-owned inflight (and optional weights). */
function makeScanPool(withWeights) {
    const el = new Uint8Array(SCAN_CAP);
    for (let i = 0; i < SCAN_CAP; i += 2) el[i] = 1;
    const inflight = new Uint32Array(SCAN_CAP);
    for (let i = 0; i < SCAN_CAP; i++) inflight[i] = 1 + (i & 15); // all busy (NQ worst case)
    if (!withWeights) return { el, inflight };
    const weights = new Uint32Array(SCAN_CAP);
    for (let i = 0; i < SCAN_CAP; i++) weights[i] = 1 + (i & 7);
    return { el, inflight, weights };
}

/** leastconn-pick: reused LeastConn over a half-eligible pool; each op a real O(cap) pick(). */
const leastConnPick = {
    name: 'LeastConnBalancer.pick()',
    setup() {
        const { el, inflight } = makeScanPool(false);
        return { el, inflight, lc: new LeastConnBalancer(SCAN_CAP, el, inflight), acc: 0 };
    },
    hot(s, n) {
        const lc = s.lc;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + lc.pick()) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: s.el.buffer.byteLength + s.inflight.buffer.byteLength }; },
};

/** sed-pick: reused SED over a weighted, half-eligible pool; each op an O(cap) scan + divisions. */
const sedPick = {
    name: 'SedBalancer.pick()',
    setup() {
        const { el, inflight, weights } = makeScanPool(true);
        return { el, inflight, weights, sed: new SedBalancer(SCAN_CAP, el, inflight, weights), acc: 0 };
    },
    hot(s, n) {
        const sed = s.sed;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + sed.pick()) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: s.el.buffer.byteLength + s.inflight.buffer.byteLength + s.weights.buffer.byteLength }; },
};

/** nq-pick: reused NQ over an ALL-BUSY weighted pool so every pick takes the full SED-fallback scan. */
const nqPick = {
    name: 'NqBalancer.pick()',
    setup() {
        const { el, inflight, weights } = makeScanPool(true); // inflight all >= 1 -> no idle short-circuit
        return { el, inflight, weights, nq: new NqBalancer(SCAN_CAP, el, inflight, weights), acc: 0 };
    },
    hot(s, n) {
        const nq = s.nq;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + nq.pick()) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: s.el.buffer.byteLength + s.inflight.buffer.byteLength + s.weights.buffer.byteLength }; },
};

/**
 * peakewma-pick: reused PeakEwmaBalancer over a half-eligible pool + a caller-owned inflight
 * array; each op two rejection draws + two decay-on-read exp() + a compare (a PURE read -- pick
 * NEVER writes the owned EWMA state). O(d)=O(1), so CAP is fine. `now` advances each op. The
 * `grows` counter covers the eligibility + inflight arrays AND the owned _ewma / _stamp buffers
 * (none reallocates -> 0 delta).
 */
const peakEwmaPick = {
    name: 'PeakEwmaBalancer.pick(now)',
    setup() {
        const el = makePool();
        const inflight = new Uint32Array(CAP);
        for (let i = 0; i < CAP; i++) inflight[i] = i & 15;
        const pe = new PeakEwmaBalancer(CAP, el, inflight, 1e6, 0xABCDEF);
        // Warm the EWMA state once (cold path) so pick() reads varied costs, not the flat seed.
        for (let i = 0; i < CAP; i += 8) pe.recordRtt(i, (i & 31) * 1000, 0);
        return { el, inflight, pe, now: 0, acc: 0 };
    },
    hot(s, n) {
        const pe = s.pe;
        let acc = s.acc | 0, now = s.now;
        for (let i = 0; i < n; i++) { now += 1000; acc = (acc + pe.pick(now)) | 0; }
        s.acc = acc | 0; s.now = now;
    },
    statsOf(s) {
        return {
            grows: s.el.buffer.byteLength + s.inflight.buffer.byteLength +
                s.pe._ewma.buffer.byteLength + s.pe._stamp.buffer.byteLength,
        };
    },
};

/**
 * peakewma-recordrtt: the WARM feedback path. Each op is one decay + one branch + two Float64
 * writes over the owned EWMA state; the typeof/range guards only construct an Error on the
 * (untaken) failure branch, so the success path allocates nothing.
 */
const peakEwmaRecord = {
    name: 'PeakEwmaBalancer.recordRtt()',
    setup() {
        const el = makePool();
        const inflight = new Uint32Array(CAP);
        const pe = new PeakEwmaBalancer(CAP, el, inflight, 1e6, 0xFEEDBEEF);
        return { el, inflight, pe, now: 0 };
    },
    hot(s, n) {
        const pe = s.pe;
        let now = s.now;
        for (let i = 0; i < n; i++) { now += 1000; pe.recordRtt(now & MASK, now % 500000, now); }
        s.now = now;
    },
    statsOf(s) {
        return {
            grows: s.el.buffer.byteLength + s.inflight.buffer.byteLength +
                s.pe._ewma.buffer.byteLength + s.pe._stamp.buffer.byteLength,
        };
    },
};

/**
 * consistenthash-pick: reused ConsistentHashBalancer over a half-eligible pool. Each op is
 * slot = keyHash % M, a prebuilt-table read, and a bounded forward-probe past down slots -- O(1),
 * a PURE read (the table is built ONCE, COLD, in setup -- excluded from the hot measurement). A
 * small M (257) keeps the cold build cheap; pick is O(1) so pool size is irrelevant. The `grows`
 * counter covers the eligibility + weights + the owned lookup table (none reallocates -> 0 delta).
 */
const CH_CAP = 256;
const CH_M = 257;         // prime, >= CH_CAP
const consistentHashPick = {
    name: 'ConsistentHashBalancer.pick(keyHash)',
    setup() {
        const el = new Uint8Array(CH_CAP);
        for (let i = 0; i < CH_CAP; i += 2) el[i] = 1; // half eligible -> exercise the probe
        const ch = new ConsistentHashBalancer(CH_CAP, el, null, CH_M, 0xABCDEF);
        return { el, ch, key: 0, acc: 0 };
    },
    hot(s, n) {
        const ch = s.ch;
        // Stride 97 (coprime to M=257) walks every slot; masked to 30 bits so `key` stays a Smi
        // (a value >= 2^31 would box as a HeapNumber and be the ONLY thing scavenging -- not pick).
        let acc = s.acc | 0, key = s.key | 0;
        for (let i = 0; i < n; i++) { key = (key + 97) & 0x3fffffff; acc = (acc + ch.pick(key)) | 0; }
        s.acc = acc | 0; s.key = key | 0;
    },
    statsOf(s) {
        return { grows: s.el.buffer.byteLength + s.ch._weights.buffer.byteLength + s.ch._lookup.buffer.byteLength };
    },
};

/**
 * boundedload-pick: reused BoundedLoadBalancer (CHBL) over a half-eligible pool + a caller-owned
 * inflight array. Each op is slot = key % M, a prebuilt-table read, and a bounded cap-aware probe --
 * a PURE read (pick NEVER writes the owned _total). O(1), a small M (257) keeps the cold build cheap.
 * `_total` is seeded ONCE in setup (cold notes) so the cap branch (over-cap homes overflowing) runs on
 * the hot path. The `grows` counter covers the eligibility + inflight + the owned weights + lookup
 * table (none reallocates -> 0 delta).
 */
const boundedLoadPick = {
    name: 'BoundedLoadBalancer.pick(keyHash)',
    setup() {
        const el = new Uint8Array(CH_CAP);
        for (let i = 0; i < CH_CAP; i += 2) el[i] = 1; // half eligible -> exercise the probe / overflow
        const inflight = new Uint32Array(CH_CAP);
        let total = 0;
        for (let i = 0; i < CH_CAP; i++) { inflight[i] = i & 15; total += inflight[i]; }
        const bl = new BoundedLoadBalancer(CH_CAP, el, inflight, 0.25, null, CH_M, 0xABCDEF);
        bl.note(0, total);                     // seed _total to the true inflight sum (cold)
        return { el, inflight, bl, key: 0, acc: 0 };
    },
    hot(s, n) {
        const bl = s.bl;
        // Stride 97 (coprime to M=257) walks every slot; masked to 30 bits so `key` stays a Smi.
        let acc = s.acc | 0, key = s.key | 0;
        for (let i = 0; i < n; i++) { key = (key + 97) & 0x3fffffff; acc = (acc + bl.pick(key)) | 0; }
        s.acc = acc | 0; s.key = key | 0;
    },
    statsOf(s) {
        return { grows: s.el.buffer.byteLength + s.inflight.buffer.byteLength + s.bl._weights.buffer.byteLength + s.bl._lookup.buffer.byteLength };
    },
};

/**
 * boundedload-note: the WARM feedback path. Each op is one add + one clamp compare over the owned
 * scalar _total; the typeof/range guards only construct an Error on the (untaken) failure branch, so
 * the success path allocates nothing.
 */
const boundedLoadNote = {
    name: 'BoundedLoadBalancer.note()',
    setup() {
        const el = new Uint8Array(CH_CAP);
        for (let i = 0; i < CH_CAP; i += 2) el[i] = 1;
        const inflight = new Uint32Array(CH_CAP);
        const bl = new BoundedLoadBalancer(CH_CAP, el, inflight, 0.25, null, CH_M, 0xFEEDBEEF);
        return { el, inflight, bl, i: 0 };
    },
    hot(s, n) {
        const bl = s.bl;
        let i = s.i | 0;
        for (let k = 0; k < n; k++) { i = (i + 1) % CH_CAP; bl.note(i, (k & 1) ? -1 : 1); }
        s.i = i | 0;
    },
    statsOf(s) {
        return { grows: s.el.buffer.byteLength + s.inflight.buffer.byteLength + s.bl._weights.buffer.byteLength + s.bl._lookup.buffer.byteLength };
    },
};

const scenarios = [
    prngDraw, eligibleRead, setChurn, roundRobinPick, smoothWrrPick, p2cPick,
    leastConnPick, sedPick, nqPick, peakEwmaPick, peakEwmaRecord, consistentHashPick,
    boundedLoadPick, boundedLoadNote,
];

/**
 * The teeth: a draw that pushes each index into a FRESH [] each op -- the array MUST
 * trip the gate (scavenges scale with n), proving the instrument catches allocation on
 * the lite-pick surface. statsOf returns a constant so the failure is the alloc lanes.
 */
const drawMustFailAlloc = {
    name: 'Prng draw pushed into fresh array (MUST allocate)',
    setup() { return { rng: new Prng(0x0badf00d) }; },
    hot(s, n) {
        const rng = s.rng;
        let sink = 0;
        for (let i = 0; i < n; i++) {
            const arr = [rng.nextBelow(CAP)]; // fresh array per op -> heap churn
            sink += arr[0];
        }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The RoundRobin teeth: pick() whose result is boxed into a FRESH [] each op -- the array
 * MUST trip the gate, proving the instrument catches allocation on the RR pick surface.
 */
const rrMustFailAlloc = {
    name: 'RoundRobin.pick() boxed into fresh array (MUST allocate)',
    setup() {
        const el = makePool();
        return { el, base: new RoundRobinBalancer(CAP, el) };
    },
    hot(s, n) {
        const rr = s.base;
        let sink = 0;
        for (let i = 0; i < n; i++) {
            const arr = [rr.pick()]; // fresh array per op -> heap churn
            sink += arr[0];
        }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/** SmoothWRR teeth: pick() boxed into a fresh [] each op -- MUST trip the gate. */
const wrrMustFailAlloc = {
    name: 'SmoothWRR.pick() boxed into fresh array (MUST allocate)',
    setup() {
        const el = new Uint8Array(SWRR_CAP);
        for (let i = 0; i < SWRR_CAP; i += 2) el[i] = 1;
        const weights = new Uint32Array(SWRR_CAP);
        for (let i = 0; i < SWRR_CAP; i++) weights[i] = 1 + (i & 7);
        return { el, weights, base: new SmoothWRRBalancer(SWRR_CAP, el, weights) };
    },
    hot(s, n) {
        const wrr = s.base;
        let sink = 0;
        for (let i = 0; i < n; i++) { const arr = [wrr.pick()]; sink += arr[0]; }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/** P2C teeth: pick() boxed into a fresh [] each op -- MUST trip the gate. */
const p2cMustFailAlloc = {
    name: 'P2C.pick() boxed into fresh array (MUST allocate)',
    setup() {
        const el = makePool();
        const inflight = new Uint32Array(CAP);
        return { el, inflight, base: new P2cBalancer(CAP, el, inflight, 1) };
    },
    hot(s, n) {
        const p2c = s.base;
        let sink = 0;
        for (let i = 0; i < n; i++) { const arr = [p2c.pick()]; sink += arr[0]; }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/** LeastConn teeth: pick() boxed into a fresh [] each op -- MUST trip the gate. */
const lcMustFailAlloc = {
    name: 'LeastConn.pick() boxed into fresh array (MUST allocate)',
    setup() {
        const { el, inflight } = makeScanPool(false);
        return { el, inflight, base: new LeastConnBalancer(SCAN_CAP, el, inflight) };
    },
    hot(s, n) {
        const lc = s.base;
        let sink = 0;
        for (let i = 0; i < n; i++) { const arr = [lc.pick()]; sink += arr[0]; }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/** SED teeth: pick() boxed into a fresh [] each op -- MUST trip the gate. */
const sedMustFailAlloc = {
    name: 'SED.pick() boxed into fresh array (MUST allocate)',
    setup() {
        const { el, inflight, weights } = makeScanPool(true);
        return { el, inflight, weights, base: new SedBalancer(SCAN_CAP, el, inflight, weights) };
    },
    hot(s, n) {
        const sed = s.base;
        let sink = 0;
        for (let i = 0; i < n; i++) { const arr = [sed.pick()]; sink += arr[0]; }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/** NQ teeth: pick() boxed into a fresh [] each op -- MUST trip the gate. */
const nqMustFailAlloc = {
    name: 'NQ.pick() boxed into fresh array (MUST allocate)',
    setup() {
        const { el, inflight, weights } = makeScanPool(true);
        return { el, inflight, weights, base: new NqBalancer(SCAN_CAP, el, inflight, weights) };
    },
    hot(s, n) {
        const nq = s.base;
        let sink = 0;
        for (let i = 0; i < n; i++) { const arr = [nq.pick()]; sink += arr[0]; }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/** PeakEWMA teeth: pick(now) boxed into a fresh [] each op -- MUST trip the gate. */
const peMustFailAlloc = {
    name: 'PeakEWMA.pick(now) boxed into fresh array (MUST allocate)',
    setup() {
        const el = makePool();
        const inflight = new Uint32Array(CAP);
        return { el, inflight, base: new PeakEwmaBalancer(CAP, el, inflight, 1e6, 1), now: 0 };
    },
    hot(s, n) {
        const pe = s.base;
        let sink = 0, now = s.now;
        for (let i = 0; i < n; i++) { now += 1000; const arr = [pe.pick(now)]; sink += arr[0]; }
        s.sink = sink; s.now = now;
    },
    statsOf() { return { grows: 0 }; },
};

/** ConsistentHash teeth: pick(keyHash) boxed into a fresh [] each op -- MUST trip the gate. */
const chMustFailAlloc = {
    name: 'ConsistentHash.pick(keyHash) boxed into fresh array (MUST allocate)',
    setup() {
        const el = new Uint8Array(CH_CAP);
        for (let i = 0; i < CH_CAP; i += 2) el[i] = 1;
        return { el, base: new ConsistentHashBalancer(CH_CAP, el, null, CH_M, 1), key: 0 };
    },
    hot(s, n) {
        const ch = s.base;
        let sink = 0, key = s.key | 0;
        for (let i = 0; i < n; i++) { key = (key + 97) & 0x3fffffff; const arr = [ch.pick(key)]; sink += arr[0]; }
        s.sink = sink; s.key = key | 0;
    },
    statsOf() { return { grows: 0 }; },
};

/** BoundedLoad teeth: pick(keyHash) boxed into a fresh [] each op -- MUST trip the gate. */
const blMustFailAlloc = {
    name: 'BoundedLoad.pick(keyHash) boxed into fresh array (MUST allocate)',
    setup() {
        const el = new Uint8Array(CH_CAP);
        for (let i = 0; i < CH_CAP; i += 2) el[i] = 1;
        const inflight = new Uint32Array(CH_CAP);
        for (let i = 0; i < CH_CAP; i++) inflight[i] = i & 15;
        const bl = new BoundedLoadBalancer(CH_CAP, el, inflight, 0.25, null, CH_M, 1);
        bl.note(0, CH_CAP * 8);
        return { el, inflight, base: bl, key: 0 };
    },
    hot(s, n) {
        const bl = s.base;
        let sink = 0, key = s.key | 0;
        for (let i = 0; i < n; i++) { key = (key + 97) & 0x3fffffff; const arr = [bl.pick(key)]; sink += arr[0]; }
        s.sink = sink; s.key = key | 0;
    },
    statsOf() { return { grows: 0 }; },
};

zgcSuite({
    N: 200000,
    k: 8,
    maxScavenges: 0,
    maxOldGen: 0,
    maxArrayBuffersKB: 0,
    counters: { grows: 0 },
    maxRetainedKB: 64,
    scenarios,
    mustFail: [
        drawMustFailAlloc, rrMustFailAlloc, wrrMustFailAlloc, p2cMustFailAlloc,
        lcMustFailAlloc, sedMustFailAlloc, nqMustFailAlloc, peMustFailAlloc, chMustFailAlloc,
        blMustFailAlloc,
    ],
});
