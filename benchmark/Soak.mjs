/**
 * @zakkster/lite-pick -- multi-strategy endurance soak (post-1.0 milestone #8).
 *
 *     node --expose-gc benchmark/Soak.mjs                 # bounded acceptance run
 *     SOAK_CYCLES=0 caffeinate -i node --expose-gc benchmark/Soak.mjs   # overnight burn-in
 *
 * The UNBOUNDED cousin of test/torture.mjs: a continuous mixed-chaos workload run once per
 * strategy LANE over a realistic pool (heavy pick streams + eligibility flap storms + whole-
 * pool-down troughs + weight retune churn + idle troughs + in-flight load feedback), snapshotting
 * RSS / GC / ops-sec and RUNNING the M4 invariant checkers (test/invariants.mjs, REUSED -- not
 * forked) at every checkpoint to catch slow drift no bounded gate can: RSS creep, GC-pause
 * degradation, throughput decay, a one-in-a-billion aggregate desync.
 *
 * ALL TEN strategies get a lane (LANES): RoundRobin, SmoothWRR, P2C, LeastConn, SED, NQ, PeakEWMA,
 * ConsistentHash, BoundedLoad, WeightedRandom. Each lane is a cold-path descriptor -- a factory that
 * builds the balancer + its caller-owned typed arrays, int/bool flags (keyed / weighted / usesSetWeight
 * / loadAware / notes / latency), the pickable-mass kind for checkBase's fail-closed IFF, and an
 * `extra` invariant that delegates to the right imported checker(s). The per-pick HOT LOOP is 0-alloc:
 * the descriptor is pre-resolved into locals before the loop; inside are only integer branches, pow2
 * masks, seeded Prng rolls, the pick call, and the inflight/note update.
 *
 * The proofs asserted every cycle:
 *   - tracker.size() returns to 0 after each cycle (no balancer outlived its scope), and
 *   - the lane's invariants are green at every checkpoint (live/aggregates exact, never a down pick,
 *     fail-closed IFF the pickable mass is 0). Emits a JSONL time-series to benchmark/soak.jsonl.
 *
 * COLD DRIFT GATES (computed from the collected series AFTER the run, cycle 0 dropped as warmup):
 *   - RSS creep:   late-window mean RSS <= earlyBaseline * GATE_RSS_MULT + GATE_RSS_ADD_MB  (global).
 *   - GC:          gcMajor === GATE_GC_MAJOR_MAX (hard, global).
 *   - throughput:  late opsPerSec >= GATE_THROUGHPUT_RATIO * early opsPerSec  (PER LANE).
 * A breach => non-zero exit naming the breached gate + the numbers. All bounds are named consts below.
 *
 * SOAK_MUSTFAIL = 'leak' | 'decay' | 'rss' is a documented TEETH-PROOF: it injects the matching
 * pathology on the COLD cycle boundary (retain the balancer / retain a per-cycle buffer / throttle late
 * checkpoints) so each gate can be shown to FAIL. Off by default; when set the run is EXPECTED to exit
 * non-zero naming that gate. The injection never touches the 0-alloc hot loop.
 *
 * Requires --expose-gc (retention gc + GcProfiler pause sampling).
 */

import { writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    RoundRobinBalancer, SmoothWRRBalancer, P2cBalancer, LeastConnBalancer, SedBalancer,
    NqBalancer, PeakEwmaBalancer, ConsistentHashBalancer, BoundedLoadBalancer, WeightedRandomBalancer,
    Prng, PICK_NONE, CH_PROBE_LIMIT,
} from '../Pick.js';
import {
    checkBase, checkConsistentHash, reachableWithinBound, checkBoundedLoad, checkWeightedRandom,
    recomputeLive, recomputeEligibleWeight, recomputeEligibleWeighted, allFinite,
} from '../test/invariants.mjs';

// JSONL schema (one record per checkpoint, appended across ALL lanes): { lane, cycle, checkpoint,
// tMs, picks, live, opsPerSec, rssMB, heapUsedMB, gcMajor, gcMinor, gcMaxPauseMs, trackerSize, invariant }.
const JSONL = fileURLToPath(new URL('./soak.jsonl', import.meta.url));

const CAP = 256;                                          // pool capacity (power of 2 -> pow2 mask)
const MASK = CAP - 1;                                     // pow2 modulo mask for the hot loop
const M_CH = 257;                                         // Maglev table size for keyed lanes (prime >= CAP)
const CYCLES = Number(process.env.SOAK_CYCLES ?? 2);     // 0 = run forever (overnight burn-in)
const PICKS_PER_CYCLE = Number(process.env.SOAK_PICKS ?? 60000);
const CHECKPOINTS = 5;
const CHECK_EVERY = Math.max(1, (PICKS_PER_CYCLE / CHECKPOINTS) | 0);

// --- drift-gate bounds (named consts -> one-line tunable; NEVER widen a bound to pass a gate) -------
const GATE_RSS_MULT = 1.25;          // late mean RSS <= early baseline * this ...
const GATE_RSS_ADD_MB = 8;           //   ... + this many MB of slack
const GATE_GC_MAJOR_MAX = 0;         // hard: zero major collections
const GATE_THROUGHPUT_RATIO = 0.60;  // late opsPerSec must stay >= this fraction of early

// --- SOAK_MUSTFAIL teeth-proof injection knobs (cold-boundary only) --------------------------------
const THROTTLE_MS = 12;              // decay: busy-spin at each late checkpoint
const RSS_LEAK_MB = 4;               // rss: MB retained per cycle to force process RSS creep

const noop = () => {};

// -------------------------------------------------------------------------------------------------
// LANES: one cold-path descriptor per strategy. `make(seed)` builds the balancer + its caller-owned
// arrays; the flags drive the hot loop; `massKind` selects the pickable-mass recompute for checkBase's
// fail-closed IFF (verified against each pick()'s exact PICK_NONE condition in Pick.js); `extra(b, ctx)`
// delegates to the imported strategy-specific checker(s). checkBase is applied to EVERY lane by check().
// -------------------------------------------------------------------------------------------------
const LANES = [
    {
        name: 'RoundRobin',
        keyed: false, weighted: false, usesSetWeight: false, loadAware: false, notes: false, latency: false,
        massKind: 'live',                                // pick() -> PICK_NONE iff live === 0
        make: (seed) => {
            const eligible = new Uint8Array(CAP).fill(1);
            return { b: new RoundRobinBalancer(CAP, eligible), eligible, inflight: null, weights: null };
        },
        extra: () => null,
    },
    {
        name: 'SmoothWRR',
        keyed: false, weighted: true, usesSetWeight: true, loadAware: false, notes: false, latency: false,
        massKind: 'eligibleWeight',                      // pick() -> PICK_NONE iff sum(eligible weights) === 0
        make: (seed) => {
            const eligible = new Uint8Array(CAP).fill(1);
            const weights = new Uint32Array(CAP);
            for (let i = 0; i < CAP; i++) weights[i] = 1 + (i & 7);
            return { b: new SmoothWRRBalancer(CAP, eligible, weights), eligible, inflight: null, weights };
        },
        extra: (b, ctx) => {
            const want = recomputeEligibleWeight(ctx.eligible, ctx.weights, ctx.cap);
            if (b._totalEligibleWeight !== want) {
                return '_totalEligibleWeight ' + b._totalEligibleWeight + ' != recomputed ' + want;
            }
            if (!allFinite(b._current, ctx.cap)) return '_current has a non-finite accumulator';
            return null;
        },
    },
    {
        name: 'P2C',
        keyed: false, weighted: false, usesSetWeight: false, loadAware: true, notes: false, latency: false,
        massKind: 'live',                                // two-choice: PICK_NONE iff live === 0
        make: (seed) => {
            const eligible = new Uint8Array(CAP).fill(1);
            const inflight = new Uint32Array(CAP);
            return { b: new P2cBalancer(CAP, eligible, inflight, seed), eligible, inflight, weights: null };
        },
        extra: () => null,
    },
    {
        name: 'LeastConn',
        keyed: false, weighted: false, usesSetWeight: false, loadAware: true, notes: false, latency: false,
        massKind: 'live',                                // exact fewest-in-flight: PICK_NONE iff live === 0
        make: (seed) => {
            const eligible = new Uint8Array(CAP).fill(1);
            const inflight = new Uint32Array(CAP);
            return { b: new LeastConnBalancer(CAP, eligible, inflight), eligible, inflight, weights: null };
        },
        extra: () => null,
    },
    {
        name: 'SED',
        keyed: false, weighted: true, usesSetWeight: false, loadAware: true, notes: false, latency: false,
        massKind: 'eligibleWeighted',                    // PICK_NONE iff no eligible node has weight > 0
        make: (seed) => {
            const eligible = new Uint8Array(CAP).fill(1);
            const inflight = new Uint32Array(CAP);
            const weights = new Uint32Array(CAP);
            for (let i = 0; i < CAP; i++) weights[i] = 1 + (i & 7);
            return { b: new SedBalancer(CAP, eligible, inflight, weights), eligible, inflight, weights };
        },
        extra: () => null,                               // reads weights live -> owns no Float64 state
    },
    {
        name: 'NQ',
        keyed: false, weighted: true, usesSetWeight: false, loadAware: true, notes: false, latency: false,
        massKind: 'eligibleWeighted',                    // PICK_NONE iff no eligible node has weight > 0
        make: (seed) => {
            const eligible = new Uint8Array(CAP).fill(1);
            const inflight = new Uint32Array(CAP);
            const weights = new Uint32Array(CAP);
            for (let i = 0; i < CAP; i++) weights[i] = 1 + (i & 7);
            return { b: new NqBalancer(CAP, eligible, inflight, weights), eligible, inflight, weights };
        },
        extra: () => null,                               // reads weights live -> owns no Float64 state
    },
    {
        name: 'PeakEWMA',
        keyed: false, weighted: false, usesSetWeight: false, loadAware: true, notes: false, latency: true,
        massKind: 'live',                                // latency-aware two-choice: PICK_NONE iff live === 0
        make: (seed) => {
            const eligible = new Uint8Array(CAP).fill(1);
            const inflight = new Uint32Array(CAP);
            return { b: new PeakEwmaBalancer(CAP, eligible, inflight, 1e6, seed), eligible, inflight, weights: null };
        },
        extra: (b, ctx) => {
            if (!allFinite(b._ewma, ctx.cap)) return '_ewma has a non-finite cell';
            if (!allFinite(b._stamp, ctx.cap)) return '_stamp has a non-finite cell';
            return null;
        },
    },
    {
        name: 'ConsistentHash',
        keyed: true, weighted: true, usesSetWeight: true, loadAware: false, notes: false, latency: false,
        massKind: 'reachable',                           // per-key: PICK_NONE iff no eligible backend reachable in bound
        make: (seed) => {
            const eligible = new Uint8Array(CAP).fill(1);
            const weights = new Uint32Array(CAP);
            for (let i = 0; i < CAP; i++) weights[i] = 1 + (i & 7);
            return { b: new ConsistentHashBalancer(CAP, eligible, weights, M_CH, seed), eligible, inflight: null, weights };
        },
        extra: (b, ctx) => checkConsistentHash(b, ctx.eligible, ctx.cap, ctx.lastPick),
    },
    {
        name: 'BoundedLoad',
        keyed: true, weighted: true, usesSetWeight: true, loadAware: true, notes: true, latency: false,
        massKind: 'reachable',                           // CHBL: PICK_NONE iff no eligible backend reachable (cap never fails closed)
        make: (seed) => {
            const eligible = new Uint8Array(CAP).fill(1);
            const inflight = new Uint32Array(CAP);
            const weights = new Uint32Array(CAP);
            for (let i = 0; i < CAP; i++) weights[i] = 1 + (i & 7);
            return { b: new BoundedLoadBalancer(CAP, eligible, inflight, 0.25, weights, M_CH, seed), eligible, inflight, weights };
        },
        extra: (b, ctx) => checkConsistentHash(b, ctx.eligible, ctx.cap, ctx.lastPick) ||
            checkBoundedLoad(b, ctx.inflight, ctx.cap),
    },
    {
        name: 'WeightedRandom',
        keyed: false, weighted: true, usesSetWeight: true, loadAware: false, notes: false, latency: false,
        massKind: 'eligibleWeighted',                    // PICK_NONE iff no eligible node has weight > 0
        make: (seed) => {
            const eligible = new Uint8Array(CAP).fill(1);
            const weights = new Uint32Array(CAP);
            for (let i = 0; i < CAP; i++) weights[i] = 1 + (i & 7);
            return { b: new WeightedRandomBalancer(CAP, eligible, weights, seed), eligible, inflight: null, weights };
        },
        extra: (b, ctx) => checkWeightedRandom(b, ctx.weights, ctx.cap),
    },
];

/** The pickable mass for a lane's fail-closed IFF (matches each pick()'s exact PICK_NONE condition). */
function massOf(lane, ctx) {
    switch (lane.massKind) {
        case 'live': return recomputeLive(ctx.eligible, ctx.cap);
        case 'eligibleWeight': return recomputeEligibleWeight(ctx.eligible, ctx.weights, ctx.cap);
        case 'eligibleWeighted': return recomputeEligibleWeighted(ctx.eligible, ctx.weights, ctx.cap);
        case 'reachable': return reachableWithinBound(ctx.b, ctx.eligible, ctx.keyHash, CH_PROBE_LIMIT);
        default: throw new Error('[soak] unknown massKind ' + lane.massKind);
    }
}

/** checkBase (universal) + the lane's strategy-specific extra invariant. Returns null or a reason. */
function checkLane(lane, ctx) {
    const mass = massOf(lane, ctx);
    const base = checkBase(ctx.b, ctx.eligible, ctx.cap, ctx.lastPick, mass);
    if (base !== null) return base;
    return lane.extra(ctx.b, ctx);
}

/** The chaos PRNG seed for a lane+cycle -- a pure function, echoed on every failure line for replay. */
function chaosSeed(lane, cycle) {
    return (0xC0FFEE ^ (cycle * 0x85EBCA77) ^ (lane.name.length * 0x2545F491)) >>> 0;
}

/** Deterministic busy-spin (cold path only) -- the decay teeth-proof throttle. */
function busySpinMs(ms) {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) { /* spin: inflate the segment wall, not the pick count */ }
}

/** Arithmetic mean of a numeric array (cold, for the post-run gates). */
function mean(xs) {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[i];
    return xs.length ? s / xs.length : 0;
}

async function main() {
    if (typeof globalThis.gc !== 'function') {
        process.stderr.write('soak: FAIL -- run with --expose-gc: node --expose-gc benchmark/Soak.mjs\n');
        process.exit(1);
    }
    // Fail-closed: the drift gates drop cycle 0 as warmup and split the REMAINDER into early/late
    // windows, so a single cycle leaves the gated set EMPTY -> every gate would vacuously pass (and
    // MF_DECAY/MF_RSS could not trip). Require >= 2 cycles (warmup + measured window), or 0 for the
    // overnight burn-in.
    if (CYCLES === 1) {
        process.stderr.write('soak: FAIL -- SOAK_CYCLES=1 leaves no gated window (cycle 0 is dropped as ' +
            'warmup); the drift gates need >= 2 cycles, or SOAK_CYCLES=0 for the overnight burn-in\n');
        process.exit(1);
    }

    // Teeth-proof knob: validate fail-closed (unknown value is an error with a did-you-mean hint).
    const MUSTFAIL = process.env.SOAK_MUSTFAIL;
    if (MUSTFAIL !== undefined && MUSTFAIL !== 'leak' && MUSTFAIL !== 'decay' && MUSTFAIL !== 'rss') {
        process.stderr.write("soak: FAIL -- unknown SOAK_MUSTFAIL '" + MUSTFAIL +
            "' (did you mean leak | decay | rss?)\n");
        process.exit(2);
    }
    const MF_LEAK = MUSTFAIL === 'leak';
    const MF_DECAY = MUSTFAIL === 'decay';
    const MF_RSS = MUSTFAIL === 'rss';

    const { GcProfiler } = await import('@zakkster/lite-gc-profiler');
    const { createLeakTracker } = await import('@zakkster/lite-leak');

    const warns = [];
    const tracker = createLeakTracker({
        name: 'lite-pick-soak',
        onWarning: (w) => warns.push(w.kind + ':' + w.reason),
    });
    const gc = new GcProfiler().start();
    writeFileSync(JSONL, ''); // fresh time-series

    const series = [];        // COLD: every checkpoint record, for the post-run drift gates
    const leakSink = [];      // MF_LEAK: retains balancers so tracker.size() cannot return to 0
    const rssSink = [];       // MF_RSS: retains per-cycle buffers so process RSS creeps
    let invariantFailures = 0;
    let sizeFailures = 0;
    let totalPicks = 0;
    let workloadMajor = 0;    // major GC induced BY THE PICK LOOP (excludes forced retention gc())
    const t0 = performance.now();

    // One cycle of chaos for ONE lane, in its own frame so the balancer is torn down before we gc.
    // Everything the hot loop touches is pre-resolved into locals/typed-arrays here (cold), so the
    // per-pick loop body is a flat run of integer branches + one pick + one inflight/note update -- 0-alloc.
    function runCycle(lane, cycle) {
        const built = lane.make((0x51A17ED ^ (cycle * 0x9E3779B1)) >>> 0);
        const b = built.b, eligible = built.eligible, inflight = built.inflight, weights = built.weights;
        tracker.track(b, noop, lane.name, { audit: true });      // tag is a string; cleanup closes over nothing
        if (MF_LEAK) leakSink.push(b);                           // teeth-proof: pin the balancer -> retention FAIL

        // The chaos PRNG seed -- a pure function of lane + cycle. Echoed on every failure line so a
        // breach is one-step reproducible (the fuzzer's seed-print discipline).
        const seed = chaosSeed(lane, cycle);
        const rng = new Prng(seed);
        const keyed = lane.keyed, latency = lane.latency, loadAware = lane.loadAware;
        const notes = lane.notes, weighted = lane.weighted, usesSetWeight = lane.usesSetWeight;

        const ctx = { b, cap: CAP, eligible, inflight, weights, keyHash: 0, lastPick: PICK_NONE };
        let keyHash = 0, now = 0, allDown = false;
        let segMs0 = performance.now();
        let segPicks0 = 0;
        // Major GC at the START of this cycle's pick loop. The forced retention gc() runs on the COLD
        // boundary BETWEEN cycles, so its major collections are already counted here -> the in-cycle
        // delta isolates the WORKLOAD's own major GC (the gate quantity), never the harness's.
        const majorAtCycleStart = gc.summary().gc.major;

        for (let step = 1; step <= PICKS_PER_CYCLE; step++) {
            // --- chaos: inline integer branches on the seeded PRNG (all cold-ish, rare rolls) --------
            const roll = rng.nextBelow(1000);
            if (roll < 3) {
                for (let i = 0; i < CAP; i++) b.setEligible(i, false);   // whole-pool-down trough
                allDown = true;
            } else if (allDown && roll < 8) {
                for (let i = 0; i < CAP; i++) b.setEligible(i, true);    // recover next tick
                allDown = false;
            } else if (roll < 40) {
                b.setEligible(rng.nextBelow(CAP), (rng.nextBelow(2) === 0)); // single-node flap storm
                if (allDown) allDown = false;
            } else if (roll < 45 && weighted) {
                // weight retune: cold setWeight churn on weighted lanes (SED/NQ read weights live).
                const wi = rng.nextBelow(CAP), wv = 1 + rng.nextBelow(8);
                if (usesSetWeight) b.setWeight(wi, wv); else weights[wi] = wv;
            } else if (roll < 48 && loadAware) {
                // idle trough: near-zero arrival burst -> drain occupancy toward zero.
                for (let i = 0; i < CAP; i++) {
                    const c = inflight[i];
                    if (c > 0) { if (notes) b.note(i, -c); inflight[i] = 0; }
                }
            }

            // --- pick: integer-branched by lane flag (keyed keyHash / latency now / plain) ----------
            let p;
            if (keyed) { keyHash = rng.next() >>> 0; p = b.pick(keyHash); }
            else if (latency) { now += 1 + rng.nextBelow(1024); p = b.pick(now); }
            else p = b.pick();

            // --- load feedback: dispatch/settle (BoundedLoad mirrors EVERY change through note()) ----
            if (loadAware && p !== PICK_NONE) {
                if (notes) {
                    inflight[p]++; b.note(p, 1);
                    if (rng.nextBelow(2) === 0 && inflight[p] > 0) { inflight[p]--; b.note(p, -1); }
                } else {
                    inflight[p]++;
                    if (rng.nextBelow(2) === 0 && inflight[p] > 0) inflight[p]--;
                }
            }
            if (latency && p !== PICK_NONE && (roll & 3) === 1) b.recordRtt(p, rng.nextBelow(500000), now);

            totalPicks++;

            // --- checkpoint: invariants + JSONL snapshot (COLD; ~1 in CHECK_EVERY picks) ------------
            if (step % CHECK_EVERY === 0) {
                const cp = (step / CHECK_EVERY) | 0;
                // decay teeth-proof: throttle the LATE checkpoints so late opsPerSec collapses.
                if (MF_DECAY && cp * 2 > CHECKPOINTS) busySpinMs(THROTTLE_MS);
                const tNow = performance.now();
                const segMs = tNow - segMs0;
                const segOps = step - segPicks0;
                const opsPerSec = segMs > 0 ? (segOps / segMs) * 1000 : 0;
                segMs0 = tNow; segPicks0 = step;

                ctx.keyHash = keyHash; ctx.lastPick = p;
                const mass = massOf(lane, ctx);
                const reason = checkLane(lane, ctx);
                const gs = gc.summary();
                const mem = process.memoryUsage();
                const rec = {
                    lane: lane.name,
                    cycle,
                    checkpoint: cp,
                    tMs: +(tNow - t0).toFixed(1),
                    picks: totalPicks,
                    live: mass,
                    opsPerSec: +opsPerSec.toFixed(0),
                    rssMB: +(mem.rss / 1048576).toFixed(1),
                    heapUsedMB: +(mem.heapUsed / 1048576).toFixed(1),
                    gcMajor: gs.gc.major,                    // cumulative (incl. forced retention gc), informational
                    gcMajorInCycle: gs.gc.major - majorAtCycleStart, // WORKLOAD major GC -> the gate quantity
                    gcMinor: gs.gc.minor,
                    gcMaxPauseMs: +gs.gc.maxMs.toFixed(3),
                    trackerSize: tracker.size(),
                    invariant: reason === null ? 'ok' : reason,
                };
                series.push(rec);
                appendFileSync(JSONL, JSON.stringify(rec) + '\n');
                if (reason !== null) {
                    invariantFailures++;
                    process.stderr.write('  soak invariant FAIL lane ' + lane.name + ' cycle ' + cycle +
                        ' step ' + step + ' cp ' + cp + ' seed=0x' + seed.toString(16) + ': ' + reason + '\n');
                }
            }
        }
        workloadMajor += gc.summary().gc.major - majorAtCycleStart;
    }

    // --- run: one lane at a time, CYCLES cycles each (forever when CYCLES === 0) --------------------
    const forever = CYCLES === 0;
    let cyclesRun = 0;
    for (let li = 0; li < LANES.length; li++) {
        const lane = LANES[li];
        let cycle = 0;
        while (forever || cycle < CYCLES) {
            runCycle(lane, cycle);

            // rss teeth-proof: retain a per-cycle buffer on the COLD boundary -> process RSS creeps.
            if (MF_RSS) rssSink.push(new Uint8Array(RSS_LEAK_MB * 1048576).fill(cycle & 255));

            // retention proof: the cycle's balancer must be collectable -- tracker.size() -> 0.
            globalThis.gc();
            await new Promise((r) => setTimeout(r, 0));
            let live = tracker.size();
            for (let i = 0; i < 8 && live > 0; i++) {
                globalThis.gc();
                await new Promise((r) => setTimeout(r, 0));
                live = tracker.size();
            }
            if (live !== 0) {
                sizeFailures++;
                process.stderr.write('  soak retention FAIL lane ' + lane.name + ' cycle ' + cycle +
                    ' seed=0x' + chaosSeed(lane, cycle).toString(16) +
                    ': tracker.size()=' + live + ' (expected 0)\n');
            }
            cyclesRun++;
            cycle++;
        }
        process.stdout.write('soak lane ' + lane.name.padEnd(14) + ' done: picks=' + totalPicks +
            ' invariants=' + (invariantFailures === 0 ? 'green' : invariantFailures + ' FAIL') +
            ' retention=' + (sizeFailures === 0 ? 'clean' : sizeFailures + ' FAIL') + '\n');
    }
    const findings = tracker.audit();
    gc.stop();

    // --- cold drift gates, computed from the collected series (cycle 0 dropped as warmup) ----------
    const breaches = [];
    const gated = series.filter((r) => r.cycle !== 0);

    // GC (hard, global): no WORKLOAD-induced major collection post-warmup. The gate reads the in-cycle
    // delta (the forced retention gc() runs on the cold boundary and is deliberately excluded).
    let gcMajor = 0;
    for (const r of gated) if (r.gcMajorInCycle > gcMajor) gcMajor = r.gcMajorInCycle;
    if (gcMajor > GATE_GC_MAJOR_MAX) breaches.push('gc: workload major=' + gcMajor + ' > ' + GATE_GC_MAJOR_MAX);

    // RSS creep (global, time-ordered): late mean vs early baseline.
    if (gated.length >= 2) {
        const rss = gated.map((r) => r.rssMB);
        const half = rss.length >> 1;
        const early = mean(rss.slice(0, half));
        const late = mean(rss.slice(rss.length - half));
        const limit = early * GATE_RSS_MULT + GATE_RSS_ADD_MB;
        if (late > limit) {
            breaches.push('rss: late=' + late.toFixed(1) + 'MB > limit=' + limit.toFixed(1) +
                'MB (early baseline=' + early.toFixed(1) + 'MB)');
        }
    }

    // Throughput decay (PER LANE): late opsPerSec vs early opsPerSec for that strategy.
    for (let li = 0; li < LANES.length; li++) {
        const name = LANES[li].name;
        const ops = gated.filter((r) => r.lane === name).map((r) => r.opsPerSec);
        if (ops.length >= 2) {
            const half = ops.length >> 1;
            const early = mean(ops.slice(0, half));
            const late = mean(ops.slice(ops.length - half));
            if (late < GATE_THROUGHPUT_RATIO * early) {
                breaches.push('throughput[' + name + ']: late=' + late.toFixed(0) +
                    ' ops/s < ' + (GATE_THROUGHPUT_RATIO * early).toFixed(0) +
                    ' (early=' + early.toFixed(0) + ', ratio=' + GATE_THROUGHPUT_RATIO + ')');
            }
        }
    }

    // --- headline: cross-lane final summary --------------------------------------------------------
    const wallS = ((performance.now() - t0) / 1000).toFixed(1);
    const rssBaseline = series.length ? series[0].rssMB : 0;
    const rssEnd = series.length ? series[series.length - 1].rssMB : 0;
    const rssTrend = breaches.some((s) => s.startsWith('rss:')) ? 'CREEP' : 'flat';
    const invariantsGreen = invariantFailures === 0;
    const ok = invariantsGreen && sizeFailures === 0 && findings.length === 0 &&
        warns.length === 0 && breaches.length === 0;

    process.stdout.write('soak: ran ' + wallS + 's, ' + totalPicks + ' picks across ' + LANES.length +
        ' lanes, RSS ' + rssBaseline + '->' + rssEnd + ' MB (' + rssTrend + '), GC major ' + workloadMajor +
        ', invariants ' + (invariantsGreen ? 'green' : invariantFailures + ' FAIL') +
        ' at all ' + series.length + ' checkpoints -> ' + (ok ? 'PASS' : 'FAIL') + '\n');

    if (!ok) {
        if (!invariantsGreen) process.stderr.write('soak: FAIL -- invariants ' + invariantFailures + ' checkpoint(s)\n');
        if (sizeFailures !== 0) process.stderr.write('soak: FAIL -- retention (leak): tracker.size() != 0 after ' + sizeFailures + ' cycle(s)\n');
        if (findings.length !== 0) for (const f of findings) process.stderr.write('soak: FAIL -- finding ' + f.kind + ':' + f.reason + '\n');
        if (warns.length !== 0) for (const w of warns) process.stderr.write('soak: FAIL -- warning ' + w + '\n');
        for (const g of breaches) process.stderr.write('soak: FAIL -- gate ' + g + '\n');
        process.exit(1);
    }
    void cyclesRun;
}

main().catch((e) => {
    process.stderr.write('soak: FAIL -- ' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(1);
});
