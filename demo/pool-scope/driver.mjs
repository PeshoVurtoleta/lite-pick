/**
 * Pool Scope -- driver.mjs : the simulated traffic engine over REAL lite-pick balancers (PS1 #3).
 *
 *     import { Driver, STRATEGIES } from './driver.mjs';
 *
 * Owns the CALLER arrays lite-pick reads (eligible Uint8Array, inflight Uint32Array, weights
 * Uint32Array), constructs any of the TEN strategies by name, and runs a closed-loop dispatch/settle
 * simulation: each tick it settles the requests whose simulated service time elapsed, then dispatches
 * fresh ones (calling the balancer's real pick()) until ~CONC are in flight -- mutating inflight
 * (++ on dispatch, -- on settle) and feeding the two warm hooks the /pool adapter uses (note() for
 * BoundedLoad, recordRtt() for PeakEWMA). A per-worker service/latency model gives some workers a
 * longer tail. The FAULT INJECTORS (killWorker / overloadSpike / flapStorm / forcePingPong /
 * makeUnfair) create the CONDITIONS the detectors independently notice.
 *
 * Determinism: the in-repo xorshift32 Prng (seeded). Hot-path law: every array is pre-allocated; the
 * tick loop creates no array/object/closure -- the pending pool is a fixed slot pool with a free-list.
 */

import {
    RoundRobinBalancer, SmoothWRRBalancer, P2cBalancer, LeastConnBalancer, SedBalancer,
    NqBalancer, PeakEwmaBalancer, ConsistentHashBalancer, BoundedLoadBalancer,
    WeightedRandomBalancer, Prng, PICK_NONE,
} from '../../Pick.js';

/** The ten strategy names (cycle order for the interactive keys). */
export const STRATEGIES = [
    'roundrobin', 'smoothwrr', 'p2c', 'leastconn', 'sed',
    'nq', 'peakewma', 'consistenthash', 'boundedload', 'weightedrandom',
];

const DEFAULT_N = 12;
const DEFAULT_CONC = 108;         // target concurrent in-flight (per-worker ~9 at N=12, under SAT 16)
const PEND = 512;                 // pending-request slot pool (power of two, >> CONC)
// The simulated clock advances 1 UNIT per tick and is kept in V8 SMI range (never a boxed HeapNumber),
// so PeakEWMA's clock arithmetic on the hot path stays 0-alloc -- a large ns-magnitude clock would box
// every value past 2^31 and leak a HeapNumber per tick (the torture gate uses an SMI clock for the
// same reason). tau / rtt are expressed in these same tick units.
const TICK_NS = 1;                // 1 simulated time unit per tick (SMI-safe for ~2e9 ticks)
const TICK_S = 0.001;             // wall-clock seconds per tick, for the throughput readout only
const TAU_NS = 20;                // PeakEWMA half-life (tick units)
const M_TABLE = 65537;            // Maglev table size for the keyed strategies (prime; even spread)
const EPS = 0.25;                 // BoundedLoad slack

const OVERLOAD_PIN = 26;          // overloadSpike pins inflight here (> detectors OVERLOAD_SAT 16)
const OVERLOAD_SERVICE = 40;      // extra service ticks a spiked worker takes (fattens the tail too)
const PP_HI = 14;                 // ping-pong square-wave high / low (both < SAT: no false overload)
const PP_LO = 2;
const PP_HALF = 8;                // ping-pong half-period in ticks
const FLAP_PERIOD = 3;            // flapStorm toggles the worker's eligibility every N ticks
const UNFAIR_HOT_WEIGHT = 12;     // makeUnfair weight on the hot worker (others 1)

// Workload REALISM (so an exact strategy -- LeastConn/SED/NQ -- breathes instead of freezing at a
// perfect static fixed point). Service time is an EXPONENTIAL draw around a per-worker base (heavy
// tail -> bursty settles -> inflight fluctuates), and arrivals are STOCHASTIC (the per-tick fill
// target wobbles). Both are driven by the seeded in-repo Prng, so scenarios stay deterministic, and
// both are read into number locals only -> the tick loop stays 0-alloc. Kept MODEST so the design
// fingerprints survive (LeastConn still the tightest/dead-level band, P2C wider, random lopsided).
const SVC_MIN = 1;               // floor on a drawn service time (ticks)
const SVC_TAIL_CAP = 48;         // cap on the exponential tail (a single request never stalls forever)
const ARRIVAL_JITTER = 10;       // per-tick fill target wobbles conc +/- this many in-flight

const CH_KEYS = new Set(['consistenthash', 'boundedload']);

/**
 * Driver -- the traffic engine. Construct once, then drive it: beginFrame(dt) -> tick() x M -> read
 * for the snapshot. Public arrays/getters are the snapshot's read surface.
 */
export class Driver {
    /**
     * @param {number} [cap=12]  pool size.
     * @param {number} [seed=0x1234abcd]  deterministic seed.
     */
    constructor(cap = DEFAULT_N, seed = 0x1234abcd) {
        this.cap = cap;
        this.seed = seed >>> 0;
        this.rng = new Prng(this.seed);

        // ---- caller-owned substrate lite-pick reads --------------------------------------
        this.eligible = new Uint8Array(cap).fill(1);
        this.inflight = new Uint32Array(cap);
        this.weights = new Uint32Array(cap).fill(1);

        // ---- derived / display state -----------------------------------------------------
        this.shareDecay = new Float64Array(cap);   // decayed pick counts -> rolling share
        this.baseService = new Int32Array(cap);
        for (let i = 0; i < cap; i++) this.baseService[i] = 3 + (i % 5);

        // ---- injector state --------------------------------------------------------------
        this.pin = new Uint32Array(cap);           // forced minimum inflight (0 = none)
        this.ceil = new Int32Array(cap).fill(-1);  // forced maximum inflight (-1 = none)
        this.slow = new Uint8Array(cap);           // long-service (overload) marker
        this.flapEnabled = false; this.flapWorker = -1;
        this.ppEnabled = false; this.ppA = -1; this.ppB = -1;

        // ---- pending-request slot pool (fixed; free-list; zero-alloc dispatch) -----------
        this.sWorker = new Uint32Array(PEND);
        this.sDue = new Int32Array(PEND);
        this.sDisp = new Int32Array(PEND);
        this.sActive = new Uint8Array(PEND);
        this.freeStack = new Int32Array(PEND);
        for (let i = 0; i < PEND; i++) this.freeStack[i] = i;
        this.freeTop = PEND;
        this.pCount = 0;

        // ---- latency ring (pre-filled so percentiles are valid from frame 0) -------------
        this.latRing = new Float32Array(512).fill(3);
        this.latHead = 0;

        // ---- clocks / counters -----------------------------------------------------------
        this.tickCount = 0;
        this.nowNs = 0;
        this.conc = DEFAULT_CONC;
        this.frameSettles = 0;
        this.frameSeconds = TICK_S;
        this.eps = EPS;

        // ---- the live balancer -----------------------------------------------------------
        this.strategyName = 'p2c';
        this.balancer = null;
        this.keyed = false;
        this.hasNote = false;
        this.hasRtt = false;
        this.setStrategy('p2c');
    }

    /* --------------------------------------------------------------- balancer construction ---- */

    /**
     * (Re)build the balancer for `name`, resetting the load simulation (so a switch is a clean
     * morph and BoundedLoad's owned _total starts synced). Keeps eligibility + injector state.
     * @param {string} name  one of STRATEGIES
     */
    setStrategy(name) {
        if (STRATEGIES.indexOf(name) < 0) {
            throw new Error('[pool-scope] unknown strategy: ' + name +
                ' (one of ' + STRATEGIES.join(', ') + ')');
        }
        const cap = this.cap, el = this.eligible, inf = this.inflight, wt = this.weights, s = this.seed;
        let b;
        if (name === 'roundrobin') b = new RoundRobinBalancer(cap, el);
        else if (name === 'smoothwrr') b = new SmoothWRRBalancer(cap, el, wt);
        else if (name === 'p2c') b = new P2cBalancer(cap, el, inf, s);
        else if (name === 'leastconn') b = new LeastConnBalancer(cap, el, inf);
        else if (name === 'sed') b = new SedBalancer(cap, el, inf, wt);
        else if (name === 'nq') b = new NqBalancer(cap, el, inf, wt);
        else if (name === 'peakewma') b = new PeakEwmaBalancer(cap, el, inf, TAU_NS, s);
        else if (name === 'consistenthash') b = new ConsistentHashBalancer(cap, el, wt, M_TABLE, s);
        else if (name === 'boundedload') b = new BoundedLoadBalancer(cap, el, inf, EPS, wt, M_TABLE, s);
        else b = new WeightedRandomBalancer(cap, el, wt, s);

        this.balancer = b;
        this.strategyName = name;
        this.keyed = CH_KEYS.has(name);
        this.hasNote = typeof b.note === 'function';
        this.hasRtt = typeof b.recordRtt === 'function';
        this._resetSim();
    }

    /** Clear the in-flight simulation (load + pending + share) for a clean strategy morph. */
    _resetSim() {
        this.inflight.fill(0);
        this.shareDecay.fill(0);
        for (let i = 0; i < PEND; i++) { this.sActive[i] = 0; this.freeStack[i] = i; }
        this.freeTop = PEND;
        this.pCount = 0;
    }

    /* ------------------------------------------------------------------ snapshot read surface -- */

    isEligible(i) { return this.balancer.isEligible(i); }
    weightOf(i) { return this.weights[i]; }

    /** BoundedLoad occupancy cap = (1+eps) x total/live, else NaN when the strategy has none. */
    capOf(i) {
        const b = this.balancer;
        if (typeof b.totalInflight !== 'number' || b.live <= 0) return NaN;
        return (1 + this.eps) * b.totalInflight / b.live;
    }

    /** PeakEWMA decayed cost estimate at `now`, else NaN. */
    ewmaOf(i) {
        const b = this.balancer;
        return typeof b.ewmaAt === 'function' ? b.ewmaAt(i, this.nowNs) : NaN;
    }

    /* ---------------------------------------------------------------------------- injectors ---- */

    /** Mark a worker DOWN (a health probe / breaker flips this bit). */
    killWorker(i) { if (i >= 0 && i < this.cap) this.balancer.setEligible(i, false); }

    /** Mark a worker back UP. */
    reviveWorker(i) { if (i >= 0 && i < this.cap) this.balancer.setEligible(i, true); }

    /** Pin a worker's simulated service time + occupancy high (a hotspot). */
    overloadSpike(i) {
        if (i < 0 || i >= this.cap) return;
        this.pin[i] = OVERLOAD_PIN;
        this.slow[i] = 1;
    }

    /** Rapidly toggle a worker's eligibility -> an oscillation signature. */
    flapStorm(i) { if (i >= 0 && i < this.cap) { this.flapEnabled = true; this.flapWorker = i; } }

    /** Drive two workers into an anti-phase square wave -> a ping-pong signature. */
    forcePingPong(a, b) {
        if (a < 0 || b < 0 || a >= this.cap || b >= this.cap) return;
        this.ppEnabled = true; this.ppA = a; this.ppB = b;
    }

    /**
     * Skew the weights so a weight-aware strategy distributes unfairly (high Gini). setWeight() is
     * called BEFORE drv.weights is mutated, because an owning strategy's _weights ALIASES that array
     * (SmoothWRR / WeightedRandom) -- pre-mutating it would make setWeight() see "no change" and skip
     * the cold rebuild. Strategies that read weights live (SED / NQ) get the update from drv.weights.
     */
    makeUnfair() {
        const b = this.balancer;
        for (let i = 0; i < this.cap; i++) {
            const tw = i === 0 ? UNFAIR_HOT_WEIGHT : 1;
            if (typeof b.setWeight === 'function') b.setWeight(i, tw);
            this.weights[i] = tw;
        }
        this.conc = 24;   // keep the hot worker's inflight under SAT while Gini stays > threshold
    }

    /* -------------------------------------------------------------------------------- engine --- */

    /** Reset the per-frame counters before a batch of ticks. */
    beginFrame(seconds) {
        this.frameSettles = 0;
        this.frameSeconds = seconds > 0 ? seconds : TICK_S;
    }

    /** One simulation tick: injectors -> settle -> dispatch -> enforce pins -> decay -> advance. */
    tick() {
        const t = this.tickCount;

        // ---- timed injectors -----------------------------------------------------------
        if (this.flapEnabled && this.flapWorker >= 0 && (t % FLAP_PERIOD) === 0) {
            const f = this.flapWorker;
            this.balancer.setEligible(f, !this.balancer.isEligible(f));
        }
        if (this.ppEnabled) {
            const hiA = (((t / PP_HALF) | 0) & 1) === 0;
            const a = this.ppA, b = this.ppB;
            this.pin[a] = hiA ? PP_HI : PP_LO; this.ceil[a] = hiA ? PP_HI : PP_LO;
            this.pin[b] = hiA ? PP_LO : PP_HI; this.ceil[b] = hiA ? PP_LO : PP_HI;
        }

        // ---- settle every request whose service time elapsed ---------------------------
        for (let s = 0; s < PEND; s++) {
            if (this.sActive[s] && this.sDue[s] <= t) {
                const w = this.sWorker[s];
                if (this.inflight[w] > 0) this.inflight[w] = this.inflight[w] - 1;
                if (this.hasNote) this.balancer.note(w, -1);
                const rtt = t - this.sDisp[s];
                this.latRing[this.latHead] = rtt;
                this.latHead = (this.latHead + 1) & 511;
                if (this.hasRtt) this.balancer.recordRtt(w, rtt * TICK_NS, this.nowNs);
                this.sActive[s] = 0;
                this.freeStack[this.freeTop++] = s;
                this.pCount--;
                this.frameSettles++;
            }
        }

        // ---- dispatch fresh requests until a STOCHASTIC target is in flight ------------
        // Arrivals wobble: the fill target is conc +/- ARRIVAL_JITTER (seeded), so total inflight
        // breathes rather than pinning to a constant -- an exact strategy then re-balances a MOVING
        // load instead of a frozen one. A FRESH key per dispatch (keyed strategies); one key per tick
        // would pile a whole tick's load onto one hashed backend.
        let target = this.conc + (this.rng.nextBelow(2 * ARRIVAL_JITTER + 1) - ARRIVAL_JITTER);
        if (target < 1) target = 1;
        let guard = target + PEND;      // hard bound so a fully-down pool never spins
        while (this.pCount < target && this.freeTop > 0 && guard-- > 0) {
            // Key masked to 31 bits so it stays a V8 SMI (a full uint32 > 2^31 boxes a HeapNumber per
            // dispatch); the Maglev table takes key % M, so the dropped top bit does not skew routing.
            const i = this.keyed ? this.balancer.pick(this.rng.next() & 0x7fffffff) : this.balancer.pick(this.nowNs);
            if (i === PICK_NONE) break;
            this.inflight[i] = (this.inflight[i] + 1) >>> 0;
            if (this.hasNote) this.balancer.note(i, 1);
            this.shareDecay[i] += 1;
            const s = this.freeStack[--this.freeTop];
            // Service time: an EXPONENTIAL draw around the per-worker base (mean ~ base, heavy tail),
            // capped, plus the overload tail. u in (0,1) from the seeded Prng -> deterministic, 0-alloc.
            const u = this.rng.next() / 4294967296;
            let svc = SVC_MIN + Math.floor(-this.baseService[i] * Math.log(u));
            if (svc > SVC_TAIL_CAP) svc = SVC_TAIL_CAP;
            if (this.slow[i]) svc += OVERLOAD_SERVICE;
            this.sWorker[s] = i;
            this.sDisp[s] = t;
            this.sDue[s] = t + svc;
            this.sActive[s] = 1;
            this.pCount++;
        }

        // ---- enforce synthetic pins / ceilings (overload, ping-pong) -------------------
        for (let i = 0; i < this.cap; i++) {
            if (this.pin[i] > 0 && this.inflight[i] < this.pin[i]) this.inflight[i] = this.pin[i];
            if (this.ceil[i] >= 0 && this.inflight[i] > this.ceil[i]) this.inflight[i] = this.ceil[i];
        }

        // ---- decay the rolling share window (slow, so the share metric is smooth) -------
        for (let i = 0; i < this.cap; i++) this.shareDecay[i] *= 0.97;

        this.tickCount = t + 1;
        this.nowNs += TICK_NS;
    }
}
