/**
 * @zakkster/lite-pick soak -- the orchestrator and entry point (`npm run soak`).
 *
 *   node --expose-gc --min-semi-space-size=4 --max-semi-space-size=4 benchmark/soak/main.mjs
 *   SOAK_SMOKE=1 node --expose-gc --min-semi-space-size=4 --max-semi-space-size=4 benchmark/soak/main.mjs
 *
 * The B/op gate REQUIRES both --min/--max-semi-space-size=4 (asserted; fail closed). Wires config ->
 * provenance/header -> per-cycle per-lane { 3-phase chaos, timed hot loop, checkpoints, boundary,
 * gate accumulation } -> summary. Increment 2 slots in: Pool lanes, the tiny-lane teeth runner, the
 * full chaos menu, the latency/rebuild samplers, the report tool, CI and docs.
 *
 * The pick loop is 0 B/op (proven by benchmark/soak/_probe.mjs; teeth in benchmark/soak/_mustfail.mjs);
 * all cold work -- invariants, memoryUsage, gc.summary, JSONL emission -- stays OUT of the timed segment.
 */

import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { DDSketch } from '@zakkster/lite-sketch';
import { Prng, PICK_NONE } from './kernel.mjs';
import { readConfig, HOTOPS_N_MIN, HOTOPS_N_MAX } from './config.mjs';
import { ROSTER, KERNEL_LANES, TINY_LANES, CAP, M_CH, checkLane, KEYS, KEY_COUNT, KEY_MASK } from './lanes.mjs';
import { POOL_LANES, runPoolCycle } from './pool-lane.mjs';
import { seedFor, selfCheckSeeds } from './seeds.mjs';
import { buildHeader } from './provenance.mjs';
import { openStream, writeRecord, installFatalHandlers, defaultOutPath, writeFatal } from './jsonl.mjs';
import { makeHotCtx, stepFor, warmBiasBytes, measureHotBytesPerOp, assertPinnedFlags, SMI_LIMIT } from './hot.mjs';
import { QualityWindow } from './quality.mjs';
import { evaluateOracle } from './oracles.mjs';
import { GateAccumulator, exitCodeFor, VERDICT } from './gates.mjs';
import { closeLaneCycle } from './boundary.mjs';

const CHECKPOINTS = 5;
const QUEUE_CAP = 1024;
const MEAN_SVC_US = 1000;
const BOP_OPS = 8192;            // B/op window length
const BOP_WINDOWS = 65;          // windows sampled per lane-cycle (window 0 dropped as Maglev warm-up)
const HOTOPS_WARM = 50000;       // warm the fixed hotOps batch before timing
// S2 (audit 2026-09-29): hotOps batches are sized by TIME, not count. A fixed 500k dense batch ran 4-8 ms
// on the fast lanes -- too short to time on a shared CPU -- and the sparse batch was a single repeat. Each
// lane calibrates its batch length ONCE (its first cycle = the warm-up cycle, excluded from the gates) to
// the smallest power of two that takes >= HOTOPS_MIN_MS, then every cycle times HOTOPS_REPS repeats of that
// SAME length and records the median -- comparable across cycles, long enough to be stable.
const HOTOPS_MIN_MS = 25;
const HOTOPS_REPS = 5;
const LAT_PICKS = 96000;             // dense latency pass, every pick timed: 96000 samples/cycle (p999 stable)
const LAT_SPARSE_PICKS = 20000;      // sparse latency pass (each pick O(cap)): report-only p50/p99/p999
const LEAK_ARRAY_LEN = 700000;   // MUSTFAIL=leak/heap: plain-array retained per lane-cycle
const SLOWLEAK_LEN = 128;        // MUSTFAIL=slowleak: ~1 KB retained per lane-cycle (S4 teeth ML)

const noop = () => {};           // leak-contract safe: closes over nothing

/**
 * S11 (audit 2026-09-29): every failure is ONE structured stderr line, written when it is detected:
 *     soak: BREACH <family> k=v ... detail=<free text, always last>
 * family: gate=<name> | quality | invariants | retention | pool=A1..A7 | phases | tracker. The teeth
 * runner parses ONLY these lines (never a substring of stack traces); a crash prints `soak: CRASH --`.
 */
function breach(head, detail) {
    process.stderr.write('soak: BREACH ' + head + (detail === undefined ? '' : ' detail=' + String(detail).replace(/\n/g, ' ')) + '\n');
}
let fatalCtx = null;             // set once stream/summarize exist, so main().catch can write a fatal

/** The chaos phases that SHOULD fire for a lane (T8 self-check applicability, from lane flags). */
function applicablePhases(lane, hasRebuild) {
    const a = ['flap', 'allDown', 'recover', 'sparse'];
    if (lane.weighted) a.push('weightRetune', 'allZero');
    if (hasRebuild) a.push('rebuildStorm');
    if (lane.loadAware) a.push('hung');
    if (lane.latency) a.push('slowNode', 'failFast', 'clockRegress', 'clockJump', 'clockFar', 'rttBurst');
    return a;
}

/** Time `n` steps, MEDIAN of `reps` repeats (low variance). `spin` is a REAL cycle-scaled busy-loop
 *  INSIDE the timed step (the decay teeth) -- it slows the MEASURED code, not the reported number. */
function timeBatch(step, ctx, n, spin, reps) {
    const ms = new Array(reps);
    for (let r = 0; r < reps; r++) {
        const t = performance.now();
        for (let i = 0; i < n; i++) {
            step(ctx);
            if (spin) { let x = 0; for (let k = 0; k < spin; k++) x += k; ctx.__spin = x; }
        }
        ms[r] = performance.now() - t;
    }
    ms.sort((a, b) => a - b);
    return ms[ms.length >> 1];
}

/** Smallest power-of-two batch length (>= HOTOPS_N_MIN, <= HOTOPS_N_MAX) whose single timed repeat takes
 *  >= minMs (with `spin` in the step, for the decay teeth). Cold path: once per lane, in its warm-up cycle;
 *  per cycle only under the decay teeth. */
function calibrateBatch(step, ctx, minMs, spin) {
    let n = HOTOPS_N_MIN;
    while (n < HOTOPS_N_MAX && timeBatch(step, ctx, n, spin, 1) < minMs) n *= 2;
    return n;
}

/** Fixed-seed sparse eligibility (~95% down) so the sparse hotOps batch exercises the fallback scans
 *  and the ConsistentHash probe -- where the tail cost lives. Deterministic for comparability. */
function setSparse(b, cap, rng) {
    for (let i = 0; i < cap; i++) b.setEligible(i, false);
    const up = Math.max(1, (cap * 0.05) | 0);
    for (let k = 0; k < up; k++) b.setEligible(rng.nextBelow(cap), true);
}

async function main() {
    if (typeof globalThis.gc !== 'function') {
        process.stderr.write('soak: FAIL -- run with --expose-gc: node --expose-gc --min-semi-space-size=4 --max-semi-space-size=4 benchmark/soak/main.mjs\n');
        process.exit(1);
    }
    assertPinnedFlags();   // the hotAlloc gate is only meaningful with semi-space pinned (fail closed)

    const cfg = readConfig(process.env, ROSTER, POOL_LANES);

    const seedErr = selfCheckSeeds(cfg.seed, ROSTER.length);
    if (seedErr !== null) {
        process.stderr.write('soak: FAIL -- seed self-check: ' + seedErr + '\n');
        process.exit(2);
    }

    // Drive BOTH the kernel lanes (CAP=256) and the tiny lanes (cap in {1,2,3}[cycle%3]) selected by
    // SOAK_LANES. Each entry carries a distinct laneId so gate/quality series never collide by name.
    const entries = [];
    const runTier = (t) => cfg.tiers.indexOf(t) !== -1;   // SOAK_TIERS subset (#8b D2)
    for (const l of KERNEL_LANES) if (runTier('kernel') && cfg.lanes.indexOf(l.name) !== -1) entries.push({ lane: l, tier: 'kernel', laneId: l.name });
    for (const l of TINY_LANES) if (runTier('tiny') && cfg.lanes.indexOf(l.name) !== -1) entries.push({ lane: l, tier: 'tiny', laneId: l.name + '#tiny' });
    for (const nm of POOL_LANES) if (runTier('pool') && cfg.lanes.indexOf(nm) !== -1) entries.push({ poolName: nm, tier: 'pool', laneId: nm });
    const laneIds = entries.filter((e) => e.tier !== 'pool').map((e) => e.laneId);   // kernel+tiny -> computeGates
    const poolLaneIds = entries.filter((e) => e.tier === 'pool').map((e) => e.laneId);

    const { GcProfiler } = await import('@zakkster/lite-gc-profiler');
    const { createLeakTracker } = await import('@zakkster/lite-leak');

    const warns = [];
    const tracker = createLeakTracker({ name: 'lite-pick-soak-next', onWarning: (w) => warns.push(w.kind + ':' + w.reason) });
    const gc = new GcProfiler().start();

    const t0 = performance.now();
    const header = buildHeader(cfg);
    header.laneRoster = entries.map((e) => e.laneId);   // every lane id (kernel+tiny+pool) the run drives
    const outPath = cfg.out || defaultOutPath(header.gitSha);
    const stream = openStream(outPath, t0);
    // WARM per-window B/op bias = the MIN of GC-free no-op windows (the clean probe floor, robust to
    // early-JIT outliers that inflate a mean and hide real allocation). Fail closed if the sample is
    // empty (every no-op window scavenged -> the probe cannot establish a floor).
    const biasInfo = warmBiasBytes(BOP_OPS, BOP_WINDOWS);
    if (biasInfo.gcFree === 0) {
        process.stderr.write('soak: FAIL -- B/op warm-bias sample empty (every no-op window scavenged); cannot establish a floor\n');
        process.exit(2);
    }
    // Plausibility ceiling (fail closed): a clean no-op window floor is ~1900-2050 B (one
    // getHeapSpaceStatistics object). A floor above BIAS_CEIL_BYTES means the no-op step itself is
    // allocating (a harness bug) -- subtracting that would absorb real per-op allocation, so refuse to
    // run rather than report a polluted 0. (gcFree===0 alone cannot catch a window with several scavenges.)
    const BIAS_CEIL_BYTES = 4096;
    if (!(biasInfo.bias <= BIAS_CEIL_BYTES)) {
        process.stderr.write('soak: FAIL -- B/op warm-bias floor ' + biasInfo.bias + ' B > ' + BIAS_CEIL_BYTES +
            ' B (the no-op probe is allocating; measurement would hide real allocation)\n');
        process.exit(2);
    }
    const bias = biasInfo.bias;
    header.bopBias = { biasBytes: bias, floorBytes: biasInfo.floor, spreadBytes: biasInfo.spread, gcFreeWindows: biasInfo.gcFree };

    // S4 (audit 2026-09-29): records stream into O(lanes) gate state and are NOT kept (the JSONL on disk is
    // the durable record for soak:report). A kept array grew the post-GC heap ~1 KB per record and tripped
    // the heap gate on long runs. Pool records are counted only (computeGates never read them).
    const gateAcc = new GateAccumulator({ warmupCycles: cfg.warmupCycles, gateN: cfg.gateN, lanes: laneIds });
    let rollupCount = 0;
    const leakSink = [];
    let invariantFailures = 0;
    let sizeFailures = 0;
    let qualityViolations = 0;
    let poolFailures = 0;
    let poolLaunchedTotal = 0;
    let unhandledCount = 0;               // pool assertion 7: zero unhandled rejections over the run
    process.on('unhandledRejection', () => { unhandledCount++; });   // counter (the fatal handler also fires)
    const lanesSeen = new Set();          // quality: a lane is INCONCLUSIVE only if it was never
    const lanesConclusive = new Set();    // conclusive (green + enough windows) in ANY cycle
    const phaseTotals = new Map();        // laneId -> merged per-phase counts (T8 self-check)
    const phaseApplicable = new Map();    // laneId -> phases that SHOULD fire for that lane
    let totalPicks = 0;
    let cyclesRun = 0;
    let workloadMajorTotal = 0;
    const current = { lane: null, cycle: -1, seeds: null, tier: null };
    let summaryWritten = false;
    // BLOCKER 1a: a lost (never-settling) pool run leaves the event loop with nothing to do; the process
    // would exit 0 with only a header in the JSONL. beforeExit fires first -> if no summary was written,
    // record a fatal 'lost run' and fail closed. (A clean run always writes a summary, so this is inert.)
    process.on('beforeExit', () => {
        if (!summaryWritten) {
            try { writeFatal(stream, 'lostRun', current, new Error('run ended with no summary -- a pool run never settled')); } catch (e) { /* ignore */ }
            breach('pool=A3 lane=' + (current.lane || '?') + ' cycle=' + current.cycle, 'lost run: the event loop drained before a summary was written');
            process.exitCode = 1;
        }
    });

    writeRecord(stream, 'header', header);
    gc.reset();   // header build allocates; start each lane-cycle's workload window clean

    function summarize(reason) {
        const gate = gateAcc.compute({
            smoke: cfg.smoke, lanes: laneIds,
            timerFloorNs: header.timerFloorNs,   // latency floor = 2 * this (BLOCKER 3)
            poolLaunched: poolLaunchedTotal,     // count pool runs as work for the "did nothing" gate
            // S5: a bounded run that did not reach its end is never a PASS. A forever run (SOAK_CYCLES=0)
            // ends ONLY by a signal, so for it a signal is the normal end (the 2N floor still applies).
            interrupted: reason !== 'end' && !(reason === 'signal' && cfg.forever),
        });
        const findings = tracker.audit();
        const inconclusiveLanes = [];
        for (const nm of lanesSeen) if (!lanesConclusive.has(nm)) inconclusiveLanes.push(nm);
        // T8 self-check: every APPLICABLE chaos phase must have fired >= 1 for each lane over the run.
        // A broken scheduler (a phase that never fires) FAILs closed -- a soak that skipped a regime is
        // not a valid soak. Skipped for smoke (too few picks to guarantee every rare phase fires).
        const phasesNotFired = [];
        if (!cfg.smoke && reason === 'end') {
            for (const [lid, appl] of phaseApplicable) {
                const pt = phaseTotals.get(lid);
                for (const p of appl) if (!(pt[p] > 0)) phasesNotFired.push(lid + '.' + p);
            }
        }
        const counterFail = invariantFailures !== 0 || sizeFailures !== 0 ||
            qualityViolations !== 0 || findings.length !== 0 || warns.length !== 0 || phasesNotFired.length !== 0 ||
            poolFailures !== 0 || unhandledCount !== 0;
        let verdict = gate.verdict;
        if (counterFail || reason === 'fatal') verdict = VERDICT.FAIL;   // a crash is never PASS/INCONCLUSIVE
        // A lane whose quality oracle NEVER gathered enough windows in ANY cycle is INCONCLUSIVE, never
        // a silent PASS -- but only when NOT a deliberately short smoke run.
        else if (verdict === VERDICT.PASS && !cfg.smoke && inconclusiveLanes.length !== 0) verdict = VERDICT.INCONCLUSIVE;
        summaryWritten = true;
        writeRecord(stream, 'summary', {
            reason,
            wallSec: +((performance.now() - t0) / 1000).toFixed(1),
            totalPicks, lanes: laneIds.length, cyclesRun, rollups: rollupCount,
            invariantFailures, retentionFailures: sizeFailures, qualityViolations, poolFailures, unhandledCount,
            inconclusiveLanes, phasesNotFired,
            phaseTotals: reason === 'end' ? Object.fromEntries(phaseTotals) : undefined,
            findings: findings.length, warnings: warns.length, workloadMajorTotal,
            verdict, breaches: gate.breaches, notes: gate.notes, inconclusive: gate.inconclusive,
            gate: gate.perLane, totalPicksGate: gate.totalPicks,
        });
        return { verdict, gate, findings, inconclusiveLanes, phasesNotFired };
    }

    installFatalHandlers(stream, () => current, (reason) => { summarize(reason); });
    fatalCtx = { stream, current: () => current, summarize };   // reachable from main().catch

    let stopRequested = false;
    let shuttingDown = false;
    function onSignal(sig) {
        if (shuttingDown) return;
        shuttingDown = true;
        stopRequested = true;
        process.stdout.write('\nsoak: ' + sig + ' -- writing final summary and exiting\n');
        const res = summarize('signal');
        printVerdict(res);
        process.exit(exitCodeFor(res.verdict));
    }
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));

    // Telemetry (T17, REPORT-ONLY, no gate): event-loop utilization delta + loop-delay percentiles.
    const eld = monitorEventLoopDelay({ resolution: 10 });
    eld.enable();
    let prevElu = performance.eventLoopUtilization();

    const qw = new QualityWindow(CAP);
    const opsN = new Map();   // S2: per-lane (name#cap) calibrated hotOps batch lengths { dense, sparse }
    // #8b D3: SOAK_HOTOPS_N pins the batch lengths (kernel tier, CAP=256), so per-process calibration is
    // skipped and both A/B sides time the SAME batch. A fresh object per lane (never a shared mutation).
    if (cfg.hotOpsN) { for (const nm of Object.keys(cfg.hotOpsN)) opsN.set(nm + '#' + CAP, { dense: cfg.hotOpsN[nm].dense, sparse: cfg.hotOpsN[nm].sparse }); }
    // Sketches are created ONCE and clear()ed per lane-cycle -- a `new DDSketch` per cycle allocated
    // enough (over 20 lanes) to trigger a workload major GC inside the window. Strict-range bins are
    // pre-allocated at construction; clear() zeroes counts without allocating.
    const latSketch = new DDSketch(0.01, { range: [1, 1e9] });
    const sparseSketch = new DDSketch(0.01, { range: [1, 1e9] });
    const rebuildSketch = new DDSketch(0.01, { range: [1, 1e9] });
    const checkEvery = Math.max(1, (cfg.picks / CHECKPOINTS) | 0);
    const deadline = cfg.durationBound ? (t0 + cfg.durationMs) : Infinity;
    const MF = cfg.mustFail;

    // One lane-cycle in its own frame; built + hotCtx are local so they are collectable on return.
    // cap/m are per-lane: kernel lanes use CAP=256/M_CH; tiny lanes use cap in {1,2,3}. Shadow the
    // module CAP/M_CH so the body below is cap-parameterized without touching every reference.
    function runCycle(lane, seed, cycle, cap, m, laneId) {
        const CAP = cap, M_CH = m;
        const built = lane.make(seed, CAP, M_CH);
        tracker.track(built.b, noop, lane.name, { audit: true });
        if (MF === 'leak') { leakSink.push(built.b); leakSink.push(new Array(LEAK_ARRAY_LEN).fill(cycle & 255)); }
        if (MF === 'heap') { leakSink.push(new Array(LEAK_ARRAY_LEN * (cycle + 1)).fill(cycle & 255)); }
        // S4 teeth (ML): ~1 KB retained per lane-cycle -- the rate the harness's own record array leaked.
        // Over a long run the heap drift gate must catch it (the same run without it must PASS: PL).
        if (MF === 'slowleak') leakSink.push(new Array(SLOWLEAK_LEN).fill(cycle & 255));
        const eligible = built.eligible, inflight = built.inflight, weights = built.weights;
        qw.arm(lane.name, lane.weighted, eligible, weights, CAP);
        const ctx = makeHotCtx(lane, built, seed, CAP, QUEUE_CAP, MEAN_SVC_US, seed & 1);
        const step = stepFor(lane.family, lane.notes);
        const chaosRng = new Prng((seed ^ 0x2545F491) >>> 0);
        const sparseRng = new Prng((seed ^ 0x5A5A5A5A) >>> 0);
        const checkCtx = { b: built.b, cap: CAP, eligible, inflight, weights, keyHash: 0, lastPick: PICK_NONE };
        // T16 latency sampler: time 1 pick in 32, delta ns -> a reused Float64Array slot, clamp [1,1e9),
        // addFrom(slot,0) into a strict-range DDSketch. The sampler adds 0 B/op beyond its two clock reads
        // (_probe.mjs, S13): the deltas stay in a local/typed slot, never a boxed field. The clock itself is
        // runtime-dependent -- Node 22's performance.now() returns a boxed double (2 x 16 B per sampled pick,
        // ~3 MB per lane-cycle: at most ~1 scavenge inside the latency segment); Node >= 24 reads 0.
        const latSlot = new Float64Array(1);
        const latRing = new Float64Array(LAT_PICKS + 1);   // pre-allocated: 0-alloc hot writes (every pick)
        latSketch.clear(); sparseSketch.clear(); rebuildSketch.clear();   // reuse (no per-cycle alloc)
        let latN = 0;

        // T8 full chaos menu: per-phase counts (emitted in the cycle record; a summary self-check asserts
        // every APPLICABLE phase fired >= 1 per lane over the run). rebuildStorm times b.rebuild() into a
        // ring (0-alloc hot; sketch populated cold) feeding the rebuild p99 slot.
        const phase = { flap: 0, weightRetune: 0, allDown: 0, recover: 0, sparse: 0, allZero: 0, rebuildStorm: 0, hung: 0, slowNode: 0, failFast: 0, clockRegress: 0, clockJump: 0, clockFar: 0, rttBurst: 0 };
        const hasRebuild = typeof built.b.rebuild === 'function';
        const rebuildRing = new Float64Array(512); let rebuildN = 0;

        // Phases: [0, warmEnd) QUIET-settle | [warmEnd, midChaos) HEAVY chaos (whole-pool down/up +
        // flaps + weight drains; safety invariants) | [midChaos, chaosEnd) SETTLE-DENSE (up-biased
        // single flaps only, NO whole-pool ops, NO restore -- eligibility trends dense while the
        // balancer's accumulators stay DRIFTED) | [chaosEnd, picks) QUIET-AFTER FROZEN -- oracles
        // evaluate the LIVE post-chaos state (BLOCKER 4). No setEligible/setWeight touches the balancer
        // after chaosEnd, so a SmoothWRR clear-regression's drift is NOT erased before the windows run.
        const warmEnd = (cfg.picks * 0.15) | 0;
        const midChaos = (cfg.picks * 0.35) | 0;
        const chaosEnd = (cfg.picks * 0.5) | 0;
        let firstFail = null;
        let mfWeightZeroDone = false;
        for (let s = 0; s < cfg.picks; s++) {
            if (s >= warmEnd && s < midChaos) {
                const roll = chaosRng.nextBelow(1000);
                const node = chaosRng.nextBelow(CAP);
                if (roll < 30) {
                    built.b.setEligible(node, (chaosRng.nextBelow(2) === 0)); phase.flap++; qw.reset();
                } else if (roll < 52 && lane.weighted) {
                    const wv = chaosRng.nextBelow(9);   // 0..8 (drains to 0)
                    if (lane.usesSetWeight) built.b.setWeight(node, wv);
                    weights[node] = wv;   // mirror so CH/BL (which COPY weights at ctor) expose the drain (BLOCKER 6)
                    phase.weightRetune++; qw.reset();
                } else if (roll < 58) {
                    for (let i = 0; i < CAP; i++) built.b.setEligible(i, false); phase.allDown++; qw.reset();
                } else if (roll < 64) {
                    for (let i = 0; i < CAP; i++) built.b.setEligible(i, true); phase.recover++; qw.reset();
                } else if (roll < 70) {
                    for (let i = 0; i < CAP; i++) built.b.setEligible(i, false);   // sparse: >= 95% down
                    const up = Math.max(1, (CAP * 0.05) | 0);
                    for (let k = 0; k < up; k++) built.b.setEligible(chaosRng.nextBelow(CAP), true);
                    phase.sparse++; qw.reset();
                } else if (roll < 76 && lane.weighted) {
                    // allZero: for KEYED lanes, setWeights (all zero) = ONE rebuild (per-node
                    // setWeight would be CAP Maglev rebuilds, ~64KB each -> a workload major GC).
                    if (lane.keyed) {
                        for (let i = 0; i < CAP; i++) weights[i] = 0;
                        built.b.setWeights(weights);   // 1.1.0 public batch API: copy + ONE rebuild
                    } else {
                        for (let i = 0; i < CAP; i++) { if (lane.usesSetWeight) built.b.setWeight(i, 0); weights[i] = 0; }
                    }
                    phase.allZero++; qw.reset();
                } else if (roll < 82 && hasRebuild && phase.rebuildStorm < 8) {
                    // rebuild() allocates (~64KB, audit L14) -> cap the storm at 8/cycle so the cold rebuild
                    // path cannot force a workload major GC. Enough to fire the phase + a few timings.
                    const t0r = performance.now(); built.b.rebuild(); let d = (performance.now() - t0r) * 1e6;
                    if (!(d >= 1)) d = 1; else if (d >= 1e9) d = 999999999;
                    rebuildRing[(rebuildN++) & 511] = d; phase.rebuildStorm++; qw.reset();   // TIMED rebuild
                } else if (roll < 88 && lane.loadAware) {
                    inflight[node] += 50; if (lane.notes) built.b.note(node, 50);   // hung: stuck in-flight
                    phase.hung++; qw.reset();
                } else if (roll < 91 && lane.latency) {
                    built.b.recordRtt(node, 10000000, ctx.now); phase.slowNode++; qw.reset();   // 10x slow
                } else if (roll < 94 && lane.latency) {
                    built.b.recordRtt(node, 1000000, ctx.now); phase.failFast++; qw.reset();   // max(elapsed,1e6us)
                } else if (roll < 100 && lane.latency) {
                    const sub = chaosRng.nextBelow(4);
                    if (sub === 0) { ctx.now = ctx.now > 1000 ? ctx.now - 1000 : 0; phase.clockRegress++; }
                    else if (sub === 1 && (cycle & 1)) { ctx.now = ctx.now + 1e12; phase.clockJump++; }   // boxingRegime (ADR 0013)
                    else if (sub === 2 && (cycle & 1)) { ctx.now = 1e15; phase.clockFar++; }              // boxingRegime (ADR 0013)
                    else { for (let r2 = 0; r2 < 8; r2++) built.b.recordRtt(chaosRng.nextBelow(CAP), 1 + chaosRng.nextBelow(500000), ctx.now); phase.rttBurst++; }
                    qw.reset();
                }
            } else if (s >= midChaos && s < chaosEnd) {
                // Settle-dense band: up-biased single-node flaps AND up-biased single-node weight restores
                // (setWeight to 1..8), NO whole-pool ops, NO full restore. This drives BOTH eligibility and
                // POSITIVE-WEIGHT count high (so the frozen quiet-after is dense enough for the WR chi-square:
                // >= 8 positive-weight eligible nodes with expected >= 5) while still flapping/reweighting
                // single nodes -- the churn a clear/drift regression accumulates on (never a full reset).
                const roll = chaosRng.nextBelow(1000);
                const node = chaosRng.nextBelow(CAP);
                if (roll < 40) { built.b.setEligible(node, chaosRng.nextBelow(4) !== 0); qw.reset(); }
                else if (roll < 80 && lane.weighted && !lane.keyed) {
                    // Up-biased weight restore for the COUNT/CHI-SQUARE oracle lanes (SmoothWRR/SED/NQ/WR)
                    // so the freeze has >= 8 positive-weight eligible nodes. NOT for keyed lanes: CH/BL
                    // setWeight triggers a Maglev rebuild that allocates (~64KB), which 600x/cycle forces a
                    // workload major GC -- and their stickiness/reference oracles need no positive weights.
                    const wv = 1 + chaosRng.nextBelow(8);   // 1..8, always positive
                    if (lane.usesSetWeight) built.b.setWeight(node, wv);
                    weights[node] = wv;
                    qw.reset();
                }
            } else if (s === chaosEnd) {
                // FREEZE the configuration chaos left behind: make NO further membership/weight changes,
                // just reset the quality window so it accumulates cleanly over the FROZEN post-chaos state.
                // The oracle then observes the balancer's REAL drifted internals (a SmoothWRR regression
                // that fails to clear _current on a down transition, a stale table) -- NOT a re-derived
                // dense pool that would erase exactly the drift the audit targets. The dense restore
                // happens AFTER the loop, only for the B/op and hotOps micro-benches.
                // Keyed CH/BL: chaos may have driven the frozen weights near all-zero; restore the gradient
                // with ONE batched rebuild (setWeights: copy all nodes, then a single rebuild) so CH/BL
                // reach the freeze with >= 8 positive-weight eligible nodes and their weight-0 guard is ARMED.
                // Per-node setWeight would be CAP Maglev rebuilds (a workload major GC); this is exactly one.
                if (lane.keyed && lane.weighted && CAP >= 8) {
                    for (let i = 0; i < CAP; i++) weights[i] = 1 + (i & 7);
                    built.b.setWeights(weights);   // 1.1.0 public batch API: copy + ONE rebuild
                }
                qw.reset();
                // weight0 teeth: a DIRECT weight->0 write (no setWeight/no rebuild) so the kernel's
                // table/alias/accumulator still routes to node 7 while its weight reads 0 -> the H3 guard
                // must observe weight-0 picks in the frozen quiet-after window.
                if (lane.weighted && CAP > 7 && MF === 'weight0' && !mfWeightZeroDone) { weights[7] = 0; mfWeightZeroDone = true; }
            }
            step(ctx);
            let observed = ctx.lastPick;
            // imbalance teeth: in quiet-after, feed the oracle an all-to-node-0 stream -> RoundRobin
            // max-min and the chi-square must reject it.
            if (MF === 'imbalance' && s >= chaosEnd) observed = 0;
            qw.record(observed);

            const s1 = s + 1;
            if (s1 % checkEvery === 0 || s1 === cfg.picks) {
                // checkpoint (COLD): invariant only, out of any timed segment.
                checkCtx.keyHash = ctx.keyHash; checkCtx.lastPick = ctx.lastPick;
                const reason = MF === 'weight0' ? null : checkLane(lane, checkCtx); // weight0 desyncs invariants by design
                if (reason !== null) {
                    invariantFailures++;
                    if (firstFail === null) firstFail = reason;
                    breach('invariants lane=' + laneId + ' cycle=' + cycle + ' step=' + s1 + ' seed=0x' + seed.toString(16), reason);
                }
            }
        }
        totalPicks += cfg.picks;
        let liveAtEval = 0, posWtEligible = 0;
        for (let i = 0; i < CAP; i++) { if (eligible[i]) { liveAtEval++; if (!weights || weights[i] > 0) posWtEligible++; } }
        // BLOCKER 1 + NIT: EVERY weighted kernel lane (SmoothWRR/SED/NQ/WR via the settle-dense restore;
        // CH/BL via the one-rebuild restore above) must reach the freeze with >= 8 positive-weight eligible
        // nodes -- else the WR chi-square is a seed lottery AND the CH/BL weight-0 guard is excused wholesale.
        // Fail closed if violated.
        if (lane.weighted && CAP >= 8 && posWtEligible < 8) {
            invariantFailures++;
            if (firstFail === null) firstFail = 'posWtEligible ' + posWtEligible + ' < 8 at freeze';
            breach('invariants lane=' + laneId + ' cycle=' + cycle + ' kind=freeze', 'only ' + posWtEligible + ' positive-weight eligible nodes (need >= 8)');
        }
        // Quality on the FROZEN post-chaos state. PLAIN lanes use the QualityWindow (histogram-based
        // RR/SmoothWRR/WR + the H3 guard); LOAD/KEYED lanes use the argmin / P2C-bound / stickiness /
        // reference-walk oracles (oracles.mjs), driven here before the dense restore.
        let quality = qw.snapshot();
        const oracleRng = new Prng((seed ^ 0x0D15EA5E) >>> 0);
        const oracle = evaluateOracle(lane.name, built.b, eligible, inflight, weights, KEYS, KEY_COUNT, CAP, oracleRng);
        if (oracle !== null) {
            // S14: property oracles (ConsistentHash down-marking / rebuild, BoundedLoad cap) report their own
            // count and breach kind; WeightedRandom keeps its window chi-square AND adds the per-category pass.
            const isWR = lane.name === 'WeightedRandom';
            const propViol = oracle.propViol | 0;
            const rejViolation = isWR && quality.rejections > quality.rejMax ? 1 : 0;
            const total = oracle.viol + propViol + quality.weightZero + rejViolation;
            quality = {
                windows: qw.windows, oracleChecks: oracle.checks, oracleViol: oracle.viol,
                propertyChecks: oracle.propChecks | 0, propertyViol: propViol,
                violations: oracle.viol, weightZero: quality.weightZero,
                rejections: isWR ? quality.rejections : 0, rejMax: isWR ? quality.rejMax : 0, skipped: isWR ? quality.skipped : 0,
                insufficientData: oracle.insufficient || (isWR && quality.insufficientData),
                totalViolations: total,
                green: total === 0,
            };
        }
        // boxingRegime reflects whether the WORKLOAD clock crossed the SMI limit (a real long-run concern
        // for PeakEWMA). Capture it from the main loop, THEN reset the clock so the micro-benches measure
        // the steady-state 0-alloc regime -- their millions of extra ticks must not push a normal lane
        // into boxing and turn its hotAlloc gate INCONCLUSIVE.
        const boxingRegime = lane.family === 'latency' && ctx.now >= SMI_LIMIT;
        ctx.now = 0;

        // The micro-benches (hotOps, B/op) DO want a canonical dense pool, restored now (after quality).
        for (let i = 0; i < CAP; i++) built.b.setEligible(i, true);
        if (weights) { for (let i = 0; i < CAP; i++) { const w = 1 + (i & 7); if (lane.usesSetWeight) built.b.setWeight(i, w); weights[i] = w; } }

        // hotOps: time BOTH a DENSE and a fixed-seed SPARSE (~95% down) batch, because the tail cost of
        // this kernel lives in the sparse fallback scans and the ConsistentHash probe, not the dense
        // steady state. Median of REPEAT batches (low variance). The `decay` teeth is a REAL cycle-scaled
        // spin INSIDE the timed step -- it slows the measured code, it does not scale the reported number.
        for (let i = 0; i < HOTOPS_WARM; i++) step(ctx);
        // NIT 1: dense and sparse are SEPARATE gated series (a blended number needs an ~8-34x sparse
        // slowdown to move it; separated, each has its own 0.60 early/late verdict). The decay teeth
        // spins inside the timed step: `decay` slows both, `decaysparse` slows ONLY the sparse batch.
        // The decay spin grows linearly with the cycle and must DOMINATE the pick cost so the slowdown is
        // unambiguous (late/early ~ 3/8 at N=5); under it the batch is re-calibrated per cycle WITH the spin,
        // so a teeth run stays ~HOTOPS_MIN_MS per repeat instead of growing with cycle * calibrated length.
        // ops/s is length-independent once a repeat is >= HOTOPS_MIN_MS. A clean run calibrates ONCE.
        const spinDense = MF === 'decay' ? cycle * 400 : 0;
        const spinSparse = (MF === 'decay' || MF === 'decaysparse') ? cycle * 400 : 0;
        const nKey = lane.name + '#' + CAP;
        let nn = opsN.get(nKey);
        if (nn === undefined) { nn = { dense: calibrateBatch(step, ctx, HOTOPS_MIN_MS, 0), sparse: 0 }; opsN.set(nKey, nn); }
        if (spinDense) nn.dense = calibrateBatch(step, ctx, HOTOPS_MIN_MS, spinDense);
        const denseMs = timeBatch(step, ctx, nn.dense, spinDense, HOTOPS_REPS);
        setSparse(built.b, CAP, sparseRng);                            // ~95% down: fallback-scan / probe tail
        for (let i = 0; i < HOTOPS_WARM; i++) step(ctx);
        if (nn.sparse === 0) nn.sparse = calibrateBatch(step, ctx, HOTOPS_MIN_MS, 0);
        if (spinSparse) nn.sparse = calibrateBatch(step, ctx, HOTOPS_MIN_MS, spinSparse);
        const sparseMs = timeBatch(step, ctx, nn.sparse, spinSparse, HOTOPS_REPS);
        // Adjudication 3: also time the SPARSE batch PER-PICK and record sparse p50/p99/p999 (the audit-1.9
        // O(cap)-scan / CH-probe tail). REPORT-ONLY for 2a; the sparse latency gate lands in 2b. 0-alloc:
        // per-pick clock into the reused ring (sketch populated cold).
        latN = 0;
        for (let i = 0; i < LAT_SPARSE_PICKS; i++) {
            const t0s = performance.now();
            step(ctx);
            let d = (performance.now() - t0s) * 1e6;
            if (!(d >= 1)) d = 1; else if (d >= 1e9) d = 999999999;
            latRing[latN++] = d;
        }
        for (let k = 0; k < latN; k++) { latSlot[0] = latRing[k]; sparseSketch.addFrom(latSlot, 0); }
        const latencySparse = latN > 0
            ? { samples: latN, p50: +sparseSketch.quantile(0.5).toFixed(0), p99: +sparseSketch.quantile(0.99).toFixed(0), p999: +sparseSketch.quantile(0.999).toFixed(0), max: +sparseSketch.quantile(1).toFixed(0) }
            : { samples: 0, p50: 0, p99: 0, p999: 0, max: 0 };
        for (let i = 0; i < CAP; i++) built.b.setEligible(i, true);   // restore dense for the B/op probe
        if (weights) { for (let i = 0; i < CAP; i++) { const w = 1 + (i & 7); if (lane.usesSetWeight) built.b.setWeight(i, w); weights[i] = w; } }
        const hotOpsDense = denseMs > 0 ? (nn.dense / denseMs) * 1000 : 0;
        const hotOpsSparse = sparseMs > 0 ? (nn.sparse / sparseMs) * 1000 : 0;

        // T16 latency: sample pick latency on the CANONICAL DENSE pool (identical each cycle -> the
        // per-cycle p999 is comparable, so the early/late ratio measures kernel DRIFT, not the varying
        // chaos state). EVERY pick is timed (not 1-in-32): the p999 tail needs many samples to be stable
        // -- 3000 samples estimate p999 from ~3 points and the 1.5x ratio then false-fails on noise;
        // LAT_PICKS samples put ~LAT_PICKS/1000 points in the tail. Each timed delta (ns) goes into a
        // PRE-ALLOCATED Float64Array ring, which the calibrated probe reads at 0.000 B/op (performance.now()
        // + a typed-slot write do not box here). The DDSketch is populated COLD AFTER the pass -- addFrom
        // allocates, so it stays off the hot sampling path. now stays SMI (< 2^24).
        ctx.now = 0;
        latN = 0;
        for (let i = 0; i < LAT_PICKS; i++) {
            const t0n = performance.now();
            step(ctx);
            let d = (performance.now() - t0n) * 1e6;   // ms -> ns
            if (!(d >= 1)) d = 1; else if (d >= 1e9) d = 999999999;   // clamp [1, 1e9)
            latRing[latN++] = d;
        }
        for (let k = 0; k < latN; k++) { latSlot[0] = latRing[k]; latSketch.addFrom(latSlot, 0); }   // COLD

        ctx.now = 0;   // fresh SMI clock so the B/op probe measures PeakEWMA's non-boxing steady state
        const bop = measureHotBytesPerOp(ctx, step, BOP_OPS, BOP_WINDOWS, bias);
        const latency = latN > 0
            ? { samples: latN, p50: +latSketch.quantile(0.5).toFixed(0), p99: +latSketch.quantile(0.99).toFixed(0), p999: +latSketch.quantile(0.999).toFixed(0), max: +latSketch.quantile(1).toFixed(0) }
            : { samples: 0, p50: 0, p99: 0, p999: 0, max: 0 };
        // rebuildStorm timings -> sketch (COLD). Fewer samples than latency (rebuild is O(M*N)); the
        // rebuild gate stays inactive below LAT_MIN_SAMPLES (report-only) rather than gate vacuously.
        const rebuildSamples = Math.min(rebuildN, 512);
        for (let k = 0; k < rebuildSamples; k++) { latSlot[0] = rebuildRing[k]; rebuildSketch.addFrom(latSlot, 0); }
        const rebuildP99 = rebuildSamples > 0 ? +rebuildSketch.quantile(0.99).toFixed(0) : 0;
        return {
            seed, invariant: firstFail === null ? 'green' : firstFail,
            hotOpsDense, hotOpsSparse, hotOpsDenseN: nn.dense, hotOpsSparseN: nn.sparse,
            latency, latencySparse, rebuildP99, rebuildSamples,
            // JSON.stringify(Infinity) === null, so a non-finite (FAIL) B/op would read as "not measured"
            // to the 2b report tool. Record it as null AND flag hotBopNonFinite so the gate re-derives a FAIL.
            hotBytesPerOp: (bop.bop === null || !Number.isFinite(bop.bop)) ? null : +bop.bop.toFixed(3),
            hotBopNonFinite: bop.bop !== null && !Number.isFinite(bop.bop),
            // Per-pass B/op (bias-subtracted) for the cross-cycle recurrence rule (NIT1). max(pass1,pass2)
            // > bound recurring across >=2 post-warmup cycles = a periodic allocation rarer than one pass.
            hotBopPassMax: (bop.bopPass1 === null) ? null
                : (!Number.isFinite(bop.bopPass1) || !Number.isFinite(bop.bopPass2)) ? null
                : +Math.max(bop.bopPass1, bop.bopPass2).toFixed(3),
            hotBopGcFree: bop.gcFree, hotBopScavenged: bop.scavenged,
            boxingRegime, quality, liveAtEval, posWtEligible, phase, hasRebuild,
            weighted: lane.weighted, loadAware: lane.loadAware, latencyLane: lane.latency,   // flags for the report's applicability re-derivation (latencyLane != the DDSketch `latency`)
        };
    }

    for (let cycle = 0; (cfg.forever || cfg.durationBound || cycle < cfg.cycles) && !stopRequested; cycle++) {
        if (cfg.durationBound && performance.now() >= deadline) break;
        for (let li = 0; li < entries.length && !stopRequested; li++) {
            const tier = entries[li].tier;
            const laneId = entries[li].laneId;

            // --- POOL LANES (async, tier 'pool') -------------------------------------------------
            if (tier === 'pool') {
                const poolName = entries[li].poolName;
                const pseed = seedFor((cfg.seed ^ 0x504F4F4C) >>> 0, POOL_LANES.indexOf(poolName), cycle);
                current.lane = laneId; current.cycle = cycle; current.seeds = { seed: pseed }; current.tier = 'pool';
                const pcore = await runPoolCycle(poolName, CAP, M_CH, pseed, cfg, MF, { keys: KEYS, keyMask: KEY_MASK }, tracker);
                totalPicks += pcore.launched;   // pool runs count as work (so a pool-only run is not "nothing")
                poolLaunchedTotal += pcore.launched;
                if (MF === 'poolretain' && pcore.retainSink) leakSink.push(pcore.retainSink);   // A6 teeth: keep the leak alive
                // A macrotask so any trailing settle callbacks flush before the boundary drains the tracker.
                await new Promise((r) => setTimeout(r, 0));
                const pb = await closeLaneCycle(gc, tracker, null, { extraForcedGc: 0 });
                const retentionOk = pb.trackerSize === 0;
                const passed = pcore.assert1_inflightConsistent && pcore.assert2_quiescenceZero &&
                    pcore.assert3_accounted && pcore.assert4_codesOk && pcore.assert5_outcomeOk && retentionOk &&
                    pcore.assert8_noDownDispatch && pcore.assert9_little;
                if (!passed) {
                    poolFailures++;
                    const at = ' lane=' + laneId + ' cycle=' + cycle;
                    if (!pcore.assert1_inflightConsistent) breach('pool=A1' + at, 'totalInflight != sum(inflight) in flight');
                    if (!pcore.assert2_quiescenceZero) breach('pool=A2' + at, 'inflight not all-zero at quiescence');
                    if (!pcore.assert3_accounted) breach('pool=A3' + at, 'accounting' + (pcore.lostRun ? ': lost run, ' + pcore.pendingCount + ' pending' : ''));
                    if (!pcore.assert4_codesOk) breach('pool=A4' + at, 'unexpected rejection code ' + pcore.badCode);
                    if (!pcore.assert5_outcomeOk) breach('pool=A5' + at, 'outcome oracle: ' + pcore.outcomeMiss);
                    if (!retentionOk) breach('pool=A6' + at, 'tracker.size()=' + pb.trackerSize + ' drainMs=' + pb.drainMs);
                    if (!pcore.assert8_noDownDispatch) breach('pool=A8' + at, pcore.downDispatch + ' attempt(s) dispatched to a DOWN node');
                    if (!pcore.assert9_little) breach('pool=A9' + at, "Little's law: integral of sum(inflight) " + pcore.inflightArea + ' != sum of attempt time ' + pcore.attemptArea);
                }
                cyclesRun++;
                const prollup = {
                    lane: laneId, cycle, tier: 'pool',
                    launched: pcore.launched, resolved: pcore.resolved, rejected: pcore.rejected, perOutcome: pcore.perOutcome,
                    assert1: pcore.assert1_inflightConsistent, assert2: pcore.assert2_quiescenceZero,
                    assert3: pcore.assert3_accounted, lostRun: pcore.lostRun, pendingCount: pcore.pendingCount,
                    assert4: pcore.assert4_codesOk, assert5_outcome: pcore.assert5_outcomeOk,
                    assert6_retention: retentionOk, trackerSize: pb.trackerSize, forcedGcTries: pb.forcedGcTries, drainMs: pb.drainMs, badCode: pcore.badCode, outcomeMiss: pcore.outcomeMiss,
                    // S9/S10: down-dispatch (A8), Little's-law identity (A9), simulated RTTs (ns) and the trace hash.
                    assert8: pcore.assert8_noDownDispatch, downDispatch: pcore.downDispatch,
                    assert9: pcore.assert9_little, inflightArea: pcore.inflightArea, attemptArea: pcore.attemptArea,
                    rttP50Ns: pcore.rttP50Ns, rttP99Ns: pcore.rttP99Ns, rttMeanNs: pcore.rttMeanNs, svcMeanNs: pcore.svcMeanNs,
                    simUs: pcore.simUs, events: pcore.events, traceHash: pcore.traceHash,
                };
                rollupCount++;
                writeRecord(stream, 'cycle', prollup);
                continue;
            }

            const lane = entries[li].lane;
            const cap = lane.capOf(cycle), m = lane.mOf(cycle);
            const laneIndex = ROSTER.indexOf(lane.name);
            // tiny lanes draw from a salted base so their seed stream is distinct from the kernel lane's
            // (laneIndex stays within the 4-bit lane mask; the base carries the tier).
            const base = tier === 'tiny' ? (cfg.seed ^ 0x7A7A7A7A) >>> 0 : cfg.seed;
            const seed = seedFor(base, laneIndex, cycle);
            current.lane = laneId; current.cycle = cycle; current.seeds = { seed }; current.tier = tier;

            const core = runCycle(lane, seed, cycle, cap, m, laneId);

            // MUSTFAIL=rss teeth: retain a super-linear resident buffer so RSS runs away.
            if (MF === 'rss') { const bytes = Math.min(256 * 1048576, Math.floor(2 * 1048576 * (cyclesRun + 1) * (cyclesRun + 1))); leakSink.push(new Uint8Array(bytes).fill(cyclesRun & 255)); }

            const b = await closeLaneCycle(gc, tracker, null, { extraForcedGc: 0 });
            workloadMajorTotal += b.workloadMajor;
            if (b.trackerSize !== 0) {
                sizeFailures++;
                breach('retention lane=' + laneId + ' cycle=' + cycle, 'tracker.size()=' + b.trackerSize + ' drainMs=' + b.drainMs);
            }
            // A real quality VIOLATION fails any lane (kernel or tiny). But insufficientData -> only a
            // KERNEL lane can be INCONCLUSIVE; a tiny lane (cap in {1,2,3}) is a degenerate regime where
            // the statistical oracles (chi-square needs df>=8, P2C needs live>=8) legitimately cannot
            // gather a window -- report-only, never INCONCLUSIVE.
            // T8 self-check accumulation: merge this cycle's per-phase counts into the lane's totals.
            if (!phaseTotals.has(laneId)) { phaseTotals.set(laneId, {}); phaseApplicable.set(laneId, applicablePhases(lane, core.hasRebuild)); }
            const pt = phaseTotals.get(laneId);
            // MUSTFAIL=phaseskip teeth: drop the 'recover' phase's count (a scheduler that never reaches a
            // regime) -> the T8 self-check must FAIL with a `phases` breach.
            for (const k in core.phase) if (!(MF === 'phaseskip' && k === 'recover')) pt[k] = (pt[k] || 0) + core.phase[k];

            if (tier === 'kernel') lanesSeen.add(laneId);
            if (!core.quality.green) {
                qualityViolations += core.quality.totalViolations;
                const q = core.quality;
                const kinds = [];
                if (q.violations > 0) kinds.push('oracle');
                if (q.propertyViol > 0) kinds.push('property');
                if (q.weightZero > 0) kinds.push('weightZero');
                if (q.rejections > q.rejMax) kinds.push('chiSquare');
                breach('quality lane=' + laneId + ' cycle=' + cycle + ' kind=' + (kinds.join(',') || 'unknown'), JSON.stringify(q));
            } else if (tier === 'kernel' && !core.quality.insufficientData) {
                lanesConclusive.add(laneId);   // this kernel lane got a clean, sufficiently-windowed cycle
            }
            cyclesRun++;

            const elu = performance.eventLoopUtilization(prevElu);
            prevElu = performance.eventLoopUtilization();
            const telemetry = {
                eluUtilization: +elu.utilization.toFixed(4),
                loopDelayP50Ms: +(eld.percentile(50) / 1e6).toFixed(3),
                loopDelayP99Ms: +(eld.percentile(99) / 1e6).toFixed(3),
                loopDelayMaxMs: +(eld.max / 1e6).toFixed(3),
            };
            eld.reset();

            const rollup = {
                lane: laneId, cycle, tier,
                heapUsedMB: b.heapUsedMB, rssMB: b.rssMB,
                // S2: the pause metric is the MEAN workload pause (gcPauseAvgMs, report-only since 9c3); the MAX is
                // extreme-value noise and stays telemetry (gcPauseMs, its 1.0 name kept for continuity).
                gcMajor: b.workloadMajor, gcPauseMs: b.workloadMaxPauseMs, gcMinor: b.workloadMinor,
                gcPauseAvgMs: b.workloadAvgPauseMs, gcPauseCount: b.workloadPauseCount,
                hotOpsDense: +core.hotOpsDense.toFixed(0),
                hotOpsSparse: +core.hotOpsSparse.toFixed(0),
                hotOpsDenseN: core.hotOpsDenseN, hotOpsSparseN: core.hotOpsSparseN,
                latency: core.latency,
                latencySparse: core.latencySparse,
                rebuildP99: core.rebuildP99, rebuildSamples: core.rebuildSamples,
                phase: core.phase,
                hasRebuild: core.hasRebuild, weighted: core.weighted, loadAware: core.loadAware, latencyLane: core.latencyLane,
                hotBytesPerOp: core.hotBytesPerOp,
                hotBopNonFinite: core.hotBopNonFinite,
                hotBopPassMax: core.hotBopPassMax,
                hotBopGcFree: core.hotBopGcFree,
                hotBopScavenged: core.hotBopScavenged,
                boxingRegime: core.boxingRegime,
                totalPicks: cfg.picks,
                invariant: core.invariant,
                quality: core.quality,
                liveAtEval: core.liveAtEval,
                posWtEligible: core.posWtEligible,
                telemetry,
                trackerSize: b.trackerSize,
                forcedGcTries: b.forcedGcTries,
                drainMs: b.drainMs,
                heapSampledAfterGc: b.heapSampledAfterGc,
                seed: core.seed,
            };
            gateAcc.push(rollup);
            rollupCount++;
            writeRecord(stream, 'cycle', rollup);
        }
        const mem = process.memoryUsage();
        process.stdout.write('soak cycle ' + cycle + ': elapsed=' + ((performance.now() - t0) / 1000).toFixed(1) +
            's picks=' + totalPicks + ' rss=' + (mem.rss / 1048576).toFixed(1) + 'MB workloadMajor=' +
            workloadMajorTotal + ' invariants=' + (invariantFailures === 0 ? 'green' : invariantFailures + ' FAIL') + '\n');
    }
    gc.stop();

    const { verdict, gate, inconclusiveLanes, phasesNotFired, findings } = summarize('end');
    const wallS = ((performance.now() - t0) / 1000).toFixed(1);
    process.stdout.write('soak: ran ' + wallS + 's, ' + totalPicks + ' picks across ' + laneIds.length +
        ' lanes, workloadMajor ' + workloadMajorTotal + ', invariants ' +
        (invariantFailures === 0 ? 'green' : invariantFailures + ' FAIL') + ' -> ' + verdict + '\n');

    printVerdict({ verdict, gate, inconclusiveLanes, phasesNotFired, findings });
    process.exit(exitCodeFor(verdict));

    /** The final verdict lines (also used by the signal path). FAIL / INCONCLUSIVE go to stderr with one
     * line per reason; report-only NOTEs (S1 hotAlloc) go to stderr on every verdict so they stay visible. */
    function printVerdict({ verdict, gate, inconclusiveLanes, phasesNotFired, findings }) {
        for (const nt of gate.notes) process.stderr.write('soak: NOTE -- ' + nt + '\n');
        if (verdict === VERDICT.FAIL) {
            // Run-level breaches (the per-lane-cycle ones were already written when detected).
            if (unhandledCount) breach('pool=A7 lane=*', unhandledCount + ' unhandled rejection(s)');
            for (const pnf of (phasesNotFired || [])) {
                const dot = pnf.lastIndexOf('.');
                breach('phases lane=' + pnf.slice(0, dot), 'chaos phase never fired: ' + pnf.slice(dot + 1));
            }
            if ((findings && findings.length) || warns.length) breach('tracker lane=*', 'findings=' + (findings ? findings.length : 0) + ' warnings=' + warns.length);
            // gates.mjs breach strings are '<gate>[<lane>] <detail>' (totalPicks: no lane). Leading
            // `key=number` tokens of the detail (e.g. hotAlloc `bop=0.628 cycles=3`) move into the BREACH
            // head so a spec can match `bop>=0.3`; the remaining free text stays the detail. Existing specs
            // match only the `gate=`/`lane=` head tokens, so promoting MORE head tokens keeps them matching.
            for (const g of gate.breaches) {
                const m = /^(\w+)\[([^\]]+)\] ?(.*)$/.exec(g);
                if (m) {
                    const toks = m[3].length ? m[3].split(' ') : [];
                    let j = 0;
                    while (j < toks.length && /^[A-Za-z]\w*=-?\d+(?:\.\d+)?$/.test(toks[j])) j++;
                    const head = 'gate=' + m[1] + ' lane=' + m[2] + (j ? ' ' + toks.slice(0, j).join(' ') : '');
                    const rest = toks.slice(j).join(' ');
                    breach(head, rest.length ? rest : undefined);
                } else breach('gate=' + (/^(\w+)/.exec(g) || ['', 'unknown'])[1] + ' lane=*', g);
            }
            process.stderr.write('soak: FAIL -- invariants=' + invariantFailures + ' retention=' + sizeFailures +
                ' quality=' + qualityViolations + ' pool=' + poolFailures + ' unhandled=' + unhandledCount +
                ' phasesNotFired=' + (phasesNotFired ? phasesNotFired.length : 0) + ' gates=' + gate.breaches.length +
                ' (one `soak: BREACH` line each, above)\n');
        } else if (verdict === VERDICT.INCONCLUSIVE) {
            for (const why of gate.inconclusive) process.stderr.write('soak: INCONCLUSIVE -- ' + why + '\n');
            if (inconclusiveLanes.length) process.stderr.write('soak: INCONCLUSIVE -- quality windows never sufficient for lane(s): ' + inconclusiveLanes.join(', ') + '\n');
        } else {
            process.stdout.write('soak: PASS' + (gate.active ? '' : ' (smoke: drift gates report SMOKE)') + '\n');
        }
    }
}

// A crash in main() itself must still leave a fatal record + summary (route through the same path).
main().catch((e) => {
    try {
        if (fatalCtx) { writeFatal(fatalCtx.stream, 'mainRejection', fatalCtx.current(), e); fatalCtx.summarize('fatal'); }
    } catch (e2) { /* fall through to the plain line */ }
    process.stderr.write('soak: CRASH -- mainRejection: ' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(1);
});
