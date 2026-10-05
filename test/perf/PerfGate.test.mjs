/**
 * @zakkster/lite-pick -- the HARD zero-allocation perf gate (@zakkster/lite-perf-gate).
 *
 * Run:  node --expose-gc --min-semi-space-size=1 --max-semi-space-size=1 --test test/perf/PerfGate.test.mjs
 *       (or: npm run test:perf -- new space pinned to 1MB, min AND max, the sharpest setting)
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zgcSuite, measure } from '@zakkster/lite-perf-gate';
import {
    Prng, BalancerBase, RoundRobinBalancer, SmoothWRRBalancer, P2cBalancer,
    LeastConnBalancer, SedBalancer, NqBalancer, PeakEwmaBalancer, ConsistentHashBalancer,
    BoundedLoadBalancer, WeightedRandomBalancer,
} from '../../Pick.js';

// FAIL-CLOSED semi-space pin check. New space is pinned to 1MB (min = max = 1) -- the SHARPEST
// setting, no coarser than V8's default starting size, so the gate detects the smallest per-op
// allocation. Pinning MIN as well as MAX stops the young generation from growing mid-run, which
// would otherwise raise the scavenge threshold and let a small allocation slip. Assert both flags so
// the gate can never silently run un-pinned. (At this sharp pin the 1.0.x recordRtt showed a small
// allocation for some integer sample patterns when its lane ran alone -- a Maglev merge of a tagged argument
// with a double, removed in 1.1.0 B3; research/1.1.0-buffer-apis.md section 6. The lane is gated below.)
function semiSpaceMB(flag) {
    const av = process.execArgv;
    for (let i = 0; i < av.length; i++) {
        const a = av[i];
        if (a === flag && i + 1 < av.length) return Number(av[i + 1]);
        if (a.startsWith(flag + '=')) return Number(a.slice(flag.length + 1));
    }
    return NaN;
}
test('perf-gate: semi-space pinned to 1MB (min AND max) -- fail closed', () => {
    const max = semiSpaceMB('--max-semi-space-size');
    const min = semiSpaceMB('--min-semi-space-size');
    assert.equal(max, 1, 'run with --max-semi-space-size=1 (got ' + max + ') -- use: npm run test:perf');
    assert.equal(min, 1, 'run with --min-semi-space-size=1 so new space does not grow mid-run ' +
        '(got ' + min + ') -- use: npm run test:perf');
});

const CAP = 1 << 14;      // pool capacity 16384 (O(1)/O(d) scenarios: size is irrelevant)
const MASK = CAP - 1;     // power-of-2 mask: nextBelow stays in [0, CAP)
// The O(cap)-per-pick strategies (SmoothWRR + the exact LeastConn family) use a REALISTIC
// pool size (real balancer pools are dozens-to-hundreds of endpoints). Proving 0 B/op does
// not need a huge pool, and CAP=16384 would make each pick scan 16384 nodes -- a needless
// slow gate.
const SWRR_CAP = 256;
const SCAN_CAP = 256;     // LeastConn / SED / NQ (all O(cap) scans)
// H5: the WeightedRandom heavy-outage FALLBACK scenario scans O(cap) per pick, so at the suite's
// 8N=1.6M ops a CAP=16384 pool runs ~2.6e10 element reads (~16.7s), long enough for V8's memory
// reducer to fire ~2 GCs after its ~8s idle-allocation timer and trip the oldgen lane (a false
// positive -- FINDINGS H5). A SMALL dedicated pool exercises the IDENTICAL exhausted-rejection ->
// rotated-linear-scan code path (integer locals only, still 0 B/op) at a fraction of the wall time,
// so every phase finishes well under 8s. Chosen over --no-memory-reducer: shrinking keeps the gate
// honest (a genuinely slow low-alloc lane would still be caught) rather than masking a whole GC
// class. At FB_CAP=2048 the 64-try rejection loop misses ~96.9% of the time (hit prob 64/2048), so
// the fallback scan is the path taken on almost every pick -- the branch this lane exists to gate.
const FB_CAP = 2048;

// The PeakEWMA driver clock is masked to CLK_MASK every step so its VALUE stays a Smi on EVERY build.
// Smi width is BUILD-DEPENDENT: on stock 64-bit Node built WITHOUT pointer compression (this machine
// -- process.config.variables.v8_enable_pointer_compression is 0) Smis are 32-bit, so the ceiling is
// 2^31-1 and %IsSmi(1.6e9) is true; on a pointer-COMPRESSED build (Chrome / Electron) Smis are 31-bit
// and the ceiling is 2^30-1. 0x3fffffff (2^30-1) is the LOWER of the two ceilings, so a masked clock
// is a Smi on both builds, keeping the gate portable. (A plain monotonic `now += 1000` reaches ~1.6e9
// over an 8N window -- still a Smi HERE, but a HeapNumber on a pointer-compressed build, where a large
// clock passed to non-inlined pick()/recordRtt would box.) The wrap makes the clock non-monotonic;
// pick()/recordRtt clamp the resulting negative dt to 0 (L6), so it is harmless. The REALISTIC-magnitude
// lanes (a 1.7e15 clock, fractional samples, keys >= 2^31) gate the 1.1.0 `From` methods below.
const CLK_MASK = 0x3fffffff;   // 2^30 - 1: the LOWER (pointer-compressed) Smi ceiling -- portable

// M-T3: buffer IDENTITY, not byteLength. A typed array's `.buffer.byteLength` can NEVER change
// (the audit's dead `grows` counter), so it could never detect a reallocation. Each distinct
// ArrayBuffer instance is assigned a strictly-increasing id; statsOf sums the ids of every backing
// store a scenario owns. If any store is reallocated mid-window (e.g. a rebuild swaps in a fresh
// typed array), statsAfter reads the NEW buffer object -> a strictly larger id -> a nonzero delta
// that trips the `grows: 0` counter. Runs OUTSIDE the measured window (statsOf is called before/
// after the gc-counter bracket), so its own allocation never pollutes the scavenge count.
let __bufSeq = 0;
const __bufIds = new WeakMap();
function bufId(buf) {
    let id = __bufIds.get(buf);
    if (id === undefined) { id = (__bufSeq += 1); __bufIds.set(buf, id); }
    return id;
}
function bufIds() {
    let s = 0;
    for (let i = 0; i < arguments.length; i++) s += bufId(arguments[i]);
    return s;
}

/** The zero-alloc counter for substrate scenarios: the eligibility view's buffer IDENTITY. */
function grows(s) {
    return bufId(s.el.buffer);
}

// M-T3: the must-fail controls' allocation must ESCAPE. `const arr = [pick()]; sink += arr[0]`
// never escapes, so once V8's escape analysis / scalar replacement kicks in the array is never
// allocated and the control silently stops tripping (the audit saw scavenges N:2-3 -> 8N:0, and
// ConsistentHash/BoundedLoad must-fail checks missing 3 of 5 runs). Writing each fresh array into
// a module-level 64-slot ring forces a real heap store V8 cannot elide, so the allocation is
// genuine and the scavenge count scales with n on EVERY run. Bounded to 64 slots: at most ~64
// arrays outlive any pass, so one must-fail measurement can never poison the next.
const MF_RING_SIZE = 64;
const MF_RING_MASK = MF_RING_SIZE - 1;
const __mfRing = new Array(MF_RING_SIZE).fill(null);

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
        return { grows: bufIds(s.el.buffer, s.weights.buffer, s.wrr._current.buffer) };
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
    statsOf(s) { return { grows: bufIds(s.el.buffer, s.inflight.buffer) }; },
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
    statsOf(s) { return { grows: bufIds(s.el.buffer, s.inflight.buffer) }; },
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
    statsOf(s) { return { grows: bufIds(s.el.buffer, s.inflight.buffer, s.weights.buffer) }; },
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
    statsOf(s) { return { grows: bufIds(s.el.buffer, s.inflight.buffer, s.weights.buffer) }; },
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
        let acc = s.acc | 0, now = s.now | 0;
        for (let i = 0; i < n; i++) { now = (now + 1000) & CLK_MASK; acc = (acc + pe.pick(now)) | 0; }
        s.acc = acc | 0; s.now = now | 0;
    },
    statsOf(s) {
        return { grows: bufIds(s.el.buffer, s.inflight.buffer, s.pe._ewma.buffer, s.pe._stamp.buffer, s.pe._samp.buffer, s.pe._arg.buffer) };
    },
};

/**
 * peakewma-recordrtt: the WARM feedback path. Each op is one decay + one branch + two Float64
 * writes over the owned EWMA state; the typeof/range guards only construct an Error on the
 * (untaken) failure branch, so the success path allocates nothing.
 *
 * The 1.0.x "recordRtt in isolation" FINDINGS (a small window-scaling allocation for the `now % 500000`
 * sample pattern when this lane ran ALONE, gone with --no-maglev or a prior lane) has an established root
 * cause: the 1.0.x blend `sampleNs > e ? sampleNs : e + ...` merged the tagged argument with a double, and
 * Maglev boxed the merge whenever the blend branch ran (5 of 30 windows alone; 0 of 30 with only that line
 * changed to if / else). 1.1.0 B3 removed the merge; research/1.1.0-buffer-apis.md section 6. The
 * mod-500000 pattern is now a GATED lane (peakEwmaRecordMod).
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
        let now = s.now | 0;
        // sampleNs = `now & 0x7ffff`: a Smi rtt in [0, 524287] ns. Chosen because it is reliable alone
        // and in any order (0 B/op); it does NOT cover the mod-500000 pattern (see the report-only lane).
        for (let i = 0; i < n; i++) { now = (now + 1000) & CLK_MASK; pe.recordRtt(now & MASK, now & 0x7ffff, now); }
        s.now = now | 0;
    },
    statsOf(s) {
        return { grows: bufIds(s.el.buffer, s.inflight.buffer, s.pe._ewma.buffer, s.pe._stamp.buffer, s.pe._samp.buffer, s.pe._arg.buffer) };
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
        // Stride 97 (coprime to M=257) walks every slot; `& 0x3fffffff` keeps `key` a Smi VALUE
        // (< 2^30), which crosses the non-inlined pick() boundary UNBOXED, proving pick() is 0 B/op on
        // the Smi-key path. HONEST DISCLOSURE (the report-only lanes below): a REALISTIC
        // key >= 2^31 is a genuine NON-Smi double -- and about half of fnv1a's `x >>> 0` output is
        // >= 2^31 -- so it is boxed as a HeapNumber at that boundary (measured ~16 B/op, steady-state).
        // The report-only lanes below print it every run; the buffer-based key API (pick keys from a
        // caller-owned Uint32Array) lands in 1.1.0.
        let acc = s.acc | 0, key = s.key | 0;
        for (let i = 0; i < n; i++) { key = (key + 97) & 0x3fffffff; acc = (acc + ch.pick(key)) | 0; }
        s.acc = acc | 0; s.key = key | 0;
    },
    statsOf(s) {
        return { grows: bufIds(s.el.buffer, s.ch._weights.buffer, s.ch._lookup.buffer) };
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
        // Stride 97 (coprime to M=257) walks every slot; `& 0x3fffffff` keeps `key` a Smi VALUE
        // (< 2^30), which crosses the non-inlined pick() boundary UNBOXED, proving pick() is 0 B/op on
        // the Smi-key path. HONEST DISCLOSURE (the report-only lanes below): a REALISTIC
        // key >= 2^31 is a genuine NON-Smi double -- about half of fnv1a's `x >>> 0` output -- so it is
        // boxed as a HeapNumber at that boundary (measured ~16 B/op, steady-state). The report-only
        // lanes below print it every run; the buffer-based key API (Uint32Array) lands in 1.1.0.
        let acc = s.acc | 0, key = s.key | 0;
        for (let i = 0; i < n; i++) { key = (key + 97) & 0x3fffffff; acc = (acc + bl.pick(key)) | 0; }
        s.acc = acc | 0; s.key = key | 0;
    },
    statsOf(s) {
        return { grows: bufIds(s.el.buffer, s.inflight.buffer, s.bl._weights.buffer, s.bl._lookup.buffer) };
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
        return { grows: bufIds(s.el.buffer, s.inflight.buffer, s.bl._weights.buffer, s.bl._lookup.buffer) };
    },
};

/**
 * weightedrandom-pick: reused WeightedRandomBalancer over a half-eligible, weighted pool. Each op is
 * one alias-column draw + one probability compare, rejection-sampled over eligibility -- integer/float
 * locals only, a PURE read (the alias table is built ONCE, COLD, in setup). O(1), so CAP is fine. The
 * `grows` counter covers the eligibility + weights + the owned _prob / _alias table (none reallocates
 * -> 0 delta).
 */
const weightedRandomPick = {
    name: 'WeightedRandomBalancer.pick()',
    setup() {
        const el = makePool();                     // half eligible -> exercise rejection
        const weights = new Uint32Array(CAP);
        for (let i = 0; i < CAP; i++) weights[i] = 1 + (i & 15);
        const wr = new WeightedRandomBalancer(CAP, el, weights, 0x5EED1E55);
        return { el, weights, wr, acc: 0 };
    },
    hot(s, n) {
        const wr = s.wr;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + wr.pick()) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) {
        return { grows: bufIds(s.el.buffer, s.weights.buffer, s.wr._prob.buffer, s.wr._alias.buffer) };
    },
};

/**
 * weightedrandom-pick-fallback: the HEAVY-OUTAGE path. EXACTLY ONE eligible positive-weight node in the
 * FB_CAP pool (all others down), so the 64-try rejection loop misses ~every time (hit prob ~64/FB_CAP)
 * and each pick() runs the rotated linear-scan FALLBACK -- the branch the dense/half scenario never
 * reaches. It must be 0 B/op too (the scan uses only integer locals). FB_CAP (see its definition) is a
 * SMALL dedicated pool so this O(cap) lane finishes well under V8's ~8s memory-reducer timer (H5).
 * Same `grows` counter (nothing reallocates -> 0 delta).
 */
const weightedRandomPickFallback = {
    name: 'WeightedRandomBalancer.pick() heavy-outage fallback scan',
    setup() {
        const el = new Uint8Array(FB_CAP);         // all DOWN...
        el[1] = 1;                                 // ...except exactly ONE eligible node -> fallback path
        const weights = new Uint32Array(FB_CAP);
        for (let i = 0; i < FB_CAP; i++) weights[i] = 1 + (i & 15); // every node positive-weight
        const wr = new WeightedRandomBalancer(FB_CAP, el, weights, 0x0FF0DEAD);
        return { el, weights, wr, acc: 0 };
    },
    hot(s, n) {
        const wr = s.wr;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + wr.pick()) | 0;   // ~every pick exhausts rejection -> scan
        s.acc = acc | 0;
    },
    statsOf(s) {
        return { grows: bufIds(s.el.buffer, s.weights.buffer, s.wr._prob.buffer, s.wr._alias.buffer) };
    },
};

// ---------------------------------------------------------------------------
// 1.1.0 B6: the zero-box `From` methods, GATED at REALISTIC magnitudes (research/1.1.0-buffer-apis.md).
// The plain-argument methods box these values at a non-inlined call (the report-only lanes print it); the
// `From` siblings read them from a caller-owned typed-array slot, so they must be 0 B/op here.
// ---------------------------------------------------------------------------
const REAL_NOW = 1.7e15;           // an hrtime-scale ns clock: a large double, never a Smi
const peakEwmaPickFrom = {
    name: 'PeakEwmaBalancer.pickFrom(clock~1.7e15 in a Float64Array)',
    setup() {
        const el = makePool();
        const inflight = new Uint32Array(CAP);
        for (let i = 0; i < CAP; i++) inflight[i] = i & 15;
        const pe = new PeakEwmaBalancer(CAP, el, inflight, 1e6, 0xABCDEF);
        for (let i = 0; i < CAP; i += 8) pe.recordRtt(i, (i & 31) * 1000 + 0.5, REAL_NOW);
        return { el, inflight, pe, clk: new Float64Array([REAL_NOW]), acc: 0 };
    },
    hot(s, n) {
        const pe = s.pe, clk = s.clk;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) { clk[0] += 1000; acc = (acc + pe.pickFrom(clk, 0)) | 0; }
        s.acc = acc | 0;
    },
    statsOf(s) {
        return { grows: bufIds(s.el.buffer, s.inflight.buffer, s.pe._ewma.buffer, s.pe._stamp.buffer, s.pe._samp.buffer, s.pe._arg.buffer, s.clk.buffer) };
    },
};
const peakEwmaRecordFrom = {
    name: 'PeakEwmaBalancer.recordRttFrom([fractional sample, clock~1.7e15])',
    setup() {
        const el = makePool();
        const inflight = new Uint32Array(CAP);
        const pe = new PeakEwmaBalancer(CAP, el, inflight, 1e6, 0xFEEDBEEF);
        return { el, inflight, pe, fb: new Float64Array([0, REAL_NOW]) };
    },
    hot(s, n) {
        const pe = s.pe, fb = s.fb;
        for (let i = 0; i < n; i++) { fb[1] += 1000; fb[0] = (i & 4095) * 250.5; pe.recordRttFrom(i & MASK, fb, 0); }
    },
    statsOf(s) {
        return { grows: bufIds(s.el.buffer, s.inflight.buffer, s.pe._ewma.buffer, s.pe._stamp.buffer, s.pe._samp.buffer, s.pe._arg.buffer, s.fb.buffer) };
    },
};
function realKeys() {
    const keys = new Uint32Array(4096);
    for (let i = 0; i < keys.length; i++) keys[i] = (0x80000000 + i * 97) >>> 0;   // all >= 2^31
    return keys;
}
const consistentHashPickFrom = {
    name: 'ConsistentHashBalancer.pickFrom(keys >= 2^31 in a Uint32Array)',
    setup() {
        const el = new Uint8Array(CH_CAP);
        for (let i = 0; i < CH_CAP; i += 2) el[i] = 1;
        const ch = new ConsistentHashBalancer(CH_CAP, el, null, CH_M, 0xABCDEF);
        return { el, ch, keys: realKeys(), ki: 0, acc: 0 };
    },
    hot(s, n) {
        const ch = s.ch, keys = s.keys, m = keys.length - 1;
        let acc = s.acc | 0, ki = s.ki | 0;
        for (let i = 0; i < n; i++) { acc = (acc + ch.pickFrom(keys, ki & m)) | 0; ki++; }
        s.acc = acc | 0; s.ki = ki | 0;
    },
    statsOf(s) {
        return { grows: bufIds(s.el.buffer, s.ch._weights.buffer, s.ch._lookup.buffer, s.keys.buffer) };
    },
};
const boundedLoadPickFrom = {
    name: 'BoundedLoadBalancer.pickFrom(keys >= 2^31 in a Uint32Array)',
    setup() {
        const el = new Uint8Array(CH_CAP);
        for (let i = 0; i < CH_CAP; i += 2) el[i] = 1;
        const inflight = new Uint32Array(CH_CAP);
        let total = 0;
        for (let i = 0; i < CH_CAP; i++) { inflight[i] = i & 15; total += inflight[i]; }
        const bl = new BoundedLoadBalancer(CH_CAP, el, inflight, 0.25, null, CH_M, 0xABCDEF);
        bl.note(0, total);
        return { el, inflight, bl, keys: realKeys(), ki: 0, acc: 0 };
    },
    hot(s, n) {
        const bl = s.bl, keys = s.keys, m = keys.length - 1;
        let acc = s.acc | 0, ki = s.ki | 0;
        for (let i = 0; i < n; i++) { acc = (acc + bl.pickFrom(keys, ki & m)) | 0; ki++; }
        s.acc = acc | 0; s.ki = ki | 0;
    },
    statsOf(s) {
        return { grows: bufIds(s.el.buffer, s.inflight.buffer, s.bl._weights.buffer, s.bl._lookup.buffer, s.keys.buffer) };
    },
};
// The 1.0.x isolation pattern (`now % 500000`, step 1000), gated since 1.1.0 B6 (root cause above).
const peakEwmaRecordMod = {
    name: 'PeakEwmaBalancer.recordRtt(now % 500000, step 1000)',
    setup() {
        const el = makePool();
        const inflight = new Uint32Array(CAP);
        const pe = new PeakEwmaBalancer(CAP, el, inflight, 1e6, 0xFEEDBEEF);
        return { el, inflight, pe, now: 0 };
    },
    hot(s, n) {
        const pe = s.pe;
        let now = s.now | 0;
        for (let i = 0; i < n; i++) { now = (now + 1000) & CLK_MASK; pe.recordRtt(now & MASK, now % 500000, now); }
        s.now = now | 0;
    },
    statsOf(s) {
        return { grows: bufIds(s.el.buffer, s.inflight.buffer, s.pe._ewma.buffer, s.pe._stamp.buffer, s.pe._samp.buffer, s.pe._arg.buffer) };
    },
};

const scenarios = [
    prngDraw, eligibleRead, setChurn, roundRobinPick, smoothWrrPick, p2cPick,
    leastConnPick, sedPick, nqPick, peakEwmaPick, peakEwmaRecord, consistentHashPick,
    boundedLoadPick, boundedLoadNote, weightedRandomPick, weightedRandomPickFallback,
    peakEwmaPickFrom, peakEwmaRecordFrom, peakEwmaRecordMod, consistentHashPickFrom, boundedLoadPickFrom,
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
            const arr = [rng.nextBelow(CAP)];         // fresh array per op -> heap churn
            __mfRing[i & MF_RING_MASK] = arr;         // ESCAPE it so V8 cannot elide the alloc
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
            const arr = [rr.pick()];                  // fresh array per op -> heap churn
            __mfRing[i & MF_RING_MASK] = arr;         // ESCAPE it so V8 cannot elide the alloc
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
        for (let i = 0; i < n; i++) { const arr = [wrr.pick()]; __mfRing[i & MF_RING_MASK] = arr; sink += arr[0]; }
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
        for (let i = 0; i < n; i++) { const arr = [p2c.pick()]; __mfRing[i & MF_RING_MASK] = arr; sink += arr[0]; }
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
        for (let i = 0; i < n; i++) { const arr = [lc.pick()]; __mfRing[i & MF_RING_MASK] = arr; sink += arr[0]; }
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
        for (let i = 0; i < n; i++) { const arr = [sed.pick()]; __mfRing[i & MF_RING_MASK] = arr; sink += arr[0]; }
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
        for (let i = 0; i < n; i++) { const arr = [nq.pick()]; __mfRing[i & MF_RING_MASK] = arr; sink += arr[0]; }
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
        for (let i = 0; i < n; i++) { now += 1000; const arr = [pe.pick(now)]; __mfRing[i & MF_RING_MASK] = arr; sink += arr[0]; }
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
        for (let i = 0; i < n; i++) { key = (key + 97) & 0x3fffffff; const arr = [ch.pick(key)]; __mfRing[i & MF_RING_MASK] = arr; sink += arr[0]; }
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
        for (let i = 0; i < n; i++) { key = (key + 97) & 0x3fffffff; const arr = [bl.pick(key)]; __mfRing[i & MF_RING_MASK] = arr; sink += arr[0]; }
        s.sink = sink; s.key = key | 0;
    },
    statsOf() { return { grows: 0 }; },
};

/** WeightedRandom teeth: pick() boxed into a fresh [] each op -- MUST trip the gate. */
const wrMustFailAlloc = {
    name: 'WeightedRandom.pick() boxed into fresh array (MUST allocate)',
    setup() {
        const el = makePool();
        const weights = new Uint32Array(CAP);
        for (let i = 0; i < CAP; i++) weights[i] = 1 + (i & 15);
        return { el, weights, base: new WeightedRandomBalancer(CAP, el, weights, 1) };
    },
    hot(s, n) {
        const wr = s.base;
        let sink = 0;
        for (let i = 0; i < n; i++) { const arr = [wr.pick()]; __mfRing[i & MF_RING_MASK] = arr; sink += arr[0]; }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

// SENSITIVITY controls (the pin must not blind the gate). At the pinned min=max=1 (1MB new space,
// the sharpest setting), even a SMALL escaped allocation must trip maxScavenges:0. These controls
// prove the floor: a single 1-field object (~16-24B) and a short string EVERY op, plus INTERMITTENT
// controls that allocate only every 16th / every 32nd pick (a far weaker signal). All MUST trip.
// If a control only trips at a COARSER pin, the pin is a loosening -- stop and report. Measured at
// 1MB: object/op 8N~34, string/op 8N~26, every-16 trips, every-32 trips.

/** Small-object teeth: ONE 1-field object per pick (smallest real heap object) -- MUST trip. */
const smallObjMustFailAlloc = {
    name: 'RoundRobin.pick() into one small {v} object per op (MUST allocate, small)',
    setup() {
        const el = makePool();
        return { el, base: new RoundRobinBalancer(CAP, el) };
    },
    hot(s, n) {
        const rr = s.base;
        let sink = 0;
        for (let i = 0; i < n; i++) { const o = { v: rr.pick() }; __mfRing[i & MF_RING_MASK] = o; sink += o.v; }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/** Short-string teeth: one freshly concatenated short string per pick -- MUST trip. */
const strMustFailAlloc = {
    name: 'RoundRobin.pick() into a short concatenated string per op (MUST allocate, small)',
    setup() {
        const el = makePool();
        return { el, base: new RoundRobinBalancer(CAP, el) };
    },
    hot(s, n) {
        const rr = s.base;
        let sink = 0;
        for (let i = 0; i < n; i++) { const str = 'p' + rr.pick(); __mfRing[i & MF_RING_MASK] = str; sink += str.length; }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/** INTERMITTENT teeth: one escaped object every 16 picks (a weak, spread-out signal) -- MUST trip. */
const every16MustFailAlloc = {
    name: 'RoundRobin.pick() into one small object every 16 picks (MUST allocate, intermittent)',
    setup() {
        const el = makePool();
        return { el, base: new RoundRobinBalancer(CAP, el) };
    },
    hot(s, n) {
        const rr = s.base;
        let sink = 0;
        for (let i = 0; i < n; i++) { const p = rr.pick(); if ((i & 15) === 0) { __mfRing[i & MF_RING_MASK] = { v: p }; } sink += p; }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/** INTERMITTENT teeth: one escaped object every 32 picks (even weaker) -- MUST trip at the 1MB pin. */
const every32MustFailAlloc = {
    name: 'RoundRobin.pick() into one small object every 32 picks (MUST allocate, intermittent)',
    setup() {
        const el = makePool();
        return { el, base: new RoundRobinBalancer(CAP, el) };
    },
    hot(s, n) {
        const rr = s.base;
        let sink = 0;
        for (let i = 0; i < n; i++) { const p = rr.pick(); if ((i & 31) === 0) { __mfRing[i & MF_RING_MASK] = { v: p }; } sink += p; }
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
    mustFail: [
        drawMustFailAlloc, rrMustFailAlloc, wrrMustFailAlloc, p2cMustFailAlloc,
        lcMustFailAlloc, sedMustFailAlloc, nqMustFailAlloc, peMustFailAlloc, chMustFailAlloc,
        blMustFailAlloc, wrMustFailAlloc, smallObjMustFailAlloc, strMustFailAlloc,
        every16MustFailAlloc, every32MustFailAlloc,
    ],
});

// ---------------------------------------------------------------------------
// REPORT-ONLY (NON-GATING) -- what the PLAIN-argument methods still cost (use the 1.1.0 `From` siblings)
// ---------------------------------------------------------------------------
// The gated lanes above prove 0 B/op on the Smi-ARGUMENT / Smi-KEY path. In REALISTIC use the hot
// double-taking / key-taking methods take an argument whose VALUE is a genuine NON-Smi double (a large
// or fractional clock, or a hash key >= 2^31 -- and about half of fnv1a's `x >>> 0` output is >= 2^31),
// which is boxed into a ~16 B HeapNumber at the NON-INLINED call boundary (measured, scales with op
// count). These lanes REPRODUCE that path and PRINT its 8N scavenge count every run so the limitation
// is visible; they do NOT assert and can NEVER fail the gate (report-only). Whether they read 0 or not
// depends on whether V8 inlines the call into this loop, run to run. The remedy shipped in 1.1.0: the
// `pickFrom` / `recordRttFrom` siblings (gated above at the same magnitudes) read the value from a
// caller-owned typed-array slot, so nothing crosses a call boxed.
const BIG_NOW = 1.7e15;            // a realistic hrtime-scale (ns) clock: a large double, not a Smi
const peakEwmaPickReal = {
    name: 'PeakEwmaBalancer.pick(now~1.7e15) REALISTIC large-double clock',
    setup() {
        const el = makePool();
        const inflight = new Uint32Array(CAP);
        for (let i = 0; i < CAP; i++) inflight[i] = i & 15;
        const pe = new PeakEwmaBalancer(CAP, el, inflight, 1e6, 0xABCDEF);
        for (let i = 0; i < CAP; i += 8) pe.recordRtt(i, (i & 31) * 1000, 0);
        return { el, inflight, pe, now: BIG_NOW, acc: 0 };
    },
    hot(s, n) {
        const pe = s.pe;
        let acc = s.acc | 0, now = s.now;   // `now` is a double: pick(now) boxes it at the boundary
        for (let i = 0; i < n; i++) { now += 1000; acc = (acc + pe.pick(now)) | 0; }
        s.acc = acc | 0; s.now = now;
    },
};
const peakEwmaRecordReal = {
    name: 'PeakEwmaBalancer.recordRtt(fractional sample, now~1.7e15) REALISTIC',
    setup() {
        const el = makePool();
        const inflight = new Uint32Array(CAP);
        const pe = new PeakEwmaBalancer(CAP, el, inflight, 1e6, 0xFEEDBEEF);
        return { el, inflight, pe, now: BIG_NOW };
    },
    hot(s, n) {
        const pe = s.pe;
        let now = s.now;                    // large double clock + a FRACTIONAL sample -> both box
        for (let i = 0; i < n; i++) { now += 1000; pe.recordRtt(i & MASK, (now % 500000) + 0.5, now); }
        s.now = now;
    },
};
const boundedLoadPickReal = {
    name: 'BoundedLoadBalancer.pick(key>=2^31 from Uint32Array) REALISTIC',
    setup() {
        const el = new Uint8Array(CH_CAP);
        for (let i = 0; i < CH_CAP; i += 2) el[i] = 1;
        const inflight = new Uint32Array(CH_CAP);
        let total = 0;
        for (let i = 0; i < CH_CAP; i++) { inflight[i] = i & 15; total += inflight[i]; }
        const bl = new BoundedLoadBalancer(CH_CAP, el, inflight, 0.25, null, CH_M, 0xABCDEF);
        bl.note(0, total);
        const keys = new Uint32Array(4096);
        for (let i = 0; i < keys.length; i++) keys[i] = (0x80000000 + i * 97) >>> 0;   // all >= 2^31
        return { el, inflight, bl, keys, ki: 0, acc: 0 };
    },
    hot(s, n) {
        const bl = s.bl, keys = s.keys, m = keys.length - 1;
        let acc = s.acc | 0, ki = s.ki | 0;
        for (let i = 0; i < n; i++) { const key = keys[ki & m]; ki++; acc = (acc + bl.pick(key)) | 0; }
        s.acc = acc | 0; s.ki = ki | 0;
    },
};
const consistentHashPickReal = {
    name: 'ConsistentHashBalancer.pick(key>=2^31 from Uint32Array) REALISTIC',
    setup() {
        const el = new Uint8Array(CH_CAP);
        for (let i = 0; i < CH_CAP; i += 2) el[i] = 1;
        const ch = new ConsistentHashBalancer(CH_CAP, el, null, CH_M, 0xABCDEF);
        const keys = new Uint32Array(4096);
        for (let i = 0; i < keys.length; i++) keys[i] = (0x80000000 + i * 97) >>> 0;   // all >= 2^31
        return { el, ch, keys, ki: 0, acc: 0 };
    },
    hot(s, n) {
        const ch = s.ch, keys = s.keys, m = keys.length - 1;
        let acc = s.acc | 0, ki = s.ki | 0;
        for (let i = 0; i < n; i++) { const key = keys[ki & m]; ki++; acc = (acc + ch.pick(key)) | 0; }
        s.acc = acc | 0; s.ki = ki | 0;
    },
};
const reportOnlyLanes = [peakEwmaPickReal, peakEwmaRecordReal, boundedLoadPickReal, consistentHashPickReal];
test('perf-gate REPORT-ONLY: realistic-argument boxing of the plain methods (non-gating)', async () => {
    // Prints scavenge counts for each report lane. It asserts NOTHING: a nonzero count here is a
    // documented item, not a gate failure.
    for (const sc of reportOnlyLanes) {
        try {
            const r = await measure(sc, { N: 200000, k: 8 });
            console.log('  REPORT-ONLY (plain argument; use the From sibling) | ' + sc.name +
                ' -- scavenges N: ' + r.minorLo + '  8N: ' + r.minorHi +
                ' (realistic double/large argument boxed at the non-inlined call boundary)');
        } catch (e) {
            console.log('  REPORT-ONLY (plain argument; use the From sibling) | ' + sc.name +
                ' -- measurement skipped: ' + (e && e.message ? e.message : String(e)));
        }
    }
});
