/**
 * @zakkster/lite-pick -- throughput witness.
 *
 *     node test/witness.mjs
 *
 * Witnesses that a strategy's pick() cost scales as ADVERTISED across a geometric
 * pool-size sweep (n = 8, 64, 512, 4096). Strategies carry different complexity, so the
 * witness carries a per-strategy expectation:
 *
 *   - 'const'  (RoundRobin, and later P2C/O(d)): raw ops/ms stays FLAT as n grows.
 *   - 'linear' (SmoothWRR, O(cap)): ops/ms decays ~1/n, so the WORK RATE (ops/ms * n)
 *              stays flat -- linear is expected, superlinear is the failure.
 *
 * The floor (min/max of the checked series >= 0.4) leaves headroom for cache/JIT noise
 * on tiny pools while still catching a real complexity regression.
 */

import { RoundRobinBalancer, SmoothWRRBalancer, P2cBalancer, LeastConnBalancer, SedBalancer, NqBalancer, PeakEwmaBalancer } from '../Pick.js';

const SIZES = [8, 64, 512, 4096];
const OPS = 2_000_000;
const FLOOR = 0.4;

function timePicks(step) {
    let sink = 0;
    for (let i = 0; i < OPS; i++) sink = (sink + step()) | 0; // warmup
    const t0 = performance.now();
    for (let i = 0; i < OPS; i++) sink = (sink + step()) | 0;
    const dt = performance.now() - t0;
    void sink;
    return OPS / dt; // ops/ms
}

/** Each subject: a name, an expected complexity, and a stepper factory over n endpoints. */
const SUBJECTS = [
    {
        name: 'RoundRobin',
        complexity: 'const',
        make(n) {
            const el = new Uint8Array(n); el.fill(1);
            const rr = new RoundRobinBalancer(n, el);
            return () => rr.pick();
        },
    },
    {
        name: 'SmoothWRR',
        complexity: 'linear', // O(cap) per pick -> ops/ms * n is the flat series
        make(n) {
            const el = new Uint8Array(n); el.fill(1);
            const w = new Uint32Array(n);
            for (let i = 0; i < n; i++) w[i] = 1 + (i & 7);
            const wrr = new SmoothWRRBalancer(n, el, w);
            return () => wrr.pick();
        },
    },
    {
        name: 'P2C',
        complexity: 'const', // two O(1)-expected rejection draws + a compare -> flat with n
        make(n) {
            const el = new Uint8Array(n); el.fill(1);
            const inflight = new Uint32Array(n);
            for (let i = 0; i < n; i++) inflight[i] = i & 15;
            const p2c = new P2cBalancer(n, el, inflight, 0xABCDEF);
            return () => p2c.pick();
        },
    },
    {
        name: 'LeastConn',
        complexity: 'linear', // exact O(cap) scan -> ops/ms * n is the flat series
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
        complexity: 'linear', // O(cap) scan + a division per eligible node
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
        complexity: 'linear', // O(cap) worst case (no idle node); busy pool forces the full scan
        make(n) {
            const el = new Uint8Array(n); el.fill(1);
            const inflight = new Uint32Array(n);
            const w = new Uint32Array(n);
            for (let i = 0; i < n; i++) { inflight[i] = 1 + (i & 15); w[i] = 1 + (i & 7); } // all busy
            const nq = new NqBalancer(n, el, inflight, w);
            return () => nq.pick();
        },
    },
    {
        name: 'PeakEWMA',
        complexity: 'const', // two O(1)-expected rejection draws + two decay exp() + a compare -> flat with n
        make(n) {
            const el = new Uint8Array(n); el.fill(1);
            const inflight = new Uint32Array(n);
            for (let i = 0; i < n; i++) inflight[i] = i & 15;
            const pe = new PeakEwmaBalancer(n, el, inflight, 1e6, 0xABCDEF);
            for (let i = 0; i < n; i += 4) pe.recordRtt(i, (i & 31) * 1000, 0); // warm, varied costs
            let now = 0;
            return () => { now += 1000; return pe.pick(now); };
        },
    },
];

let failed = false;
for (const subj of SUBJECTS) {
    process.stdout.write('lite-pick witness (M7: ' + subj.name + ', ' + subj.complexity + ')\n');
    const rows = SIZES.map((n) => ({ n, opsPerMs: timePicks(subj.make(n)) }));
    // The series that MUST stay flat depends on the advertised complexity.
    const series = rows.map((r) => (subj.complexity === 'linear' ? r.opsPerMs * r.n : r.opsPerMs));
    const min = Math.min(...series), max = Math.max(...series);
    const flatness = min / max;
    for (const r of rows) {
        process.stdout.write('  n=' + String(r.n).padStart(5) + '  ' +
            r.opsPerMs.toFixed(0).padStart(9) + ' ops/ms' +
            (subj.complexity === 'linear' ? '   (work-rate ' + (r.opsPerMs * r.n).toFixed(0) + ')' : '') + '\n');
    }
    const label = subj.complexity === 'linear' ? 'work-rate flatness' : 'flatness';
    process.stdout.write('  ' + label + ' (min/max) = ' + flatness.toFixed(3) +
        ' -> ' + (flatness >= FLOOR ? 'PASS' : 'FAIL') + '\n\n');
    if (flatness < FLOOR) failed = true;
}

if (failed) {
    process.stderr.write('witness: FAIL -- a strategy did not scale as advertised\n');
    process.exit(1);
}
process.stdout.write('witness: PASS\n');
