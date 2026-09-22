/**
 * @zakkster/lite-pick -- throughput witness.
 *
 *     node test/witness.mjs
 *
 * Witnesses that a strategy's pick() holds its ops/ms as the pool grows (a good pick()
 * is O(1) or O(d), never O(n)) across a geometric pool-size sweep (n = 8, 64, 512, 4096).
 *
 * M0 note: there is NO strategy pick() yet -- the first strategy (M1 RoundRobin) lands
 * the flatness gate here. For now the witness proves the SUBSTRATE draw is flat: Prng +
 * BalancerBase.isEligible cost is independent of pool size, the floor every strategy
 * builds on. Each strategy session (M1+) appends its own pick() sweep + flatness assert.
 */

import { Prng, BalancerBase } from '../Pick.js';

const SIZES = [8, 64, 512, 4096];
const OPS = 2_000_000;

function measure(n) {
    const el = new Uint8Array(n);
    for (let i = 0; i < n; i += 2) el[i] = 1;
    const base = new BalancerBase(n, el);
    const rng = new Prng(0x1234abcd);
    // warmup (let V8 settle the call sites)
    let sink = 0;
    for (let i = 0; i < OPS; i++) sink = (sink + (base.isEligible(rng.nextBelow(n)) ? 1 : 0)) | 0;
    const t0 = performance.now();
    for (let i = 0; i < OPS; i++) sink = (sink + (base.isEligible(rng.nextBelow(n)) ? 1 : 0)) | 0;
    const dt = performance.now() - t0;
    void sink;
    return OPS / dt; // ops/ms
}

const results = SIZES.map((n) => ({ n, opsPerMs: measure(n) }));
const rates = results.map((r) => r.opsPerMs);
const min = Math.min(...rates);
const max = Math.max(...rates);
const flatness = min / max; // 1.0 = perfectly flat; O(1) substrate stays near 1

process.stdout.write('lite-pick witness (M0 substrate: Prng draw + isEligible)\n');
for (const r of results) {
    process.stdout.write('  n=' + String(r.n).padStart(5) + '  ' +
        r.opsPerMs.toFixed(0).padStart(9) + ' ops/ms\n');
}
process.stdout.write('  flatness (min/max) = ' + flatness.toFixed(3) + '\n');

// A generous floor: the substrate is O(1), so the slowest size must stay within ~2.5x
// of the fastest (headroom for cache/JIT noise on tiny pools). Strategies tighten this.
const FLOOR = 0.4;
if (flatness < FLOOR) {
    process.stderr.write('witness: FAIL -- substrate not flat (min/max ' +
        flatness.toFixed(3) + ' < ' + FLOOR + ')\n');
    process.exit(1);
}
process.stdout.write('witness: PASS\n');
