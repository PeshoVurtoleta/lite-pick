/**
 * @zakkster/lite-pick -- release-time soak A/B (#8b) behaviour suite.
 *
 *     node --test test/SoakAB.test.js
 *
 * Three sections:
 *   (1) ZERO-DEP: the pure analyser (benchmark/soak/ab-analyse.mjs, which imports gates.mjs ONLY) and
 *       the exact statistics the A/B gate is built on. No devDependency, no install, no clock, no I/O --
 *       it runs on the Node 18 job with an empty node_modules. Every number is ABSOLUTE (the research's
 *       hand-computed values), checked to 1e-9 where fractional.
 *   (2) HARNESS: the SOAK_TIERS / SOAK_HOTOPS_N knobs, driven through the REAL main.mjs. These need the
 *       three soak devDependencies; on Node < 20 with no install they skip (the SoakReport.test.js
 *       convention), and FAIL anywhere else a devDependency is missing.
 *   (3) RUNNER + CI: the SoakAB.mjs CLI fail-closed cases, the workflow pins, the teeth anchors (`git show`:
 *       needs full history, ci.yml checks out with fetch-depth 0), and the packers run from a temp cwd with
 *       relative paths (npm pack; the registry test skips only when the registry is unreachable).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    T, R, ALPHA, FAMILY, KERNEL_LANES,
    hlShift, ciIndex, shiftBounds, holm, balancedOrder, detrendedCv, cv,
    decide, validateAcceptance, checkProcesses, analyse,
} from '../benchmark/soak/ab-analyse.mjs';
import { mwOneSidedP } from '../benchmark/soak/gates.mjs';

const EPS = 1e-9;
const near = (a, b, eps = EPS) => assert.ok(Math.abs(a - b) <= eps, a + ' != ' + b + ' (|d|=' + Math.abs(a - b) + ')');

// ===================================================================================================
// (1) ZERO-DEP: the exact statistics
// ===================================================================================================

test('constants are the recorded release values (T, R, ALPHA, FAMILY)', () => {
    assert.equal(T, 0.05);
    assert.equal(R, 0.15);
    assert.equal(ALPHA, 0.05);
    assert.equal(FAMILY, 20);
});

test('complete separation is the smallest one-sided MW p and cannot FAIL below K=6', () => {
    // All B slower than all A -> complete separation -> p = 1 / C(2K, K).
    const sep = (K) => mwOneSidedP(ones(K, 1), K, ones(K, 0.5), K, -1);
    near(sep(8), 1 / 12870);                 // 7.770e-5
    near(sep(10), 1 / 184756);               // 5.4125e-6
    const p5 = sep(5);
    near(p5, 1 / 252);                       // 0.003968...
    // K=5 Holm first step over 20: 1/252 * 20 = 0.0794 > ALPHA -> NEVER FAIL, whatever the effect size.
    const pHolm5 = p5 * FAMILY;
    near(pHolm5, 0.07936507936507936);
    assert.equal(decide({ s: 0.5, sU: 0.5, sL: 0.5, pHolm: pHolm5 }), 'INCONCLUSIVE');   // not FAIL
});

test('ciIndex matches the exact Hodges-Lehmann confidence index', () => {
    assert.equal(ciIndex(8, 8, 0.05), 16);
    assert.equal(ciIndex(10, 10, 0.05), 28);
});

test('Holm step-down adjusts in input order and is never weaker than Bonferroni', () => {
    const p = [0.01, 0.04, 0.03, 0.005];
    const adj = holm(p);
    const want = [0.03, 0.06, 0.06, 0.02];
    for (let i = 0; i < 4; i++) near(adj[i], want[i], 1e-12);
    // Bonferroni control (each * 4): Holm is <= it elementwise.
    const bonf = p.map((x) => x * 4);
    for (let i = 0; i < 4; i++) assert.ok(adj[i] <= bonf[i] + 1e-12, 'Holm <= Bonferroni at ' + i);
    assert.deepEqual(bonf.map((x) => +x.toFixed(4)), [0.04, 0.16, 0.12, 0.02]);
});

test('Hodges-Lehmann shift + confidence bounds on the research A/B vectors (exact to 1e-9)', () => {
    const A = [], B = [];
    for (let i = 0; i < 10; i++) A.push(1 + 1e-4 * i);
    for (let j = 0; j < 10; j++) B.push(0.80 + 0.02 * j);
    const sb = shiftBounds(A, B);
    near(sb.s, 0.110404636);
    near(sb.sU, 0.160167966);
    near(sb.sL, 0.060657540);
    near(hlShift(A, B), 0.110404636);
    // Complete separation (every B < every A) -> FAIL under the default rule.
    const p = mwOneSidedP(A, 10, B, 10, -1);
    near(p, 1 / 184756);
    const pHolm = p * FAMILY;
    assert.equal(decide({ s: sb.s, sU: sb.sU, sL: sb.sL, pHolm }), 'FAIL');
    // A wrong order-statistic index (27+2 = 29, 0-based) does NOT reproduce sU -- the C=28 index is load-bearing.
    const r = pairwise(A, B);
    assert.ok(Math.abs((1 - r[29]) - sb.sU) > 1e-6, 'index 29 must differ from the C=28 bound');
});

test('decide: boundaries are strict (s=T not FAIL, sU=R not PASS)', () => {
    assert.equal(decide({ s: 0.05, sU: 0.10, sL: 0.0, pHolm: 1e-6 }), 'PASS');          // s == T -> not FAIL
    assert.equal(decide({ s: 0.20, sU: 0.15, sL: 0.0, pHolm: 0.9 }), 'INCONCLUSIVE');   // sU == R -> not PASS
    assert.equal(decide({ s: 0.20, sU: 0.10, sL: 0.0, pHolm: 1e-6 }), 'FAIL');          // sig AND material
});

test('acceptance: matching version admits the bound (ACCEPTED); a mismatch is ignored (FAIL)', () => {
    const reason = 'LeastConn tie rotation traded 5-8 percent for fairness, see ADR 0014';
    assert.ok(reason.length >= 20);
    const entry = { lane: 'SmoothWRR', metric: 'hotOpsDense', maxSlowdown: 0.12, reason };
    const accept = { schema: 1, version: '1.1.1', entries: [entry] };
    const stat = { s: 0.110404636, sU: 0.160167966, sL: 0.060657540, pHolm: 1e-6 };

    const okv = validateAcceptance(accept, '1.1.1');
    assert.equal(okv.ok, true);
    assert.equal(okv.errors.length, 0);
    const key = 'SmoothWRR\u0000hotOpsDense';
    near(okv.map[key], 0.12);
    assert.equal(decide(stat, okv.map[key]), 'ACCEPTED');

    // version 1.1.0 for a 1.1.1 candidate -> entries IGNORED + a NOTE (stricter), so the default rule FAILs.
    const stale = validateAcceptance({ schema: 1, version: '1.1.0', entries: [entry] }, '1.1.1');
    assert.equal(stale.ok, true);
    assert.equal(Object.keys(stale.map).length, 0);
    assert.equal(stale.notes.length, 1);
    assert.match(stale.notes[0], /version 1\.1\.0 != candidate 1\.1\.1/);
    assert.equal(decide(stat, null), 'FAIL');
});

test('acceptance: fail-closed on every malformed shape (exit-2 class)', () => {
    const base = (over) => Object.assign({ schema: 1, version: '1.1.1', entries: [] }, over);
    const r = (a) => validateAcceptance(a, '1.1.1');
    assert.equal(r(null).ok, true);                                             // missing file = none
    assert.equal(r(base({ bogus: 1 })).ok, false);                              // unknown top key
    assert.match(r({ schemaa: 1, version: '1.1.1', entries: [] }).errors.join(' '), /did you mean schema/);
    assert.equal(r(base({ schema: 2 })).ok, false);                             // wrong schema
    const good = { lane: 'P2C', metric: 'hotOpsSparse', maxSlowdown: 0.1, reason: 'x'.repeat(20) };
    assert.equal(r(base({ entries: [good] })).ok, true);
    assert.equal(r(base({ entries: [Object.assign({}, good, { metric: 'latencyP99' })] })).ok, false);   // bad metric
    assert.equal(r(base({ entries: [Object.assign({}, good, { maxSlowdown: 0.05 })] })).ok, false);      // == T, not > T
    assert.equal(r(base({ entries: [Object.assign({}, good, { maxSlowdown: 0.6 })] })).ok, false);       // > 0.5
    assert.equal(r(base({ entries: [Object.assign({}, good, { reason: 'too short' })] })).ok, false);    // < 20 chars
    assert.equal(r(base({ entries: [Object.assign({}, good, { reason: 'x'.repeat(19) + String.fromCharCode(0xe9) })] })).ok, false);  // non-ASCII reason
    assert.match(r(base({ entries: [Object.assign({}, good, { reasonn: 'x'.repeat(20) })] })).errors.join(' '), /did you mean reason/);
    assert.equal(r(base({ entries: [good, good] })).ok, false);                 // duplicate lane+metric
    // An acceptance for a lane that is NOT one of the ten kernel lanes is an ERROR (never a silently
    // ignored bound): 'SmothWRR' must fail closed with a did-you-mean, not validate ok and vanish.
    const typo = r(base({ entries: [Object.assign({}, good, { lane: 'SmothWRR' })] }));
    assert.equal(typo.ok, false, "an unknown acceptance lane must fail closed");
    assert.match(typo.errors.join(' '), /unknown lane 'SmothWRR'.*did you mean SmoothWRR\?/);
    // a known kernel lane still validates.
    assert.equal(r(base({ entries: [Object.assign({}, good, { lane: 'SmoothWRR' })] })).ok, true);
});

test('balancedOrder: exactly ceil(K/2) AB for every seed, positions shuffled', () => {
    for (let seed = 0; seed < 1000; seed++) {
        const o = balancedOrder(10, seed);
        assert.equal(o.length, 10);
        assert.equal(o.filter((x) => x === 'AB').length, 5);
        assert.equal(o.filter((x) => x === 'BA').length, 5);
    }
    // odd K: ceil(7/2) = 4 AB, 3 BA.
    const odd = balancedOrder(7, 123);
    assert.equal(odd.filter((x) => x === 'AB').length, 4);
    assert.equal(odd.filter((x) => x === 'BA').length, 3);
    // the shuffle actually moves things (not all seeds give the same order).
    const shapes = new Set();
    for (let s = 0; s < 50; s++) shapes.add(balancedOrder(10, s).join(''));
    assert.ok(shapes.size > 1, 'the order must depend on the seed');
});

test('report-only noise stats: detrended CV removes a straight-line drift', () => {
    const flat = [100, 100, 100, 100];
    near(cv(flat), 0);
    near(detrendedCv(flat), 0);
    // a pure linear ramp has nonzero CV but ~zero detrended CV.
    const ramp = [100, 90, 80, 70, 60];
    assert.ok(cv(ramp) > 0.1);
    assert.ok(detrendedCv(ramp) < 1e-9);
});

test('checkProcesses: a baseline (A) that is not PASS is INCONCLUSIVE, not FAIL', () => {
    const header = mkHeader();
    const manifest = mkManifest();
    const procs = [
        { side: 'A', role: 'round', exit: 1, verdict: 'FAIL', header },
        { side: 'B', role: 'round', exit: 0, verdict: 'PASS', header: mkHeader('B') },
    ];
    const r = checkProcesses(manifest, procs);
    assert.ok(r.inconclusive.some((x) => /baseline \(A\) process not PASS/.test(x)));
    assert.equal(r.fail.length, 0);
});

test('checkProcesses: a B process that FAILs its own soak is a FAIL', () => {
    const header = mkHeader();
    const procs = [
        { side: 'A', role: 'round', exit: 0, verdict: 'PASS', header },
        { side: 'B', role: 'round', exit: 1, verdict: 'FAIL', header: mkHeader('B') },
    ];
    const r = checkProcesses(mkManifest(), procs);
    assert.ok(r.fail.some((x) => /B process failed its own soak/.test(x)));
});

test('analyse: a clean A/A over all ten kernel lanes (20 comparisons) is PASS, exit 0', () => {
    const K = 10;
    // Both sides draw the same tiny-variance distribution per lane -> no significant difference anywhere.
    const val = (side, lane, metric, r) => 1000 + lane.length * 10 + (metric === 'hotOpsSparse' ? -300 : 0) + r;
    const res = analyse(mkManifest(), mkTenLaneProcs(K, val), null);
    assert.equal(res.comparisons.length, FAMILY);               // 10 lanes x 2 metrics == 20
    assert.equal(res.verdict, 'PASS');
    assert.equal(res.exitCode, 0);
    assert.ok(res.comparisons.every((c) => c.usable && c.verdict === 'PASS'));
});

// --- fail CLOSED: the analyser must never PASS on an untrustworthy family or sample count (blocker 1) ---

test('analyse: a short/empty/over-long lane family can never PASS -- it is INCONCLUSIVE', () => {
    const noise = (side, lane, metric, r) => 1e6 * (1 + 0.01 * Math.sin(r * 7 + lane.length));
    const run = (lanes) => {
        const procs = mkTenLaneProcs(10, noise);   // the procs still carry all ten lanes' samples
        const res = analyse(Object.assign(mkManifest(), { lanes }), procs, null);
        return res;
    };
    // lanes = [] : 0 comparisons must NOT be a silent PASS.
    let res = run([]);
    assert.equal(res.verdict, 'INCONCLUSIVE', 'empty lane set must be INCONCLUSIVE, not PASS');
    assert.equal(res.exitCode, 3);
    assert.ok(res.inconclusive.some((x) => /comparison family is 0/.test(x)));
    // lanes undefined : same.
    res = analyse(Object.assign(mkManifest(), { lanes: undefined }), mkTenLaneProcs(10, noise), null);
    assert.equal(res.verdict, 'INCONCLUSIVE');
    // one lane : 2 comparisons, not the family of 20.
    res = run(['RoundRobin']);
    assert.equal(res.verdict, 'INCONCLUSIVE', 'a single lane (2 comparisons) must be INCONCLUSIVE');
    assert.ok(res.inconclusive.some((x) => /comparison family is 2 .*not 20/.test(x)));
    // eleven lanes : 22 comparisons, also wrong.
    res = run(KERNEL_LANES.concat(['Imaginary']));
    assert.equal(res.verdict, 'INCONCLUSIVE', 'an over-long roster (22 comparisons) must be INCONCLUSIVE');
});

test('analyse: K below the MW floor (or non-integer) can never PASS -- it is INCONCLUSIVE', () => {
    const noise = (side, lane, metric, r) => 1e6 * (1 + 0.01 * Math.sin(r * 7 + lane.length));
    // K undefined with 3 rounds of data: must NOT skip the round/K check and PASS.
    let res = analyse(Object.assign(mkManifest(), { K: undefined }), mkTenLaneProcs(3, noise), null);
    assert.equal(res.verdict, 'INCONCLUSIVE', 'K undefined must be INCONCLUSIVE, not PASS');
    assert.ok(res.inconclusive.some((x) => /K must be an integer >= 8/.test(x)));
    // K = 5 (below the 8 floor) with 5 rounds: still INCONCLUSIVE (the exact MW cannot reach the family alpha).
    res = analyse(Object.assign(mkManifest(), { K: 5 }), mkTenLaneProcs(5, noise), null);
    assert.equal(res.verdict, 'INCONCLUSIVE');
});

test('analyse: a dropped sample (fewer than K per side) makes only that comparison INCONCLUSIVE, never a 9-vs-9 verdict', () => {
    const K = 10;
    // B is a flat 30% slower on SmoothWRR (would FAIL), but one SmoothWRR round is dropped on BOTH sides
    // (null -> filtered) so the lane carries 9 vs 9. The pre-fix analyser decided it on 9 vs 9 and FAILed;
    // the fix refuses anything but exactly K per side -> that comparison is INCONCLUSIVE, the run too.
    const base = (side, lane, metric, r) => 1e6 * (1 + 0.01 * Math.sin(r * 7 + lane.length)) * (lane === 'SmoothWRR' && side === 'B' ? 0.7 : 1);
    const dropped = (side, lane, metric, r) => (lane === 'SmoothWRR' && r === 2) ? null : base(side, lane, metric, r);
    const res = analyse(mkManifest(), mkTenLaneProcs(K, dropped), null);
    const dense = res.comparisons.find((c) => c.lane === 'SmoothWRR' && c.metric === 'hotOpsDense');
    assert.equal(dense.a.length, 9);
    assert.equal(dense.b.length, 9);
    assert.equal(dense.usable, false);
    assert.equal(dense.verdict, 'INCONCLUSIVE');
    assert.notEqual(res.verdict, 'FAIL', 'a 9-vs-9 lane must not be FAILed on an incomplete sample');
    assert.equal(res.verdict, 'INCONCLUSIVE');
    // The other lanes, which DO have 10 vs 10, are still usable (the guard is per comparison, not global).
    const rr = res.comparisons.find((c) => c.lane === 'RoundRobin' && c.metric === 'hotOpsDense');
    assert.equal(rr.usable, true);
});

test('analyse: report-only fields (latencyP99 / CV) never change the verdict or exit (blocker 2)', () => {
    const K = 10;
    const val = (side, lane, metric, r) => 1000 + lane.length * 10 + (metric === 'hotOpsSparse' ? -300 : 0) + r;
    const procs = mkTenLaneProcs(K, val);
    const bare = analyse(mkManifest(), procs, null);
    assert.equal(bare.verdict, 'PASS');
    // Now attach wildly divergent latencyP99 to every B sample (B 100x worse) -- a report-only field.
    for (const p of procs) {
        for (const lane of KERNEL_LANES) {
            p.samples[lane].latencyP99Dense = p.side === 'B' ? 10000 : 10;
            p.samples[lane].latencyP99Sparse = p.side === 'B' ? 20000 : 20;
        }
    }
    const withLat = analyse(mkManifest(), procs, null);
    assert.equal(withLat.verdict, bare.verdict, 'latency must not move the verdict');
    assert.equal(withLat.exitCode, bare.exitCode);
    // but the report-only fields ARE populated and serialisable.
    const c = withLat.comparisons.find((x) => x.lane === 'RoundRobin' && x.metric === 'hotOpsDense');
    assert.equal(c.latencyP99A, 10);
    assert.equal(c.latencyP99B, 10000);
    assert.ok(typeof c.cvA === 'number' && typeof c.detrendedCvB === 'number');
});

test('checkProcesses: an A/A run (manifest.aa) admits prev == candidate; a release run does not', () => {
    const header = mkHeader();
    const procs = [
        { side: 'A', role: 'round', exit: 0, verdict: 'PASS', header: mkHeader('A') },
        { side: 'B', role: 'round', exit: 0, verdict: 'PASS', header: mkHeader('A') },
    ];
    // A/A: both sides are the SAME real release, recorded verbatim (not 0.0.0/0.0.1).
    const aaMan = { prevVersion: '1.1.0', candidateVersion: '1.1.0', aa: true, K: 1,
        aPickSha: 'A', aPoolSha: 'A', bPickSha: 'A', bPoolSha: 'A', parityPickSha: 'A', parityPoolSha: 'A' };
    const aa = checkProcesses(aaMan, procs);
    assert.ok(!aa.inconclusive.some((x) => /prev .* is not < candidate|expects prev == candidate/.test(x)),
        'an A/A run must accept prev == candidate: ' + JSON.stringify(aa.inconclusive));
    // the same equal versions WITHOUT the aa flag (a release run) are INCONCLUSIVE.
    const rel = checkProcesses(Object.assign({}, aaMan, { aa: false }), procs);
    assert.ok(rel.inconclusive.some((x) => /prev 1\.1\.0 is not < candidate 1\.1\.0/.test(x)));
});

test('analyse: a family of the right SIZE but the wrong lanes is INCONCLUSIVE (every kernel lane must be compared)', () => {
    // ten copies of RoundRobin = 20 comparisons, while the other nine lanes are 50% slower in B: counting lanes
    // alone would PASS this run without ever looking at the regressions.
    const slowElsewhere = (side, lane, metric, r) => 1e6 * (1 + 0.01 * Math.sin(r * 7)) * (side === 'B' && lane !== 'RoundRobin' ? 0.5 : 1);
    const lanes = KERNEL_LANES.map(() => 'RoundRobin');
    const res = analyse(Object.assign(mkManifest(), { lanes }), mkTenLaneProcs(10, slowElsewhere), null);
    assert.equal(res.verdict, 'INCONCLUSIVE', 'a duplicated-lane family must never PASS: ' + res.verdict);
    assert.ok(res.inconclusive.some((x) => /lane set is not the kernel roster/.test(x)), JSON.stringify(res.inconclusive));
});

test('checkProcesses: an A/A run with DIFFERENT kernels on the two sides is INCONCLUSIVE', () => {
    const procs = [
        { side: 'A', role: 'round', exit: 0, verdict: 'PASS', header: mkHeader('A') },
        { side: 'B', role: 'round', exit: 0, verdict: 'PASS', header: mkHeader('B') },
    ];
    const man = { prevVersion: '1.1.0', candidateVersion: '1.1.0', aa: true, K: 1,
        aPickSha: 'A', aPoolSha: 'A', bPickSha: 'B', bPoolSha: 'B', parityPickSha: 'B', parityPoolSha: 'B' };
    const res = checkProcesses(man, procs);
    assert.ok(res.inconclusive.some((x) => /A\/A control expects identical kernels/.test(x)), JSON.stringify(res.inconclusive));
});

test('analyse: an A/A run ignores the acceptance file (an ACCEPTED must never hide in the A/A tally)', () => {
    // identical kernels, B 10% slower on SmoothWRR dense: with the acceptance applied this would read ACCEPTED.
    const val = (side, lane, metric, r) => 1e6 * (1 + 0.001 * r) * (side === 'B' && lane === 'SmoothWRR' && metric === 'hotOpsDense' ? 0.9 : 1);
    const procs = mkTenLaneProcs(10, val).map((p) => Object.assign(p, { header: mkHeader('A') }));
    const man = Object.assign(mkManifest(), { candidateVersion: '1.1.0', aa: true,
        bPickSha: 'A', bPoolSha: 'A', parityPickSha: 'A', parityPoolSha: 'A' });
    const accept = { schema: 1, version: '1.1.0',
        entries: [{ lane: 'SmoothWRR', metric: 'hotOpsDense', maxSlowdown: 0.12, reason: 'A/A must not honour this entry at all' }] };
    const res = analyse(man, procs, accept);
    const c = res.comparisons.find((x) => x.lane === 'SmoothWRR' && x.metric === 'hotOpsDense');
    assert.notEqual(c.verdict, 'ACCEPTED', 'acceptance applied in aa mode');
    assert.equal(c.verdict, 'FAIL');
});

test('holm refuses a family smaller than the number of p-values', () => {
    assert.throws(() => holm([0.01, 0.02, 0.03], 2), RangeError);
    assert.deepEqual(holm([0.01], 20), [0.2]);
});

test('the analyser\'s KERNEL_LANES is exactly the soak kernel roster (a new lane cannot slip past the A/B)', async () => {
    const { KERNEL_LANES: ROSTER } = await import('../benchmark/soak/lanes.mjs');
    assert.deepEqual(KERNEL_LANES.slice(), ROSTER.map((d) => d.name));
});

// --- zero-dep helpers --------------------------------------------------------------------------------
function ones(K, v) { const a = new Array(K); for (let i = 0; i < K; i++) a[i] = v; return a; }
function pairwise(A, B) { const out = []; for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) out.push(B[j] / A[i]); out.sort((x, y) => x - y); return out; }
function mkHeader(sha = 'A') {
    return {
        schemaVersion: 5, node: 'v22.23.3', v8: '12.0', gitSha: 'abc', execArgv: ['--expose-gc'],
        os: { platform: 'linux', arch: 'x64', cpuModel: 'EPYC', cpuCount: 4 },
        config: { seed: 12648430 }, laneRoster: ['RoundRobin', 'P2C'],
        kernel: { pickSha256: sha, poolSha256: sha, kernelOverride: true, poolOverride: true },
    };
}
function mkManifest() {
    return {
        prevVersion: '1.1.0', candidateVersion: '1.1.1',
        aPickSha: 'A', aPoolSha: 'A', bPickSha: 'B', bPoolSha: 'B',
        parityPickSha: 'B', parityPoolSha: 'B',
        K: 10, lanes: KERNEL_LANES.slice(),
    };
}
/** K A-rounds and K B-rounds over all ten kernel lanes; `val(side, lane, metric, round)` -> a sample. */
function mkTenLaneProcs(K, val) {
    const procs = [];
    for (let r = 0; r < K; r++) {
        for (const side of ['A', 'B']) {
            const samples = {};
            for (const lane of KERNEL_LANES) {
                samples[lane] = { hotOpsDense: val(side, lane, 'hotOpsDense', r), hotOpsSparse: val(side, lane, 'hotOpsSparse', r) };
            }
            procs.push({ side, role: 'round', exit: 0, verdict: 'PASS', header: mkHeader(side), samples });
        }
    }
    return procs;
}

// ===================================================================================================
// (2) HARNESS: SOAK_TIERS / SOAK_HOTOPS_N through the real main.mjs
// ===================================================================================================

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAIN = join(ROOT, 'benchmark', 'soak', 'main.mjs');
const NODE = process.execPath;
const FLAGS = ['--expose-gc', '--min-semi-space-size=4', '--max-semi-space-size=4'];
const MAJOR = Number(process.versions.node.split('.')[0]);
const SOAK_DEPS = ['lite-sketch', 'lite-leak', 'lite-gc-profiler'];
const MISSING = SOAK_DEPS.filter((d) => !existsSync(join(ROOT, 'node_modules', '@zakkster', d, 'package.json')));
const SKIP = MISSING.length > 0 && MAJOR < 20
    ? 'no node_modules on the Node 18 job: ' + MISSING.join(', ') + ' not installed' : false;
const soakTest = (name, fn) => test(name, { skip: SKIP }, fn);

let TMP;
function tmp(name) { if (!TMP) TMP = mkdtempSync(join(tmpdir(), 'soak-ab-')); return join(TMP, name); }
function runMain(env, out) {
    const r = spawnSync(NODE, FLAGS.concat([MAIN]), {
        cwd: ROOT, env: Object.assign({}, process.env, env, { SOAK_OUT: out }),
        stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 180000,
    });
    const why = ' (exit ' + r.status + (r.error ? ', ' + r.error.message : '') + ')\n' + String(r.stderr || '').slice(-1500);
    assert.equal(r.status, 0, 'main.mjs must exit 0 for ' + out + why);
    assert.ok(existsSync(out), 'main.mjs wrote no stream ' + out + why);
    return readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

soakTest('SOAK_TIERS=kernel drives only the kernel tier (no #tiny, no pool lanes)', () => {
    const recs = runMain({ SOAK_SMOKE: '1', SOAK_TIERS: 'kernel', SOAK_LANES: 'RoundRobin,P2C,ConsistentHash' }, tmp('tiers.jsonl'));
    const cycles = recs.filter((r) => r.type === 'cycle');
    assert.ok(cycles.length > 0);
    for (const c of cycles) {
        assert.equal(c.tier, 'kernel', 'a non-kernel cycle leaked in: ' + c.lane);
        assert.ok(c.lane.indexOf('#tiny') === -1, 'a tiny lane leaked in: ' + c.lane);
    }
    const header = recs.find((r) => r.type === 'header');
    assert.ok(header.laneRoster.every((id) => id.indexOf('#tiny') === -1 && ['RoundRobin', 'P2C', 'ConsistentHash'].indexOf(id) !== -1));
    assert.deepEqual(header.config.tiers, ['kernel']);   // additive header field (SCHEMA 5)
});

soakTest('SOAK_HOTOPS_N pins every record to the given batch lengths (self-calibration never 1024)', () => {
    const recs = runMain(
        { SOAK_SMOKE: '1', SOAK_TIERS: 'kernel', SOAK_LANES: 'RoundRobin', SOAK_HOTOPS_N: 'RoundRobin:1024:1024' },
        tmp('pin.jsonl'));
    const cycles = recs.filter((r) => r.type === 'cycle');
    assert.ok(cycles.length > 0);
    for (const c of cycles) {
        assert.equal(c.hotOpsDenseN, 1024, 'dense batch not pinned at cycle ' + c.cycle);
        assert.equal(c.hotOpsSparseN, 1024, 'sparse batch not pinned at cycle ' + c.cycle);
    }
    const header = recs.find((r) => r.type === 'header');
    assert.deepEqual(header.config.hotOpsN, { RoundRobin: { dense: 1024, sparse: 1024 } });

    // Control: WITHOUT the pin RoundRobin self-calibrates well above the 1024 floor -- proving the pin
    // is doing the work, not an accident of the floor.
    const free = runMain({ SOAK_SMOKE: '1', SOAK_TIERS: 'kernel', SOAK_LANES: 'RoundRobin' }, tmp('free.jsonl'));
    const freeCycles = free.filter((r) => r.type === 'cycle');
    assert.ok(freeCycles.every((c) => c.hotOpsDenseN > 1024), 'RoundRobin dense should calibrate above 1024');
});

soakTest('SOAK_HOTOPS_N with a misspelled lane fails closed with a did-you-mean (not just the roster)', () => {
    const r = spawnSync(NODE, FLAGS.concat([MAIN]), {
        cwd: ROOT,
        env: Object.assign({}, process.env, { SOAK_SMOKE: '1', SOAK_TIERS: 'kernel', SOAK_LANES: 'RoundRobin', SOAK_HOTOPS_N: 'RoundRobn:1024:1024', SOAK_OUT: tmp('hotn-typo.jsonl') }),
        stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 60000,
    });
    assert.equal(r.status, 2, 'a misspelled SOAK_HOTOPS_N lane must exit 2; stderr=' + r.stderr);
    assert.match(r.stderr, /SOAK_HOTOPS_N: unknown lane 'RoundRobn'.*did you mean RoundRobin\?/);
});

// ===================================================================================================
// (3) RUNNER + CI: the SoakAB.mjs CLI fail-closed cases and the workflow pins (Batch 3, task 14).
// These need NO network and NO devDependency: the exit-2 paths (arg parse, SOAK_* refusal) run before
// any pack/spawn, and SoakAB.mjs imports only the zero-dep ab-analyse/ab-pack/gates. So they run on the
// Node 18 no-install job too (no skip) -- the subprocess loads nothing from node_modules.
// ===================================================================================================

const SOAKAB = join(ROOT, 'benchmark', 'soak', 'SoakAB.mjs');
const CI_YML = join(ROOT, '.github', 'workflows', 'ci.yml');
const AB_YML = join(ROOT, '.github', 'workflows', 'soak-ab.yml');

/** Run the CLI with a SOAK_*-free base env plus `extraEnv`; capture status + stderr. */
function runCli(args, extraEnv) {
    const env = {};
    for (const k of Object.keys(process.env)) if (k.indexOf('SOAK_') !== 0) env[k] = process.env[k];
    Object.assign(env, extraEnv || {});
    return spawnSync(NODE, [SOAKAB, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
}

test('CLI: a misspelled flag exits 2 with a did-you-mean hint (no network)', () => {
    const r = runCli(['--rouds', '10', '--prev', '1.1.0']);
    assert.equal(r.status, 2, 'exit 2 on an unknown flag; stderr=' + r.stderr);
    assert.match(r.stderr, /unknown flag --rouds/);
    assert.match(r.stderr, /did you mean --rounds\?/);
});

test('CLI: --rounds below the K=8 floor exits 2 (no network)', () => {
    const r = runCli(['--prev', '1.1.0', '--rounds', '7']);
    assert.equal(r.status, 2, 'exit 2 when rounds < 8; stderr=' + r.stderr);
    assert.match(r.stderr, /--rounds 7 out of range \[8, 40\]/);
});

test('CLI: a SOAK_* already in the environment is refused with exit 2 (no network)', () => {
    const r = runCli(['--prev', '1.1.0', '--rounds', '10'], { SOAK_SEED: '1' });
    assert.equal(r.status, 2, 'exit 2 when SOAK_* leaks in; stderr=' + r.stderr);
    assert.match(r.stderr, /refusing to run with SOAK_\* already set/);
    assert.match(r.stderr, /SOAK_SEED/);
});

test('CLI: --help exits 0 and names every flag (no network)', () => {
    const r = runCli(['--help']);
    assert.equal(r.status, 0, 'exit 0 on --help; stderr=' + r.stderr);
    for (const flag of ['--prev', '--rounds', '--seed', '--order-seed', '--out-dir', '--accept', '--aa', '--a-dir', '--b-dir']) {
        assert.ok(r.stdout.indexOf(flag) !== -1, '--help must document ' + flag);
    }
});

test('CLI: --a-dir without --b-dir exits 2 (control mode needs both)', () => {
    const r = runCli(['--a-dir', '/tmp/x']);
    assert.equal(r.status, 2, 'exit 2; stderr=' + r.stderr);
    assert.match(r.stderr, /--a-dir and --b-dir must be given together/);
});

test('workflow: soak-ab.yml node-version equals the ci.yml gates job node-version (22.23.3)', () => {
    const ci = readFileSync(CI_YML, 'utf8');
    const ab = readFileSync(AB_YML, 'utf8');
    // Isolate the ci.yml `gates:` job (from its header to the next top-level job key).
    const gi = ci.indexOf('\n  gates:');
    assert.ok(gi !== -1, 'ci.yml must have a gates job');
    const tail = ci.slice(gi + 1);
    const nxt = tail.slice(8).search(/\n {2}[A-Za-z][\w-]*:\n/);
    const gatesBlock = nxt === -1 ? tail : tail.slice(0, nxt + 8);
    const gatesNode = /node-version:\s*([\d.]+)/.exec(gatesBlock);
    const abNode = /node-version:\s*([\d.]+)/.exec(ab);
    assert.ok(gatesNode, 'ci.yml gates job must pin node-version');
    assert.ok(abNode, 'soak-ab.yml must pin node-version');
    assert.equal(abNode[1], gatesNode[1], 'soak-ab.yml node-version must track the gates job');
    assert.equal(abNode[1], '22.23.3');
});

test('workflow: no ${{ inputs.* }} is interpolated inside any run: body (only via env:)', () => {
    const ab = readFileSync(AB_YML, 'utf8');
    for (const line of ab.split('\n')) {
        if (line.trim().startsWith('#')) continue;   // comments document the token; they are not run bodies
        if (line.indexOf('${{ inputs.') === -1) continue;
        // The only admissible shape is an env: mapping line:  KEY: ${{ inputs.name }}
        assert.match(line, /^\s+[A-Za-z_][A-Za-z0-9_]*:\s*\$\{\{ inputs\.[A-Za-z_]+ \}\}$/,
            'inputs.* may appear only as an env: mapping, never inside a run: body -- offending line: ' + line);
    }
    // And the run body does reference the shell env vars (sanity: the inputs ARE threaded through env).
    assert.ok(ab.indexOf('"$PREV"') !== -1 && ab.indexOf('"$ROUNDS"') !== -1, 'the run body must use $PREV/$ROUNDS from env:');
});

// --- teeth-anchor regression (AB_LIST): every mutant anchor in _ab-teeth.mjs still resolves against the
// committed 1.1.0 kernel. LIST mode uses `git show 2a08567:Pick.js` (offline, no network/devDeps), so a
// stale anchor is caught here, not only when the ~7-minute proof run is scheduled. Runs on Node 18 too.
test('teeth: every _ab-teeth.mjs mutant anchor resolves (AB_LIST, offline)', () => {
    const r = spawnSync(NODE, [join(ROOT, 'benchmark', 'soak', '_ab-teeth.mjs')],
        { cwd: ROOT, env: Object.assign({}, process.env, { AB_LIST: '1' }), encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(r.status, 0, 'AB_LIST must exit 0 (every anchor resolved); stderr=' + r.stderr + ' stdout=' + r.stdout);
    const ids = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(ids.pop(), { end: true, count: ids.length }, 'AB_LIST output truncated or unterminated');
    assert.ok(ids.every((o) => !o.error), 'no anchor may fail to resolve: ' + JSON.stringify(ids.filter((o) => o.error)));
    const want = ['AB-AA', 'AB-SLOW20', 'AB-SLOW10', 'AB-SPARSE', 'AB-FAST', 'AB-COMPAT', 'AB-BFAIL'];
    assert.deepEqual(ids.map((o) => o.id), want, 'all seven controls must list, in order');
});

// --- relative paths (the 2026-10-06 hosted A/A run: --out-dir benchmark/out/soak-ab resolved twice) -----------

async function inTempCwd(fn) {
    const here = process.cwd();
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'soak-ab-rel-'))); // macOS: /var -> /private/var
    process.chdir(tmp);
    try { return await fn(tmp); } finally { process.chdir(here); rmSync(tmp, { recursive: true, force: true }); }
}

// ab-pack spawns `npm` WITHOUT a shell (on Windows that is npm.cmd -> ENOENT), by design: --prev reaches the
// npm spec before SoakAB.mjs validates it, so a shell would be an injection surface. soak-ab.yml is ubuntu-only.
const WIN_SKIP = process.platform === 'win32' && 'ab-pack spawns npm without a shell; soak-ab.yml is ubuntu-only';

test('packTree: relative scratch/out dirs resolve against the CALLER cwd, not the npm cwd', { skip: WIN_SKIP }, async () => {
    const { packTree } = await import('../benchmark/soak/ab-pack.mjs');
    await inTempCwd((tmp) => {
        const B = packTree(undefined, join('rel', 'scratch'), 'rel');
        assert.equal(B.dir, join(tmp, 'rel', 'B', 'package'));
        assert.ok(existsSync(join(tmp, 'rel', 'B', 'package', 'Pick.js')));
    });
});

test('fetchRelease: a relative scratch dir is not resolved twice (registry; skipped only if unreachable)', { skip: WIN_SKIP }, async (t) => {
    const { execFileSync } = await import('node:child_process');
    try {
        execFileSync('npm', ['view', '@zakkster/lite-pick@1.1.0', 'version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
    } catch {
        t.skip('npm registry unreachable');
        return;
    }
    const { fetchRelease } = await import('../benchmark/soak/ab-pack.mjs');
    await inTempCwd((tmp) => {
        const A = fetchRelease('1.1.0', join('rel', 'scratch'), 'rel');
        assert.equal(A.version, '1.1.0');
        assert.equal(A.dir, join(tmp, 'rel', 'A', 'package'));
    });
});
