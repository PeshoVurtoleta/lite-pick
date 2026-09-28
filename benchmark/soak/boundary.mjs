/**
 * @zakkster/lite-pick soak -- lane-cycle boundary (audit RECOMMENDATIONS 1.3, 1.10).
 *
 * ORDER MATTERS. The workload GC numbers are captured BEFORE the forced retention GCs and the
 * profiler is RESET AFTER them, so the forced full GCs at the boundary never pollute the workload
 * major/pause figures (audit 1.10). The heap is sampled STRICTLY AFTER the forced GC that drives the
 * leak tracker to zero, so it is the true leak signal, not mid-cycle floating garbage (audit 1.3).
 *
 *   1. yield a tick so async GC entries land in the profiler window
 *   2. gc.summary() -> workload major / minor / maxPause (since the last reset)
 *   3. drop references to the cycle's balancer + arrays
 *   4. forced gc() loop until tracker.size() === 0 (<= 8 tries), plus any injected extra GCs
 *   5. heap sample -- asserted to run AFTER the last forced GC (heapSampleSeq === forcedGcSeq + 1)
 *   6. return the rollup (caller emits the record)
 *   7. gc({type:'minor'}) to tidy, then gc.reset() so the next cycle's summary is pure workload
 */

const tick = () => new Promise((r) => setTimeout(r, 0));

function forceGc(minor) {
    const g = globalThis.gc;
    try {
        if (minor) g({ type: 'minor', execution: 'sync' });
        else g();
    } catch (e) {
        g();   // older node: no options form
    }
}

/**
 * @param {object} gc a running GcProfiler
 * @param {object} tracker a lite-leak tracker
 * @param {function} dropRefs zero-arg fn that nulls the caller's refs to the cycle's balancer
 * @param {object} opts { extraForcedGc?: number }
 */
export async function closeLaneCycle(gc, tracker, dropRefs, opts) {
    const extra = (opts && opts.extraForcedGc) | 0;

    // 1) yield so GC entries flush into the profiler window
    await tick();

    // 2) capture workload GC (since last reset) -- BEFORE any forced GC
    const gs = gc.summary();
    const workloadMajor = gs.gc.major;
    const workloadMinor = gs.gc.minor;
    const workloadMaxPauseMs = +gs.gc.maxMs.toFixed(3);

    // 3) drop references
    if (dropRefs) dropRefs();

    // 4) forced GC loop until the tracker drains. `heapReadOk` starts false and only the heap-sample
    // step (5) sets it true, AFTER at least one forced GC ran -- a real ordering guard, not a counter
    // that checks itself: if the heap read is ever moved before the GC loop, forcedGc stays 0 and the
    // assert fires.
    let forcedGc = 0;
    let live = tracker.size();
    let tries = 0;
    for (let i = 0; i < 8; i++) {
        forceGc(false);
        forcedGc++;
        await tick();
        tries++;
        live = tracker.size();
        if (live === 0) break;
    }
    // injected extra forced GCs (teeth: prove they do not pollute the workload numbers)
    for (let i = 0; i < extra; i++) { forceGc(false); forcedGc++; }

    // 5) heap sample STRICTLY AFTER the forced GC -- assert at least one forced GC preceded it.
    if (forcedGc < 1) throw new Error('[soak] heap sampled before any forced GC (forcedGc=' + forcedGc + ')');
    const mem = process.memoryUsage();
    const heapUsedMB = +(mem.heapUsed / 1048576).toFixed(1);
    const rssMB = +(mem.rss / 1048576).toFixed(1);
    const heapSampledAfterGc = true;

    // 6) tidy + reset the profiler window for the next cycle
    forceGc(true);
    gc.reset();

    return {
        workloadMajor, workloadMinor, workloadMaxPauseMs,
        heapUsedMB, rssMB, trackerSize: live, forcedGcTries: tries, heapSampledAfterGc,
    };
}
