/**
 * pickEcosystem/live -- the worker fleet: one lite-di-container CHILD SCOPE per worker, each with
 *
 *   - token `worker`: an async singleton whose factory brings worker i up (the first time: wait for the set's
 *     READY; after that: `set.respawn(i)`), torn down by `set.kill(i)`. A restart is therefore the container's
 *     own primitive -- `invalidate` (kill) + `getAsync` (respawn) -- driven by:
 *   - a lite-di-supervisor (one-for-one, F5: 5 restarts / 30 s, then ESCALATED: the worker stays down until
 *     reset(i) builds a fresh scope -- fail closed);
 *   - a lite-di-health with three READY sources: the worker is READY, no job is hung (F4: 500 ms), and the
 *     supervisor reports it healthy;
 *   - a lite-statechart circuit breaker (F3): Closed -> Open after 5 consecutive failures -> HalfOpen after a
 *     2 s cool-down -> one probe -> Closed on success, Open on failure.
 *
 * `tick(now)` (20 Hz, lite-di-cron) is the ONLY eligibility writer: up(i) = health ready AND the breaker
 * allows, applied through `setEligible` only on a change. It also turns a dead worker into a supervisor
 * fault, and a job hung past F4's 1 s into a kill (then a fault). Worker deaths are not breaker failures
 * (the supervisor owns them); a transform failure is.
 */

import { Supervisor, STATES as SUP } from '@zakkster/lite-di-supervisor';
import { Health, LANES } from '@zakkster/lite-di-health';
import { createStatechart } from '@zakkster/lite-statechart';
import { CTL_LEN, CTL_UNITS, CTL_SLOW, CTL_FAIL, CTL_HANG, CTL_CRASH, UNITS_PER_MS } from './job.js';

export const B_CLOSED = 0;
export const B_OPEN = 1;
export const B_HALF = 2;
const B_CODE = { closed: B_CLOSED, open: B_OPEN, halfOpen: B_HALF };

const DOWN = 2;      // lite-worker-pool WORKER_STATE.DOWN
const READY = 1;
const DEATH = new Error('worker died');

function breakerConfig() {
    return {
        initial: 'closed',
        states: {
            closed: { on: { trip: 'open' } },
            open: { on: { cool: 'halfOpen' } },
            halfOpen: { on: { probeOk: 'closed', probeFail: 'open' } },
        },
    };
}

export class Fleet {
    /**
     * @param {object} config     scene config (workers, breakerFailures, breakerCoolMs, hungMs, hungKillMs,
     *                            maxRestarts, restartWindowMs, speeds)
     * @param {object} set        lite-worker-pool WorkerSet
     * @param {object} balancers  the live balancer slot (setEligible)
     * @param {object} bus        lite-di-event-bus
     * @param {Function} now      ms clock
     */
    constructor(config, set, balancers, bus, now) {
        const n = config.workers;
        this.cfg = config;
        this.set = set;
        this.bal = balancers;
        this.bus = bus;
        this.now = now;
        this.n = n;
        this.fails = new Uint16Array(n);
        this.bState = new Uint8Array(n);
        this.openedAt = new Float64Array(n);
        this.probeOut = new Uint8Array(n);
        this.restarting = new Uint8Array(n);
        this.escalated = new Uint8Array(n);
        this.started = new Uint8Array(n);         // 0 until the first bring-up (which waits for READY)
        this.transient = new Uint8Array(n);       // a hang / crash fault to clear on the next respawn
        this.restarts = new Float64Array(n);
        this.ctl = new Float64Array(n * CTL_LEN); // per-worker control values (job.js layout)
        this.scopes = new Array(n).fill(null);
        this.sups = new Array(n).fill(null);
        this.healths = new Array(n).fill(null);
        this.breakers = new Array(n).fill(null);
        this._initialReady = null;
        for (let i = 0; i < n; i++) {
            const b = i * CTL_LEN;
            this.ctl[b + CTL_UNITS] = config.jobMs * UNITS_PER_MS;
            this.ctl[b + CTL_SLOW] = config.speeds[i];
        }
    }

    /** Build every worker's scope + supervisor + health + breaker; resolves when all are up. */
    async start(root) {
        this.root = root;
        for (let i = 0; i < this.n; i++) this.set.control(i, this.ctl.subarray(i * CTL_LEN, (i + 1) * CTL_LEN));
        this._initialReady = this.set.ready();
        const all = [];
        for (let i = 0; i < this.n; i++) all.push(this._build(i));
        await Promise.all(all);
    }

    async _build(i) {
        const self = this;
        const scope = this.root.scope();
        scope.singletonFactoryAsync('worker', function () { return self._bringUp(i); });
        scope.onTeardown('worker', function () { self.set.kill(i); });
        scope.boot();
        const sup = new Supervisor(scope, {
            children: ['worker'],
            strategy: 'one-for-one',
            maxRestarts: this.cfg.maxRestarts,
            windowMs: this.cfg.restartWindowMs,
            now: this.now,
            onRestart: function () { self.restarts[i]++; self.bus.emit('restart', i); },
            onEscalate: function () { self.escalated[i] = 1; self.bus.emit('escalate', i); },
        });
        const health = new Health();
        const set = this.set;
        const now = this.now;
        const hungMs = this.cfg.hungMs;
        health.source('ready', function () { return set.isReady(i); }, LANES.READY);
        health.source('hung', function () { const b = set.busySince(i); return b !== b || now() - b < hungMs; }, LANES.READY);
        health.watchSupervisor('supervisor', sup, LANES.READY);
        const breaker = createStatechart(breakerConfig());
        breaker.onTransition(function (from, to) {
            self.bState[i] = B_CODE[to];
            self.bus.emit('breaker', i * 4 + B_CODE[to]);
        });
        this.scopes[i] = scope;
        this.sups[i] = sup;
        this.healths[i] = health;
        this.breakers[i] = breaker;
        this.bState[i] = B_CLOSED;
        this.fails[i] = 0;
        this.probeOut[i] = 0;
        await sup.start();
    }

    async _bringUp(i) {
        if (!this.started[i]) {
            this.started[i] = 1;
            await this._initialReady;
        } else {
            if (this.transient[i]) {
                const b = i * CTL_LEN;
                this.ctl[b + CTL_HANG] = 0;
                this.ctl[b + CTL_CRASH] = 0;
                this.transient[i] = 0;
                this.set.control(i, this.ctl.subarray(b, b + CTL_LEN));
            }
            await this.set.respawn(i);
        }
        this.fails[i] = 0;
        return i;
    }

    // ---- hot: called by the engines ------------------------------------------------------------

    onDispatch(i) {
        if (this.bState[i] === B_HALF && this.probeOut[i] === 0) {
            this.probeOut[i] = 1;                          // HalfOpen admits exactly one probe
            if (this.bal.shared.up[i] === 1) this.bal.setEligible(i, false);
        }
    }

    onResult(i, ok, code) {
        if (code === 'LWP_WORKER_DOWN' || code === 'LWP_DISPOSED') return;   // the supervisor's, not the breaker's
        const st = this.bState[i];
        if (st === B_CLOSED) {
            if (ok) { this.fails[i] = 0; return; }
            this.fails[i]++;
            if (this.fails[i] >= this.cfg.breakerFailures) {
                this.openedAt[i] = this.now();
                this.breakers[i].send('trip');
            }
        } else if (st === B_HALF) {
            this.probeOut[i] = 0;
            if (ok) { this.fails[i] = 0; this.breakers[i].send('probeOk'); }
            else { this.openedAt[i] = this.now(); this.breakers[i].send('probeFail'); }
        }
    }

    // ---- 20 Hz: faults -> supervisor, breaker cool-down, the eligibility writer ------------------

    tick(now) {
        const set = this.set;
        const up = this.bal.shared.up;
        for (let i = 0; i < this.n; i++) {
            const sup = this.sups[i];
            if (sup === null) continue;
            const st = set.state(i);
            if (st === READY) {
                const b = set.busySince(i);
                if (b === b && now - b > this.cfg.hungKillMs) { this.transient[i] = 1; set.kill(i); }
            }
            if (set.state(i) === DOWN && this.restarting[i] === 0 && this.escalated[i] === 0 && sup.state === SUP.RUNNING) {
                this._fault(i, sup);
            }
            if (this.bState[i] === B_OPEN && now - this.openedAt[i] >= this.cfg.breakerCoolMs) {
                this.probeOut[i] = 0;
                this.breakers[i].send('cool');
            }
            const bs = this.bState[i];
            const want = this.healths[i].readyz() === 0 && (bs === B_CLOSED || (bs === B_HALF && this.probeOut[i] === 0)) ? 1 : 0;
            if (want !== up[i]) {
                this.bal.setEligible(i, want === 1);
                this.bus.emit('eligible', i * 2 + want);
            }
        }
    }

    _fault(i, sup) {
        const self = this;
        this.restarting[i] = 1;
        const done = function () { self.restarting[i] = 0; };
        try {
            sup.reportFault('worker', DEATH).then(done, done);
        } catch (e) {
            done();
        }
    }

    // ---- cold: faults a visitor (or a test) injects, all paid inside the real thread -------------

    /** kind: 'slow' | 'flaky' | 'hang' | 'crash' | 'crashloop' | 'kill'. */
    fault(i, kind) {
        const b = i * CTL_LEN;
        const c = this.ctl;
        if (kind === 'slow') c[b + CTL_SLOW] = this.cfg.speeds[i] * 10;
        else if (kind === 'flaky') c[b + CTL_FAIL] = 0.5;
        else if (kind === 'hang') { c[b + CTL_HANG] = 3000; this.transient[i] = 1; }
        else if (kind === 'crash') { c[b + CTL_CRASH] = 1; this.transient[i] = 1; }
        else if (kind === 'crashloop') { c[b + CTL_CRASH] = 1; this.transient[i] = 0; }
        else if (kind === 'kill') { this.set.kill(i); return; }
        else throw new RangeError('unknown fault ' + kind);
        this.set.control(i, c.subarray(b, b + CTL_LEN));
    }

    /** Clear every fault on worker i (configuration back to the scene's). */
    heal(i) {
        const b = i * CTL_LEN;
        const c = this.ctl;
        c[b + CTL_SLOW] = this.cfg.speeds[i];
        c[b + CTL_FAIL] = 0;
        c[b + CTL_HANG] = 0;
        c[b + CTL_CRASH] = 0;
        this.transient[i] = 0;
        this.set.control(i, c.subarray(b, b + CTL_LEN));
    }

    /** After an escalation: a fresh scope + supervisor (the old one is terminal), worker respawned. */
    async reset(i) {
        this.heal(i);
        await this._teardown(i);
        this.escalated[i] = 0;
        this.restarting[i] = 0;
        await this._build(i);
    }

    async _teardown(i) {
        const sup = this.sups[i];
        const scope = this.scopes[i];
        this.sups[i] = null;
        if (sup !== null) await sup.shutdown();
        if (scope !== null) await scope.shutdown();
        this.scopes[i] = null;
    }

    /** Orchestrator step: stop supervising and retire every worker scope (before the root container). */
    async shutdownSupervisors() {
        for (let i = 0; i < this.n; i++) if (this.sups[i] !== null) await this.sups[i].shutdown();
    }

    async shutdownScopes() {
        for (let i = 0; i < this.n; i++) await this._teardown(i);
    }

    drain() {
        for (let i = 0; i < this.n; i++) if (this.healths[i] !== null) this.healths[i].drain();
    }
}
