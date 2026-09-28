/**
 * @zakkster/lite-pick soak -- discrete-event load model (audit RECOMMENDATIONS 1.8).
 *
 * A binary min-heap of (completeAt, node, service) held ENTIRELY in pre-allocated typed arrays,
 * so every push/pop is 0 B/op: doubles live in a Float64Array slot end to end (a large virtual
 * clock or completion time would box as a HeapNumber if it crossed a non-inlined boundary), node
 * indices are SMIs in an Int32Array. This replaces the old inflight++/coin-flip random walk with a
 * real queueing system: per-node service times (exponential OR lognormal via Box-Muller), a
 * processor-sharing slowdown (1 + inflight/conc), bounded concurrency (virtual time jumps to the
 * next completion when the pool is saturated), and hung nodes that park with no completion event.
 *
 * HOT PATH: pushCompletion / pop / sampleServiceUs / parkHung allocate zero bytes per call.
 */

const TWO_PI = 6.283185307179586;
const U_DEN = 16777216;          // 2^24 -- the uniform draw denominator
const SVC_MAX = (1 << 30) - 1;   // keep a service duration SMI-safe (< 2^30)

export class EventQueue {
    /** @param {number} heapCap max concurrent in-flight events (power-of-2 friendly, e.g. 1024). */
    constructor(heapCap) {
        this.heapCap = heapCap | 0;
        this.hTime = new Float64Array(this.heapCap); // completion time (us) -- large-double-safe slot
        this.hNode = new Int32Array(this.heapCap);   // endpoint index (SMI)
        this.hSvc = new Int32Array(this.heapCap);    // sampled service (us, SMI)
        this.size = 0;

        this._clk = new Float64Array(1);   // virtual clock (us) -- never a boxed field
        this._rng = null;
        this._inflight = null;
        this._conc = 1;
        this._mean = 1000;                 // mean service (us)
        this._lognormal = 0;               // 0 exponential, 1 lognormal
        this._bmHave = 0;
        this._bmSpare = new Float64Array(1);

        this.hung = new Uint32Array(0);    // parked (hung) node indices -- no heap slot
        this.hungCount = 0;
    }

    /**
     * Re-arm for a lane-cycle. Clears the heap + clock and rebinds the driver state. Cold.
     * @param {object} rng a Prng
     * @param {Uint32Array} inflight the lane's caller-owned in-flight counters
     * @param {number} conc concurrency ceiling (<= heapCap)
     * @param {number} meanUs mean service time in microseconds
     * @param {number} lognormal 1 for lognormal service, 0 for exponential
     * @param {number} hungCap capacity of the hung-parking list (usually the pool cap)
     */
    reset(rng, inflight, conc, meanUs, lognormal, hungCap) {
        this.size = 0;
        this._clk[0] = 0;
        this._rng = rng;
        this._inflight = inflight;
        this._conc = conc < 1 ? 1 : (conc > this.heapCap ? this.heapCap : conc);
        this._mean = meanUs > 0 ? meanUs : 1;
        this._lognormal = lognormal ? 1 : 0;
        this._bmHave = 0;
        if (this.hung.length < hungCap) this.hung = new Uint32Array(hungCap);
        this.hungCount = 0;
    }

    /** The current virtual time (us). Reads a slot; returns an SMI-or-double the caller may sink. */
    now() { return this._clk[0]; }

    full() { return this.size >= this._conc; }

    /** Sample a service duration in integer microseconds (SMI-safe). 0 B/op. */
    sampleServiceUs(node) {
        let base;
        if (this._lognormal) {
            let z;
            if (this._bmHave) {
                z = this._bmSpare[0];
                this._bmHave = 0;
            } else {
                const u1 = (this._rng.nextBelow(U_DEN) + 1) / (U_DEN + 1);
                const u2 = (this._rng.nextBelow(U_DEN) + 1) / (U_DEN + 1);
                const r = Math.sqrt(-2 * Math.log(u1));
                z = r * Math.cos(TWO_PI * u2);
                this._bmSpare[0] = r * Math.sin(TWO_PI * u2);
                this._bmHave = 1;
            }
            // sigma=0.5, mu chosen so the mean is ~this._mean: E[X]=exp(mu+sigma^2/2).
            base = this._mean * Math.exp(0.5 * z - 0.125);
        } else {
            const u = (this._rng.nextBelow(U_DEN) + 1) / (U_DEN + 1);
            base = -this._mean * Math.log(u);
        }
        const inf = this._inflight ? this._inflight[node] : 0;
        let us = base * (1 + inf / this._conc);
        if (!(us >= 1)) us = 1;              // NaN-safe floor
        if (us > SVC_MAX) us = SVC_MAX;
        return us | 0;
    }

    /**
     * Schedule a completion for `node` at clk + sampled-service. Returns the service duration (us,
     * SMI). If the heap is full it is a no-op returning 0 (caller must drain first). 0 B/op.
     */
    pushCompletion(node) {
        if (this.size >= this.heapCap) return 0;
        const svc = this.sampleServiceUs(node);
        const at = this._clk[0] + svc;
        let i = this.size++;
        this.hTime[i] = at;
        this.hNode[i] = node;
        this.hSvc[i] = svc;
        // sift up
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.hTime[parent] <= this.hTime[i]) break;
            this._swap(parent, i);
            i = parent;
        }
        return svc;
    }

    /**
     * Pop the earliest completion, advance the virtual clock to it, and return the node (SMI).
     * Returns -1 when the heap is empty. 0 B/op.
     */
    pop() {
        if (this.size === 0) return -1;
        const node = this.hNode[0];
        this._clk[0] = this.hTime[0];
        const last = --this.size;
        if (last > 0) {
            this.hTime[0] = this.hTime[last];
            this.hNode[0] = this.hNode[last];
            this.hSvc[0] = this.hSvc[last];
            this._down(0);
        }
        return node;
    }

    /** Park a node as hung: it holds an in-flight slot but never completes. Cold-ish, rare. */
    parkHung(node) {
        if (this.hungCount < this.hung.length) this.hung[this.hungCount++] = node >>> 0;
    }

    _down(i) {
        const n = this.size;
        for (;;) {
            const l = 2 * i + 1;
            const r = l + 1;
            let s = i;
            if (l < n && this.hTime[l] < this.hTime[s]) s = l;
            if (r < n && this.hTime[r] < this.hTime[s]) s = r;
            if (s === i) break;
            this._swap(s, i);
            i = s;
        }
    }

    _swap(a, b) {
        const t0 = this.hTime[a]; this.hTime[a] = this.hTime[b]; this.hTime[b] = t0;
        const n0 = this.hNode[a]; this.hNode[a] = this.hNode[b]; this.hNode[b] = n0;
        const s0 = this.hSvc[a]; this.hSvc[a] = this.hSvc[b]; this.hSvc[b] = s0;
    }

    /** COLD self-check: the binary-heap order property holds for the whole array. */
    verifyHeap() {
        for (let i = 1; i < this.size; i++) {
            const parent = (i - 1) >> 1;
            if (this.hTime[parent] > this.hTime[i]) return false;
        }
        return true;
    }
}
