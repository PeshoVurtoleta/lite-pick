/**
 * @zakkster/lite-pick -- the seeded invariant fuzzer (the state-machine attack).
 *
 *     node test/fuzz.mjs            # CI mode: fixed + random + regression + pathological
 *     node test/fuzz.mjs <seed>     # replay one seed (byte-for-byte, printed on any failure)
 *
 * A property-based barrage of pick / setEligible / setWeight / load-change ops against each
 * state-owning strategy, asserting its INVARIANTS after EVERY op via the reusable checker in
 * test/invariants.mjs. This is the net-new correctness vector (RESEARCH section 3): not "never
 * returns a down index" (the churn test's job) but STATE SYNCHRONISATION -- every maintained
 * aggregate stays EXACT vs a manual recompute, owned Float64 state stays finite, PICK_NONE
 * holds IFF the pickable mass is 0, and the exact strategies (LeastConn/SED/NQ) return the
 * true optimum. Prior art: AWS lightweight formal methods, Linux scheduler selftests /
 * syzkaller, Envoy's round-robin LB fuzz test.
 *
 * Complements -- never replaces -- test/balance.mjs: the fuzzer proves no state corruption;
 * the balance anchor proves the algorithm does the RIGHT thing. Strict mode checks after
 * every op (the real proof); the driver runs strict here.
 */

import {
    RoundRobinBalancer, SmoothWRRBalancer, P2cBalancer,
    LeastConnBalancer, SedBalancer, NqBalancer, PICK_NONE,
} from '../Pick.js';
import {
    checkBase, recomputeEligibleWeight, recomputeEligibleWeighted,
    allFinite, minEligibleScore,
} from './invariants.mjs';

/** The fuzzer's OWN deterministic RNG (an LCG), independent of any balancer's internal PRNG. */
function lcg(seed) {
    let s = (seed >>> 0) || 0x9e3779b9;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
}

/** A weight draw: mostly small, sometimes 0 (candidate exclusion), rarely 0xFFFFFFFF (overflow probe). */
function drawWeight(rnd) {
    const r = rnd() % 100;
    if (r < 5) return 0;
    if (r < 7) return 0xFFFFFFFF;
    return 1 + (rnd() % 8);
}

/**
 * Strategy specs. `mass(ctx)` is the pickable mass for the fail-closed IFF; `extra(b, ctx, p)`
 * asserts the strategy-specific invariants (returns null or a reason string).
 */
const SPECS = {
    RoundRobin: {
        weighted: false, loadAware: false, usesSetWeight: false,
        make: (cap, el) => new RoundRobinBalancer(cap, el),
        mass: (ctx) => ctx.b.live,
        extra: () => null,
    },
    SmoothWRR: {
        weighted: true, loadAware: false, usesSetWeight: true,
        make: (cap, el, _inf, w) => new SmoothWRRBalancer(cap, el, w),
        mass: (ctx) => recomputeEligibleWeight(ctx.el, ctx.weights, ctx.cap),
        extra: (b, ctx) => {
            const want = recomputeEligibleWeight(ctx.el, ctx.weights, ctx.cap);
            if (b._totalEligibleWeight !== want) {
                return '_totalEligibleWeight ' + b._totalEligibleWeight + ' != recomputed ' + want;
            }
            if (!allFinite(b._current, ctx.cap)) return '_current has a non-finite accumulator';
            return null;
        },
    },
    P2C: {
        weighted: false, loadAware: true, usesSetWeight: false,
        make: (cap, el, inf) => new P2cBalancer(cap, el, inf, 0xC0FFEE),
        mass: (ctx) => ctx.b.live,
        extra: () => null, // two-choice: no exact-min claim, base invariants only
    },
    LeastConn: {
        weighted: false, loadAware: true, usesSetWeight: false,
        make: (cap, el, inf) => new LeastConnBalancer(cap, el, inf),
        mass: (ctx) => ctx.b.live,
        extra: (b, ctx, p) => {
            if (p === PICK_NONE) return null;
            const min = minEligibleScore(ctx.el, ctx.cap, (i) => ctx.inflight[i]);
            if (ctx.inflight[p] !== min) return 'not the least-conn: inflight[' + p + ']=' + ctx.inflight[p] + ' != min ' + min;
            return null;
        },
    },
    SED: {
        weighted: true, loadAware: true, usesSetWeight: false,
        make: (cap, el, inf, w) => new SedBalancer(cap, el, inf, w),
        mass: (ctx) => recomputeEligibleWeighted(ctx.el, ctx.weights, ctx.cap),
        extra: (b, ctx, p) => {
            if (p === PICK_NONE) return null;
            if (ctx.weights[p] === 0) return 'SED picked a weight-0 node ' + p;
            const score = (ctx.inflight[p] + 1) / ctx.weights[p];
            const min = minEligibleScore(ctx.el, ctx.cap,
                (i) => (ctx.inflight[i] + 1) / ctx.weights[i], (i) => ctx.weights[i] > 0);
            if (score !== min) return 'not the SED min: score ' + score + ' != min ' + min;
            return null;
        },
    },
    NQ: {
        weighted: true, loadAware: true, usesSetWeight: false,
        make: (cap, el, inf, w) => new NqBalancer(cap, el, inf, w),
        mass: (ctx) => recomputeEligibleWeighted(ctx.el, ctx.weights, ctx.cap),
        extra: (b, ctx, p) => {
            if (p === PICK_NONE) return null;
            if (ctx.weights[p] === 0) return 'NQ picked a weight-0 node ' + p;
            // First idle eligible (weight > 0, inflight 0) short-circuits the scan.
            let firstIdle = -1;
            for (let i = 0; i < ctx.cap; i++) {
                if (ctx.el[i] && ctx.weights[i] > 0 && ctx.inflight[i] === 0) { firstIdle = i; break; }
            }
            if (firstIdle >= 0) {
                return p === firstIdle ? null : 'NQ ignored an idle node: picked ' + p + ', first idle ' + firstIdle;
            }
            // No idle node -> NQ reduces to SED.
            const score = (ctx.inflight[p] + 1) / ctx.weights[p];
            const min = minEligibleScore(ctx.el, ctx.cap,
                (i) => (ctx.inflight[i] + 1) / ctx.weights[i], (i) => ctx.weights[i] > 0);
            if (score !== min) return 'NQ fallback not the SED min: score ' + score + ' != min ' + min;
            return null;
        },
    },
};

/**
 * One fuzz run: build the shared arrays + the balancer, then STEPS times perform one optional
 * mutation, a pick, and a full invariant check. Returns null on success or a failure record.
 */
function runOne(name, seed, cap, steps) {
    const spec = SPECS[name];
    const rnd = lcg(seed);
    const el = new Uint8Array(cap);
    for (let i = 0; i < cap; i++) el[i] = (rnd() % 10) >= 3 ? 1 : 0; // ~70% up
    const inflight = new Uint32Array(cap);
    if (spec.loadAware) for (let i = 0; i < cap; i++) inflight[i] = rnd() % 16;
    const weights = new Uint32Array(cap);
    if (spec.weighted) for (let i = 0; i < cap; i++) weights[i] = drawWeight(rnd);

    const b = spec.make(cap, el, inflight, weights);
    const ctx = { b, cap, el, inflight, weights };

    for (let step = 0; step < steps; step++) {
        const r = rnd() % 100;
        if (r < 25) {
            // eligibility toggle -- MUST go through the balancer so it maintains its aggregates
            b.setEligible(rnd() % cap, (rnd() & 1) === 0);
        } else if (r < 45 && spec.loadAware) {
            const i = rnd() % cap, kind = rnd() % 3;
            if (kind === 0) inflight[i] = (inflight[i] + 1) >>> 0;             // dispatch
            else if (kind === 1) inflight[i] = inflight[i] > 0 ? inflight[i] - 1 : 0; // settle
            else inflight[i] = rnd() % 32;                                     // jump
        } else if (r < 60 && spec.weighted) {
            const i = rnd() % cap, w = drawWeight(rnd);
            if (spec.usesSetWeight) b.setWeight(i, w); else weights[i] = w;    // live vs sole-writer
        }
        // Sometimes exercise the pathological max on SmoothWRR's summed total directly.
        if ((r & 31) === 7 && spec.weighted && spec.usesSetWeight) b.setWeight(rnd() % cap, 0xFFFFFFFF);

        const p = b.pick();
        const mass = spec.mass(ctx);
        const baseErr = checkBase(b, el, cap, p, mass);
        if (baseErr) return { name, seed, cap, step, reason: baseErr };
        const extraErr = spec.extra(b, ctx, p);
        if (extraErr) return { name, seed, cap, step, reason: extraErr };

        // Keep the closed loop moving so LeastConn/SED/NQ explore the pool.
        if (spec.loadAware && p !== PICK_NONE && (rnd() & 1)) inflight[p] = (inflight[p] + 1) >>> 0;
    }
    return null;
}

/** Explicit pathological corpus: hand-built states that historically break naive balancers. */
function pathological() {
    const fails = [];
    // 1. SmoothWRR: max-weight summed total stays exact and finite under 2^53.
    {
        const cap = 8, el = new Uint8Array(cap).fill(1), w = new Uint32Array(cap).fill(0xFFFFFFFF);
        const b = new SmoothWRRBalancer(cap, el, w);
        for (let i = 0; i < 5000; i++) {
            const p = b.pick();
            if (p === PICK_NONE || !el[p]) { fails.push('pathological max-weight SmoothWRR bad pick ' + p); break; }
        }
        const want = recomputeEligibleWeight(el, w, cap);
        if (b._totalEligibleWeight !== want) fails.push('pathological max-weight total desync ' + b._totalEligibleWeight + ' != ' + want);
        if (!allFinite(b._current, cap)) fails.push('pathological max-weight _current non-finite');
    }
    // 2. All-zero weight while live > 0: SmoothWRR / SED / NQ all fail closed.
    {
        const cap = 4, el = new Uint8Array(cap).fill(1), w = new Uint32Array(cap), inf = new Uint32Array(cap);
        for (const b of [new SmoothWRRBalancer(cap, el, w), new SedBalancer(cap, el, inf, w), new NqBalancer(cap, el, inf, w)]) {
            if (b.pick() !== PICK_NONE) fails.push('all-zero-weight ' + b.constructor.name + ' did not fail closed (live=' + b.live + ')');
        }
    }
    // 3. Single node: every strategy returns it while up, PICK_NONE when down.
    {
        const el = new Uint8Array(1).fill(1), inf = new Uint32Array(1), w = new Uint32Array(1).fill(3);
        const bs = [
            new RoundRobinBalancer(1, el), new SmoothWRRBalancer(1, el, w), new P2cBalancer(1, el, inf),
            new LeastConnBalancer(1, el, inf), new SedBalancer(1, el, inf, w), new NqBalancer(1, el, inf, w),
        ];
        for (const b of bs) if (b.pick() !== 0) fails.push('single-node ' + b.constructor.name + ' did not return 0');
        el[0] = 0;
        for (const b of bs) { b.setEligible(0, false); if (b.pick() !== PICK_NONE) fails.push('single-node-down ' + b.constructor.name + ' did not fail closed'); }
    }
    return fails;
}

// --- driver -----------------------------------------------------------------
const argSeed = process.argv[2] !== undefined ? (Number(process.argv[2]) >>> 0) : null;
const NAMES = Object.keys(SPECS);
const CAPS = [1, 2, 7, 63];
const STEPS = 4000;
// CI seeds: a FIXED regression seed, a RANDOM discovery seed, and a growing bug-finding corpus.
const REGRESSION_CORPUS = [0x00000001, 0xDEADBEEF, 0x5EED5EED, 0x0BADF00D, 0xC0FFEE];
const seeds = argSeed !== null
    ? [argSeed]
    : [0x12345678, (Math.random() * 0xffffffff) >>> 0, ...REGRESSION_CORPUS];

let failed = false;
process.stdout.write('lite-pick fuzz (M4: invariant state-machine attack)\n');

const pathFails = pathological();
if (pathFails.length) { failed = true; for (const f of pathFails) process.stderr.write('  FAIL pathological: ' + f + '\n'); }
else process.stdout.write('  ok   pathological corpus (max-weight, all-zero-weight, single-node)\n');

let runs = 0;
for (const name of NAMES) {
    for (const seed of seeds) {
        for (const cap of CAPS) {
            const res = runOne(name, seed, cap, STEPS);
            runs++;
            if (res) {
                failed = true;
                process.stderr.write('  FAIL ' + res.name + ' seed=0x' + res.seed.toString(16) +
                    ' cap=' + res.cap + ' step=' + res.step + ': ' + res.reason +
                    '\n        replay: node test/fuzz.mjs ' + res.seed + '\n');
            }
        }
    }
    if (!failed) process.stdout.write('  ok   ' + name.padEnd(10) + ' (' + (seeds.length * CAPS.length) + ' runs x ' + STEPS + ' strict ops)\n');
}

if (failed) { process.stderr.write('fuzz: FAIL\n'); process.exit(1); }
process.stdout.write('fuzz: PASS (' + runs + ' runs, strict-mode invariants after every op)\n');
