/**
 * @zakkster/lite-pick -- weighted fairness / convergence (M6 dimension 8, a trust gate).
 *
 *     node benchmark/Fairness.mjs
 *
 * Proof the weighted path is CORRECT, not just fast (RESEARCH dimension 8). Two measures:
 *
 *   - SmoothWRR: does it converge EXACTLY to the configured weight ratios, and SMOOTHLY
 *     (not bursty like naive weight-expansion WRR)? Exact fairness (counts == k*weight) plus
 *     a burstiness measure (max consecutive run) vs the bursty expand-WRR foil + the
 *     Math.random weighted-expansion foil (`wrr`, an incumbent npm package).
 *   - SED: in a closed feedback loop, does load settle PROPORTIONAL to weight? Worst-node
 *     share drift from its weight target, and the weighted imbalance vs a weight-blind
 *     random foil (which starves/floods the heavy nodes).
 *
 * Convergence + burstiness are ALGORITHMIC and seeded -- exact, reproducible, drift-checked.
 */

import { SmoothWRRBalancer, SedBalancer, Prng } from '../Pick.js';
import { SEEDS } from './Matrix.mjs';

const maxRun = (seq) => {
    let best = 0, run = 0, prev = -2;
    for (let i = 0; i < seq.length; i++) {
        const x = seq[i];
        run = x === prev ? run + 1 : 1;
        prev = x;
        if (run > best) best = run;
    }
    return best;
};

/** SmoothWRR convergence + smoothness on the canonical skewed weight vector. */
function measureSmoothWRR() {
    const weights = Uint32Array.from([10, 3, 2, 1]); // total 16, skewed
    let total = 0; for (let i = 0; i < weights.length; i++) total += weights[i];
    const n = weights.length;
    const el = new Uint8Array(n); el.fill(1);
    const wrr = new SmoothWRRBalancer(n, el, weights);

    const k = 500;
    const counts = new Uint32Array(n);
    const seq = new Int32Array(k * total);
    for (let i = 0; i < seq.length; i++) { const p = wrr.pick(); counts[p]++; seq[i] = p; }

    let exactFair = true;
    for (let i = 0; i < n; i++) if (counts[i] !== k * weights[i]) exactFair = false;

    // Bursty foil: naive weight-expansion list cycled in order (clumps the heavy node).
    const list = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < weights[i]; j++) list.push(i);
    const bursty = new Int32Array(seq.length);
    for (let p = 0; p < seq.length; p++) bursty[p] = list[p % list.length];

    return {
        weights: Array.from(weights),
        cycles: k,
        exactFair,
        smoothMaxRun: maxRun(seq),
        burstyMaxRun: maxRun(bursty),
    };
}

/** SED weighted least-conn: load settles proportional to weight in a feedback loop. */
function measureSed() {
    const weights = Uint32Array.from([1, 2, 3, 4, 6, 8, 12, 16]); // sum 52, skewed
    let wsum = 0; for (let i = 0; i < weights.length; i++) wsum += weights[i];
    const n = weights.length;
    const el = new Uint8Array(n); el.fill(1);
    const inflight = new Uint32Array(n);
    const sed = new SedBalancer(n, el, inflight, weights);
    const TOTAL = 200000;
    for (let i = 0; i < TOTAL; i++) inflight[sed.pick()]++;

    let worst = 0;
    for (let i = 0; i < n; i++) {
        const drift = Math.abs(inflight[i] / TOTAL - weights[i] / wsum);
        if (drift > worst) worst = drift;
    }
    // Weight-blind random foil: heavy nodes starved/flooded.
    const rndLoad = new Uint32Array(n);
    const rng = new Prng(SEEDS.foil);
    for (let i = 0; i < TOTAL; i++) rndLoad[rng.nextBelow(n)]++;
    let sedWImb = 0, rndWImb = 0;
    for (let i = 0; i < n; i++) {
        const target = weights[i] / wsum;
        sedWImb = Math.max(sedWImb, Math.abs(inflight[i] / TOTAL - target) / target);
        rndWImb = Math.max(rndWImb, Math.abs(rndLoad[i] / TOTAL - target) / target);
    }
    return {
        weights: Array.from(weights),
        total: TOTAL,
        worstShareDrift: worst,
        weightedImbalance: sedWImb,
        randomImbalance: rndWImb,
    };
}

/** Measure both; returns the structured result Report.mjs stamps + renders. */
export function measureFairness() {
    return { smoothwrr: measureSmoothWRR(), sed: measureSed() };
}

if (import.meta.url === 'file://' + process.argv[1]) {
    const r = measureFairness();
    const s = r.smoothwrr;
    process.stdout.write('lite-pick fairness (M6 dimension 8) -- weighted convergence + burstiness\n');
    process.stdout.write('  SmoothWRR weights [' + s.weights.join(',') + ']: exact fairness over ' +
        s.cycles + ' cycles = ' + s.exactFair + '\n');
    process.stdout.write('  SmoothWRR smoothness: max-run=' + s.smoothMaxRun +
        ' vs bursty foil max-run=' + s.burstyMaxRun + '\n');
    const d = r.sed;
    process.stdout.write('  SED weights [' + d.weights.join(',') + ']: worst share drift=' +
        d.worstShareDrift.toFixed(4) + ' (tracks weight)\n');
    process.stdout.write('  SED weighted-imbalance=' + d.weightedImbalance.toFixed(3) +
        ' vs weight-blind random=' + d.randomImbalance.toFixed(3) + '\n');

    const ok = s.exactFair && s.smoothMaxRun < s.burstyMaxRun &&
        d.worstShareDrift < 0.01 && d.weightedImbalance < d.randomImbalance / 2;
    process.stdout.write('  fairness (exact + smooth + weight-proportional) -> ' +
        (ok ? 'PASS' : 'FAIL') + '\n');
    if (!ok) { process.stderr.write('bench:fairness: FAIL\n'); process.exit(1); }
    process.stdout.write('bench:fairness: PASS\n');
}
