/**
 * @zakkster/lite-pick -- the HARD zero-allocation perf gate (@zakkster/lite-perf-gate).
 *
 * Run:  node --expose-gc --max-semi-space-size=4 --test test/perf/PerfGate.test.mjs
 *
 * A node:test-native COMPLEMENT to torture (0 B/op), not a replacement. M2 gates the
 * SUBSTRATE hot ops every strategy rides -- the deterministic Prng draw (next /
 * nextBelow) and the BalancerBase eligibility read (isEligible) -- AND RoundRobin.pick()
 * and SmoothWRR.pick(), via scavenge scaling at N and k*N, with the old-gen and external /
 * arrayBuffers lanes pinned to 0. Backing arrays are fixed at construction and NEVER grow,
 * so each scenario's `grows` counter (its backing .buffer.byteLength) shows a 0 delta.
 *
 * Each strategy session (M1+) appends its own reused-instance scenario + its own
 * mustFail teeth-check here (ROADMAP section 3 / accounting site 10).
 *
 * mustFail: a "draw into a fresh []" step that MUST trip the gate (scavenges scale with
 * n), proving the instrument has teeth on the lite-pick surface.
 */

import { zgcSuite } from '@zakkster/lite-perf-gate';
import { Prng, BalancerBase, RoundRobinBalancer, SmoothWRRBalancer } from '../../Pick.js';

const CAP = 1 << 14;      // pool capacity 16384 (O(1)/O(d) scenarios: size is irrelevant)
const MASK = CAP - 1;     // power-of-2 mask: nextBelow stays in [0, CAP)
// SmoothWRR is O(cap) per pick, so its scenarios use a REALISTIC pool size (real
// balancer pools are dozens-to-hundreds of endpoints). Proving 0 B/op does not need a
// huge pool, and CAP=16384 would make each pick scan 16384 nodes -- a needless slow gate.
const SWRR_CAP = 256;

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

const scenarios = [prngDraw, eligibleRead, setChurn, roundRobinPick, smoothWrrPick];

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

zgcSuite({
    N: 200000,
    k: 8,
    maxScavenges: 0,
    maxOldGen: 0,
    maxArrayBuffersKB: 0,
    counters: { grows: 0 },
    maxRetainedKB: 64,
    scenarios,
    mustFail: [drawMustFailAlloc, rrMustFailAlloc, wrrMustFailAlloc],
});
