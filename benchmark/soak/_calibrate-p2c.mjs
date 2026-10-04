/**
 * @zakkster/lite-pick soak -- calibrate the P2C oracle's averaged threshold (audit 2026-09-29 S7;
 * research/s7-p2c-oracle-bound.md, option C, decided 2026-10-04).
 *
 *     node benchmark/soak/_calibrate-p2c.mjs [--cycles 100000] [--from 8] [--to 256] [--jobs 8]
 *          [--seed 0x5EED] [--out benchmark/soak/p2c-calibration.json] [--mutant 0|50|80]
 *
 * For every live count in [from, to] it runs `cycles` CLEAN oracle cycles of the real P2cBalancer at the
 * soak's shape (cap 256, a fresh random eligible subset of that size per cycle, membership changed with
 * setEligible exactly as the soak's chaos does) through the SAME p2cTrials() the oracle calls, and
 * records the exact distribution of the oracle statistic (the sum of the 8 trial gaps), the per-trial
 * gap, and the backstop / lost-pick counts. The threshold rule (research option C): limit(live) =
 * (largest clean sum seen at any live count <= this one) + 4, i.e. the healthy maximum of the AVERAGE
 * gap plus 0.5, made monotone in live because the healthy gap grows with n (log2 ln n). The emitted
 * table goes into oracles.mjs P2C_SUM_LIMIT; the JSON is the evidence.
 *
 * --mutant 50|80 measures POWER instead: the same cycles with P2C ignoring its comparison on 50% / 80%
 * of picks (returns the first draw -- the (1+beta)-choice process of Peres-Talwar-Wieder, beta = 0.5 /
 * 0.2), reporting the share of cycles the oracle (with a given table) would fail.
 *
 * Tooling, not a test: never run by npm test. Deterministic for a given seed/jobs split.
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { writeFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { P2cBalancer, Prng } from '../../Pick.js';
import { p2cTrials, _p2c, p2cTrialCap, P2C_TRIALS, P2C_MIN_LIVE } from './oracles.mjs';

const CAP = 256;
const SUM_BINS = 1024;    // sum-of-gaps histogram (clamped)
const MARGIN = 4;         // 0.5 on the AVERAGE of 8 gaps == 4 on their sum

function args() {
    const a = process.argv.slice(2), o = { cycles: 100000, from: P2C_MIN_LIVE, to: CAP, jobs: 8, seed: 0x5EED, out: null, mutant: 0, table: null };
    for (let i = 0; i < a.length; i += 2) {
        const k = a[i].replace(/^--/, ''), v = a[i + 1];
        if (!(k in o)) { process.stderr.write('unknown option --' + k + '\n'); process.exit(2); }
        o[k] = (k === 'out' || k === 'table') ? v : Number(v);
    }
    if (!(o.from >= P2C_MIN_LIVE && o.to <= CAP && o.from <= o.to && o.cycles >= 1 && o.jobs >= 1)) {
        process.stderr.write('bad range: from ' + o.from + ' to ' + o.to + ' cycles ' + o.cycles + ' jobs ' + o.jobs + '\n');
        process.exit(2);
    }
    if (!(o.mutant === 0 || o.mutant === 50 || o.mutant === 80)) { process.stderr.write('--mutant must be 0, 50 or 80\n'); process.exit(2); }
    return o;
}

// The mutant: P2C ignores the comparison on a share of picks and keeps the first draw (one random
// choice). Same distinct-second-draw loop as the kernel so the healthy share is identical.
function mutantPick(b, ignoreOf10) {
    const a = b._draw();
    if (a < 0) return -1;
    if (b._live === 1) return a;
    let c = b._draw();
    for (let t = 0; c === a && t < 32; t++) c = b._draw();
    if (c < 0 || c === a) return a;
    if (b._rng.nextBelow(10) < ignoreOf10) return a;
    return b._inflight[c] < b._inflight[a] ? c : a;
}

function runLive(live, cycles, seed, mutant, limit) {
    const el = new Uint8Array(CAP), inf = new Uint32Array(CAP);
    const b = new P2cBalancer(CAP, el, inf, (seed ^ Math.imul(live, 0x9E3779B1)) >>> 0);
    if (mutant) { const ig = mutant / 10; b.pick = function () { return mutantPick(this, ig); }; }
    const rng = new Prng((seed ^ Math.imul(live, 0x85EBCA6B) ^ 0xC0FFEE) >>> 0);
    const perm = new Int32Array(CAP);
    const sumHist = new Float64Array(SUM_BINS);
    let backstop = 0, lost = 0, maxSum = 0, failed = 0;
    for (let c = 0; c < cycles; c++) {
        for (let i = 0; i < CAP; i++) { perm[i] = i; b.setEligible(i, false); }
        for (let i = 0; i < live; i++) {                       // partial Fisher-Yates: a uniform subset
            const j = i + rng.nextBelow(CAP - i);
            const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
            b.setEligible(perm[i], true);
        }
        p2cTrials(b, el, inf, CAP, live);
        const s = _p2c[0];
        sumHist[s < SUM_BINS ? s : SUM_BINS - 1]++;
        if (s > maxSum) maxSum = s;
        if (_p2c[1] >= 2) backstop++;
        if (_p2c[2] > 0) lost++;
        if (limit >= 0 && (s > limit || _p2c[1] >= 2 || _p2c[2] > 0)) failed++;   // the oracle's exact rule
    }
    const hist = [];                                            // sparse [sum, cycles] pairs
    for (let i = 0; i < SUM_BINS; i++) if (sumHist[i] > 0) hist.push([i, sumHist[i]]);
    return { live, cycles, maxSum, sumHist: hist, backstop, lost, failed, trialCap: p2cTrialCap(live) };
}

if (!isMainThread) {
    const { lives, cycles, seed, mutant, limits } = workerData;
    for (const live of lives) parentPort.postMessage(runLive(live, cycles, seed, mutant, limits ? limits[live] : -1));
} else {
    const o = args();
    const lives = [];
    for (let n = o.from; n <= o.to; n++) lives.push(n);
    // Balance by cost (~ live picks per cycle): deal the largest live counts first to the lightest job.
    const jobs = Array.from({ length: Math.min(o.jobs, lives.length) }, () => ({ lives: [], cost: 0 }));
    for (const n of [...lives].sort((x, y) => y - x)) { jobs.sort((x, y) => x.cost - y.cost); jobs[0].lives.push(n); jobs[0].cost += n; }
    // --mutant: the oracle's limits come from a finished clean calibration (--table <json>).
    let limits = null;
    if (o.mutant !== 0) {
        if (!o.table) { process.stderr.write('--mutant needs --table <calibration json>\n'); process.exit(2); }
        const cal = JSON.parse(readFileSync(o.table, 'utf8'));
        limits = new Array(CAP + 1).fill(-1);
        for (let n = P2C_MIN_LIVE; n <= CAP; n++) for (const [at, v] of cal.breakpoints) if (n >= at) limits[n] = v;
    }
    const t0 = Date.now(), results = new Map();
    await Promise.all(jobs.map((j) => new Promise((resolve, reject) => {
        const w = new Worker(new URL(import.meta.url), { workerData: { lives: j.lives, cycles: o.cycles, seed: o.seed, mutant: o.mutant, limits } });
        w.on('message', (r) => {
            results.set(r.live, r);
            process.stderr.write('live ' + r.live + ' maxSum ' + r.maxSum + ' backstop ' + r.backstop + ' lost ' + r.lost + ' (' + results.size + '/' + lives.length + ', ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)\n');
        });
        w.on('error', reject);
        w.on('exit', (code) => code === 0 ? resolve() : reject(new Error('worker exit ' + code)));
    })));
    const rows = lives.map((n) => results.get(n));
    let sha = 'unknown';
    try { sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
    const meta = { tool: 'benchmark/soak/_calibrate-p2c.mjs', node: process.version, gitSha: sha, cap: CAP, trials: P2C_TRIALS,
        cycles: o.cycles, seed: o.seed, jobs: o.jobs, mutant: o.mutant, seconds: Math.round((Date.now() - t0) / 1000), date: new Date().toISOString() };
    if (o.mutant === 0) {
        // limit(live) = monotone running max of the clean maxima, + MARGIN.
        let run = 0;
        const limit = rows.map((r) => { if (r.maxSum > run) run = r.maxSum; return run + MARGIN; });
        const breaks = [];
        for (let i = 0; i < rows.length; i++) if (i === 0 || limit[i] !== limit[i - 1]) breaks.push([rows[i].live, limit[i]]);
        const totalBackstop = rows.reduce((s, r) => s + r.backstop, 0), totalLost = rows.reduce((s, r) => s + r.lost, 0);
        process.stdout.write('P2C_SUM_LIMIT breakpoints [live, limit] (' + o.cycles + ' clean cycles per live count; backstop fired ' +
            totalBackstop + ', lost picks ' + totalLost + '):\n' + JSON.stringify(breaks) + '\n');
        if (o.out) writeFileSync(o.out, JSON.stringify({ meta, margin: MARGIN, breakpoints: breaks, rows }) + '\n');
    } else {
        // Power: share of mutant cycles the oracle FAILS (sum over limit OR backstop OR lost pick).
        const power = rows.map((r) => [r.live, +(r.failed / r.cycles).toFixed(4)]);
        process.stdout.write('mutant ' + o.mutant + '% ignore -- [live, share of cycles failed]:\n' + JSON.stringify(power) + '\n');
        if (o.out) writeFileSync(o.out, JSON.stringify({ meta, power, rows }) + '\n');
    }
}
