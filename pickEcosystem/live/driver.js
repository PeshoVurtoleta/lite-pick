/**
 * pickEcosystem/live -- the Pool Scope DRIVER interface over the LIVE system (so P2/P3 add only renderers).
 *
 * Pool Scope's `LitePickSnapshot.build(driver)` (demo/pool-scope/snapshot.mjs) reads: `inflight`,
 * `isEligible(i)`, `shareOf(i)`, `weightOf(i)`, `capOf(i)`, `ewmaOf(i)`, `hasLatSketch`, `latQuantile(q)`,
 * `latRing`, `frameSettles`, `frameSeconds`, `nowNs`. The simulated driver computes them from its model; this
 * one reads them off the running kernel. `tick()` is a no-op -- the live system advances on its own clock; a
 * renderer calls `beginFrame(seconds)` once per frame. Every read is cold (render rate), never on the request
 * path.
 */

import { S_OK } from './stats.js';

const SHARE_DECAY = 0.8;     // per frame: the rolling share follows the last ~5 frames

export class LiveDriver {
    constructor(kernel) {
        const n = kernel.cfg.workers;
        this.k = kernel;
        this.cap = n;
        this.inflight = kernel.balancers.shared.inflight;
        this.latRing = kernel.stats.ring;
        this.hasLatSketch = true;
        this.frameSettles = 0;
        this.frameSeconds = 1 / 12;
        this.nowNs = 0;
        this.shareDecay = new Float64Array(n);
        this._lastPerOk = new Float64Array(n);
        this._lastOk = 0;
    }

    get strategyName() { return this.k.balancers.name; }

    isEligible(i) { return this.k.balancers.lb.isEligible(i); }
    weightOf(i) { return this.k.balancers.shared.weights[i]; }
    shareOf(i) { return this.shareDecay[i]; }

    /** BoundedLoad's occupancy cap, else NaN (the simulated driver's definition). */
    capOf(i) {
        const b = this.k.balancers.lb;
        if (typeof b.totalInflight !== 'number' || b.live <= 0) return NaN;
        return (1 + this.k.cfg.eps) * b.totalInflight / b.live;
    }

    /** PeakEWMA's decayed estimate (ns) at `nowNs`, else NaN. */
    ewmaOf(i) {
        const b = this.k.balancers.lb;
        return typeof b.ewmaAt === 'function' ? b.ewmaAt(i, this.nowNs) : NaN;
    }

    /** Latency quantile (ms) over the last full second, NaN while that window is empty. */
    latQuantile(q) {
        const s = this.k.stats.latLast;
        return s.count > 0 ? s.quantile(q) : NaN;
    }

    beginFrame(seconds) {
        this.frameSeconds = seconds > 0 ? seconds : 1 / 12;
        const st = this.k.stats;
        const ok = st.c[S_OK];
        this.frameSettles = ok - this._lastOk;
        this._lastOk = ok;
        const per = st.perOk;
        for (let i = 0; i < this.cap; i++) {
            this.shareDecay[i] = this.shareDecay[i] * SHARE_DECAY + (per[i] - this._lastPerOk[i]);
            this._lastPerOk[i] = per[i];
        }
        this.nowNs = this.k.engine.now() * 1e6;
    }

    tick() { /* the live system runs itself */ }

    setStrategy(name) { this.k.setStrategy(name); }
}
