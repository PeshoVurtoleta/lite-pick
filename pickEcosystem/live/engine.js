/**
 * pickEcosystem/live -- the request engines (capstone P1 spec, F1).
 *
 * ENGINE A (default) -- zero allocation per request in this code. A preallocated request table (typed-array
 * columns, a free-list of slots), the balancer's zero-box `pickFrom` (clock or key from a Float64Array /
 * Uint32Array slot), lite-worker-pool's `post` + `onSettle`, and the balancer's feedback in place: `inflight`
 * up on dispatch and down on settle, `recordRttFrom` for PeakEWMA (a failure records max(elapsed, penalty),
 * the /pool rule), `note` for BoundedLoad. A failed attempt fails over ONCE to a different eligible worker
 * (the /pool `tries: 2` rule). Measured before P1: ~1-3 B/request over the loopback, vs ~1.3 KB for B.
 *
 * ENGINE B -- the ergonomic path: lite-pick's `/pool` `run((i, signal) => set.submit(i, job, { signal }))`,
 * a Promise per request. Kept so a visitor can switch and see the cost side by side.
 *
 * Both feed the fleet (breakers) and the stats; both settle into the same `inflight` array, so switching
 * engines or strategies under load conserves the counts.
 */

import { S_ARRIVED, S_OK, S_FAILED, S_FAILOVER, S_SHED, S_NONE, S_REFUSED, S_DRAINED } from './stats.js';

export const ENGINE_A = 0;
export const ENGINE_B = 1;

const NS = 1e6;                 // ms -> ns (PeakEWMA works in ns)

export class Engine {
    /**
     * @param {object} config     scene config (workers, maxRequests, penaltyNs)
     * @param {object} set        lite-worker-pool WorkerSet
     * @param {object} balancers  the live balancer slot
     * @param {object} fleet      breakers / eligibility (onDispatch, onResult)
     * @param {object} stats
     * @param {object} bus        lite-di-event-bus
     * @param {Function} now      ms clock
     * @param {object} poolMod    `@zakkster/lite-pick/pool` (engine B)
     */
    constructor(config, set, balancers, fleet, stats, bus, now, poolMod) {
        this.cfg = config;
        this.set = set;
        this.bal = balancers;
        this.fleet = fleet;
        this.stats = stats;
        this.bus = bus;
        this.now = now;
        this.poolMod = poolMod;
        this.inflight = balancers.shared.inflight;
        this.n = config.workers;
        this.mode = ENGINE_A;
        this.draining = false;
        this.lastWorker = -1;     // the worker the last request went to (-1: none) -- the hot-key panel's mapping

        // ---- engine A: the request table ------------------------------------------------
        const R = config.maxRequests;
        this.R = R;
        this.rKey = new Uint32Array(R);
        this.rArrive = new Float64Array(R);
        this.rSent = new Float64Array(R);
        this.rTries = new Uint8Array(R);
        this.rFirst = new Int16Array(R);
        this.free = new Int32Array(R);
        for (let r = 0; r < R; r++) this.free[r] = R - 1 - r;
        this.freeTop = R;
        this.seq = 0;
        this._clk = new Float64Array(1);       // pickFrom clock slot (zero-box)
        this._key = new Uint32Array(1);        // pickFrom key slot (zero-box)
        this._fb = new Float64Array(2);        // recordRttFrom [sampleNs, nowNs]

        // ---- engine B -------------------------------------------------------------------------
        this.pool = null;
        this.pendingB = 0;
        const self = this;
        this._clockNs = () => self.now() * NS;
        // set's onSettle is wired to this (kernel.js); engine A's only completion path.
        this.onSettle = function (i, tag, ok, value, code) { self._settleA(i, tag, ok, code); };
    }

    /** Requests in flight (both engines). */
    pending() { return (this.R - this.freeTop) + this.pendingB; }

    setMode(mode) {
        if (mode !== ENGINE_A && mode !== ENGINE_B) throw new RangeError('engine must be ENGINE_A (0) or ENGINE_B (1)');
        this.mode = mode;
        if (mode === ENGINE_B) this.rebindPool();
    }

    /** After a strategy switch: engine B's /pool wraps the balancer, so it is rebuilt (same inflight). */
    rebindPool() {
        if (this.mode === ENGINE_B) this.pool = new this.poolMod.Pool(this.bal.lb, this.inflight);
    }

    /** One arrival. Returns false when it was not admitted (draining, or the table is full). */
    request(key) {
        const c = this.stats.c;
        c[S_ARRIVED]++;
        if (this.draining) { c[S_DRAINED]++; return false; }
        if (this.mode === ENGINE_B) return this._requestB(key);
        if (this.freeTop === 0) { c[S_SHED]++; this.lastWorker = -1; return false; }
        const r = this.free[--this.freeTop];
        this.rKey[r] = key >>> 0;
        this.rArrive[r] = this.now();
        this.rTries[r] = 0;
        this.rFirst[r] = -1;
        this._dispatchA(r);
        return true;
    }

    // ---- engine A ------------------------------------------------------------------------------

    _pick() {
        const bal = this.bal;
        const lb = bal.lb;
        if (bal.keyed) return lb.pickFrom(this._key, 0);
        if (bal.latency) { this._clk[0] = this.now() * NS; return lb.pickFrom(this._clk, 0); }
        return lb.pick();
    }

    // A failover must go to a DIFFERENT worker: scan forward from the one that failed.
    _other(avoid) {
        const lb = this.bal.lb;
        for (let k = 1; k < this.n; k++) {
            const j = (avoid + k) % this.n;
            if (lb.isEligible(j)) return j;
        }
        return -1;
    }

    _dispatchA(r) {
        this._key[0] = this.rKey[r];
        let i = this._pick();
        if (this.rTries[r] > 0 && i === this.rFirst[r]) i = this._other(i);
        if (i < 0) { this.stats.c[S_NONE]++; this.lastWorker = -1; this._finishA(r, false); return; }
        this.rTries[r]++;
        if (this.rFirst[r] < 0) this.rFirst[r] = i;
        this.seq = (this.seq + 1) & 0x7fffffff;
        if (!this.set.post(i, this.seq, r)) {
            this.stats.c[S_REFUSED]++;
            this._attemptFailed(r);
            return;
        }
        this.inflight[i]++;
        const bal = this.bal;
        if (bal.hasNote) bal.lb.note(i, 1);
        this.rSent[r] = this.now();
        this.lastWorker = i;
        this.fleet.onDispatch(i);
        this.bus.emit('dispatch', i);
        if (this.rTries[r] > 1) this.bus.emit('reroute', this.rFirst[r] * 256 + i);   // "w1 -> w2", the decision stream
    }

    _attemptFailed(r) {
        if (this.rTries[r] < this.cfg.tries) {
            this.stats.c[S_FAILOVER]++;
            this.bus.emit('failover', this.rFirst[r]);
            this._dispatchA(r);
        } else {
            this._finishA(r, false);
        }
    }

    _settleA(i, r, ok, code) {
        this.inflight[i]--;
        const bal = this.bal;
        const lb = bal.lb;
        if (bal.hasNote) lb.note(i, -1);
        const now = this.now();
        if (bal.latency) {
            const el = (now - this.rSent[r]) * NS;
            const fb = this._fb;
            fb[0] = ok ? el : (el > this.cfg.penaltyNs ? el : this.cfg.penaltyNs);
            fb[1] = now * NS;
            lb.recordRttFrom(i, fb, 0);
        }
        this.fleet.onResult(i, ok, code);
        if (ok) {
            this.stats.perOk[i]++;
            this.stats.latency(now - this.rArrive[r]);
            this._finishA(r, true);
        } else {
            this.stats.perFail[i]++;
            if (code === 'LWP_DISPOSED') this._finishA(r, false);
            else this._attemptFailed(r);
        }
    }

    _finishA(r, ok) {
        this.stats.c[ok ? S_OK : S_FAILED]++;
        this.free[this.freeTop++] = r;
    }

    // ---- engine B ------------------------------------------------------------------------------

    _requestB(key) {
        if (this.pool === null) this.rebindPool();
        const self = this;
        const arrive = this.now();
        const seq = (this.seq = (this.seq + 1) & 0x7fffffff);
        const bal = this.bal;
        const opts = bal.keyed ? { key, tries: this.cfg.tries } : bal.latency ? { clock: this._clockNs, tries: this.cfg.tries } : { tries: this.cfg.tries };
        this.pendingB++;
        this.lastWorker = -1;     // engine B picks asynchronously
        this.pool.run((i, signal) => {
            self.fleet.onDispatch(i);
            self.bus.emit('dispatch', i);
            return self.set.submit(i, seq, { signal }).then(
                (v) => { self.fleet.onResult(i, true, null); self.stats.perOk[i]++; return v; },
                (e) => { self.fleet.onResult(i, false, e && e.code); self.stats.perFail[i]++; throw e; });
        }, opts).then(
            () => { self.pendingB--; self.stats.c[S_OK]++; self.stats.latency(self.now() - arrive); },
            () => { self.pendingB--; self.stats.c[S_FAILED]++; });
        return true;
    }
}
