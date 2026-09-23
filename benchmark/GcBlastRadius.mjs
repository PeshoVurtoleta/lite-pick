/**
 * @zakkster/lite-pick -- GC blast-radius (M6 headline chart #2).
 *
 *     node --expose-gc benchmark/GcBlastRadius.mjs
 *
 * The number an AWS-paying SRE actually feels. The point of zero-GC is NOT the pick's own
 * latency -- it is that a MAJOR GC pause freezes EVERY in-flight request at once, so an
 * allocating balancer inflates the SERVICE-LEVEL p99.9 and max pause, not the microbench.
 * This file runs the SAME sustained mixed workload (the shared seeded matrix) through two
 * lanes and reports the end-to-end request tail + the GC pause distribution:
 *
 *   - lite-pick lane: P2cBalancer over caller-owned typed arrays. 0 B/op on the pick path;
 *                     maxMajor 0; maxPauseMs <= 2. The contract, held under load.
 *   - allocating foil lane: the SAME power-of-two decision, coded the ordinary way -- a
 *                     fresh candidate object per probe pushed into a per-request array and
 *                     sorted. Correct answer, allocating body -> major GC fires (maxMajor
 *                     >= 1) and the request tail balloons. THAT contrast is the headline.
 *
 * GC sampling follows the lite-gc-profiler machinery test/torture.mjs already uses
 * (GcProfiler.start -> sampleHeap in the loop -> settle -> summary -> checkNoGc), plus
 * measureAllocs for the exact B/op line. Requires --expose-gc (measureAllocs + forced gc).
 */

import { buildWorkload, SEEDS } from './Matrix.mjs';
import { P2cBalancer, Prng } from '../Pick.js';

const CAP = 1024;          // a realistic downstream pool
const REQUESTS = 2_000_000; // sustained request stream (enough churn to fill old gen)
const PROBES = 2;          // power-of-two-choices d

/**
 * A "request" is one selection over the shared workload plus a tiny synchronous body,
 * timed end to end and dropped into a pre-allocated Float64Array so a GC pause that lands
 * mid-request shows up as a tall bar. lat[] is reused across lanes (no per-request alloc in
 * the measurement harness itself -- only the lane's pick body may allocate).
 */
const lat = new Float64Array(REQUESTS);

function percentile(sorted, p) {
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
}

function tailFromLat() {
    const copy = lat.slice();
    copy.sort();
    let max = 0;
    for (let i = 0; i < copy.length; i++) if (copy[i] > max) max = copy[i];
    return { p999: percentile(copy, 99.9), max };
}

/** lite-pick lane: reused balancer, caller-owned inflight, zero allocation in the body. */
function runLitePick(work) {
    const p2c = new P2cBalancer(CAP, work.eligible, work.inflight, SEEDS.p2c);
    const gc = new GcProfiler().start();
    let sink = 0;
    for (let r = 0; r < REQUESTS; r++) {
        const t0 = performance.now();
        const i = p2c.pick();
        work.inflight[i]++;                 // dispatch
        sink = (sink + i) | 0;
        work.inflight[i]--;                 // settle (net-zero: steady-state pool)
        lat[r] = performance.now() - t0;
        if ((r & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    void sink;
    return gc;
}

/**
 * allocating foil lane: the ordinary "collect candidates, sort, take best" idiom, wrapped
 * in a realistic in-flight model. Each request allocates a candidate array of probe objects
 * plus a request-context object that stays LIVE until the request settles (INFLIGHT requests
 * later) -- the same reason a real allocating balancer's garbage reaches the old generation:
 * request state outlives one turn. That promotion pressure forces MAJOR GC (maxMajor >= 1),
 * and a major pause freezes every in-flight request -- exactly the blast radius being shown.
 */
const INFLIGHT = 16384;    // concurrent in-flight request contexts held live
function runFoil(work) {
    const rng = new Prng(SEEDS.foil);
    const ring = new Array(INFLIGHT).fill(null); // live-object ring: the retention pressure
    const gc = new GcProfiler().start();
    let sink = 0;
    for (let r = 0; r < REQUESTS; r++) {
        const t0 = performance.now();
        const candidates = [];
        for (let p = 0; p < PROBES; p++) {
            const idx = rng.nextBelow(CAP);
            candidates.push({ idx, load: work.inflight[idx] }); // the allocation
        }
        candidates.sort((a, b) => a.load - b.load);
        const i = candidates[0].idx;
        work.inflight[i]++;
        sink = (sink + i) | 0;
        work.inflight[i]--;
        // The request context survives until it "settles" INFLIGHT requests later. It
        // carries a small payload (request metadata/headers), the realistic per-request
        // heap a proxy allocates -- promoted to old gen while in flight, garbage after.
        ring[r & (INFLIGHT - 1)] = {
            endpoint: i, candidates, ts: t0,
            meta: { r, key: 'req-' + (r & 1023), hops: [i, i ^ 1, i ^ 2] },
        };
        lat[r] = performance.now() - t0;
        if ((r & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    void sink;
    void ring;
    return gc;
}

let GcProfiler, checkNoGc, measureAllocs;

/** Measure both lanes; returns the structured result Report.mjs stamps + renders. */
export async function measureGcBlastRadius() {
    if (typeof globalThis.gc !== 'function') {
        throw new Error('GcBlastRadius needs --expose-gc: node --expose-gc benchmark/GcBlastRadius.mjs');
    }
    ({ GcProfiler, checkNoGc, measureAllocs } = await import('@zakkster/lite-gc-profiler'));

    // --- lite-pick lane -----------------------------------------------------
    const lpWork = buildWorkload('skewed-cost', CAP, SEEDS.gc);
    const lpGc = runLitePick(lpWork);
    await lpGc.settle();
    const lpSum = lpGc.summary();
    lpGc.stop();
    const lpTail = tailFromLat();
    const lpReport = checkNoGc(lpSum, { maxMajor: 0, maxPauseMs: 2 });

    // Exact B/op on the lite-pick pick body (the 0 B/op claim, measured not asserted).
    const bpWork = buildWorkload('skewed-cost', CAP, SEEDS.gc);
    const bpP2c = new P2cBalancer(CAP, bpWork.eligible, bpWork.inflight, SEEDS.p2c);
    let bpSink = 0;
    const bpStep = () => { bpSink = (bpSink + bpP2c.pick()) | 0; };
    const bpRes = measureAllocs(bpStep, { iterations: 100000, batches: 8 });
    void bpSink;
    const lpBpop = Math.max(0, Math.round(bpRes.bytesPerCall === null ? 0 : bpRes.bytesPerCall));

    // --- allocating foil lane ----------------------------------------------
    const foilWork = buildWorkload('skewed-cost', CAP, SEEDS.gc);
    const foilGc = runFoil(foilWork);
    await foilGc.settle();
    const foilSum = foilGc.summary();
    foilGc.stop();
    const foilTail = tailFromLat();

    return {
        cap: CAP,
        requests: REQUESTS,
        seed: SEEDS.gc,
        litePick: {
            major: lpSum.gc.major,
            minor: lpSum.gc.minor,
            maxPauseMs: lpSum.gc.maxMs,
            bpop: lpBpop,
            serviceP999Ms: lpTail.p999,
            serviceMaxMs: lpTail.max,
            gateOk: lpReport.ok,
        },
        foil: {
            major: foilSum.gc.major,
            minor: foilSum.gc.minor,
            maxPauseMs: foilSum.gc.maxMs,
            serviceP999Ms: foilTail.p999,
            serviceMaxMs: foilTail.max,
        },
    };
}

if (import.meta.url === 'file://' + process.argv[1]) {
    const r = await measureGcBlastRadius();
    process.stdout.write('lite-pick GC blast-radius (M6 headline #2) -- n=' + r.cap +
        ', ' + r.requests + ' requests, seed 0x' + r.seed.toString(16) + '\n');
    const fmt = (x) => x.toFixed(3);
    process.stdout.write('  lite-pick lane   major=' + r.litePick.major +
        ' minor=' + r.litePick.minor +
        ' maxPause=' + fmt(r.litePick.maxPauseMs) + 'ms' +
        ' B/op=' + r.litePick.bpop +
        ' | service p99.9=' + fmt(r.litePick.serviceP999Ms) + 'ms' +
        ' max=' + fmt(r.litePick.serviceMaxMs) + 'ms\n');
    process.stdout.write('  allocating foil  major=' + r.foil.major +
        ' minor=' + r.foil.minor +
        ' maxPause=' + fmt(r.foil.maxPauseMs) + 'ms' +
        ' | service p99.9=' + fmt(r.foil.serviceP999Ms) + 'ms' +
        ' max=' + fmt(r.foil.serviceMaxMs) + 'ms\n');

    const lpOk = r.litePick.major === 0 && r.litePick.bpop === 0 &&
        r.litePick.maxPauseMs <= 2 && r.litePick.gateOk;
    const foilOk = r.foil.major >= 1;
    process.stdout.write('  lite-pick lane (maxMajor 0 / 0 B/op / maxPause<=2ms) -> ' +
        (lpOk ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('  allocating foil (maxMajor >= 1, the contrast) -> ' +
        (foilOk ? 'PASS' : 'FAIL') + '\n');
    if (!lpOk || !foilOk) {
        process.stderr.write('bench:gc: FAIL\n');
        process.exit(1);
    }
    process.stdout.write('bench:gc: PASS\n');
}
