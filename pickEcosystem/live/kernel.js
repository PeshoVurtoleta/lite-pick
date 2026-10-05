/**
 * pickEcosystem/live -- the composition root: `bootKernel(io)` builds the whole headless system out of the
 * suite's bricks (capstone notes: research/capstone-pickEcosystem.md, research/capstone-P1-spec.md).
 *
 *   lite-di-container   root container + one child scope per worker (fleet.js)
 *   lite-worker-pool    createWorkerSet: the workers (real threads, or virtual ones in tests)
 *   lite-pick           the ten strategies (balancers.js), engine A's kernel calls, engine B's /pool
 *   lite-di-strategies  the live strategy switch
 *   lite-di-supervisor / lite-di-health / lite-statechart   per-worker restart, readiness, breaker
 *   lite-di-event-bus   every decision as an event (numeric payloads -> 0 B/emit), flight recorder
 *   lite-di-cron        traffic 100 Hz, fleet 20 Hz, stats 1 Hz -- all on the injected clock
 *   lite-di-orchestrator  graceful shutdown: drain -> stop supervising -> quiesce -> retire -> exit
 *   lite-sketch         latency percentiles
 *
 * `io` injects everything that touches the outside world, so the same kernel runs in a terminal over
 * worker_threads, in a browser over Web Workers, and in tests over virtual workers on a virtual clock:
 *   { lp, poolMod, wp, spawn, now, timers?, config? }
 * lite-pick / lite-worker-pool arrive as module namespaces (F2): the served demo passes the pinned npm
 * releases, one test suite passes the repo's working tree.
 */

import { Container } from '@zakkster/lite-di-container';
import { StrategyRouter } from '@zakkster/lite-di-strategies';
import { EventBus } from '@zakkster/lite-di-event-bus';
import { Cron, interval } from '@zakkster/lite-di-cron';
import { Orchestrator } from '@zakkster/lite-di-orchestrator';
import { jobFn } from './job.js';
import { STRATEGIES, registerBalancers, Balancers } from './balancers.js';
import { Stats } from './stats.js';
import { Fleet } from './fleet.js';
import { Engine, ENGINE_A, ENGINE_B } from './engine.js';
import { Traffic } from './traffic.js';

export { STRATEGIES, ENGINE_A, ENGINE_B };

/** The default scene (P1 spec F3-F7). */
export const DEFAULTS = Object.freeze({
    workers: 8,
    speeds: [1, 1, 1, 1, 1, 1, 2, 3],      // slowdown per worker: 6 and 7 are 2x and 3x slower
    weights: [3, 3, 3, 3, 3, 3, 2, 1],     // capacity weights for the weighted strategies
    jobMs: 1,                              // ~1 ms of real CPU per job
    slots: 2,
    queue: 32,
    rate: 2000,                            // open-loop arrivals, req/s
    keys: 10000,
    zipfS: 1.1,
    strategy: 'p2c',
    seed: 0x1234abcd,
    maxRequests: 1024,                     // engine A's request table
    tries: 2,                              // attempts per request (1 = no failover; the /pool rule is 2)
    tauNs: 1e9,                            // PeakEWMA time constant
    penaltyNs: 1e9,                        // a failed attempt's recorded rtt floor (the /pool default)
    eps: 0.25,                             // BoundedLoad slack
    tableM: 4099,                          // Maglev table size (prime >= workers)
    breakerFailures: 5,                    // F3
    breakerCoolMs: 2000,
    hungMs: 500,                           // F4
    hungKillMs: 1000,
    maxRestarts: 5,                        // F5
    restartWindowMs: 30000,
    trafficMs: 10,                         // F7 cadences
    fleetMs: 50,
    statsMs: 1000,
    recorder: 4096,                        // flight-recorder entries
});

class TrafficJob { constructor(t) { this.t = t; } run(ctx) { this.t.tick(ctx.now); } }
class FleetJob { constructor(f) { this.f = f; } run(ctx) { this.f.tick(ctx.now); } }
class StatsJob { constructor(s) { this.s = s; } run(ctx) { this.s.roll(ctx.now); } }

/** Event counters, one listener class per event (the bus dispatches by index, 0 B/emit). */
export const EV_DISPATCH = 0, EV_FAILOVER = 1, EV_BREAKER = 2, EV_ELIGIBLE = 3, EV_RESTART = 4, EV_ESCALATE = 5, EV_COUNT = 6;
const EVENTS = ['dispatch', 'failover', 'breaker', 'eligible', 'restart', 'escalate'];
function counterFor(slot) {
    return class { constructor(ev) { this.ev = ev; } handle() { this.ev[slot]++; } };
}

/**
 * Build and start the system. Resolves once every worker is up (in tests, advance the virtual workers
 * while awaiting). Returns the kernel handle.
 */
export async function bootKernel(io) {
    const cfg = Object.freeze({ ...DEFAULTS, ...(io.config || {}) });
    const n = cfg.workers;
    const now = io.now;
    const shared = {
        n,
        seed: cfg.seed,
        up: new Uint8Array(n),                       // eligibility as the fleet last wrote it (all down until READY)
        inflight: new Uint32Array(n),
        weights: Uint32Array.from(cfg.weights),
    };
    const events = new Float64Array(EV_COUNT);

    const c = new Container();
    c.value('config', cfg);
    c.value('now', now);
    c.value('lp', io.lp);
    c.value('poolMod', io.poolMod);
    c.value('shared', shared);
    c.value('events', events);
    registerBalancers(c, io.lp, cfg, shared);

    let sink = null;   // set -> engine (the set is built before the engine that consumes its replies)
    c.singletonFactory('set', () => io.wp.createWorkerSet(jobFn, {
        size: n, slots: cfg.slots, queue: cfg.queue, spawn: io.spawn, now,
        onSettle: (i, tag, ok, value, code) => sink.onSettle(i, tag, ok, value, code),
    }));
    c.onTeardown('set', (set) => set.dispose());
    c.singleton('stats', Stats, ['config']);
    c.singleton('balancers', Balancers, ['shared']);
    c.singleton('fleet', Fleet, ['config', 'set', 'balancers', 'bus', 'now']);
    c.singleton('engine', Engine, ['config', 'set', 'balancers', 'fleet', 'stats', 'bus', 'now', 'poolMod']);
    c.singleton('traffic', Traffic, ['config', 'engine', 'lp']);

    const bus = new EventBus(c);
    c.value('bus', bus);
    for (let k = 0; k < EVENTS.length; k++) bus.on(EVENTS[k], counterFor(k), ['events']);

    const cron = new Cron(c, { tickMs: cfg.trafficMs, now });
    cron.job('traffic', TrafficJob, interval(cfg.trafficMs), { deps: ['traffic'] });
    cron.job('fleet', FleetJob, interval(cfg.fleetMs), { deps: ['fleet'] });
    cron.job('stats', StatsJob, interval(cfg.statsMs), { deps: ['stats'] });

    bus.boot();                                       // boots the root container (graph validated here)
    if (cfg.recorder > 0) bus.record(cfg.recorder);

    const balancers = c.get('balancers');
    const strategies = {};
    for (let k = 0; k < STRATEGIES.length; k++) strategies[STRATEGIES[k]] = 'lb:' + STRATEGIES[k];
    balancers.attachRouter(new StrategyRouter(c, { strategies, gate: (name) => name }));
    balancers.set(cfg.strategy);

    const set = c.get('set');
    const stats = c.get('stats');
    const fleet = c.get('fleet');
    const engine = c.get('engine');
    const traffic = c.get('traffic');
    sink = engine;

    await fleet.start(c);
    if (io.timers === 'real') cron.start(); else cron.arm();

    // Graceful shutdown (lite-di-orchestrator): drain -> stop supervising -> quiesce in-flight -> retire the
    // worker scopes -> root container teardown (set.dispose) -> exit(code).
    const orch = new Orchestrator(c, {
        health: { drain() { traffic.stop(); engine.draining = true; fleet.drain(); } },
        supervisor: { shutdown() { return fleet.shutdownSupervisors(); } },
    });
    orch.step('quiesce', () => new Promise((resolve) => {
        const poll = () => { if (engine.pending() === 0) resolve(); else (io.later || setTimeout)(poll, 5); };
        poll();
    }));
    orch.step('scopes', () => fleet.shutdownScopes());
    orch.step('stop-cron', () => { cron.stop(); });

    return {
        cfg, container: c, set, engine, fleet, traffic, stats, balancers, bus, cron, events, orchestrator: orch,
        /** Drive every due cron job at `t` (tests / a virtual clock). */
        tick(t) { cron.tick(t); },
        setStrategy(name) { balancers.set(name); engine.rebindPool(); },
        setEngine(mode) { engine.setMode(mode); },
        setRate(r) { traffic.rate = r; },
        fault(i, kind) { fleet.fault(i, kind); },
        heal(i) { fleet.heal(i); },
        reset(i) { return fleet.reset(i); },
        /** Resolves with the exit code; `exit` is injected (run.mjs passes process.exit). */
        shutdown(opts) {
            let code = -1;
            const o = opts || {};
            return orch.shutdown({
                exit: (x) => { code = x; if (o.exit) o.exit(x); },
                deadlineMs: o.deadlineMs || 10000,
                timers: o.timers,
            }).then(() => code);
        },
    };
}
