/**
 * @zakkster/lite-pick -- balance-quality gate (THE anchor).
 *
 *     node test/balance.mjs
 *
 * The differentiating benchmark: measured peak-to-average load across the workload
 * matrix (uniform / skewed-weight / skewed-cost), asserted within the strategy's
 * theoretical ceiling and strictly better than the random foil where the strategy
 * claims to be. P2C's headline is the Azar-Broder-Karlin-Upfal `ln ln n / ln 2` bound
 * (M3), where this gate does its most important work.
 *
 * M0 note: there is NO strategy yet, so there is nothing to balance. This harness is a
 * scaffold: it defines the uniform draw baseline (max load under pure random assignment)
 * that every strategy is measured AGAINST, so M1+ only appends the strategy's own row +
 * its ceiling assertion. It exits 0 at M0 (no strategy to fail).
 */

import { Prng } from '../Pick.js';

/** Max bin load when N balls land in N bins uniformly at random (the foil to beat). */
function randomMaxLoad(n, seed) {
    const bins = new Uint32Array(n);
    const rng = new Prng(seed);
    for (let i = 0; i < n; i++) bins[rng.nextBelow(n)]++;
    let max = 0;
    for (let i = 0; i < n; i++) if (bins[i] > max) max = bins[i];
    return max;
}

const SIZES = [64, 512, 4096];
process.stdout.write('lite-pick balance (M0: random-foil baseline only -- no strategy yet)\n');
for (const n of SIZES) {
    const maxLoad = randomMaxLoad(n, 0x1234abcd);
    const avg = 1; // n balls / n bins
    process.stdout.write('  n=' + String(n).padStart(5) +
        '  random peak/avg = ' + (maxLoad / avg).toFixed(2) +
        '  (~ln n / ln ln n; P2C target ~ ln ln n / ln 2 at M3)\n');
}
process.stdout.write('balance: PASS (baseline established; strategy ceilings assert from M1)\n');
