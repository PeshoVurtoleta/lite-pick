/**
 * pickEcosystem/live -- counters and latency. Every hot write is a typed-array slot or a DDSketch add
 * (0 B/op); `snapshot()` is cold and allocates.
 */

import { DDSketch } from '@zakkster/lite-sketch';

export const S_ARRIVED = 0;     // requests offered by the traffic generator
export const S_OK = 1;          // requests that completed
export const S_FAILED = 2;      // requests that failed after their last attempt
export const S_FAILOVER = 3;    // second attempts (a different worker)
export const S_SHED = 4;        // shed for capacity: at admission (pending >= live x (slots+queue)), or a never-placed request found every queue full
export const S_NONE = 5;        // no eligible worker (PICK_NONE)
export const S_REFUSED = 6;     // set.post refused (queue full / not READY) -- counted per attempt
export const S_DRAINED = 7;     // offered while draining (shutdown)
export const S_COUNT = 8;

export class Stats {
    constructor(config) {
        this.n = config.workers;
        this.c = new Float64Array(S_COUNT);            // totals, never reset
        this.perOk = new Float64Array(this.n);         // completed per worker
        this.perFail = new Float64Array(this.n);       // failed attempts per worker
        this.lat = new DDSketch(0.01);                 // end-to-end latency (ms), rolled every second
        this.latLast = new DDSketch(0.01);             // the previous full second (what stats report)
        // Per-worker time ON the worker (ms): a successful attempt, sent -> settled (the worker's queue + the job;
        // failover excluded), rolled with the end-to-end window. Pool Scope's worker table and inspector read these.
        this.svc = [];
        this.svcLast = [];
        for (let i = 0; i < this.n; i++) { this.svc.push(new DDSketch(0.01)); this.svcLast.push(new DDSketch(0.01)); }
        this._x = new Float64Array(1);                 // addFrom slot (0-box)
        this.ring = new Float32Array(512);             // the most recent latencies (Pool Scope fallback)
        this.ringHead = 0;
        this.p50 = NaN;
        this.p99 = NaN;
        this.rate = 0;                                 // completions per second over the last second
        this._okAtRoll = 0;
        this._rollAt = -1;
    }

    latency(ms) {
        this._x[0] = ms;
        this.lat.addFrom(this._x, 0);
        this.ring[this.ringHead] = ms;
        this.ringHead = (this.ringHead + 1) & 511;
    }

    /** A successful attempt on worker i took `ms` (sent -> settled). */
    service(i, ms) {
        this._x[0] = ms;
        this.svc[i].addFrom(this._x, 0);
    }

    /** 1 Hz: freeze the last second's percentiles and rate, start a new window. */
    roll(now) {
        const s = this.lat;
        this.p50 = s.count ? s.quantile(0.5) : NaN;
        this.p99 = s.count ? s.quantile(0.99) : NaN;
        const dt = this._rollAt < 0 ? 1 : (now - this._rollAt) / 1000;
        this.rate = dt > 0 ? (this.c[S_OK] - this._okAtRoll) / dt : 0;
        this._okAtRoll = this.c[S_OK];
        this._rollAt = now;
        this.lat = this.latLast;
        this.latLast = s;
        this.lat.clear();
        const a = this.svc, b = this.svcLast;
        for (let i = 0; i < this.n; i++) { const t = a[i]; a[i] = b[i]; b[i] = t; a[i].clear(); }
    }

    snapshot() {
        const c = this.c;
        return {
            arrived: c[S_ARRIVED], ok: c[S_OK], failed: c[S_FAILED], failover: c[S_FAILOVER], shed: c[S_SHED],
            none: c[S_NONE], refused: c[S_REFUSED], drained: c[S_DRAINED], rate: this.rate, p50: this.p50, p99: this.p99,
            perOk: Array.from(this.perOk), perFail: Array.from(this.perFail),
        };
    }
}
