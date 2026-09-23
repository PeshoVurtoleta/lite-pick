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

import { SmoothWRRBalancer, SedBalancer, PeakEwmaBalancer, P2cBalancer, Prng } from '../Pick.js';
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

/**
 * PeakEWMA latency-steering: a closed-loop single-server-per-node queue with ONE slow node (10x
 * service time). Reports the slow node's share of traffic under PeakEWMA (latency-aware), P2C
 * (in-flight-aware) and a random foil, plus each lane's service p99 -- the same anchor gate as
 * test/balance.mjs, surfaced here as the strategy's fairness-under-latency dimension.
 */
function measurePeakEwmaSteering() {
    const n = 16, REQ = 100000, DT = 150, BASE = 1000, SLOW = 0, TAU = 1e9;
    const runLane = (kind) => {
        const el = new Uint8Array(n); el.fill(1);
        const inflight = new Uint32Array(n);
        const busyUntil = new Float64Array(n);
        const serviceNs = new Float64Array(n);
        for (let j = 0; j < n; j++) serviceNs[j] = BASE;
        serviceNs[SLOW] = 10 * BASE;
        let pe = null, p2c = null, rng = null;
        if (kind === 'peakewma') pe = new PeakEwmaBalancer(n, el, inflight, TAU, SEEDS.p2c);
        else if (kind === 'p2c') p2c = new P2cBalancer(n, el, inflight, SEEDS.p2c);
        else rng = new Prng(SEEDS.p2c);
        const counts = new Uint32Array(n);
        const lat = new Float64Array(REQ);
        for (let r = 0; r < REQ; r++) {
            const t = r * DT;
            for (let j = 0; j < n; j++) {
                const rem = busyUntil[j] - t;
                inflight[j] = rem > 0 ? Math.ceil(rem / serviceNs[j]) : 0;
            }
            const i = pe ? pe.pick(t) : p2c ? p2c.pick() : rng.nextBelow(n);
            const start = busyUntil[i] > t ? busyUntil[i] : t;
            busyUntil[i] = start + serviceNs[i];
            lat[r] = busyUntil[i] - t;
            counts[i]++;
            if (pe) pe.recordRtt(i, lat[r], t);
        }
        lat.sort();
        return { slowShare: counts[SLOW] / REQ, p99: lat[Math.floor(0.99 * REQ)] };
    };
    return { n, slowNode: SLOW, peakewma: runLane('peakewma'), p2c: runLane('p2c'), random: runLane('random') };
}

/** Measure all; returns the structured result Report.mjs stamps + renders. */
export function measureFairness() {
    return { smoothwrr: measureSmoothWRR(), sed: measureSed(), peakewma: measurePeakEwmaSteering() };
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

    const pe = r.peakewma;
    process.stdout.write('  PeakEWMA slow-node (node ' + pe.slowNode + ', 10x rtt) share: PeakEWMA=' +
        (pe.peakewma.slowShare * 100).toFixed(3) + '%  P2C=' + (pe.p2c.slowShare * 100).toFixed(3) +
        '%  random=' + (pe.random.slowShare * 100).toFixed(3) + '%\n');
    process.stdout.write('  PeakEWMA service p99 (ns): PeakEWMA=' + pe.peakewma.p99.toFixed(0) +
        '  P2C=' + pe.p2c.p99.toFixed(0) + '  random=' + pe.random.p99.toFixed(0) + '\n');

    const peOk = pe.peakewma.slowShare <= 0.25 * pe.p2c.slowShare &&
        pe.peakewma.p99 <= 0.8 * pe.p2c.p99 &&
        pe.random.p99 > pe.peakewma.p99 && pe.random.p99 > pe.p2c.p99;
    const ok = s.exactFair && s.smoothMaxRun < s.burstyMaxRun &&
        d.worstShareDrift < 0.01 && d.weightedImbalance < d.randomImbalance / 2 && peOk;
    process.stdout.write('  fairness (exact + smooth + weight-proportional + latency-steering) -> ' +
        (ok ? 'PASS' : 'FAIL') + '\n');
    if (!ok) { process.stderr.write('bench:fairness: FAIL\n'); process.exit(1); }
    process.stdout.write('bench:fairness: PASS\n');
}
