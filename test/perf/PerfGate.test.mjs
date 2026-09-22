/**
 * @zakkster/lite-pick -- the HARD zero-allocation perf gate (@zakkster/lite-perf-gate).
 *
 * Run:  node --expose-gc --max-semi-space-size=4 --test test/perf/PerfGate.test.mjs
 *
 * A node:test-native COMPLEMENT to torture (0 B/op), not a replacement. M0 gates the
 * SUBSTRATE hot ops every strategy rides -- the deterministic Prng draw (next /
 * nextBelow) and the BalancerBase eligibility read (isEligible) -- via scavenge scaling
 * at N and k*N, with the old-gen and external / arrayBuffers lanes pinned to 0. The
 * eligibility view is fixed at construction and NEVER grows, so the `grows` counter
 * (its .buffer.byteLength) must show a 0 delta across the whole window.
 *
 * Each strategy session (M1+) appends its own reused-instance scenario + its own
 * mustFail teeth-check here (ROADMAP section 3 / accounting site 10).
 *
 * mustFail: a "draw into a fresh []" step that MUST trip the gate (scavenges scale with
 * n), proving the instrument has teeth on the lite-pick surface.
 */

import { zgcSuite } from '@zakkster/lite-perf-gate';
import { Prng, BalancerBase } from '../../Pick.js';

const CAP = 1 << 14;      // pool capacity 16384
const MASK = CAP - 1;     // power-of-2 mask: nextBelow stays in [0, CAP)

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

const scenarios = [prngDraw, eligibleRead, setChurn];

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

zgcSuite({
    N: 200000,
    k: 8,
    maxScavenges: 0,
    maxOldGen: 0,
    maxArrayBuffersKB: 0,
    counters: { grows: 0 },
    maxRetainedKB: 64,
    scenarios,
    mustFail: [drawMustFailAlloc],
});
