/**
 * @zakkster/lite-pick soak -- POOL LANES (planner T14-15; deterministic simulation since S9, audit 2026-09-29).
 *
 * The /pool layer is the only async, allocating, stateful surface (dispatch, settle, failover, abort,
 * note, recordRtt). This drives Pool-wrapped P2C / PeakEWMA / BoundedLoad / ConsistentHash inside a
 * DETERMINISTIC DISCRETE-EVENT SIMULATION (research/s9-deterministic-simulation.md -- the FoundationDB /
 * TigerBeetle pattern): runs ARRIVE as Poisson events on a virtual clock; every attempt `fn(i)` PARKS its
 * promise resolver in the EventQueue at `now + service(i)` (processor sharing: the service is inflated by
 * the node's own in-flight count); the driver pops the earliest event, jumps the clock to it, releases
 * exactly that promise, and yields ONE macrotask (setImmediate) so every resulting microtask -- Pool's
 * settle, failover, feedback -- finishes before the next event. Completion order is the queue's, never
 * Node's promise order; the same seed replays the same trace (`traceHash`, checked by
 * test/SoakPool.test.js). Pool and PeakEWMA read the clock in NANOSECONDS (`opts.clock`, PeakEWMA tau
 * 1 ms = the mean service). A HUNG attempt parks with no completion and is released (SIM_RESET) only when
 * nothing else can happen; a run still pending when the queue is empty and nothing is parked is a LOST run,
 * detected deterministically (no real-time deadline). Membership churns between batches.
 * NOT a 0-B/op path (Pool.run allocates by design) -- flat-heap == RETENTION (tracker->0).
 *
 * The assertions are keyed on each run's SEEDED INTENT (a real Pool bug -- not a harness self-injection --
 * is what must trip them; every pool must-fail control is a SOAK_POOL Pool.js mutant):
 *   A1 (BL) b._total === INDEPENDENT sum(inflight) WHILE RUNS ARE IN FLIGHT (checked inside fn), and
 *           each in-flight pick respects cap = ceil((1+eps)(T+1)/live).
 *   A2 every inflight cell === 0 at quiescence.
 *   A3 launched === resolved + rejected AND no lost (never-settling) run.
 *   A4 rejection codes only SIM_* / abort-reason; NO LITE_PICK_NONE while the pool has eligible nodes.
 *   A5+OUTCOME per-run intent oracle: success->RESOLVE/1 try; failover->RESOLVE/2 distinct; failAll->
 *           REJECT SIM_FAIL/3; hung->REJECT SIM_RESET/3; abort->REJECT err===signal.reason/1.
 *   A6 heap flat: tracker.size() -> 0 (pool + balancer) at the boundary.
 *   A7 zero unhandled rejections over the run.
 *   A8 (S10) no attempt is dispatched to a node that is DOWN at dispatch time (fn checks eligible[i]).
 *   A9 Little's law, exactly: the time-integral of sum(inflight) (Pool's own counters) equals the sum over
 *           runs of (run end - attempt start) for every attempt (Pool holds a failed attempt's slot until
 *           its run settles). A bookkeeping bug that over/under-counts in flight -- even one that nets to
 *           zero at quiescence (A2 blind) -- breaks it.
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
function mkErr(msg, code) { const e = new Error(msg); e.code = code; return e; }

// Simulation parameters (virtual microseconds; Pool sees nanoseconds = us x 1000).
const MEAN_SVC_US = 1000;                    // mean attempt service time (exponential)
const NODE_CONC = 2;                         // processor sharing: service x (1 + inflight[node] / NODE_CONC)
const ARRIVAL_US = MEAN_SVC_US / 128;        // Poisson arrivals: ~128 runs in flight (Little: L = lambda W)
const HUNG_RELEASE_US = 20 * MEAN_SVC_US;    // a parked hung attempt is released this long after the drain
const U_DEN = 16777216;
const LITTLE_REL_TOL = 1e-9;                 // A9 is an identity; only float rounding is tolerated
const drain = () => new Promise((r) => setImmediate(r));   // one macrotask: every pending microtask runs first

/**
 * The pool lane's event heap: earliest virtual time first, equal times in PUSH ORDER (a sequence number --
 * FIFO, deterministic). Ordinary arrays on purpose: this lane allocates by design (Pool.run does), and the
 * 0-B/op EventQueue the kernel lanes use stays byte-identical (S9: adding ids/sequence to it shifted V8's
 * inlining on Node 22 enough that the probe's latency step boxed ~11.5 B/op).
 */
class SimQueue {
    constructor() { this.t = []; this.sq = []; this.id = []; this.node = []; this.size = 0; this.seq = 0; this.now = 0; this.lastId = -1; }
    _less(a, b) { return this.t[a] < this.t[b] || (this.t[a] === this.t[b] && this.sq[a] < this.sq[b]); }
    _swap(a, b) {
        let x = this.t[a]; this.t[a] = this.t[b]; this.t[b] = x;
        x = this.sq[a]; this.sq[a] = this.sq[b]; this.sq[b] = x;
        x = this.id[a]; this.id[a] = this.id[b]; this.id[b] = x;
        x = this.node[a]; this.node[a] = this.node[b]; this.node[b] = x;
    }
    /** Schedule handle `id` (for `node`) at absolute virtual time `at` (>= now). */
    push(at, node, id) {
        let i = this.size++;
        this.t[i] = at; this.sq[i] = this.seq++; this.id[i] = id; this.node[i] = node;
        while (i > 0) { const p = (i - 1) >> 1; if (!this._less(i, p)) break; this._swap(i, p); i = p; }
    }
    /** Pop the earliest event: jump the clock to it, leave its handle in lastId, return its node. */
    pop() {
        const node = this.node[0];
        this.now = this.t[0];
        this.lastId = this.id[0];
        const last = --this.size;
        if (last > 0) {
            this.t[0] = this.t[last]; this.sq[0] = this.sq[last]; this.id[0] = this.id[last]; this.node[0] = this.node[last];
            let i = 0;
            for (;;) {
                const l = 2 * i + 1, r = l + 1;
                let s = i;
                if (l < last && this._less(l, s)) s = l;
                if (r < last && this._less(r, s)) s = r;
                if (s === i) break;
                this._swap(s, i); i = s;
            }
        }
        return node;
    }
    /** Move the clock forward with no event (the hung-release step). */
    advance(dt) { if (dt > 0) this.now += dt; }
}

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
 * Run one pool lane-cycle inside the deterministic simulation. `mode` is a SOAK_MUSTFAIL pool mode
 * (harness-level teeth; the PRIMARY teeth are SOAK_POOL Pool.js mutants). Returns a rollup with the
 * assertion results, RTT telemetry and the trace hash. deps = { keys, keyMask }.
 */
export async function runPoolCycle(laneName, cap, m, seed, cfg, mode, deps, tracker) {
    const built = buildPoolLane(laneName, cap, m, seed);
    const pool = new Pool(built.b, built.inflight);
    tracker.track(pool, noop, laneName + ':pool', { audit: true });
    tracker.track(built.b, noop, laneName + ':bal', { audit: true });
    const eligible = built.eligible, inflight = built.inflight, b = built.b;
    const rng = new Prng((seed ^ 0x9E3779B1) >>> 0);
    const churnRng = new Prng((seed ^ 0x2545F491) >>> 0);
    const arrRng = new Prng((seed ^ 0x6A09E667) >>> 0);
    const q = new SimQueue();
    // The des.mjs service sampler, reused as-is: its divisor `conc` applies to the node's OWN inflight, so
    // conc = NODE_CONC gives per-node processor sharing (the old lane passed cap: slowdown ~1.004).
    const svcQ = new EventQueue(NODE_CONC);
    svcQ.reset(new Prng((seed ^ 0x51A17ED) >>> 0), inflight, NODE_CONC, MEAN_SVC_US, 0, 0);

    const keyed = laneName === 'PoolBoundedLoad' || laneName === 'PoolConsistentHash';
    const latency = laneName === 'PoolPeakEWMA';
    const isBL = laneName === 'PoolBoundedLoad';
    const eps = isBL ? b._eps : 0, minCap = isBL ? b.minCap | 0 : 0;
    const clock = () => q.now * 1000;      // ns for Pool / PeakEWMA

    const RUNS = 2048, C = 128;
    let launched = 0, resolved = 0, rejected = 0;
    let a1_inflightConsistent = true, a2_quiescenceZero = true, a4_codesOk = true;
    let outcomeOk = true, lostRun = false, pendingCount = 0;
    let badCode = null, outcomeMiss = null;
    let downDispatch = 0;                      // A8
    let inflightArea = 0, attemptArea = 0;     // A9 (virtual us x requests)
    let svcSum = 0, svcN = 0, events = 0, settledInBatch = 0;
    const rttUs = new Float64Array(RUNS);      // last-attempt RTT of each resolved run (what PeakEWMA sees)
    let rttN = 0;
    let h = 0x811c9dc5 | 0;                    // FNV-1a trace hash (events, dispatches, outcomes)
    const mix = (v) => { h = Math.imul(h ^ (v | 0), 0x01000193); };
    const perOutcome = { success: 0, failover: 0, failAll: 0, hung: 0, abort: 0 };
    const perOutcomeMiss = { success: 0, failover: 0, failAll: 0, hung: 0, abort: 0 };
    const retainSink = [];
    // Event handles: kind 0 = arrival (ref = run index), 1 = completion (ref = parked resolver).
    const evKind = [], evRef = [];
    const hungParked = [];                     // reject functions of parked hung attempts (FIFO)

    /** Independent sum of inflight over ALL nodes (the kernel _total contract). */
    function sumInflight() { let s = 0; for (let i = 0; i < cap; i++) s += inflight[i]; return s; }
    function newEvent(kind, ref) { evKind.push(kind); evRef.push(ref); return evKind.length - 1; }

    /** Park an attempt on node i until its simulated completion. */
    function parkCompletion(i) {
        return new Promise((resolve) => {
            const svc = svcQ.sampleServiceUs(i);   // processor-sharing slowdown from inflight[i] (already ++'d by Pool)
            svcSum += svc; svcN++;
            q.push(q.now + svc, i, newEvent(1, resolve));
        });
    }
    /** Park a hung attempt: no completion event; released (SIM_RESET) only when nothing else can happen. */
    function parkHung() { return new Promise((_, reject) => { hungParked.push(reject); }); }

    function launch(runIdx) {
        launched++;
        const rec = { intent: 'success', tried: [], starts: [], settled: false, ok: false, code: null, err: null, ac: null };
        let attempt = 0;
        const roll = rng.nextBelow(1000);
        if (roll < 150) rec.intent = 'failover';
        else if (roll < 250) rec.intent = 'failAll';
        else if (roll < 280) rec.intent = 'hung';
        else if (roll < 300) rec.intent = 'abort';
        const ac = rec.intent === 'abort' ? new AbortController() : null;
        rec.ac = ac;

        const fn = async (i, signal) => {
            // --- synchronous at DISPATCH (Pool called fn right after inflight[i]++) ---------------------
            if (!eligible[i]) downDispatch++;                 // A8 (S10): Pool must never dispatch to a down node
            rec.tried.push(i);
            rec.starts.push(q.now);
            mix(i);
            const a = attempt++;
            if (mode === 'poolnote' && isBL) b.note(i, 1);   // harness A1 teeth: desync _total IN FLIGHT
            // A1 (BL): while THIS dispatch is in flight (inflight already ++'d by Pool), the kernel's
            // _total must equal the INDEPENDENT sum(inflight), and the pick must respect the cap.
            if (isBL) {
                const T = sumInflight();
                if (b._total !== T) a1_inflightConsistent = false;
                let live = 0; for (let k = 0; k < cap; k++) if (eligible[k]) live++;
                if (live > 0 && T > 0) {
                    let capOcc = Math.ceil((1 + eps) * (T + 1) / live);
                    if (capOcc < minCap) capOcc = minCap;   // the opt-in floor (1.1.0, N4); 0 by default
                    if (inflight[i] > capOcc) a1_inflightConsistent = false;
                }
            }
            if (mode === 'poolbadcode' && runIdx === 0) throw mkErr('unexpected', 'WEIRD_CODE');
            // --- the simulated work -------------------------------------------------------------------
            if (rec.intent === 'hung') await parkHung();      // rejects with SIM_RESET when released
            else await parkCompletion(i);
            if (rec.intent === 'abort' && a === 0) { ac.abort(mkErr('sim abort', 'SIM_ABORT')); throw ac.signal.reason; }
            if (rec.intent === 'failAll') throw mkErr('sim fail', SIM_FAIL);
            if (rec.intent === 'failover' && a === 0) throw mkErr('sim fail (failover)', SIM_FAIL);
            return i;
        };
        const opts = { tries: 3 };
        if (keyed) opts.key = deps.keys[runIdx & deps.keyMask];
        if (latency) opts.clock = clock;
        if (ac) opts.signal = ac.signal;

        pool.run(fn, opts).then(
            () => { rec.settled = true; rec.ok = true; resolved++; settle(rec); },
            (err) => { rec.settled = true; rec.ok = false; rec.err = err; rec.code = err && err.code; rejected++; settle(rec); },
        );
    }

    /** A run settled (same virtual time as its last event): A9 bookkeeping, RTT, trace, outcome oracle. */
    function settle(rec) {
        settledInBatch++;
        const end = q.now;
        for (let k = 0; k < rec.starts.length; k++) attemptArea += end - rec.starts[k];
        if (rec.ok && rec.starts.length) rttUs[rttN++] = end - rec.starts[rec.starts.length - 1];
        mix(rec.ok ? 1 : 2); mix(rec.tried.length);
        evalRun(rec);
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

    /** Advance the clock by dt while integrating sum(inflight) (A9 left side). */
    function integrate(dtUs) { inflightArea += sumInflight() * dtUs; }

    /** Drive the simulation until every run of the batch settled. false = a LOST run (nothing can happen). */
    async function driveBatch(batchSize) {
        for (;;) {
            if (settledInBatch === batchSize) return true;
            if (q.size > 0) {
                const prev = q.now;
                const node = q.pop();
                integrate(q.now - prev);
                const id = q.lastId;
                events++;
                mix(evKind[id]); mix(node); mix(Math.round(q.now * 1000));
                if (evKind[id] === 0) launch(evRef[id]);
                else { const resolve = evRef[id]; evRef[id] = null; resolve(); }
                await drain();
            } else if (hungParked.length) {
                integrate(HUNG_RELEASE_US);
                q.advance(HUNG_RELEASE_US);
                const parked = hungParked.splice(0, hungParked.length);
                events++;
                mix(9); mix(parked.length);
                for (let k = 0; k < parked.length; k++) parked[k](mkErr('sim reset (hung, released at phase end)', SIM_RESET));
                await drain();
            } else {
                return false;   // runs pending, no event scheduled, nothing parked: a lost run (A3)
            }
        }
    }

    let idx = 0;
    while (idx < RUNS && !lostRun) {
        const batchSize = Math.min(C, RUNS - idx);
        settledInBatch = 0;
        // Poisson arrivals for this batch, from the current virtual time.
        let t = q.now;
        for (let k = 0; k < batchSize; k++, idx++) {
            t += -ARRIVAL_US * Math.log((arrRng.nextBelow(U_DEN) + 1) / (U_DEN + 1));
            q.push(t, 0, newEvent(0, idx));
        }
        if (!(await driveBatch(batchSize))) { lostRun = true; break; }
        churn();   // membership churn between batches
    }

    // Harness-mode teeth (kept for the required poolleak/poolnote/poolunhandled modes; the PRIMARY teeth
    // are the SOAK_POOL Pool.js mutants).
    if (mode === 'poolleak') inflight[0] = (inflight[0] + 1) >>> 0;
    // (poolnote A1 teeth fire IN FLIGHT inside fn -- a post-quiescence note would be unobserved.)
    if (mode === 'poolretain') retainSink.push(b);
    if (mode === 'poolunhandled') { Promise.reject(mkErr('unhandled', SIM_FAIL)); }
    if (lostRun) pendingCount = launched - resolved - rejected;

    await drain();

    if (sumInflight() !== 0) a2_quiescenceZero = false;
    const a3_accounted = !lostRun && (resolved + rejected) === launched;
    // A9: an identity, so only float rounding is tolerated. A lost run leaves attempts unsettled: A3 owns that.
    const a9_little = lostRun || Math.abs(inflightArea - attemptArea) <= LITTLE_REL_TOL * Math.max(1, attemptArea);

    // RTT telemetry (cold): nanoseconds, as Pool and PeakEWMA see them.
    const rs = rttUs.slice(0, rttN).sort();
    const pctl = (f) => (rttN ? Math.round(rs[Math.min(rttN - 1, Math.floor(f * rttN))] * 1000) : 0);
    let rttSum = 0; for (let k = 0; k < rttN; k++) rttSum += rs[k];

    return {
        laneName, launched, resolved, rejected, perOutcome, perOutcomeMiss,
        assert1_inflightConsistent: a1_inflightConsistent,
        assert2_quiescenceZero: a2_quiescenceZero,
        assert3_accounted: a3_accounted, lostRun, pendingCount,
        assert4_codesOk: a4_codesOk, badCode,
        assert5_outcomeOk: outcomeOk, outcomeMiss,
        assert8_noDownDispatch: downDispatch === 0, downDispatch,
        assert9_little: a9_little, inflightArea: +inflightArea.toFixed(3), attemptArea: +attemptArea.toFixed(3),
        rttP50Ns: pctl(0.5), rttP99Ns: pctl(0.99), rttMeanNs: rttN ? Math.round(rttSum / rttN * 1000) : 0,
        svcMeanNs: svcN ? Math.round(svcSum / svcN * 1000) : 0, simUs: Math.round(q.now), events,
        traceHash: (h >>> 0).toString(16),
        retainSink: mode === 'poolretain' ? retainSink : null,
    };
}
