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

import { RoundRobinBalancer, Prng } from '../Pick.js';

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

// --- Context: the random-foil peak/avg baseline P2C must beat at M3 --------
{
    const rng = new Prng(0xfeedface);
    for (const n of [64, 512, 4096]) {
        const bins = new Uint32Array(n);
        for (let i = 0; i < n; i++) bins[rng.nextBelow(n)]++;
        let max = 0; for (let i = 0; i < n; i++) if (bins[i] > max) max = bins[i];
        process.stdout.write('  ctx  n=' + String(n).padStart(4) +
            ' random peak/avg = ' + max.toFixed(2) + ' (P2C target ~ ln ln n / ln 2 at M3)\n');
    }
}

if (failed) {
    process.stderr.write('balance: FAIL\n');
    process.exit(1);
}
process.stdout.write('balance: PASS\n');
