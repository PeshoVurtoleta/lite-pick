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

import { RoundRobinBalancer, SmoothWRRBalancer, P2cBalancer, LeastConnBalancer, SedBalancer, NqBalancer, PeakEwmaBalancer, Prng } from '../Pick.js';

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

// --- LeastConn: EXACT fewest-in-flight -- perfect greedy balance ------------
// The exact complement to P2C's approximation. In a closed feedback loop (increment on
// dispatch) exact least-connections is greedy-optimal: max-minus-min load stays within 1 --
// TIGHTER than P2C's ln ln n gap. We assert the perfection AND that LeastConn's peak is <=
// P2C's peak on the same balls-into-bins run (exact beats approximate).
process.stdout.write('lite-pick balance (M4: LeastConn -- exact, perfect greedy)\n');
{
    const k = 32;
    for (const n of [64, 1024, 4096]) {
        const picks = k * n;

        const lcLoad = new Uint32Array(n);
        const lc = new LeastConnBalancer(n, (() => { const e = new Uint8Array(n); e.fill(1); return e; })(), lcLoad);
        for (let i = 0; i < picks; i++) lcLoad[lc.pick()]++;

        const p2cLoad = new Uint32Array(n);
        const p2c = new P2cBalancer(n, (() => { const e = new Uint8Array(n); e.fill(1); return e; })(), p2cLoad, 0xABCDEF);
        for (let i = 0; i < picks; i++) p2cLoad[p2c.pick()]++;

        let lcMax = 0, lcMin = Infinity, p2cMax = 0;
        for (let i = 0; i < n; i++) {
            if (lcLoad[i] > lcMax) lcMax = lcLoad[i];
            if (lcLoad[i] < lcMin) lcMin = lcLoad[i];
            if (p2cLoad[i] > p2cMax) p2cMax = p2cLoad[i];
        }
        process.stdout.write('  n=' + String(n).padStart(4) +
            '  LeastConn peak/avg=' + (lcMax / k).toFixed(2) + ' (max-min=' + (lcMax - lcMin) + ')' +
            '  P2C peak/avg=' + (p2cMax / k).toFixed(2) + '\n');
        check(lcMax - lcMin <= 1, 'n=' + n + ': LeastConn perfect greedy balance (max-min=' + (lcMax - lcMin) + ')');
        check(lcMax <= p2cMax, 'n=' + n + ': LeastConn peak ' + lcMax + ' <= P2C peak ' + p2cMax + ' (exact beats approximate)');
    }
}

// --- SED: weighted least-conn -- load converges proportional to weight ------
// SED minimizes (inflight+1)/weight, so in a feedback loop each node's share tracks its
// weight fraction. We assert every node's observed share is within a tight band of its
// weight target, and that SED's weighted imbalance crushes a random foil's.
process.stdout.write('lite-pick balance (M4: SED -- weighted fairness)\n');
{
    const weights = Uint32Array.from([1, 2, 3, 4, 6, 8, 12, 16]); // sum 52, skewed
    let wsum = 0; for (const w of weights) wsum += w;
    const n = weights.length;
    const el = new Uint8Array(n); el.fill(1);
    const inflight = new Uint32Array(n);
    const sed = new SedBalancer(n, el, inflight, weights);
    const TOTAL = 200000;
    for (let i = 0; i < TOTAL; i++) inflight[sed.pick()]++;

    let worst = 0;
    for (let i = 0; i < n; i++) {
        const share = inflight[i] / TOTAL, target = weights[i] / wsum;
        const drift = Math.abs(share - target);
        if (drift > worst) worst = drift;
    }
    // Random foil: draw uniformly (weight-blind) -- its heaviest node is starved/flooded.
    const rndLoad = new Uint32Array(n);
    const rng = new Prng(0xABCDEF);
    for (let i = 0; i < TOTAL; i++) rndLoad[rng.nextBelow(n)]++;
    let sedWImb = 0, rndWImb = 0; // max over nodes of |share - target| / target
    for (let i = 0; i < n; i++) {
        const target = weights[i] / wsum;
        sedWImb = Math.max(sedWImb, Math.abs(inflight[i] / TOTAL - target) / target);
        rndWImb = Math.max(rndWImb, Math.abs(rndLoad[i] / TOTAL - target) / target);
    }
    process.stdout.write('  worst share drift=' + worst.toFixed(4) +
        '  SED weighted-imbalance=' + sedWImb.toFixed(3) + '  random=' + rndWImb.toFixed(3) + '\n');
    check(worst < 0.01, 'SED load tracks weight within 1% (worst drift ' + worst.toFixed(4) + ')');
    check(sedWImb < rndWImb / 2, 'SED weighted-imbalance ' + sedWImb.toFixed(3) + ' far below random ' + rndWImb.toFixed(3));
}

// --- NQ: never-queue -- idle-first fan-out before any queueing --------------
// NQ's defining property: it never queues while a server is idle. On a fresh pool of n
// idle workers, the first n dispatches must hit n DISTINCT workers (no double-up), and it
// reduces to SED once all are busy. The exact-min correctness is proven by the fuzzer;
// here we anchor the observable worker-pool fan-out.
process.stdout.write('lite-pick balance (M4: NQ -- idle-first fan-out)\n');
{
    const n = 32;
    const el = new Uint8Array(n); el.fill(1);
    const inflight = new Uint32Array(n);
    const weights = new Uint32Array(n).fill(1);
    const nq = new NqBalancer(n, el, inflight, weights);
    const seen = new Uint8Array(n);
    let distinct = 0;
    for (let i = 0; i < n; i++) { const p = nq.pick(); if (!seen[p]) { seen[p] = 1; distinct++; } inflight[p]++; }
    check(distinct === n, 'NQ first ' + n + ' dispatches hit ' + distinct + '/' + n + ' distinct idle workers');
    // Now all busy (inflight 1): NQ falls back to SED -> next pick is a least-loaded node.
    const before = inflight.slice();
    const p = nq.pick();
    let minLoad = Infinity; for (let i = 0; i < n; i++) if (before[i] < minLoad) minLoad = before[i];
    check(before[p] === minLoad, 'NQ SED-fallback picks a least-loaded node once none are idle');
}

// --- PeakEWMA: THE latency anchor -- steer around a slow-but-up node -----------
// The differentiator vs P2C-over-inflight: PeakEWMA REMEMBERS a node's latency (EWMA), so it
// avoids a slow node even while that node is idle (inflight 0) and therefore looks attractive to
// a pure in-flight strategy. We run the SAME closed-loop single-server-per-node queue simulation
// through three lanes -- PeakEWMA (latency-aware), P2C (in-flight-aware), random (blind) -- with
// ONE node at 10x service time, and assert: PeakEWMA sends the slow node <= 25% of P2C's share
// for it, PeakEWMA's service p99 is >= 20% below P2C's, and the random foil is worse than both.
process.stdout.write('lite-pick balance (M7: PeakEWMA -- latency anchor)\n');
{
    const n = 16;
    const REQ = 100000;
    const DT = 150;            // arrival interval (ns): moderate load on the fast pool
    const BASE = 1000;         // fast-node service time (ns)
    const SLOW = 0;            // the slow endpoint
    const seed = 0xABCDEF;
    // tau >> total run duration (REQ*DT ~ 1.5e7 ns), so a learned latency persists across the run.
    const TAU = 1e9;

    function runLane(kind) {
        const el = new Uint8Array(n); el.fill(1);
        const inflight = new Uint32Array(n);      // backlog depth, recomputed each arrival
        const busyUntil = new Float64Array(n);    // when each single-server node is next free
        const serviceNs = new Float64Array(n);
        for (let j = 0; j < n; j++) serviceNs[j] = BASE;
        serviceNs[SLOW] = 10 * BASE;              // the slow-but-up node

        let pe = null, p2c = null, rng = null;
        if (kind === 'peakewma') pe = new PeakEwmaBalancer(n, el, inflight, TAU, seed);
        else if (kind === 'p2c') p2c = new P2cBalancer(n, el, inflight, seed);
        else rng = new Prng(seed);

        const counts = new Uint32Array(n);
        const lat = new Float64Array(REQ);
        for (let r = 0; r < REQ; r++) {
            const t = r * DT;
            // Backlog-derived in-flight (FIFO single server): the depth the strategy reads.
            for (let j = 0; j < n; j++) {
                const rem = busyUntil[j] - t;
                inflight[j] = rem > 0 ? Math.ceil(rem / serviceNs[j]) : 0;
            }
            let i;
            if (pe) i = pe.pick(t);
            else if (p2c) i = p2c.pick();
            else i = rng.nextBelow(n);
            const start = busyUntil[i] > t ? busyUntil[i] : t;
            const finish = start + serviceNs[i];
            busyUntil[i] = finish;
            const latency = finish - t;
            lat[r] = latency;
            counts[i]++;
            if (pe) pe.recordRtt(i, latency, t);   // warm feedback on settle
        }
        lat.sort();
        return { share: counts[SLOW] / REQ, p99: lat[Math.floor(0.99 * REQ)] };
    }

    const pe = runLane('peakewma');
    const p2c = runLane('p2c');
    const rnd = runLane('random');

    process.stdout.write('  slow-node share: PeakEWMA=' + (pe.share * 100).toFixed(3) + '%' +
        '  P2C=' + (p2c.share * 100).toFixed(3) + '%  random=' + (rnd.share * 100).toFixed(3) + '%\n');
    process.stdout.write('  service p99 (ns): PeakEWMA=' + pe.p99.toFixed(0) +
        '  P2C=' + p2c.p99.toFixed(0) + '  random=' + rnd.p99.toFixed(0) + '\n');

    check(pe.share <= 0.25 * p2c.share,
        'PeakEWMA slow-node share ' + (pe.share * 100).toFixed(3) + '% <= 25% of P2C ' +
        (p2c.share * 100).toFixed(3) + '% (i.e. <= ' + (0.25 * p2c.share * 100).toFixed(3) + '%)');
    check(pe.p99 <= 0.8 * p2c.p99,
        'PeakEWMA service p99 ' + pe.p99.toFixed(0) + 'ns >= 20% below P2C ' + p2c.p99.toFixed(0) + 'ns');
    check(rnd.p99 > pe.p99 && rnd.p99 > p2c.p99,
        'random foil p99 ' + rnd.p99.toFixed(0) + 'ns is worse than both PeakEWMA and P2C');
}

if (failed) {
    process.stderr.write('balance: FAIL\n');
    process.exit(1);
}
process.stdout.write('balance: PASS\n');
