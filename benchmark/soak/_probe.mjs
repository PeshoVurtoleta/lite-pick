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
 *   5. The latency sampler (per-pick clock + ring) adds 0 B/op beyond its two clock reads (S13).
 * Every failure prints one `probe: FAIL -- <what>` line on stderr; a pass prints `probe: ok`.
 *
 * S13 (audit 2026-09-29): the probe failed on the clean tree with "latency sampler B/op = 31.9" and no
 * failure line. Root cause (not JIT noise -- deterministic 32.02 on every Node 22 run, 0.000 on Node 26):
 * Node 22's performance.now() returns a BOXED double, 16 B per read, and the sampler reads it twice. So the
 * probe now measures the two clock reads ALONE with the identical code minus the kernel step, gates the
 * DIFFERENCE (sampler - clock <= NOISE_FLOOR: the sampler's own work allocates nothing), and bounds the
 * clock at two boxed doubles (CLOCK_MAX), reporting it. Run by `soak:teeth` as pass-control PP, with the
 * must-fail PM (PROBE_MUSTFAIL=sampleralloc: one small object per sampled pick).
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
const CLOCK_MAX = 2 * 16 + 1;   // two clock reads, each at most one boxed double (16 B), + 1 B of slack

// Teeth knob (fail closed): PROBE_MUSTFAIL=sampleralloc makes the sampler allocate one small object per op.
const PROBE_MODES = ['sampleralloc'];
const PROBE_MF = process.env.PROBE_MUSTFAIL;
if (PROBE_MF !== undefined && PROBE_MODES.indexOf(PROBE_MF) === -1) {
    process.stderr.write("probe: FAIL -- PROBE_MUSTFAIL='" + PROBE_MF + "' -- did you mean " + PROBE_MODES.join(' | ') + '?\n');
    process.exit(2);
}
const failures = [];   // one `probe: FAIL -- ...` line each

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
        if (bop === null || !Number.isFinite(bop)) { fail = true; failures.push('lane ' + lane.name + ' B/op=' + bop + ' (every window scavenged, or non-finite)'); }
        else { if (bop > worst) worst = bop; if (!(bop <= NOISE_FLOOR)) { fail = true; failures.push('lane ' + lane.name + ' B/op=' + bop.toFixed(3) + ' > ' + NOISE_FLOOR); } }
    }

    // T16 latency-sampler 0-B/op check: per-pick performance.now() timing written to a pre-allocated
    // ring is 0 B/op (the DDSketch is populated cold, off this path). Measured with the SAME calibrated
    // probe (warm bias subtracted) that reads 0.000 for the kernel step.
    // S13: the CLOCK reads are measured alone (identical code minus the kernel step) and the sampler is
    // gated on the difference -- the runtime's clock boxing is reported and bounded, not misattributed.
    let latSamplerBop = 0, clockBop = 0;
    {
        const lane = KERNEL_LANES.find((l) => l.name === 'PeakEWMA');
        const seed = seedFor(0xC0FFEE, 6, 0);
        const built = lane.make(seed, CAP, M_CH);
        const ctx = makeHotCtx(lane, built, seed, CAP, 1024, 1000, 0);
        const step = stepFor(lane.family, lane.notes);
        const ring = new Float64Array(8192); let rp = 0;
        const leak = PROBE_MF === 'sampleralloc';
        const samplerStep = (c) => { const t0 = performance.now(); step(c); let d = (performance.now() - t0) * 1e6; if (!(d >= 1)) d = 1; ring[(rp++) & 8191] = d; if (leak) c.__o = { d: rp }; };
        const clockStep = (c) => { const t0 = performance.now(); let d = (performance.now() - t0) * 1e6; if (!(d >= 1)) d = 1; ring[(rp++) & 8191] = d; };
        for (let i = 0; i < WARM; i++) { samplerStep(ctx); clockStep(ctx); }
        const rs = measureHotBytesPerOp(ctx, samplerStep, OPS, WINDOWS, bias);
        const rc = measureHotBytesPerOp(ctx, clockStep, OPS, WINDOWS, bias);
        latSamplerBop = rs.bop === null || !Number.isFinite(rs.bop) ? Infinity : rs.bop;
        clockBop = rc.bop === null || !Number.isFinite(rc.bop) ? Infinity : rc.bop;
        if (!(clockBop <= CLOCK_MAX)) { fail = true; failures.push('clock reads B/op=' + clockBop + ' > ' + CLOCK_MAX + ' (more than two boxed doubles)'); }
        if (!(latSamplerBop - clockBop <= NOISE_FLOOR)) {
            fail = true;
            failures.push('latency sampler adds ' + (latSamplerBop - clockBop).toFixed(3) + ' B/op beyond its clock reads (sampler ' + latSamplerBop.toFixed(3) + ', clock ' + clockBop.toFixed(3) + ') > ' + NOISE_FLOOR);
        }
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
    if (qBop === null || !(qBop <= NOISE_FLOOR)) { fail = true; failures.push('EventQueue B/op=' + qBop + ' > ' + NOISE_FLOOR); }

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
    process.stdout.write('  latency sampler B/op=' + (latSamplerBop === Infinity ? 'null' : latSamplerBop.toFixed(3)) +
        ' = clock ' + (clockBop === Infinity ? 'null' : clockBop.toFixed(3)) + ' + sampler ' + (latSamplerBop - clockBop).toFixed(3) +
        ' (per-pick clock + ring, sketch cold; the clock is ' + (clockBop > NOISE_FLOOR ? 'BOXED on this runtime' : 'unboxed') + ')\n');
    process.stdout.write('GATE leak=size ' + live + '/0 findings=' + findings.length +
        ' warnings=0 | gc major=' + s.gc.major + ' minor=' + s.gc.minor +
        ' maxMs=' + s.gc.maxMs.toFixed(2) + ' | alloc=' + worst.toFixed(3) + ' B/op | ' +
        (gateFail ? 'FAIL' : 'ok') + '\n');

    if (gateFail) {
        if (!report.ok) for (const v of report.violations) failures.push('gc ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual);
        if (!queueOk) failures.push('EventQueue heap-order property violated');
        if (live !== 0) failures.push('retention: tracker.size()=' + live);
        if (findings.length !== 0) failures.push('tracker findings=' + findings.length);
        if (!failures.length) failures.push('unattributed gate failure');   // never a silent exit 1
        for (const f of failures) process.stderr.write('probe: FAIL -- ' + f + '\n');
        process.exit(1);
    }
    process.stderr.write('probe: ok\n');
}

main().catch((e) => { process.stderr.write('probe: FAIL -- ' + (e && e.stack ? e.stack : e) + '\n'); process.exit(1); });
