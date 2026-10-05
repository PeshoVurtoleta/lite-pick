/**
 * pickEcosystem/live -- open-loop traffic (capstone C6, P1 spec F6/F7).
 *
 * Arrivals are a Poisson process at `rate` requests/s, drawn per tick (Knuth's product-of-uniforms count, so
 * a 10 ms tick at 2000 req/s offers ~20 requests with the right variance) -- OPEN loop: arrivals do not wait
 * for completions, so overload and queueing show honestly. Each request carries a key drawn from a Zipf
 * distribution over `keys` keys (precomputed CDF + binary search); keyed strategies route by it. The PRNG is
 * lite-pick's seeded xorshift (`Prng.nextBelow`, which never boxes). 0 B per tick.
 */

const U = 1073741824;   // 2^30: nextBelow(U) is a small integer on every engine

export class Traffic {
    /**
     * @param {object} config  scene config (rate, keys, zipfS, seed)
     * @param {object} engine  the request engine (request(key))
     * @param {object} lp      @zakkster/lite-pick (Prng)
     */
    constructor(config, engine, lp) {
        this.engine = engine;
        this.rate = config.rate;
        this.admitting = true;
        this.rng = new lp.Prng(config.seed ^ 0x5bd1e995);
        this.last = -1;
        this.offered = 0;
        const K = config.keys;
        this.cdf = new Float64Array(K);
        let s = 0;
        for (let k = 0; k < K; k++) { s += 1 / Math.pow(k + 1, config.zipfS); this.cdf[k] = s; }
        for (let k = 0; k < K; k++) this.cdf[k] /= s;
    }

    // The uniform draws are written out where they are used: a helper returning the fractional value would
    // box it (a non-Smi double crossing a call V8 does not inline -- the zero-box law); nextBelow(U) itself
    // returns a small integer.
    _poisson(mean) {
        if (!(mean > 0)) return 0;
        const L = Math.exp(-mean);
        const rng = this.rng;
        let k = 0;
        let p = (rng.nextBelow(U) + 0.5) / U;
        while (p > L) { k++; p *= (rng.nextBelow(U) + 0.5) / U; }
        return k;
    }

    _key() {
        const u = (this.rng.nextBelow(U) + 0.5) / U;
        const cdf = this.cdf;
        let lo = 0, hi = cdf.length - 1;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (cdf[mid] < u) lo = mid + 1; else hi = mid; }
        // Spread key ids like a hash, but keep them in [0, 2^30): a small integer on every engine, so the key
        // never boxes as it crosses _key() -> request() (a uint32 >= 2^31 would, whenever V8 does not inline).
        return Math.imul(lo + 1, 0x9e3779b1) & 0x3fffffff;
    }

    /** One tick: offer Poisson(rate x dt) requests. */
    tick(now) {
        if (this.last < 0) { this.last = now; return; }
        const dt = now - this.last;
        this.last = now;
        if (!this.admitting || dt <= 0) return;
        const k = this._poisson(this.rate * dt / 1000);
        for (let j = 0; j < k; j++) this.engine.request(this._key());
        this.offered += k;
    }

    stop() { this.admitting = false; }
}
