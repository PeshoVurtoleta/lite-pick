/**
 * pickEcosystem/live -- the ten lite-pick strategies behind a lite-di-strategies router (capstone C4).
 *
 * Each strategy is a plain container FACTORY (`lb:<name>`, a fresh balancer per resolve); the router maps a
 * strategy name to its token. A live switch builds the new balancer cold over a COPY of the current
 * eligibility (each balancer owns its array; the fleet's eligibility writer is the only writer, through
 * `setEligible`) and over the SAME caller-owned `inflight` array, so requests in flight on the old balancer
 * settle into the same counters. BoundedLoad's owned occupancy total is synced from `inflight` at the switch.
 */

export const STRATEGIES = Object.freeze([
    'roundrobin', 'smoothwrr', 'p2c', 'leastconn', 'sed', 'nq', 'peakewma', 'consistenthash', 'boundedload', 'weightedrandom',
]);

/** Register the ten `lb:<name>` factories on `c` (before boot). `shared` = { up, inflight, weights, n, seed }. */
export function registerBalancers(c, lp, cfg, shared) {
    const n = shared.n;
    const eligibleCopy = () => {
        const el = new Uint8Array(n);
        el.set(shared.up);
        return el;
    };
    const make = {
        roundrobin: () => new lp.RoundRobinBalancer(n, eligibleCopy()),
        smoothwrr: () => new lp.SmoothWRRBalancer(n, eligibleCopy(), new Uint32Array(shared.weights)),
        p2c: () => new lp.P2cBalancer(n, eligibleCopy(), shared.inflight, shared.seed),
        leastconn: () => new lp.LeastConnBalancer(n, eligibleCopy(), shared.inflight),
        sed: () => new lp.SedBalancer(n, eligibleCopy(), shared.inflight, shared.weights),
        nq: () => new lp.NqBalancer(n, eligibleCopy(), shared.inflight, shared.weights),
        peakewma: () => new lp.PeakEwmaBalancer(n, eligibleCopy(), shared.inflight, cfg.tauNs, shared.seed),
        consistenthash: () => new lp.ConsistentHashBalancer(n, eligibleCopy(), null, cfg.tableM),
        boundedload: () => new lp.BoundedLoadBalancer(n, eligibleCopy(), shared.inflight, cfg.eps, null, cfg.tableM),
        weightedrandom: () => new lp.WeightedRandomBalancer(n, eligibleCopy(), new Uint32Array(shared.weights), shared.seed),
    };
    for (let k = 0; k < STRATEGIES.length; k++) c.factory('lb:' + STRATEGIES[k], make[STRATEGIES[k]]);
}

/** The live balancer slot. Created by the container; the router is attached after boot. */
export class Balancers {
    constructor(shared) {
        this.shared = shared;
        this.router = null;
        this.lb = null;
        this.name = '';
        this.keyed = false;      // ConsistentHash / BoundedLoad: pick by key
        this.latency = false;    // PeakEWMA: pick by clock, fed recordRtt
        this.hasNote = false;    // BoundedLoad: occupancy total via note()
        this.switches = 0;
    }

    attachRouter(router) { this.router = router; }

    /** Switch strategy (cold). Throws (did-you-mean, from the router) on an unknown name. */
    set(name) {
        const lb = this.router.resolve(name);
        if (typeof lb.note === 'function') {
            const inf = this.shared.inflight;
            for (let i = 0; i < inf.length; i++) if (inf[i] > 0) lb.note(i, inf[i]);
        }
        this.lb = lb;
        this.name = name;
        this.keyed = lb.constructor.KEYED === true;
        this.latency = lb.constructor.LATENCY === true;
        this.hasNote = typeof lb.note === 'function';
        this.switches++;
        return lb;
    }

    /** The fleet's eligibility writer (the only one): record and apply. */
    setEligible(i, up) {
        this.shared.up[i] = up ? 1 : 0;
        this.lb.setEligible(i, up);
    }
}
