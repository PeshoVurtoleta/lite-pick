/**
 * @zakkster/lite-pick -- Pool.run cost LADDER lanes (one lane per child process).
 *
 *   node --expose-gc --min-semi-space-size=1 --max-semi-space-size=1 \
 *        test/perf/pool-cost-lanes.mjs <laneId> [N]
 *
 * MEASUREMENT LAW (benchmark/PoolCost.mjs + test/perf/PoolCost.test.mjs drive this file): allocation
 * RATE by scavenge COUNT under a pinned 1 MiB young generation. Each lane runs its own driver warm
 * (a fixed 3,000,000 runs), yields one setImmediate, then counts MINOR GCs over a window of N awaited runs and a
 * window of 8N awaited runs. Old-gen GCs are counted per window too (must be 0). Bytes per run is
 *
 *     B/run = (S_8N - S_N) x 1048576 / (7 N)
 *
 * so the fixed per-process overhead cancels and only the per-run allocation remains. NEVER
 * lite-gc-profiler measureOps here (it reports a retained delta, which reads 0 for a transient
 * promise/frame -- exactly what Pool.run costs). One lane per child keeps each measurement in a
 * fresh heap so one lane's optimizer state cannot poison the next.
 *
 * The Pool implementation under test is import('../../Pool.js') by default; set LITE_POOL_IMPL to an
 * absolute path to measure a different copy (the HEAD revert-check points it at the scratch copy).
 */

import { PerformanceObserver, constants } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const MINOR = constants.NODE_PERFORMANCE_GC_MINOR;
const MAJOR = constants.NODE_PERFORMANCE_GC_MAJOR;
const INCR = constants.NODE_PERFORMANCE_GC_INCREMENTAL;

const POOL_URL = process.env.LITE_POOL_IMPL
    ? pathToFileURL(process.env.LITE_POOL_IMPL).href
    : new URL('../../Pool.js', import.meta.url).href;
const PICK_URL = new URL('../../Pick.js', import.meta.url).href;

const { Pool, POOL_CHANNEL_DISPATCH, POOL_CHANNEL_SETTLE } = await import(POOL_URL);
const { PICK_NONE, P2cBalancer, PeakEwmaBalancer } = await import(PICK_URL);

// ---------------------------------------------------------------------------
// Shared, HOISTED fixtures (nothing per-run unless a lane's shape demands it).
// ---------------------------------------------------------------------------
const CAP = 64;
function p2cPool() {
    const el = new Uint8Array(CAP).fill(1);
    const inflight = new Uint32Array(CAP);
    return new Pool(new P2cBalancer(CAP, el, inflight, 0x1234abcd), inflight);
}
function peakPool() {
    const el = new Uint8Array(CAP).fill(1);
    const inflight = new Uint32Array(CAP);
    return new Pool(new PeakEwmaBalancer(CAP, el, inflight, 1e6, 0x55), inflight);
}

const RESOLVED = Promise.resolve(0);
const SYNC_FN = (ep) => ep;
const ASYNC_FN = async (ep) => ep;
const FN_RESOLVED = () => RESOLVED;
const SUBMIT_FN = (ep) => new Promise((r) => r(ep));

const OPTS_P2C = { tries: 1 };
const OPTS_TRIES2 = { tries: 2 };
const PRE_ERR = new Error('lane-preallocated');

// L6: attempt 0 throws, then succeed. Reset per run via a module counter (no per-run alloc).
let l6attempt = 0;
const L6_FN = (ep) => { if (l6attempt++ === 0) throw PRE_ERR; return ep; };

// L7: abort before dispatch (reused aborted signal + reused opts). Deterministic, no error alloc.
const ABORTED_SIGNAL = { aborted: true, reason: PRE_ERR };
const OPTS_ABORT = { tries: 1, signal: ABORTED_SIGNAL };

// L8: PeakEWMA clocks.
let c8a = 0;
const CLK_SMALL = () => { c8a = (c8a + 1000) & 0x3fffffff; return c8a; };
let c8b = 1.7e15;
const CLK_BIG = () => { c8b += 1000; return c8b; };

// PLANT / CTRL_OBJ: an escaped allocation per run into a 64-slot ring -- the teeth (must trip the
// ceiling). The ring bounds live objects to 64 so the control never promotes / poisons the window.
const RING_SIZE = 64;
const RING_MASK = RING_SIZE - 1;
const __ring = new Array(RING_SIZE).fill(null);

// PROMOTE: the old-gen teeth. Objects pushed into a LARGE ring survive many scavenges before being
// overwritten, so they are tenured into old_space and force an old-gen COLLECTION during the drive --
// the control that proves the oldGen==0 assertion is not vacuous. Sized so old_space grows well past a
// scavenge cycle yet stays bounded (no OOM): 262144 small objects, a few MB.
const PROMOTE_SIZE = 1 << 18;
const PROMOTE_MASK = PROMOTE_SIZE - 1;
const __promote = new Array(PROMOTE_SIZE).fill(null);

// ---------------------------------------------------------------------------
// Lanes. `sync: true` lanes are NOT awaited (the absolute floor). Everything else is awaited.
// ---------------------------------------------------------------------------
function buildLanes() {
    const p2c = p2cPool();
    const peakA = peakPool();
    const peakB = peakPool();
    const b = p2c.balancer, inflight = p2c.inflight;

    const OPTS_PEAK_SMALL = { tries: 1, clock: CLK_SMALL };
    const OPTS_PEAK_BIG = { tries: 1, clock: CLK_BIG };

    const lanes = {
        // L0: bare pick() + inflight ++/-- (SYNC, must be 0).
        L0: { sync: true, run: () => { const i = b.pick(); if (i !== PICK_NONE) { inflight[i] = (inflight[i] + 1) >>> 0; inflight[i] = inflight[i] > 0 ? inflight[i] - 1 : 0; } } },
        // L1: driver floor -- await an already-resolved promise, no async frame of our own.
        L1: { run: () => RESOLVED },
        // L2: minimal hand-written async wrapper (pick, ++, try/await/finally --).
        L2: { run: async (i) => { const e = b.pick(); if (e === PICK_NONE) return; inflight[e] = (inflight[e] + 1) >>> 0; try { return await SYNC_FN(e); } finally { inflight[e] = inflight[e] > 0 ? inflight[e] - 1 : 0; } } },
        // L3: Pool.run, sync fn, hoisted opts, P2C, tries 1.
        L3: { run: () => p2c.run(SYNC_FN, OPTS_P2C) },
        // L4: Pool.run with an async fn.
        L4: { run: () => p2c.run(ASYNC_FN, OPTS_P2C) },
        // L5: Pool.run with a fn returning the shared resolved promise.
        L5: { run: () => p2c.run(FN_RESOLVED, OPTS_P2C) },
        // L6: tries 2, attempt 0 throws a preallocated error, attempt 1 succeeds (the ACTUAL-failover cost).
        L6: { run: () => { l6attempt = 0; return p2c.run(L6_FN, OPTS_TRIES2); } },
        // L6S: tries 2 but fn SUCCEEDS on attempt 0 (a failover-configured pool's common path). Reported
        // only -- shows that F1's scalar fast path keeps this cheap (~L3), which an arrays-upfront variant
        // would not.
        L6S: { run: () => p2c.run(SYNC_FN, OPTS_TRIES2) },
        // L7: abort before dispatch (throws the reused reason; caught here).
        L7: { run: async () => { try { return await p2c.run(SYNC_FN, OPTS_ABORT); } catch { /* reused reason */ } } },
        // L8a: PeakEWMA, small-int (Smi) clock -- the reading stays unboxed, so L8a == L3 (gated there).
        L8a: { run: () => peakA.run(SYNC_FN, OPTS_PEAK_SMALL) },
        // L8b: PeakEWMA, 1.7e15 epoch-ns clock. The clock reading is a large double V8 boxes at the
        // non-inlined pick()/recordRtt boundary (read twice per successful attempt), so L8b costs more
        // than L3 -- its own gated "clocked" row.
        L8b: { run: () => peakB.run(SYNC_FN, OPTS_PEAK_BIG) },
        // L9: L3 with BOTH channels subscribed (guarded for availability).
        L9: { run: () => p2c.run(SYNC_FN, OPTS_P2C) },
        // L10: submit-shaped fn (fresh promise) + a per-run { signal } opts object.
        L10: { run: () => p2c.run(SUBMIT_FN, { tries: 1, signal: undefined }) },
        // CTRL_OBJ: L3 + ONE escaped {a:i} per run into a 64-slot ring -- the SMALLEST realistic
        // per-run heap object (the tightest teeth for the +8 B attempt-0 ceiling). Must trip it.
        CTRL_OBJ: { run: (i) => { __ring[i & RING_MASK] = { a: i }; return p2c.run(SYNC_FN, OPTS_P2C); } },
        // CTRL_OBJ6: L6 + one escaped {a:i} per run -- the same teeth for the FAILOVER ceiling, so a
        // reintroduced per-attempt allocation cannot slip past the L6 row either.
        CTRL_OBJ6: { run: (i) => { __ring[i & RING_MASK] = { a: i }; l6attempt = 0; return p2c.run(L6_FN, OPTS_TRIES2); } },
        // PLANT: L3 + one escaped [] + push per run into a 64-slot ring (teeth; must exceed the
        // ceiling). The empty literal + push forces both the array object and a backing-store
        // allocation V8 cannot elide (the store escapes into the module-level ring).
        PLANT: { run: (i) => { const a = []; a.push(i); __ring[i & RING_MASK] = a; return p2c.run(SYNC_FN, OPTS_P2C); } },
        // PL_BOX / PL_BOX6: L3 / L6 + one escaped boxed DOUBLE (i + 0.5, a ~16 B HeapNumber) per run --
        // the smallest realistic regression (a single boxed number crossing a call), the tightest teeth
        // for SLACK. Must exceed the attempt-0 / failover ceiling on every row.
        PL_BOX: { run: (i) => { __ring[i & RING_MASK] = i + 0.5; return p2c.run(SYNC_FN, OPTS_P2C); } },
        PL_BOX6: { run: (i) => { __ring[i & RING_MASK] = i + 0.5; l6attempt = 0; return p2c.run(L6_FN, OPTS_TRIES2); } },
        // PL_BOX8b: L8b + one escaped boxed double per run -- the teeth for the clocked (epoch-ns) row.
        PL_BOX8b: { run: (i) => { __ring[i & RING_MASK] = i + 0.5; return peakB.run(SYNC_FN, OPTS_PEAK_BIG); } },
        // PROMOTE: the old-gen control -- retain one {a,b} per run in a LARGE ring so objects are
        // tenured and an old-gen COLLECTION fires DURING the drive. Its oldN+old8N MUST be > 0.
        PROMOTE: { run: (i) => { __promote[i & PROMOTE_MASK] = { a: i, b: i }; return p2c.run(SYNC_FN, OPTS_P2C); } },
    };
    return lanes;
}

// L9 channel subscriptions (guarded). Kept alive for the whole process.
function subscribeChannels() {
    try {
        const dc = process.getBuiltinModule('node:diagnostics_channel');
        if (!dc || typeof dc.channel !== 'function') return false;
        const d = dc.channel(POOL_CHANNEL_DISPATCH);
        const s = dc.channel(POOL_CHANNEL_SETTLE);
        let sink = 0;
        d.subscribe((m) => { sink += m.endpoint; });
        s.subscribe((m) => { sink += m.attempt; });
        globalThis.__ch_sink = () => sink;
        return true;
    } catch { return false; }
}

// ---------------------------------------------------------------------------
// Driver + GC counting.
// ---------------------------------------------------------------------------
async function driveSync(lane, n) { for (let i = 0; i < n; i++) lane.run(i); }
async function driveAsync(lane, n) { for (let i = 0; i < n; i++) await lane.run(i); }

function makeGcCounter() {
    // Store each entry's kind + startTime, then (in countWindow) count ONLY GCs that STARTED during the
    // drive (startTime <= driveEnd). The window does NOT promote nothing: old_space grows ~10 MB over the
    // Node 22 8N window as per-run promises/frames survive a scavenge and are tenured. What the startTime
    // filter drops is GC that starts AFTER the drive, during the flush sleep: late harness minor GCs
    // (measured ~23-33 per window on Node 22) and -- once old_space has grown -- an idle old-gen
    // collection (on Node 22 L6/L10 an incremental+major pair ~15-18 ms into the flush). Those are not
    // per-run allocation pressure, so excluding them keeps the scavenge RATE (S_8N - S_N) and the
    // old-gen assertion about the DRIVE. A path that truly forces an old-gen collection WHILE running
    // (the PROMOTE control) still trips, because that GC starts before driveEnd.
    const entries = [];
    const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
            const k = e.detail ? e.detail.kind : e.kind;
            entries.push({ k, t: e.startTime });
        }
    });
    obs.observe({ entryTypes: ['gc'] });
    return { entries, close: () => obs.disconnect() };
}

async function countWindow(drive, lane, n, flushMs) {
    const gcc = makeGcCounter();
    await drive(lane, n);
    const driveEnd = performance.now();
    await sleep(flushMs);
    let minor = 0, oldGen = 0;
    for (const e of gcc.entries) {
        if (e.t > driveEnd) continue;   // started after the drive (during the flush) -- not per-run pressure
        if (e.k === MINOR) minor++;
        else if (e.k === MAJOR || e.k === INCR) oldGen++;
    }
    gcc.close();
    return { minor, oldGen };
}

async function main() {
    const laneId = process.argv[2];
    const N = process.argv[3] ? parseInt(process.argv[3], 10) : 200000;
    const flushMs = process.env.POOL_COST_FLUSH_MS ? parseInt(process.env.POOL_COST_FLUSH_MS, 10) : 120;

    if (laneId === 'L9') subscribeChannels();
    const lanes = buildLanes();
    const lane = lanes[laneId];
    if (!lane) { process.stderr.write('unknown lane ' + laneId + '\n'); process.exit(2); }
    const drive = lane.sync ? driveSync : driveAsync;

    // FIXED warm-up (NOT an adaptive steady-state detector -- an earlier chunk-equality detector was
    // dead: it read gcc.entries.length before the GC entries were delivered, so it always ran exactly 3
    // chunks). Warm with a FIXED 3,000,000 runs, chunked with a setImmediate yield between chunks so the
    // concurrent optimizer installs code at a safepoint. Most lanes are then deterministic 5x on both
    // Nodes (+/-1 scavenge). The failover path (L6) is the exception on Node 26: it is BIMODAL under CPU
    // contention (8N 2020 = 1324.2 B/run most runs, dropping to 1956 = 1276.3 in a minority of contended
    // runs); the gate pins the UPPER mode, so the low mode can only pass. Override via POOL_COST_WARM
    // (total runs) for investigation only.
    const warmRuns = process.env.POOL_COST_WARM ? parseInt(process.env.POOL_COST_WARM, 10) : 3000000;
    const warmChunk = 500000;
    for (let done = 0; done < warmRuns; done += warmChunk) {
        await drive(lane, Math.min(warmChunk, warmRuns - done));
        await new Promise((r) => setImmediate(r));
    }
    if (typeof globalThis.gc === 'function') globalThis.gc();

    const lo = await countWindow(drive, lane, N, flushMs);
    const hi = await countWindow(drive, lane, 8 * N, flushMs);

    const bytesPerRun = ((hi.minor - lo.minor) * 1048576) / (7 * N);
    const out = {
        lane: laneId, N, warmRuns,
        sN: lo.minor, s8N: hi.minor,
        oldN: lo.oldGen, old8N: hi.oldGen,
        bytesPerRun: Math.round(bytesPerRun * 10) / 10,
        node: process.versions.node,
    };
    process.stdout.write(JSON.stringify(out) + '\n');
}

main().catch((e) => { process.stderr.write('pool-cost-lanes FAIL: ' + (e && e.stack ? e.stack : e) + '\n'); process.exit(1); });
