/**
 * @zakkster/lite-pick soak -- hot-path CLEAN probe (increment 1 acceptance).
 *
 *   node --expose-gc --min-semi-space-size=4 --max-semi-space-size=4 benchmark/soak/_probe.mjs
 *
 * Proves the harness is clean:
 *   1. Every kernel lane's hot step is 0 B/op (median of GC-free new-space windows, warm bias).
 *   2. The EventQueue push/pop is 0 B/op AND keeps heap order over 1e6 random ops.
 *   3. Lane churn leaves no retention (tracker.size() -> 0).
 *   4. GcProfiler maxMajor 0 over the hot run -- read AFTER a ~50ms settle so the GC window is not
 *      empty (BLOCKER 2: a summary read in the same sync turn as gc() sees nothing and cannot fail).
 * The TEETH (must-fail controls) live in benchmark/soak/_mustfail.mjs.
 */

import { GcProfiler, checkNoGc } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';
import { performance } from 'node:perf_hooks';
import { Prng } from '../../Pick.js';
import { KERNEL_LANES, CAP, M_CH } from './lanes.mjs';
import { EventQueue } from './des.mjs';
import { makeHotCtx, stepFor, measureHotBytesPerOp, warmBiasBytes, assertPinnedFlags } from './hot.mjs';
import { seedFor } from './seeds.mjs';

const OPS = 8192;
const WINDOWS = 65;
const WARM = 1000000;   // warm each lane hard so a one-off runtime event lands OUTSIDE the measured passes
const NOISE_FLOOR = 0.05;   // a clean lane must sit below this after the warm bias is removed (0.000)

const settle = () => new Promise((r) => setTimeout(r, 50));

function probeQueue(bias) {
    const q = new EventQueue(1024);
    const rng = new Prng(0xBEEF);
    const inflight = new Uint32Array(64);
    q.reset(rng, inflight, 512, 1000, 1, 64);
    let ok = true;
    for (let i = 0; i < 1000000; i++) {
        if (!q.full() && (rng.nextBelow(2) === 0 || q.size === 0)) q.pushCompletion(rng.nextBelow(64));
        else if (q.size > 0) q.pop();
        if ((i & 65535) === 0 && !q.verifyHeap()) { ok = false; break; }
    }
    if (!q.verifyHeap()) ok = false;
    const qctx = { q, rng, inflight };
    const qstep = (c) => {
        if (!c.q.full() && (c.rng.nextBelow(2) === 0 || c.q.size === 0)) c.q.pushCompletion(c.rng.nextBelow(64));
        else if (c.q.size > 0) c.q.pop();
    };
    for (let i = 0; i < WARM; i++) qstep(qctx);
    const qBop = measureHotBytesPerOp(qctx, qstep, OPS, WINDOWS, bias).bop;
    return { ok, qBop };
}

async function main() {
    assertPinnedFlags();
    if (typeof globalThis.gc !== 'function') { process.stderr.write('probe: FAIL -- gc not exposed\n'); process.exit(2); }
    const bias = warmBiasBytes(OPS, WINDOWS).bias;   // .bias = the MIN of GC-free no-op windows (the floor)

    const results = [];
    let worst = 0, fail = false;
    const ctxs = [];

    // Phase A: B/op per lane. This uses getHeapSpaceStatistics (which itself allocates), so it is NOT
    // under the maxMajor profiler -- that would attribute the PROBE's allocations to the kernel.
    for (let li = 0; li < KERNEL_LANES.length; li++) {
        const lane = KERNEL_LANES[li];
        const seed = seedFor(0xC0FFEE, li, 0);
        const built = lane.make(seed, CAP, M_CH);
        const ctx = makeHotCtx(lane, built, seed, CAP, 1024, 1000, li & 1);
        const step = stepFor(lane.family, lane.notes);
        for (let i = 0; i < WARM; i++) step(ctx);
        const bop = measureHotBytesPerOp(ctx, step, OPS, WINDOWS, bias).bop;
        results.push({ lane: lane.name, bop });
        ctxs.push({ ctx, step });
        // NaN-closed: a null (all-scavenged) OR any non-finite B/op is a FAIL, never a silent pass.
        if (bop === null || !Number.isFinite(bop)) fail = true;
        else { if (bop > worst) worst = bop; if (!(bop <= NOISE_FLOOR)) fail = true; }
    }

    // T16 latency-sampler 0-B/op check: per-pick performance.now() timing written to a pre-allocated
    // ring is 0 B/op (the DDSketch is populated cold, off this path). Measured with the SAME calibrated
    // probe (warm bias subtracted) that reads 0.000 for the kernel step.
    let latSamplerBop = 0;
    {
        const lane = KERNEL_LANES.find((l) => l.name === 'PeakEWMA');
        const seed = seedFor(0xC0FFEE, 6, 0);
        const built = lane.make(seed, CAP, M_CH);
        const ctx = makeHotCtx(lane, built, seed, CAP, 1024, 1000, 0);
        const step = stepFor(lane.family, lane.notes);
        const ring = new Float64Array(8192); let rp = 0;
        const samplerStep = (c) => { const t0 = performance.now(); step(c); let d = (performance.now() - t0) * 1e6; if (!(d >= 1)) d = 1; ring[(rp++) & 8191] = d; };
        for (let i = 0; i < WARM; i++) samplerStep(ctx);
        const r = measureHotBytesPerOp(ctx, samplerStep, OPS, WINDOWS, bias);
        latSamplerBop = r.bop === null ? Infinity : r.bop;
        if (latSamplerBop > NOISE_FLOOR) fail = true;
    }

    // Phase B: maxMajor 0 over PURE step loops (no heap-stats calls -> the only allocation possible is
    // the kernel's, and there is none). A fresh profiler; settle before summary (BLOCKER 2).
    const gc = new GcProfiler().start();
    for (let k = 0; k < ctxs.length; k++) {
        const { ctx, step } = ctxs[k];
        for (let i = 0; i < 500000; i++) step(ctx);
    }
    // NO forced gc() here -- a forced full GC would itself be counted as a major. Just settle so any
    // GC the WORKLOAD triggered lands in the window; a 0-alloc workload triggers none (major stays 0),
    // an allocating mutant triggers scavenges/majors that this then catches.
    await settle();
    const s = gc.summary();
    const report = checkNoGc(s, { maxMajor: 0 });
    gc.stop();

    const { ok: queueOk, qBop } = probeQueue(bias);
    if (qBop === null || qBop > NOISE_FLOOR) fail = true;

    const tracker = createLeakTracker({ name: 'soak-probe' });
    for (let c = 0; c < 256; c++) {
        const lane = KERNEL_LANES[c % KERNEL_LANES.length];
        const seed = seedFor(0xC0FFEE, c % KERNEL_LANES.length, c);
        const built = lane.make(seed, CAP, M_CH);
        tracker.track(built.b, () => {}, lane.name, { audit: true });
        const ctx = makeHotCtx(lane, built, seed, CAP, 1024, 1000, 0);
        const step = stepFor(lane.family, lane.notes);
        for (let i = 0; i < 2000; i++) step(ctx);
    }
    globalThis.gc();
    await settle();
    let live = tracker.size();
    for (let i = 0; i < 8 && live > 0; i++) { globalThis.gc(); await settle(); live = tracker.size(); }
    const findings = tracker.audit();

    const gateFail = fail || !report.ok || !queueOk || live !== 0 || findings.length !== 0;
    for (const r of results) {
        process.stdout.write('  ' + r.lane.padEnd(16) + ' ' +
            (r.bop === null ? 'B/op=null (all windows saw GC)' : 'B/op=' + r.bop.toFixed(3)) + '\n');
    }
    process.stdout.write('  queue           B/op=' + (qBop === null ? 'null' : qBop.toFixed(3)) +
        ' heapOrder=' + (queueOk ? 'ok' : 'FAIL') + '  (warm bias=' + bias.toFixed(0) + ' B/window)\n');
    process.stdout.write('  latency sampler B/op=' + (latSamplerBop === Infinity ? 'null' : latSamplerBop.toFixed(3)) + ' (per-pick clock + ring, sketch cold)\n');
    process.stdout.write('GATE leak=size ' + live + '/0 findings=' + findings.length +
        ' warnings=0 | gc major=' + s.gc.major + ' minor=' + s.gc.minor +
        ' maxMs=' + s.gc.maxMs.toFixed(2) + ' | alloc=' + worst.toFixed(3) + ' B/op | ' +
        (gateFail ? 'FAIL' : 'ok') + '\n');

    if (gateFail) {
        if (!report.ok) for (const v of report.violations) process.stderr.write('  violation ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual + '\n');
        if (!queueOk) process.stderr.write('  heap-order property violated\n');
        if (live !== 0) process.stderr.write('  retention: tracker.size()=' + live + '\n');
        process.exit(1);
    }
}

main().catch((e) => { process.stderr.write('probe: FAIL -- ' + (e && e.stack ? e.stack : e) + '\n'); process.exit(1); });
