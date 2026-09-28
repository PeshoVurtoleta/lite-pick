/**
 * @zakkster/lite-pick soak -- POOL LANES (planner T14-15, increment 2a async).
 *
 * The /pool layer is the only async, allocating, stateful surface (dispatch, settle, failover, abort,
 * note, recordRtt). This drives Pool-wrapped P2C / PeakEWMA / BoundedLoad / ConsistentHash with a
 * discrete-event model: a virtual clock in a Float64Array(1); per-run outcomes sampled from a seeded
 * Prng; the des.mjs service sampler for realistic RTTs. Genuine async; a REF'd deadline races every
 * batch so a stuck run is observed, and membership churns between batches so failover routes around
 * real down nodes. NOT a 0-B/op path (Pool.run allocates by design) -- flat-heap == RETENTION (tracker->0).
 *
 * The assertions are keyed on each run's SEEDED INTENT (a real Pool bug -- not a harness self-injection --
 * is what must trip them; every pool must-fail control is a SOAK_POOL Pool.js mutant):
 *   A1 (BL) b._total === INDEPENDENT sum(inflight) WHILE RUNS ARE IN FLIGHT (checked inside fn), and
 *           each in-flight pick respects cap = ceil((1+eps)(T+1)/live).
 *   A2 every inflight cell === 0 at quiescence.
 *   A3 launched === resolved + rejected AND no lost (never-settling) run (batch deadline + beforeExit).
 *   A4 rejection codes only SIM_* / abort-reason; NO LITE_PICK_NONE while the pool has eligible nodes.
 *   A5+OUTCOME per-run intent oracle: success->RESOLVE/1 try; failover->RESOLVE/2 distinct; failAll->
 *           REJECT SIM_FAIL/3; hung->REJECT SIM_RESET/3; abort->REJECT err===signal.reason/1.
 *   A6 heap flat: tracker.size() -> 0 (pool + balancer) at the boundary.
 *   A7 zero unhandled rejections over the run.
 */

import {
    Pool, P2cBalancer, PeakEwmaBalancer, ConsistentHashBalancer, BoundedLoadBalancer, Prng,
} from './kernel.mjs';
import { EventQueue } from './des.mjs';

export const POOL_LANES = ['PoolP2C', 'PoolPeakEWMA', 'PoolBoundedLoad', 'PoolConsistentHash'];
// MODULE-LEVEL cleanup: a cleanup defined INSIDE runPoolCycle links the FinalizationRegistry's held
// callback to the pool/balancer scope (V8 shared closure context) and pins them forever -- the trap the
// torture-harness skill warns about. This noop closes over nothing.
const noop = () => {};
const SIM_FAIL = 'SIM_FAIL', SIM_RESET = 'SIM_RESET';
const ALLOWED = { SIM_FAIL: 1, SIM_RESET: 1 };   // + the abort reason (checked by identity), never LITE_PICK_NONE
const BATCH_DEADLINE_MS = 4000;
function mkErr(msg, code) { const e = new Error(msg); e.code = code; return e; }

/** Build the Pool + balancer + caller-owned arrays for a pool lane. */
function buildPoolLane(laneName, cap, m, seed) {
    const eligible = new Uint8Array(cap).fill(1);
    const inflight = new Uint32Array(cap);
    let b;
    if (laneName === 'PoolP2C') b = new P2cBalancer(cap, eligible, inflight, seed);
    else if (laneName === 'PoolPeakEWMA') b = new PeakEwmaBalancer(cap, eligible, inflight, 1e6, seed);
    else if (laneName === 'PoolBoundedLoad') {
        const weights = new Uint32Array(cap); for (let i = 0; i < cap; i++) weights[i] = 1 + (i & 7);
        b = new BoundedLoadBalancer(cap, eligible, inflight, 0.25, weights, m, seed);
    } else {
        const weights = new Uint32Array(cap); for (let i = 0; i < cap; i++) weights[i] = 1 + (i & 7);
        b = new ConsistentHashBalancer(cap, eligible, weights, m, seed);
    }
    return { b, eligible, inflight };
}

/**
 * Run one pool lane-cycle. `mode` is a SOAK_MUSTFAIL pool mode (harness-level teeth; the PRIMARY teeth
 * are SOAK_POOL Pool.js mutants). Returns a rollup + the per-outcome counts. AWAITS all launched runs;
 * a stuck run trips the deadline -> lostRun (A3). deps = { keys, keyMask }.
 */
export async function runPoolCycle(laneName, cap, m, seed, cfg, mode, deps, tracker) {
    const built = buildPoolLane(laneName, cap, m, seed);
    const pool = new Pool(built.b, built.inflight);
    tracker.track(pool, noop, laneName + ':pool', { audit: true });
    tracker.track(built.b, noop, laneName + ':bal', { audit: true });
    const eligible = built.eligible, inflight = built.inflight, b = built.b;
    const rng = new Prng((seed ^ 0x9E3779B1) >>> 0);
    const churnRng = new Prng((seed ^ 0x2545F491) >>> 0);
    const vclock = new Float64Array(1);
    const q = new EventQueue(1024);
    q.reset(new Prng((seed ^ 0x51A17ED) >>> 0), inflight, cap, 1000, 0, cap);

    const keyed = laneName === 'PoolBoundedLoad' || laneName === 'PoolConsistentHash';
    const latency = laneName === 'PoolPeakEWMA';
    const isBL = laneName === 'PoolBoundedLoad';
    const eps = isBL ? b._eps : 0;
    const clock = () => vclock[0];

    const RUNS = 2048, C = 128;
    let launched = 0, resolved = 0, rejected = 0;
    let a1_inflightConsistent = true, a2_quiescenceZero = true, a4_codesOk = true;
    let outcomeOk = true, lostRun = false, pendingCount = 0;
    let badCode = null, outcomeMiss = null;
    const perOutcome = { success: 0, failover: 0, failAll: 0, hung: 0, abort: 0 };
    const perOutcomeMiss = { success: 0, failover: 0, failAll: 0, hung: 0, abort: 0 };
    const retainSink = [];

    /** Independent sum of inflight over ALL nodes (the kernel _total contract). */
    function sumInflight() { let s = 0; for (let i = 0; i < cap; i++) s += inflight[i]; return s; }

    function launch(runIdx) {
        launched++;
        const rec = { intent: 'success', tried: [], settled: false, ok: false, code: null, err: null, ac: null };
        let attempt = 0;
        const roll = rng.nextBelow(1000);
        if (roll < 150) rec.intent = 'failover';
        else if (roll < 250) rec.intent = 'failAll';
        else if (roll < 280) rec.intent = 'hung';
        else if (roll < 300) rec.intent = 'abort';
        const ac = rec.intent === 'abort' ? new AbortController() : null;
        rec.ac = ac;

        const fn = async (i, signal) => {
            rec.tried.push(i);
            const a = attempt++;
            await Promise.resolve();
            vclock[0] += q.sampleServiceUs(i);
            if (mode === 'poolnote' && isBL) b.note(i, 1);   // harness A1 teeth: desync _total IN FLIGHT
            // A1 (BL): while THIS dispatch is in flight (inflight already ++'d by Pool), the kernel's
            // _total must equal the INDEPENDENT sum(inflight), and the pick must respect the cap.
            if (isBL) {
                const T = sumInflight();
                if (b._total !== T) a1_inflightConsistent = false;
                let live = 0; for (let k = 0; k < cap; k++) if (eligible[k]) live++;
                if (live > 0 && T > 0) {
                    const capOcc = Math.ceil((1 + eps) * (T + 1) / live);
                    if (inflight[i] > capOcc) a1_inflightConsistent = false;
                }
            }
            if (mode === 'poolbadcode' && runIdx === 0) throw mkErr('unexpected', 'WEIRD_CODE');
            if (rec.intent === 'abort' && a === 0) { ac.abort(mkErr('sim abort', 'SIM_ABORT')); throw ac.signal.reason; }
            if (rec.intent === 'hung') throw mkErr('sim reset (hung, phase end)', SIM_RESET);
            if (rec.intent === 'failAll') throw mkErr('sim fail', SIM_FAIL);
            if (rec.intent === 'failover' && a === 0) throw mkErr('sim fail (failover)', SIM_FAIL);
            return i;
        };
        const opts = { tries: 3 };
        if (keyed) opts.key = deps.keys[runIdx & deps.keyMask];
        if (latency) opts.clock = clock;
        if (ac) opts.signal = ac.signal;

        return pool.run(fn, opts).then(
            (out) => { rec.settled = true; rec.ok = true; resolved++; evalRun(rec); },
            (err) => { rec.settled = true; rec.ok = false; rec.err = err; rec.code = err && err.code; rejected++; evalRun(rec); },
        );
    }

    /** Per-run oracle: did the run settle exactly as its seeded intent requires? */
    function evalRun(rec) {
        perOutcome[rec.intent]++;
        // A4: no LITE_PICK_NONE while the pool has eligible nodes; only allowed codes on a reject.
        if (!rec.ok) {
            if (rec.code === 'LITE_PICK_NONE') { a4_codesOk = false; if (badCode === null) badCode = 'LITE_PICK_NONE(fully eligible)'; }
            else if (rec.intent === 'abort') { /* code is the abort reason, checked below by identity */ }
            else if (!ALLOWED[rec.code]) { a4_codesOk = false; if (badCode === null) badCode = String(rec.code); }
        }
        const t = rec.tried;
        let ok;
        if (rec.intent === 'success') ok = rec.ok && t.length === 1;
        else if (rec.intent === 'failover') ok = rec.ok && t.length === 2 && t[0] !== t[1];
        else if (rec.intent === 'failAll') ok = !rec.ok && rec.code === SIM_FAIL && t.length === 3;
        else if (rec.intent === 'hung') ok = !rec.ok && rec.code === SIM_RESET && t.length === 3;
        else ok = !rec.ok && rec.err === rec.ac.signal.reason && t.length === 1;   // abort
        if (!ok) { outcomeOk = false; perOutcomeMiss[rec.intent]++; if (outcomeMiss === null) outcomeMiss = rec.intent + '(tries=' + t.length + ',ok=' + rec.ok + ',code=' + rec.code + ')'; }
    }

    /** Flap a few NON-in-flight nodes (inflight 0) down/up so failover routes around real churn. */
    function churn() {
        for (let n = 0; n < 6; n++) {
            const i = churnRng.nextBelow(cap);
            if (inflight[i] === 0) b.setEligible(i, churnRng.nextBelow(4) !== 0);   // up-biased
        }
        let live = 0; for (let i = 0; i < cap; i++) if (eligible[i]) live++;
        if (live < cap - 16) for (let i = 0; i < cap; i++) b.setEligible(i, true);   // never go sparse
    }

    let idx = 0;
    while (idx < RUNS && !lostRun) {
        const batch = [];
        for (let k = 0; k < C && idx < RUNS; k++, idx++) batch.push(launch(idx));
        let timer;
        const deadline = new Promise((res) => { timer = setTimeout(res, BATCH_DEADLINE_MS, false); });   // REF'd
        const done = await Promise.race([Promise.allSettled(batch).then(() => true), deadline]);
        clearTimeout(timer);   // release the timer + its closure so it cannot pin the pool/balancer context
        if (!done) { lostRun = true; break; }
        churn();   // membership churn between batches
    }

    // Harness-mode teeth (kept for the required poolleak/poolnote/poolunhandled modes; the PRIMARY teeth
    // are the SOAK_POOL Pool.js mutants).
    if (mode === 'poolleak') inflight[0] = (inflight[0] + 1) >>> 0;
    // (poolnote A1 teeth fire IN FLIGHT at line ~108 -- a post-quiescence note would be unobserved.)
    if (mode === 'poolretain') retainSink.push(b);
    if (mode === 'poolunhandled') { Promise.reject(mkErr('unhandled', SIM_FAIL)); }
    if (lostRun) pendingCount = launched - resolved - rejected;

    await new Promise((r) => setTimeout(r, 0));

    if (sumInflight() !== 0) a2_quiescenceZero = false;
    const a3_accounted = !lostRun && (resolved + rejected) === launched;

    return {
        laneName, launched, resolved, rejected, perOutcome, perOutcomeMiss,
        assert1_inflightConsistent: a1_inflightConsistent,
        assert2_quiescenceZero: a2_quiescenceZero,
        assert3_accounted: a3_accounted, lostRun, pendingCount,
        assert4_codesOk: a4_codesOk, badCode,
        assert5_outcomeOk: outcomeOk, outcomeMiss,
        retainSink: mode === 'poolretain' ? retainSink : null,
    };
}
