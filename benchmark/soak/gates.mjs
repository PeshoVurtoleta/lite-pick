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
 * hotAlloc is REPORT-ONLY below the gross tier (S1, audit 2026-09-29): in a long-lived multi-lane
 * process, V8 JIT state (shared step functions + fresh instances per lane-cycle -> deopt windows that
 * box doubles) shows 8-20 B/op on a correct kernel on Node 22. Per-op 0 B/op is owned by PerfGate
 * (test:perf, isolated scavenge counting); retention by torture and the heap drift gate. The soak keeps
 * measuring and reports an over-bound lane as a NOTE; it still FAILs on the gross tier (every window
 * scavenged = >= a 4 MB semi-space per 8192-pick window, ~512 B/op) and on a non-finite measurement.
 */

export const VERDICT = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', INCONCLUSIVE: 'INCONCLUSIVE', SMOKE: 'SMOKE', STUB: 'STUB' });

// Named gate constants (one-line tunable; NEVER widen to make a gate pass).
export const HEAP_MULT = 1.10;         // late heap median <= early median * this ...
export const HEAP_SLACK_MB = 2;        //   ... + this many MB
export const RSS_MULT = 1.75;          // rss runaway: late-quarter p95 <= band-center median * this ...
export const RSS_SLACK_MB = 16;        //   ... + this many MB
export const HOTOPS_RATIO = 0.60;      // late hotOps median >= this * early median
export const GCPAUSE_MULT = 2;         // late gcPause median <= early median * this ...
export const GCPAUSE_ADD_MS = 1;       //   ... + this many ms
export const GC_MAJOR_MAX = 0;         // hard: zero workload major GC per lane-cycle
export const LAT_P999_MULT = 1.5;      // latency p99 / rebuild p99: late <= early * this + addNs
export const LAT_ADD_TICKS = 2;        // wall-clock granularity floor = this * timerFloorNs (from
                                       // provenance): sub-us individual-pick timing is near performance.now()
                                       // resolution, so a pure 1.5x ratio false-fails on a <=1-tick wobble.
                                       // Two ticks is the minimal floor; a real regression exceeds it easily.
export const LAT_ADD_NS_FALLBACK = 100; // used only if timerFloorNs is unavailable
export const LAT_MIN_SAMPLES = 2000;   // per early/late window; below this the gate is INACTIVE (never PASS)
export const HOTALLOC_MAX = 0.02;      // per post-warmup cycle: hot B/op MEAN above this is REPORTED
                                       // (a NOTE, not a breach -- S1). 0.02 is a hair above the warm noise
                                       // floor so even a 2-field object every 64th pick (~0.5 B/op) shows.

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

/** A latency-style drift gate (latencyP999 / rebuild p99): late median <= early median * LAT_P999_MULT,
 * ACTIVE only when the early AND late windows each hold >= LAT_MIN_SAMPLES; else report-only (never PASS
 * vacuously). Returns a gate object; pushes a breach to `breaches` on FAIL. */
function latencyGate(name, laneName, elVal, elSamples, smoke, active, reportOnly, addNs, breaches) {
    const earlyS = elSamples.earlySum(), lateS = elSamples.lateSum();
    if (smoke || !active) return { verdict: VERDICT.SMOKE, earlySamples: earlyS, lateSamples: lateS };
    if (reportOnly) return { verdict: VERDICT.STUB, reportOnly: true, earlySamples: earlyS, lateSamples: lateS };
    if (earlyS < LAT_MIN_SAMPLES || lateS < LAT_MIN_SAMPLES) {
        return { verdict: VERDICT.STUB, reason: 'insufficientSamples', earlySamples: earlyS, lateSamples: lateS, minSamples: LAT_MIN_SAMPLES };
    }
    const early = elVal.earlyMedian(), late = elVal.lateMedian();
    const limit = early * LAT_P999_MULT + addNs;
    const verdict = late <= limit ? VERDICT.PASS : VERDICT.FAIL;
    if (verdict === VERDICT.FAIL) breaches.push(name + '[' + laneName + '] late=' + r0(late) + 'ns > limit=' + r0(limit) + 'ns (early=' + r0(early) + ', floor=' + r0(addNs) + 'ns)');
    return { verdict, earlyMedianNs: r0(early), lateMedianNs: r0(late), limitNs: r0(limit), floorNs: r0(addNs), earlySamples: earlyS, lateSamples: lateS };
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

function medianList(list) {
    if (!list.length) return 0;
    const a = list.slice().sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * @param {Array} rollups per-lane-cycle records: { lane, cycle, tier, heapUsedMB, rssMB,
 *        hotOpsPerSec, gcMajor, gcPauseMs, hotBytesPerOp (number|null), totalPicks, boxingRegime }
 * @param {object} opts { warmupCycles, gateN, smoke, lanes: [names], interrupted (bool: a bounded run
 *        that did not reach its end -- S5), timerFloorNs, poolLaunched }
 */
export function computeGates(rollups, opts) {
    const warmup = opts.warmupCycles | 0;
    const N = opts.gateN | 0;
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
        const rows = rollups
            .filter((r) => r.lane === laneName && r.cycle >= warmup)
            .sort((a, b) => a.cycle - b.cycle);
        const post = rows.length;

        const elHeap = new EarlyLate(N), elRss = new EarlyLate(N);
        const elOps = new EarlyLate(N), elOpsSparse = new EarlyLate(N), elPause = new EarlyLate(N);
        const elLatP999 = new EarlyLate(N), elLatSamples = new EarlyLate(N);
        const elRebuildP99 = new EarlyLate(N), elRebuildSamples = new EarlyLate(N);
        const rssList = [];
        let gcMajorMax = 0, hotAllocWorst = 0, hotAllocMeasured = 0, hotAllocScavengedFail = false;
        let hotAllocNonFinite = false;
        let hotAllocPassMaxOver = 0;   // NIT1: post-warmup cycles where max(pass1,pass2) B/op > bound
        let lanePicks = 0;

        for (const r of rows) {
            elHeap.push(r.heapUsedMB);
            elRss.push(r.rssMB);
            elOps.push(r.hotOpsDense);
            elOpsSparse.push(r.hotOpsSparse);
            elPause.push(r.gcPauseMs);
            // Gate on p99 (top 1% ~ 960 of 96000 samples): p999 individual sub-microsecond-pick timing is
            // dominated by rare OS-scheduling jitter in the tail, not kernel drift, so a 1.5x p999 ratio
            // false-fails a clean kernel. p99 is the robust kernel tail; a growing stall still inflates it.
            // p999/max remain in the cycle record (informational).
            const lat = r.latency || { p99: 0, samples: 0 };
            elLatP999.push(lat.p99); elLatSamples.push(lat.samples);
            elRebuildP99.push(r.rebuildP99 || 0); elRebuildSamples.push(r.rebuildSamples || 0);
            rssList.push(r.rssMB);
            if (r.gcMajor > gcMajorMax) gcMajorMax = r.gcMajor;
            lanePicks += r.totalPicks;
            // hotAlloc: EVERY post-warmup cycle is measured. The B/op probe runs at ctx.now=0, so a cycle
            // whose WORKLOAD clock went into the boxing range still measures the true 0-alloc steady state
            // -- no boxingRegime exclusion (NIT C: it needlessly halved PeakEWMA coverage).
            if (r.hotBopNonFinite) {
                // A non-finite measured B/op is recorded as null (JSON drops Infinity) + this flag. It is a
                // measurement FAIL (Infinity), re-derivable from the JSONL by the report tool.
                hotAllocMeasured++;
                hotAllocWorst = Infinity;
                hotAllocNonFinite = true;
            } else if (r.hotBytesPerOp !== null && r.hotBytesPerOp !== undefined) {
                hotAllocMeasured++;
                // NaN-closed: a non-finite measured value is a FAIL (Infinity), never a silent pass via a
                // `NaN > worst` that evaluates false.
                if (!Number.isFinite(r.hotBytesPerOp)) { hotAllocWorst = Infinity; hotAllocNonFinite = true; }
                else if (r.hotBytesPerOp > hotAllocWorst) hotAllocWorst = r.hotBytesPerOp;
            } else if (r.hotBopGcFree === 0) {
                // EVERY window scavenged -> sustained allocation (>= a semi-space per window) -> a heavy
                // leak, NOT "unmeasurable". This is a FAIL, never a silent skip.
                hotAllocScavengedFail = true;
            }
            // NIT1 recurrence: a periodic allocation RARER than one pass lands in only one pass per cycle
            // (so the MIN `bop` misses it, like a one-off) but RECURS every cycle. Count cycles where the
            // per-pass max exceeds the bound; >=2 is periodic (a true one-off happens ~once per process).
            if (r.hotBopPassMax !== null && r.hotBopPassMax !== undefined &&
                (!Number.isFinite(r.hotBopPassMax) || r.hotBopPassMax > HOTALLOC_MAX)) hotAllocPassMaxOver++;
        }
        totalPicksAll += lanePicks;

        // --- always-active per-cycle gates -----------------------------------------------------
        const gcMajorGate = { verdict: post >= 1 ? (gcMajorMax <= GC_MAJOR_MAX ? VERDICT.PASS : VERDICT.FAIL) : VERDICT.SMOKE, observed: gcMajorMax, bound: GC_MAJOR_MAX };
        if (gcMajorGate.verdict === VERDICT.FAIL) breaches.push('gcMajor[' + laneName + '] observed=' + gcMajorMax + ' > ' + GC_MAJOR_MAX);

        // hotAlloc (S1): the GROSS tier FAILs first -- every window scavenged (sustained allocation,
        // ~512+ B/op) or a non-finite measurement (a broken probe never passes). Over-bound below that
        // is REPORT-ONLY (verdict STUB + a NOTE). INCONCLUSIVE stays reserved for "nothing was measured",
        // which must never PASS with worst=0.
        const hotAllocRecur = hotAllocPassMaxOver >= 2;
        const hotAllocOver = hotAllocWorst > HOTALLOC_MAX || hotAllocRecur;
        let hotAllocVerdict;
        if (post < 1) hotAllocVerdict = VERDICT.SMOKE;
        else if (hotAllocScavengedFail || hotAllocNonFinite) hotAllocVerdict = VERDICT.FAIL;
        else if (hotAllocMeasured === 0) hotAllocVerdict = VERDICT.INCONCLUSIVE;
        else if (hotAllocOver) hotAllocVerdict = VERDICT.STUB;
        else hotAllocVerdict = VERDICT.PASS;
        const hotAllocGate = { verdict: hotAllocVerdict, reportOnly: hotAllocVerdict === VERDICT.STUB, observedMax: hotAllocWorst, measured: hotAllocMeasured, scavengedFail: hotAllocScavengedFail, nonFinite: hotAllocNonFinite, passMaxOver: hotAllocPassMaxOver, bound: HOTALLOC_MAX };
        if (hotAllocVerdict === VERDICT.FAIL) breaches.push('hotAlloc[' + laneName + '] ' + (hotAllocScavengedFail ? 'every window scavenged (sustained allocation)' : 'non-finite B/op measurement'));
        else if (hotAllocVerdict === VERDICT.INCONCLUSIVE) inconclusive.push('hotAlloc[' + laneName + '] measured no GC-free window');
        else if (hotAllocVerdict === VERDICT.STUB) notes.push('hotAlloc[' + laneName + '] ' + (hotAllocWorst > HOTALLOC_MAX ? 'max=' + hotAllocWorst.toFixed(3) : 'per-pass max over bound in ' + hotAllocPassMaxOver + ' cycles') + ' > ' + HOTALLOC_MAX + ' B/op (report-only; PerfGate owns per-op 0 B/op)');

        // tiny lanes report throughput/latency, never fail on it (cap in {1,2,3} is a degenerate regime).
        const reportOnlyThroughput = rows.length > 0 && rows[0].tier === 'tiny';
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

            const bandCenter = medianList(rssList);
            const q = Math.max(1, Math.floor(rssList.length / 4));
            const lateP95 = percentileOf(rssList.slice(rssList.length - q), 0.95);
            const rssLimit = bandCenter * RSS_MULT + RSS_SLACK_MB;
            rssGate = { verdict: lateP95 <= rssLimit ? VERDICT.PASS : VERDICT.FAIL, bandCenterMB: r1(bandCenter), lateP95MB: r1(lateP95), limitMB: r1(rssLimit) };
            if (rssGate.verdict === VERDICT.FAIL) breaches.push('rss[' + laneName + '] lateP95=' + r1(lateP95) + 'MB > limit=' + r1(rssLimit) + 'MB');

            const opsEarly = elOps.earlyMedian(), opsLate = elOps.lateMedian();
            const opsLimit = HOTOPS_RATIO * opsEarly;
            const opsFail = opsLate < opsLimit;
            opsGate = { verdict: reportOnlyThroughput ? VERDICT.STUB : (opsFail ? VERDICT.FAIL : VERDICT.PASS), earlyMedian: r0(opsEarly), lateMedian: r0(opsLate), limit: r0(opsLimit), reportOnly: reportOnlyThroughput };
            if (opsGate.verdict === VERDICT.FAIL) breaches.push('hotOps[' + laneName + '] dense late=' + r0(opsLate) + ' < limit=' + r0(opsLimit));

            const spEarly = elOpsSparse.earlyMedian(), spLate = elOpsSparse.lateMedian();
            const spLimit = HOTOPS_RATIO * spEarly;
            const spFail = spLate < spLimit;
            opsSparseGate = { verdict: reportOnlyThroughput ? VERDICT.STUB : (spFail ? VERDICT.FAIL : VERDICT.PASS), earlyMedian: r0(spEarly), lateMedian: r0(spLate), limit: r0(spLimit), reportOnly: reportOnlyThroughput };
            if (opsSparseGate.verdict === VERDICT.FAIL) breaches.push('hotOpsSparse[' + laneName + '] late=' + r0(spLate) + ' < limit=' + r0(spLimit));

            const pEarly = elPause.earlyMedian(), pLate = elPause.lateMedian();
            const pLimit = pEarly * GCPAUSE_MULT + GCPAUSE_ADD_MS;
            pauseGate = { verdict: pLate <= pLimit ? VERDICT.PASS : VERDICT.FAIL, earlyMedianMs: r2(pEarly), lateMedianMs: r2(pLate), limitMs: r2(pLimit) };
            if (pauseGate.verdict === VERDICT.FAIL) breaches.push('gcPause[' + laneName + '] late=' + r2(pLate) + 'ms > limit=' + r2(pLimit) + 'ms');
        }

        const gates = {
            gcMajor: gcMajorGate, hotAlloc: hotAllocGate,
            heap: heapGate, rss: rssGate, hotOps: opsGate, hotOpsSparse: opsSparseGate, gcPause: pauseGate,
            // T16: latency p99 drift + rebuild p99 drift (both report-only for tiny lanes). p999/max are
            // in the cycle record; the gate is on p99 (the robust tail; see the accumulation note above).
            latencyP99: latencyGate('latencyP99', laneName, elLatP999, elLatSamples, opts.smoke, post >= activeFloor, reportOnlyThroughput, latAddNs, breaches),
            rebuild: latencyGate('rebuild', laneName, elRebuildP99, elRebuildSamples, opts.smoke, post >= activeFloor, reportOnlyThroughput, latAddNs, breaches),
        };
        for (const k of Object.keys(gates)) {
            const v = gates[k].verdict;
            if (v === VERDICT.FAIL) sawFail = true;
            else if (v === VERDICT.INCONCLUSIVE) sawInconclusive = true;
        }
        // S5: a non-smoke lane below the active floor has SMOKE drift gates -- not enough evidence.
        if (!opts.smoke && post < activeFloor) inconclusive.push('lane ' + laneName + ' ran ' + post + ' post-warmup cycle(s); drift gates need ' + activeFloor);
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

/** Map a verdict to a process exit code. */
export function exitCodeFor(verdict) {
    if (verdict === VERDICT.FAIL) return 1;
    if (verdict === VERDICT.INCONCLUSIVE) return 3;
    return 0;
}

function r0(x) { return +x.toFixed(0); }
function r1(x) { return +x.toFixed(1); }
function r2(x) { return +x.toFixed(2); }
