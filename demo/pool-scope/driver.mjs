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
import { SKETCH, ADAPTIVE } from './siblings.mjs';

/** The ten strategy names (cycle order for the interactive keys). */
export const STRATEGIES = [
    'roundrobin', 'smoothwrr', 'p2c', 'leastconn', 'sed',
    'nq', 'peakewma', 'consistenthash', 'boundedload', 'weightedrandom',
];

const DEFAULT_N = 12;
const DEFAULT_CONC = 72;          // target concurrent in-flight (per-worker ~6 at N=12; keeps weighted top workers < SAT)
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
const UNFAIR_HOT_WEIGHT = 12;     // makeUnfair top weight (diverging ramp head; see makeUnfair)
// Default MILD weight skew (a gentle deterministic tier ramp across the pool) so the WEIGHT-AWARE
// strategies (SmoothWRR / SED / NQ / WeightedRandom + weighted ConsistentHash / BoundedLoad) render
// their signature STAIRCASE by default, not only after `u`. WEIGHT_TIERS steps over the cap -> weight
// 1..WEIGHT_TIERS. Mild on purpose: a weight-BLIND strategy's flat load over this skew stays UNDER the
// weight-aware fairness threshold (an honest "RR ignores weights" read, not a flagged fault), while a
// weight-aware strategy tracks it (proportional -> fair). makeUnfair replaces it with a wide diverging
// ramp that DOES cross the threshold for a weight-blind policy.
const WEIGHT_TIERS = 3;           // default skew: weights 1,2,3 in equal tiers across the pool

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

// ---- keyed-workload model (PS2: the keyed strategies route by an INTEGER key) -----------------
// PS1 fed the keyed strategies a fresh FULL-RANGE random key per dispatch -- a real key, but UNIFORM
// over 2^31, so every dispatch hit an independent Maglev slot and NO key ever dominated (a consistent-
// hash pool's whole reason for existing -- affinity to a bounded, SKEWED key set -- was invisible). PS2
// fixes it: a BOUNDED keyspace (KEYSPACE keys) so stickiness is meaningful, drawn UNIFORM by default and
// ZIPFIAN under the `hotkeys` scenario so a few keys dominate -> a real hotspot the HOT-KEY panel shows
// (plain ConsistentHash overloads the hot key's backend; BoundedLoad caps it and overflows to neighbours).
const KEYSPACE = 256;            // bounded key set (power of two): uniform spreads evenly over 12 workers
                                 // (no false starvation), zipf concentrates on the head (a real hotspot)
const KEY_MASK = KEYSPACE - 1;
const ZIPF_RES = 4096;           // zipf lookup-table resolution (a draw indexes it -> a key, 0-alloc)
const ZIPF_S = 1.15;             // zipf exponent for the `hotkeys` scenario (heavier -> sharper hotspot)
const KEY_DECAY = 0.99;          // per-frame decay of the inline per-key frequency (recent-weighted share)

// ---- sibling-backed layer knobs (PS2) ---------------------------------------------------------
const LAT_ALPHA = 0.01;          // DDSketch relative accuracy: p50/p95/p99 within +-1% of truth (HARD)
const LAT_ROLL_FRAMES = 96;      // clear the latency sketches every N frames -> recent latency, not all-time
const FD_HALFLIFE = 64;          // ForwardDecay half-life (tick units) for the decayed per-worker share
const HK_K = 8;                  // HeavyKeeper / hot-key top-k tracked (panel shows the top ~5)

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
        // Default MILD weight skew: a deterministic tier ramp (1..WEIGHT_TIERS) so weighted strategies
        // show a staircase out of the box. weight[i] = 1 + floor(i * TIERS / cap) -> equal-size tiers.
        this.weights = new Uint32Array(cap);
        for (let i = 0; i < cap; i++) this.weights[i] = 1 + ((i * WEIGHT_TIERS / cap) | 0);

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
        // The inline FALLBACK path: a fixed ring the snapshot pre-alloc-sorts for p50/p95/p99.
        this.latRing = new Float32Array(512).fill(3);
        this.latHead = 0;

        // ---- sibling-backed latency (lite-sketch DDSketch), else the inline ring ----------
        // DDSketch.add(rtt) on settle is 0 B/op and gives a HARD +-alpha relative-error quantile off the
        // render tick (cold walk). Global sketch is the minimum; per-worker sketches (12) enable a
        // per-worker tail (SED / NQ / PeakEWMA) via latWorkerQuantile(). Cleared every LAT_ROLL_FRAMES so
        // the header reflects RECENT latency, not all-time. hasLatSketch gates the whole path.
        this.hasLatSketch = !!SKETCH;
        this.latSketch = null;
        this.latWorker = null;
        if (SKETCH) {
            this.latSketch = new SKETCH.DDSketch(LAT_ALPHA);
            this.latWorker = new Array(cap);
            for (let i = 0; i < cap; i++) this.latWorker[i] = new SKETCH.DDSketch(LAT_ALPHA);
        }

        // ---- sibling-backed decayed per-worker share (lite-adaptive ForwardDecay) ---------
        // ForwardDecay.add(now) on each pick is 0 B/op; rate(now) on the render tick is a RECENCY-weighted
        // pick rate (recent picks weigh more -- what a live monitor wants). shareOf() prefers it, else the
        // inline decayed shareDecay counter below. hasFd gates it.
        this.hasFd = !!ADAPTIVE;
        this.fd = null;
        if (ADAPTIVE) {
            this.fd = new Array(cap);
            for (let i = 0; i < cap; i++) this.fd[i] = new ADAPTIVE.ForwardDecay(FD_HALFLIFE);
        }

        // ---- keyed workload + the HOT-KEY layer (lite-adaptive HeavyKeeper, else inline) --
        // keyFreq is a decayed per-key frequency (always maintained: it supplies the panel SHARE + is the
        // inline top-k fallback). keyWorker records the backend each key last routed to (captured at
        // dispatch -- no pick() replay, no kernel perturbation). HeavyKeeper.add(key) is 0 B/op and, when
        // present, IDENTIFIES the top-k hot keys (decayed top-k = "hot right now", native decay so it
        // tracks the CURRENT hot set + far lower error than Space-Saving on a Zipfian/drifting stream;
        // that recency is exactly the live-monitor need, so it is preferred over lite-sketch SpaceSaving).
        this.keyDist = 'uniform';                  // 'uniform' (default) | 'zipf' (the hotkeys scenario)
        this.keyFreq = new Float64Array(KEYSPACE);
        this.keyWorker = new Int32Array(KEYSPACE).fill(-1);
        this._zipf = new Uint16Array(ZIPF_RES);
        this._buildZipf();
        this.hasHeavyKeeper = !!ADAPTIVE;
        this.hk = null;
        this._hkPairs = null;
        if (ADAPTIVE) {
            this.hk = new ADAPTIVE.HeavyKeeper(4, 64, HK_K);
            this._hkPairs = new Float64Array(2 * HK_K);   // topKInto scratch (0-alloc render read)
        }

        // ---- clocks / counters -----------------------------------------------------------
        this.tickCount = 0;
        this.frameCount = 0;
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

    /** Clear the in-flight simulation (load + pending + share + sibling state) for a clean morph. */
    _resetSim() {
        this.inflight.fill(0);
        this.shareDecay.fill(0);
        for (let i = 0; i < PEND; i++) { this.sActive[i] = 0; this.freeStack[i] = i; }
        this.freeTop = PEND;
        this.pCount = 0;
        // Sibling + keyed state: reset so a strategy switch is a clean morph (no stale latency / share /
        // hot-key carry-over from the previous policy). All clear() calls are 0-alloc (pool reuse).
        this.keyFreq.fill(0);
        this.keyWorker.fill(-1);
        if (this.latSketch) {
            this.latSketch.clear();
            for (let i = 0; i < this.cap; i++) this.latWorker[i].clear();
        }
        if (this.fd) for (let i = 0; i < this.cap; i++) this.fd[i].clear();
        if (this.hk) this.hk.clear();
    }

    /** Precompute the zipf lookup table: index a uniform draw -> a key, weighted 1/(rank^ZIPF_S). Cold. */
    _buildZipf() {
        let norm = 0;
        for (let r = 1; r <= KEYSPACE; r++) norm += 1 / Math.pow(r, ZIPF_S);
        let acc = 0, key = 0;
        for (let slot = 0; slot < ZIPF_RES; slot++) {
            const target = (slot + 0.5) / ZIPF_RES;
            while (key < KEYSPACE - 1) {
                const next = acc + (1 / Math.pow(key + 1, ZIPF_S)) / norm;
                if (target <= next) break;
                acc = next; key++;
            }
            this._zipf[slot] = key;
        }
    }

    /** Draw the next request key (bounded keyspace). Zero-alloc: a masked draw or one table read. */
    _nextKey() {
        if (this.keyDist === 'zipf') return this._zipf[this.rng.nextBelow(ZIPF_RES)];
        return this.rng.nextBelow(KEYSPACE) & KEY_MASK;
    }

    /**
     * Switch the keyed workload to a skewed (zipfian) key stream -> a hotspot the panel shows. Raise the
     * offered load so the hot backend clearly OVERLOADS (ConsistentHash piles the head keys on one node)
     * -- the lower default concurrency keeps healthy weighted workers under SAT, so the hotspot scenario
     * restores the pressure that makes the overload signature visible.
     */
    makeHotKeys() { this.keyDist = 'zipf'; this.conc = 132; }

    /* ------------------------------------------------------------------ snapshot read surface -- */

    isEligible(i) { return this.balancer.isEligible(i); }
    weightOf(i) { return this.weights[i]; }

    /**
     * Raw per-worker share magnitude the snapshot normalises over the live mass. Prefers the
     * ForwardDecay RECENCY-weighted pick rate (recent picks weigh more); falls back to the inline
     * decayed pick counter. Same interface either way -- a swap, not a rewrite.
     */
    shareOf(i) {
        const fd = this.fd;
        if (fd) { const f = fd[i]; return f.mode === 'explicit' ? f.rate(this.nowNs) : 0; }
        return this.shareDecay[i];
    }

    /** Global latency quantile (q in [0,1]) from the DDSketch, or NaN when no sketch / empty. Cold. */
    latQuantile(q) { return this.latSketch ? this.latSketch.quantile(q) : NaN; }

    /** Per-worker latency quantile from the per-worker DDSketch (tail for SED/NQ/PeakEWMA). Cold. */
    latWorkerQuantile(i, q) { return this.latWorker ? this.latWorker[i].quantile(q) : NaN; }

    /**
     * Fill outKeys (Int32Array) with the top hot keys, newest-hot first; returns the count (<= len).
     * Prefers HeavyKeeper.topKInto (0-alloc, decayed top-k = hot RIGHT NOW); else a partial selection
     * over the inline decayed keyFreq. Cold (render tick). Keys route via keyWorker[key]; share via keyFreq.
     */
    hotKeys(outKeys) {
        const n = outKeys.length;
        if (this.hk) {
            const c = this.hk.topKInto(this._hkPairs);
            let m = 0;
            for (let e = 0; e < c && m < n; e++) outKeys[m++] = this._hkPairs[e * 2] | 0;
            // topKInto is unordered by share; sort the small result by decayed keyFreq (cold, tiny).
            for (let a = 0; a < m; a++) {
                let best = a;
                for (let b = a + 1; b < m; b++) if (this.keyFreq[outKeys[b]] > this.keyFreq[outKeys[best]]) best = b;
                if (best !== a) { const t = outKeys[a]; outKeys[a] = outKeys[best]; outKeys[best] = t; }
            }
            return m;
        }
        // Inline fallback: partial selection of the top n keys over the whole (tens-wide) keyspace.
        let m = 0;
        for (let slot = 0; slot < n; slot++) {
            let best = -1, bestF = 0;
            for (let k = 0; k < KEYSPACE; k++) {
                const f = this.keyFreq[k];
                if (f <= 0) continue;
                let taken = false;
                for (let j = 0; j < m; j++) if (outKeys[j] === k) { taken = true; break; }
                if (taken) continue;
                if (best < 0 || f > bestF) { best = k; bestF = f; }
            }
            if (best < 0) break;
            outKeys[m++] = best;
        }
        return m;
    }

    /** Total decayed key mass (denominator for the hot-key panel share). Cold, KEYSPACE-small. */
    keyMass() {
        let s = 0;
        for (let k = 0; k < KEYSPACE; k++) s += this.keyFreq[k];
        return s;
    }

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
     * Force a GENUINE weight-disproportion: replace the mild default skew with a WIDE diverging ramp
     * (weight 1..UNFAIR_HOT_WEIGHT across the pool). Under the WEIGHT-AWARE fairness detector this is
     * the honest unfair signature (design section 5: load NOT proportional to weight): a weight-BLIND
     * policy (RoundRobin / P2C / LeastConn / PeakEWMA -- the `unfair` scenario default) spreads load
     * FLAT over this steep ramp, so load-over-weight fans out and the Gini crosses the threshold; a
     * weight-AWARE policy tracks the ramp and stays proportional (correctly NOT flagged). setWeight() is
     * called BEFORE drv.weights is mutated, because an owning strategy's _weights ALIASES that array
     * (SmoothWRR / WeightedRandom) -- pre-mutating it would make setWeight() see "no change" and skip
     * the cold rebuild. Strategies that read weights live (SED / NQ) get the update from drv.weights.
     */
    makeUnfair() {
        const b = this.balancer;
        const span = this.cap > 1 ? this.cap - 1 : 1;
        for (let i = 0; i < this.cap; i++) {
            // Diverging ramp: worker 0 -> 1, last worker -> UNFAIR_HOT_WEIGHT (the tilted weight-ghost).
            const tw = 1 + Math.round(i * (UNFAIR_HOT_WEIGHT - 1) / span);
            if (typeof b.setWeight === 'function') b.setWeight(i, tw);
            this.weights[i] = tw;
        }
        // Keep even the highest weight-share worker's inflight under OVERLOAD_SAT for a weight-aware
        // policy, so `unfair` reads UNFAIR alone (no incidental OVERLOAD from the steep ramp head).
        this.conc = 90;
    }

    /* -------------------------------------------------------------------------------- engine --- */

    /** Reset the per-frame counters before a batch of ticks; roll the latency sketches for recency. */
    beginFrame(seconds) {
        this.frameSettles = 0;
        this.frameSeconds = seconds > 0 ? seconds : TICK_S;
        // Roll (clear) the latency sketches every LAT_ROLL_FRAMES frames so p50/p95/p99 reflect RECENT
        // latency, not all-time. clear() is 0-alloc (pool reuse); the inline latRing is the empty-window
        // safety net the snapshot uses until the sketch repopulates (which is within one busy frame).
        this.frameCount++;
        if (this.latSketch && (this.frameCount % LAT_ROLL_FRAMES) === 0) {
            this.latSketch.clear();
            for (let i = 0; i < this.cap; i++) this.latWorker[i].clear();
        }
        // Decay the inline per-key frequency (recency weighting for the panel share + the fallback top-k).
        if (this.keyed) for (let k = 0; k < KEYSPACE; k++) this.keyFreq[k] *= KEY_DECAY;
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
                // Sibling latency: DDSketch.add(rtt) is 0 B/op (rtt is a small SMI). Global + per-worker
                // so the header p50/p95/p99 carry a HARD +-alpha bound and a per-worker tail is available.
                if (this.latSketch && rtt > 0) { this.latSketch.add(rtt); this.latWorker[w].add(rtt); }
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
            // Keyed strategies route by a BOUNDED-keyspace key (uniform, or zipfian under `hotkeys`) so
            // stickiness + hotspots are real; a small SMI key never boxes. Non-keyed strategies take the
            // SMI sim clock. The hot-key structures are fed with the SAME key the balancer routed on.
            let key = 0;
            const i = this.keyed ? this.balancer.pick(key = this._nextKey()) : this.balancer.pick(this.nowNs);
            if (i === PICK_NONE) break;
            this.inflight[i] = (this.inflight[i] + 1) >>> 0;
            if (this.hasNote) this.balancer.note(i, 1);
            this.shareDecay[i] += 1;
            // Sibling decayed share: ForwardDecay.add(now) is 0 B/op (now is a SMI); rate(now) is read cold.
            if (this.fd) this.fd[i].add(this.nowNs);
            // Hot-key layer (keyed only): record the routed backend + feed the top-k (HeavyKeeper, 0 B/op)
            // and the inline decayed frequency (panel share + fallback ranking). All 0-alloc.
            if (this.keyed) {
                this.keyWorker[key] = i;
                this.keyFreq[key] += 1;
                if (this.hk) this.hk.add(key);
            }
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
