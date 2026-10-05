/**
 * @zakkster/lite-pick soak -- drift gates (audit RECOMMENDATIONS 1.2). PURE MODULE.
 *
 * No I/O, no process state: computeGates(rollups, opts) -> verdicts. The report tool (increment 2)
 * imports it to re-derive the same gates from a JSONL stream. Gates are computed PER LANE across
 * CYCLES (never lane-vs-lane, never JIT warm-up): for each lane+metric keep the first N post-warmup
 * cycles and a ring of the last N (O(1) memory, replacing the old unbounded SERIES_CAP). A drift
 * gate is ACTIVE only at >= 2*N post-warmup cycles; below that it reports SMOKE.
 *
 * Verdicts: PASS | FAIL | INCONCLUSIVE (exit 3) | SMOKE. The overall verdict is FAIL if any gate
 * FAILs, else INCONCLUSIVE if any is inconclusive OR the run lacks the evidence to judge (S5: a
 * non-smoke lane below the 2N active floor, or an interrupted run), else PASS. SMOKE gates never fail
 * a run, and a non-smoke run never PASSes on SMOKE gates.
 *
 * hotAlloc has three tiers (S1, audit 2026-09-29; FAIL tier added 2026-10-05, ADR 0014): the GROSS tier
 * FAILs on every window scavenged (>= a 4 MB semi-space per 8192-pick window, ~512 B/op) or a non-finite
 * measurement; the FAIL tier FAILs when the two-pass MIN B/op reaches HOTALLOC_FAIL (0.3) in >= 2 post-
 * warm-up cycles of a lane (a real steady-state allocation -- calibrated 2.05x below the lowest mutant MIN
 * and 2.1x above the worst clean MIN); the NOTE tier below merely REPORTS an over-bound lane (> HOTALLOC_MAX
 * or a per-pass recurrence). The MIN estimator (hot.mjs:263) is robust to V8 JIT deopt windows that box
 * doubles on a correct kernel on Node 22; per-op 0 B/op stays owned by PerfGate (test:perf, isolated
 * scavenge counting), retention by torture and the heap drift gate.
 */

export const VERDICT = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', INCONCLUSIVE: 'INCONCLUSIVE', SMOKE: 'SMOKE', STUB: 'STUB' });

// Every gate computeGates() judges: the per-lane gate keys (perLane[i].gates) plus the global totalPicks.
// The teeth coverage meta-test (test/SoakTeeth.test.js) proves this list equals what compute() returns
// and that each one is tripped by a must-fail control (or is a declared gap in teeth.mjs).
export const GATE_NAMES = Object.freeze(['gcMajor', 'hotAlloc', 'heap', 'rss', 'hotOps', 'hotOpsSparse', 'gcPause',
    'latencyP99', 'rebuild', 'totalPicks']);
// Judged and recorded, but NEVER a FAIL (verdict STUB; teeth burst 9c3, audit 2026-09-29):
//   rebuild -- the rebuild-storm phase yields ~8 timed rebuilds per lane-cycle, so a 5-cycle window never
//     reaches LAT_MIN_SAMPLES (2000): the gate could only ever be STUB. Explicit now, instead of implicit.
//   gcPause -- with semi-space pinned at 4 MB a scavenge copies at most ~4 MB, so the MEAN pause plateaus
//     near 1 ms (Apple M4) and cannot pass early*2+1 ms; every mutant that raised it far enough promoted
//     and tripped the hard gcMajor gate first (ring-of-survivors mutants: 1.05 ms vs a ~1.2 ms limit, and
//     0.43 ms with gcMajor + heap failing). A gate that can only fire on noise is pure flake risk (ADR 0014).
// test/SoakTeeth.test.js pins both: making either FAIL-capable again fails it until a control proves it.
export const REPORT_ONLY_GATES = Object.freeze(['rebuild', 'gcPause']);

// Named gate constants (one-line tunable; NEVER widen to make a gate pass).
export const HEAP_MULT = 1.10;         // late heap median <= early median * this ...
export const HEAP_SLACK_MB = 2;        //   ... + this many MB
export const RSS_MULT = 1.75;          // rss runaway: late-quarter p95 <= band-center median * this ...
export const RSS_SLACK_MB = 16;        //   ... + this many MB
export const HOTOPS_RATIO = 0.60;      // late hotOps median >= this * early median
export const GCPAUSE_MULT = 2;         // late MEAN-pause median <= early median * this ...
export const GCPAUSE_ADD_MS = 1;       //   ... + this many ms
export const GC_MAJOR_MAX = 0;         // hard: zero workload major GC per lane-cycle
export const LAT_P99_MULT = 1.5;       // latency p99 / rebuild p99: late <= early * this + addNs
export const LAT_ADD_TICKS = 2;        // wall-clock granularity floor = this * timerFloorNs (from
                                       // provenance): sub-us individual-pick timing is near performance.now()
                                       // resolution, so a pure 1.5x ratio false-fails on a <=1-tick wobble.
                                       // Two ticks is the minimal floor; a real regression exceeds it easily.
export const LAT_ADD_NS_FALLBACK = 100; // used only if timerFloorNs is unavailable
export const LAT_MIN_SAMPLES = 2000;   // per early/late window; below this the gate is INACTIVE (never PASS)
// S2 (audit 2026-09-29): a TIMING drift (hotOps, hotOpsSparse, latencyP99; gcPause computes the same test
// but is report-only since 9c3) FAILs only when it
// breaches its ratio bound (the minimum effect size, above) AND is statistically real: an exact one-sided
// Mann-Whitney test of the early vs late window gives p < MW_ALPHA. With N=5 per side the smallest
// attainable p is 1/252 = 0.004, so p < 0.01 needs (near-)complete separation of the two windows -- one or
// two noisy cycles can no longer FAIL a run. The early-window MAD is RECORDED, not gated: a "drop > 3 MAD"
// rule (the audit's suggestion) rejects exactly a gradual decay, whose own trend widens the early window
// (the decay teeth: drop 15.7M vs 3 x MAD 28M, while p = 0.004 and the ratio bound is clearly breached).
export const MW_ALPHA = 0.01;
export const HOTALLOC_MAX = 0.02;      // per post-warmup cycle: hot B/op MEAN above this is REPORTED
                                       // (a NOTE, not a breach -- S1). 0.02 is a hair above the warm noise
                                       // floor so even a 2-field object every 64th pick (~0.5 B/op) shows.
export const HOTALLOC_FAIL = 0.3;      // FAIL tier (maintainer decision 2026-10-05, calibrated in ADR 0014):
                                       // a lane whose two-pass MIN B/op (hot.mjs:263) reaches this in >= 2
                                       // post-warm-up cycles is a real steady-state allocation, not JIT noise.
                                       // 0.3 is 2.05x below M4's lowest mutant MIN (0.614) and 2.1x above the
                                       // audit's worst clean MIN (0.143). HOTALLOC_MAX stays the NOTE floor below.

/** O(1)-memory early/late accumulator: first N samples + a ring of the last N. */
export class EarlyLate {
    constructor(n) {
        this.n = n | 0;
        this.early = new Float64Array(this.n);
        this.earlyCount = 0;
        this.lateRing = new Float64Array(this.n);
        this.total = 0;
    }
    push(v) {
        if (this.earlyCount < this.n) this.early[this.earlyCount++] = v;
        this.lateRing[this.total % this.n] = v;
        this.total++;
    }
    get lateCount() { return this.total < this.n ? this.total : this.n; }
    earlyMedian() { return medianOf(this.early, this.earlyCount); }
    lateMedian() { return medianOf(this.lateRing, this.lateCount); }
    earlySum() { let s = 0; for (let i = 0; i < this.earlyCount; i++) s += this.early[i]; return s; }
    lateSum() { let s = 0; const c = this.lateCount; for (let i = 0; i < c; i++) s += this.lateRing[i]; return s; }
}

/** A latency-style drift gate (latencyP99 / rebuild p99): late median <= early median * LAT_P99_MULT,
 * ACTIVE only when the early AND late windows each hold >= LAT_MIN_SAMPLES; else report-only (never PASS
 * vacuously). Returns a gate object; pushes a breach to `breaches` on FAIL. */
function latencyGate(name, laneName, elVal, elSamples, smoke, active, reportOnly, addNs, breaches) {
    const earlyS = elSamples.earlySum(), lateS = elSamples.lateSum();
    if (smoke || !active) return { verdict: VERDICT.SMOKE, earlySamples: earlyS, lateSamples: lateS };
    if (reportOnly) return { verdict: VERDICT.STUB, reportOnly: true, earlySamples: earlyS, lateSamples: lateS };
    if (earlyS < LAT_MIN_SAMPLES || lateS < LAT_MIN_SAMPLES) {
        return { verdict: VERDICT.STUB, reason: 'insufficientSamples', earlySamples: earlyS, lateSamples: lateS, minSamples: LAT_MIN_SAMPLES };
    }
    const { early, late, p } = shiftStats(elVal, +1);
    const limit = early * LAT_P99_MULT + addNs;
    // S2: over the limit AND a significant upward shift (one noisy late cycle no longer FAILs).
    const verdict = (late > limit && p < MW_ALPHA) ? VERDICT.FAIL : VERDICT.PASS;
    if (verdict === VERDICT.FAIL) breaches.push(name + '[' + laneName + '] late=' + r0(late) + 'ns > limit=' + r0(limit) + 'ns (early=' + r0(early) + ', floor=' + r0(addNs) + 'ns, p=' + p.toFixed(4) + ')');
    return { verdict, earlyMedianNs: r0(early), lateMedianNs: r0(late), limitNs: r0(limit), floorNs: r0(addNs), p: +p.toFixed(4), earlySamples: earlyS, lateSamples: lateS };
}

/** Median absolute deviation of the first `count` values. */
function madOf(arr, count) {
    if (count === 0) return 0;
    const med = medianOf(arr, count);
    const dev = new Float64Array(count);
    for (let i = 0; i < count; i++) dev[i] = Math.abs(arr[i] - med);
    return medianOf(dev, count);
}

const uDistMemo = new Map();
/** Exact null distribution of the Mann-Whitney U for sample sizes (m, n): counts[u] = number of the
 * C(m+n, m) equally likely orderings with U = u. f(m,n)[u] = f(m-1,n)[u-n] + f(m,n-1)[u]. */
function uDist(m, n) {
    const key = m + ',' + n;
    const hit = uDistMemo.get(key);
    if (hit) return hit;
    let out;
    if (m === 0 || n === 0) out = [1];
    else {
        const a = uDist(m - 1, n), b = uDist(m, n - 1);
        out = new Array(m * n + 1).fill(0);
        for (let u = 0; u < a.length; u++) out[u + n] += a[u];
        for (let u = 0; u < b.length; u++) out[u] += b[u];
    }
    uDistMemo.set(key, out);
    return out;
}

/**
 * Exact one-sided Mann-Whitney p-value that the LATE window is shifted in direction `dir` (+1 = higher,
 * -1 = lower) relative to the EARLY window. S = #pairs where late is beyond early in `dir` (+0.5 per tie);
 * p = P(U >= floor(S)) under H0. Rounding S down is conservative (a larger p, fewer false FAILs).
 */
export function mwOneSidedP(early, m, late, n, dir) {
    if (m === 0 || n === 0) return 1;
    let s = 0;
    for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
        const d = (late[j] - early[i]) * dir;
        s += d > 0 ? 1 : (d === 0 ? 0.5 : 0);
    }
    const counts = uDist(m, n);
    let total = 0, tail = 0;
    const k = Math.floor(s);
    for (let u = 0; u < counts.length; u++) { total += counts[u]; if (u >= k) tail += counts[u]; }
    return tail / total;
}

/** Early/late shift statistics for a drift gate: medians, early MAD, one-sided MW p in `dir`. */
function shiftStats(el, dir) {
    return {
        early: el.earlyMedian(), late: el.lateMedian(),
        mad: madOf(el.early, el.earlyCount),
        p: mwOneSidedP(el.early, el.earlyCount, el.lateRing, el.lateCount, dir),
    };
}

function medianOf(arr, count) {
    if (count === 0) return 0;
    const a = Array.prototype.slice.call(arr, 0, count).sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function percentileOf(list, p) {
    if (!list.length) return 0;
    const a = list.slice().sort((x, y) => x - y);
    const idx = Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1));
    return a[idx];
}

/** Bounded RSS series for the runaway guard (S4: O(1) memory). `bandCenter()` is the median of a
 * decimating buffer -- every sample while <= RSS_KEEP, then every 2nd, 4th, ... (deterministic, evenly
 * spread over the whole run); `lateP95()` is the p95 of the last quarter of the run, capped at the last
 * RSS_LATE samples. Both equal the old unbounded list's values for runs of <= RSS_KEEP samples. */
export const RSS_KEEP = 1024;
export const RSS_LATE = 256;
class RssSeries {
    constructor() {
        this.buf = new Float64Array(RSS_KEEP);
        this.len = 0;
        this.stride = 1;
        this.ring = new Float64Array(RSS_LATE);
        this.total = 0;
    }
    push(v) {
        const i = this.total++;
        this.ring[i % RSS_LATE] = v;
        if (i % this.stride !== 0) return;
        if (this.len === RSS_KEEP) {
            // keep every 2nd retained sample (those with index % (2*stride) === 0), then double the stride
            for (let k = 0; k < RSS_KEEP / 2; k++) this.buf[k] = this.buf[2 * k];
            this.len = RSS_KEEP / 2;
            this.stride *= 2;
            if (i % this.stride !== 0) return;
        }
        this.buf[this.len++] = v;
    }
    bandCenter() { return medianOf(this.buf, this.len); }
    lateP95() {
        let q = Math.max(1, Math.floor(this.total / 4));
        if (q > RSS_LATE) q = RSS_LATE;
        if (q > this.total) q = this.total;
        const out = [];
        for (let k = this.total - q; k < this.total; k++) out.push(this.ring[k % RSS_LATE]);
        return percentileOf(out, 0.95);
    }
}

function newLaneState(N) {
    return {
        post: 0, firstTier: null,
        elHeap: new EarlyLate(N), elRss: new EarlyLate(N),
        elOps: new EarlyLate(N), elOpsSparse: new EarlyLate(N), elPause: new EarlyLate(N),
        elLatP999: new EarlyLate(N), elLatSamples: new EarlyLate(N),
        elRebuildP99: new EarlyLate(N), elRebuildSamples: new EarlyLate(N),
        rss: new RssSeries(),
        gcMajorMax: 0, hotAllocWorst: 0, hotAllocMeasured: 0, hotAllocScavengedFail: false,
        hotAllocNonFinite: false, pauseMissing: false,
        hotAllocPassMaxOver: 0,   // NIT1: post-warmup cycles where max(pass1,pass2) B/op > bound
        hotAllocFailCycles: 0,    // post-warmup cycles whose two-pass MIN B/op reached HOTALLOC_FAIL (FAIL tier)
        hotAllocFailWorst: 0,     // worst (max) MIN B/op among those failing cycles
        lanePicks: 0, warmPicks: 0,
    };
}

/** Fold one post-warmup cycle record into its lane's state (O(1) memory per lane). */
function pushRow(st, r) {
    st.post++;
    if (st.firstTier === null) st.firstTier = r.tier;
    st.elHeap.push(r.heapUsedMB);
    st.elRss.push(r.rssMB);
    st.elOps.push(r.hotOpsDense);
    st.elOpsSparse.push(r.hotOpsSparse);
    // S2: the MEAN workload pause (gcPauseAvgMs) is the gcPause metric (report-only since 9c3); the per-cycle
    // max (gcPauseMs) is telemetry. A record without it (a pre-S2 stream) marks the metric missing.
    if (typeof r.gcPauseAvgMs === 'number' && Number.isFinite(r.gcPauseAvgMs)) st.elPause.push(r.gcPauseAvgMs);
    else st.pauseMissing = true;
    // Gate on p99 (top 1% ~ 960 of 96000 samples): p999 individual sub-microsecond-pick timing is
    // dominated by rare OS-scheduling jitter in the tail, not kernel drift, so a 1.5x p999 ratio
    // false-fails a clean kernel. p99 is the robust kernel tail; a growing stall still inflates it.
    // p999/max remain in the cycle record (informational).
    const lat = r.latency || { p99: 0, samples: 0 };
    st.elLatP999.push(lat.p99); st.elLatSamples.push(lat.samples);
    st.elRebuildP99.push(r.rebuildP99 || 0); st.elRebuildSamples.push(r.rebuildSamples || 0);
    st.rss.push(r.rssMB);
    if (r.gcMajor > st.gcMajorMax) st.gcMajorMax = r.gcMajor;
    st.lanePicks += r.totalPicks;
    // hotAlloc: EVERY post-warmup cycle is measured. The B/op probe runs at ctx.now=0, so a cycle
    // whose WORKLOAD clock went into the boxing range still measures the true 0-alloc steady state
    // -- no boxingRegime exclusion (NIT C: it needlessly halved PeakEWMA coverage).
    if (r.hotBopNonFinite) {
        // A non-finite measured B/op is recorded as null (JSON drops Infinity) + this flag. It is a
        // measurement FAIL (Infinity), re-derivable from the JSONL by the report tool.
        st.hotAllocMeasured++;
        st.hotAllocWorst = Infinity;
        st.hotAllocNonFinite = true;
    } else if (r.hotBytesPerOp !== null && r.hotBytesPerOp !== undefined) {
        st.hotAllocMeasured++;
        // NaN-closed: a non-finite measured value is a FAIL (Infinity), never a silent pass via a
        // `NaN > worst` that evaluates false.
        if (!Number.isFinite(r.hotBytesPerOp)) { st.hotAllocWorst = Infinity; st.hotAllocNonFinite = true; }
        else {
            if (r.hotBytesPerOp > st.hotAllocWorst) st.hotAllocWorst = r.hotBytesPerOp;
            // FAIL tier (maintainer decision 2026-10-05): a MIN B/op at or above HOTALLOC_FAIL is a real
            // steady-state allocation; count such post-warm-up cycles and track the worst (>= 2 FAILs).
            if (r.hotBytesPerOp >= HOTALLOC_FAIL) {
                st.hotAllocFailCycles++;
                if (r.hotBytesPerOp > st.hotAllocFailWorst) st.hotAllocFailWorst = r.hotBytesPerOp;
            }
        }
    } else if (r.hotBopGcFree === 0) {
        // EVERY window scavenged -> sustained allocation (>= a semi-space per window) -> a heavy
        // leak, NOT "unmeasurable". This is a FAIL, never a silent skip.
        st.hotAllocScavengedFail = true;
    }
    // NIT1 recurrence: a periodic allocation RARER than one pass lands in only one pass per cycle
    // (so the MIN `bop` misses it, like a one-off) but RECURS every cycle. Count cycles where the
    // per-pass max exceeds the bound; >=2 is periodic (a true one-off happens ~once per process).
    if (r.hotBopPassMax !== null && r.hotBopPassMax !== undefined &&
        (!Number.isFinite(r.hotBopPassMax) || r.hotBopPassMax > HOTALLOC_MAX)) st.hotAllocPassMaxOver++;
    }

/**
 * Streaming gate state (S4, audit 2026-09-29): main.mjs pushes each cycle record as it is produced and
 * keeps NO record array, so the harness's own memory is O(lanes), not O(cycles) -- an unbounded record
 * list grew the post-GC heap ~1 KB per record and tripped the heap gate on long runs. Records must arrive
 * in cycle order per lane (main produces them so; computeGates sorts). Records of an unknown lane or a
 * warm-up cycle are ignored.
 */
export class GateAccumulator {
    /** @param {object} opts { warmupCycles, gateN, lanes: [names] } */
    constructor(opts) {
    this.warmup = opts.warmupCycles | 0;
    this.N = opts.gateN | 0;
    this.lanes = new Map();
    for (const nm of opts.lanes) this.lanes.set(nm, newLaneState(this.N));
    }
    push(r) {
    const st = this.lanes.get(r.lane);
    if (st === undefined) return;
    // A warm-up record is not folded into the drift/alloc state, but its picks ARE work: count them so a
    // run that completed ONLY the warm-up cycle is INCONCLUSIVE (S5), never "the soak did nothing" (FAIL).
    if (r.cycle < this.warmup) { st.warmPicks += (r.totalPicks | 0); return; }
    pushRow(st, r);
    }
    /**
     * @param {object} opts { smoke, lanes: [names], interrupted (bool: a bounded run that did not reach its
     *        end -- S5), timerFloorNs, poolLaunched }
     */
    compute(opts) {
    const N = this.N;
    const activeFloor = 2 * N;
    const lanes = opts.lanes;
    // Latency granularity floor = LAT_ADD_TICKS * timerFloorNs (from provenance); clean lanes wobble <= 1
    // tick, a real regression exceeds 2 ticks easily. Falls back if the timer floor is unavailable.
    const latAddNs = opts.timerFloorNs > 0 ? LAT_ADD_TICKS * opts.timerFloorNs : LAT_ADD_NS_FALLBACK;
    const breaches = [];
    const notes = [];          // report-only observations (hotAlloc over bound): printed, never a verdict
    const inconclusive = [];   // S5: why the run cannot be judged (evidence missing), never a silent PASS
    const perLane = [];
    let sawFail = false, sawInconclusive = false;

    let totalPicksAll = 0;

    for (const laneName of lanes) {
        const st = this.lanes.get(laneName) || newLaneState(N);
        const { post, elHeap, elOps, elOpsSparse, elPause, elLatP999, elLatSamples, elRebuildP99,
            elRebuildSamples, gcMajorMax, hotAllocWorst, hotAllocMeasured, hotAllocScavengedFail,
            hotAllocNonFinite, hotAllocPassMaxOver, hotAllocFailCycles, hotAllocFailWorst, lanePicks, warmPicks } = st;
        totalPicksAll += lanePicks + warmPicks;

        // --- always-active per-cycle gates -----------------------------------------------------
        const gcMajorGate = { verdict: post >= 1 ? (gcMajorMax <= GC_MAJOR_MAX ? VERDICT.PASS : VERDICT.FAIL) : VERDICT.SMOKE, observed: gcMajorMax, bound: GC_MAJOR_MAX };
        if (gcMajorGate.verdict === VERDICT.FAIL) breaches.push('gcMajor[' + laneName + '] observed=' + gcMajorMax + ' > ' + GC_MAJOR_MAX);

        // hotAlloc (S1): the GROSS tier FAILs first -- every window scavenged (sustained allocation,
        // ~512+ B/op) or a non-finite measurement (a broken probe never passes). Over-bound below that
        // is REPORT-ONLY (verdict STUB + a NOTE). INCONCLUSIVE stays reserved for "nothing was measured",
        // which must never PASS with worst=0.
        const hotAllocRecur = hotAllocPassMaxOver >= 2;
        const hotAllocOver = hotAllocWorst > HOTALLOC_MAX || hotAllocRecur;
        // FAIL tier (maintainer decision 2026-10-05, ADR 0014): >= 2 post-warm-up cycles whose MIN B/op
        // reached HOTALLOC_FAIL. The gross tier (every window scavenged / non-finite) stays above it; the
        // over-bound NOTE tier stays below.
        const hotAllocFail = hotAllocFailCycles >= 2;
        let hotAllocVerdict;
        if (post < 1) hotAllocVerdict = VERDICT.SMOKE;
        else if (hotAllocScavengedFail || hotAllocNonFinite) hotAllocVerdict = VERDICT.FAIL;
        else if (hotAllocFail) hotAllocVerdict = VERDICT.FAIL;
        else if (hotAllocMeasured === 0) hotAllocVerdict = VERDICT.INCONCLUSIVE;
        else if (hotAllocOver) hotAllocVerdict = VERDICT.STUB;
        else hotAllocVerdict = VERDICT.PASS;
        const hotAllocGate = { verdict: hotAllocVerdict, reportOnly: hotAllocVerdict === VERDICT.STUB, observedMax: hotAllocWorst, measured: hotAllocMeasured, scavengedFail: hotAllocScavengedFail, nonFinite: hotAllocNonFinite, passMaxOver: hotAllocPassMaxOver, failCycles: hotAllocFailCycles, failWorst: +hotAllocFailWorst.toFixed(3), bound: HOTALLOC_MAX, failBound: HOTALLOC_FAIL };
        if (hotAllocVerdict === VERDICT.FAIL) {
            if (hotAllocScavengedFail || hotAllocNonFinite) breaches.push('hotAlloc[' + laneName + '] ' + (hotAllocScavengedFail ? 'every window scavenged (sustained allocation)' : 'non-finite B/op measurement'));
            else breaches.push('hotAlloc[' + laneName + '] bop=' + hotAllocFailWorst.toFixed(3) + ' cycles=' + hotAllocFailCycles + ' >= ' + HOTALLOC_FAIL + ' B/op');
        }
        else if (hotAllocVerdict === VERDICT.INCONCLUSIVE) inconclusive.push('hotAlloc[' + laneName + '] measured no GC-free window');
        else if (hotAllocVerdict === VERDICT.STUB) notes.push('hotAlloc[' + laneName + '] ' + (hotAllocWorst > HOTALLOC_MAX ? 'max=' + hotAllocWorst.toFixed(3) : 'per-pass max over bound in ' + hotAllocPassMaxOver + ' cycles') + ' > ' + HOTALLOC_MAX + ' B/op (report-only; PerfGate owns per-op 0 B/op)');

        // tiny lanes report throughput/latency, never fail on it (cap in {1,2,3} is a degenerate regime).
        const reportOnlyThroughput = st.firstTier === 'tiny';
        // --- drift gates: active only at >= 2N post-warmup cycles -------------------------------
        let heapGate, rssGate, opsGate, opsSparseGate, pauseGate;
        if (opts.smoke || post < activeFloor) {
            heapGate = { verdict: VERDICT.SMOKE, needCycles: activeFloor, have: post };
            rssGate = { verdict: VERDICT.SMOKE, needCycles: activeFloor, have: post };
            opsGate = { verdict: VERDICT.SMOKE, needCycles: activeFloor, have: post };
            opsSparseGate = { verdict: VERDICT.SMOKE, needCycles: activeFloor, have: post };
            pauseGate = { verdict: VERDICT.SMOKE, needCycles: activeFloor, have: post };
        } else {
            const heapEarly = elHeap.earlyMedian(), heapLate = elHeap.lateMedian();
            const heapLimit = heapEarly * HEAP_MULT + HEAP_SLACK_MB;
            heapGate = { verdict: heapLate <= heapLimit ? VERDICT.PASS : VERDICT.FAIL, earlyMedianMB: r1(heapEarly), lateMedianMB: r1(heapLate), limitMB: r1(heapLimit) };
            if (heapGate.verdict === VERDICT.FAIL) breaches.push('heap[' + laneName + '] late=' + r1(heapLate) + 'MB > limit=' + r1(heapLimit) + 'MB');

            const bandCenter = st.rss.bandCenter();
            const lateP95 = st.rss.lateP95();
            const rssLimit = bandCenter * RSS_MULT + RSS_SLACK_MB;
            rssGate = { verdict: lateP95 <= rssLimit ? VERDICT.PASS : VERDICT.FAIL, bandCenterMB: r1(bandCenter), lateP95MB: r1(lateP95), limitMB: r1(rssLimit) };
            if (rssGate.verdict === VERDICT.FAIL) breaches.push('rss[' + laneName + '] lateP95=' + r1(lateP95) + 'MB > limit=' + r1(rssLimit) + 'MB');

            // S2: throughput FAILs only if the late median is below the ratio bound AND the one-sided
            // Mann-Whitney p < MW_ALPHA (late really is slower, not one noisy cycle).
            const ops = shiftStats(elOps, -1);
            const opsLimit = HOTOPS_RATIO * ops.early;
            const opsFail = ops.late < opsLimit && ops.p < MW_ALPHA;
            opsGate = { verdict: reportOnlyThroughput ? VERDICT.STUB : (opsFail ? VERDICT.FAIL : VERDICT.PASS), earlyMedian: r0(ops.early), lateMedian: r0(ops.late), limit: r0(opsLimit), earlyMad: r0(ops.mad), p: +ops.p.toFixed(4), reportOnly: reportOnlyThroughput };
            if (opsGate.verdict === VERDICT.FAIL) breaches.push('hotOps[' + laneName + '] dense late=' + r0(ops.late) + ' < limit=' + r0(opsLimit) + ' (p=' + ops.p.toFixed(4) + ')');

            const sp = shiftStats(elOpsSparse, -1);
            const spLimit = HOTOPS_RATIO * sp.early;
            const spFail = sp.late < spLimit && sp.p < MW_ALPHA;
            opsSparseGate = { verdict: reportOnlyThroughput ? VERDICT.STUB : (spFail ? VERDICT.FAIL : VERDICT.PASS), earlyMedian: r0(sp.early), lateMedian: r0(sp.late), limit: r0(spLimit), earlyMad: r0(sp.mad), p: +sp.p.toFixed(4), reportOnly: reportOnlyThroughput };
            if (opsSparseGate.verdict === VERDICT.FAIL) breaches.push('hotOpsSparse[' + laneName + '] late=' + r0(sp.late) + ' < limit=' + r0(spLimit) + ' (p=' + sp.p.toFixed(4) + ')');

            // gcPause is REPORT-ONLY (REPORT_ONLY_GATES): the MEAN pause, same significance rule upward, is
            // computed and recorded (wouldFail), never a breach and never INCONCLUSIVE.
            if (st.pauseMissing) {
                pauseGate = { verdict: VERDICT.STUB, reportOnly: true, reason: 'gcPauseAvgMs missing from a record' };
            } else {
                const pz = shiftStats(elPause, +1);
                const pLimit = pz.early * GCPAUSE_MULT + GCPAUSE_ADD_MS;
                const pFail = pz.late > pLimit && pz.p < MW_ALPHA;
                pauseGate = { verdict: VERDICT.STUB, reportOnly: true, wouldFail: pFail, earlyMedianMs: r2(pz.early), lateMedianMs: r2(pz.late), limitMs: r2(pLimit), earlyMadMs: r2(pz.mad), p: +pz.p.toFixed(4) };
            }
        }

        const gates = {
            gcMajor: gcMajorGate, hotAlloc: hotAllocGate,
            heap: heapGate, rss: rssGate, hotOps: opsGate, hotOpsSparse: opsSparseGate, gcPause: pauseGate,
            // T16: latency p99 drift (report-only for tiny lanes) + rebuild p99 (REPORT-ONLY everywhere, see
            // REPORT_ONLY_GATES). p999/max are in the cycle record; latency gates on p99 (the robust tail).
            latencyP99: latencyGate('latencyP99', laneName, elLatP999, elLatSamples, opts.smoke, post >= activeFloor, reportOnlyThroughput, latAddNs, breaches),
            rebuild: latencyGate('rebuild', laneName, elRebuildP99, elRebuildSamples, opts.smoke, post >= activeFloor, true, latAddNs, breaches),
        };
        for (const k of Object.keys(gates)) {
            const v = gates[k].verdict;
            if (v === VERDICT.FAIL) sawFail = true;
            else if (v === VERDICT.INCONCLUSIVE) sawInconclusive = true;
        }
        // S5: a non-smoke lane below the active floor has SMOKE drift gates -- not enough evidence.
        if (!opts.smoke && post < activeFloor) inconclusive.push('lane ' + laneName + ' ran ' + post + ' post-warmup cycle(s); drift gates need ' + activeFloor + (post === 0 ? ' -- only the warm-up cycle completed' : ''));
        perLane.push({ lane: laneName, postWarmupCycles: post, gates });
    }
    // S5: a bounded run stopped before its end (signal, crash) is never a PASS.
    if (opts.interrupted) inconclusive.push('run interrupted before its end');

    // totalPicks gate (global): a soak that did nothing must never pass.
    const allWork = totalPicksAll + (opts.poolLaunched || 0);   // kernel/tiny picks + pool runs
    const totalPicksGate = { verdict: allWork > 0 ? VERDICT.PASS : VERDICT.FAIL, totalPicks: totalPicksAll, poolLaunched: opts.poolLaunched || 0 };
    if (totalPicksGate.verdict === VERDICT.FAIL) { breaches.push('totalPicks=0 -- the soak did nothing'); sawFail = true; }

    const verdict = sawFail ? VERDICT.FAIL : ((sawInconclusive || inconclusive.length !== 0) ? VERDICT.INCONCLUSIVE : VERDICT.PASS);
    return { verdict, breaches, notes, inconclusive, perLane, totalPicks: totalPicksGate, active: !opts.smoke };
    }
}

/**
 * Re-derive the gates from a full record array (the report tool: it can afford the memory). The SAME
 * accumulator main.mjs streams into, so the two always agree.
 * @param {Array} rollups per-lane-cycle records: { lane, cycle, tier, heapUsedMB, rssMB, hotOpsDense,
 *        hotOpsSparse, gcMajor, gcPauseMs, hotBytesPerOp (number|null), totalPicks, latency, ... }
 * @param {object} opts { warmupCycles, gateN, smoke, lanes: [names], interrupted, timerFloorNs, poolLaunched }
 */
export function computeGates(rollups, opts) {
    const acc = new GateAccumulator(opts);
    const rows = rollups.slice().sort((x, y) => x.cycle - y.cycle);   // stable: per-lane order preserved
    for (const r of rows) acc.push(r);
    return acc.compute(opts);
}

/** Map a verdict to a process exit code. */
export function exitCodeFor(verdict) {
    if (verdict === VERDICT.FAIL) return 1;
    if (verdict === VERDICT.INCONCLUSIVE) return 3;
    return 0;
}

function r0(x) { return +x.toFixed(0); }
function r1(x) { return +x.toFixed(1); }
function r2(x) { return +x.toFixed(2); }
