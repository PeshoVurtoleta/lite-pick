/**
 * @zakkster/lite-pick -- benchmark matrix (SUBJECTS + foils).
 *
 *     node benchmark/Matrix.mjs
 *
 * This is the registration point each strategy adds a SUBJECT to (accounting site 13).
 * The FULL benchmark suite -- all ten dimensions, the GC blast-radius chart, the balance
 * anchor, the trust gates, the reproducibility machinery, and the incumbent npm foils
 * (`load-balancers`, `loadbalance`, `wrr`) -- is a dedicated session, M6 (RESEARCH s3).
 * Until then this file measures raw pick() throughput for the shipped strategies against
 * a hand-rolled foil, so the SUBJECTS list and the harness shape exist and stay honest.
 *
 * Framing (do NOT drift): the headline is NOT "X times faster". A trivial `i++ % n` foil
 * MATCHES an honest strategy on raw ops/sec; lite-pick's claims are the 0 B/op contract
 * (torture / PerfGate) and balance quality + tail (balance.mjs, and M6). This file is the
 * PARITY check -- a strategy within noise of the foil while holding the contract has passed.
 */

import { RoundRobinBalancer, SmoothWRRBalancer, P2cBalancer, LeastConnBalancer, SedBalancer, NqBalancer, Prng } from '../Pick.js';

export const SIZES = [8, 64, 512, 4096];
export const OPS = 2_000_000;

/**
 * The SHARED, SEEDED workload matrix (M6). Every dimension file (GcBlastRadius,
 * Fairness, Disruption, Report) builds its inputs from here, so the whole suite runs
 * the SAME reproducible pool state -- one seed set, stamped into results.json. The three
 * workload shapes mirror the balance-gate matrix (RESEARCH dimension 2):
 *
 *   - 'uniform'       all endpoints eligible, equal weight; inflight seeded jittered.
 *   - 'skewed-weight' all eligible, weights fan 1..16 (the SmoothWRR/SED fairness case).
 *   - 'skewed-cost'   a slow-node pool: a minority of endpoints carry heavy standing
 *                     inflight (the least-conn / P2C balance-under-load case).
 *
 * Seeds are named so Report.mjs can stamp EVERY PRNG seed into results.json (teeth).
 */
export const SEEDS = Object.freeze({
    workload: 0x1234abcd,
    p2c: 0xABCDEF,
    foil: 0xC0FFEE,
    gc: 0x51A17ED,
    disruption: 0xBEEF1234,
});

export const WORKLOAD_KINDS = Object.freeze(['uniform', 'skewed-weight', 'skewed-cost']);

/**
 * Build one seeded workload of `kind` over n endpoints. Returns caller-owned typed-array
 * views (eligible / weights / inflight) plus the seed used -- pure, deterministic, 0 shared
 * state between calls. `seed` defaults to SEEDS.workload so every dimension agrees.
 */
export function buildWorkload(kind, n, seed = SEEDS.workload) {
    if (WORKLOAD_KINDS.indexOf(kind) === -1) {
        throw new Error('buildWorkload: unknown kind "' + kind + '" -- did you mean one of ' +
            WORKLOAD_KINDS.join(', ') + '?');
    }
    const rng = new Prng(seed);
    const eligible = new Uint8Array(n);
    const weights = new Uint32Array(n);
    const inflight = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
        eligible[i] = 1;
        if (kind === 'uniform') {
            weights[i] = 1;
            inflight[i] = rng.nextBelow(16);
        } else if (kind === 'skewed-weight') {
            weights[i] = 1 + (i % 16);
            inflight[i] = rng.nextBelow(16);
        } else { // skewed-cost: a slow minority carries heavy standing load
            weights[i] = 1;
            inflight[i] = (rng.nextBelow(8) === 0) ? 64 + rng.nextBelow(64) : rng.nextBelow(4);
        }
    }
    return { kind, n, seed, eligible, weights, inflight };
}

/**
 * Each SUBJECT builds a stepper over an all-up pool of n endpoints. `dims` lists the
 * benchmark dimensions (RESEARCH section 3) the subject participates in, so the report
 * can route a subject to the right chart without a second registry:
 *   'throughput' (parity), 'balance', 'gc', 'fairness', 'disruption'.
 */
export const SUBJECTS = [
    {
        name: 'RoundRobin',
        dims: ['throughput'],
        make(n) {
            const el = new Uint8Array(n); el.fill(1);
            const rr = new RoundRobinBalancer(n, el);
            return () => rr.pick();
        },
    },
    {
        // Foil: eligibility-blind wrapping index. Fast, but returns down nodes under
        // partial eligibility (balance.mjs shows the dead-pick trap this falls into).
        name: 'foil i++ % n',
        dims: ['throughput'],
        make(n) {
            let i = -1;
            return () => { i++; if (i >= n) i = 0; return i; };
        },
    },
    {
        name: 'SmoothWRR',
        dims: ['throughput', 'fairness'],
        make(n) {
            const el = new Uint8Array(n); el.fill(1);
            const w = new Uint32Array(n);
            for (let i = 0; i < n; i++) w[i] = 1 + (i & 7);
            const wrr = new SmoothWRRBalancer(n, el, w);
            return () => wrr.pick();
        },
    },
    {
        // Foil: naive weight-expansion WRR. Precomputes an expanded index list and cycles
        // it -- fast per step, but BURSTY (balance.mjs shows the clumping SmoothWRR avoids).
        name: 'foil expand-WRR',
        dims: ['throughput', 'fairness'],
        make(n) {
            const list = [];
            for (let i = 0; i < n; i++) { const w = 1 + (i & 7); for (let k = 0; k < w; k++) list.push(i); }
            const len = list.length;
            let i = -1;
            return () => { i++; if (i >= len) i = 0; return list[i]; };
        },
    },
    {
        name: 'P2C',
        dims: ['throughput', 'balance', 'gc'],
        make(n) {
            const el = new Uint8Array(n); el.fill(1);
            const inflight = new Uint32Array(n);
            for (let i = 0; i < n; i++) inflight[i] = i & 15;
            const p2c = new P2cBalancer(n, el, inflight, 0xABCDEF);
            return () => p2c.pick();
        },
    },
    {
        // Foil: random single draw. Ties P2C on throughput but loses on balance (the
        // ln ln n vs ln n / ln ln n gap -- balance.mjs is the anchor that shows it).
        name: 'foil random',
        dims: ['throughput', 'balance'],
        make(n) {
            const rng = new Prng(0xABCDEF);
            return () => rng.nextBelow(n);
        },
    },
    {
        // EXACT fewest-in-flight, O(cap) scan. The PARITY point is that the exact scan is a
        // few ns/endpoint; balance.mjs shows it achieves the perfect greedy balance P2C
        // approximates. (The allocating "fresh Array + Math.min" anti-pattern this replaces is
        // proven to trip the gate by PerfGate's mustFail teeth, not raced on throughput here.)
        name: 'LeastConn',
        dims: ['throughput', 'balance'],
        make(n) {
            const el = new Uint8Array(n); el.fill(1);
            const inflight = new Uint32Array(n);
            for (let i = 0; i < n; i++) inflight[i] = i & 15;
            const lc = new LeastConnBalancer(n, el, inflight);
            return () => lc.pick();
        },
    },
    {
        name: 'SED',
        dims: ['throughput', 'fairness'],
        make(n) {
            const el = new Uint8Array(n); el.fill(1);
            const inflight = new Uint32Array(n);
            const w = new Uint32Array(n);
            for (let i = 0; i < n; i++) { inflight[i] = i & 15; w[i] = 1 + (i & 7); }
            const sed = new SedBalancer(n, el, inflight, w);
            return () => sed.pick();
        },
    },
    {
        name: 'NQ',
        dims: ['throughput'],
        make(n) {
            const el = new Uint8Array(n); el.fill(1);
            const inflight = new Uint32Array(n);
            const w = new Uint32Array(n);
            for (let i = 0; i < n; i++) { inflight[i] = 1 + (i & 15); w[i] = 1 + (i & 7); } // all busy: SED fallback
            const nq = new NqBalancer(n, el, inflight, w);
            return () => nq.pick();
        },
    },
];

export function bench(step) {
    let sink = 0;
    for (let i = 0; i < OPS; i++) sink = (sink + step()) | 0; // warmup
    const t0 = performance.now();
    for (let i = 0; i < OPS; i++) sink = (sink + step()) | 0;
    const dt = performance.now() - t0;
    void sink;
    return OPS / dt;
}

/** Run the throughput sweep and return { [name]: { [n]: opsPerMs } } -- the parity slice. */
export function measureThroughput() {
    const out = {};
    for (const subj of SUBJECTS) {
        const row = {};
        for (const n of SIZES) row[n] = bench(subj.make(n));
        out[subj.name] = row;
    }
    return out;
}

// Runnable standalone (`node benchmark/Matrix.mjs`); importing this file must NOT run the
// sweep (Report.mjs imports SUBJECTS / buildWorkload), so the runner is behind a main guard.
if (import.meta.url === 'file://' + process.argv[1]) {
    process.stdout.write('lite-pick benchmark matrix -- raw pick() ops/ms (parity check)\n');
    process.stdout.write('  (full 10-dimension suite is M6; this is the throughput slice)\n\n');
    const header = 'subject'.padEnd(16) + SIZES.map((n) => ('n=' + n).padStart(12)).join('');
    process.stdout.write(header + '\n');
    for (const subj of SUBJECTS) {
        let row = subj.name.padEnd(16);
        for (const n of SIZES) row += bench(subj.make(n)).toFixed(0).padStart(12);
        process.stdout.write(row + '\n');
    }
}
