/**
 * @zakkster/lite-pick -- throughput witness.
 *
 *     node test/witness.mjs
 *
 * Witnesses that a strategy's pick() holds its ops/ms as the pool grows (a good pick() is
 * O(1) or O(d), never O(n)) across a geometric pool-size sweep (n = 8, 64, 512, 4096).
 *
 * M1: RoundRobin.pick() is the strategy under test. It is O(1) amortized when eligibility
 * is dense (the measured case here -- all nodes up), so ops/ms must stay flat as n grows.
 * (The sparse-eligibility O(cap) worst case is a documented edge, not the steady state.)
 * Each later strategy appends its own pick() sweep + flatness assert here.
 */

import { RoundRobinBalancer } from '../Pick.js';

const SIZES = [8, 64, 512, 4096];
const OPS = 2_000_000;

function measure(n) {
    const el = new Uint8Array(n);
    el.fill(1); // all eligible: RR's O(1)-amortized steady state
    const rr = new RoundRobinBalancer(n, el);
    let sink = 0;
    for (let i = 0; i < OPS; i++) sink = (sink + rr.pick()) | 0; // warmup
    const t0 = performance.now();
    for (let i = 0; i < OPS; i++) sink = (sink + rr.pick()) | 0;
    const dt = performance.now() - t0;
    void sink;
    return OPS / dt; // ops/ms
}

const results = SIZES.map((n) => ({ n, opsPerMs: measure(n) }));
const rates = results.map((r) => r.opsPerMs);
const min = Math.min(...rates);
const max = Math.max(...rates);
const flatness = min / max; // 1.0 = perfectly flat; O(1) pick stays near 1

process.stdout.write('lite-pick witness (M1: RoundRobin.pick())\n');
for (const r of results) {
    process.stdout.write('  n=' + String(r.n).padStart(5) + '  ' +
        r.opsPerMs.toFixed(0).padStart(9) + ' ops/ms\n');
}
process.stdout.write('  flatness (min/max) = ' + flatness.toFixed(3) + '\n');

// O(1) amortized -> the slowest size stays within ~2.5x of the fastest (headroom for
// cache/JIT noise on tiny pools). A decay to O(n) would blow this floor at n=4096.
const FLOOR = 0.4;
if (flatness < FLOOR) {
    process.stderr.write('witness: FAIL -- RoundRobin.pick() not flat (min/max ' +
        flatness.toFixed(3) + ' < ' + FLOOR + ')\n');
    process.exit(1);
}
process.stdout.write('witness: PASS\n');
