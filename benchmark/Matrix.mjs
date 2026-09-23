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

const SIZES = [8, 64, 512, 4096];
const OPS = 2_000_000;

/** Each SUBJECT builds a stepper over an all-up pool of n endpoints. */
const SUBJECTS = [
    {
        name: 'RoundRobin',
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
        make(n) {
            let i = -1;
            return () => { i++; if (i >= n) i = 0; return i; };
        },
    },
    {
        name: 'SmoothWRR',
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

function bench(step) {
    let sink = 0;
    for (let i = 0; i < OPS; i++) sink = (sink + step()) | 0; // warmup
    const t0 = performance.now();
    for (let i = 0; i < OPS; i++) sink = (sink + step()) | 0;
    const dt = performance.now() - t0;
    void sink;
    return OPS / dt;
}

process.stdout.write('lite-pick benchmark matrix -- raw pick() ops/ms (parity check)\n');
process.stdout.write('  (full 10-dimension suite is M6; this is the throughput slice)\n\n');
const header = 'subject'.padEnd(16) + SIZES.map((n) => ('n=' + n).padStart(12)).join('');
process.stdout.write(header + '\n');
for (const subj of SUBJECTS) {
    let row = subj.name.padEnd(16);
    for (const n of SIZES) row += bench(subj.make(n)).toFixed(0).padStart(12);
    process.stdout.write(row + '\n');
}
