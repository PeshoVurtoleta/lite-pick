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
import os from 'node:os';
import {
    RoundRobinBalancer, SmoothWRRBalancer, P2cBalancer, LeastConnBalancer, SedBalancer,
    NqBalancer, PeakEwmaBalancer, ConsistentHashBalancer, BoundedLoadBalancer, WeightedRandomBalancer,
    Prng, PICK_NONE, CH_PROBE_LIMIT,
} from '../Pick.js';
import {
    checkBase, checkConsistentHash, reachableWithinBound, checkBoundedLoad, checkWeightedRandom,
    recomputeLive, recomputeEligibleWeight, recomputeEligibleWeighted, allFinite,
} from '../test/invariants.mjs';

// JSONL is a TYPED, self-describing stream: every record carries a `type` field. Kinds:
//   { type:"header", ... }      one line at startup: env + config + gate bounds + lane roster/seeds.
//   { type:"checkpoint", ... }  per checkpoint: lane, cycle, checkpoint, ts, picks, live, opsPerSec,
//                               rssMB, heapUsedMB, gcMajor(+InCycle), gcMinor, gcMaxPauseMs, trackerSize, invariant.
//   { type:"cycle", ... }       per lane per cycle (coarse charting series): rss/heap min/mean/max, gc deltas,
//                               gcMaxPauseMs, opsPerSec, invariant status, trackerSize after retention gc.
//   { type:"summary", ... }     gate-margin payload: at bounded-run end, periodically in forever mode, and on
//                               SIGINT/SIGTERM. Reports each gate's observed value, bound, and margin.
// Log volume is throttled by SOAK_LOG: `full` emits every record kind; `cycle` SUPPRESSES per-checkpoint
// records (header+cycle+summary only). Default: `cycle` for forever runs, `full` for bounded. The throttle
// affects EMISSION ONLY -- invariant/retention checks + gate sampling run every checkpoint regardless.
const JSONL = fileURLToPath(new URL('./soak.jsonl', import.meta.url));

const CAP = 256;                                          // pool capacity (power of 2 -> pow2 mask)
const MASK = CAP - 1;                                     // pow2 modulo mask for the hot loop
const M_CH = 257;                                         // Maglev table size for keyed lanes (prime >= CAP)
const CYCLES = Number(process.env.SOAK_CYCLES ?? 2);     // 0 = run forever (overnight burn-in)
const PICKS_PER_CYCLE = Number(process.env.SOAK_PICKS ?? 60000);
const CHECKPOINTS = 5;
const CHECK_EVERY = Math.max(1, (PICKS_PER_CYCLE / CHECKPOINTS) | 0);

// --- drift-gate bounds (named consts -> one-line tunable; NEVER widen a bound to pass a gate) -------
// Recalibrated from a 4h/67k-cycle run: heapUsed was FLAT (~22->24MB) under a benign RSS fragmentation
// band (~125-158MB that OSCILLATES over a flat heap). The PRIMARY memory gate is therefore heapUsed (the
// true leak signal), and RSS is a GENEROUS runaway guard tolerant of arena oscillation. Both read the
// coarse CYCLE-ROLLUP series (median/p95 over per-lane-cycle means), never the noisy per-checkpoint series.
const GATE_HEAP_MULT = 1.25;         // PRIMARY: late-quarter MEDIAN heap <= early-quarter MEDIAN * this ...
const GATE_HEAP_SLACK_MB = 8;        //   ... + this many MB slack (a real heap climb to 100MB+ trips it)
const GATE_RSS_MULT = 1.75;          // RUNAWAY GUARD: late-quarter p95 RSS <= band-center MEDIAN * this ...
const GATE_RSS_SLACK_MB = 16;        //   ... + this many MB slack (tolerates fragmentation, catches a climb)
const GATE_GC_MAJOR_MAX = 0;         // hard: zero WORKLOAD major collections
const GATE_THROUGHPUT_RATIO = 0.60;  // late opsPerSec must stay >= this fraction of early (per lane)

// --- SOAK_MUSTFAIL teeth-proof injection knobs (cold-boundary only) --------------------------------
const THROTTLE_MS = 12;              // decay: busy-spin at each late checkpoint
const RSS_LEAK_MB = 4;               // rss: accelerating MB retained per cycle -> RSS runaway
const LEAK_ARRAY_LEN = 700000;       // leak: plain-array length retained per lane-cycle -> heapUsed climb

const WARMUP_CYCLES = 1;             // drift gates drop cycle 0 (JIT/alloc settling) from all math
// Forever-mode memory bound: the in-memory checkpoint series feeds the gate/summary math only (the
// DURABLE analysis artifact is soak.jsonl on disk). A multi-hour run would grow it without bound, so
// cap it -- keeping the EARLY baseline window + the RECENT window, dropping the middle. Bounded runs
// never reach the cap, so their gate math is byte-identical.
const SERIES_CAP = 50000;

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

/** The balancer construction seed for a cycle -- a pure function (feeds each lane's internal PRNG). */
function balancerSeed(cycle) {
    return (0x51A17ED ^ (cycle * 0x9E3779B1)) >>> 0;
}

/** min/mean/max of a numeric array (cold, for the cycle rollups). */
function stats(xs) {
    let lo = Infinity, hi = -Infinity, s = 0;
    for (let i = 0; i < xs.length; i++) { const v = xs[i]; if (v < lo) lo = v; if (v > hi) hi = v; s += v; }
    const n = xs.length || 1;
    return { min: +((lo === Infinity ? 0 : lo)).toFixed(1), mean: +(s / n).toFixed(1), max: +((hi === -Infinity ? 0 : hi)).toFixed(1) };
}

/** Median of a numeric array (cold; robust to GC-timing noise vs mean). 0 if empty. */
function median(xs) {
    if (!xs.length) return 0;
    const s = xs.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Nearest-rank percentile of a numeric array (cold; p in [0,1]). 0 if empty. */
function percentile(xs, p) {
    if (!xs.length) return 0;
    const s = xs.slice().sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
    return s[idx];
}

/**
 * Cold: compute the drift-gate verdicts + fine-tuning MARGINS (cycle 0 dropped as warmup). The MEMORY
 * gates (heap PRIMARY, rss RUNAWAY-GUARD) read the coarse CYCLE-ROLLUP series (per-lane-cycle means) --
 * median/p95, robust to noise and to per-checkpoint EMISSION being throttled. gcMajor + throughput read
 * the per-checkpoint series unchanged. Too-short windows are marked insufficient-data (neither vacuous-
 * pass nor false-fail). Returns { breaches, gcMajor, gcPass, heap, rss, throughput }.
 */
function computeGates(series, cycleSeries) {
    const gated = series.filter((r) => r.cycle >= WARMUP_CYCLES);
    const cycles = cycleSeries.filter((r) => r.cycle >= WARMUP_CYCLES);
    const breaches = [];

    // GC (hard, global): the max WORKLOAD-induced (in-cycle) major count; forced retention gc() excluded.
    let gcMajor = 0;
    for (const r of gated) if (r.gcMajorInCycle > gcMajor) gcMajor = r.gcMajorInCycle;
    const gcPass = gcMajor <= GATE_GC_MAJOR_MAX;
    if (!gcPass) breaches.push('gc: workload major=' + gcMajor + ' > ' + GATE_GC_MAJOR_MAX);

    // MEMORY gates over the cycle-rollup means. Need >= 4 rollups to form early/late quarters.
    let heap = null, rss = null;
    if (cycles.length >= 4) {
        const q = Math.max(1, Math.floor(cycles.length / 4));
        const heapMeans = cycles.map((r) => r.heapUsedMB.mean);
        const rssMeans = cycles.map((r) => r.rssMB.mean);

        // PRIMARY -- heapUsed (the true leak signal): late-quarter median vs early-quarter median.
        const earlyMed = median(heapMeans.slice(0, q));
        const lateMed = median(heapMeans.slice(heapMeans.length - q));
        const heapLimit = earlyMed * GATE_HEAP_MULT + GATE_HEAP_SLACK_MB;
        const heapPass = lateMed <= heapLimit;
        heap = {
            earlyMedianMB: +earlyMed.toFixed(1), lateMedianMB: +lateMed.toFixed(1), limitMB: +heapLimit.toFixed(1),
            mult: GATE_HEAP_MULT, slackMB: GATE_HEAP_SLACK_MB, headroomMB: +(heapLimit - lateMed).toFixed(1), pass: heapPass,
        };
        if (!heapPass) {
            breaches.push('heap: late-quarter median=' + lateMed.toFixed(1) + 'MB > limit=' + heapLimit.toFixed(1) +
                'MB (early-quarter median=' + earlyMed.toFixed(1) + 'MB, mult=' + GATE_HEAP_MULT + ', slack=' + GATE_HEAP_SLACK_MB + 'MB)');
        }

        // RUNAWAY GUARD -- rss: late-quarter p95 vs the post-warmup band-center (median), fragmentation-tolerant.
        const bandCenter = median(rssMeans);
        const lateP95 = percentile(rssMeans.slice(rssMeans.length - q), 0.95);
        const rssLimit = bandCenter * GATE_RSS_MULT + GATE_RSS_SLACK_MB;
        const rssPass = lateP95 <= rssLimit;
        rss = {
            guard: 'runaway', bandCenterMB: +bandCenter.toFixed(1), lateP95MB: +lateP95.toFixed(1), limitMB: +rssLimit.toFixed(1),
            mult: GATE_RSS_MULT, slackMB: GATE_RSS_SLACK_MB, headroomMB: +(rssLimit - lateP95).toFixed(1), pass: rssPass,
        };
        if (!rssPass) {
            breaches.push('rss-runaway: late-quarter p95=' + lateP95.toFixed(1) + 'MB > limit=' + rssLimit.toFixed(1) +
                'MB (band-center median=' + bandCenter.toFixed(1) + 'MB, mult=' + GATE_RSS_MULT + ', slack=' + GATE_RSS_SLACK_MB + 'MB)');
        }
    } else {
        heap = { insufficientData: true, rollups: cycles.length };
        rss = { insufficientData: true, rollups: cycles.length };
    }

    // Throughput decay (PER LANE, unchanged): late opsPerSec vs early opsPerSec over the checkpoint series.
    const perLane = [];
    let minRatio = Infinity;
    for (const lane of LANES) {
        const ops = gated.filter((r) => r.lane === lane.name).map((r) => r.opsPerSec);
        if (ops.length >= 2) {
            const half = ops.length >> 1;
            const early = mean(ops.slice(0, half));
            const late = mean(ops.slice(ops.length - half));
            const ratio = early > 0 ? late / early : 1;
            const pass = late >= GATE_THROUGHPUT_RATIO * early;
            perLane.push({ lane: lane.name, earlyOps: +early.toFixed(0), lateOps: +late.toFixed(0), ratio: +ratio.toFixed(3), pass });
            if (ratio < minRatio) minRatio = ratio;
            if (!pass) {
                breaches.push('throughput[' + lane.name + ']: late=' + late.toFixed(0) +
                    ' ops/s < ' + (GATE_THROUGHPUT_RATIO * early).toFixed(0) +
                    ' (early=' + early.toFixed(0) + ', ratio=' + GATE_THROUGHPUT_RATIO + ')');
            }
        }
    }
    if (minRatio === Infinity) minRatio = 0;
    const throughput = {
        bound: GATE_THROUGHPUT_RATIO, observedMinRatio: +minRatio.toFixed(3),
        pass: perLane.every((p) => p.pass), perLane,
    };

    return { breaches, gcMajor, gcPass, heap, rss, throughput };
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

    // Log-volume knob: `full` emits every record; `cycle` suppresses per-checkpoint EMISSION (a 4h run
    // wrote 1.9GB of them). Default: `cycle` for forever/overnight, `full` for bounded qa. Emission only --
    // invariant/retention checks + gate sampling run every checkpoint regardless (fail-closed on an unknown).
    const LOG_ENV = process.env.SOAK_LOG;
    if (LOG_ENV !== undefined && LOG_ENV !== 'full' && LOG_ENV !== 'cycle') {
        process.stderr.write("soak: FAIL -- unknown SOAK_LOG '" + LOG_ENV +
            "' (did you mean full | cycle?)\n");
        process.exit(2);
    }
    const LOG_MODE = LOG_ENV !== undefined ? LOG_ENV : (CYCLES === 0 ? 'cycle' : 'full');
    const LOG_FULL = LOG_MODE === 'full';

    const { GcProfiler } = await import('@zakkster/lite-gc-profiler');
    const { createLeakTracker } = await import('@zakkster/lite-leak');

    const warns = [];
    const tracker = createLeakTracker({
        name: 'lite-pick-soak',
        onWarning: (w) => warns.push(w.kind + ':' + w.reason),
    });
    const gc = new GcProfiler().start();
    writeFileSync(JSONL, ''); // fresh time-series

    const series = [];        // COLD: checkpoint records for gcMajor + throughput gates (bounded; see SERIES_CAP)
    const cycleSeries = [];   // COLD: cycle-rollup records for the MEMORY gates (heap + rss); bounded likewise
    const leakSink = [];      // MF_LEAK: retains balancers + heap arrays so tracker.size() != 0 AND heap climbs
    const rssSink = [];       // MF_RSS: retains per-cycle buffers so process RSS runs away
    let invariantFailures = 0;
    let sizeFailures = 0;
    let totalPicks = 0;
    let cyclesRun = 0;
    let workloadMajor = 0;    // major GC induced BY THE PICK LOOP (excludes forced retention gc())
    const t0 = performance.now();
    const forever = CYCLES === 0;

    /** Append one typed record to the durable JSONL stream (synchronous -- survives a kill). */
    function writeRecord(rec) {
        appendFileSync(JSONL, JSON.stringify(rec) + '\n');
    }

    /** Push into an in-memory gate series, bounding it (forever mode) by dropping the middle. */
    function pushBounded(arr, rec) {
        arr.push(rec);
        if (arr.length > SERIES_CAP) {
            const keepEarly = SERIES_CAP >> 2;          // preserve the early baseline window ...
            arr.splice(keepEarly, arr.length - SERIES_CAP);   // ... drop the middle, keep the recent tail
        }
    }

    // --- HEADER: self-describing first line (env + config + gate bounds + lane roster/seeds) --------
    writeRecord({
        type: 'header',
        startedAt: new Date().toISOString(),
        node: process.version,
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        cap: CAP,
        maglevM: M_CH,
        cycles: CYCLES,                                 // 0 = forever
        picksPerCycle: PICKS_PER_CYCLE,
        checkpointsPerCycle: CHECKPOINTS,
        checkEvery: CHECK_EVERY,
        warmupCyclesDropped: WARMUP_CYCLES,
        seriesCap: SERIES_CAP,
        mustFail: MUSTFAIL ?? null,
        logMode: LOG_MODE,
        gates: {
            heapMult: GATE_HEAP_MULT, heapSlackMB: GATE_HEAP_SLACK_MB,
            rssMult: GATE_RSS_MULT, rssSlackMB: GATE_RSS_SLACK_MB,
            gcMajorMax: GATE_GC_MAJOR_MAX, throughputRatio: GATE_THROUGHPUT_RATIO,
        },
        seedFormula: {
            chaos: '(0xC0FFEE ^ (cycle*0x85EBCA77) ^ (name.length*0x2545F491)) >>> 0',
            balancer: '(0x51A17ED ^ (cycle*0x9E3779B1)) >>> 0',
        },
        lanes: LANES.map((l) => ({
            name: l.name, keyed: l.keyed, weighted: l.weighted, usesSetWeight: l.usesSetWeight,
            loadAware: l.loadAware, notes: l.notes, latency: l.latency, massKind: l.massKind,
            chaosSeedCycle0: chaosSeed(l, 0), balancerSeedCycle0: balancerSeed(0),
        })),
    });

    /**
     * Build + append a SUMMARY record with per-gate margins (the fine-tuning payload). reason is
     * 'end' | 'periodic' | 'signal'. Does NOT change any gate decision -- it reports margins. Returns
     * { gate, findings, pass } so the terminal path can drive the headline + exit code.
     */
    function writeSummary(reason, final) {
        const gate = computeGates(series, cycleSeries);
        const findings = tracker.audit();
        const invariantsGreen = invariantFailures === 0;
        const pass = invariantsGreen && sizeFailures === 0 && findings.length === 0 &&
            warns.length === 0 && gate.breaches.length === 0;
        const rssBaselineMB = cycleSeries.length ? cycleSeries[0].rssMB.mean : 0;
        const rssEndMB = cycleSeries.length ? cycleSeries[cycleSeries.length - 1].rssMB.mean : 0;
        writeRecord({
            type: 'summary',
            ts: new Date().toISOString(),
            reason, final,
            wallSec: +((performance.now() - t0) / 1000).toFixed(1),
            totalPicks, lanes: LANES.length, cyclesRun, cycleRollups: cycleSeries.length, checkpoints: series.length,
            rssBaselineMB, rssEndMB,
            retentionFailures: sizeFailures, invariantFailures, findings: findings.length, warnings: warns.length,
            gateMargins: {
                heap: gate.heap,           // PRIMARY leak signal: early/late-quarter median heapUsed
                rss: gate.rss,             // RUNAWAY GUARD: late-quarter p95 vs band-center median
                gcMajor: { observed: gate.gcMajor, bound: GATE_GC_MAJOR_MAX, pass: gate.gcPass },
                throughput: {
                    observedMinRatio: gate.throughput.observedMinRatio, bound: gate.throughput.bound,
                    pass: gate.throughput.pass, perLane: gate.throughput.perLane,
                },
            },
            pass,
        });
        return { gate, findings, pass };
    }

    // --- SIGINT/SIGTERM: flush a final summary so an interrupted overnight run stays analyzable -----
    let shuttingDown = false;
    let stopRequested = false;
    function onSignal(sig) {
        if (shuttingDown) return;
        shuttingDown = true;
        stopRequested = true;
        process.stdout.write('\nsoak: ' + sig + ' -- writing final summary and exiting\n');
        // Mirror the terminal path: an overnight run that ALREADY recorded an invariant desync, a
        // retention leak, or a gate breach must exit 1 even when stopped by Ctrl-C (the forever loop
        // records failures but never breaks on them). A clean run stopped mid-flight exits 0.
        try {
            const { gate, findings, pass } = writeSummary('signal', true);
            if (!pass) {
                if (invariantFailures !== 0) process.stderr.write('soak: FAIL -- invariants ' + invariantFailures + ' checkpoint(s)\n');
                if (sizeFailures !== 0) process.stderr.write('soak: FAIL -- retention (leak): tracker.size() != 0 after ' + sizeFailures + ' cycle(s)\n');
                if (findings.length !== 0) for (const f of findings) process.stderr.write('soak: FAIL -- finding ' + f.kind + ':' + f.reason + '\n');
                if (warns.length !== 0) for (const w of warns) process.stderr.write('soak: FAIL -- warning ' + w + '\n');
                for (const g of gate.breaches) process.stderr.write('soak: FAIL -- gate ' + g + '\n');
            }
            process.exit(pass ? 0 : 1);
        } catch (e) {
            process.stderr.write('soak: summary write failed -- ' + (e && e.stack ? e.stack : e) + '\n');
            process.exit(1);
        }
    }
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));

    // One cycle of chaos for ONE lane, in its own frame so the balancer is torn down before we gc.
    // Everything the hot loop touches is pre-resolved into locals/typed-arrays here (cold), so the
    // per-pick loop body is a flat run of integer branches + one pick + one inflight/note update -- 0-alloc.
    // Returns a COARSE per-lane-cycle rollup (min/mean/max + gc deltas + ops/sec + invariant status).
    function runCycle(lane, cycle) {
        const built = lane.make(balancerSeed(cycle));
        const b = built.b, eligible = built.eligible, inflight = built.inflight, weights = built.weights;
        tracker.track(b, noop, lane.name, { audit: true });      // tag is a string; cleanup closes over nothing
        if (MF_LEAK) {
            // leak teeth-proof: pin the balancer (-> retention FAIL) AND retain a plain (on-heap) array so
            // heapUsed climbs across lane-cycles -> the PRIMARY heap gate trips. A typed array would grow
            // external/RSS, not heapUsed, so use a plain Array (SMI-packed) for a real heap-growth signal.
            leakSink.push(b);
            leakSink.push(new Array(LEAK_ARRAY_LEN).fill(cyclesRun & 255));
        }

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
        const cycleStart = segMs0;
        // COLD rollup accumulators (per checkpoint, this lane-cycle).
        const rssSamples = [], heapSamples = [];
        let firstFail = null;
        const gsStart = gc.summary();
        const majorAtCycleStart = gsStart.gc.major;             // isolates WORKLOAD major GC (gate quantity)
        const minorAtCycleStart = gsStart.gc.minor;

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
                const rssMB = +(mem.rss / 1048576).toFixed(1);
                const heapUsedMB = +(mem.heapUsed / 1048576).toFixed(1);
                rssSamples.push(rssMB);
                heapSamples.push(heapUsedMB);
                const rec = {
                    type: 'checkpoint',
                    lane: lane.name,
                    cycle,
                    checkpoint: cp,
                    ts: new Date().toISOString(),
                    tMs: +(tNow - t0).toFixed(1),
                    picks: totalPicks,
                    live: mass,
                    opsPerSec: +opsPerSec.toFixed(0),        // rolling ops/sec for this lane-window
                    rssMB,
                    heapUsedMB,
                    gcMajor: gs.gc.major,                    // cumulative (incl. forced retention gc), informational
                    gcMajorInCycle: gs.gc.major - majorAtCycleStart, // WORKLOAD major GC -> the gate quantity
                    gcMinor: gs.gc.minor,
                    gcMaxPauseMs: +gs.gc.maxMs.toFixed(3),
                    trackerSize: tracker.size(),
                    invariant: reason === null ? 'ok' : reason,
                };
                pushBounded(series, rec);            // ALWAYS: feeds gcMajor + throughput gates
                if (LOG_FULL) writeRecord(rec);      // EMISSION throttled by SOAK_LOG; checks above are not
                if (reason !== null) {
                    invariantFailures++;
                    if (firstFail === null) firstFail = reason;
                    process.stderr.write('  soak invariant FAIL lane ' + lane.name + ' cycle ' + cycle +
                        ' step ' + step + ' cp ' + cp + ' seed=0x' + seed.toString(16) + ': ' + reason + '\n');
                }
            }
        }
        const gsEnd = gc.summary();
        const majorDelta = gsEnd.gc.major - majorAtCycleStart;
        workloadMajor += majorDelta;
        const cycleWallMs = performance.now() - cycleStart;
        return {
            rssMB: stats(rssSamples),
            heapUsedMB: stats(heapSamples),
            gcMajorDelta: majorDelta,                         // WORKLOAD major GC this cycle
            gcMinorDelta: gsEnd.gc.minor - minorAtCycleStart,
            gcMaxPauseMs: +gsEnd.gc.maxMs.toFixed(3),         // cumulative worst pause to date
            opsPerSec: +(cycleWallMs > 0 ? (PICKS_PER_CYCLE / cycleWallMs) * 1000 : 0).toFixed(0),
            invariant: firstFail === null ? 'green' : firstFail,
        };
    }

    // --- run: cycle-major (each cycle exercises ALL lanes); forever when CYCLES === 0 --------------
    for (let cycle = 0; (forever || cycle < CYCLES) && !stopRequested; cycle++) {
        for (let li = 0; li < LANES.length && !stopRequested; li++) {
            const lane = LANES[li];
            const rollup = runCycle(lane, cycle);

            // rss teeth-proof: retain a SUPER-LINEAR (quadratic-per-cycle) buffer on the COLD boundary so
            // cumulative RSS climbs faster than its own median band-center -> late-quarter p95 dwarfs the
            // band center and trips the (deliberately generous) runaway guard. Capped per-buffer to avoid an
            // absurd single alloc; .fill() forces the pages resident so RSS (not just reserved) grows.
            if (MF_RSS) {
                const bytes = Math.min(256 * 1048576, Math.floor(RSS_LEAK_MB * 1048576 * (cyclesRun + 1) * (cyclesRun + 1) / 16));
                rssSink.push(new Uint8Array(bytes).fill(cyclesRun & 255));
            }

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

            // CYCLE ROLLUP: the coarse per-lane-cycle series -- the MEMORY gates read this (always emitted).
            const cycleRec = {
                type: 'cycle',
                lane: lane.name,
                cycle,
                ts: new Date().toISOString(),
                picks: totalPicks,
                rssMB: rollup.rssMB,
                heapUsedMB: rollup.heapUsedMB,
                gcMajorDelta: rollup.gcMajorDelta,
                gcMinorDelta: rollup.gcMinorDelta,
                gcMaxPauseMs: rollup.gcMaxPauseMs,
                opsPerSec: rollup.opsPerSec,
                invariant: rollup.invariant,
                trackerSize: live,
            };
            pushBounded(cycleSeries, cycleRec);
            writeRecord(cycleRec);
        }
        // STDOUT heartbeat: one coarse human liveness line per cycle (how a glance shows it's alive).
        const mem = process.memoryUsage();
        process.stdout.write('soak cycle ' + cycle + ': elapsed=' + ((performance.now() - t0) / 1000).toFixed(1) +
            's picks=' + totalPicks + ' rss=' + (mem.rss / 1048576).toFixed(1) + 'MB invariants=' +
            (invariantFailures === 0 ? 'green' : invariantFailures + ' FAIL') +
            (sizeFailures === 0 ? '' : ' retention=' + sizeFailures + ' FAIL') + '\n');

        // Periodic summary so a mid-run peek at an overnight forever run has a current gate-margin block.
        if (forever) writeSummary('periodic', false);
    }
    gc.stop();

    // --- terminal: final summary (gate margins) + headline + exit ----------------------------------
    const { gate, findings, pass } = writeSummary('end', true);
    const rssBaseline = cycleSeries.length ? cycleSeries[0].rssMB.mean : 0;
    const rssEnd = cycleSeries.length ? cycleSeries[cycleSeries.length - 1].rssMB.mean : 0;
    const memCreep = (gate.heap && gate.heap.pass === false) || (gate.rss && gate.rss.pass === false);
    const rssTrend = memCreep ? 'CREEP' : 'flat';
    const invariantsGreen = invariantFailures === 0;
    const wallS = ((performance.now() - t0) / 1000).toFixed(1);

    process.stdout.write('soak: ran ' + wallS + 's, ' + totalPicks + ' picks across ' + LANES.length +
        ' lanes, RSS ' + rssBaseline + '->' + rssEnd + ' MB (' + rssTrend + '), GC major ' + workloadMajor +
        ', invariants ' + (invariantsGreen ? 'green' : invariantFailures + ' FAIL') +
        ' at all ' + series.length + ' checkpoints -> ' + (pass ? 'PASS' : 'FAIL') + '\n');

    if (!pass) {
        if (!invariantsGreen) process.stderr.write('soak: FAIL -- invariants ' + invariantFailures + ' checkpoint(s)\n');
        if (sizeFailures !== 0) process.stderr.write('soak: FAIL -- retention (leak): tracker.size() != 0 after ' + sizeFailures + ' cycle(s)\n');
        if (findings.length !== 0) for (const f of findings) process.stderr.write('soak: FAIL -- finding ' + f.kind + ':' + f.reason + '\n');
        if (warns.length !== 0) for (const w of warns) process.stderr.write('soak: FAIL -- warning ' + w + '\n');
        for (const g of gate.breaches) process.stderr.write('soak: FAIL -- gate ' + g + '\n');
        process.exit(1);
    }
}

main().catch((e) => {
    process.stderr.write('soak: FAIL -- ' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(1);
});
