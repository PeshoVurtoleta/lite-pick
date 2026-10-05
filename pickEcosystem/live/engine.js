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
 * ADMISSION (P4). Before either engine touches a worker, `request()` sheds the arrival when the system is
 * already at capacity -- `pending() >= live x (slots + queue)` with `live > 0` -- as S_SHED: O(1)
 * small-integer math, no allocation, so a 5x overload stays zero-alloc on engine A. When `live` is 0 (a
 * whole-fleet outage) the test is SKIPPED so the arrival is not disguised as a shed -- it reaches the engine
 * and is classed as the failure it is. Below capacity the test is false and the run is byte-identical to the
 * pre-P4 engine (the golden P0 vectors). Past admission a race can still find the picked worker's queue full:
 * engine A reroutes once to a room-aware `_other` (an eligible worker that still has room) and, if none does,
 * sheds the never-placed request as S_SHED; engine B maps a final LWP_QUEUE_FULL the same way, but only when
 * NO earlier attempt failed for another reason. S_SHED means a request that NEVER ran and only ever met a full
 * queue; everything else that is not OK -- a ran-and-failed attempt, a non-READY refusal, PICK_NONE (no
 * eligible worker) -- is S_FAILED.
 *
 * Both feed the fleet (breakers) and the stats; both settle into the same `inflight` array, so switching
 * engines or strategies under load conserves the counts. Engine B's /pool is given a per-Pool FORWARDER
 * (not the whole Balancers facade): the forwarder's `constructor` IS the strategy class, so Pool reads the
 * real KEYED/LATENCY markers and keeps its fail-closed key/clock checks; `pick`+markers stay pinned to the
 * lb0 it was built over (but `pick` fails closed on lb0's frozen eligibility: a now-down result returns
 * PICK_NONE so the failover scan re-routes by CURRENT eligibility), while `note`/`recordRtt` forward to the
 * CURRENT `bal.lb` (the one seeded with the in-flight counts at a switch, as engine A's settle does), and
 * `isEligible` reads `shared.up`.
 */

import { S_ARRIVED, S_OK, S_FAILED, S_FAILOVER, S_SHED, S_NONE, S_REFUSED, S_DRAINED } from './stats.js';

export const ENGINE_A = 0;
export const ENGINE_B = 1;

const NS = 1e6;                 // ms -> ns (PeakEWMA works in ns)
const READY = 1;                // lite-worker-pool WORKER_STATE.READY (shared with fleet.js)

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
        this.slotCap = config.slots + config.queue;     // per-worker capacity: executing + queued (admission)
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
        this.rRan = new Uint8Array(R);                  // 1 once the request posted to a worker (it RAN)
        this.rCap = new Uint8Array(R);                  // 1 while every obstacle was capacity (a full queue)
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

    /**
     * After a strategy switch: engine B's /pool wraps the balancer through a per-Pool FORWARDER, rebuilt over
     * the SAME `inflight`. Why a forwarder and not `bal.lb` directly (or the whole Balancers facade):
     *   - `constructor: lb.constructor` -- Pool reads the strategy class's static KEYED/LATENCY markers off
     *     `b.constructor`, so its fail-closed KEY check and required-CLOCK check stay armed. What the marker
     *     loss costs is those two fail-closed checks (an unmarked plain-Object facade admits a keyed or
     *     latency run with no key/clock), not key routing itself.
     *   - `pick` + the markers are PINNED to the balancer this Pool was built over (lb0): within a run the
     *     pick channel and its marker never disagree, even if the strategy switches mid-flight. But lb0's
     *     eligibility is a COPY frozen at build time, so `pick` fails closed on it -- a pick whose result
     *     `shared.up` now says is down returns PICK_NONE (-1), and Pool's failover scan re-routes by the
     *     CURRENT eligibility through `isEligible` (a run in flight at a switch never fails over to a worker
     *     the fleet has since marked down).
     *   - `note`/`recordRtt` forward to the CURRENT `bal.lb` -- an in-flight run that settles AFTER a switch
     *     feeds the balancer now in use (the one `balancers.set` seeded with the in-flight counts), exactly as
     *     engine A's `_settleA` does; feeding lb0 would desync the new balancer's owned total (INCONSISTENT).
     *   - `isEligible` reads `shared.up` (the fleet's single eligibility writer), so a failover scan agrees.
     * Rebuilt on EVERY switch so lb0 tracks the live strategy; dropping this rebind (M15) strands engine B on
     * the previous channel -- a keyed switch loses key affinity.
     */
    rebindPool() {
        const bal = this.bal, lb = bal.lb, up = bal.shared.up;
        this.pool = new this.poolMod.Pool({
            constructor: lb.constructor,
            capacity: lb.capacity,
            get live() { return lb.live; },
            pick(a) { const i = lb.pick(a); return i >= 0 && up[i] !== 1 ? -1 : i; },
            isEligible(i) { return up[i] === 1; },
            note(i, d) { if (bal.hasNote) bal.lb.note(i, d); },
            recordRtt(i, s, n) { if (bal.latency) bal.lb.recordRtt(i, s, n); },
        }, this.inflight);
    }

    /** One arrival. Returns false when it was not admitted (draining, or the table is full). */
    request(key) {
        const c = this.stats.c;
        c[S_ARRIVED]++;
        if (this.draining) { c[S_DRAINED]++; return false; }
        // Admission (P4): shed when already at capacity -- O(1) small ints, no allocation, no box. A whole-fleet
        // outage (live 0) is NOT a capacity condition: skip the test (0 * slotCap would shed every arrival) and
        // let the request reach the engine so it is classed as the real failure it is (PICK_NONE / a non-READY
        // refusal -> S_FAILED), never a disguised shed.
        const live = this.bal.lb.live;
        if (live !== 0 && (this.R - this.freeTop) + this.pendingB >= live * this.slotCap) { c[S_SHED]++; this.lastWorker = -1; return false; }
        if (this.mode === ENGINE_B) return this._requestB(key);
        if (this.freeTop === 0) { c[S_SHED]++; this.lastWorker = -1; return false; }
        const r = this.free[--this.freeTop];
        this.rKey[r] = key >>> 0;
        this.rArrive[r] = this.now();
        this.rTries[r] = 0;
        this.rFirst[r] = -1;
        this.rRan[r] = 0;
        this.rCap[r] = 1;
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

    // A failover (or a capacity reroute) must go to a DIFFERENT worker that still has ROOM: scan forward from
    // the one to avoid and skip any worker whose queue is full (load >= slots + queue). -1 if none has room.
    _other(avoid) {
        const lb = this.bal.lb, set = this.set, cap = this.slotCap;
        for (let k = 1; k < this.n; k++) {
            const j = (avoid + k) % this.n;
            if (lb.isEligible(j) && set.load(j) < cap) return j;
        }
        return -1;
    }

    _dispatchA(r) {
        this._key[0] = this.rKey[r];
        let i = this._pick();
        if (i < 0) {
            // true PICK_NONE: no eligible worker at all this attempt.
            if (this.rTries[r] === 0) this.rCap[r] = 0;   // nowhere to send it -- not a capacity shed
            this.stats.c[S_NONE]++; this.lastWorker = -1; this._finishA(r, false); return;
        }
        if (this.rTries[r] > 0 && i === this.rFirst[r]) {
            // A failover re-pick that lands on the SAME worker (key affinity) reroutes to a different worker with
            // room. If every OTHER eligible worker is full, that is a CAPACITY refusal of the failover, NOT
            // PICK_NONE (there ARE eligible workers) -- count it as a per-attempt refusal, never as S_NONE ("no
            // eligible worker"). rTries>0 is reached only from a settled attempt, so the request RAN: _finishA
            // classes it S_FAILED (rRan 1), never a shed.
            const j = this._other(i);
            if (j < 0) { this.stats.c[S_REFUSED]++; this.lastWorker = -1; this._finishA(r, false); return; }
            i = j;
        }
        this._postA(r, i);
    }

    // Post request r to worker i. A capacity refusal (set.post false: the queue is full) reroutes ONCE to a
    // room-aware `_other`; if no worker has room the request is shed (it never ran) in _finishA.
    _postA(r, i) {
        this.rTries[r]++;
        if (this.rFirst[r] < 0) this.rFirst[r] = i;
        this.seq = (this.seq + 1) & 0x7fffffff;
        if (!this.set.post(i, this.seq, r)) {
            this.stats.c[S_REFUSED]++;
            // A READY worker refuses only when its queue is full (capacity). A refusal from a worker that is
            // NOT READY (down / restarting) is a placement FAILURE, not a capacity shed -- clear rCap.
            if (this.set.state(i) !== READY) this.rCap[r] = 0;
            if (this.rTries[r] < this.cfg.tries) {
                const j = this._other(i);
                if (j >= 0) { this.stats.c[S_FAILOVER]++; this.bus.emit('failover', this.rFirst[r]); this._postA(r, j); return; }
            }
            this._finishA(r, false);                      // never placed, all full -> capacity shed (rRan 0, rCap 1)
            return;
        }
        this.rRan[r] = 1;
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
            this.stats.service(i, now - this.rSent[r]);
            this.stats.latency(now - this.rArrive[r]);
            this._finishA(r, true);
        } else {
            this.stats.perFail[i]++;
            if (code === 'LWP_DISPOSED') this._finishA(r, false);
            else this._attemptFailed(r);
        }
    }

    _finishA(r, ok) {
        // A request that never ran and only ever hit capacity (a full queue) is SHED, not a failure.
        this.stats.c[ok ? S_OK : ((this.rRan[r] === 0 && this.rCap[r] === 1) ? S_SHED : S_FAILED)]++;
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
        // A request is SHED only if it NEVER ran: its final error is a full queue (LWP_QUEUE_FULL) and no
        // earlier attempt failed for any other reason. `ran` records a non-capacity attempt failure (a request
        // that RAN and failed, e.g. a crash/timeout, or a non-READY refusal) -- then a final QUEUE_FULL on a
        // failover is still a FAILURE, not a shed (engine A tracks the same via rRan/rCap).
        let ran = false;
        this.pool.run((i, signal) => {
            self.fleet.onDispatch(i);
            self.bus.emit('dispatch', i);
            const sent = self.now();
            return self.set.submit(i, seq, { signal }).then(
                (v) => { self.fleet.onResult(i, true, null); self.stats.perOk[i]++; self.stats.service(i, self.now() - sent); return v; },
                (e) => { const code = e && e.code; if (code !== 'LWP_QUEUE_FULL') ran = true; self.fleet.onResult(i, false, code); self.stats.perFail[i]++; throw e; });
        }, opts).then(
            () => { self.pendingB--; self.stats.c[S_OK]++; self.stats.latency(self.now() - arrive); },
            (e) => { self.pendingB--; self.stats.c[(!ran && e && e.code === 'LWP_QUEUE_FULL') ? S_SHED : S_FAILED]++; });   // never ran (queue full only) -> shed
        return true;
    }
}
