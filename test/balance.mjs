/**
 * @zakkster/lite-pick -- balance-quality gate (THE anchor).
 *
 *     node test/balance.mjs
 *
 * The differentiating benchmark: measured peak-to-average load, asserted within the
 * strategy's ceiling and better than the foil where the strategy claims to be.
 *
 * M1 RoundRobin has two claims, and this gate proves both:
 *   1. FAIRNESS: on an all-up uniform pool, RR is PERFECT -- every node's load is within
 *      1 of the mean (imbalance ~ 1.0), the theoretical best any balancer can do.
 *   2. CORRECTNESS over the naive foil: the `i++ % n` foil ignores eligibility and returns
 *      DOWN nodes ("dead picks"); RR never does. Under partial eligibility RR still
 *      distributes perfectly among the LIVE set with ZERO dead picks. That is RR's win --
 *      not raw throughput (where the trivial foil ties it), but never routing to a dead node.
 *
 * The random-foil peak/avg baseline (what P2C must beat at M3) is printed for context.
 */

import { RoundRobinBalancer, SmoothWRRBalancer, P2cBalancer, Prng } from '../Pick.js';

let failed = false;
function check(cond, msg) {
    process.stdout.write((cond ? '  ok   ' : '  FAIL ') + msg + '\n');
    if (!cond) failed = true;
}

process.stdout.write('lite-pick balance (M1: RoundRobin)\n');

// --- Claim 1: perfect fairness on an all-up uniform pool -------------------
for (const n of [64, 512, 4096]) {
    const el = new Uint8Array(n); el.fill(1);
    const rr = new RoundRobinBalancer(n, el);
    const counts = new Uint32Array(n);
    const PICKS = n * 1000;
    for (let i = 0; i < PICKS; i++) counts[rr.pick()]++;
    let max = 0, min = Infinity;
    for (let i = 0; i < n; i++) { if (counts[i] > max) max = counts[i]; if (counts[i] < min) min = counts[i]; }
    const mean = PICKS / n;
    const imbalance = max / mean;
    check(max - min <= 1 && imbalance <= 1.0001,
        'n=' + String(n).padStart(4) + ' all-up: imbalance=' + imbalance.toFixed(4) +
        ' (max-min=' + (max - min) + ', perfect)');
}

// --- Claim 2: zero dead picks under partial eligibility, vs the foil -------
{
    const n = 512;
    const el = new Uint8Array(n);
    const rng = new Prng(0x1234abcd);
    let live = 0;
    for (let i = 0; i < n; i++) { const up = rng.nextBelow(10) >= 3; el[i] = up ? 1 : 0; if (up) live++; } // ~70% up
    const rr = new RoundRobinBalancer(n, el);
    const PICKS = 200000;

    // RoundRobin: count dead picks + imbalance over the live set.
    const counts = new Uint32Array(n);
    let rrDead = 0;
    for (let i = 0; i < PICKS; i++) { const p = rr.pick(); if (el[p]) counts[p]++; else rrDead++; }
    let max = 0, min = Infinity;
    for (let i = 0; i < n; i++) if (el[i]) { if (counts[i] > max) max = counts[i]; if (counts[i] < min) min = counts[i]; }
    const liveImbalance = max / (PICKS / live);

    // Foil: i++ % n, eligibility-blind -> dead picks whenever the index is down.
    let foilDead = 0;
    for (let i = 0; i < PICKS; i++) { const p = i % n; if (!el[p]) foilDead++; }

    check(rrDead === 0, 'partial (' + live + '/' + n + ' up): RoundRobin dead picks = ' + rrDead);
    check(max - min <= 1, 'partial: RoundRobin imbalance over live set = ' + liveImbalance.toFixed(4) + ' (perfect)');
    check(foilDead > 0, 'partial: `i++ % n` foil dead picks = ' + foilDead + ' (the trap RR avoids)');
}

// --- SmoothWRR: exact weighted fairness + smoothness vs the bursty foil ----
process.stdout.write('lite-pick balance (M2: SmoothWRR)\n');
{
    const maxRun = (seq) => {
        let best = 0, run = 0, prev = -2;
        for (const x of seq) { run = x === prev ? run + 1 : 1; prev = x; if (run > best) best = run; }
        return best;
    };
    const weights = Uint32Array.from([10, 3, 2, 1]); // total 16, skewed
    const total = 16;
    const n = weights.length;
    const el = new Uint8Array(n); el.fill(1);
    const wrr = new SmoothWRRBalancer(n, el, weights);

    const k = 500;
    const counts = new Uint32Array(n);
    const seq = [];
    for (let i = 0; i < k * total; i++) { const p = wrr.pick(); counts[p]++; seq.push(p); }

    // Fairness: exact convergence to k * weight[i].
    let fair = true;
    for (let i = 0; i < n; i++) if (counts[i] !== k * weights[i]) fair = false;
    check(fair, 'weights [10,3,2,1]: exact fairness over ' + k + ' cycles (counts = k*weight)');

    // Smoothness: max run far below the bursty weight-expansion foil (which clumps 10).
    const list = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < weights[i]; j++) list.push(i);
    const bursty = [];
    for (let p = 0; p < seq.length; p++) bursty.push(list[p % list.length]);
    const sRun = maxRun(seq), bRun = maxRun(bursty);
    check(sRun < bRun, 'smoothness: SmoothWRR max-run=' + sRun + ' < bursty foil max-run=' + bRun);
}

// --- P2C: THE anchor -- the ln ln n peak-load ceiling vs a random foil -----
// The canonical balls-into-bins experiment: throw m = k*n balls into n bins. P2C's peak
// load stays within an ADDITIVE ln ln n / ln 2 gap of the mean (Azar-Broder-Karlin-Upfal);
// a random single draw's gap grows like sqrt(k ln n) -- far larger. We assert P2C's gap is
// (a) dramatically below random's, and (b) a small constant consistent with ln ln n / ln 2.
process.stdout.write('lite-pick balance (M3: P2C -- THE anchor)\n');
{
    const k = 32; // balls per bin (mean load)
    for (const n of [64, 1024, 4096]) {
        const el = new Uint8Array(n); el.fill(1);
        const picks = k * n;

        // P2C: each pick increments the chosen bin's in-flight; pick() reads it back.
        const p2cLoad = new Uint32Array(n);
        const p2c = new P2cBalancer(n, el, p2cLoad, 0xABCDEF);
        for (let i = 0; i < picks; i++) p2cLoad[p2c.pick()]++;

        // Random single-draw foil.
        const rndLoad = new Uint32Array(n);
        const rng = new Prng(0xABCDEF);
        for (let i = 0; i < picks; i++) rndLoad[rng.nextBelow(n)]++;

        let p2cMax = 0, rndMax = 0;
        for (let i = 0; i < n; i++) { if (p2cLoad[i] > p2cMax) p2cMax = p2cLoad[i]; if (rndLoad[i] > rndMax) rndMax = rndLoad[i]; }
        const p2cGap = p2cMax - k, rndGap = rndMax - k;
        const ceiling = Math.log(Math.log(n)) / Math.LN2; // ln ln n / ln 2 (~2.8 at n=1024)

        process.stdout.write('  n=' + String(n).padStart(4) +
            '  P2C peak/avg=' + (p2cMax / k).toFixed(2) + ' (gap ' + p2cGap + ')' +
            '  random peak/avg=' + (rndMax / k).toFixed(2) + ' (gap ' + rndGap + ')' +
            '  ceiling~' + ceiling.toFixed(1) + '\n');

        check(p2cGap < rndGap / 2,
            'n=' + n + ': P2C gap ' + p2cGap + ' is far below random gap ' + rndGap);
        check(p2cGap <= 4 * ceiling + 4,
            'n=' + n + ': P2C gap ' + p2cGap + ' within the ln ln n ceiling band (<= ' +
            (4 * ceiling + 4).toFixed(1) + ')');
    }
}

if (failed) {
    process.stderr.write('balance: FAIL\n');
    process.exit(1);
}
process.stdout.write('balance: PASS\n');
